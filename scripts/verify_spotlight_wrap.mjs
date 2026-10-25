/**
 * 浮窗输入框：**自然折行**是否也能触发「展开卡」形态。
 *
 * 判据 = 原生桥 resizePanel 的载荷（这是窗口真实尺寸的来源）：
 *   胶囊 540×88 / 展开 500×640。
 *
 * 场景：
 *  A. 短文本（1 行）→ 保持胶囊
 *  B. 长文本自然折行（**不含 \n**）→ 必须展开；文本不丢、焦点还在
 *  C. 删回 1 行 → 收回胶囊
 *  D. Shift+Enter 换行 → 仍然展开（既有行为不回退）
 *  E. 全程 resize 消息条数（抖动检测）
 */
import { spawn } from 'node:child_process';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9411;
const proc = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--in-process-gpu',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/edge-prof-spotwrap', '--no-first-run','--no-default-browser-check',
  '--hide-scrollbars','--window-size=560,720','http://127.0.0.1:5173/?mode=spotlight'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsUrl(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&t.url.startsWith('http')); if(p) return p.webSocketDebuggerUrl;} catch{} await sleep(500);} throw new Error('no target'); }

const ws = new WebSocket(await wsUrl());
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
let seq=0; const pending=new Map();
const b64 = s => Buffer.from(s,'utf8').toString('base64');
const now = Date.now();
const SNAP = { mainSessionId:'sess-1', generatingSessionIds:[], liveStreamingTokens:{}, settings:{language:'zh',theme:'dark',apiPort:1235},
  sessions:[{id:'sess-1',title:'新对话',createdAt:now,updatedAt:now,contextUsed:0,enableThinking:false,enableWikiSearch:false,messages:[]}]};

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

const state = `(() => {
  const el = document.querySelector('[data-chat-input="true"]');
  const rs = window.__resizes || [];
  const view = document.querySelector('[data-spot-view]');
  const last = rs.length ? rs[rs.length - 1] : null;
  return JSON.stringify({
    len: el ? el.value.length : -1,
    value: el ? el.value : null,
    last: last ? { w: last.width, h: last.height, exp: last.expanded } : null,
    count: rs.length,
    taScroll: el ? el.scrollHeight : 0,
    taClient: el ? el.clientHeight : 0,
    focused: el ? document.activeElement === el : null,
    view: view ? view.getAttribute('data-spot-view') : null,
  });
})()`;

async function type(text) {
  await ev(`(() => { const el = document.querySelector('[data-chat-input="true"]'); if (el && document.activeElement !== el) el.focus(); return 1; })()`);
  await send('Input.insertText', { text });
  await sleep(350);
}

async function backspaceAll() {
  for (let i = 0; i < 120; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  }
  await sleep(400);
}

async function enterWithShift() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 });
  await sleep(350);
}

try {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__resizes = [];
    window.webkit = { messageHandlers: {
      resizePanel: { postMessage: (p) => window.__resizes.push({ ...p, t: Math.round(performance.now()) }) },
      closeSpotlight: { postMessage: () => {} },
    } };
  ` });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await sleep(800);
  await send('Page.reload', {});
  await sleep(4500);

  console.log('bridge 探针:', await ev(`JSON.stringify({ webkit: typeof window.webkit, handlers: window.webkit && window.webkit.messageHandlers ? Object.keys(window.webkit.messageHandlers) : null, resizes: (window.__resizes||[]).length })`));
  await ev(`(() => { window.__resizes = window.__resizes || [];
    window.webkit = window.webkit || {}; window.webkit.messageHandlers = window.webkit.messageHandlers || {};
    window.webkit.messageHandlers.resizePanel = { postMessage: (p) => window.__resizes.push({ ...p, t: Math.round(performance.now()) }) };
    return Object.keys(window.webkit.messageHandlers); })()`);
  const s0 = JSON.parse(await ev(state));
  console.log('[0] 初始:', JSON.stringify(s0.last), 'count=', s0.count);

  console.log('[A] 打短文本（1 行）');
  await type('你好');
  const sA = JSON.parse(await ev(state));
  console.log('   ', JSON.stringify(sA.last), 'view=', sA.view, 'len=', sA.len, 'scroll/client=', sA.taScroll + '/' + sA.taClient);

  console.log('[B] 打长文本（不按回车，让它自然折行）');
  await type('差分是differential，这个词美式日常英语常用吗？到底是什么意思呢？就看这个中文我也不理解，一般是表示什么含义？');
  const sB = JSON.parse(await ev(state));
  console.log('   ', JSON.stringify(sB.last), 'view=', sB.view, 'len=', sB.len, '焦点在输入框=', sB.focused);
  console.log('   scroll/client=', sB.taScroll + '/' + sB.taClient, '（相等=没被裁掉）');

  console.log('[C] 全部删掉 → 应收回胶囊');
  await backspaceAll();
  const sC = JSON.parse(await ev(state));
  console.log('   ', JSON.stringify(sC.last), 'view=', sC.view, 'len=', sC.len);

  console.log('[D] 输入里带换行符（= Shift+Enter 的结果，既有行为）');
  await type('第一行\n第二行');
  const sD = JSON.parse(await ev(state));
  console.log('   ', JSON.stringify(sD.last), 'view=', sD.view, 'value=', JSON.stringify(sD.value));

  console.log('[E] 输入法合成中不能被换 DOM（长拼音撑满一行）');
  await backspaceAll();
  const mark = await ev(`(() => { const el = document.querySelector('[data-chat-input="true"]'); el.__probe = 'kept'; el.focus(); return 1; })()`);
  await send('Input.imeSetComposition', {
    text: 'chai fen shi differential zhe ge ci mei shi ri chang ying yu chang yong ma dao di shi shen me yi si',
    selectionStart: 88, selectionEnd: 88,
  });
  await sleep(350);
  const sE1 = JSON.parse(await ev(state));
  const probe1 = await ev(`(() => { const el = document.querySelector('[data-chat-input="true"]'); return el ? el.__probe || null : null; })()`);
  console.log('   合成中: view=', sE1.view, '节点标记=', probe1, 'value=`' + (sE1.value || '') + '`');
  await send('Input.insertText', { text: '差分是differential，这个词美式日常英语常用吗？到底是什么意思呢？就看这个中文我也不理解，一般是表示什么含义？' });
  await sleep(600);
  const sE2 = JSON.parse(await ev(state));
  console.log('   上屏后: view=', sE2.view, 'value=`' + (sE2.value || '') + '`');

  const A = sA.view === 'capsule' && (!sA.last || (sA.last.h === 88 && !sA.last.exp));
  const B = sB.view === 'expanded' && sB.len > 20 && sB.focused && (!sB.last || (sB.last.h === 640 && sB.last.exp));
  const C = sC.view === 'capsule' && sC.len === 0 && (!sC.last || (sC.last.h === 88 && !sC.last.exp));
  const D = sD.view === 'expanded' && sD.value.includes('\n');
  const E = sE1.view === 'capsule' && probe1 === 'kept' && sE2.view === 'expanded' && (sE2.value || '').includes('差分是');
  const noFlap = sD.count <= 8;

  console.log(`\nA(短文本保持胶囊)=${A}  B(折行展开)=${B}  C(删空收回)=${C}  D(Shift+Enter)=${D}  E(合成期不换DOM)=${E}  抖动(${sD.count} 条)=${noFlap}`);
  console.log('结果：', A && B && C && D && E && noFlap ? 'PASS' : 'FAIL');
} catch (e) {
  console.error('FAILED:', e.message);
} finally { try{ws.close();}catch{} try{proc.kill('SIGKILL');}catch{} process.exit(0); }
