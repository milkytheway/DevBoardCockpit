import type { ThemeMode } from '../theme';
import { LOCALES, LOCALE_NAMES, useT, type Locale, type Localised } from '../i18n';
import type { ViewDensity } from '../../../shared/layout';
import type { PermissionActor, PermissionRow } from '../../../shared/ipc-contract';
import { PaletteIcon } from '../Icons';

/**
 * **Interface wording** —— every string the user can read is in this table ✓.
 *
 * Each entry sits next to the code that uses it, and `t()` picks the one for
 * the active locale ✓.
 */
const strings = {
  // ── Shortcuts ──
  shortcutPalette: { 'zh-Hans': '命令面板', en: 'Command palette' },
  shortcutTerminal: { 'zh-Hans': '去 / 回终端页', en: 'Go to / back from the terminal page' },
  shortcutDismiss: { 'zh-Hans': '关闭详情 / 命令面板', en: 'Close the detail pane / command palette' },

  // ── Page header ──
  title: { 'zh-Hans': '设置', en: 'Settings' },
  subtitle: {
    'zh-Hans': '外壳只管呈现；连接、卡片与权限都在 main',
    en: 'The shell only presents; connections, cards and permissions live in main',
  },

  // ── Appearance ──
  appearance: { 'zh-Hans': '外观', en: 'Appearance' },
  appearanceHead: {
    'zh-Hans': '主题走 token 三层：改种子，不重写组件',
    en: 'The theme runs on three token layers: change the seed, not the components',
  },
  themeGroup: { 'zh-Hans': '主题', en: 'Theme' },
  dark: { 'zh-Hans': '深色', en: 'Dark' },
  light: { 'zh-Hans': '浅色', en: 'Light' },
  appearanceNote: {
    'zh-Hans': '主题走 token 三层：改种子，不重写组件。切主题时外壳与卡片一起换——卡片宿主把主题推给 main，重新加载 iframe 时取同一套 token。',
    en: 'The theme runs on three token layers: change the seed, not the components. Switching the theme swaps the shell and the cards together — the card host pushes the theme to main, and the reloaded iframe picks up the same set of tokens.',
  },
  cardDensity: { 'zh-Hans': '卡片密度', en: 'Card density' },
  densityGroup: { 'zh-Hans': '密度', en: 'Density' },
  comfortable: { 'zh-Hans': '舒适', en: 'Comfortable' },
  compact: { 'zh-Hans': '紧凑', en: 'Compact' },
  interfaceLanguage: { 'zh-Hans': '界面语言', en: 'Interface language' },
  languageGroup: { 'zh-Hans': '语言', en: 'Language' },
  languageNote: { 'zh-Hans': '选择立即生效，无需重启。', en: 'The choice takes effect at once; no restart needed.' },

  // ── Keyboard ──
  keyboard: { 'zh-Hans': '键盘', en: 'Keyboard' },
  keyboardNote: { 'zh-Hans': '全部操作都有命令行入口', en: 'Every action has a command line entry' },

  // ── Runtime ──
  runtime: { 'zh-Hans': '运行面', en: 'Runtime' },
  runtimeNote: { 'zh-Hans': '宿主能力与通道', en: 'Host capabilities and channels' },
  connections: { 'zh-Hans': '连接', en: 'Connections' },
  profilesCount: { 'zh-Hans': '个 profile', en: 'profiles' },
  cards: { 'zh-Hans': '卡片', en: 'Cards' },
  cardsCount: { 'zh-Hans': '张（内置 + 用户目录）', en: 'cards (built in + user directory)' },
  cardChannels: { 'zh-Hans': '卡片通道', en: 'Card channels' },
  dataChannels: { 'zh-Hans': '数据通道', en: 'Data channels' },
  rescanCards: { 'zh-Hans': '重新扫描卡片目录', en: 'Rescan the card directories' },

  // ── Permissions ──
  permissions: { 'zh-Hans': '权限', en: 'Permissions' },
  permissionsHead: {
    'zh-Hans': '所有能动的操作都在这儿 —— 想关哪个关哪个',
    en: 'Every action that can move something is here — switch off whatever you like',
  },
  permissionsNote: {
    'zh-Hans': '一个地方，一个开关。打开的类目，卡片就能用；危险动作不跟着整类开关走，必须逐条打开。',
    en: 'One place, one switch. A category that is on is available to cards; destructive actions do not follow the category switch and have to be enabled one by one.',
  },
  noPermissions: { 'zh-Hans': '没有可设的操作 —— 先接上一块板。', en: 'Nothing to configure — connect a board first.' },
  groupActions: { 'zh-Hans': '元操作', en: 'Meta operations' },
  groupActionsNote: { 'zh-Hans': '板子上的原子动作', en: 'Atomic actions on the board' },
  groupWorkflows: { 'zh-Hans': '流程', en: 'Workflows' },
  groupWorkflowsNote: {
    'zh-Hans': '编译、体检、抓帧这类多步流程',
    en: 'Multi-step workflows such as build, health check and frame capture',
  },
  groupHost: { 'zh-Hans': '宿主', en: 'Host' },
  groupHostNote: { 'zh-Hans': '不碰板子的宿主能力', en: 'Host capabilities that do not touch the board' },
  noComparableActions: { 'zh-Hans': '这块板没有可比授权的动作', en: 'This board has no actions to authorise' },
  noWorkflowPack: { 'zh-Hans': '还没有安装流程包', en: 'No workflow pack is installed yet' },
  openToCards: { 'zh-Hans': '条对卡片开放', en: 'open to cards' },
  destructiveNote: { 'zh-Hans': '危险动作需逐条打开：', en: 'Destructive actions have to be enabled one by one: ' },
  listSeparator: { 'zh-Hans': '、', en: ', ' },
  dangerBadge: { 'zh-Hans': '危险', en: 'Dangerous' },
  switchLabelCard: { 'zh-Hans': '卡片', en: 'Card' },
  cardGrant: { 'zh-Hans': '卡片授权', en: 'card access' },
  agentGrant: { 'zh-Hans': 'agent 授权', en: 'agent access' },
  grantPrefix: { 'zh-Hans': '为卡片打开', en: 'Grant ' },
  grantSuffix: { 'zh-Hans': '授权', en: ' to cards' },

  // ── About ──
  about: { 'zh-Hans': '关于', en: 'About' },
  aboutVersion: { 'zh-Hans': 'DevBoard Cockpit · 外壳 v0.11', en: 'DevBoard Cockpit · shell v0.11' },
  aboutNote: {
    'zh-Hans': '卡片宿主、沙箱与 CSP 是 main 的职责；这个外壳只画，不判权限，不碰设备。',
    en: 'The card host, the sandbox and the CSP belong to main; this shell only draws, it neither judges permissions nor touches the device.',
  },
  aboutDesign: {
    'zh-Hans': '配色与卡片内部遵循同一套视觉规范；卡片只能使用宿主注入的 `--cockpit-*` 变量。',
    en: 'Colour and card interiors follow one visual specification; a card may only use the `--cockpit-*` variables the host injects.',
  },
} satisfies Record<string, Localised>;

