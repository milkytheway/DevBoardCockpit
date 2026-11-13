/**
 * 第一张卡：CPU 占用。
 *
 * ── 显示规则**照抄契约 §2.1 的六行表**（别自己简化）──
 *
 * | 状态 | 显示 |
 * |---|---|
 * | `ok` | 数值 |
 * | `stale` | **旧值** + 「已过时」 |
 * | `error`（有旧值） | **旧值** + 「读取失败（显示的是上一次的值）」 |
 * | `error`（无旧值） | 「读取失败」 |
 * | `unavailable` | **不显示数值** + 「不可用 · 缺 <tag>」 |
 * | `pending` | 「等待第一次采样」 |
 *
 * ── 为什么用宿主给的类名 ──
 *
 * `.cockpit-value` / `.cockpit-unavailable` 这些类是**宿主注入的基础样式**，
 * 它们只写 `var(--cockpit-*)`——所以卡片**不可能把状态画错**，
 * 而且换皮肤时这张卡**不用改一行**。
 */

const valueEl = document.getElementById('value');
const noteEl = document.getElementById('note');
const ageEl = document.getElementById('age');

/** 最近一次读数（用来算年龄） */
let last = null;

/** 把毫差变成「几秒前」 */
function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 1) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  return Math.round(seconds / 60) + ' 分钟前';
}

function render(reading) {
  last = reading;
  switch (reading.status) {
    case 'ok':
      valueEl.className = 'cockpit-value';
      valueEl.textContent = String(reading.value);
      noteEl.textContent = '';
      break;
    case 'stale':
      // **保留旧值**，但标出它不新
      valueEl.className = 'cockpit-value cockpit-value--stale';
      valueEl.textContent = String(reading.value);
      noteEl.textContent = '已过时';
      break;
    case 'error':
      valueEl.className = 'cockpit-value cockpit-value--error';
      valueEl.textContent = reading.value === null ? '' : String(reading.value);
      noteEl.textContent =
        reading.value === null ? '读取失败' : '读取失败（显示的是上一次的值）';
      break;
    case 'unavailable':
      // **不显示数值** —— 「读不到」与「真的是 0」必须分得开
      valueEl.className = 'cockpit-unavailable';
      valueEl.textContent = '';
      noteEl.textContent = '不可用 · 缺 ' + reading.tag;
      break;
    default:
      valueEl.className = 'cockpit-pending';
      valueEl.textContent = '';
      noteEl.textContent = '等待第一次采样';
      break;
  }
  ageEl.textContent = last === null ? '' : ago(last.at);
}

cockpit.tags.subscribe('cpu.usage', render);

// **年龄自己走**：读数不是每秒都推的，但「这个数有多旧」应该每秒都在变
setInterval(() => {
  if (last !== null) ageEl.textContent = ago(last.at);
}, 1000);
