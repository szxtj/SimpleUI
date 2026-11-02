// 两套配置独立性 + Chat Model 表单正确性（只操作可见元素）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const APP = 'http://127.0.0.1:31235';
const CFG = process.env.HOME + '/Library/Application Support/SimpleUI/model_config.json';
const PORT = 9351;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
const settingsJson = async () => {
  const j = await (await fetch(`${APP}/api/sessions/settings`)).json();
  const s = j.settings;
  return JSON.stringify({
    provider: s.apiProvider,
    activePort: s.apiPort,
    activeModel: s.modelId,
    ttf: [s.ttfConfig?.apiPort, s.ttfConfig?.modelId],
    maple: [s.mapleConfig?.apiPort, s.mapleConfig?.modelId, s.mapleConfig?.maxTokens],
  });
};

const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--in-process-gpu', '--user-data-dir=/tmp/edge-maple8', 'about:blank',
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

// 只点「可见」的按钮：两块面板同时在 DOM 里（一块 hidden），必须排除 offsetParent === null
const clickVisible = (text) => ev(`(() => {
  const b = [...document.querySelectorAll('button')]
    .filter(x => x.offsetParent !== null && (x.innerText || '').includes(${JSON.stringify(text)}));
  if (!b.length) return 'not-visible';
  b[0].click();
  return 'clicked:' + b[0].innerText.trim().replace(/\\s+/g, ' ');
})()`);

const readChatForm = () => ev(`(() => {
  const panel = [...document.querySelectorAll('div')].find(d => d.offsetParent !== null && /API Provider/i.test(d.innerText || '') && d.querySelector('input'));
  const scope = panel || document.body;
  const nums = [...scope.querySelectorAll('input[type=number]')].map(i => i.value);
  const texts = [...scope.querySelectorAll('input[type=text]')].map(i => i.value).filter(Boolean);
  const active = [...scope.querySelectorAll('button')]
    .filter(b => /TTF \\(Gemma|Mference \\(Qwen|Maple \\(20B|Custom \\(OpenAI|DeepSeek Official/.test(b.innerText || ''))
    .map(b => ({ label: b.innerText.trim().replace(/\\s+/g, ' '), cls: b.className.includes('border-amber') || b.className.includes('border-emerald') }));
  return JSON.stringify({ nums, texts: texts.slice(0, 4), active });
})()`);

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

  await send('Page.navigate', { url: `${APP}/?panel=settings` });
  await sleep(3500);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].filter(x=>x.offsetParent!==null).find(x=>/设置|Settings/i.test((x.title||'')+(x.getAttribute('aria-label')||'')+x.innerText)); if(b)b.click(); return true; })()`);
  await sleep(1200);
  await ev(`(() => { const t=document.querySelector('[data-tab-id="chat-models"]'); if(t)t.click(); return true; })()`);
  await sleep(1500);

  console.log('A. 打开 Chat Model 表单:', await readChatForm());

  // ---- 1) 切到 TTF 并保存：不得动服务配置 ----
  const cfgBefore = sha(CFG);
  console.log('   点击 TTF:', await clickVisible('TTF (Gemma 4)'));
  await sleep(600);
  console.log('   切换后表单:', await readChatForm());
  console.log('   保存:', await clickVisible('Save Settings'));
  await sleep(2500);
  const cfgAfter = sha(CFG);
  const s1 = JSON.parse(await settingsJson());
  console.log(`   model_config.json ${cfgBefore}→${cfgAfter}`, cfgBefore === cfgAfter ? '✅ 未被服务面板/App 互写' : '❌ 被改');
  console.log('   app 设置 provider=' + s1.provider, '| ttf=' + s1.ttf.join('/'));
  console.log('   TTF 端口模型是否被污染:', s1.ttf[0] === 1235 && s1.ttf[1].includes('gemma') ? '✅ 干净' : '❌ ' + s1.ttf);

  // ---- 2) 服务面板 Save & apply：不得动 app 设置 ----
  const s2Before = await settingsJson();
  await ev(`(() => { const t=document.querySelector('[data-tab-id="svc-model"]'); if(t)t.click(); return true; })()`);
  await sleep(1200);
  console.log('   服务面板选 Maple:', await clickVisible('Maple (20B'));
  await sleep(900);
  console.log('   服务面板保存:', await clickVisible('Save & apply'));
  await sleep(4500);
  const s2After = await settingsJson();
  console.log('   app 设置:', s2Before === s2After ? '✅ 未被触碰' : '❌ 被改\n     ' + s2Before + '\n     ' + s2After);

  // ---- 3) 切回 Maple 并保存 ----
  await ev(`(() => { const t=document.querySelector('[data-tab-id="chat-models"]'); if(t)t.click(); return true; })()`);
  await sleep(1000);
  console.log('   点击 Maple:', await clickVisible('Maple (20B-A1B)'));
  await sleep(600);
  console.log('   表单:', await readChatForm());
  console.log('   保存:', await clickVisible('Save Settings'));
  await sleep(2500);
  const s3 = JSON.parse(await settingsJson());
  console.log('B. 还原后 provider =', s3.provider, s3.provider === 'maple' ? '✅' : '❌',
    '| active=', s3.activePort + '/' + s3.activeModel);

  ws.close(); proc.kill('SIGKILL');
}

main().catch((e) => { console.error('FAILED:', e.message); try { ws?.close(); } catch {} proc.kill('SIGKILL'); process.exit(1); });
