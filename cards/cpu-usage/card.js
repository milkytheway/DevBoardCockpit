/**
 * CPU card: one number and per-core bars.
 *
 * The card deliberately does NOT draw a gauge, a sparkline or min/p95/max:
 * those live in the host detail panel (see docs/UI设计/11). One readout, one
 * auxiliary form, one status line.
 */

const valueEl = document.getElementById('value');
const groupsEl = document.getElementById('groups');
const noteEl = document.getElementById('note');

const readings = new Map();
let coreOrder = [];
let lastGood = null;

const CORE_COUNT = 8;

function subscribeWithRetry(name, cb) {
  let stopped = false;
  const attempt = () => {
    if (stopped) return;
    Promise.resolve(cockpit.tags.subscribe(name, cb)).then(
      (result) => {
        if (result && result.ok === false && result.reason === 'not_connected') {
          setTimeout(attempt, 150);
        }
      },
      () => setTimeout(attempt, 150),
    );
  };
  attempt();
  return () => {
    stopped = true;
  };
}

function statusOf(reading) {
  return reading && typeof reading.status === 'string' ? reading.status : 'pending';
}

function ageText(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds <= 0 ? '刚刚' : `${seconds}s 前`;
}

function noteFor(reading) {
  const status = statusOf(reading);
  if (status === 'unavailable') return '这块板不提供 CPU 占用率';
  if (status === 'pending') return '等待第一次采样';
  if (status === 'error') return '读取失败';
  if (status === 'stale') return `采样已过时 · ${ageText(reading.at)}`;
  return `采样 ${ageText(reading.at)} · 每核分布`;
}

function setValue(reading) {
  if (!valueEl) return;
  const status = statusOf(reading);

  valueEl.className = 'cockpit-value';
  valueEl.textContent = '—';

  if (status === 'unavailable') {
    valueEl.className = 'cockpit-unavailable';
    valueEl.textContent = '不可用';
    return;
  }
  if (status === 'pending') {
    valueEl.className = 'cockpit-pending';
    valueEl.textContent = '…';
    return;
  }
  if (typeof reading?.value === 'number') lastGood = reading.value;
  const number = typeof reading?.value === 'number' ? reading.value : lastGood;
  if (number === null || number === undefined) {
    valueEl.className = 'cockpit-value cockpit-value--error';
    valueEl.textContent = '—';
    return;
  }
  valueEl.textContent = number.toFixed(1);
  if (status === 'stale') valueEl.className = 'cockpit-value cockpit-value--stale';
  if (status === 'error') valueEl.className = 'cockpit-value cockpit-value--error';
}

function coreFillClass(value) {
  if (typeof value !== 'number') return 'cpu__bar-fill';
  if (value >= 85) return 'cpu__bar-fill is-danger';
  if (value >= 60) return 'cpu__bar-fill is-warn';
  return 'cpu__bar-fill';
}

function renderGroups() {
  if (!groupsEl) return;
  groupsEl.replaceChildren();

  const clusters = new Map();
  for (const index of coreOrder) {
    const cluster = readings.get(`cpu.core.${index}.cluster`);
    const label = cluster && typeof cluster.value === 'string' ? cluster.value : '核心';
    if (!clusters.has(label)) clusters.set(label, []);
    clusters.get(label).push(index);
  }
  if (clusters.size === 0) {
    const fallback = { 核心: Array.from({ length: CORE_COUNT }, (_, i) => i) };
    for (const [label, indexes] of Object.entries(fallback)) clusters.set(label, indexes);
  }

  for (const [label, indexes] of clusters) {
    const group = document.createElement('div');
    group.className = 'cpu__group';

    const heading = document.createElement('span');
    heading.className = 'cpu__group-label';
    heading.textContent = label;
    group.append(heading);

    const bars = document.createElement('div');
    bars.className = 'cpu__bars';
    for (const index of indexes) {
      const reading = readings.get(`cpu.core.${index}.usage`);
      const percent =
        reading && typeof reading.value === 'number' ? Math.max(0, Math.min(100, reading.value)) : 0;

      const column = document.createElement('div');
      column.className = 'cpu__bar';
      column.title = `核心 ${index}`;

      const track = document.createElement('div');
      track.className = 'cpu__bar-track';
      const fill = document.createElement('div');
      fill.className = coreFillClass(reading?.value);
      fill.style.height = `${percent}%`;
      track.append(fill);

      const caption = document.createElement('span');
      caption.className = 'cpu__bar-value';
      caption.textContent = reading && typeof reading.value === 'number' ? `${Math.round(percent)}` : '—';

      column.append(track, caption);
      bars.append(column);
    }

    group.append(bars);
    groupsEl.append(group);
  }
}

function update() {
  const reading = readings.get('cpu.usage');
  setValue(reading);
  if (noteEl) noteEl.textContent = noteFor(reading);
  renderGroups();
}

for (let index = 0; index < CORE_COUNT; index += 1) {
  coreOrder.push(index);
  subscribeWithRetry(`cpu.core.${index}.usage`, (reading) => {
    readings.set(`cpu.core.${index}.usage`, reading);
    update();
  });
  subscribeWithRetry(`cpu.core.${index}.cluster`, (reading) => {
    readings.set(`cpu.core.${index}.cluster`, reading);
    update();
  });
}

subscribeWithRetry('cpu.usage', (reading) => {
  readings.set('cpu.usage', reading);
  update();
});

setInterval(() => {
  const reading = readings.get('cpu.usage');
  if (noteEl && reading) noteEl.textContent = noteFor(reading);
}, 1000);

update();
