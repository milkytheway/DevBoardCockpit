import { useEffect, useRef, useState } from 'react';
import type { ConnectionInfo } from '../../shared/ipc-contract';
import { groupByDevice } from './devices';
import { ChevronIcon } from './Icons';

/**
 * **选设备**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么是「设备」而不是「连接」 ──
 *
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **它们是同一块板** ✓
 * → 界面要让用户按**板**去想 ✓ —— 不是按**通道** ✓。
 * → **`device_key` 就是那块板的身份** ✓。
 *
 * ── v1 的形状（**单连接** ✓）──
 *
 * → **一次只连一块板** ✓（`O11` / `O18` ✓）→ 「选设备」= **换一条连接** ✓。
 * → **不是「同时看多块板」** ✓（那是 M8 ✓ —— **另说** ✓）。
 * → **所以每一项点的是连接** ✓ —— **连接才是能选的东西** ✓。
 */
export function DevicePicker({
  connections,
  onSelect,
  busy,
}: {
  /** 宿主给的连接清单（**带 `deviceKey` 与 `current`** ✓） */
  connections: ConnectionInfo[];
  /** 选中一条连接（**宿主去切** ✓） */
  onSelect: (profileId: string) => void;
  /** 切换中（**别让用户连点** ✓） */
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = groupByDevice(connections);
  const currentGroup = groups.find((group) => group.currentProfileId !== null) ?? null;
  const currentConnection =
    currentGroup?.connections.find((c) => c.id === currentGroup.currentProfileId) ?? null;

  // ── 点外面就关掉 · Esc 也关掉 ──
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        type="button"
        className="btn btn--ghost btn--sm device-picker__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="选择要操作的设备"
        disabled={busy}
      >
        <span className="device-picker__label">设备</span>
        {currentGroup === null ? (
          <span className="dim">未连接</span>
        ) : (
          <>
            <span className="chip chip--sm mono">{currentGroup.deviceKey}</span>
            <span className="ellipsis">{currentConnection?.label ?? currentGroup.deviceKey}</span>
          </>
        )}
        <ChevronIcon size={13} />
      </button>

      {open ? (
        <div className="device-picker__menu" role="listbox" aria-label="设备">
          {groups.length === 0 ? <p className="empty-note">没有可用的连接</p> : null}
          {groups.map((group) => (
            <section key={group.deviceKey} className="device-picker__group">
              <p className="eyebrow device-picker__group-name">
                <span className="mono">{group.deviceKey}</span>
                <span className="dim">
                  {group.connections.length} 条连接
                </span>
              </p>
              {group.connections.map((connection) => {
                const isCurrent = connection.id === group.currentProfileId;
                return (
                  <button
                    key={connection.id}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className={`device-picker__item${isCurrent ? ' is-current' : ''}`}
                    onClick={() => {
                      setOpen(false);
                      if (!isCurrent) onSelect(connection.id);
                    }}
                    title={connection.label}
                  >
                    <span className={`dot ${isCurrent ? 'dot--ok' : 'dot--muted'}`} aria-hidden />
                    <span className="ellipsis">{connection.label}</span>
                    <span className="dim mono">{connection.transport}</span>
                    {isCurrent ? <span className="chip chip--sm">当前</span> : null}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
