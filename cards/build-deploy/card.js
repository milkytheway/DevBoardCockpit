/**
 * Build/deploy: pick a workflow, fill its declared inputs, run it, watch the
 * stages. The card never runs commands itself — it only asks the host.
 */

const flowEl = document.getElementById('flow');
const inputsEl = document.getElementById('inputs');
const runEl = document.getElementById('run');
const noteEl = document.getElementById('note');
const stepsEl = document.getElementById('steps');

let flows = [];
let current = null;
let runId = null;
let timer = null;

const ALLOWED = new Set(['hello-kernel.build-run', 'meminfo-user.build-run']);

const STATE_TEXT = {
  running: '在跑',
  awaiting_confirmation: '等确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const REASON_TEXT = {
  denied: '没有被授权',
  not_found: '没有这个流程',
  not_approved: '流程包未批准',
  invalid_params: '输入不合法',
  busy: '同一条流程正在跑',
  failed: '执行失败',
  not_connected: '宿主未连接',
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

function renderFlowOptions() {
  if (!flowEl) return;
  flowEl.textContent = '';
  for (const flow of flows) {
    const option = document.createElement('option');
    option.value = flow.id;
    option.textContent = flow.name ?? flow.id;
    flowEl.appendChild(option);
  }
  current = flows[0] ?? null;
  if (current) flowEl.value = current.id;
}

function renderInputs() {
  if (!inputsEl) return;
  inputsEl.textContent = '';
  const declared = current && current.inputs ? current.inputs : {};
  for (const name of Object.keys(declared)) {
    const def = declared[name] ?? {};
    const row = document.createElement('label');
    row.className = 'flow__field';

    const label = document.createElement('span');
    label.className = 'flow__label';
    label.textContent = def.required === true ? `${name} *` : name;
    if (typeof def.description === 'string') label.title = def.description;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flow__input';
    input.dataset.name = name;
    input.placeholder = def.type === 'path' ? '路径' : '值';
    if (def.default !== undefined && def.default !== null) input.value = String(def.default);

    row.append(label, input);
    inputsEl.appendChild(row);
  }
}

function collectInputs() {
  const declared = current && current.inputs ? current.inputs : {};
  const values = {};
  if (!inputsEl) return values;
  for (const el of inputsEl.querySelectorAll('input[data-name]')) {
    const name = el.dataset.name;
    if (name === undefined || !Object.prototype.hasOwnProperty.call(declared, name)) continue;
    values[name] = el.value;
  }
  return values;
}

function missingRequired() {
  const declared = current && current.inputs ? current.inputs : {};
  const values = collectInputs();
  return Object.entries(declared)
    .filter(([name, def]) => def.required === true && String(values[name] ?? '').trim() === '')
    .map(([name]) => name);
}

function renderSteps(status) {
  if (!stepsEl) return;
  stepsEl.textContent = '';
  const stages = Array.isArray(status.stages) ? status.stages : [];
  for (const stage of stages) {
    const li = document.createElement('li');
    const ok = stage.ok === true;
    const verified = stage.verified === true;
    const tone = !ok ? 'bad' : verified ? 'ok' : 'warn';
    li.className = `deck__step deck__step--${tone}`;
    const id = document.createElement('span');
    id.className = 'flow__step-id';
    id.textContent = stage.stepId ?? '';
    const kind = document.createElement('span');
    kind.textContent = stage.kind ?? '';
    li.append(id, kind);
    if (!ok && typeof stage.reason === 'string') {
      const why = document.createElement('span');
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
    setNote(state === 'done' ? '完成' : state === 'cancelled' ? '已取消' : '失败');
    return;
  }
  const step = status.current ? status.current.stepId : '';
  setNote(`${STATE_TEXT[state] ?? state}${step ? ` · ${step}` : ''}`);
}

async function run() {
  if (current === null) {
    setNote('先选一条流程');
    return;
  }
  const missing = missingRequired();
  if (missing.length > 0) {
    setNote(`缺输入：${missing.join('、')}`);
    return;
  }
  if (runEl) runEl.disabled = true;
  setNote('正在起…');
  const result = await cockpit.workflows.run(current.id, collectInputs());
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

async function loadFlows() {
  const list = await cockpit.workflows.list();
  if (!Array.isArray(list)) {
    setNote(REASON_TEXT[list && list.reason ? list.reason : 'failed']);
    return;
  }
  flows = list.filter((flow) => ALLOWED.has(flow.id));
  if (flows.length === 0) {
    setNote('没有可跑的流程');
    if (runEl) runEl.disabled = true;
    return;
  }
  renderFlowOptions();
  renderInputs();
  setNote('就绪');
}

if (flowEl) {
  flowEl.addEventListener('change', () => {
    current = flows.find((flow) => flow.id === flowEl.value) ?? null;
    renderInputs();
    setNote('就绪');
  });
}
if (runEl) runEl.addEventListener('click', () => void run());
await loadFlows();
