// Maple 思考端到端：主窗 + 浮窗各发一条真实消息，验证思考过程出现在界面（不再被丢弃）
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9353;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple9', 'about:blank',
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
const setInput = (sel, text) => ev(`(() => {
  const el = document.querySelector('${sel}');
  if (!el) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

async function waitForThinking(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await ev(`(() => {
      const box = document.querySelector('.markdown-thinking');
      const txt = document.body.innerText;
      return JSON.stringify({
        thinkingNode: !!box,
        thinkingLen: box ? box.innerText.length : 0,
        thinkingPreview: box ? box.innerText.slice(0, 60) : '',
      });
    })()`);
    const j = JSON.parse(r);
    if (j.thinkingNode && j.thinkingLen > 10) return j;
    await sleep(500);
  }
  return { thinkingNode: false };
}

async function waitForDone(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const generating = await ev(`(() => JSON.stringify({
      stopBtn: [...document.querySelectorAll('button')].some(b => /停止|Stop/i.test(b.innerText||'') && b.offsetParent !== null),
    }))()`);
    if (JSON.parse(generating).stopBtn === false) return true;
    await sleep(1000);
  }
  return false;
}

async function main() {
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });

  // ---------- 主窗 ----------
  await send('Page.navigate', { url: APP + '/' });
  await sleep(3500);
  console.log('主窗输入:', await setInput('[data-chat-input] textarea, textarea', '9.11 和 9.9 哪个大？想清楚再答'));
  await sleep(300);
  console.log('主窗发送:', await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
      .find(b => /发送消息|Send message/i.test(b.title || ''));
    if (!btn) return 'no-send-btn';
    if (btn.disabled) return 'send-disabled';
    btn.click();
    return 'clicked';
  })()`));
  await sleep(1500);
  const t = await waitForThinking(60000);
  console.log('主窗思考:', JSON.stringify(t));
  if (t.thinkingNode) await shot('e2e-main-thinking');

  // 主窗思考按钮锁定态
  const lockState = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /始终开启思考|always thinks/i.test(x.title || ''));
    return JSON.stringify({ lockedFound: !!b, ariaDisabled: b ? b.getAttribute('aria-disabled') : null,
      label: b ? b.innerText.trim() : null });
  })()`);
  console.log('主窗思考按钮:', lockState);

  await waitForDone(180000);
  await sleep(1500);
  let serverProof = 'unavailable';
  try {
    const st = await (await fetch(`${APP}/api/sessions/state`)).json();
    const sessions = st.sessions || st || [];
    const arr = Array.isArray(sessions) ? sessions : Object.values(sessions);
    const withMsgs = arr.find(x => (x.messages || []).some(m => m.role === 'assistant' && (m.reasoningContent || '').length > 0));
    const asst = withMsgs ? [...withMsgs.messages].reverse().find(m => m.role === 'assistant' && (m.reasoningContent || '').length > 0) : null;
    serverProof = `reasoning=${(asst?.reasoningContent || '').length} 字 content=${(asst?.content || '').length} 字`;
  } catch {}
  console.log('主窗服务端证据:', serverProof);
  await shot('e2e-main-done');

  // ---------- 浮窗 ----------
  await send('Page.navigate', { url: APP + '/#/spotlight' });
  await sleep(3500);
  await ev(`(() => {
    localStorage.setItem('tff_chat_sessions_v1', JSON.stringify([{ id:'sess-maple-e2e', title:'验证',
      messages:[{id:'m1',role:'user',content:'你好',timestamp:1},{id:'m2',role:'assistant',content:'你好！',timestamp:2}],
      createdAt:1, updatedAt:2, contextUsed:0, enableThinking:true }]));
    localStorage.setItem('tff_chat_current_id_v1','sess-maple-e2e');
    return true;
  })()`);
  await send('Page.reload');
  await sleep(3000);
  await ev(`(() => { window.loadSessionInSpotlight && window.loadSessionInSpotlight('sess-maple-e2e'); return true; })()`);
  await sleep(800);
  console.log('浮窗输入:', await setInput('textarea', '1+1 等于几？'));
  await sleep(300);
  console.log('浮窗发送:', await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
      .find(b => /发送消息|Send message/i.test(b.title || ''));
    if (!btn) return 'no-send-btn';
    if (btn.disabled) return 'send-disabled';
    btn.click();
    return 'clicked';
  })()`));
  await sleep(1500);
  const t2 = await waitForThinking(60000);
  console.log('浮窗思考:', JSON.stringify(t2));
  if (t2.thinkingNode) await shot('e2e-spot-thinking');

  const lock2 = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /始终开启思考|always thinks/i.test(x.title || ''));
    return JSON.stringify({ lockedFound: !!b, ariaDisabled: b ? b.getAttribute('aria-disabled') : null,
      label: b ? b.innerText.trim() : null });
  })()`);
  console.log('浮窗思考按钮:', lock2);

  await waitForDone(180000);
  await sleep(1000);
  await shot('e2e-spot-done');

  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
