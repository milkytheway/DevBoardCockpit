import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveInsideCard, mimeFor } from '../../../src/main/cards/paths';
import { join, sep } from 'node:path';

/**
 * 卡片目录里的路径解析与穿越防护。
 *
 * ── 为什么这是安全边界 ──
 *
 * 卡片是 **AI 写的任意网页**。它能请求 `cockpit://card/<id>/<路径>`。
 * 如果路径没守住，卡片就能读到**宿主的文件系统**——
 * 那是这个产品最不能出的事。
 *
 * 所以要挡的是：
 * `..` · 绝对路径 · Windows 盘符 · `%2e%2e`（URL 编码过的 `..`）· 空段。
 */
describe('卡片目录内的路径解析', () => {
  const root = join('/cards', 'cpu-usage');

  it('普通相对路径 → 落在目录里', () => {
    expect(resolveInsideCard(root, 'index.html')).toBe(join(root, 'index.html'));
  });

  it('`..` 越界 → null', () => {
    expect(resolveInsideCard(root, '../secret.txt')).toBeNull();
    expect(resolveInsideCard(root, 'a/../../b.txt')).toBeNull();
  });

  it('绝对路径 → null（哪怕它指向目录里面）', () => {
    expect(resolveInsideCard(root, '/etc/passwd')).toBeNull();
  });

  it('URL 编码过的 `..` → null（**先 decode 再判**）', () => {
    expect(resolveInsideCard(root, '%2e%2e/secret.txt')).toBeNull();
    expect(resolveInsideCard(root, '%2E%2E/secret.txt')).toBeNull();
  });

  it('目录里面的 `..`（没越界）→ 允许', () => {
    expect(resolveInsideCard(root, 'sub/../index.html')).toBe(join(root, 'index.html'));
  });

  it('空路径 → null', () => {
    expect(resolveInsideCard(root, '')).toBeNull();
  });

  it('结尾是 `/`（那是目录，不是文件）→ null', () => {
    expect(resolveInsideCard(root, 'sub/')).toBeNull();
  });

  it('解出来的路径一定在 root 底下（**判据不是字符串比较**）', () => {
    const resolved = resolveInsideCard(root, 'a/b/../c.js');
    expect(resolved).not.toBeNull();
    expect(resolved?.startsWith(root + sep)).toBe(true);
  });
});

describe('符号链接（软链是最常见的绕过）', () => {
  function scene(): { root: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), 'card-symlink-'));
    const root = join(base, 'card');
    mkdirSync(root, { recursive: true });
    // **宿主的文件**：卡片目录之外
    writeFileSync(join(base, 'secret.txt'), 'SECRET-HOST-FILE', 'utf8');
    return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it('软链指向卡片目录**之外** → null（词法上在目录里，realpath 后在外面）', () => {
    const { root, cleanup } = scene();
    try {
      symlinkSync(join(root, '..', 'secret.txt'), join(root, 'link.txt'));
      expect(resolveInsideCard(root, 'link.txt')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('软链指向**目录之外的一个目录** → null', () => {
    const { root, cleanup } = scene();
    try {
      const outsideDir = join(root, '..', 'outside');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'x.txt'), 'X', 'utf8');
      symlinkSync(outsideDir, join(root, 'outdir'));
      expect(resolveInsideCard(root, 'outdir/x.txt')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('软链指向**卡片目录之内** → 允许（同一份代码的别名不算越界）', () => {
    const { root, cleanup } = scene();
    try {
      writeFileSync(join(root, 'real.txt'), 'ok', 'utf8');
      symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'));
      expect(resolveInsideCard(root, 'alias.txt')).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('MIME 类型', () => {
  it('js 是 text/javascript（**给错就 module script 被拒**）', () => {
    expect(mimeFor('x.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('x.mjs')).toBe('text/javascript; charset=utf-8');
  });

  it('html / css / json / 图片各归各位', () => {
    expect(mimeFor('x.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('x.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('x.json')).toBe('application/json; charset=utf-8');
    expect(mimeFor('x.svg')).toBe('image/svg+xml');
    expect(mimeFor('x.png')).toBe('image/png');
  });

  it('不认识的 → 二进制（**不猜**）', () => {
    expect(mimeFor('x.bin')).toBe('application/octet-stream');
  });
});
