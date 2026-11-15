/**
 * GPU/NPU card: GPU load is the single claim. NPU load, frequency and
 * temperature are one auxiliary row; the rings and identity colours are gone.
 */

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

function fmtFreq(hz) {
  if (typeof hz !== 'number') return '—';
  return hz >= 1e9 ? `${(hz / 1e9).toFixed(2)} GHz` : `${Math.round(hz / 1e6)} MHz`;
}

function render() {
  const gpu = readings.get('gpu.usage');
  const status = statusOf(gpu);

  if (gpuEl) {
    gpuEl.className = 'cockpit-value';
    if (status === 'unavailable') {
      gpuEl.className = 'cockpit-unavailable';
      gpuEl.textContent = '不可用';
    } else if (status === 'pending') {
      gpuEl.className = 'cockpit-pending';
      gpuEl.textContent = '…';
    } else {
      if (typeof gpu?.value === 'number') lastGood = gpu.value;
      const number = typeof gpu?.value === 'number' ? gpu.value : lastGood;
      if (number === null || number === undefined) {
        gpuEl.className = 'cockpit-value cockpit-value--error';
        gpuEl.textContent = '—';
      } else {
        gpuEl.textContent = number.toFixed(0);
        if (status === 'stale') gpuEl.className = 'cockpit-value cockpit-value--stale';
        if (status === 'error') gpuEl.className = 'cockpit-value cockpit-value--error';
      }
    }
  }

  const npu = readings.get('npu.usage');
  if (npuEl) {
    if (statusOf(npu) === 'unavailable') npuEl.textContent = '不可用';
    else if (typeof npu?.value === 'number') npuEl.textContent = `${npu.value.toFixed(0)}%`;
    else npuEl.textContent = '—';
  }

  if (noteEl) {
    if (status === 'error') noteEl.textContent = '读取失败 · 显示的是上一次的值';
    else if (status === 'stale') noteEl.textContent = `采样已过时 · ${ageText(gpu.at)}`;
    else if (status === 'unavailable') noteEl.textContent = '这块板不提供 GPU 负载';
    else if (status === 'pending') noteEl.textContent = '等待第一次采样';
    else {
      const freq = fmtFreq(readings.get('gpu.freq_hz')?.value);
      const temp = readings.get('temp.gpu')?.value;
      const tempText = typeof temp === 'number' ? `${temp.toFixed(1)}°C` : '—';
      noteEl.textContent = `${freq} · ${tempText} · 采样 ${ageText(gpu.at)}`;
    }
  }
}

for (const name of ['gpu.usage', 'npu.usage', 'gpu.freq_hz', 'temp.gpu']) {
  subscribeWithRetry(name, (reading) => {
    readings.set(name, reading);
    render();
  });
}

setInterval(render, 1000);
render();
