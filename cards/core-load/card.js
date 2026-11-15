/**
 * Per-core load: one headline (average), eight bars, peak/total as a compact
 * auxiliary line. No gradient fills, no glow.
 */

const valueEl = document.getElementById('value');
const peakEl = document.getElementById('peak');
const totalEl = document.getElementById('total');
const barsEl = document.getElementById('bars');
const noteEl = document.getElementById('note');

const readings = new Map();
const CORE_COUNT = 8;
let lastGood = null;

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

function fillClass(value) {
  if (value >= 85) return 'core__fill is-danger';
  if (value >= 60) return 'core__fill is-warn';
  return 'core__fill';
}

function renderBars() {
  if (!barsEl) return;
  const existing = barsEl.children.length;
  if (existing !== CORE_COUNT) {
    barsEl.replaceChildren();
    for (let index = 0; index < CORE_COUNT; index += 1) {
      const column = document.createElement('div');
      column.className = 'core__bar';
      column.title = `核心 ${index}`;

      const track = document.createElement('div');
      track.className = 'core__track';
      const fill = document.createElement('div');
      fill.className = 'core__fill';
      track.append(fill);

      const caption = document.createElement('span');
      caption.className = 'core__caption';
      caption.textContent = String(index);

      column.append(track, caption);
      barsEl.append(column);
    }
  }

  for (let index = 0; index < CORE_COUNT; index += 1) {
    const column = barsEl.children[index];
    if (!column) continue;
    const reading = readings.get(`cpu.core.${index}.usage`);
    const percent =
      reading && typeof reading.value === 'number' ? Math.max(0, Math.min(100, reading.value)) : 0;
    const fill = column.querySelector('.core__fill');
    if (fill) {
      fill.className = fillClass(percent);
      fill.style.height = `${percent}%`;
    }
    column.title = `核心 ${index} · ${reading && typeof reading.value === 'number' ? `${Math.round(percent)}%` : '—'}`;
  }
}

function render() {
  const usage = readings.get('cpu.usage');
  const status = statusOf(usage);

  if (valueEl) {
    valueEl.className = 'cockpit-value';
    if (status === 'unavailable') {
      valueEl.className = 'cockpit-unavailable';
      valueEl.textContent = '不可用';
    } else if (status === 'pending') {
      valueEl.className = 'cockpit-pending';
      valueEl.textContent = '…';
    } else {
      if (typeof usage?.value === 'number') lastGood = usage.value;
      const number = typeof usage?.value === 'number' ? usage.value : lastGood;
      if (number === null || number === undefined) {
        valueEl.className = 'cockpit-value cockpit-value--error';
        valueEl.textContent = '—';
      } else {
        valueEl.textContent = number.toFixed(1);
        if (status === 'stale') valueEl.className = 'cockpit-value cockpit-value--stale';
        if (status === 'error') valueEl.className = 'cockpit-value cockpit-value--error';
      }
    }
  }

  let peak = null;
  for (let index = 0; index < CORE_COUNT; index += 1) {
    const core = readings.get(`cpu.core.${index}.usage`);
    if (core && typeof core.value === 'number') {
      peak = peak === null ? core.value : Math.max(peak, core.value);
    }
  }
  if (peakEl) peakEl.textContent = peak === null ? '—' : `${peak.toFixed(0)}%`;
  if (totalEl) {
    totalEl.textContent = typeof usage?.value === 'number' ? `${usage.value.toFixed(1)}%` : '—';
  }

  if (noteEl) {
    if (status === 'error') noteEl.textContent = '读取失败 · 显示的是上一次的值';
    else if (status === 'stale') noteEl.textContent = `采样已过时 · ${ageText(usage.at)}`;
    else if (status === 'unavailable') noteEl.textContent = '这块板不提供逐核负载';
    else if (status === 'pending') noteEl.textContent = '等待第一次采样';
    else noteEl.textContent = `采样 ${ageText(usage.at)}`;
  }

  renderBars();
}

for (let index = 0; index < CORE_COUNT; index += 1) {
  subscribeWithRetry(`cpu.core.${index}.usage`, (reading) => {
    readings.set(`cpu.core.${index}.usage`, reading);
    render();
  });
}
subscribeWithRetry('cpu.usage', (reading) => {
  readings.set('cpu.usage', reading);
  render();
});

setInterval(render, 1000);
render();
