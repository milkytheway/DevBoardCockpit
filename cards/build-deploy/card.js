/**
 * Build and deploy: choose the workspace values, then run one explicit stage.
 */

const noteEl = document.getElementById('note');
const stateEl = document.getElementById('state');
const stepsEl = document.getElementById('steps');

const LANG =
  new window.URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh';
const TEXT = {
  zh: {
    title: '编译上板',
    compile: '编译',
    upload: '上传',
    run: '运行',
    compileAction: '执行编译',
    uploadAction: '执行上传',
    runAction: '执行运行',
    directory: '目录',
    project: '项目',
    module: '模块',
    pending: '待执行',
    idle: '空闲',
    running: '运行中',
    done: '完成',
    failed: '失败',
    cancelled: '已取消',
    choose: '选择',
    chooseDirectory: '选择构建目录',
    chooseProject: '选择项目',
    chooseModule: '选择模块',
    unavailable: '无可用项',
    missing: '缺少：{items}',
    denied: '未授权',
    notFound: '没有这个流程',
    invalid: '输入不合法',
    busy: '这条流程正在跑',
    notConnected: '宿主未连接',
  },
  en: {
    title: 'Build and deploy',
    compile: 'Compile',
    upload: 'Upload',
    run: 'Run',
    compileAction: 'Run compile',
    uploadAction: 'Run upload',
    runAction: 'Run program',
    directory: 'Directory',
    project: 'Project',
    module: 'Module',
    pending: 'Pending',
    idle: 'Idle',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    choose: 'Choose',
    chooseDirectory: 'Choose build directory',
    chooseProject: 'Choose project',
    chooseModule: 'Choose module',
    unavailable: 'No items',
    missing: 'Missing: {items}',
    denied: 'Not authorized',
    notFound: 'Workflow not found',
    invalid: 'Invalid input',
    busy: 'Workflow already running',
    notConnected: 'Host not connected',
  },
};

function t(key, values) {
  const text = TEXT[LANG][key] ?? TEXT.zh[key] ?? key;
  return values
    ? text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match))
    : text;
}

const INPUTS = {
  build_dir: /** @type {HTMLInputElement | null} */ (document.getElementById('build-dir')),
  project: /** @type {HTMLInputElement | null} */ (document.getElementById('project')),
  module: /** @type {HTMLInputElement | null} */ (document.getElementById('module')),
};

const PHASES = [
  { key: 'compile', flow: 'hello-kernel.compile' },
  { key: 'upload', flow: 'hello-kernel.upload' },
  { key: 'run', flow: 'hello-kernel.load' },
];

const STATE_TEXT = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

