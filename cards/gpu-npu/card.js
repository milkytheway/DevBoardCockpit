/**
 * GPU / NPU card: two rings plus frequency and temperature facts.
 *
 * NPU usage is honestly rendered as unavailable when the board cannot read it
 * (the fake device has no `/sys/kernel/debug/rknpu/load`); a missing reading is
 * never shown as 0.
 */

const el = (id) => document.getElementById(id);

const readings = new Map();
const parts = {
  gpu: { arc: el('gpu-arc'), value: el('gpu-value'), foot: el('gpu-foot') },
  npu: { arc: el('npu-arc'), value: el('npu-value'), foot: el('npu-foot') },
  gpuFreq: el('gpu-freq'),
  npuFreq: el('npu-freq'),
  gpuTemp: el('gpu-temp'),
  npuTemp: el('npu-temp'),
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

function fmtTemp(value) {
  return typeof value === 'number' ? value.toFixed(1) + ' °C' : '—';
}

function ringState(reading) {
  if (!reading) return 'pending';
  if (reading.status === 'ok' || reading.status === 'stale') {
    return typeof reading.value === 'number' ? reading.status : 'pending';
  }
  return reading.status;
}

function renderRing(key, reading) {
  const node = parts[key];
  const state = ringState(reading);
  const numeric = state === 'ok' || state === 'stale' ? reading.value : null;

  node.value.className = 'ring__value';
  node.arc.dataset.state = state;

  if (numeric === null) {
    node.arc.style.strokeDasharray = '0 100';
    node.value.textContent = state === 'unavailable' ? '不可用' : '—';
    node.value.classList.add('is-' + state);
    node.foot.textContent =
      state === 'pending' ? '等待采样' : state === 'unavailable' ? '板型不暴露' : state === 'error' ? '读取失败' : '';
    return;
  }

  const clamped = Math.max(0, Math.min(100, numeric));
  node.arc.style.strokeDasharray = clamped + ' 100';
  node.value.textContent = (numeric < 10 ? numeric.toFixed(1) : Math.round(numeric)) + '%';
  node.foot.textContent = state === 'stale' ? '已过时 · ' + ago(reading.at) : '2s 刷新';
}

function update() {
  const gpu = readings.get('gpu.usage');
  const npu = readings.get('npu.usage');

  renderRing('gpu', gpu);
  renderRing('npu', npu);

  const gpuFreq = readings.get('gpu.freq_hz');
  parts.gpuFreq.textContent = gpuFreq && typeof gpuFreq.value === 'number' ? fmtFreq(gpuFreq.value) : '—';

  const npuFreq = readings.get('custom.rk3588-atk.npu.freq_hz');
  parts.npuFreq.textContent =
    npuFreq && typeof npuFreq.value === 'number' ? fmtFreq(npuFreq.value) : '—';

  const gpuTemp = readings.get('temp.gpu');
  parts.gpuTemp.textContent = gpuTemp && typeof gpuTemp.value === 'number' ? fmtTemp(gpuTemp.value) : '—';

  const npuTemp = readings.get('temp.npu');
  parts.npuTemp.textContent = npuTemp && typeof npuTemp.value === 'number' ? fmtTemp(npuTemp.value) : '—';

  const gpuState = ringState(gpu);
  const npuState = ringState(npu);
  const last = [gpu, npu].find((reading) => reading && typeof reading.at === 'number');

  if (npuState === 'unavailable') {
    parts.note.textContent = 'NPU 利用率不可用 · 这块板不暴露 rknpu load';
    parts.note.className = 'gn-note is-warn';
  } else if (gpuState === 'error' || npuState === 'error') {
    parts.note.textContent = '读取失败 · 显示的是上一次的值';
    parts.note.className = 'gn-note is-error';
  } else if (gpuState === 'stale' || npuState === 'stale') {
    parts.note.textContent = '数据已过时 · 最后采样 ' + ago(last && last.at);
    parts.note.className = 'gn-note is-warn';
  } else if (gpuState === 'pending') {
    parts.note.textContent = '等待第一次采样';
    parts.note.className = 'gn-note';
  } else {
    parts.note.textContent = last ? '最后采样 ' + ago(last.at) : '';
    parts.note.className = 'gn-note';
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

for (const name of ['gpu.usage', 'npu.usage', 'gpu.freq_hz', 'temp.gpu', 'temp.npu']) {
  subscribeWithRetry('subscribe', name, (reading) => {
    readings.set(name, reading);
    update();
  });
}
subscribeWithRetry('subscribe', 'custom.rk3588-atk.npu.freq_hz', (reading) => {
  readings.set('custom.rk3588-atk.npu.freq_hz', reading);
  update();
});

update();
setInterval(update, 1000);
