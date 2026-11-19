import type { ThemeMode } from '../theme';
import { LOCALES, LOCALE_NAMES, type Locale } from '../i18n';
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
  locale,
  onLocale,
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
  /** The interface language. */
  locale: Locale;
  /** Change it. */
  onLocale: (locale: Locale) => void;
}): JSX.Element {
  // The master switches only touch **card** grants: the agent side keeps its
  // own row. Destructive actions stay out of the bulk grant — one switch must
  // not hand a card the power to reboot the board.
  const bulkActions = permissions.filter(
    (row) => row.kind === 'action' && row.danger !== 'destructive',
  );
  const bulkWorkflows = permissions.filter((row) => row.kind === 'workflow');
  const destructive = permissions.filter(
    (row) => row.kind === 'action' && row.danger === 'destructive',
  );
  const setAll = (rows: PermissionRow[], allowed: boolean): void => {
    for (const row of rows) onPermission('card', row.op, allowed);
  };
  const groups = (
    [
      { kind: 'action', label: '元操作', note: '板子上的原子动作' },
      { kind: 'workflow', label: '流程', note: '编译、体检、抓帧这类多步流程' },
      { kind: 'host', label: '宿主', note: '不碰板子的宿主能力' },
    ] as const
  )
    .map((group) => ({
      ...group,
      rows: permissions.filter((row) => row.kind === group.kind),
    }))
    .filter((group) => group.rows.length > 0);

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

          <h3 className="settings-card__sub">界面语言</h3>
          <div className="segmented" role="group" aria-label="语言">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                className={locale === option ? 'is-active' : ''}
                aria-pressed={locale === option}
                onClick={() => onLocale(option)}
              >
                {LOCALE_NAMES[option]}
              </button>
            ))}
          </div>
          <p className="settings-note">选择立即生效，无需重启。</p>
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
            一个地方，一个开关。打开的类目，卡片就能用；危险动作不跟着整类开关走，
            必须逐条打开。
          </p>
          {permissions.length === 0 ? (
            <p className="settings-note dim">没有可设的操作 —— 先接上一块板。</p>
          ) : (
            <>
              <div className="perm-master">
                <MasterToggle
                  label="元操作"
                  detail={
                    bulkActions.length === 0
                      ? '这块板没有可比授权的动作'
                      : `${bulkActions.filter((row) => row.card).length} / ${bulkActions.length} 条对卡片开放`
                  }
                  checked={
                    bulkActions.length > 0 && bulkActions.every((row) => row.card)
                  }
                  disabled={bulkActions.length === 0}
                  onChange={(allowed) => setAll(bulkActions, allowed)}
                />
                <MasterToggle
                  label="流程"
                  detail={
                    bulkWorkflows.length === 0
                      ? '还没有安装流程包'
                      : `${bulkWorkflows.filter((row) => row.card).length} / ${bulkWorkflows.length} 条对卡片开放`
                  }
                  checked={
                    bulkWorkflows.length > 0 && bulkWorkflows.every((row) => row.card)
                  }
                  disabled={bulkWorkflows.length === 0}
                  onChange={(allowed) => setAll(bulkWorkflows, allowed)}
                />
                {destructive.length > 0 ? (
                  <p className="perm-master__note">
                    危险动作需逐条打开：
                    {destructive.map((row) => row.label).join('、')}
                  </p>
                ) : null}
              </div>
              <div className="perm-groups">
                {groups.map((group) => (
                  <section key={group.kind} className="perm-group">
                    <header className="perm-group__head">
                      <h3>{group.label}</h3>
                      <span className="perm-group__count">{group.rows.length}</span>
                      <span className="perm-group__note">{group.note}</span>
                    </header>
                    <ul className="perm-list">
                      {group.rows.map((row) => (
                        <li key={row.op} className="perm-row">
                          <div className="perm-row__text">
                            <span className="perm-row__label">
                              {row.label}
                              {row.danger === 'destructive' ? (
                                <span className="perm-row__danger">危险</span>
                              ) : null}
                            </span>
                            <span className="perm-row__op mono">{row.op}</span>
                            {row.hint ? <span className="perm-row__hint">{row.hint}</span> : null}
                          </div>
                          <div className="perm-row__switches">
                            <div className="perm-row__switch">
                              <span className="perm-row__switch-label">卡片</span>
                              <Switch
                                checked={row.card}
                                label={`${row.label} · 卡片授权`}
                                onChange={(next) => onPermission('card', row.op, next)}
                              />
                            </div>
                            <div className="perm-row__switch">
                              <span className="perm-row__switch-label">agent</span>
                              <Switch
                                checked={row.agent}
                                label={`${row.label} · agent 授权`}
                                onChange={(next) => onPermission('agent', row.op, next)}
                              />
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="settings-card settings-card--about">
          <header className="settings-card__head">
            <div>
              <h2>关于</h2>
              <p>DevBoard Cockpit · 外壳 v0.11</p>
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

/**
 * A class-wide consent switch.
 *
 * It writes every row of its kind through `onPermission`, so the row list
 * below is the single source of truth — the switch is a shortcut, not a
 * second permission store.
 */
function MasterToggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onChange: (allowed: boolean) => void;
}): JSX.Element {
  return (
    <div className={`perm-master__row${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className="perm-master__text">
        <b>{label}</b>
        <small>{detail}</small>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        label={`为卡片打开${label}授权`}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * One Ant-Design-style switch.
 *
 * It is a button with `role="switch"` rather than a styled checkbox so the
 * whole control is one hit target and the accessibility state is explicit.
 */
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" aria-hidden />
    </button>
  );
}
