import { useState } from 'react';
import type { PermissionActor, PermissionRow } from '../../../shared/ipc-contract';
import type { ViewDensity } from '../../../shared/layout';
import { BoardSetup } from '../BoardSetup';
import {
  ActivityIcon,
  BoardIcon,
  GaugeIcon,
  ListIcon,
  PaletteIcon,
  RefreshIcon,
} from '../Icons';
import {
  LOCALES,
  LOCALE_NAMES,
  pick,
  useLocale,
  useT,
  type Locale,
  type Localised,
} from '../i18n';
import type { ThemeMode } from '../theme';

type SettingsSection = 'general' | 'board' | 'permissions' | 'shortcuts' | 'about';

const strings = {
  title: { 'zh-Hans': '设置', en: 'Settings' },
  categories: { 'zh-Hans': '设置分类', en: 'Settings categories' },
  preferences: { 'zh-Hans': '偏好', en: 'Preferences' },
  device: { 'zh-Hans': '设备', en: 'Device' },
  security: { 'zh-Hans': '安全', en: 'Security' },
  advanced: { 'zh-Hans': '高级', en: 'Advanced' },
  general: { 'zh-Hans': '通用', en: 'General' },
  board: { 'zh-Hans': '开发板', en: 'Board' },
  permissions: { 'zh-Hans': '权限', en: 'Permissions' },
  shortcuts: { 'zh-Hans': '快捷键', en: 'Shortcuts' },
  about: { 'zh-Hans': '关于', en: 'About' },
  appearance: { 'zh-Hans': '外观', en: 'Appearance' },
  workspace: { 'zh-Hans': '工作区', en: 'Workspace' },
  theme: { 'zh-Hans': '主题', en: 'Theme' },
  dark: { 'zh-Hans': '深色', en: 'Dark' },
  light: { 'zh-Hans': '浅色', en: 'Light' },
  density: { 'zh-Hans': '卡片密度', en: 'Card density' },
  comfortable: { 'zh-Hans': '舒适', en: 'Comfortable' },
  compact: { 'zh-Hans': '紧凑', en: 'Compact' },
  language: { 'zh-Hans': '界面语言', en: 'Language' },
  languageGroup: { 'zh-Hans': '语言', en: 'Language' },
  connections: { 'zh-Hans': '连接', en: 'Connections' },
  cards: { 'zh-Hans': '卡片', en: 'Cards' },
  installed: { 'zh-Hans': '已安装', en: 'installed' },
  rescan: { 'zh-Hans': '重新扫描', en: 'Rescan' },
  rescanCards: { 'zh-Hans': '重新扫描卡片目录', en: 'Rescan the card directory' },
  boardValues: { 'zh-Hans': '本机连接值', en: 'Connection values' },
  permissionHeading: { 'zh-Hans': '操作授权', en: 'Action access' },
  noPermissions: { 'zh-Hans': '没有可配置的权限', en: 'Nothing to configure' },
  groupActions: { 'zh-Hans': '元操作', en: 'Actions' },
  groupWorkflows: { 'zh-Hans': '流程', en: 'Workflows' },
  groupHost: { 'zh-Hans': '宿主', en: 'Host' },
  noComparableActions: { 'zh-Hans': '无', en: 'None' },
  noWorkflowPack: { 'zh-Hans': '未安装', en: 'Not installed' },
  openToCards: { 'zh-Hans': '条对卡片开放', en: 'open to cards' },
  destructiveOnly: {
    'zh-Hans': '危险操作需单独开启',
    en: 'Dangerous actions are enabled individually',
  },
  danger: { 'zh-Hans': '危险', en: 'Danger' },
  card: { 'zh-Hans': '卡片', en: 'Card' },
  cardGrant: { 'zh-Hans': '卡片授权', en: 'card access' },
  agentGrant: { 'zh-Hans': 'agent 授权', en: 'agent access' },
  grantPrefix: { 'zh-Hans': '为卡片打开', en: 'Grant ' },
  grantSuffix: { 'zh-Hans': '授权', en: ' to cards' },
  commandPalette: { 'zh-Hans': '命令面板', en: 'Command palette' },
  terminalShortcut: { 'zh-Hans': '去 / 回终端页', en: 'Open / leave the terminal' },
  dismissShortcut: { 'zh-Hans': '关闭详情 / 命令面板', en: 'Close details / command palette' },
  version: { 'zh-Hans': '版本', en: 'Version' },
  versionValue: { 'zh-Hans': 'DevBoard Cockpit · Shell 0.11', en: 'DevBoard Cockpit · Shell 0.11' },
  renderer: { 'zh-Hans': '界面', en: 'Interface' },
  rendererValue: { 'zh-Hans': 'Electron · React', en: 'Electron · React' },
} satisfies Record<string, Localised>;

