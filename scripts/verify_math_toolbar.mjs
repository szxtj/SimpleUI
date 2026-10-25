/**
 * 公式工具条（LaTeX / 公式块）是否被窗口边缘裁掉。
 *
 * 做法：种一条含多个**内联公式**的助手消息（有靠左的、有靠右的），
 * 用真实鼠标逐个点选，量工具条的 getBoundingClientRect 是否完全落在视口内。
 *
 * 用法：MODE=spot|main（默认 spot，模拟浮窗 500px 宽）
 */
import { spawn } from 'node:child_process';

const MODE = (process.env.MODE || 'spot').toLowerCase();
const VW = Number(process.env.VW || (MODE === 'spot' ? 500 : 1000));
const VH = MODE === 'spot' ? 640 : 700;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = MODE === 'spot' ? 9421 : 9422;
const TARGET = MODE === 'spot' ? 'http://127.0.0.1:5173/?mode=spotlight' : 'http://127.0.0.1:5173/';

const proc = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--in-process-gpu',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/edge-prof-math-${MODE}`, '--no-first-run','--no-default-browser-check',
  '--hide-scrollbars', `--window-size=${VW},${VH}`, TARGET], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&t.url.startsWith('http')); if(p) return p.webSocketDebuggerUrl;} catch{} await sleep(500);} throw new Error('no target'); }

const ws = new WebSocket(await wsUrl());
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
let seq=0; const pending=new Map();
const b64 = s => Buffer.from(s,'utf8').toString('base64');

const now = Date.now();
const content = [
  '$\\varphi$ 相位 — 这一行的公式贴着左边缘。',
  '',
  '载波有三个可被数字信号控制的要素：幅度 $A$、频率 $f$、',
  '',
  '这一行故意写很长很长很长很长很长很长很长很长很长很长很长很长的文字，用来把公式挤到右边 $\\beta$。',
  '',
  '$$s(t) = A(t)\\cos(2\\pi f_c t + \\varphi(t))$$',
  '',
  '再来一行普通的 $x_{1}$ 与 $y_{2}$ 做对照。',
  '',
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor $A_{1}$',
  '',
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut $A_{2}$',
  '',
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore $A_{3}$',
].join('\n');

const SNAP = { mainSessionId:'sess-math', generatingSessionIds:[], liveStreamingTokens:{}, settings:{language:'en',theme:'light',apiPort:1235},
  sessions:[{id:'sess-math',title:'公式验证',createdAt:now,updatedAt:now,contextUsed:0,enableThinking:false,enableWikiSearch:false,
    messages:[
      {id:'m1',role:'user',content:'解释一下 ASK 调制',timestamp:now-3000},
      {id:'m2',role:'assistant',content,timestamp:now-2000},
    ]}]};

ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    const h=[{name:'Content-Type',value:'application/json'}];
    if (/sessions\/state/.test(request.url)) send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:h,body:b64(JSON.stringify(SNAP))});
    else if (/sessions\/events/.test(request.url)) send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/event-stream'}],body:b64(`event: snapshot\ndata: ${JSON.stringify(SNAP)}\n\n`)});
    else send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:h,body:b64('{}')});
    return;
  }
  if (m.id && pending.has(m.id)) { const {resolve,reject}=pending.get(m.id); pending.delete(m.id); m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result); }
});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value;};

/** 量所有内联公式的位置 + 当前显示的工具条 */
const clipProbe = `(() => {
  const host = document.querySelector('.interactive-math');
  if (!host) return 'null';
  for (let el = host.parentElement; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), cls: (el.className || '').toString().slice(0, 40) });
    }
  }
  return 'null';
})()`;

const formulasProbe = `(() => {
  const all = [...document.querySelectorAll('.interactive-math')];
  return JSON.stringify(all.map((el, i) => {
    const r = el.getBoundingClientRect();
    const tb = el.querySelector('[data-math-toolbar], [class*="z-30"], [class*="z-20"]');
    return {
      i, display: !el.matches('span.interactive-math'),
      cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
      left: Math.round(r.left), right: Math.round(r.right),
      tb: tb ? (t => ({ left: Math.round(t.left), right: Math.round(t.right), w: Math.round(t.width) }))(tb.getBoundingClientRect()) : null,
    };
  }));
})()`;

const vw = `document.documentElement.clientWidth`;