const REASON_TEXT = {
  denied: 'denied',
  not_found: 'notFound',
  invalid_params: 'invalid',
  busy: 'busy',
  failed: 'failed',
  not_connected: 'notConnected',
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const SUGGESTIONS = {
  build_dir: new Set(),
  project: new Set(),
  module: new Set(),
};

const phaseButtons = {};
const resultEls = {};
const chooseButtons = {};
for (const phase of PHASES) {
  phaseButtons[phase.key] = /** @type {HTMLButtonElement | null} */ (
    document.getElementById(`phase-${phase.key}`)
  );
  resultEls[phase.key] = document.getElementById(`result-${phase.key}`);
}
for (const [field, id] of Object.entries({
  build_dir: 'choose-build-dir',
  project: 'choose-project',
  module: 'choose-module',
})) {
  chooseButtons[field] = /** @type {HTMLButtonElement | null} */ (document.getElementById(id));
}

let running = false;
let runId = null;
let timer = null;
let currentPhase = null;
let available = new Set();

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

function setState(text) {
  if (stateEl) stateEl.textContent = text;
}

function setBusy(busy) {
  running = busy;
  for (const phase of PHASES) {
    const button = phaseButtons[phase.key];
    if (button) button.disabled = busy || !available.has(phase.flow);
  }
  for (const button of Object.values(chooseButtons)) {
    if (button) button.disabled = busy;
  }
  setState(busy ? t('running') : t('idle'));
}

function setPhaseState(key, state, text) {
  const row = document.querySelector(`.bd__action[data-phase="${key}"]`);
  if (row) {
    row.classList.toggle('is-running', state === 'running');
    row.classList.toggle('is-done', state === 'done');
    row.classList.toggle('is-failed', state === 'failed');
  }
  const result = resultEls[key];
  if (result) result.textContent = text;
}

function clearTimeline() {
  if (!stepsEl) return;
  stepsEl.hidden = true;
  stepsEl.textContent = '';
}

function renderStages(status) {
  if (!stepsEl) return;
  clearTimeline();
  const stages = Array.isArray(status.stages) ? status.stages : [];
  stepsEl.hidden = stages.length === 0;
  for (const stage of stages) {
    const li = document.createElement('li');
    li.className = `bd__run-item ${stage.ok ? (stage.verified ? 'is-ok' : 'is-warn') : 'is-bad'}`;
    li.title = stage.reason ? t(REASON_TEXT[stage.reason] ?? 'failed') : '';
    li.textContent = stage.stepId ?? '';
    stepsEl.appendChild(li);
  }
}

function optionList(field, defaults) {
  const values = new Set(SUGGESTIONS[field]);
  for (const value of defaults) values.add(value);
  const current = INPUTS[field]?.value.trim();
  if (current) values.add(current);
  return [...values].filter((value) => value.length > 0);
}

function closeChoices(except = null) {
  for (const field of Object.keys(INPUTS)) {
    if (field === except) continue;
    const menu = document.querySelector(`[data-choice-menu="${field}"]`);
    if (menu !== null) /** @type {{hidden:boolean}} */ (menu).hidden = true;
  }
}

function renderChoice(field) {
  const menu = document.querySelector(`[data-choice-menu="${field}"]`);
  const input = INPUTS[field];
  if (menu === null || !input) return;
  const element = /** @type {{hidden:boolean;textContent:string;appendChild(node:Node):void}} */ (menu);
  element.textContent = '';
  const values = optionList(field, []);
  if (values.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'bd__choice-empty';
    empty.textContent = t('unavailable');
    element.appendChild(empty);
  }
  for (const value of values) {
    const option = document.createElement('button');
    option.type = 'button';
    option.role = 'option';
    option.className = 'bd__choice-option';
    option.textContent = value;
    option.addEventListener('click', () => {
      input.value = value;
      SUGGESTIONS[field].add(value);
      menu.hidden = true;
      void saveValues();
    });
    element.appendChild(option);
  }
  closeChoices(field);
  element.hidden = false;
}

async function saveValues() {
  if (!cockpit.storage) return;
  const values = {
    build_dir: INPUTS.build_dir?.value.trim() ?? '',
    project: INPUTS.project?.value.trim() ?? '',
    module: INPUTS.module?.value.trim() ?? '',
  };
  await cockpit.storage.set('values', values);
  await cockpit.storage.set('recent', {
    build_dir: [...SUGGESTIONS.build_dir].slice(-8),
    project: [...SUGGESTIONS.project].slice(-12),
    module: [...SUGGESTIONS.module].slice(-12),
  });
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
    if (currentPhase) setPhaseState(currentPhase, 'failed', t('failed'));
    setNote(t(REASON_TEXT[status && status.reason ? status.reason : 'failed']));
    stopPolling();
    setBusy(false);
    return;
  }
  renderStages(status);
  const state = status.state ?? 'running';
  if (!TERMINAL.has(state)) {
    const step = status.current ? status.current.stepId : '';
    setNote(`${t(STATE_TEXT[state] ?? 'running')}${step ? ` · ${step}` : ''}`);
    return;
  }
  stopPolling();
  setBusy(false);
  const text = t(state === 'done' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed');
  if (currentPhase) setPhaseState(currentPhase, state === 'done' ? 'done' : 'failed', text);
  setNote(text);
}

function collectInputs(phase) {
  const editable = {
    build_dir: INPUTS.build_dir?.value.trim() ?? '',
    project: INPUTS.project?.value.trim() ?? '',
    module: INPUTS.module?.value.trim() ?? '',
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
  if (running || !available.has(phase.flow)) return;
  stopPolling();
  runId = null;
  currentPhase = phase.key;
  clearTimeline();
  setBusy(true);
  setPhaseState(phase.key, 'running', t('running'));
  setNote(t(phase.key));
  const result = await cockpit.workflows.run(phase.flow, collectInputs(phase));
  if (!result || result.ok === false) {
    setBusy(false);
    setPhaseState(phase.key, 'failed', t('failed'));
    setNote(t(REASON_TEXT[result && result.reason ? result.reason : 'failed']));
    return;
  }
  runId = result.runId;
  timer = setInterval(() => void poll(), 700);
  await poll();
}

async function restore() {
  if (!cockpit.storage) return;
  const saved = await cockpit.storage.get('values');
  if (saved && typeof saved === 'object') {
    for (const field of Object.keys(INPUTS)) {
      const value = saved[field];
      if (typeof value === 'string' && INPUTS[field] && INPUTS[field].value.length === 0) {
        INPUTS[field].value = value;
      }
    }
  }
  const recent = await cockpit.storage.get('recent');
  if (recent && typeof recent === 'object') {
    for (const field of Object.keys(SUGGESTIONS)) {
      const values = recent[field];
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === 'string') SUGGESTIONS[field].add(value);
        }
      }
    }
  }
}

