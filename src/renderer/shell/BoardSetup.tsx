import { useState } from 'react';
import type {
  BoardApplyValue,
  BoardDetection,
  ConnectionValues,
} from '../../shared/board-setup';
import { useT, type Localised } from './i18n';

/**
 * **The board setup** — the values that belong to **this machine** ✓.
 *
 * ── What it shows ──
 *
 * | What | Why |
 * |---|---|
 * | **every connection of this machine** ✓ with the values it uses ✓ | the person has to see what the application believes ✓ |
 * | **where each value came from** ✓ (`builtin` ✓ · `detected` ✓ · `confirmed` ✓) | a value nobody chose looks like a value somebody chose ✓ |
 * | **the candidates that were tried** ✓ (the addresses ✓ with the reason each one failed ✓ · the serial ports ✓ with the one that answers ✓) | "an address that is written down proves nothing" ✓ — the person has to see what was measured ✓ |
 * | **the private keys of this machine** ✓ | the key is the person's ✓ (the published profiles must not carry it ✓) |
 *
 * → **Every field can be corrected** ✓ — the guest machine's address is as
 *   much the person's as the board's ✓.
 * → **What is written goes into the machine-value store** ✓ (not into a copy
 *   of the profile ✓ — a copy would freeze the connection ✓).
 */

/** **Interface wording** —— every string the user can read is in this table ✓. */
const strings = {
  title: { 'zh-Hans': '这台机器上的连接', en: 'The connections of this machine' },
  head: {
    'zh-Hans': '序列号、地址、串口、私钥 —— 这四样只有你知道，探测只是帮填',
    en: 'Serial number, address, serial port, private key — only you know them; the detection only helps you fill them in',
  },
  note: {
    'zh-Hans': '改过的值写进用户目录里的「机器值」（machine-values.json），内置的连接定义原样保留 —— 下一版修好连接定义时，你机器上也会跟着好。',
    en: 'What you change goes into the machine values (machine-values.json) in the user directory; the shipped connection definitions stay as they are — when the next version fixes a definition, your machine gets it too.',
  },
  detect: { 'zh-Hans': '探测', en: 'Detect' },
  detecting: { 'zh-Hans': '探测中…', en: 'Detecting…' },
  save: { 'zh-Hans': '保存', en: 'Save' },
  saving: { 'zh-Hans': '写入中…', en: 'Writing…' },
  saved: { 'zh-Hans': '已写入 {count} 条连接', en: 'Written into {count} connections' },
  savedNone: { 'zh-Hans': '没有写入任何连接', en: 'Nothing was written' },
  failed: { 'zh-Hans': '没成：{detail}', en: 'It did not work: {detail}' },
  adbSerial: { 'zh-Hans': '板子序列号', en: 'Board serial number' },
  address: { 'zh-Hans': '地址', en: 'Address' },
  serialPort: { 'zh-Hans': '串口', en: 'Serial port' },
  username: { 'zh-Hans': '用户名', en: 'User name' },
  key: { 'zh-Hans': '私钥', en: 'Private key' },
  board: { 'zh-Hans': '板子', en: 'Board' },
  machine: { 'zh-Hans': '机器（不属于任何板）', en: 'Machine (not a board)' },
  sourceBuiltin: { 'zh-Hans': '连接定义里的', en: 'from the definition' },
  sourceDetected: { 'zh-Hans': '探测到的', en: 'detected' },
  sourceConfirmed: { 'zh-Hans': '你确认的', en: 'confirmed' },
  tried: { 'zh-Hans': '试过的地址', en: 'The addresses that were tried' },
  reachable: { 'zh-Hans': '通', en: 'answers' },
  unreachable: { 'zh-Hans': '不通', en: 'no answer' },
  ports: { 'zh-Hans': '串口', en: 'Serial ports' },
  answers: { 'zh-Hans': '有回应', en: 'answers' },
  silent: { 'zh-Hans': '没回应', en: 'silent' },
  keys: { 'zh-Hans': '本机的私钥', en: 'The private keys of this machine' },
  noKeys: { 'zh-Hans': '没有找到私钥（~/.ssh 里没有常见名字）', en: 'No private key found (none of the usual names in ~/.ssh)' },
  noBoard: { 'zh-Hans': '没有探测到板子', en: 'No board was detected' },
  none: { 'zh-Hans': '（空）', en: '(empty)' },
  model: { 'zh-Hans': '板子自报型号', en: 'The model the board reports' },
} satisfies Record<string, Localised>;

