import type { ThemeMode } from '../theme';
import type { ViewDensity } from '../../../shared/layout';

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
    <div className="settings">
      <header className="settings__head">
        <h1>设置</h1>
        <p className="dim">外壳只管呈现；连接、卡片与权限都在 main。</p>
      </header>

      <section className="settings__card">
        <h2>外观</h2>
        <p className="dim">主题走 token 三层：改种子，不重写组件。默认深色。</p>
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
        <p className="dim settings__probe">
          换主题后，终端**原地换色**（不重建，屏幕不会丢）；卡片通过宿主注入的 theme.css 跟随。
        </p>

        <h2>密度</h2>
        <p className="dim">一屏能看几张卡片。</p>
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

      <section className="settings__card">
        <h2>键盘</h2>
        <table className="readings-table">
          <thead>
            <tr>
              <th>快捷键</th>
              <th>动作</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((row) => (
              <tr key={row.keys}>
                <td className="mono">{row.keys}</td>
                <td>{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="settings__card">
        <h2>运行面</h2>
        <dl className="kv">
          <dt>连接</dt>
          <dd>{connectionsCount} 个 profile</dd>
          <dt>卡片</dt>
          <dd>{cardsCount} 张（内置 + 用户目录）</dd>
          <dt>卡片通道</dt>
          <dd>cardsList / cardsHello / cardsRequest / layoutGet / layoutSet</dd>
          <dt>数据通道</dt>
          <dd>tagsReadings / tagsChanged / tagsStatus（只读，renderer 不碰设备）</dd>
        </dl>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRefreshCards}>
          重新扫描卡片
        </button>
      </section>

      <section className="settings__card settings__about">
        <h2>关于</h2>
        <p>
          DevBoard Cockpit · 外壳 v0.5（M5b）。卡片宿主、沙箱与 CSP 是 main 的职责；这个外壳只画，不判权限，
          不碰设备。
        </p>
        <p className="dim">
          设计依据：docs/UI设计/01-UI设计总纲.md；机制基线：docs/21；边界：docs/UI设计/05-外壳施工图.md。
        </p>
      </section>
    </div>
  );
}