async function init() {
  const list = await cockpit.workflows.list();
  if (!Array.isArray(list)) {
    setNote(t(REASON_TEXT[list && list.reason ? list.reason : 'failed']));
    return;
  }
  available = new Set(list.map((flow) => flow.id));
  for (const flow of list) {
    const fields = flow && flow.inputs ? flow.inputs : {};
    for (const field of Object.keys(SUGGESTIONS)) {
      const value = fields[field] && fields[field].default;
      if (typeof value === 'string') SUGGESTIONS[field].add(value);
    }
  }
  for (const phase of PHASES) {
    const button = phaseButtons[phase.key];
    if (button) button.disabled = !available.has(phase.flow);
  }
  const missing = PHASES.filter((phase) => !available.has(phase.flow));
  if (missing.length > 0) {
    setNote(t('missing', { items: missing.map((phase) => t(phase.key)).join(LANG === 'en' ? ', ' : '、') }));
  }
}

document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
document.title = t('title');
document.querySelector('.bd__actions')?.setAttribute(
  'aria-label',
  LANG === 'en' ? 'Build actions' : '构建操作',
);
document.querySelector('.bd__form')?.setAttribute(
  'aria-label',
  LANG === 'en' ? 'Build parameters' : '构建参数',
);
stepsEl?.setAttribute('aria-label', LANG === 'en' ? 'Run stages' : '本次运行的阶段');
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = t(element.getAttribute('data-i18n'));
}
for (const key of ['compile', 'upload', 'run']) {
  const result = resultEls[key];
  if (result) result.textContent = t('pending');
}
chooseButtons.build_dir?.setAttribute('aria-label', t('chooseDirectory'));
chooseButtons.project?.setAttribute('aria-label', t('chooseProject'));
chooseButtons.module?.setAttribute('aria-label', t('chooseModule'));
for (const button of Object.values(chooseButtons)) {
  if (button) button.textContent = t('choose');
}
setState(t('idle'));

for (const phase of PHASES) {
  const button = phaseButtons[phase.key];
  button?.addEventListener('click', () => void start(phase));
}
for (const [field, button] of Object.entries(chooseButtons)) {
  button?.addEventListener('click', (event) => {
    event.stopPropagation();
    renderChoice(field);
  });
  INPUTS[field]?.addEventListener('focus', () => {
    const value = INPUTS[field]?.value.trim();
    if (value) SUGGESTIONS[field].add(value);
  });
}
document.addEventListener('click', () => closeChoices());

await restore();
await init();
