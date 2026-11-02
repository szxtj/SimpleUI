// 视觉门控验证：Maple 下主窗/浮窗的加号应禁用；TTF 下应可用
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9359;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple12', 'about:blank',
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

const plusProbe = `(() => {
  const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null)
    .find(x => /当前模型不支持图片|not supported by the current model/i.test(x.title || ''));
  if (!b) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, disabled: b.disabled, title: b.title.slice(0, 40) });
})()`;

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

  // ---------- Maple：加号应禁用 ----------
  await send('Page.navigate', { url: APP + '/' });
  await sleep(3500);
  console.log('主窗 @Maple 加号:', await ev(plusProbe));
  fs.writeFileSync(`${OUT}/vision-maple-main.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // 浮窗
  await send('Page.navigate', { url: APP + '/#/spotlight' });
  await sleep(3500);
  await ev(`(() => {
    localStorage.setItem('tff_chat_sessions_v1', JSON.stringify([{ id:'s1', title:'t',
      messages:[{id:'m1',role:'user',content:'hi',timestamp:1},{id:'m2',role:'assistant',content:'ok',timestamp:2}],
      createdAt:1, updatedAt:2, contextUsed:0, enableThinking:true }]));
    localStorage.setItem('tff_chat_current_id_v1','s1');
    return true;
  })()`);
  await send('Page.reload');
  await sleep(3000);
  console.log('浮窗 @Maple 加号:', await ev(plusProbe));

  // ---------- 服务端 maxTokens 派生 ----------
  const st = await (await fetch(`${APP}/api/sessions/settings`)).json();
  const s = st.settings;
  console.log('app mapleConfig:', JSON.stringify({
    maxContext: s.mapleConfig?.maxContext, maxTokens: s.mapleConfig?.maxTokens,
    期望maxTokens: Math.floor((s.mapleConfig?.maxContext || 16384) / 2),
  }));
  console.log('扁平 maxTokens（当前 provider maple）:', s.apiPort, s.maxTokens);

  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
