/**
 * Board identity card: model, governor, GPU frequency and both backlight
 * channels. Backlights use the board pack's 0-255 range and are shown as a
 * percentage of that range.
 */

const BACKLIGHT_MAX = 255;

const el = (id) => document.getElementById(id);

const readings = new Map();
const parts = {
  model: el('model'),
  governor: el('governor'),
  gpuFreq: el('gpu-freq'),
  bl0: el('bl0'),
  bl0v: el('bl0v'),
  bl1: el('bl1'),
  bl1v: el('bl1v'),
  note: el('note'),
};

function ago(at) {
  if (typeof at !== 'number') return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  return Math.round(seconds / 60) + ' 分钟前';
}

function fmtFreq(value) {
  if (typeof value !== 'number') return '—';
  if (value >= 1e9) return (value / 1e9).toFixed(2) + ' GHz';
  return Math.round(value / 1e6) + ' MHz';
}

function stringOf(name) {
  const reading = readings.get(name);
  if (!reading || reading.status === 'unavailable' || reading.status === 'pending') return null;
  if (reading.value === null || reading.value === undefined) return null;
  return String(reading.value);
}

function numberIn(name) {
  const reading = readings.get(name);
  if (!reading || (reading.status !== 'ok' && reading.status !== 'stale')) return null;
  return typeof reading.value === 'number' ? reading.value : null;
}

function renderBacklight(fillNode, valueNode, name) {
  const raw = numberIn(name);
  const valueNodeEl = valueNode;
  if (raw === null) {
    fillNode.style.width = '0%';
    valueNodeEl.textContent = '—';
    return;
  }
  const percent = Math.max(0, Math.min(100, (raw / BACKLIGHT_MAX) * 100));
  fillNode.style.width = percent.toFixed(1) + '%';
  valueNodeEl.textContent = Math.round(raw) + ' / ' + BACKLIGHT_MAX;
}

function update() {
  const model = stringOf('board.model');
  parts.model.textContent = model || '—';

  const governor = stringOf('cpu.governor');
  parts.governor.textContent = governor || '—';

  const gpuFreq = numberIn('gpu.freq_hz');
  parts.gpuFreq.textContent = gpuFreq === null ? '—' : fmtFreq(gpuFreq);

  renderBacklight(parts.bl0, parts.bl0v, 'custom.rk3588-atk.backlight.brightness');
  renderBacklight(parts.bl1, parts.bl1v, 'custom.rk3588-atk.backlight1.brightness');

  const latest = Math.max(
    0,
    ...[
      'board.model',
      'cpu.governor',
      'gpu.freq_hz',
      'custom.rk3588-atk.backlight.brightness',
      'custom.rk3588-atk.backlight1.brightness',
    ]
      .map((name) => readings.get(name))
      .filter(Boolean)
      .map((reading) => (typeof reading.at === 'number' ? reading.at : 0)),
  );

  parts.note.className = 'bi-note';
  if (!readings.size) {
    parts.note.textContent = '等待第一次采样';
  } else if (latest === 0) {
    parts.note.textContent = '等待第一次采样';
  } else {
    parts.note.textContent = '最后采样 ' + ago(latest);
  }
}

const tags = window.cockpit && window.cockpit.tags;

/**
 * The bridge hands its private port over asynchronously (hello -> host ->
 * MessagePort). A subscription issued before that resolves as `not_connected`
 * and is dropped, so retry until the handshake has settled.
 */
function subscribeWithRetry(kind, name, callback) {
  if (!tags) return;
  const pending = tags[kind](name, callback);
  if (pending && typeof pending.then === 'function') {
    pending.then((result) => {
      if (!result || result.ok !== true) {
        setTimeout(() => subscribeWithRetry(kind, name, callback), 150);
      }
    });
  }
}

for (const name of [
  'board.model',
  'cpu.governor',
  'gpu.freq_hz',
  'custom.rk3588-atk.backlight.brightness',
  'custom.rk3588-atk.backlight1.brightness',
]) {
  subscribeWithRetry('subscribe', name, (reading) => {
    readings.set(name, reading);
    update();
  });
}

update();
setInterval(update, 1000);