try {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await send('Page.reload', {});
  await sleep(5000);
  if (MODE === 'spot') {
    await ev(`window.loadSessionInSpotlight && window.loadSessionInSpotlight('sess-math')`);
    await sleep(1500);
  }

  const list = JSON.parse(await ev(formulasProbe));
  const clip = JSON.parse(await ev(clipProbe) || 'null');
  console.log(`[${MODE}] 视口 ${await ev(vw)}px，裁剪容器=${JSON.stringify(clip)}，找到 ${list.length} 个公式`);

  const results = [];
  for (const f of list) {
    // 先把该公式滚到视口中间（否则顶栏/底部输入框会挡住点击）
    await ev(`(() => { const el = document.querySelectorAll('.interactive-math')[${f.i}];
      if (el) el.scrollIntoView({ block: 'center' }); return 1; })()`);
    await sleep(200);
    const cur = JSON.parse(await ev(formulasProbe)).find(x => x.i === f.i) || f;
    // 真实鼠标点选该公式
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cur.cx, y: cur.cy, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cur.cx, y: cur.cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cur.cx, y: cur.cy, button: 'left', clickCount: 1 });
    await sleep(260);
    const after = JSON.parse(await ev(formulasProbe)).find(x => x.i === f.i);
    if (!after || !after.tb) { results.push({ i: f.i, ok: null, note: '工具条未出现' }); continue; }
    const width = await ev(vw);
    const lo = Math.max(0, clip ? clip.left : 0);
    const hi = Math.min(width, clip ? clip.right : width);
    const ok = after.tb.left >= lo && after.tb.right <= hi;
    results.push({ i: f.i, display: f.display, formula: [f.left, f.right], tb: [after.tb.left, after.tb.right], ok });
    console.log(`  公式#${f.i}${f.display ? '(块级)' : ''} x=${f.left}..${f.right} → 工具条 ${after.tb.left}..${after.tb.right} ${ok ? 'OK' : '❌ 越界'}`);
  }

  // ---- 追加：夹紧后的工具条按钮仍可点 + 宽度变化会重新夹 + 不产生横向滚动 ----
  console.log(`\n[按钮可用性] 点被夹紧那个公式的「LaTeX」按钮`);
  const loEdge = Math.max(0, clip ? clip.left : 0);
  const hiEdge = Math.min(VW, clip ? clip.right : VW);
  const shiftedIdx = (results.find(r => r.ok && r.tb && (r.tb[0] <= loEdge + 9 || r.tb[1] >= hiEdge - 9)) || {}).i;
  if (shiftedIdx !== undefined) {
    await ev(`(() => { const el = document.querySelectorAll('.interactive-math')[${shiftedIdx}]; el && el.scrollIntoView({block:'center'}); return 1; })()`);
    await sleep(200);
    const pos = JSON.parse(await ev(`(() => {
      const el = document.querySelectorAll('.interactive-math')[${shiftedIdx}];
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`));
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(300);
    const btn = JSON.parse(await ev(`(() => {
      const tb = document.querySelector('[data-math-toolbar]');
      if (!tb) return JSON.stringify({ none: true });
      const b = tb.querySelector('button');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: b.textContent.trim() });
    })()`));
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const after = JSON.parse(await ev(`(() => {
      const tb = document.querySelector('[data-math-toolbar]');
      const b = tb && tb.querySelector('button');
      const r = tb ? tb.getBoundingClientRect() : null;
      const scrollers = [...document.querySelectorAll('div')].filter(d => /auto|scroll/.test(getComputedStyle(d).overflowX));
      const hOver = scrollers.filter(d => d.scrollWidth > d.clientWidth + 2).map(d => d.scrollWidth - d.clientWidth);
      return JSON.stringify({ label: b ? b.textContent.trim() : null,
        bounds: r ? [Math.round(r.left), Math.round(r.right)] : null, hOver });
    })()`));
    const lo2 = Math.max(0, clip ? clip.left : 0);
    const hi2 = Math.min(VW, clip ? clip.right : VW);
    const inside = after.bounds && after.bounds[0] >= lo2 && after.bounds[1] <= hi2;
    console.log(`  点前="${btn.text}" 点后="${after.label}" 夹紧后边界=${JSON.stringify(after.bounds)} 在窗口内=${inside} 横向溢出=${JSON.stringify(after.hOver)}`);
    results.push({ i: 'button', ok: inside && after.label !== btn.text });
  }

  const inline = results.filter(r => r.ok !== null && !r.display);
  const bad = inline.filter(r => !r.ok);
  console.log(`\n内联公式 ${inline.length} 个，越界 ${bad.length} 个`);
  console.log('结果：', bad.length === 0 ? 'PASS 全部在视口内' : 'FAIL 有工具条被裁');
} catch (e) {
  console.error('FAILED:', e.message);
} finally { try{ws.close();}catch{} try{proc.kill('SIGKILL');}catch{} process.exit(0); }
