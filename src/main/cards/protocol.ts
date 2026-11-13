import { mimeFor, readFileOrNull, resolveInsideCard } from './paths';
import { cspScriptTag } from './csp-script';

/**
 * `cockpit://` 协议处理器。
 *
 * ── 契约 §6.1 的三条硬承诺，全在这个文件里兑现 ──
 *
 * | 承诺 | 怎么兑现 |
 * |---|---|
 * | **断网** | 每个 HTML 响应都带 `CARD_CSP`（`connect-src 'none'`）——**响应头**，卡片改不了（`meta` 里的 CSP 管不了自己） |
 * | **卡片资源离线可用** | 资源由本协议伺服；MIME 给对（给错 → module script 被浏览器拒） |
 * | **卡片碰不到宿主的文件系统** | 路径解析 + 穿越防护（`paths.ts`） |
 *
 * ── 形状：`(Request) => Response` ──
 *
 * `Request` / `Response` 是 **web 标准的全局对象**（Node 20 就有），
 * 所以这个处理器的每一条行为**都能在单测里验**，不必等真浏览器。
 * 浏览器那一层（真沙箱、真断网、CSP 违规归属）留给 e2e。
 */

/**
 * 卡片 HTML 的 CSP 头（**契约 `spec/03` §6.1 的逐条原文**）。
 *
 * **一个字都不改**——它是「卡片不能联网」这条承诺的执行者。
 */
export const CARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; " +
  "form-action 'none'; frame-src 'none'; base-uri 'none'";

/**
 * 宿主注入的 bridge 脚本标签。
 *
 * ── 必须是**带实例 id 的绝对 URL** ──
 *
 * 卡片页面的地址是 `cockpit://card/<实例 id>/index.html`。
 * 若这里写 `/__host/bridge.js`（相对根路径），浏览器会解析成
 * `cockpit://card/__host/bridge.js`——**实例 id 被吃掉了** →
 * 协议处理器拿 `__host` 当实例 id → 404 → `window.cockpit` 恒 undefined。
 *
 * → 所以用**绝对 URL**（`cockpit://card/<实例 id>/__host/bridge.js`）。
 *
 * 代价：**每个实例的标签不一样**（实例 id 不同）——
 * 这正是我们要的：bridge 脚本里带着自己的实例 id（RF-1 的凭据）。
 */
function bridgeTagFor(instanceId: string): string {
  const id = encodeURIComponent(instanceId);
  return `<script type="module" src="cockpit://card/${id}/__host/bridge.js"></script>`;
}

/** 把标签插到文档最前面（`<head>` 之后，没有 `<head>` 就 `<html>` 之后） */
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
  // 连 `<html>` 都没有 → 前置到文档开头
  return tags + html;
}

/**
 * 把 bridge 脚本标签插进 HTML。
 *
 * 位置有讲究：**必须在卡片自己的脚本之前**——
 * 否则卡片脚本一跑，`window.cockpit` 还不存在。
 *
 * @param instanceId 这个实例的 id（标签里要带上它）
 */
export function injectBridge(html: string, instanceId: string): string {
  return injectAtStart(html, bridgeTagFor(instanceId));
}

/**
 * 把**宿主注入的两个脚本**插进 HTML。
 *
 * | 顺序 | 脚本 | 为什么在这个位置 |
 * |---|---|---|
 * | 1 | `__host/csp.js` | **经典脚本**（解析时同步执行）→ 在卡片自己的脚本之前就装上 CSP 违规监听 → 卡片在**解析期**的违规也抓得到 |
 * | 2 | `__host/bridge.js` | module（defer）→ 卡片脚本跑之前 `window.cockpit` 就绪 |
 *
 * 顺序不能反：csp 必须在 bridge 之前（监听要早）。
 */
export function injectHostScripts(html: string, instanceId: string): string {
  return injectAtStart(html, cspScriptTag(instanceId) + bridgeTagFor(instanceId));
}

/** 把主题样式（`:root{--cockpit-*:…}`）插进 HTML */
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
  /** 这个实例的卡片目录。**没登记就是 null**（不猜） */
  dirOfInstance: (instanceId: string) => string | null;
  /** 这个实例的入口文件（相对卡片目录） */
  entryOfInstance: (instanceId: string) => string;
  /** 注入给这个实例的 bridge 脚本（**每个实例一份**：它带着 instanceId） */
  bridgeScript: (instanceId: string) => string;
  /** 注入给这个实例的 CSP 违规监听脚本（**每个实例一份**：它带着 instanceId） */
  cspScript: (instanceId: string) => string;
  /** 当前主题的 CSS 变量块（Task 11 接上） */
  themeStyle?: () => string;
}

/**
 * 造一个 `cockpit://` 的处理器。
 *
 * URL 形状：`cockpit://card/<实例 id>/<卡片目录内的相对路径>`
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

    // 宿主注入的 bridge 脚本（**不走文件系统**——它是生成的）
    if (rel === '__host/bridge.js') {
      return new Response(deps.bridgeScript(instanceId), {
        status: 200,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // 宿主注入的 CSP 违规监听脚本（**经典脚本**——要赶在卡片自己的脚本之前）
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
      // 卡片是**开发时反复改**的 → 不缓存（否则改了文件看不到变化）
      'Cache-Control': 'no-store',
    };

    const isHtml = filePath.endsWith('.html') || filePath.endsWith('.htm');
    if (!isHtml) {
      return new Response(body, { status: 200, headers });
    }

    // **每个 HTML 都带 CSP**（卡片里的第二个页面也一样）
    headers['Content-Security-Policy'] = CARD_CSP;
    let html = body.toString('utf8');
    // bridge 与主题只注入**入口**（其它页面是卡片自己的资源）
    if (rel === deps.entryOfInstance(instanceId)) {
      html = injectHostScripts(html, instanceId);
      const theme = deps.themeStyle?.() ?? '';
      if (theme !== '') html = injectTheme(html, theme);
    }
    return new Response(html, { status: 200, headers });
  };
}
