/**
 * Thermal card: SoC hero value plus GPU / NPU threshold bars.
 */

const el = (id) => document.getElementById(id);

const readings = new Map();
const parts = {
  soc: el('soc-value'),
  socAt: el('soc-at'),
  gpuValue: el('gpu-value'),
  gpuFill: el('gpu-fill'),
  npuValue: el('npu-value'),
  npuFill: el('npu-fill'),
  note: el('note'),
};

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
  if (value >= 70) return 'warn';
  return 'ok';
}

function fmtTemp(value) {
  return typeof value === 'number' ? value.toFixed(1) : '—';
}

function renderRow(valueNode, fillNode, reading) {
  const tone = toneFor(reading && (reading.status === 'ok' || reading.status === 'stale') ? reading.value : null);
  if (valueNode) valueNode.textContent = fmtTemp(reading && (reading.status === 'ok' || reading.status === 'stale') ? reading.value : null) + ' °C';
  if (fillNode) {
    fillNode.dataset.tone = tone;
    fillNode.style.width =
      (reading && (reading.status === 'ok' || reading.status === 'stale') && typeof reading.value === 'number'
        ? Math.max(0, Math.min(100, reading.value))
        : 0) + '%';
  }
  if (valueNode) {
    valueNode.className = valueNode.className.replace(/\s*is-\w+/g, '') + (tone === 'none' ? '' : ' is-' + tone);
  }
}

function update() {
  const soc = readings.get('temp.soc');
  const gpu = readings.get('temp.gpu');
  const npu = readings.get('temp.npu');

  const socOk = soc && (soc.status === 'ok' || soc.status === 'stale') && typeof soc.value === 'number';
  parts.soc.textContent = socOk ? fmtTemp(soc.value) : '—';
  parts.soc.className = 'th-hero__value';
  if (socOk) {
    const tone = toneFor(soc.value);
    if (tone !== 'ok') parts.soc.classList.add('is-' + tone);
    if (soc.status === 'stale') parts.soc.classList.add('is-stale');
  }
  parts.socAt.textContent = socOk ? '最后采样 ' + ago(soc.at) : '等待第一次采样';

  renderRow(parts.gpuValue, parts.gpuFill, gpu);
  renderRow(parts.npuValue, parts.npuFill, npu);

  const states = [soc, gpu, npu].filter(Boolean).map((reading) => reading.status);
  parts.note.className = 'th-note';
  if (!soc && !gpu && !npu) {
    parts.note.textContent = '等待第一次采样';
  } else if (states.includes('unavailable')) {
    parts.note.textContent = '部分温度通道不可用 · 板型包未提供';
    parts.note.classList.add('is-warn');
  } else if (states.includes('error')) {
    parts.note.textContent = '读取失败 · 显示的是上一次的值';
    parts.note.classList.add('is-error');
  } else if (states.includes('stale')) {
    parts.note.textContent = '数据已过时 · 72°C 预警 / 85°C 危险';
    parts.note.classList.add('is-warn');
  } else {
    parts.note.textContent = '72°C 预警 / 85°C 危险';
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

for (const name of ['temp.soc', 'temp.gpu', 'temp.npu']) {
  subscribeWithRetry('subscribe', name, (reading) => {
    readings.set(name, reading);
    update();
  });
}

update();
setInterval(update, 1000);
