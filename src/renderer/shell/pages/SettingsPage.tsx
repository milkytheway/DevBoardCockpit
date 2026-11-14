import type { ThemeMode } from '../theme';
import type { ViewDensity } from '../../../shared/layout';
import { PaletteIcon } from '../Icons';

const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Ctrl + K', action: '命令面板' },
  { keys: 'Ctrl + `', action: '去 / 回终端页' },
  { keys: 'Esc', action: '关闭详情 / 命令面板' },
];

export function SettingsPage({
  theme,
  onTheme,
  density,
  onDensity,
  cardsCount,
  connectionsCount,
  onRefreshCards,
}: {
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  /** Grid density — how much of the screen one card takes. */
  density: ViewDensity;
  onDensity: (density: ViewDensity) => void;
  cardsCount: number;
  connectionsCount: number;
  onRefreshCards: () => void;
}): JSX.Element {
  return (
    <div className="page page--settings">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">SETTINGS</span>
          <h1 className="page-head__title">设置</h1>
          <p className="page-head__sub">外壳只管呈现；连接、卡片与权限都在 main</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="settings-card">
          <header className="settings-card__head">
            <span className="settings-card__icon" aria-hidden>
              <PaletteIcon size={16} />
            </span>
            <div>
              <h2>外观</h2>
              <p>主题走 token 三层：改种子，不重写组件</p>
            </div>
          </header>
          <div className="segmented" role="group" aria-label="主题">
            {(['dark', 'light'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? 'is-active' : ''}
                aria-pressed={theme === mode}
                disabled={mode === 'light'}
                title={mode === 'light' ? '浅色外壳待卡片主题通道接入（M6）' : '当前主题'}
                onClick={() => onTheme(mode)}
              >
                {mode === 'dark' ? '深色' : '浅色（待接入）'}
              </button>
            ))}
          </div>
          <p className="settings-note">
            外壳深色已就绪；浅色外壳的卡片颜色需要主进程把主题推给卡片（M6）。主题仍走 token 三层：改种子，不重写组件。
          </p>

          <h3 className="settings-card__sub">卡片密度</h3>
          <div className="segmented" role="group" aria-label="密度">
            {(['comfortable', 'compact'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={density === mode ? 'is-active' : ''}
                aria-pressed={density === mode}
                onClick={() => onDensity(mode)}
              >
                {mode === 'comfortable' ? '舒适' : '紧凑'}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card">
          <header className="settings-card__head">
            <div>
              <h2>键盘</h2>
              <p>全部操作都有命令行入口</p>
            </div>
          </header>
          <ul className="shortcut-list">
            {SHORTCUTS.map((row) => (
              <li key={row.keys}>
                <kbd>{row.keys}</kbd>
                <span>{row.action}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="settings-card">
          <header className="settings-card__head">
            <div>
              <h2>运行面</h2>
              <p>宿主能力与通道</p>
            </div>
          </header>
          <dl className="kv kv--compact">
            <dt>连接</dt>
            <dd>{connectionsCount} 个 profile</dd>
            <dt>卡片</dt>
            <dd>{cardsCount} 张（内置 + 用户目录）</dd>
            <dt>卡片通道</dt>
            <dd className="mono">cardsList · cardsHello · layoutGet</dd>
            <dt>数据通道</dt>
            <dd className="mono">tagsReadings · tagsChanged</dd>
          </dl>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefreshCards}>
            重新扫描卡片目录
          </button>
        </section>

        <section className="settings-card settings-card--about">
          <header className="settings-card__head">
            <div>
              <h2>关于</h2>
              <p>DevBoard Cockpit · 外壳 v0.5（M5b）</p>
            </div>
          </header>
          <p className="settings-note">
            卡片宿主、沙箱与 CSP 是 main 的职责；这个外壳只画，不判权限，不碰设备。
          </p>
          <p className="settings-note dim">
            设计依据 docs/UI设计/01-UI设计总纲.md · 机制基线 docs/21 · 边界 docs/UI设计/05-外壳施工图.md
          </p>
        </section>
      </div>
    </div>
  );
}