const SHORTCUTS: readonly { keys: string; action: Localised }[] = [
  { keys: 'Ctrl + K', action: strings.commandPalette },
  { keys: 'Ctrl + `', action: strings.terminalShortcut },
  { keys: 'Esc', action: strings.dismissShortcut },
];

const CATEGORIES: readonly {
  id: SettingsSection;
  label: Localised;
  group: Localised;
  icon: (props: { size?: number }) => JSX.Element;
}[] = [
  { id: 'general', label: strings.general, group: strings.preferences, icon: PaletteIcon },
  { id: 'board', label: strings.board, group: strings.device, icon: BoardIcon },
  { id: 'permissions', label: strings.permissions, group: strings.security, icon: ActivityIcon },
  { id: 'shortcuts', label: strings.shortcuts, group: strings.advanced, icon: ListIcon },
  { id: 'about', label: strings.about, group: strings.advanced, icon: GaugeIcon },
];

/** Display names for the shipped operations. Unknown operations keep the pack's label. */
const OPERATION_NAMES: Record<string, Localised> = {
  'action:backlight.set': { 'zh-Hans': '设置背光亮度', en: 'Set backlight brightness' },
  'action:system.reboot': { 'zh-Hans': '重启开发板', en: 'Reboot the board' },
  'action:cpu.governor.set': { 'zh-Hans': '设置 CPU 调频策略', en: 'Set CPU governor' },
  'action:led.set': { 'zh-Hans': '开关板载 LED', en: 'Toggle on-board LED' },
  'action:backlight1.set': { 'zh-Hans': '设置第二路背光亮度', en: 'Set second backlight brightness' },
  'action:cpu.governor.set_all': { 'zh-Hans': '设置全部 CPU 集群调频', en: 'Set all CPU cluster governors' },
  'action:network.iface.set': { 'zh-Hans': '开关网络接口', en: 'Bring network interface up / down' },
  'action:can.up': { 'zh-Hans': '启用 CAN 接口', en: 'Enable CAN interface' },
  'action:sysclock.set': { 'zh-Hans': '设置系统时间', en: 'Set system time' },
  'action:audio.play': { 'zh-Hans': '播放音频', en: 'Play audio' },
  'action:audio.record': { 'zh-Hans': '录制音频', en: 'Record audio' },
  'action:camera.snapshot': { 'zh-Hans': '拍摄一帧', en: 'Capture a camera frame' },
  'action:storage.benchmark': { 'zh-Hans': '存储写入测试', en: 'Storage write benchmark' },
  'action:module.load': { 'zh-Hans': '加载内核模块', en: 'Load kernel module' },
  'action:module.unload': { 'zh-Hans': '卸载内核模块', en: 'Unload kernel module' },
  'workflow:board-healthcheck.verify': { 'zh-Hans': '板卡体检', en: 'Board health check' },
  'workflow:board-selfcheck.verify': { 'zh-Hans': '厂商自检', en: 'Vendor self check' },
  'workflow:camera-capture.capture': { 'zh-Hans': '相机抓帧', en: 'Camera capture' },
  'workflow:hello-kernel.build-run': { 'zh-Hans': '编译并运行内核模块', en: 'Build and run kernel module' },
  'workflow:hello-kernel.compile': { 'zh-Hans': '编译内核模块', en: 'Compile kernel module' },
  'workflow:hello-kernel.load': { 'zh-Hans': '加载内核模块', en: 'Load kernel module' },
  'workflow:hello-kernel.upload': { 'zh-Hans': '上传内核模块', en: 'Upload kernel module' },
  'workflow:meminfo-user.build-run': { 'zh-Hans': '编译并运行用户程序', en: 'Build and run user program' },
  'workflow:network-iperf.measure': { 'zh-Hans': '网络测速', en: 'Network benchmark' },
  'workflow:storage-benchmark.measure': { 'zh-Hans': '存储测速', en: 'Storage benchmark' },
  'workflow:prepare-credentials.authorize-key': { 'zh-Hans': '安装 SSH 公钥', en: 'Install SSH public key' },
  'host:install_card': { 'zh-Hans': '安装卡片', en: 'Install card' },
  'host:uninstall_card': { 'zh-Hans': '卸载卡片', en: 'Uninstall card' },
  'host:promote_card': { 'zh-Hans': '提升卡片', en: 'Promote card' },
};

