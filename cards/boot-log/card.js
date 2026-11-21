/**
 * The boot log card: **run the flow, show what it did**.
 *
 * ── What the card shows, and what it cannot ──
 *
 * → The card may **not** see the output of a workflow ✓ (contract `05`
 *   §8·B·B5 ✓ — the details stay with the host and the agent ✓) → it cannot
 *   print the log itself ✓.
 * → So the flow writes the log to a **file on the board** ✓ and the card
 *   says **where** ✓ → the **file transfer** fetches it ✓ (the file page ✓
 *   — it picks its own link ✓ · no terminal needed ✓).
 * → The card shows the **verdict of every step** ✓ — that is what it is for
 *   ✓ (the same shape as the workflow card ✓).
 */

const FLOW_ID = 'boot-log.capture';

const runEl = document.getElementById('run');
const noteEl = document.getElementById('note');
const stepsEl = document.getElementById('steps');
const pathEl = document.getElementById('path');

const REASON_TEXT = {
  denied: '没有被授权',
  not_found: '没有这个流程',
  invalid_params: '输入不合法',
  busy: '同一条流程正在跑',
  failed: '执行失败',
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

let runId = null;
let timer = null;

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

function renderSteps(status) {
  if (!stepsEl) return;
  stepsEl.textContent = '';
  const stages = Array.isArray(status.stages) ? status.stages : [];
  for (const stage of stages) {
    const li = document.createElement('li');
    const ok = stage.ok === true;
    const verified = stage.verified === true;
    li.className = `log__step ${ok ? (verified ? 'is-ok' : 'is-warn') : 'is-bad'}`;
    const id = document.createElement('span');
    id.className = 'log__step-id';
    id.textContent = stage.stepId ?? '';
    li.append(id);
    if (!ok && typeof stage.reason === 'string') {
      const why = document.createElement('span');
      why.className = 'log__step-why';
      why.textContent = REASON_TEXT[stage.reason] ?? stage.reason;
      li.appendChild(why);
    }
    stepsEl.appendChild(li);
  }
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (runEl) runEl.disabled = false;
}

async function tick() {
  if (runId === null) return;
  const status = await cockpit.workflows.status(runId);
  if (!status || status.ok === false) {
    setNote(REASON_TEXT[status && status.reason ? status.reason : 'failed']);
    stop();
    return;
  }
  renderSteps(status);
  const state = status.state ?? 'running';
  if (TERMINAL.has(state)) {
    stop();
    if (state === 'done') setNote('已取到，日志在板子上');
    else if (state === 'cancelled') setNote('已取消');
    else setNote('没成');
    return;
  }
  const step = status.current ? status.current.stepId : '';
  setNote(step ? `正在跑 · ${step}` : '正在跑…');
}

async function run() {
  if (runEl) runEl.disabled = true;
  setNote('正在起…');
  const result = await cockpit.workflows.run(FLOW_ID, {});
  if (!result || result.ok === false) {
    setNote(REASON_TEXT[result && result.reason ? result.reason : 'failed']);
    if (runEl) runEl.disabled = false;
    return;
  }
  runId = result.runId;
  stop();
  timer = setInterval(() => void tick(), 700);
  await tick();
}

/** The flow may declare a default path ✓ — the card shows it ✓ */
async function loadPath() {
  const list = await cockpit.workflows.list();
  if (!Array.isArray(list)) return;
  const flow = list.find((item) => item.id === FLOW_ID);
  const declared = flow && flow.inputs ? flow.inputs : {};
  const path = declared.path;
  if (path && typeof path.default === 'string' && pathEl) pathEl.textContent = path.default;
}

if (runEl) runEl.addEventListener('click', () => void run());
void loadPath();
