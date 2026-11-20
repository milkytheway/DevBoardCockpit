import { mimeFor, readFileOrNull, resolveInsideCard } from './paths';
import { cspScriptTag } from './csp-script';

/**
 * The handler of the `cockpit://` protocol.
 *
 * ── The three hard promises of contract §6.1 are all kept in this file ──
 *
 * | Promise | How it is kept |
 * |---|---|
 * | **No network** | every HTML response carries `CARD_CSP` (`connect-src 'none'`) — a **response header**, which the card cannot change (a CSP in a `meta` tag cannot restrict itself) |
 * | **The resources of a card work offline** | the resources are served by this protocol; the MIME type has to be right (a wrong one → the browser rejects the module script) |
 * | **A card cannot reach the file system of the host** | path resolution + traversal protection (`paths.ts`) |
 *
 * ── The shape: `(Request) => Response` ──
 *
 * `Request` / `Response` are **global objects of the web standard** (Node 20
 * already has them), so every behaviour of this handler **can be verified in a
 * unit test** without waiting for a real browser.
 * The browser layer (the real sandbox, the real network cut, the attribution
 * of a CSP violation) is left to the e2e tests.
 */

/**
 * The CSP header of the card HTML (**the text of contract `spec/03` §6.1,
 * clause by clause**).
 *
 * **Not one character is changed** — it is the executor of the promise "a card
 * cannot reach the network".
 */
export const CARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; " +
  "form-action 'none'; frame-src 'none'; base-uri 'none'";

/**
 * The tag of the bridge script injected by the host.
 *
 * ── It has to be an **absolute URL with the instance id** ──
 *
 * The address of a card page is `cockpit://card/<instance id>/index.html`.
 * If this were `/__host/bridge.js` (a root-relative path), the browser would
 * resolve it to `cockpit://card/__host/bridge.js` — **the instance id is
 * swallowed** → the protocol handler takes `__host` for the instance id → 404
 * → `window.cockpit` stays undefined for good.
 *
 * → Therefore an **absolute URL** (`cockpit://card/<instance id>/__host/bridge.js`).
 *
 * The cost: **the tag differs per instance** (the instance id differs) —
 * which is exactly what is wanted: the bridge script carries its own instance
 * id (the credential of RF-1).
 */
function bridgeTagFor(instanceId: string): string {
  const id = encodeURIComponent(instanceId);
  return `<script type="module" src="cockpit://card/${id}/__host/bridge.js"></script>`;
}

/** Inserts the tag at the very front of the document (after `<head>`, after `<html>` when there is no `<head>`) */
function injectAtStart(html: string, tags: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  // Not even an `<html>` → put it at the beginning of the document
  return tags + html;
}

/**
 * Inserts the tag of the bridge script into the HTML.
 *
 * The position matters: **it has to be before the scripts of the card** —
 * otherwise `window.cockpit` does not exist yet when the card script runs.
 *
 * @param instanceId the id of this instance (the tag has to carry it)
 */
export function injectBridge(html: string, instanceId: string): string {
  return injectAtStart(html, bridgeTagFor(instanceId));
}

/**
 * Inserts the **two scripts injected by the host** into the HTML.
 *
 * | Order | Script | Why it sits there |
 * |---|---|---|
 * | 1 | `__host/csp.js` | a **classic script** (synchronous during parsing) → the CSP violation listener is installed before the scripts of the card → violations during **parsing** are caught too |
 * | 2 | `__host/bridge.js` | a module (deferred) → `window.cockpit` is ready before the card scripts run |
 *
 * The order must not be reversed: csp has to come before bridge (the listener
 * has to be early).
 */
export function injectHostScripts(html: string, instanceId: string): string {
  return injectAtStart(html, cspScriptTag(instanceId) + bridgeTagFor(instanceId));
}

/** Inserts the theme styles (`:root{--cockpit-*:…}`) into the HTML */
export function injectTheme(html: string, style: string): string {
  if (style.trim() === '') return html;
  const tag = `<style>${style}</style>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

export interface CardProtocolDeps {
  /** The card directory of this instance. **`null` when it is not registered** (no guessing) */
  dirOfInstance: (instanceId: string) => string | null;
  /** The entry file of this instance (relative to the card directory) */
  entryOfInstance: (instanceId: string) => string;
  /** The bridge script injected into this instance (**one per instance**: it carries the instanceId) */
  bridgeScript: (instanceId: string) => string;
  /** The CSP violation listener injected into this instance (**one per instance**: it carries the instanceId) */
  cspScript: (instanceId: string) => string;
  /** The block of CSS variables of the current theme (wired up in task 11) */
  themeStyle?: () => string;
}

/**
 * Builds a handler for `cockpit://`.
 *
 * The shape of the URL: `cockpit://card/<instance id>/<relative path inside the
 * card directory>`
 */
export function createCardProtocol(
  deps: CardProtocolDeps,
): (request: Request) => Response {
  return (request: Request): Response => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (url.hostname !== 'card') return new Response('not found', { status: 404 });

    const segments = url.pathname.split('/').filter((s) => s !== '');
    const instanceId = segments[0];
    if (instanceId === undefined) return new Response('not found', { status: 404 });

    const dir = deps.dirOfInstance(instanceId);
    if (dir === null) return new Response('not found', { status: 404 });

    const rel = segments.slice(1).join('/');

    // The bridge script injected by the host (**not read from the file system** — it is generated)
    if (rel === '__host/bridge.js') {
      return new Response(deps.bridgeScript(instanceId), {
        status: 200,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // The CSP violation listener injected by the host (**a classic script** — it has to be ahead of the scripts of the card)
    if (rel === '__host/csp.js') {
      return new Response(deps.cspScript(instanceId), {
        status: 200,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    const filePath = resolveInsideCard(dir, rel);
    if (filePath === null) return new Response('forbidden', { status: 403 });

    const body = readFileOrNull(filePath);
    if (body === null) return new Response('not found', { status: 404 });

    const headers: Record<string, string> = {
      'Content-Type': mimeFor(filePath),
      // A card is **edited over and over during development** → no caching (otherwise a change to a file is not visible)
      'Cache-Control': 'no-store',
    };

    const isHtml = filePath.endsWith('.html') || filePath.endsWith('.htm');
    if (!isHtml) {
      return new Response(body, { status: 200, headers });
    }

    // **Every HTML carries the CSP** (the second page of a card as well)
    headers['Content-Security-Policy'] = CARD_CSP;
    let html = body.toString('utf8');
    // The bridge and the theme are injected into the **entry** only (the other pages are resources of the card)
    if (rel === deps.entryOfInstance(instanceId)) {
      html = injectHostScripts(html, instanceId);
      const theme = deps.themeStyle?.() ?? '';
      if (theme !== '') html = injectTheme(html, theme);
    }
    return new Response(html, { status: 200, headers });
  };
}
