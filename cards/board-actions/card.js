/**
 * Board actions: LED, backlight, governor. Every call goes through the host's
 * permission check, executes once, then returns the readback.
 */

const ledEl = document.getElementById('led');
const ledTextEl = document.getElementById('led-text');
const ledNoteEl = document.getElementById('led-note');
const blEl = document.getElementById('bl');
const blTextEl = document.getElementById('bl-text');
const blApplyEl = document.getElementById('bl-apply');
const blNoteEl = document.getElementById('bl-note');
const govEl = document.getElementById('gov');
const govTextEl = document.getElementById('gov-text');
const govApplyEl = document.getElementById('gov-apply');
const govNoteEl = document.getElementById('gov-note');

let ledOn = false;
let blTouched = false;

const REASON_TEXT = {
  denied: '没有授权',
  readback_mismatch: '回读不符',
  not_found: '没有这个动作',
  invalid_params: '参数不合法',
  busy: '链路正忙',
  timeout: '超时',
  unsupported_transport: '这个通道不支持',
  not_connected: '宿主未连接',
  floor: '被危险地板拦住',
};

function note(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.className = `ops__note${tone ? ` is-${tone}` : ''}`;
}

function reasonText(reason) {
  return REASON_TEXT[reason] ?? `失败（${reason}）`;
}

function renderLed() {
  if (ledTextEl) ledTextEl.textContent = ledOn ? '开' : '关';
  if (ledEl) ledEl.setAttribute('aria-checked', ledOn ? 'true' : 'false');
}

function resultText(result) {
  if (!result || result.ok === false) return { text: reasonText(result && result.reason ? result.reason : 'failed'), tone: 'bad' };
  if (result.verified === false) return { text: '已发出 · 未确认', tone: 'warn' };
  return { text: '已生效', tone: 'ok' };
}

async function invoke(action, params) {
  return cockpit.actions.invoke(action, params);
}

async function toggleLed() {
  if (!ledEl) return;
  ledEl.disabled = true;
  const next = ledOn ? 0 : 1;
  note(ledNoteEl, '执行中…', null);
  const result = await invoke('led.set', { value: next });
  const done = resultText(result);
  note(ledNoteEl, done.text, done.tone);
  if (result && result.ok === true) {
    ledOn = next === 1;
    renderLed();
  }
  ledEl.disabled = false;
}

async function applyBacklight() {
  if (!blEl || !blApplyEl) return;
  blApplyEl.disabled = true;
  blTouched = false;
  const value = Number(blEl.value);
  note(blNoteEl, '执行中…', null);
  const result = await invoke('backlight.set', { value });
  const done = resultText(result);
  note(blNoteEl, done.text, done.tone);
  blApplyEl.disabled = false;
}

async function applyGovernor() {
  if (!govEl || !govApplyEl) return;
  govApplyEl.disabled = true;
  note(govNoteEl, '执行中…', null);
  const result = await invoke('cpu.governor.set_all', { governor: govEl.value });
  const done = resultText(result);
  note(govNoteEl, done.text, done.tone);
  govApplyEl.disabled = false;
}

function subscribeWithRetry(kind, name, cb) {
  let stopped = false;
  const start = () => {
    if (stopped) return;
    const call = kind === 'pattern' ? cockpit.tags.subscribePattern(name, cb) : cockpit.tags.subscribe(name, cb);
    call.then((result) => {
      if (!result || result.ok === false) setTimeout(start, 150);
    }).catch(() => setTimeout(start, 150));
  };
  start();
  return () => { stopped = true; };
}

function onBacklight(reading) {
  if (!reading || reading.status !== 'ok' || typeof reading.value !== 'number') return;
  if (blTextEl) blTextEl.textContent = String(Math.round(reading.value));
  if (blEl && !blTouched) blEl.value = String(Math.round(reading.value));
}

function onGovernor(reading) {
  if (!reading || reading.status !== 'ok' || typeof reading.value !== 'string') return;
  if (govTextEl) govTextEl.textContent = reading.value;
  if (govEl) {
    const known = Array.from(govEl.options).some((option) => option.value === reading.value);
    if (!known) {
      const option = document.createElement('option');
      option.value = reading.value;
      option.textContent = reading.value;
      govEl.appendChild(option);
    }
    govEl.value = reading.value;
  }
}

if (ledEl) ledEl.addEventListener('click', () => void toggleLed());
if (blApplyEl) blApplyEl.addEventListener('click', () => void applyBacklight());
if (govApplyEl) govApplyEl.addEventListener('click', () => void applyGovernor());
if (blEl) blEl.addEventListener('input', () => { blTouched = true; });

renderLed();
subscribeWithRetry('name', 'custom.rk3588-atk.backlight.brightness', onBacklight);
subscribeWithRetry('name', 'cpu.governor', onGovernor);
