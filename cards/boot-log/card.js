/**
 * Read the complete persistent boot log through the serial connection and
 * present it in a selectable dialog.
 */

const runEl = document.getElementById('run');
const refreshEl = document.getElementById('refresh');
const closeEl = document.getElementById('close');
const noteEl = document.getElementById('note');
const dialogEl = document.getElementById('log-dialog');
const outputEl = document.getElementById('log-output');
const metaEl = document.getElementById('meta');
const pathEl = document.getElementById('host-path');
const searchEl = document.getElementById('search');
const selectAllEl = document.getElementById('select-all');
const copyEl = document.getElementById('copy');

const LANG =
  new window.URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh';
const TEXT = {
  zh: {
    title: '启动日志',
    refresh: '重新获取',
    getLog: '获取启动日志',
    openLog: '打开日志',
    reading: '读取中…',
    readingWithTime: '正在读取 · {seconds}s',
    saved: '已保存',
    lastSaved: '上次保存',
    ready: '就绪',
    noLog: '暂无日志',
    noMatch: '没有匹配项',
    filter: '筛选日志',
    selectAll: '全选',
    copy: '复制',
    copied: '已复制',
    selected: '已选中',
    logContent: '启动日志内容',
    close: '关闭',
    denied: '未授权',
    serialBusy: '串口已被占用',
    serialNotConfigured: '未配置串口',
    boardNotConnected: '开发板未连接',
    busy: '正在获取',
    failed: '获取失败',
  },
  en: {
    title: 'Boot log',
    refresh: 'Read again',
    getLog: 'Get boot log',
    openLog: 'Open log',
    reading: 'Reading…',
    readingWithTime: 'Reading · {seconds}s',
    saved: 'Saved',
    lastSaved: 'Last saved',
    ready: 'Ready',
    noLog: 'No log yet',
    noMatch: 'No matches',
    filter: 'Filter log',
    selectAll: 'Select all',
    copy: 'Copy',
    copied: 'Copied',
    selected: 'Selected',
    logContent: 'Boot log contents',
    close: 'Close',
    denied: 'Not authorized',
    serialBusy: 'Serial port is in use',
    serialNotConfigured: 'Serial port not configured',
    boardNotConnected: 'Board not connected',
    busy: 'Reading',
    failed: 'Read failed',
  },
};

function t(key, values) {
  const text = TEXT[LANG][key] ?? TEXT.zh[key] ?? key;
  return values
    ? text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match))
    : text;
}

function reasonText(reason) {
  const key = {
    denied: 'denied',
    serial_busy: 'serialBusy',
    serial_not_configured: 'serialNotConfigured',
    board_not_connected: 'boardNotConnected',
    boot_log_busy: 'busy',
  }[reason];
  return t(key ?? 'failed');
}

let fullText = '';
let elapsedTimer = null;
let opener = null;
let copyTimer = null;

function setNote(text) {
  if (noteEl) noteEl.textContent = text;
}

function setRunning(running) {
  if (runEl) {
    runEl.disabled = running;
    runEl.textContent = running ? t('reading') : fullText ? t('openLog') : t('getLog');
  }
  if (refreshEl) refreshEl.disabled = running;
}

