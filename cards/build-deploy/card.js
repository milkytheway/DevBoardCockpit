/**
 * 编译上板：选一条流程 → 填输入 → 跑 → 看每一步。
 *
 * ── 它只做一件事 ──
 *
 * → **触发宿主已声明的流程** ✓（契约 `spec/03` §7.7 的三行 ✓）
 * → **自己不执行任何命令** ✓ —— 那是流程层的事 ✓
 * → **看不到哪台机器** ✓ —— 角色是拓扑 ✓，不给卡片 ✓（契约 §七 ✓）。
 *
 * ── 三条规矩 ──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **只列用户批过的流程** ✓ | 没批过的包**卡片看不见** ✓（宿主那一层就滤掉了 ✓） |
 * | 2 | **输入只认流程声明的那些** ✓ | 不自己发明参数 ✓ |
 * | 3 | **每一步都说得出「跑过没有 / 验过没有」** ✓ | 「跑过」≠「成了」 ✓（契约 §2.4 的 `verified` ✓） |
 */

const flowEl = document.getElementById('flow');
const inputsEl = document.getElementById('inputs');
const stepsEl = document.getElementById('steps');
const runEl = document.getElementById('run');
const noteEl = document.getElementById('note');

/** 宿主给的流程清单 */
let flows = [];
/** 当前选中的流程 */
let current = null;
/** 当前这次运行的 id */
let runId = null;
/** 轮询的定时器 */
let timer = null;