const SHORTCUTS: readonly { keys: string; action: Localised }[] = [
  { keys: 'Ctrl + K', action: strings.shortcutPalette },
  { keys: 'Ctrl + `', action: strings.shortcutTerminal },
  { keys: 'Esc', action: strings.shortcutDismiss },
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
  /** **The unified permission area** (the table on the settings page ✓ · ADR-D47 ✓) */
  permissions: PermissionRow[];
  /** Change one entry (**idempotent** ✓) */
  onPermission: (actor: PermissionActor, op: string, allowed: boolean) => void;
  /** The interface language. */
  locale: Locale;
  /** Change it. */
  onLocale: (locale: Locale) => void;
}): JSX.Element {
  const t = useT();
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
      { kind: 'action', label: t(strings.groupActions), note: t(strings.groupActionsNote) },
      { kind: 'workflow', label: t(strings.groupWorkflows), note: t(strings.groupWorkflowsNote) },
      { kind: 'host', label: t(strings.groupHost), note: t(strings.groupHostNote) },
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
          <h1 className="page-head__title">{t(strings.title)}</h1>
          <p className="page-head__sub">{t(strings.subtitle)}</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="settings-card">
          <header className="settings-card__head">
            <span className="settings-card__icon" aria-hidden>
              <PaletteIcon size={16} />
            </span>
            <div>
              <h2>{t(strings.appearance)}</h2>
              <p>{t(strings.appearanceHead)}</p>
            </div>
          </header>
          <div className="segmented" role="group" aria-label={t(strings.themeGroup)}>
            {(['dark', 'light'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? 'is-active' : ''}
                aria-pressed={theme === mode}
                onClick={() => onTheme(mode)}
              >
                {mode === 'dark' ? t(strings.dark) : t(strings.light)}
              </button>
            ))}
          </div>
          <p className="settings-note">{t(strings.appearanceNote)}</p>

          <h3 className="settings-card__sub">{t(strings.cardDensity)}</h3>
          <div className="segmented" role="group" aria-label={t(strings.densityGroup)}>
            {(['comfortable', 'compact'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={density === mode ? 'is-active' : ''}
                aria-pressed={density === mode}
                onClick={() => onDensity(mode)}
              >
                {mode === 'comfortable' ? t(strings.comfortable) : t(strings.compact)}
              </button>
            ))}
          </div>

          <h3 className="settings-card__sub">{t(strings.interfaceLanguage)}</h3>
          <div className="segmented" role="group" aria-label={t(strings.languageGroup)}>
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
          <p className="settings-note">{t(strings.languageNote)}</p>
        </section>

        <section className="settings-card">
          <header className="settings-card__head">
            <div>
              <h2>{t(strings.keyboard)}</h2>
              <p>{t(strings.keyboardNote)}</p>
            </div>
          </header>
          <ul className="shortcut-list">
            {SHORTCUTS.map((row) => (
              <li key={row.keys}>
                <kbd>{row.keys}</kbd>
                <span>{t(row.action)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="settings-card">
          <header className="settings-card__head">
            <div>
              <h2>{t(strings.runtime)}</h2>
              <p>{t(strings.runtimeNote)}</p>
            </div>
          </header>
          <dl className="kv kv--compact">
            <dt>{t(strings.connections)}</dt>
            <dd>
              {connectionsCount} {t(strings.profilesCount)}
            </dd>
            <dt>{t(strings.cards)}</dt>
            <dd>
              {cardsCount} {t(strings.cardsCount)}
            </dd>
            <dt>{t(strings.cardChannels)}</dt>
            <dd className="mono">cardsList · cardsHello · layoutGet</dd>
            <dt>{t(strings.dataChannels)}</dt>
            <dd className="mono">tagsReadings · tagsChanged</dd>
          </dl>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefreshCards}>
            {t(strings.rescanCards)}
          </button>
        </section>

        <section className="settings-card settings-card--permissions">
          <header className="settings-card__head">
            <div>
              <h2>{t(strings.permissions)}</h2>
              <p>{t(strings.permissionsHead)}</p>
            </div>
          </header>
          <p className="settings-note">{t(strings.permissionsNote)}</p>
          {permissions.length === 0 ? (
            <p className="settings-note dim">{t(strings.noPermissions)}</p>
          ) : (
            <>
              <div className="perm-master">
                <MasterToggle
                  label={t(strings.groupActions)}
                  detail={
                    bulkActions.length === 0
                      ? t(strings.noComparableActions)
                      : `${bulkActions.filter((row) => row.card).length} / ${bulkActions.length} ${t(strings.openToCards)}`
                  }
                  checked={
                    bulkActions.length > 0 && bulkActions.every((row) => row.card)
                  }
                  disabled={bulkActions.length === 0}
                  onChange={(allowed) => setAll(bulkActions, allowed)}
                />
                <MasterToggle
                  label={t(strings.groupWorkflows)}
                  detail={
                    bulkWorkflows.length === 0
                      ? t(strings.noWorkflowPack)
                      : `${bulkWorkflows.filter((row) => row.card).length} / ${bulkWorkflows.length} ${t(strings.openToCards)}`
                  }
                  checked={
                    bulkWorkflows.length > 0 && bulkWorkflows.every((row) => row.card)
                  }
                  disabled={bulkWorkflows.length === 0}
                  onChange={(allowed) => setAll(bulkWorkflows, allowed)}
                />
                {destructive.length > 0 ? (
                  <p className="perm-master__note">
                    {t(strings.destructiveNote)}
                    {destructive.map((row) => row.label).join(t(strings.listSeparator))}
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
                                <span className="perm-row__danger">{t(strings.dangerBadge)}</span>
                              ) : null}
                            </span>
                            <span className="perm-row__op mono">{row.op}</span>
                            {row.hint ? <span className="perm-row__hint">{row.hint}</span> : null}
                          </div>
                          <div className="perm-row__switches">
                            <div className="perm-row__switch">
                              <span className="perm-row__switch-label">
                                {t(strings.switchLabelCard)}
                              </span>
                              <Switch
                                checked={row.card}
                                label={`${row.label} · ${t(strings.cardGrant)}`}
                                onChange={(next) => onPermission('card', row.op, next)}
                              />
                            </div>
                            <div className="perm-row__switch">
                              <span className="perm-row__switch-label">agent</span>
                              <Switch
                                checked={row.agent}
                                label={`${row.label} · ${t(strings.agentGrant)}`}
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
              <h2>{t(strings.about)}</h2>
              <p>{t(strings.aboutVersion)}</p>
            </div>
          </header>
          <p className="settings-note">{t(strings.aboutNote)}</p>
          <p className="settings-note dim">{t(strings.aboutDesign)}</p>
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
  const t = useT();
  return (
    <div className={`perm-master__row${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className="perm-master__text">
        <b>{label}</b>
        <small>{detail}</small>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        label={`${t(strings.grantPrefix)}${label}${t(strings.grantSuffix)}`}
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