// 浮窗端到端：发送一条真实消息 → 思考条出现 → 服务端留存 reasoningContent
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9357;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple11', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (n) => {
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('shot:', n);
};

// 等主窗空闲（避免共享生成状态）
async function waitIdle() {
  for (let i = 0; i < 240; i++) {
    try {
      const st = await (await fetch(`${APP}/api/sessions/state`)).json();
      const arr = Array.isArray(st) ? st : st.sessions || Object.values(st);
      const busy = arr.some(x => (x.messages || []).some(m => m.pending));
      if (!busy) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log('等待其它回合结束:', await waitIdle());

  let list = [];
  for (let i = 0; i < 40; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {}
    await sleep(300);
  }
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 640, deviceScaleFactor: 2, mobile: false });

  await send('Page.navigate', { url: APP + '/#/spotlight' });
  await sleep(3500);
  await ev(`(() => {
    localStorage.setItem('tff_chat_sessions_v1', JSON.stringify([{ id:'sess-spot-e2e', title:'验证',
      messages:[{id:'m1',role:'user',content:'你好',timestamp:1},{id:'m2',role:'assistant',content:'你好！',timestamp:2}],
      createdAt:1, updatedAt:2, contextUsed:0, enableThinking:true }]));
    localStorage.setItem('tff_chat_current_id_v1','sess-spot-e2e');
    localStorage.setItem('tff_chat_settings_v1', JSON.stringify({ apiProvider:'maple', language:'zh' }));
    return true;
  })()`);
  await send('Page.reload');
  await sleep(3500);
  await ev(`(() => { window.loadSessionInSpotlight && window.loadSessionInSpotlight('sess-spot-e2e'); return true; })()`);
  await sleep(800);

  const sendState = await ev(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '9.11 和 9.9 哪个大？');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  console.log('浮窗输入:', sendState);
  await sleep(400);
  console.log('浮窗发送:', await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
      .find(b => /发送消息|Send message/i.test(b.title || '') || /Send \\(Enter\\)/i.test(b.title || ''));
    if (!btn) return 'no-send-btn';
    if (btn.disabled) return 'send-disabled';
    btn.click();
    return 'clicked';
  })()`));
  await sleep(1200);

  // 等思考条出现
  let thinking = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const r = await ev(`(() => {
      const box = document.querySelector('.markdown-thinking');
      return JSON.stringify({ has: !!box, len: box ? box.innerText.length : 0 });
    })()`);
    const j = JSON.parse(r);
    if (j.has && j.len > 10) { thinking = j; break; }
    await sleep(500);
  }
  console.log('浮窗思考:', JSON.stringify(thinking || { has: false }));
  if (thinking) await shot('e2e-spot-thinking');

  // 等完成
  const t1 = Date.now();
  while (Date.now() - t1 < 240000) {
    const st = await (await fetch(`${APP}/api/sessions/state`)).json();
    const arr = Array.isArray(st) ? st : st.sessions || Object.values(st);
    const busy = arr.some(x => (x.messages || []).some(m => m.pending));
    if (!busy) break;
    await sleep(1500);
  }
  await sleep(1200);

  // 服务端证据
  const st = await (await fetch(`${APP}/api/sessions/state`)).json();
  const arr = Array.isArray(st) ? st : st.sessions || Object.values(st);
  const sess = arr.find(x => x.id === 'sess-spot-e2e') || arr[0];
  const asst = sess ? [...(sess.messages || [])].reverse().find(m => m.role === 'assistant') : null;
  console.log('浮窗服务端证据: reasoning =', (asst?.reasoningContent || '').length, '字 | content =', (asst?.content || '').length, '字');
  await shot('e2e-spot-done');

  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
