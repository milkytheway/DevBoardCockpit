/**
 * CPU card: a half-circle gauge for the total, eight core bars, the
 * governor and a 60-second trend.
 *
 * Display rules follow contract §2.1: stale keeps the old value and says
 * so, error shows the old value (or nothing) and says so, unavailable never
 * renders a number. The host injects the theme variables; this card never
 * hardcodes a colour.
 */

const MAX_SAMPLES = 60;
const CORE_COUNT = 8;

const el = (id) => document.getElementById(id);

const ui = {
  value: el('value'),
  governor: el('governor'),
  sample: el('sample'),
  now: el('now'),
  note: el('note'),
  min: el('min'),
  p95: el('p95'),
  max: el('max'),
  arc: el('arc'),
  needle: el('needle'),
  spark: el('spark'),
};

/** Latest readings, keyed by tag. */
const readings = new Map();
let samples = [];
let lastCpuAt = null;

/* ── formatting ─────────────────────────────────────────────── */

const fmtPct = (value) => (typeof value === 'number' ? value.toFixed(1) : '—');

function ago(at) {
  if (at === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  return Math.round(seconds / 60) + ' 分钟前';
}

function statusClass(reading) {
  if (!reading) return 'cockpit-pending';
  switch (reading.status) {
    case 'ok':
      return 'cockpit-value';
    case 'stale':
      return 'cockpit-value cockpit-value--stale';
    case 'error':
      return 'cockpit-value cockpit-value--error';
    case 'unavailable':
      return 'cockpit-unavailable';
    default:
      return 'cockpit-pending';
  }
}

function noteFor(reading, fallback) {
  if (!reading) return fallback;
  switch (reading.status) {
    case 'ok':
      return '';
    case 'stale':
      return '已过时';
    case 'error':
      return reading.value === null ? '读取失败' : '读取失败（显示的是上一次的值）';
    case 'unavailable':
      return '不可用 · ' + (reading.detail || '缺 ' + reading.tag);
    default:
      return '等待第一次采样';
  }
}

/* ── core bars ──────────────────────────────────────────────── */

const coreNodes = [];

function buildCores() {
  const container = el('cores');
  for (const [groupLabel, base] of [
    ['A55', 0],
    ['A76', 4],
  ]) {
    const group = document.createElement('div');
    group.className = 'core-group';
    const label = document.createElement('span');
    label.className = 'core-group__label';
    label.textContent = groupLabel;
    group.appendChild(label);

    const bars = document.createElement('div');
    bars.className = 'core-bars';
    for (let i = 0; i < 4; i += 1) {
      const coreIndex = base + i;
      const core = document.createElement('div');
      core.className = 'core';
      const track = document.createElement('div');
      track.className = 'core__track';
      const fill = document.createElement('div');
      fill.className = 'core__fill';
      track.appendChild(fill);
      const text = document.createElement('span');
      text.className = 'core__label';
      text.textContent = String(coreIndex);
      core.appendChild(track);
      core.appendChild(text);
      bars.appendChild(core);
      coreNodes[coreIndex] = { fill, text, value: null };
    }
    group.appendChild(bars);
    container.appendChild(group);
  }
}

function renderCores() {
  for (let index = 0; index < CORE_COUNT; index += 1) {
    const node = coreNodes[index];
    if (!node) continue;
    const reading = readings.get('cpu.core.' + index + '.usage');
    const value = reading && typeof reading.value === 'number' ? reading.value : null;
    node.fill.style.height = value === null ? '0%' : Math.max(2, Math.min(100, value)) + '%';
    node.fill.dataset.state =
      value === null ? 'none' : value >= 85 ? 'danger' : value >= 60 ? 'warn' : 'ok';
    node.text.textContent =
      value === null ? '—' : Math.round(value) + '%';
  }
}

/* ── gauge ──────────────────────────────────────────────────── */

const percentile = (sorted, ratio) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
};

