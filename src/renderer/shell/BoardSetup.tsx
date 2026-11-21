import { useState } from 'react';
import type { BoardDetection, BoardValues } from '../../shared/board-setup';
import { useT, type Localised } from './i18n';

/**
 * **The board setup** — the values that belong to **this machine** ✓.
 *
 * ── why it is a page and not a command line ──
 *
 * → The published connection profiles carry **placeholders** ✓ (a
 *   documentation address ✓ · an all-zero serial ✓) → the application
 *   **detects** the real values ✓ → but when there is **more than one
 *   candidate** ✓ the person has to say which one is right ✓ → that is a
 *   question for the interface ✓.
 * → The values are written into the **user directory** ✓ → the built-in
 *   profiles stay read-only ✓ → the user's copy wins ✓.
 *
 * ── what it shows ──
 *
 * | What | Why |
 * |---|---|
 * | the adb devices and their state | "the board is not authorised" and "the board is not plugged in" are two different things ✓ |
 * | the model the board reports | the proof that this is *our* board ✓ |
 * | the address the board reports | the board says it itself ✓ |
 * | the serial ports — **and which one answers** | **a port that answers is the console** ✓ (a COM port that exists proves nothing ✓) |
 */

/** **Interface wording** —— every string the user can read is in this table ✓. */
const strings = {
  detect: { 'zh-Hans': '检测', en: 'Detect' },
  detecting: { 'zh-Hans': '检测中…', en: 'Detecting…' },
  apply: { 'zh-Hans': '保存', en: 'Save' },
  applying: { 'zh-Hans': '写入中…', en: 'Writing…' },
  notDetected: { 'zh-Hans': '未检测', en: 'Not detected' },
  adbSerial: { 'zh-Hans': 'ADB 序列号', en: 'ADB serial' },
  address: { 'zh-Hans': 'IP 地址', en: 'IP address' },
  serialPort: { 'zh-Hans': '串口', en: 'Serial port' },
  key: { 'zh-Hans': 'SSH 私钥', en: 'SSH private key' },
  detected: { 'zh-Hans': '探测到的', en: 'Detected' },
  none: { 'zh-Hans': '未检测', en: 'Not detected' },
  noKey: { 'zh-Hans': '没有找到私钥', en: 'no private key found' },
  devices: { 'zh-Hans': 'ADB 设备', en: 'ADB devices' },
  model: { 'zh-Hans': '设备型号', en: 'Device model' },
  ports: { 'zh-Hans': '串口', en: 'Serial ports' },
  answers: { 'zh-Hans': '有回应', en: 'answers' },
  silent: { 'zh-Hans': '没回应', en: 'silent' },
  saved: { 'zh-Hans': '已写入 {count} 个连接', en: 'Written into {count} connections' },
  savedNone: { 'zh-Hans': '没有写入任何连接', en: 'Nothing was written' },
  noBoardPack: {
    'zh-Hans': '未匹配板型',
    en: 'No matching board pack',
  },
  failed: { 'zh-Hans': '失败：{detail}', en: 'Failed: {detail}' },
} satisfies Record<string, Localised>;

export function BoardSetup({
  onApplied,
  reportError,
}: {
  /** The connections changed → the shell refreshes them */
  onApplied?: () => void;
  /** The error channel of the shell */
  reportError?: (message: string) => void;
}): JSX.Element {
  const t = useT();
  const [detection, setDetection] = useState<BoardDetection | null>(null);
  const [adbSerial, setAdbSerial] = useState('');
  const [address, setAddress] = useState('');
  const [serialPort, setSerialPort] = useState('');
  const [keyFilename, setKeyFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const detect = async (): Promise<void> => {
    const api = window.cockpit;
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      const found = await api.boardDetect();
      setDetection(found);
      // → **The detected values fill the fields** ✓ — the person may change
      //   them ✓ (the detection is a proposal ✓ · the person decides ✓).
      if (found.adbDevices.length === 1) {
        setAdbSerial(found.adbDevices[0]?.serial ?? '');
      }
      if (found.address !== null) setAddress(found.address);
      const answering = found.ports.find((port) => port.answered);
      if (answering !== undefined) setSerialPort(answering.path);
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(t(strings.failed, { detail }));
      reportError?.(detail);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    const api = window.cockpit;
    if (!api || detection === null) return;
    setBusy(true);
    setMessage(null);
    const values: BoardValues = {
      boardPack: detection.boardPack ?? '',
      adbSerial,
      address,
      serialPort,
      keyFilename,
    };
    try {
      const result = await api.boardApply(values);
      setMessage(
        result.written.length > 0
          ? t(strings.saved, { count: String(result.written.length) })
          : t(strings.savedNone),
      );
      onApplied?.();
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(t(strings.failed, { detail }));
      reportError?.(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="board-setup">
      <div className="board-setup__toolbar">
        <span className="board-setup__state">
          {detection?.model ?? t(strings.notDetected)}
        </span>
        <div className="board-setup__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void detect()}
          disabled={busy}
        >
          {busy ? t(strings.detecting) : t(strings.detect)}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void apply()}
          disabled={busy || detection === null || detection.boardPack === null}
        >
          {busy ? t(strings.applying) : t(strings.apply)}
        </button>
        </div>
      </div>

      {detection !== null ? (
        <>
          <div className="board-setup__grid">
            <label className="board-setup__field">
              <span>{t(strings.adbSerial)}</span>
              <input
                value={adbSerial}
                onChange={(event) => setAdbSerial(event.target.value)}
                placeholder={t(strings.none)}
                spellCheck={false}
              />
            </label>
            <label className="board-setup__field">
              <span>{t(strings.address)}</span>
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t(strings.none)}
                spellCheck={false}
              />
            </label>
            <label className="board-setup__field">
              <span>{t(strings.serialPort)}</span>
              <select
                id="board-setup-port"
                value={serialPort}
                onChange={(event) => setSerialPort(event.target.value)}
              >
                <option value="">{t(strings.none)}</option>
                {detection.ports.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.path}
                    {port.answered ? ` · ${t(strings.answers)}` : ` · ${t(strings.silent)}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="board-setup__field">
              <span>{t(strings.key)}</span>
              <select
                id="board-setup-key"
                value={keyFilename}
                onChange={(event) => setKeyFilename(event.target.value)}
              >
                <option value="">{t(strings.none)}</option>
                {detection.sshKeys?.map((key) => (
                  <option key={key.path} value={key.path}>
                    {key.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h3 className="settings-subhead">{t(strings.devices)}</h3>
          <ul className="board-setup__list">
            {detection.adbDevices.length === 0 ? (
              <li>{t(strings.none)}</li>
            ) : (
              detection.adbDevices.map((device) => (
                <li key={device.serial}>
                  <code className="mono">{device.serial}</code> · {device.stateText}
                </li>
              ))
            )}
          </ul>

          <h3 className="settings-subhead">{t(strings.model)}</h3>
          <p className="settings-inline-value">
            {detection.model ?? t(strings.none)}
            {detection.boardPack === null ? ` · ${t(strings.noBoardPack)}` : ''}
          </p>
        </>
      ) : null}

      {message !== null ? <p className="settings-feedback">{message}</p> : null}
    </div>
  );
}
