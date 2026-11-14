import {
  FolderIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  ListIcon,
  TerminalIcon,
} from './Icons';
import type { DockTab, PageId } from './types';

export function Rail({
  page,
  dockTab,
  dockOpen,
  onPage,
  onOpenDock,
}: {
  page: PageId;
  dockTab: DockTab;
  dockOpen: boolean;
  onPage: (page: PageId) => void;
  onOpenDock: (tab: DockTab) => void;
}): JSX.Element {
  const item = (
    key: string,
    label: string,
    icon: JSX.Element,
    active: boolean,
    action: () => void,
  ): JSX.Element => (
    <button
      key={key}
      type="button"
      className={`rail__item ${active ? 'is-active' : ''}`}
      onClick={action}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <nav className="rail" aria-label="主导航">
      {item('workbench', '工作台', <GridIcon size={18} />, page === 'workbench' && !dockOpen, () => onPage('workbench'))}
      {item('library', '卡片库', <LayersIcon size={18} />, page === 'library', () => onPage('library'))}
      {item(
        'terminal',
        '终端',
        <TerminalIcon size={18} />,
        page === 'workbench' && dockOpen && dockTab === 'terminal',
        () => onOpenDock('terminal'),
      )}
      {item(
        'files',
        '文件',
        <FolderIcon size={18} />,
        page === 'workbench' && dockOpen && dockTab === 'files',
        () => onOpenDock('files'),
      )}
      {item(
        'logs',
        '日志',
        <ListIcon size={18} />,
        page === 'workbench' && dockOpen && dockTab === 'logs',
        () => onOpenDock('logs'),
      )}
      <span className="rail__spacer" />
      {item('settings', '设置', <GearIcon size={18} />, page === 'settings', () => onPage('settings'))}
    </nav>
  );
}