/** 运行状态 → 人话（**封闭的那几档** ✓） */
const STATE_TEXT = {
  running: '在跑',
  awaiting_confirmation: '等人确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 结束态（**到了就不轮询了** ✓） */
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

/** 失败的理由码 → 人话（**卡片看到的是码** ✓ —— 宿主不泄原话 ✓） */
const REASON_TEXT = {
  denied: '这张卡没有被授权跑这个流程',
  not_found: '宿主里没有这个流程包',
  not_approved: '这个流程包还没被人批准',
  invalid_params: '输入不合法',
  busy: '同一条流程正在跑',
  failed: '出了别的事（细节看宿主的运行日志）',
  not_connected: '还没连上宿主',
};

function reasonText(reason) {
  return REASON_TEXT[reason] ?? `出了别的事（${reason}）`;
}

/** 流程的输入声明 → 表单 */
function renderInputs() {
  if (!inputsEl) return;
  inputsEl.textContent = '';
  const declared = current && current.inputs ? current.inputs : {};
  const names = Object.keys(declared);
  if (names.length === 0) {
    const p = document.createElement('p');
    p.className = 'deck__none';
    p.textContent = '这条流程没有输入';
    inputsEl.appendChild(p);
    return;
  }
  for (const name of names) {
    const def = declared[name] ?? {};
    const row = document.createElement('label');
    row.className = 'deck__field';

    const caption = document.createElement('span');
    caption.className = 'deck__caption';
    caption.textContent = def.required === true ? `${name} *` : name;
    if (typeof def.description === 'string' && def.description.length > 0) {
      caption.title = def.description;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'deck__input';
    input.dataset.name = name;
    input.placeholder = def.type === 'path' ? '路径' : '值';
    if (def.default !== undefined && def.default !== null) input.value = String(def.default);

    row.appendChild(caption);
    row.appendChild(input);
    inputsEl.appendChild(row);
  }
}

/** 收集输入（**只认声明过的那些** ✓） */
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

/** 必填的输入填了吗 */
function missingRequired() {
  const declared = current && current.inputs ? current.inputs : {};
  const values = collectInputs();
  const missing = [];
  for (const [name, def] of Object.entries(declared)) {
    if (def.required !== true) continue;
    const value = values[name];
    if (value === undefined || String(value).trim().length === 0) missing.push(name);
  }
  return missing;
}

/** 一次运行的状态 → 时间线 */
function renderSteps(status) {
  if (!stepsEl) return;
  stepsEl.textContent = '';
  const stages = Array.isArray(status.stages) ? status.stages : [];
  if (stages.length === 0) {
    const li = document.createElement('li');
    li.className = 'deck__step deck__step--wait';
    li.textContent = '还没开始';
    stepsEl.appendChild(li);
    return;
  }
  for (const stage of stages) {
    const li = document.createElement('li');
    const ok = stage.ok === true;
    const verified = stage.verified === true;
    let tone = 'wait';
    let mark = '·';
    if (!ok) {
      tone = 'bad';
      mark = '✕';
    } else if (verified) {
      tone = 'ok';
      mark = '✓';
    } else {
      // **跑过了但没验过** ✓ —— **它与「成了」不是一件事** ✓
      tone = 'warn';
      mark = '○';
    }
    li.className = `deck__step deck__step--${tone}`;
    const name = document.createElement('span');
    name.className = 'deck__step-name';
    name.textContent = `${mark} ${stage.stepId}`;
    const kind = document.createElement('span');
    kind.className = 'deck__step-kind';
    kind.textContent = stage.kind ?? '';
    li.appendChild(name);
    li.appendChild(kind);
    if (!ok && typeof stage.reason === 'string') {
      const why = document.createElement('span');
      why.className = 'deck__step-why';
      why.textContent = reasonText(stage.reason);
      li.appendChild(why);
    }
    stepsEl.appendChild(li);
  }
}

/** 轮询一次 */
async function tick() {
  if (runId === null) return;
  const res = await cockpit.workflows.status(runId);
  if (!res || res.ok === false) {
    setNote(reasonText(res && res.reason ? res.reason : 'failed'));
    stop();
    return;
  }
  renderSteps(res);
  const state = res.state ?? 'running';
  if (TERMINAL.has(state)) {
    stop();
    setNote(
      state === 'done'
        ? '跑完了 ✓'
        : state === 'cancelled'
          ? '已取消'
          : '失败了（看上面那一步）',
    );
    return;
  }
  const currentStep = res.current ? res.current.stepId : '';
  setNote(`${STATE_TEXT[state] ?? state}${currentStep ? ` · ${currentStep}` : ''}`);
}

/** 停轮询 */
function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (runEl) runEl.disabled = false;
}

/** 跑一次 */
async function run() {
  if (current === null) {
    setNote('先选一条流程');
    return;
  }
  const missing = missingRequired();
  if (missing.length > 0) {
    setNote(`这些必填的还没填：${missing.join('、')}`);
    return;
  }
  if (runEl) runEl.disabled = true;
  setNote('正在起…');
  const res = await cockpit.workflows.run(current.id, collectInputs());
  if (!res || res.ok === false) {
    setNote(reasonText(res && res.reason ? res.reason : 'failed'));
    if (runEl) runEl.disabled = false;
    return;
  }
  runId = res.runId;
  stop();
  timer = setInterval(() => {
    void tick();
  }, 700);
  await tick();
}

/** 读流程清单 */
async function loadFlows() {
  const list = await cockpit.workflows.list();
  if (!Array.isArray(list)) {
    setNote(reasonText(list && list.reason ? list.reason : 'failed'));
    return;
  }
  flows = list;
  if (!flowEl) return;
  flowEl.textContent = '';
  if (flows.length === 0) {
    // **没批过的包卡片看不见** ✓ —— **明说** ✓（不装成「没有流程」 ✗）
    setNote('没有可跑的流程（流程包要先被人批准）');
    renderInputs();
    if (runEl) runEl.disabled = true;
    return;
  }
  for (const flow of flows) {
    const option = document.createElement('option');
    option.value = flow.id;
    option.textContent = flow.name ?? flow.id;
    flowEl.appendChild(option);
  }
  current = flows[0];
  renderInputs();
  setNote(`${flows.length} 条流程可选`);
}

if (flowEl) {
  flowEl.addEventListener('change', () => {
    current = flows.find((f) => f.id === flowEl.value) ?? null;
    renderInputs();
    setNote(current ? current.name ?? current.id : '先选一条流程');
  });
}
if (runEl) runEl.addEventListener('click', () => void run());

void loadFlows();