function stopElapsed() {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function applyFilter() {
  if (!outputEl) return;
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
  if (query.length === 0) {
    outputEl.textContent = fullText || t('noLog');
    return;
  }
  const lines = fullText.split(/\r?\n/).filter((line) => line.toLowerCase().includes(query));
  outputEl.textContent = lines.length > 0 ? lines.join('\n') : t('noMatch');
}

function showLog(result) {
  fullText = result.text;
  applyFilter();
  if (metaEl) {
    const amount = result.text.length === 0 ? 0 : result.text.split(/\r?\n/).length;
    const seconds = Math.max(1, Math.round((result.durationMs ?? 0) / 1000));
    metaEl.textContent =
      LANG === 'en' ? `${amount} lines · ${seconds}s` : `${amount} 行 · ${seconds}s`;
  }
  // → **The path of the host is not given to the card** ✓ (the contract says
  //   a card does not get the paths of the host ✓) → the card shows **when**
  //   it was captured ✓ instead ✓.
  if (pathEl) {
    pathEl.textContent = result.capturedAt ?? '';
    pathEl.title = result.capturedAt ?? '';
  }
  if (refreshEl) refreshEl.hidden = false;
  setRunning(false);
}

function openDialog() {
  if (!dialogEl || fullText.length === 0) return;
  opener = document.activeElement;
  dialogEl.hidden = false;
  closeEl?.focus();
}

function closeDialog() {
  if (!dialogEl) return;
  dialogEl.hidden = true;
  if (opener && typeof opener.focus === 'function') opener.focus();
}

function setCopyFeedback(text) {
  if (!copyEl) return;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyEl.textContent = text;
  copyTimer = setTimeout(() => {
    copyEl.textContent = t('copy');
    copyTimer = null;
  }, 1400);
}

function selectAll() {
  if (!outputEl) return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(outputEl);
  selection?.removeAllRanges();
  selection?.addRange(range);
  outputEl.focus();
}

async function capture() {
  if (runEl && runEl.disabled) return;
  const startedAt = Date.now();
  setRunning(true);
  setNote(t('reading'));
  stopElapsed();
  elapsedTimer = setInterval(() => {
    setNote(t('readingWithTime', { seconds: Math.floor((Date.now() - startedAt) / 1000) }));
  }, 500);

  const result = await cockpit.bootLog.capture();
  stopElapsed();
  if (!result || result.ok === false) {
    setRunning(false);
    setNote(reasonText(result && result.reason ? result.reason : 'boot_log_failed'));
    return;
  }
  showLog(result);
  setNote(t('saved'));
  openDialog();
}

async function restore() {
  const latest = await cockpit.bootLog.latest();
  if (!latest) return;
  if (latest.ok === false) {
    setNote(reasonText(latest.reason));
    return;
  }
  showLog(latest);
  setNote(t('lastSaved'));
}

document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
document.title = t('title');
document.getElementById('log-title').textContent = t('title');
document.getElementById('log-dialog-title').textContent = t('title');
document.getElementById('note').textContent = t('ready');
document.getElementById('log-output').textContent = t('noLog');
if (refreshEl) {
  refreshEl.setAttribute('aria-label', t('refresh'));
  refreshEl.title = t('refresh');
}
if (searchEl) {
  searchEl.placeholder = t('filter');
  searchEl.setAttribute('aria-label', t('filter'));
}
if (selectAllEl) selectAllEl.textContent = t('selectAll');
if (copyEl) copyEl.textContent = t('copy');
if (outputEl) outputEl.setAttribute('aria-label', t('logContent'));
if (closeEl) {
  closeEl.setAttribute('aria-label', t('close'));
  closeEl.title = t('close');
}
setRunning(false);

if (runEl) {
  runEl.addEventListener('click', () => {
    if (fullText.length > 0) openDialog();
    else void capture();
  });
}
if (refreshEl) refreshEl.addEventListener('click', () => void capture());
if (closeEl) closeEl.addEventListener('click', closeDialog);
if (dialogEl) {
  dialogEl.addEventListener('mousedown', (event) => {
    if (event.target === dialogEl) closeDialog();
  });
}
if (searchEl) searchEl.addEventListener('input', applyFilter);
if (selectAllEl) selectAllEl.addEventListener('click', selectAll);
if (copyEl) {
  copyEl.addEventListener('click', () => {
    selectAll();
    const clipboard = window.navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyFeedback(t('selected'));
      return;
    }
    void clipboard.writeText(fullText).then(
      () => setCopyFeedback(t('copied')),
      () => setCopyFeedback(t('selected')),
    );
  });
}
document.addEventListener('keydown', (event) => {
  if (!dialogEl || dialogEl.hidden) return;
  if (event.key === 'Escape') {
    closeDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [
    ...dialogEl.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});

void restore();
