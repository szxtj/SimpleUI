// 验证：面板显示 SSD 上的权重为 Ready；点「Save & apply」后路径不被改回默认
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9343;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple4', 'about:blank',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 2, mobile: false });

  await send('Page.navigate', { url: `${APP}/?panel=services` });
  await sleep(3500);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /设置|Settings/i.test((x.title||'') + (x.getAttribute('aria-label')||'') + x.innerText));
    if (b) b.click(); return true;
  })()`);
  await sleep(1300);
  await ev(`(() => { const t = document.querySelector('[data-tab-id="svc-model"]'); if (t) t.click(); return true; })()`);
  await sleep(1200);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('Maple (20B')); if (b) b.click(); return true; })()`);
  await sleep(1500);

  const before = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input[type=text]')].map(i => i.value);
    const txt = document.body.innerText;
    return JSON.stringify({
      dirInputs: inputs.filter(v => v.includes('maple') || v.includes('SSD')),
      weightsReady: /Ready/.test(txt),
      showsDownload: [...document.querySelectorAll('button')].some(b => (b.innerText||'').trim() === 'Download'),
    });
  })()`);
  console.log('before save:', before);
  fs.writeFileSync(`${OUT}/maple-weights-fixed.png`,
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // 点 Save & apply（不动任何字段），确认路径不被改回默认
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Save & apply|保存并应用/i.test(x.innerText || ''));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(4000);

  const cfg = await (await fetch(`${APP}/api/model/config`)).json();
  console.log('after save mapleModelDir =', cfg.mapleModelDir);
  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
