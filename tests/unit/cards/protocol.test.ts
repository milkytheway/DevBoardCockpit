import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardProtocol, CARD_CSP, injectBridge } from '../../../src/main/cards/protocol';
import { cspScriptFor } from '../../../src/main/cards/csp-script';

/**
 * The `cockpit://` protocol handler.
 *
 * The three hard promises of contract §6.1 are all delivered in this file:
 *
 * 1. **the CSP response header is injected by the host** (the card cannot
 *    change it — a CSP in a `meta` tag cannot police itself)
 * 2. **the MIME type is right** (the wrong one makes the browser reject the
 *    module script)
 * 3. **a path may not escape the card directory** (a card is an arbitrary web
 *    page written by an AI)
 *
 * Why it is tested here instead of waiting for Electron:
 *
 * The handler is `(Request) => Response` — **a global object of the web
 * standard**, available in Node 20. Every behaviour of it can therefore be
 * **verified in a unit test** without waiting for a real browser. The browser
 * layer (a real sandbox, real isolation from the network) is left to the
 * end-to-end tests.
 */
function cardDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'card-proto-'));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'index.html'), '<!doctype html><html><body>hi</body></html>', 'utf8');
  writeFileSync(join(base, 'card.js'), 'export const x = 1;', 'utf8');
  return { dir: base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function handler(dir: string): (request: Request) => Response {
  return createCardProtocol({
    dirOfInstance: (id) => (id === 'inst-1' ? dir : null),
    entryOfInstance: () => 'index.html',
    bridgeScript: () => '/* bridge */',
    cspScript: (id) => cspScriptFor(id),
    themeStyle: () => ':root{--cockpit-bg:#000}',
  });
}

describe('the CSP header (the wording of contract §6.1, item by item)', () => {
  it('it is exactly the section the contract writes', () => {
    expect(CARD_CSP).toContain("default-src 'none'");
    expect(CARD_CSP).toContain("script-src 'self'");
    expect(CARD_CSP).toContain("connect-src 'none'");
    expect(CARD_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(CARD_CSP).toContain("frame-src 'none'");
    expect(CARD_CSP).toContain("base-uri 'none'");
  });
});

describe('the injection of the bridge script', () => {
  it('it is inserted after the `<head>`', () => {
    const html = injectBridge('<!doctype html><html><head><title>x</title></head><body></body></html>', 'inst-1');
    expect(html).toContain('<script type="module" src="cockpit://card/inst-1/__host/bridge.js"></script>');
    expect(html.indexOf('bridge.js')).toBeLessThan(html.indexOf('<title>') + 100);
  });

  it('without a head it is inserted after the `<html>`', () => {
    const html = injectBridge('<!doctype html><html><body>x</body></html>', 'inst-1');
    expect(html).toContain('bridge.js');
  });

  it('without an html tag either it is prepended to the beginning of the document', () => {
    const html = injectBridge('hello', 'inst-1');
    expect(html.startsWith('<script type="module" src="cockpit://card/inst-1/__host/bridge.js"></script>')).toBe(true);
  });
});

describe('the routing of the protocol handler', () => {
  it('the entry HTML: it carries the CSP header, the bridge is injected, and it has the theme styles', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/index.html'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(CARD_CSP);
      const body = await res.text();
      expect(body).toContain('bridge.js');
      expect(body).toContain('--cockpit-bg');
    } finally {
      cleanup();
    }
  });

  it('**the injected URL has to be routable by the handler** (a path relative to the root would swallow the instance id)', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const entryUrl = 'cockpit://card/inst-1/index.html';
      const res = handler(dir)(new Request(entryUrl));
      const html = await res.text();
      const src = /<script type="module" src="([^"]+)"><\/script>/.exec(html)?.[1];
      expect(src).toBeDefined();
      // **It is resolved by the rules of the browser** (a relative path loses the
// instance id here)
      const resolved = new URL(src as string, entryUrl);
      expect(resolved.href).toBe('cockpit://card/inst-1/__host/bridge.js');
      // Request the resolved URL → it has to be the bridge script, not a 404
      const bridge = handler(dir)(new Request(resolved.href));
      expect(bridge.status).toBe(200);
      expect(await bridge.text()).toContain('bridge');
    } finally {
      cleanup();
    }
  });

  it('js: the MIME type is text/javascript (**the wrong one makes the browser reject the module script**)', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/card.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    } finally {
      cleanup();
    }
  });

  it('`__host/bridge.js`: the copy the host injects', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/__host/bridge.js'));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('bridge');
    } finally {
      cleanup();
    }
  });

  it('**`__host/csp.js`: the CSP listener script the host injects**', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/__host/csp.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
      const body = await res.text();
      expect(body).toContain('securitypolicyviolation');
    } finally {
      cleanup();
    }
  });

  it('**the CSP listener comes before the bridge** (it listens early enough for the bridge to use it)', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/index.html'));
      const html = await res.text();
      const cspAt = html.indexOf('__host/csp.js');
      const bridgeAt = html.indexOf('__host/bridge.js');
      expect(cspAt).toBeGreaterThan(-1);
      expect(bridgeAt).toBeGreaterThan(-1);
      expect(cspAt).toBeLessThan(bridgeAt);
    } finally {
      cleanup();
    }
  });

  it('**a path traversal → 403** (it may not escape the card directory)', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/..%2f..%2fetc%2fpasswd'));
      expect(res.status).toBe(403);
    } finally {
      cleanup();
    }
  });

  it('an instance that is not registered → 404', () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/nope/index.html'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  it('a host other than `card` → 404', () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://app/index.html'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  it('the file does not exist → 404', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/nope.js'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});
