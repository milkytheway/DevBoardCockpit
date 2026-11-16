import type { ThemeMode } from '../theme';
import type { ViewDensity } from '../../../shared/layout';
import type { PermissionActor, PermissionRow } from '../../../shared/ipc-contract';
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
  permissions,
  onPermission,
}: {
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  /** Grid density — how much of the screen one card takes. */
  density: ViewDensity;
  onDensity: (density: ViewDensity) => void;
  cardsCount: number;
  connectionsCount: number;
  onRefreshCards: () => void;
  /** **统一权限区**（设置页那张表 ✓ · ADR-D47 ✓） */
  permissions: PermissionRow[];
  /** 改一条（**幂等** ✓） */
  onPermission: (actor: PermissionActor, op: string, allowed: boolean) => void;
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
                onClick={() => onTheme(mode)}
              >
                {mode === 'dark' ? '深色' : '浅色'}
              </button>
            ))}
          </div>
          <p className="settings-note">
            主题走 token 三层：改种子，不重写组件。切主题时外壳与卡片一起换——卡片宿主把主题推给 main，重新加载 iframe 时取同一套 token。
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

        <section className="settings-card settings-card--permissions">
          <header className="settings-card__head">
            <div>
              <h2>权限</h2>
              <p>所有能动的操作都在这儿 —— 想关哪个关哪个</p>
            </div>
          </header>
          <p className="settings-note">
            一个地方，一个开关，不再弹窗。<strong>卡片</strong>是界面上的卡，
            <strong>agent</strong>是 MCP 那条路。默认：卡片不许写板子（触发流程可以），
            agent 照常（它那边本来就有人的确认）。
          </p>
          {permissions.length === 0 ? (
            <p className="settings-note dim">没有可设的操作 —— 先接上一块板。</p>
          ) : (
            <ul className="perm-list">
              {permissions.map((row) => (
                <li key={row.op} className="perm-row">
                  <div className="perm-row__text">
                    <span className="perm-row__label">{row.label}</span>
                    <span className="perm-row__op mono">{row.op}</span>
                    {row.hint ? <span className="perm-row__hint">{row.hint}</span> : null}
                  </div>
                  <div className="perm-row__switches">
                    <label className="perm-switch">
                      <input
                        type="checkbox"
                        checked={row.card}
                        onChange={(e) => onPermission('card', row.op, e.target.checked)}
                      />
                      <span>卡片</span>
                    </label>
                    <label className="perm-switch">
                      <input
                        type="checkbox"
                        checked={row.agent}
                        onChange={(e) => onPermission('agent', row.op, e.target.checked)}
                      />
                      <span>agent</span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
