import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardProtocol, CARD_CSP, injectBridge } from '../../../src/main/cards/protocol';
import { cspScriptFor } from '../../../src/main/cards/csp-script';

/**
 * `cockpit://` 协议处理器。
 *
 * ── 契约 §6.1 的三条硬承诺，全在这个文件里兑现 ──
 *
 * 1. **CSP 响应头由宿主注入**（卡片改不了——`meta` 里的 CSP 管不了自己）
 * 2. **MIME 给对**（给错 → module script 被浏览器拒）
 * 3. **路径不许逃出卡片目录**（卡片是 AI 写的任意网页）
 *
 * ── 为什么要在这里测（而不是等 Electron） ──
 *
 * 处理器就是 `(Request) => Response`——**web 标准的全局对象**，
 * Node 20 里就有。所以它的每一条行为都能**在单测里验**，
 * 不必等真浏览器。浏览器那一层（真沙箱、真断网）留给 e2e。
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

describe('CSP 头（契约 §6.1 逐条原文）', () => {
  it('就是契约写的那一段', () => {
    expect(CARD_CSP).toContain("default-src 'none'");
    expect(CARD_CSP).toContain("script-src 'self'");
    expect(CARD_CSP).toContain("connect-src 'none'");
    expect(CARD_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(CARD_CSP).toContain("frame-src 'none'");
    expect(CARD_CSP).toContain("base-uri 'none'");
  });
});

describe('bridge 脚本的注入', () => {
  it('插在 `<head>` 之后', () => {
    const html = injectBridge('<!doctype html><html><head><title>x</title></head><body></body></html>', 'inst-1');
    expect(html).toContain('<script type="module" src="cockpit://card/inst-1/__host/bridge.js"></script>');
    expect(html.indexOf('bridge.js')).toBeLessThan(html.indexOf('<title>') + 100);
  });

  it('没有 head 就插在 `<html>` 之后', () => {
    const html = injectBridge('<!doctype html><html><body>x</body></html>', 'inst-1');
    expect(html).toContain('bridge.js');
  });

  it('连 html 标签都没有就前置到文档开头', () => {
    const html = injectBridge('hello', 'inst-1');
    expect(html.startsWith('<script type="module" src="cockpit://card/inst-1/__host/bridge.js"></script>')).toBe(true);
  });
});

describe('协议处理器的路由', () => {
  it('入口 HTML：带 CSP 头，注入了 bridge，还带了主题样式', async () => {
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

  it('**注入出来的 URL 必须真的能被处理器路由到**（相对根路径会把实例 id 吃掉）', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const entryUrl = 'cockpit://card/inst-1/index.html';
      const res = handler(dir)(new Request(entryUrl));
      const html = await res.text();
      const src = /<script type="module" src="([^"]+)"><\/script>/.exec(html)?.[1];
      expect(src).toBeDefined();
      // **按浏览器的规则解析**（相对路径会在这里丢掉实例 id）
      const resolved = new URL(src as string, entryUrl);
      expect(resolved.href).toBe('cockpit://card/inst-1/__host/bridge.js');
      // 拿解析出来的 URL 去请求 → 必须是 bridge 脚本，不是 404
      const bridge = handler(dir)(new Request(resolved.href));
      expect(bridge.status).toBe(200);
      expect(await bridge.text()).toContain('bridge');
    } finally {
      cleanup();
    }
  });

  it('js：MIME 是 text/javascript（**给错 module script 就被拒**）', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/card.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    } finally {
      cleanup();
    }
  });

  it('`__host/bridge.js`：宿主注入的那一份', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/__host/bridge.js'));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('bridge');
    } finally {
      cleanup();
    }
  });

  it('**`__host/csp.js`：宿注入的 CSP 监听脚本**', async () => {
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

  it('**CSP 监听脚本在 bridge 之前**（监听得早，bridge 才能用）', async () => {
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

  it('**路径穿越 → 403**（不许逃出卡片目录）', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/..%2f..%2fetc%2fpasswd'));
      expect(res.status).toBe(403);
    } finally {
      cleanup();
    }
  });

  it('没登记的实例 → 404', () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/nope/index.html'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  it('不是 `card` 这个 host → 404', () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://app/index.html'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  it('文件不存在 → 404', async () => {
    const { dir, cleanup } = cardDir();
    try {
      const res = handler(dir)(new Request('cockpit://card/inst-1/nope.js'));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});