function renderStats() {
  if (samples.length === 0) {
    ui.min.textContent = '—';
    ui.p95.textContent = '—';
    ui.max.textContent = '—';
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  ui.min.textContent = fmtPct(sorted[0]) + '%';
  ui.p95.textContent = fmtPct(percentile(sorted, 0.95)) + '%';
  ui.max.textContent = fmtPct(sorted[sorted.length - 1]) + '%';
}

function renderSpark() {
  if (samples.length < 2) {
    ui.spark.setAttribute('points', '');
    return;
  }
  const step = 120 / (MAX_SAMPLES - 1);
  const offset = MAX_SAMPLES - samples.length;
  const points = samples.map((value, index) => {
    const x = (offset + index) * step;
    const y = 38 - Math.max(0, Math.min(100, value)) * 0.34;
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  ui.spark.setAttribute('points', points.join(' '));
}

function renderGauge() {
  const reading = readings.get('cpu.usage');
  const value =
    reading && (reading.status === 'ok' || reading.status === 'stale') && typeof reading.value === 'number'
      ? reading.value
      : null;

  ui.value.className = 'gauge__value ' + statusClass(reading);
  ui.value.textContent = value === null ? (reading && reading.status === 'unavailable' ? '⊘' : '—') : fmtPct(value);
  ui.note.textContent = noteFor(reading, '等待第一次采样');
  ui.note.className = 'cpu-note ' + (reading && reading.status !== 'ok' ? 'is-' + reading.status : '');

  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
  ui.arc.style.strokeDasharray = clamped + ' 100';
  ui.arc.dataset.state = value === null ? 'none' : clamped >= 85 ? 'danger' : clamped >= 60 ? 'warn' : 'ok';
  // 0 % points left, 50 % points up, 100 % points right. Computing the end
  // point is more reliable than a rotate() attribute (transform-origin on SVG
  // children is inconsistent across engines).
  const angle = (-90 + clamped * 1.8) * (Math.PI / 180);
  ui.needle.setAttribute('x1', '110');
  ui.needle.setAttribute('y1', '110');
  ui.needle.setAttribute('x2', (110 + Math.sin(angle) * 72).toFixed(1));
  ui.needle.setAttribute('y2', (110 - Math.cos(angle) * 72).toFixed(1));
  ui.needle.dataset.state = value === null ? 'none' : 'on';

  if (value !== null) {
    ui.now.textContent = fmtPct(value) + '%';
  } else {
    ui.now.textContent = '—';
  }

  if (reading && typeof reading.at === 'number') lastCpuAt = reading.at;
  ui.sample.textContent = ago(lastCpuAt);
}

/* ── subscriptions ──────────────────────────────────────────── */

function onCpu(reading) {
  readings.set('cpu.usage', reading);
  if (reading && reading.status === 'ok' && typeof reading.value === 'number') {
    samples.push(reading.value);
    if (samples.length > MAX_SAMPLES) samples.shift();
    renderSpark();
    renderStats();
  }
  renderGauge();
}

function onCore(reading) {
  readings.set(reading.tag, reading);
  renderCores();
}

function onCluster(reading) {
  readings.set(reading.tag, reading);
}

function onGovernor(reading) {
  readings.set('cpu.governor', reading);
  const value = reading && reading.value !== null && reading.value !== undefined ? String(reading.value) : '—';
  ui.governor.textContent = value;
  ui.governor.title = reading ? reading.tag + ' · ' + reading.status : '';
}

const tags = window.cockpit && window.cockpit.tags;

/**
 * The bridge is up before the card script, but its private port is handed back
 * asynchronously (hello -> host -> MessagePort). A subscription sent before the
 * port arrives resolves with `not_connected` and is dropped. Retry once the
 * handshake has settled instead of staying empty forever.
 */
function subscribeWithRetry(kind, name, callback) {
  if (!tags) return;
  const attempt = () => {
    const pending = tags[kind](name, callback);
    if (pending && typeof pending.then === 'function') {
      pending.then((result) => {
        if (!result || result.ok !== true) setTimeout(attempt, 150);
      });
    }
  };
  attempt();
}

if (tags) {
  subscribeWithRetry('subscribe', 'cpu.usage', onCpu);
  subscribeWithRetry('subscribe', 'cpu.governor', onGovernor);
  subscribeWithRetry('subscribePattern', 'cpu.core.*.usage', onCore);
  subscribeWithRetry('subscribePattern', 'cpu.core.*.cluster', onCluster);
} else {
  ui.note.textContent = '宿主桥接未就绪';
}

buildCores();
renderCores();

// The age keeps ticking even when readings are not pushed every second.
setInterval(() => {
  ui.sample.textContent = ago(lastCpuAt);
}, 1000);
