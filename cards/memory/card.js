/**
 * Memory card: percentage + used/total. The trend and the detailed byte
 * breakdown live in the host detail panel, not here.
 */

const valueEl = document.getElementById('value');
const fractionEl = document.getElementById('fraction');
const noteEl = document.getElementById('note');

const readings = new Map();
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

function fmtBytes(bytes) {
  if (typeof bytes !== 'number') return '—';
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(0)} MiB`;
}

function statusOf(reading) {
  return reading && typeof reading.status === 'string' ? reading.status : 'pending';
}

function ageText(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds <= 0 ? '刚刚' : `${seconds}s 前`;
}

function render() {
  const usage = readings.get('mem.usage');
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
        valueEl.textContent = number.toFixed(0);
        if (status === 'stale') valueEl.className = 'cockpit-value cockpit-value--stale';
        if (status === 'error') valueEl.className = 'cockpit-value cockpit-value--error';
      }
    }
  }

  const used = readings.get('mem.used_bytes');
  const total = readings.get('mem.total_bytes');
  const available = readings.get('mem.available_bytes');
  if (fractionEl) fractionEl.textContent = `${fmtBytes(used?.value)} / ${fmtBytes(total?.value)}`;

  if (noteEl) {
    if (status === 'error') noteEl.textContent = '读取失败 · 显示的是上一次的值';
    else if (status === 'stale') noteEl.textContent = `采样已过时 · ${ageText(usage.at)}`;
    else if (status === 'unavailable') noteEl.textContent = '这块板不提供内存信息';
    else if (status === 'pending') noteEl.textContent = '等待第一次采样';
    else noteEl.textContent = `可用 ${fmtBytes(available?.value)} · 采样 ${ageText(usage.at)}`;
  }
}

for (const name of ['mem.usage', 'mem.used_bytes', 'mem.total_bytes', 'mem.available_bytes']) {
  subscribeWithRetry(name, (reading) => {
    readings.set(name, reading);
    render();
  });
}

setInterval(render, 1000);
render();
