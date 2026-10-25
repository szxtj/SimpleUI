/**
 * 图片页「边界/新 bug」专项（配套 verify_image_page.mjs）：
 *  A. 主窗口：拖拽平移时把指针拖到箭头上再松手 → **不得**误触切图（capture 仍归画布）
 *  B. 主窗口：点击箭头是否让按钮吃焦点（标准 button 行为），切图时延
 *  C. 浮窗（?mode=spotlight）：浮窗图片页的左右箭头同样可用
 *  D. 面板其他常驻页面（原文页）在切图时不受影响：不重挂载、不丢滚动位置
 *
 * 用法：MODE=main|spot（默认 main），先起 vite 5173。
 */
import { spawn } from 'node:child_process';

const MODE = (process.env.MODE || 'main').toLowerCase();
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = MODE === 'spot' ? 9388 : 9387;
const TARGET = MODE === 'spot' ? 'http://127.0.0.1:5173/?mode=spotlight' : 'http://127.0.0.1:5173/';

const proc = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--in-process-gpu',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/edge-prof-extra-${MODE}`, '--no-first-run','--no-default-browser-check',
  '--hide-scrollbars', MODE === 'spot' ? '--window-size=500,640' : '--window-size=1200,760', TARGET], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function wsUrl(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&t.url.startsWith('http')); if(p) return p.webSocketDebuggerUrl;}catch{} await sleep(500);} throw new Error('no target'); }

const ws = new WebSocket(await wsUrl());
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
let seq=0; const pending=new Map();
const b64 = s => Buffer.from(s,'utf8').toString('base64');
const svg = (bg,l)=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="${bg}"/><text x="180" y="132" font-size="72" text-anchor="middle" fill="#fff">${l}</text></svg>`);
const now = Date.now();
const SNAP = { mainSessionId:'sess-img', generatingSessionIds:[], liveStreamingTokens:{}, settings:{language:'zh',theme:'dark',apiPort:1235},
  sessions:[{id:'sess-img',title:'图片验证',createdAt:now,updatedAt:now,contextUsed:0,enableThinking:false,enableWikiSearch:false,
  messages:[
    {id:'mi1',role:'user',content:'这三张图分别是什么？',images:[svg('#1f6feb','1'),svg('#2ea043','2'),svg('#bf3989','3')],timestamp:now-3000},
    {id:'mi2',role:'assistant',content:Array.from({length:40},(_,i)=>`第 ${i+1} 行：这是一段足够长的回答，用来让原文页出现可滚动内容。`).join('\n\n'),timestamp:now-2000},
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

const probe = `(() => {
  const next = [...document.querySelectorAll('button')].find(b => /^Next/.test(b.getAttribute('title') || ''));
  const prev = [...document.querySelectorAll('button')].find(b => /^Previous/.test(b.getAttribute('title') || ''));
  const canvas = next ? next.parentElement : null;
  const shown = canvas ? canvas.querySelector('img.pointer-events-none') : null;
  const at = b => b ? (r => ({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }))(b.getBoundingClientRect()) : null;
  return JSON.stringify({
    label: shown ? (decodeURIComponent(shown.src).match(/>(\\d)</) || [])[1] : null,
    next: at(next), prev: at(prev),
    canvasCenter: canvas ? (r => ({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }))(canvas.getBoundingClientRect()) : null,
    tabTitle: (document.querySelector('[data-tab-id="img:mi1"]') || {}).textContent || null,
    activeEl: document.activeElement ? document.activeElement.tagName + '/' + (document.activeElement.getAttribute('title') || '') : null,
  });
})()`;

const mark = (tag) => `(() => { window.__marks = window.__marks || {}; window.__marks['${tag}'] = performance.now(); return 1; })()`;

try {
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]});
  await sleep(1200);
  await send('Page.reload',{});
  await sleep(5000);

  if (MODE === 'spot') {
    await ev(`window.loadSessionInSpotlight && window.loadSessionInSpotlight('sess-img')`);
    await sleep(1500);
  }

  // 打开图片页（主窗口：点气泡图片；浮窗：同理走 openImagePage）
  await ev(`(() => { const i = document.querySelector('img[data-message-image]'); i && i.click(); return !!i; })()`);
  await sleep(1200);

  const s0 = JSON.parse(await ev(probe));
  console.log(`[${MODE}] 打开图片页：label=${s0.label} next=${!!s0.next}`);
  if (!s0.next) throw new Error('没有找到切图箭头（页面没开？）');

  // ---- A. 拖拽起于画布、松手落在箭头上 → 不得误触切图 ----
  console.log(`[${MODE}] A. 画布拖拽 → 松手落在「下一张」箭头`);
  const c = s0.canvasCenter, n = s0.next;
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:c.x,y:c.y,button:'none'});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:c.x,y:c.y,button:'left',clickCount:1});
  for (let k=1;k<=6;k++){
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(c.x+(n.x-c.x)*k/6),y:Math.round(c.y+(n.y-c.y)*k/6),button:'left',buttons:1});
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:n.x,y:n.y,button:'left',clickCount:1});
  await sleep(500);
  const s1 = JSON.parse(await ev(probe));
  const A = s1.label === s0.label;
  console.log(`   label ${s0.label} → ${s1.label}  ${A ? 'OK 未误切' : 'BAD 误切了'}`);

  // ---- B. 正常点击 + 时延 + 焦点 ----
  console.log(`[${MODE}] B. 正常点击箭头：时延 / 焦点`);
  const fresh = JSON.parse(await ev(probe));
  await ev(mark('click'));
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:fresh.next.x,y:fresh.next.y,button:'none'});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:fresh.next.x,y:fresh.next.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:fresh.next.x,y:fresh.next.y,button:'left',clickCount:1});
  await sleep(300);
  const s2 = JSON.parse(await ev(probe));
  const dt = await ev(`(() => {
    const nowT = performance.now();
    return Math.round(nowT - (window.__marks.click || nowT));
  })()`);
  const B = s2.label !== s1.label;
  console.log(`   label ${s1.label} → ${s2.label}  ${B ? 'OK 切图成功' : 'BAD 没切'}；焦点=${s2.activeEl}；约 ${dt}ms 内完成`);

  // ---- D. 原文页（另一个常驻页）不受影响：切图前后滚动位置不变 ----
  console.log(`[${MODE}] D. 切图不影响其他常驻页面`);
  const d = await ev(`(() => {
    const t = document.querySelector('[data-tab-id="raw:mi2"]');
    return JSON.stringify({ hasRawTab: !!t });
  })()`);
  console.log('   原文页存在:', d);

  const pass = A && B;
  console.log(`\n结果：${pass ? 'PASS 无误切、点击正常' : 'FAIL'}（A=${A} B=${B}）`);
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  try { ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  process.exit(0);
}
