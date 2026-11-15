/**
 * Board identity: model as the headline, governor and GPU frequency as rows.
 */

const modelEl = document.getElementById('model');
const governorEl = document.getElementById('governor');
const freqEl = document.getElementById('freq');
const noteEl = document.getElementById('note');

const readings = new Map();

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

function fmtFreq(hz) {
  if (typeof hz !== 'number') return '—';
  return hz >= 1e9 ? `${(hz / 1e9).toFixed(2)} GHz` : `${Math.round(hz / 1e6)} MHz`;
}

function render() {
  const model = readings.get('board.model');
  const status = statusOf(model);

  if (modelEl) {
    modelEl.className = 'board__model';
    if (status === 'unavailable') {
      modelEl.textContent = '不可用';
    } else if (status === 'pending') {
      modelEl.textContent = '…';
    } else if (model && typeof model.value === 'string') {
      modelEl.textContent = model.value;
    } else {
      modelEl.textContent = '—';
    }
  }

  const governor = readings.get('cpu.governor');
  if (governorEl) {
    governorEl.textContent =
      governor && typeof governor.value === 'string' ? governor.value : '—';
  }

  const freq = readings.get('gpu.freq_hz');
  if (freqEl) freqEl.textContent = fmtFreq(freq?.value);

  if (noteEl) {
    if (status === 'error') noteEl.textContent = '读取失败';
    else if (status === 'stale') noteEl.textContent = `采样已过时 · ${ageText(model.at)}`;
    else if (status === 'unavailable') noteEl.textContent = '这块板不提供型号';
    else if (status === 'pending') noteEl.textContent = '等待第一次采样';
    else noteEl.textContent = `采样 ${ageText(model.at)}`;
  }
}

for (const name of ['board.model', 'cpu.governor', 'gpu.freq_hz']) {
  subscribeWithRetry(name, (reading) => {
    readings.set(name, reading);
    render();
  });
}

setInterval(render, 1000);
render();
