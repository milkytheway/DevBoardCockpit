/**
 * Memory card: big percentage, 18-segment bar and the byte-level stats.
 */

const MAX_SAMPLES = 60;
const SEGMENTS = 18;

const el = (id) => document.getElementById(id);

const parts = {
  value: el('value'),
  fraction: el('fraction'),
  spark: el('spark'),
  seg: el('seg'),
  used: el('used'),
  available: el('available'),
  total: el('total'),
  note: el('note'),
};

const readings = new Map();
const samples = [];
const cells = [];

function ago(at) {
  if (typeof at !== 'number') return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  return Math.round(seconds / 60) + ' 分钟前';
}

function fmtBytes(bytes) {
  if (typeof bytes !== 'number') return '—';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GiB';
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + ' MiB';
  return Math.round(bytes / 1024) + ' KiB';
}

function toneFor(usage) {
  if (typeof usage !== 'number') return 'none';
  if (usage >= 85) return 'danger';
  if (usage >= 70) return 'warn';
  return 'ok';
}

for (let index = 0; index < SEGMENTS; index += 1) {
  const cell = document.createElement('span');
  cell.className = 'seg__cell';
  parts.seg.appendChild(cell);
  cells.push(cell);
}

function renderSegments(usage) {
  const filled = typeof usage === 'number' ? Math.round((Math.max(0, Math.min(100, usage)) / 100) * SEGMENTS) : 0;
  const tone = toneFor(usage);
  cells.forEach((cell, index) => {
    cell.className = 'seg__cell';
    if (index < filled) cell.classList.add('is-on', 'is-' + tone);
  });
}

function renderSpark() {
  if (samples.length < 2) {
    parts.spark.setAttribute('points', '');
    return;
  }
  const step = 100 / Math.max(1, MAX_SAMPLES - 1);
  const points = samples.map((value, index) => {
    const x = (index * step).toFixed(2);
    const y = (38 - Math.max(0, Math.min(100, value)) * 0.34).toFixed(2);
    return x + ',' + y;
  });
  parts.spark.setAttribute('points', points.join(' '));
}

function update() {
  const usage = readings.get('mem.usage');
  const usable = usage && (usage.status === 'ok' || usage.status === 'stale') && typeof usage.value === 'number';

  parts.value.className = 'mem-big__value';
  if (usable) {
    parts.value.textContent = (usage.value < 10 ? usage.value.toFixed(1) : Math.round(usage.value)) + '%';
    if (usage.status === 'stale') parts.value.classList.add('is-stale');
    if (usage.value >= 85) parts.value.classList.add('is-danger');
  } else if (usage && usage.status === 'unavailable') {
    parts.value.textContent = '不可用';
    parts.value.classList.add('is-unavailable');
  } else if (usage && usage.status === 'error') {
    parts.value.textContent = '读取失败';
    parts.value.classList.add('is-error');
  } else {
    parts.value.textContent = '—';
    parts.value.classList.add('is-pending');
  }

  const usedBytes = readings.get('mem.used_bytes');
  const totalBytes = readings.get('mem.total_bytes');
  const availableBytes = readings.get('mem.available_bytes');

  const usedText = usedBytes && typeof usedBytes.value === 'number' ? fmtBytes(usedBytes.value) : '—';
  const totalText = totalBytes && typeof totalBytes.value === 'number' ? fmtBytes(totalBytes.value) : '—';
  parts.fraction.textContent = usedText + ' / ' + totalText;

  parts.used.textContent = usedText;
  parts.available.textContent =
    availableBytes && typeof availableBytes.value === 'number' ? fmtBytes(availableBytes.value) : '—';
  parts.total.textContent = totalText;

  renderSegments(usable ? usage.value : null);
  renderSpark();

  const at = usage && typeof usage.at === 'number' ? usage.at : null;
  parts.note.className = 'mem-note';
  if (!usage) {
    parts.note.textContent = '等待第一次采样';
  } else if (usage.status === 'stale') {
    parts.note.textContent = '已过时 · 最后采样 ' + ago(at);
    parts.note.classList.add('is-stale');
  } else if (usage.status === 'unavailable') {
    parts.note.textContent = '板型包未提供该 tag';
    parts.note.classList.add('is-unavailable');
  } else if (usage.status === 'error') {
    parts.note.textContent = '读取失败 · 显示的是上一次的值';
    parts.note.classList.add('is-error');
  } else {
    parts.note.textContent = '最后采样 ' + ago(at);
  }
}

function onUsage(reading) {
  readings.set('mem.usage', reading);
  if (reading.status === 'ok' && typeof reading.value === 'number') {
    samples.push(reading.value);
    if (samples.length > MAX_SAMPLES) samples.shift();
    renderSpark();
  }
  update();
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

subscribeWithRetry('subscribe', 'mem.usage', onUsage);
for (const name of ['mem.used_bytes', 'mem.total_bytes', 'mem.available_bytes']) {
  subscribeWithRetry('subscribe', name, (reading) => {
    readings.set(name, reading);
    update();
  });
}

update();
setInterval(update, 1000);
