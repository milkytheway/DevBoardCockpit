/**
 * ⚠️ **假设备** —— 一块**虚拟文件系统**。
 *
 * ── 为什么假设备要有一块盘 ──
 *
 * 写侧（M6）要证明的是「**动作执行 → 回读 → 界面按回读值渲染**」，
 * 而回读的五种形式里有三种落在**文件与命令**上：
 * `file_equals`（读文件比值）、`command_ok`（看退出码）、`verify`（跑二次命令）。
 *
 * → 假设备**不能只会吐 `/proc` 文本**：它得能**写文件、能读回、能被 grep**。
 * 否则「动作闭环」这条判据在假设备上根本跑不了（只能靠真板 → 不可自动化）。
 *
 * ── 三条「诚实」的要求 ──
 *
 * 1. **真传**：推上去的文件真的落在虚拟盘里，拉下来的文件真的落在宿主磁盘上
 *    ——「报告成功却不传文件」这种骗人的事不再发生；
 * 2. **不假装有**：拉一个不存在的文件**报错**，不是**报告成功**；
 * 3. **字节保真**：存的是 **Buffer** 不是字符串
 *    —— `.ko` 是二进制，用字符串存会把它毁掉（转码即损坏）。
 *
 * ── 一块板子只有一块盘 ──
 *
 * 所以这块 fs **按 profile id 分**：同一个假 profile 的两条连接
 * （运行时的连接、终端标签的连接）看到**同一块盘**——
 * 运行时写进去的文件，文件浏览器看得见。
 */

/** 一个目录项（与 HAL 的 `FileEntry` 同形，但这里多一个 size） */
export interface VirtualEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
}

export class VirtualFs {
  /** 绝对路径 → 内容 */
  private readonly files = new Map<string, Buffer>();

  /** 写一个文件（建不建父目录都无所谓——这是一块扁平的文件系统） */
  write(path: string, content: string | Buffer): void {
    this.files.set(normalizePath(path), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  /** 读一个文件；没有就是 `null`（**不是空串**——空文件与没有文件是两件事） */
  read(path: string): Buffer | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  /** 读一个文件（当文本用） */
  readText(path: string): string | null {
    const buffer = this.read(path);
    return buffer === null ? null : buffer.toString('utf8');
  }

  /** 这个路径上有东西吗 */
  exists(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** 删一个文件（没有就是 `false`） */
  remove(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** 列一个目录的**直接子项**（文件与子目录） */
  list(dir: string): VirtualEntry[] {
    const base = normalizePath(dir);
    const prefix = base === '' || base === '/' ? '/' : `${base}/`;
    const files = new Map<string, VirtualEntry>();
    const dirs = new Set<string>();
    for (const [path, content] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.set(rest, {
          name: rest,
          path,
          isDirectory: false,
          sizeBytes: content.length,
        });
        continue;
      }
      //  deeper → 是个子目录
      dirs.add(rest.slice(0, slash));
    }
    const out: VirtualEntry[] = [];
    for (const name of [...dirs].sort()) {
      out.push({ name, path: `${prefix}${name}`, isDirectory: true, sizeBytes: null });
    }
    for (const entry of [...files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(entry);
    }
    return out;
  }

  /** 全部路径（诊断用） */
  paths(): string[] {
    return [...this.files.keys()];
  }
}

/** 路径归一：去掉重复的 `/`、去掉结尾的 `/`（根目录除外） */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  const collapsed = trimmed.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * 每块假板子一块 fs（**按 profile id 分**）。
 *
 * → 同一个假 profile 的两条连接看到同一块盘 ✓
 * → 换一个 profile id 就是**另一块板子**（互不串台）✓
 */
const FILESYSTEMS = new Map<string, VirtualFs>();

export function fakeFilesystem(profileId: string): VirtualFs {
  const existing = FILESYSTEMS.get(profileId);
  if (existing !== undefined) return existing;
  const created = new VirtualFs();
  // **给这块盘放两个惯例文件**——文件浏览器一打开就有东西看
  // （以前那是 `list()` 硬编出来的两个条目；现在它们**真的在盘上**）。
  created.write('/README.txt', 'This is a fake board. Everything here is synthetic data.\n');
  created.write('/etc/hostname', 'fake-board\n');
  FILESYSTEMS.set(profileId, created);
  return created;
}
