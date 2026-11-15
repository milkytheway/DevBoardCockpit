/**
 * Thermal card: SoC is the claim; GPU/NPU are two supporting rows. The
 * threshold decoration moved to the host detail panel.
 */

const socEl = document.getElementById('soc');
const gpuEl = document.getElementById('gpu');
const npuEl = document.getElementById('npu');
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

function statusOf(reading) {
  return reading && typeof reading.status === 'string' ? reading.status : 'pending';
}

function ageText(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds <= 0 ? '刚刚' : `${seconds}s 前`;
}

function setRow(element, reading) {
  if (!element) return;
  const parent = element.parentElement;
  const status = statusOf(reading);
  parent?.classList.remove('is-warn', 'is-danger');
  if (status === 'unavailable') {
    element.textContent = '不可用';
    return;
  }
  if (typeof reading?.value !== 'number') {
    element.textContent = '—';
    return;
  }
  element.textContent = `${reading.value.toFixed(1)} °C`;
  if (reading.value >= 85) parent?.classList.add('is-danger');
  else if (reading.value >= 70) parent?.classList.add('is-warn');
}

function render() {
  const soc = readings.get('temp.soc');
  const status = statusOf(soc);

  if (socEl) {
    socEl.className = 'cockpit-value';
    if (status === 'unavailable') {
      socEl.className = 'cockpit-unavailable';
      socEl.textContent = '不可用';
    } else if (status === 'pending') {
      socEl.className = 'cockpit-pending';
      socEl.textContent = '…';
    } else {
      if (typeof soc?.value === 'number') lastGood = soc.value;
      const number = typeof soc?.value === 'number' ? soc.value : lastGood;
      if (number === null || number === undefined) {
        socEl.className = 'cockpit-value cockpit-value--error';
        socEl.textContent = '—';
      } else {
        socEl.textContent = number.toFixed(1);
        if (status === 'stale') socEl.className = 'cockpit-value cockpit-value--stale';
        if (status === 'error') socEl.className = 'cockpit-value cockpit-value--error';
      }
    }
  }

  setRow(gpuEl, readings.get('temp.gpu'));
  setRow(npuEl, readings.get('temp.npu'));

  if (noteEl) {
    if (status === 'error') noteEl.textContent = '读取失败 · 显示的是上一次的值';
    else if (status === 'stale') noteEl.textContent = `采样已过时 · ${ageText(soc.at)}`;
    else if (status === 'unavailable') noteEl.textContent = '这块板不提供温度';
    else if (status === 'pending') noteEl.textContent = '等待第一次采样';
    else noteEl.textContent = `采样 ${ageText(soc.at)}`;
  }
}

for (const name of ['temp.soc', 'temp.gpu', 'temp.npu']) {
  subscribeWithRetry(name, (reading) => {
    readings.set(name, reading);
    render();
  });
}

setInterval(render, 1000);
render();
