// 极简 CDP 驱动：连上本地 Electron 的渲染进程，评估表达式
const PORT = process.env.CDP_PORT || 9222;

export async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

export async function connect() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('没找到 page target: ' + JSON.stringify(list.map(t => t.type)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    }
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, page };
}
