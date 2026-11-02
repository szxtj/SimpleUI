// 验证 Maple 卡片「未就绪 / 下载中」两个分支的渲染（不真的下完 5.3GB）
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const OUT = '/tmp/maple-shots';
const PORT = 9338;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) => {
  const r = await fetch(APP + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json().catch(() => ({}));
};

const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple-profile2', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
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

async function openPanel() {
  await send('Page.navigate', { url: `${APP}/?panel=services` });
  await sleep(2500);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /设置|Settings/i.test((x.title||'') + (x.getAttribute('aria-label')||'') + x.innerText));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1200);
  await ev(`(() => { const t = document.querySelector('[data-tab-id="svc-model"]'); if (t) t.click(); return true; })()`);
  await sleep(800);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('Maple (20B'));
    if (b) b.click(); return true;
  })()`);
  await sleep(1200);
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
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });

  const emptyDir = '/tmp/maple-empty-check';
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  console.log('set empty dir:', JSON.stringify(await api('/api/model/config', { mapleModelDir: emptyDir })));

  await openPanel();
  const notReady = await ev(`(() => {
    const txt = document.body.innerText;
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
    return JSON.stringify({
      showsDownloadBtn: btns.includes('Download'),
      showsInstallBtn: btns.includes('Install'),
      showsReady: txt.includes('Ready'),
    });
  })()`);
  console.log('not-ready:', notReady);
  await shot('maple-not-ready');

  // 开始下载（几秒后取消），验证「下载中」进度条
  await api('/api/model/maple/download/start', {});
  await sleep(1000);
  await ev('location.reload()');
  await sleep(2500);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /设置|Settings/i.test((x.title||'') + (x.getAttribute('aria-label')||'') + x.innerText));
    if (b) b.click(); return true;
  })()`);
  await sleep(1000);
  await ev(`(() => { const t = document.querySelector('[data-tab-id="svc-model"]'); if (t) t.click(); return true; })()`);
  await sleep(800);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('Maple (20B')); if (b) b.click(); return true; })()`);
  await sleep(2500);
  const downloading = await ev(`(() => {
    const txt = document.body.innerText;
    return JSON.stringify({
      hasPercent: /\\d+%/.test(txt),
      hasCancel: [...document.querySelectorAll('button')].some(b => (b.innerText||'').trim() === 'Cancel'),
      hasProbing: /Probing|Downloading/i.test(txt),
    });
  })()`);
  console.log('downloading:', downloading);
  await shot('maple-downloading');

  await api('/api/model/maple/download/cancel', {});
  await sleep(1200);

  // 还原真实权重目录
  console.log('restore:', JSON.stringify(await api('/api/model/config', { mapleModelDir: '/Volumes/JustinSSD/maple-preview-2bit-mlx' })));
  await sleep(800);
  const restored = await api('/api/model/maple/state');
  console.log('restored model.ready:', restored?.model?.ready);

  ws.close(); proc.kill('SIGKILL');
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await api('/api/model/maple/download/cancel', {}); } catch {}
  try { await api('/api/model/config', { mapleModelDir: '/Volumes/JustinSSD/maple-preview-2bit-mlx' }); } catch {}
  try { ws?.close(); } catch {}
  proc.kill('SIGKILL');
  process.exit(1);
});