function operationLabel(row: PermissionRow, locale: Locale): string {
  const known = OPERATION_NAMES[row.op];
  return known === undefined ? row.label : pick(known, locale);
}

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
  onBoardApplied,
  reportError,
}: {
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  density: ViewDensity;
  onDensity: (density: ViewDensity) => void;
  cardsCount: number;
  connectionsCount: number;
  onRefreshCards: () => void;
  permissions: PermissionRow[];
  onPermission: (actor: PermissionActor, op: string, allowed: boolean) => void;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onBoardApplied?: () => void;
  reportError?: (message: string) => void;
}): JSX.Element {
  const t = useT();
  const [section, setSection] = useState<SettingsSection>('general');
  const active = CATEGORIES.find((category) => category.id === section) ?? CATEGORIES[0];
  let previousGroup = '';

  return (
    <div className="page page--settings">
      <div className="settings-shell">
        <aside className="settings-sidebar">
          <header className="settings-sidebar__head">
            <span className="settings-sidebar__eyebrow">DEVBOARD</span>
            <h1>{t(strings.title)}</h1>
          </header>
          <nav className="settings-nav" aria-label={t(strings.categories)}>
            {CATEGORIES.map((category) => {
              const Icon = category.icon;
              const group = t(category.group);
              const showGroup = group !== previousGroup;
              previousGroup = group;
              return (
                <div key={category.id} className="settings-nav__entry">
                  {showGroup ? <span className="settings-nav__group">{group}</span> : null}
                  <button
                    type="button"
                    className={`settings-nav__item${section === category.id ? ' is-active' : ''}`}
                    aria-current={section === category.id ? 'page' : undefined}
                    onClick={() => setSection(category.id)}
                  >
                    <Icon size={16} />
                    <span>{t(category.label)}</span>
                  </button>
                </div>
              );
            })}
          </nav>
        </aside>

        <section className="settings-content" aria-labelledby="settings-section-title">
          <header className="settings-content__head">
            <h2 id="settings-section-title">{active ? t(active.label) : ''}</h2>
          </header>

          {section === 'general' ? (
            <GeneralSettings
              theme={theme}
              onTheme={onTheme}
              density={density}
              onDensity={onDensity}
              locale={locale}
              onLocale={onLocale}
              cardsCount={cardsCount}
              connectionsCount={connectionsCount}
              onRefreshCards={onRefreshCards}
            />
          ) : null}

          {section === 'board' ? (
            <div className="settings-section">
              <div className="settings-section__head">
                <h3>{t(strings.boardValues)}</h3>
              </div>
              <BoardSetup onApplied={onBoardApplied} reportError={reportError} />
            </div>
          ) : null}

          {section === 'permissions' ? (
            <PermissionsSettings permissions={permissions} onPermission={onPermission} />
          ) : null}

          {section === 'shortcuts' ? (
            <div className="settings-section">
              <div className="settings-section__head">
                <h3>{t(strings.shortcuts)}</h3>
              </div>
              <ul className="shortcut-list shortcut-list--settings">
                {SHORTCUTS.map((row) => (
                  <li key={row.keys}>
                    <span>{t(row.action)}</span>
                    <kbd>{row.keys}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {section === 'about' ? (
            <div className="settings-section">
              <div className="settings-group">
                <SettingRow label={t(strings.version)} detail={t(strings.versionValue)} />
                <SettingRow label={t(strings.renderer)} detail={t(strings.rendererValue)} />
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function GeneralSettings({
  theme,
  onTheme,
  density,
  onDensity,
  locale,
  onLocale,
  cardsCount,
  connectionsCount,
  onRefreshCards,
}: {
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  density: ViewDensity;
  onDensity: (density: ViewDensity) => void;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  cardsCount: number;
  connectionsCount: number;
  onRefreshCards: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <>
      <div className="settings-section">
        <div className="settings-section__head">
          <h3>{t(strings.appearance)}</h3>
        </div>
        <div className="settings-group">
          <SettingRow label={t(strings.theme)}>
            <Segmented
              label={t(strings.theme)}
              value={theme}
              options={[
                { id: 'dark', label: t(strings.dark) },
                { id: 'light', label: t(strings.light) },
              ]}
              onChange={(value) => onTheme(value as ThemeMode)}
            />
          </SettingRow>
          <SettingRow label={t(strings.density)}>
            <Segmented
              label={t(strings.density)}
              value={density}
              options={[
                { id: 'comfortable', label: t(strings.comfortable) },
                { id: 'compact', label: t(strings.compact) },
              ]}
              onChange={(value) => onDensity(value as ViewDensity)}
            />
          </SettingRow>
          <SettingRow label={t(strings.language)}>
            <Segmented
              label={t(strings.languageGroup)}
              value={locale}
              options={LOCALES.map((option) => ({
                id: option,
                label: LOCALE_NAMES[option],
              }))}
              onChange={(value) => onLocale(value as Locale)}
            />
          </SettingRow>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section__head">
          <h3>{t(strings.workspace)}</h3>
        </div>
        <div className="settings-group">
          <SettingRow label={t(strings.connections)} detail={String(connectionsCount)} />
          <SettingRow
            label={t(strings.cards)}
            detail={`${cardsCount} ${t(strings.installed)}`}
            action={
              <button
                type="button"
                className="settings-icon-action"
                onClick={onRefreshCards}
                aria-label={t(strings.rescanCards)}
                title={t(strings.rescanCards)}
              >
                <RefreshIcon size={14} />
                <span>{t(strings.rescan)}</span>
              </button>
            }
          />
        </div>
      </div>
    </>
  );
}

function PermissionsSettings({
  permissions,
  onPermission,
}: {
  permissions: PermissionRow[];
  onPermission: (actor: PermissionActor, op: string, allowed: boolean) => void;
}): JSX.Element {
  const t = useT();
  const locale = useLocale();
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
      { kind: 'action', label: t(strings.groupActions) },
      { kind: 'workflow', label: t(strings.groupWorkflows) },
      { kind: 'host', label: t(strings.groupHost) },
    ] as const
  )
    .map((group) => ({
      ...group,
      rows: permissions.filter((row) => row.kind === group.kind),
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="settings-section settings-section--permissions">
      <div className="settings-section__head">
        <h3>{t(strings.permissionHeading)}</h3>
      </div>
      {permissions.length === 0 ? (
        <p className="settings-empty">{t(strings.noPermissions)}</p>
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
              checked={bulkActions.length > 0 && bulkActions.every((row) => row.card)}
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
              checked={bulkWorkflows.length > 0 && bulkWorkflows.every((row) => row.card)}
              disabled={bulkWorkflows.length === 0}
              onChange={(allowed) => setAll(bulkWorkflows, allowed)}
            />
            {destructive.length > 0 ? (
              <p className="perm-master__note">{t(strings.destructiveOnly)}</p>
            ) : null}
          </div>

          <div className="perm-groups">
            {groups.map((group) => (
              <section key={group.kind} className="perm-group">
                <header className="perm-group__head">
                  <h3>{group.label}</h3>
                  <span className="perm-group__count">{group.rows.length}</span>
                </header>
                <ul className="perm-list">
                  {group.rows.map((row) => {
                    const label = operationLabel(row, locale);
                    return (
                      <li key={row.op} className="perm-row" title={row.op}>
                        <div className="perm-row__text">
                          <span className="perm-row__label">
                            {label}
                            {row.danger === 'destructive' ? (
                              <span className="perm-row__danger">{t(strings.danger)}</span>
                            ) : null}
                          </span>
                        </div>
                        <div className="perm-row__switches">
                          <div className="perm-row__switch">
                            <span className="perm-row__switch-label">{t(strings.card)}</span>
                            <Switch
                              checked={row.card}
                              label={`${label} · ${t(strings.cardGrant)}`}
                              onChange={(next) => onPermission('card', row.op, next)}
                            />
                          </div>
                          <div className="perm-row__switch">
                            <span className="perm-row__switch-label">agent</span>
                            <Switch
                              checked={row.agent}
                              label={`${label} · ${t(strings.agentGrant)}`}
                              onChange={(next) => onPermission('agent', row.op, next)}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SettingRow({
  label,
  detail,
  action,
  children,
}: {
  label: string;
  detail?: string;
  action?: JSX.Element;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <strong>{label}</strong>
        {detail !== undefined ? <span>{detail}</span> : null}
      </div>
      {action ?? children}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="segmented settings-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? 'is-active' : ''}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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
