import type { ThemeMode } from './theme';

const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Ctrl + K', action: '命令面板' },
  { keys: 'Ctrl + `', action: '展开 / 收起底部工具' },
  { keys: 'Esc', action: '关闭检查器 / 命令面板' },
  { keys: 'Ctrl + 1..4', action: '切换视图（预留）' },
];

export function SettingsPage({
  theme,
  onTheme,
  cardsCount,
  connectionsCount,
  onRefreshCards,
}: {
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
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
          换主题后，终端会重挂一次以读取新 token；卡片通过宿主注入的 theme.css 跟随。
        </p>
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