const SOURCE_LABEL: Record<string, Localised> = {
  builtin: strings.sourceBuiltin,
  detected: strings.sourceDetected,
  confirmed: strings.sourceConfirmed,
  user: strings.sourceConfirmed,
};

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
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
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
      const prefilled: Record<string, Record<string, string>> = {};
      for (const connection of found.connections) {
        const fields: Record<string, string> = {};
        if (connection.values['serial'] !== undefined) fields['serial'] = connection.values['serial'];
        if (connection.values['host'] !== undefined) fields['host'] = connection.values['host'];
        if (connection.values['port'] !== undefined) fields['port'] = connection.values['port'];
        if (connection.values['username'] !== undefined) fields['username'] = connection.values['username'];
        if (connection.values['key_filename'] !== undefined) {
          fields['key_filename'] = connection.values['key_filename'];
        }
        prefilled[connection.id] = fields;
      }
      setEdits(prefilled);
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(t(strings.failed, { detail }));
      reportError?.(detail);
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    const api = window.cockpit;
    if (!api || detection === null) return;
    setBusy(true);
    setMessage(null);
    const payload: BoardApplyValue[] = detection.connections.map((connection) => ({
      id: connection.id,
      fields: edits[connection.id] ?? {},
    }));
    try {
      const result = await api.boardApply(payload);
      setMessage(
        result.written.length > 0
          ? t(strings.saved, { count: String(result.written.length) })
          : t(strings.savedNone),
      );
      onApplied?.();
      // → **The values that were written are shown as confirmed** ✓.
      setEdits((current) => {
        const next = { ...current };
        for (const id of result.written) {
          next[id] = { ...(next[id] ?? {}) };
        }
        return next;
      });
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(t(strings.failed, { detail }));
      reportError?.(detail);
    } finally {
      setBusy(false);
    }
  };

  const setField = (id: string, field: string, value: string): void => {
    setEdits((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), [field]: value },
    }));
  };

  const field = (
    connection: ConnectionValues,
    name: string,
    label: Localised,
    placeholder?: string,
  ): JSX.Element => {
    const source = connection.sources[name];
    const current = connection.values as Record<string, string | undefined>;
    return (
      <label className="board-setup__field" key={name}>
        <span>{t(label)}</span>
        <input
          value={edits[connection.id]?.[name] ?? current[name] ?? ''}
          placeholder={placeholder ?? t(strings.none)}
          spellCheck={false}
          onChange={(event) => setField(connection.id, name, event.target.value)}
        />
        {source !== undefined ? (
          <em className="board-setup__source">{t(SOURCE_LABEL[source] ?? strings.sourceBuiltin)}</em>
        ) : null}
      </label>
    );
  };

  return (
    <section className="settings-card">
      <header className="settings-card__head">
        <div>
          <h2>{t(strings.title)}</h2>
          <p>{t(strings.head)}</p>
        </div>
      </header>

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
          onClick={() => void save()}
          disabled={busy || detection === null}
        >
          {busy ? t(strings.saving) : t(strings.save)}
        </button>
      </div>

      {detection !== null ? (
        <>
          <h3 className="settings-card__sub">{t(strings.model)}</h3>
          <p className="settings-note">
            {detection.model ?? t(strings.noBoard)}
          </p>

          <h3 className="settings-card__sub">{t(strings.tried)}</h3>
          <ul className="board-setup__list">
            {detection.addresses.length === 0 ? (
              <li>{t(strings.noBoard)}</li>
            ) : (
              detection.addresses.map((candidate) => (
                <li key={candidate.address}>
                  <code className="mono">{candidate.address}</code> ·{' '}
                  {candidate.reachable ? t(strings.reachable) : t(strings.unreachable)}
                  {candidate.detail !== null ? ` (${candidate.detail})` : ''}
                </li>
              ))
            )}
          </ul>

          <h3 className="settings-card__sub">{t(strings.ports)}</h3>
          <ul className="board-setup__list">
            {detection.ports.length === 0 ? (
              <li>{t(strings.noBoard)}</li>
            ) : (
              detection.ports.map((port) => (
                <li key={port.path}>
                  <code className="mono">{port.path}</code> ·{' '}
                  {port.answered ? t(strings.answers) : t(strings.silent)}
                </li>
              ))
            )}
          </ul>

          <h3 className="settings-card__sub">{t(strings.keys)}</h3>
          <ul className="board-setup__list">
            {detection.sshKeys.length === 0 ? (
              <li>{t(strings.noKeys)}</li>
            ) : (
              detection.sshKeys.map((key) => (
                <li key={key}>
                  <code className="mono">{key}</code>
                </li>
              ))
            )}
          </ul>

          {detection.connections.map((connection) => (
            <div key={connection.id}>
              <h3 className="settings-card__sub">
                {connection.label} ·{' '}
                {connection.boardPack === null
                  ? t(strings.machine)
                  : `${t(strings.board)} · ${connection.boardPack}`}
              </h3>
              <div className="board-setup__grid">
                {connection.transport === 'adb'
                  ? field(connection, 'serial', strings.adbSerial)
                  : null}
                {connection.transport === 'ssh' ? field(connection, 'host', strings.address) : null}
                {connection.transport === 'ssh'
                  ? field(connection, 'username', strings.username)
                  : null}
                {connection.transport === 'ssh' ? field(connection, 'key_filename', strings.key) : null}
                {connection.transport === 'serial' ? field(connection, 'port', strings.serialPort) : null}
              </div>
            </div>
          ))}
        </>
      ) : null}

      {message !== null ? <p className="settings-note">{message}</p> : null}
      <p className="settings-note">{t(strings.note)}</p>
    </section>
  );
}
