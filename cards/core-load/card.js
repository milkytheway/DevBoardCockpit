/**
 * Core-load card: one bar per logical CPU, grouped by the cluster labels the
 * board pack reports. The cluster grouping is data-driven: tags whose cluster
 * reading is missing are simply left ungrouped.
 */

const CORE_COUNT = 8;

const el = (id) => document.getElementById(id);

const parts = {
  avg: el('avg'),
  peak: el('peak'),
  total: el('total'),
  bars: el('bars'),
  note: el('note'),
};

const readings = new Map();
const cores = [];

function ago(at) {
  if (typeof at !== 'number') return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  return Math.round(seconds / 60) + ' 分钟前';
}

function toneFor(value) {
  if (typeof value !== 'number') return 'none';
  if (value >= 85) return 'danger';
  if (value >= 60) return 'warn';
  return 'ok';
}

for (let index = 0; index < CORE_COUNT; index += 1) {
  const col = document.createElement('div');
  col.className = 'cl-core is-empty';

  const track = document.createElement('div');
  track.className = 'cl-core__track';
  const fill = document.createElement('div');
  fill.className = 'cl-core__fill';
  track.appendChild(fill);

  const value = document.createElement('div');
  value.className = 'cl-core__value';
  value.textContent = '—';

  const label = document.createElement('div');
  label.className = 'cl-core__label';
  label.textContent = 'core ' + index;

  col.append(track, value, label);
  parts.bars.appendChild(col);
  cores.push({ col, fill, value, label });
}

function clusterOf(index) {
  const reading = readings.get('cpu.core.' + index + '.cluster');
  if (reading && typeof reading.value === 'string') return reading.value;
  if (reading && reading.value !== null && reading.value !== undefined) return String(reading.value);
  return null;
}

function update() {
  const values = [];
  let latestAt = null;

  cores.forEach((node, index) => {
    const reading = readings.get('cpu.core.' + index + '.usage');
    const usable =
      reading && (reading.status === 'ok' || reading.status === 'stale') && typeof reading.value === 'number';
    const numeric = usable ? reading.value : null;
    const tone = toneFor(numeric);

    if (usable && typeof reading.at === 'number') latestAt = Math.max(latestAt ?? 0, reading.at);
    if (numeric !== null) values.push(numeric);

    node.col.className = 'cl-core' + (numeric === null ? ' is-empty' : '');
    node.fill.style.height = (numeric === null ? 0 : Math.max(0, Math.min(100, numeric))) + '%';
    node.fill.dataset.tone = tone;
    node.value.textContent = numeric === null ? '—' : (numeric < 10 ? numeric.toFixed(1) : Math.round(numeric)) + '%';
    node.value.dataset.tone = tone;
    const cluster = clusterOf(index);
    node.label.textContent = cluster ? cluster + ' ' + index : 'core ' + index;
  });

  const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const peak = values.length ? Math.max(...values) : null;
  const total = readings.get('cpu.usage');
  const totalValue =
    total && (total.status === 'ok' || total.status === 'stale') && typeof total.value === 'number' ? total.value : null;

  parts.avg.textContent = avg === null ? '—' : avg.toFixed(1);
  parts.peak.textContent = peak === null ? '—' : peak.toFixed(1);
  parts.total.textContent = totalValue === null ? '—' : totalValue.toFixed(1) + '%';

  const states = ['cpu.usage', ...Array.from({ length: CORE_COUNT }, (_unused, index) => 'cpu.core.' + index + '.usage')]
    .map((name) => readings.get(name))
    .filter(Boolean)
    .map((reading) => reading.status);

  parts.note.className = 'cl-note';
  if (!values.length && !total) {
    parts.note.textContent = '等待第一次采样';
  } else if (states.includes('error')) {
    parts.note.textContent = '读取失败 · 显示的是上一次的值';
    parts.note.classList.add('is-error');
  } else if (states.includes('stale')) {
    parts.note.textContent = '数据已过时 · 最后采样 ' + ago(latestAt);
    parts.note.classList.add('is-warn');
  } else {
    parts.note.textContent = latestAt ? '最后采样 ' + ago(latestAt) : '2s 刷新';
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

subscribeWithRetry('subscribe', 'cpu.usage', (reading) => {
  readings.set('cpu.usage', reading);
  update();
});
subscribeWithRetry('subscribePattern', 'cpu.core.*.usage', (reading) => {
  if (reading && reading.tag) readings.set(reading.tag, reading);
  update();
});
subscribeWithRetry('subscribePattern', 'cpu.core.*.cluster', (reading) => {
  if (reading && reading.tag) readings.set(reading.tag, reading);
  update();
});

update();
setInterval(update, 1000);
