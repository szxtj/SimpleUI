// Maple 模式三张截图：服务管理(基础模型) / 应用设置(对话模型) / 主界面
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9341;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple3', 'about:blank',
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
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot:', n);
};

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

  await send('Page.navigate', { url: APP + '/' });
  await sleep(4000);

  // ---- A. 主界面（未开设置，看输入区思考胶囊）----
  // 锁定的胶囊 title 是 thinkingLockedMaple 文案，用它精确定位（避免命中消息里的 Thinking 标签）
  const pickThink = `(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.find(b => /始终开启思考|always thinks/i.test(b.title || '')) || null;
  })()`;

  const mainInfo = await ev(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const locked = btns.find(b => /始终开启思考|always thinks/i.test(b.title || ''));
    return JSON.stringify({
      lockedFound: !!locked,
      label: locked ? locked.innerText.trim().replace(/\\s+/g, ' ') : null,
      ariaDisabled: locked ? locked.getAttribute('aria-disabled') : null,
      hasTextarea: !!document.querySelector('textarea'),
      bodyLen: document.body.innerText.length,
    });
  })()`);
  console.log('main:', mainInfo);
  await shot('main-maple');

  const before = await ev(`${pickThink} && ${pickThink}.innerText.trim()`);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /始终开启思考|always thinks/i.test(x.title || '')); if (b) b.click(); return true; })()`);
  await sleep(700);
  const after = await ev(`${pickThink} && ${pickThink}.innerText.trim()`);
  console.log('click test: before=', JSON.stringify(before), 'after=', JSON.stringify(after), '| unchanged:', before === after);

  // ---- B. 设置 → 服务管理 → 基础模型 ----
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /设置|Settings/i.test((x.title||'') + (x.getAttribute('aria-label')||'') + x.innerText));
    if (b) b.click(); return true;
  })()`);
  await sleep(1400);
  await ev(`(() => { const t = document.querySelector('[data-tab-id="svc-model"]'); if (t) t.click(); return true; })()`);
  await sleep(1400);
  await shot('settings-service-maple');

  // ---- C. 设置 → 应用设置 → 对话模型 ----
  await ev(`(() => { const t = document.querySelector('[data-tab-id="chat-models"]'); if (t) t.click(); return true; })()`);
  await sleep(1600);
  const chatInfo = await ev(`(() => {
    const txt = document.body.innerText;
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
    return JSON.stringify({
      hasMapleProvider: btns.some(t => t.includes('Maple (20B-A1B)')),
      hasPort1242: txt.includes('1242'),
      hasLockNote: /始终开启思考|always thinks/i.test(txt),
    });
  })()`);
  console.log('chat-models:', chatInfo);
  await shot('settings-chat-maple');

  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
