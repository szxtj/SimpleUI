// 3D 双模型接入的无头自测：3D 窗口两种模型态（code / idol）+ 设置页模型选择卡片。
// 依赖：系统 Edge + CDP（不装 Playwright）；要求 /Applications/SimpleUI.app 正在运行。
// 用法：node scripts/verify_scene3d_models.mjs
import { spawn } from 'child_process';
import fs from 'fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9333;
const BASE = 'http://127.0.0.1:31235';
const OUT = '/tmp/verify_scene3d';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--in-process-gpu',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/edge-scene3d-profile`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
  });
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ ${expr} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.text || '') + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(`  📸 ${OUT}/${name}.png`);
}

async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(2500);
}

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

try {
  // 等调试端口
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('Edge 调试端口未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 860, deviceScaleFactor: 2, mobile: false,
  });

  // ---- 1. 3D 窗口：代码模型态 ----
  console.log('\n[1] 3D 窗口 · code 模型');
  await goto(`${BASE}/#/scene3d`);
  // 语言统一成中文，方便断言文案
  await ev(`localStorage.setItem('tff_chat_settings_v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('tff_chat_settings_v1')||'{}'),{language:'zh'}))); return 1;`);
  await goto(`${BASE}/#/scene3d`);

  const codeText = await ev(`return document.body.innerText;`);
  check('页面存活（有文本）', (codeText || '').length > 50, `${(codeText || '').length} chars`);

  // 开窗不加载：两个运行时都必须是 false（"发送之后再加载"的契约）
  const rt = await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(j=>j.runtimes||{});`);
  check('开窗后没有任何运行时在跑', !rt.code && !rt.idol, JSON.stringify(rt));

  // 旧的「开窗即拉起」暗门已删除
  const ensureCode = await ev(`
    return fetch('/api/scene3d/ensure', {method:'POST'}).then(r=>r.status).catch(()=>-1);
  `);
  check('/ensure 已下线（404）', ensureCode === 404, `status=${ensureCode}`);
  check('空状态是「一句话生成」(code 模型)', /一句话生成可交互的 3D 场景|Create interactive 3D scenes/.test(codeText || ''));
  await shot('01_scene3d_code');

  // ---- 2. 切到 idol：走设置接口（等价于设置页保存）----
  console.log('\n[2] 切到 idol 模型（POST /api/scene3d/config）');
  const saved = await ev(`
    return fetch('/api/scene3d/config', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({modelKey:'idol'})}).then(r=>r.json());
  `);
  check('config 接口保存成功', saved?.ok === true && saved?.config?.modelKey === 'idol', JSON.stringify(saved?.config));
  await goto(`${BASE}/#/scene3d`);
  const idolText = await ev(`return document.body.innerText;`);
  check('空状态换成「一张照片」(idol 模型)', /一张照片，生成 3D 模型|One photo becomes a 3D model/.test(idolText || ''));
  const ph = await ev(`const ta=document.querySelector('textarea'); return ta?ta.getAttribute('placeholder'):null;`);
  check('输入框提示要求附图', /需要一张图片|needs an image/.test(String(ph)), String(ph));
  const sendDisabled = await ev(`
    const ta = document.querySelector('textarea');
    const wrap = ta.closest('div.relative');
    const btns = [...wrap.querySelectorAll('button')];
    const b = btns[btns.length-1];
    return b ? b.disabled : null;
  `);
  check('无图时发送按钮禁用', sendDisabled === true, `disabled=${sendDisabled}`);
  await shot('02_scene3d_idol');

  // 还原成 code，好让设置页的「未保存草稿」测试有对照组
  await ev(`return fetch('/api/scene3d/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelKey:'code'})}).then(r=>r.json());`);

  // ---- 3. 设置页卡片 ----
  console.log('\n[3] 设置 → 3D 场景构建');
  await goto(`${BASE}/`);
  // 等首帧状态到位再点设置，否则卡片还没拿到 status 就断言（会偶发 22/23）
  await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(()=>1).catch(()=>0);`);
  await sleep(1200);
  // 找设置按钮：按 title / aria-label 里含「设置|Settings」的按钮
  const opened = await ev(`
    const btns = [...document.querySelectorAll('button')];
    const hit = btns.find(b => /设置|Settings/.test((b.getAttribute('title')||'') + (b.getAttribute('aria-label')||'')));
    if (!hit) return 'NO_BUTTON';
    hit.click();
    return 'CLICKED';
  `);
  check('找到并点击设置入口', opened === 'CLICKED', String(opened));
  await sleep(900);
  const tabClicked = await ev(`
    const nodes = [...document.querySelectorAll('button, li, div, span')];
    const hit = nodes.find(n => /^(3D 场景构建|3D Scene Builder)$/.test((n.textContent||'').trim()));
    if (!hit) return 'NO_TAB';
    const target = hit.closest('button') || hit.closest('div[role=button]') || hit;
    target.click();
    return 'OK';
  `);
  check('切到 3D 场景构建标签', tabClicked === 'OK', String(tabClicked));
  await sleep(1200);
  const cardText = await ev(`
    // 取整个设置弹窗的文本（对话区里也有同名字样，所以先定位含「生成模型」的最小容器）
    const all = [...document.querySelectorAll('div')];
    const hit = all.filter(d => /生成模型|Generation model/.test(d.innerText||'') && /Idol/.test(d.innerText||''))
                   .sort((a,b)=> (a.innerText||'').length - (b.innerText||'').length)[0];
    return hit ? hit.innerText.slice(0, 1600) : (document.body.innerText||'').slice(0,1600);
  `);
  check('卡片出现「生成模型」选择 + Idol 选项', !!cardText && /Idol/.test(cardText||''));
  const dialogText = await ev(`const d=document.querySelector('[role="dialog"]') || document.body; return d.innerText || '';`);
  check('卡片有保存配置按钮', /保存配置|Save configuration/.test(dialogText || ''));
  check('选择器里两个运行时都标出来了', /llama\.cpp/.test(cardText || '') && /mlx-serve/.test(cardText || ''));
  check('显示闲置内存释放', /闲置内存释放|Idle memory release/.test(dialogText || ''));
  // 已保存模型就绪时没有下载入口、未就绪才出现 —— 两条都算通过
  check('模型状态行正常（Ready 或 Download）', /(^|\n)(Ready|Offline)(\n|$)|Download model|下载模型/.test(dialogText || ''));
  check('没有串入 OCR 的文案', !/OCR model|OCR 模型/.test(dialogText || ''));
  check('有「恢复默认」按钮', /恢复默认|Restore defaults/i.test(dialogText || ''));
  await shot('03_settings_scene3d');

  // [3b] 点模型卡 = **立即切换**（与语音输入的引擎切换同一语义，不需要保存）
  const before = await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(j=>j.selectedKey);`);
  const clickIdol = await ev(`
    const btns = [...document.querySelectorAll('button')];
    const hit = btns.find(b => /^Idol/.test((b.textContent||'').trim()));
    if (!hit) return 'NO_IDOL';
    hit.click();
    return 'OK';
  `);
  check('能点到 Idol 卡片', clickIdol === 'OK', String(clickIdol));
  await sleep(2500);
  const after = await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(j=>j.selectedKey);`);
  check('点卡片立即生效（无需保存）', before === 'code' && after === 'idol', `${before} -> ${after}`);

  const switchedText = await ev(`const d=document.querySelector('[role="dialog"]') || document.body; return d.innerText || '';`);
  check('卡片整体翻成 Idol', /One photo becomes a 3D model|一张照片/.test(switchedText || ''));
  const saveDisabled = await ev(`
    const b=[...document.querySelectorAll('button')].find(x=>/保存配置|Save configuration/.test(x.textContent||''));
    return b ? b.disabled : null;`);
  check('没改闲置时长时保存按钮不可点', saveDisabled === true, `disabled=${saveDisabled}`);
  await shot('04_settings_switch_idol');

  // 切回去
  await ev(`
    const b=[...document.querySelectorAll('button')].find(x=>/^Qwen3\.5-4B-3D-Coder/.test((x.textContent||'').trim()));
    if(b) b.click(); return 1;`);
  await sleep(2000);
  const backKey = await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(j=>j.selectedKey);`);
  check('能切回 code', backKey === 'code', String(backKey));

  // ---- 4. 还原 ----
  console.log('\n[4] 还原为 code');
  await ev(`return fetch('/api/scene3d/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelKey:'code'})}).then(r=>r.json());`);
  const back = await ev(`return fetch('/api/scene3d/status').then(r=>r.json()).then(j=>j.selectedKey);`);
  check('已还原 code', back === 'code', String(back));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 2;
} catch (e) {
  console.error('脚本失败:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill('SIGKILL');
}
