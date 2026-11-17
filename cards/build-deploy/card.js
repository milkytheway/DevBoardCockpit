/**
 * 编译上板：三步分开跑。
 *
 * The card only collects inputs and asks the host to run one of three
 * workflow packs. It never executes commands itself.
 */

const noteEl = document.getElementById('note');
const stateEl = document.getElementById('state');
const stepsEl = document.getElementById('steps');
const dirEl = /** @type {HTMLInputElement | null} */ (document.getElementById('build-dir'));
const projectEl = /** @type {HTMLInputElement | null} */ (document.getElementById('project'));
const moduleEl = /** @type {HTMLInputElement | null} */ (document.getElementById('module'));

const PHASES = [
  { key: 'compile', flow: 'hello-kernel.compile', label: '编译' },
  { key: 'upload', flow: 'hello-kernel.upload', label: '上传' },
  { key: 'run', flow: 'hello-kernel.load', label: '运行' },
];

const ALLOWED = new Set(PHASES.map((phase) => phase.flow));

const STATE_TEXT = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const REASON_TEXT = {
  denied: '没有被授权',
  not_found: '没有这个流程',
  not_approved: '流程包未批准',
  invalid_params: '输入不合法',
  busy: '这条流程正在跑',
  failed: '执行失败',
  not_connected: '宿主未连接',
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const buttons = {};
for (const phase of PHASES) {
  buttons[phase.key] = /** @type {HTMLButtonElement | null} */ (
    document.getElementById(`phase-${phase.key}`)
  );
}

let running = false;
let runId = null;
let timer = null;
let currentPhase = null;

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

function setBusy(busy) {
  running = busy;
  for (const button of Object.values(buttons)) {
    if (button) button.disabled = busy;
  }
  if (stateEl) {
    stateEl.hidden = !busy;
    stateEl.textContent = busy ? '运行中' : '';
  }
}

function markPhase(key, state) {
  const item = document.querySelector(`.bd__step[data-phase="${key}"]`);
  if (!item) return;
  item.classList.toggle('is-active', state === 'running');
  item.classList.toggle('is-done', state === 'done');
  item.classList.toggle('is-failed', state === 'failed');
}

function clearTimeline() {
  if (stepsEl) stepsEl.textContent = '';
}

function renderStages(status) {
  if (!stepsEl) return;
  clearTimeline();
  const stages = Array.isArray(status.stages) ? status.stages : [];
  for (const stage of stages) {
    const li = document.createElement('li');
    const ok = stage.ok === true;
    li.className = 'bd__run-item';
    if (!ok) li.classList.add('is-bad');
    else if (stage.verified === true) li.classList.add('is-ok');
    else li.classList.add('is-warn');

    const dot = document.createElement('span');
    dot.className = 'bd__run-dot';
    dot.textContent = ok ? (stage.verified === true ? '✓' : '·') : '✕';
    const id = document.createElement('span');
    id.className = 'bd__run-id mono';
    id.textContent = stage.stepId ?? '';
    const kind = document.createElement('span');
    kind.className = 'bd__run-kind';
    kind.textContent = stage.kind ?? '';
    li.append(dot, id, kind);
    if (!ok && typeof stage.reason === 'string') {
      const why = document.createElement('span');
      why.className = 'bd__run-why';
      why.textContent = REASON_TEXT[stage.reason] ?? stage.reason;
      li.appendChild(why);
    }
    stepsEl.appendChild(li);
  }
}

function stopPolling() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function poll() {
  if (runId === null) return;
  const status = await cockpit.workflows.status(runId);
  if (!status || status.ok === false) {
    if (currentPhase) markPhase(currentPhase, 'failed');
    setNote(REASON_TEXT[status && status.reason ? status.reason : 'failed']);
    stopPolling();
    setBusy(false);
    return;
  }
  renderStages(status);
  const state = status.state ?? 'running';
  if (!TERMINAL.has(state)) {
    const step = status.current ? status.current.stepId : '';
    setNote(`${STATE_TEXT[state] ?? state}${step ? ` · ${step}` : ''}`);
    return;
  }
  stopPolling();
  setBusy(false);
  if (currentPhase) markPhase(currentPhase, state === 'done' ? 'done' : 'failed');
  setNote(state === 'done' ? '完成' : state === 'cancelled' ? '已取消' : '失败');
}

function collectInputs(phase) {
  const editable = {
    build_dir: dirEl ? dirEl.value.trim() : '',
    project: projectEl ? projectEl.value.trim() : '',
    module: moduleEl ? moduleEl.value.trim() : '',
  };
  if (phase.key === 'run') {
    return editable.module ? { module: editable.module } : {};
  }
  const inputs = {};
  if (editable.build_dir) inputs.build_dir = editable.build_dir;
  if (editable.project) inputs.project = editable.project;
  return inputs;
}

async function start(phase) {
  if (running) return;
  stopPolling();
  runId = null;
  currentPhase = phase.key;
  setBusy(true);
  markPhase(phase.key, 'running');
  clearTimeline();
  setNote(`正在起：${phase.label}`);
  const result = await cockpit.workflows.run(phase.flow, collectInputs(phase));
  if (!result || result.ok === false) {
    setBusy(false);
    markPhase(phase.key, 'failed');
    setNote(REASON_TEXT[result && result.reason ? result.reason : 'failed']);
    return;
  }
  runId = result.runId;
  timer = setInterval(() => void poll(), 700);
  await poll();
}

for (const phase of PHASES) {
  const button = buttons[phase.key];
  if (button) button.addEventListener('click', () => void start(phase));
}

async function init() {
  const list = await cockpit.workflows.list();
  if (!Array.isArray(list)) {
    setNote(REASON_TEXT[list && list.reason ? list.reason : 'failed']);
    return;
  }
  const available = new Set(list.map((flow) => flow.id));
  for (const phase of PHASES) {
    const button = buttons[phase.key];
    if (button) button.title = ALLOWED.has(phase.flow) && available.has(phase.flow)
      ? `${phase.flow}`
      : '宿主没有这条流程';
  }
  const missing = PHASES.filter((phase) => !available.has(phase.flow));
  if (missing.length > 0) {
    setNote(`宿主没有：${missing.map((phase) => phase.label).join('、')}`);
  }
}

await init();
