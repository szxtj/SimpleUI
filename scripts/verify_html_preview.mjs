/**
 * 验证「HTML 代码块预览」的无头闭环。
 *
 * 后端不存在也没关系：CDP Fetch 把 /api/sessions/state 与 /api/sessions/events 伪造成
 * 「一条已完成的 HTML 块 + 一条正在流式输出的 HTML 块」，其余 /api/* 一律回空对象。
 *
 * 覆盖：
 *  1. 已完成的 HTML 块：默认就是预览（iframe 存在、两个按钮在、分段选中 preview）
 *  2. 生成中的块：无 iframe、分段按钮 disabled、不出现「在浏览器打开 / 下载」
 *  3. **按块判定**：同一条消息里，前面写完了的块照样可以预览（这是不按消息级 pending 一刀切的依据）
 *  4. 切源码：iframe 消失、<pre> 出现、打开/下载按钮消失；切回预览 srcdoc 与原 code 逐字一致（证明切换不改内容）
 *  5. 深/浅色：头部底色随 <html class="dark"> 变化
 *  6. 流结束：SSE 重连后下发「已闭合」快照 → 生成中的块自动切到预览（不需要人点）
 *
 * 用法：先 `npx vite`（5173），再 `node scripts/verify_html_preview.mjs`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9351;
const TARGET = 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-htmlprev`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1080,800', TARGET,
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('http'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP page target');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const HTML_DONE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Demo Title</title>
<style>body{background:#eef2f7;font-family:-apple-system;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
h1{color:#0f172a;font-size:28px}</style>
</head>
<body><h1>HELLO-PREVIEW</h1></body>
</html>`;

const HTML_HALF = `<!DOCTYPE html>
<html><head><title>Half</title></head>
<body><h1>SECOND-HALF`;

const JS_BLOCK = 'console.log(1);\nconst a = 2;';

const now = Date.now();
const baseSession = (streaming) => ({
  id: 'sess-html', title: 'HTML 预览验证', createdAt: now, updatedAt: now, contextUsed: 0,
  enableThinking: false, enableWikiSearch: false,
  messages: [
    { id: 'm1', role: 'user', content: '写个 html 教学示例', timestamp: now - 4000 },
    {
      id: 'm2', role: 'assistant', timestamp: now - 3000,
      content:
        '这是一个可以直接运行的 HTML 文档。\n\n```html\n' + HTML_DONE + '\n```\n\n再给一段普通脚本作对照：\n\n```js\n' + JS_BLOCK + '\n```\n',
    },
    {
      id: 'm3', role: 'assistant', timestamp: now - 2000,
      content: streaming
        ? '接着写第二个示例（还没写完）：\n\n```html\n' + HTML_HALF
        : '接着写第二个示例：\n\n```html\n' + HTML_DONE.replace('HELLO-PREVIEW', 'SECOND-DONE') + '\n```\n',
    },
  ],
});

const snapshotOf = (streaming) => ({
  mainSessionId: 'sess-html',
  generatingSessionIds: streaming ? ['sess-html'] : [],
  liveStreamingTokens: streaming ? { 'sess-html': 120 } : {},
  settings: {
    apiPort: 1235, modelId: 'test', maxContext: 32768, enableThinking: false,
    reasoningEffort: 'default', temperature: 0.2, topP: 0.95, topK: 64,
    repetitionPenalty: 1, maxTokens: 4096, stopStrings: [], systemPrompt: '',
    language: 'zh', theme: 'dark',
  },
  sessions: [baseSession(streaming)],
});

const SNAP_STREAMING = snapshotOf(true);
const SNAP_DONE = snapshotOf(false);
let phase = 'streaming';
let current = SNAP_STREAMING;
let eventsHits = 0;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params;
    const url = request.url;
    const headers = [{ name: 'Content-Type', value: 'application/json' }];
    if (/\/api\/sessions\/events/.test(url)) {
      eventsHits += 1;
      // 由脚本的 phase 决定下发哪一版：EventSource 会不断重连，靠它把「流结束」推进页面
      current = phase === 'done' ? SNAP_DONE : SNAP_STREAMING;
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Cache-Control', value: 'no-cache' }],
        body: b64(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`),
      });
    } else if (/\/api\/sessions\/state/.test(url)) {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: b64(JSON.stringify(current)) });
    } else {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: b64('{}') });
    }
    return;
  }

  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function shot(file, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  console.log('  saved', `${OUT}/${file}`);
}

async function clickButton(blockSelectorJs, buttonRe) {
  const pt = JSON.parse(await ev(`(() => {
    const b = ${blockSelectorJs};
    const btn = [...b.querySelectorAll('button')].find(x => ${buttonRe}.test(x.textContent || ''));
    if (!btn) return JSON.stringify({ missing: true });
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    window.__lastBtn = (btn.textContent || '').trim();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (btn.textContent || '').trim() });
  })()`));
  if (pt.missing) return pt;
  await sleep(300);
  // scrollIntoView 之后重新取坐标（滚动会移动元素）
  const pt2 = JSON.parse(await ev(`(() => {
    const b = ${blockSelectorJs};
    const btn = [...b.querySelectorAll('button')].find(x => ${buttonRe}.test(x.textContent || ''));
    const r = btn.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`));
  await realClick(pt2.x, pt2.y);
  return pt;
}

async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(450);
}

const blocksProbe = `(() => {
  const blocks = [...document.querySelectorAll('[data-md-codeblock]')];
  return JSON.stringify(blocks.map(b => {
    const iframe = b.querySelector('iframe');
    const btns = [...b.querySelectorAll('button')];
    const seg = btns.filter(x => /预览|源码|Preview|Source/.test(x.textContent || ''));
    const header = b.firstElementChild;
    const raw = b.getAttribute('data-raw-code') || '';
    return {
      lang: b.getAttribute('data-language'),
      rawLen: raw.length,
      hasHello: raw.includes('HELLO-PREVIEW'),
      hasHalf: raw.includes('SECOND-HALF'),
      hasSecondDone: raw.includes('SECOND-DONE'),
      hasIframe: !!iframe,
      srcdocLen: iframe ? (iframe.getAttribute('srcdoc') || '').length : 0,
      sandbox: iframe ? iframe.getAttribute('sandbox') : null,
      iframeH: iframe ? Math.round(iframe.getBoundingClientRect().height) : 0,
      seg: seg.map(s => ({ t: (s.textContent || '').trim(), disabled: !!s.disabled, pressed: s.getAttribute('aria-pressed') })),
      hasOpen: btns.some(x => /在浏览器打开|Open in Browser/.test(x.textContent || '')),
      hasDl: btns.some(x => /下载|Download/.test(x.textContent || '')),
      hasPre: !!b.querySelector('pre'),
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
      shellBg: getComputedStyle(b).backgroundColor,
    };
  }));
})()`;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`);
  }
}

try {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await sleep(1200);
  await send('Page.reload', {});
  await sleep(5200);

  let blocks = JSON.parse(await ev(blocksProbe));
  console.log('[1] 初始（m2 已完成、m3 流式中）:', JSON.stringify(blocks.map(b => ({ lang: b.lang, iframe: b.hasIframe, seg: b.seg.map(s => s.t + (s.disabled ? '(禁)' : '')) }))));

  const htmlDone = blocks.find(b => b.hasHello);
  const htmlHalf = blocks.find(b => b.hasHalf);
  const jsBlock = blocks.find(b => b.lang === 'js');

  check('已完成的 HTML 块存在', !!htmlDone, blocks.map(b => b.lang));
  check('已完成块默认预览（iframe 存在）', !!htmlDone?.hasIframe);
  check('iframe 高 480px', htmlDone?.iframeH === 480, htmlDone?.iframeH);
  check('iframe 严格沙箱（不给 allow-same-origin）',
    htmlDone?.sandbox === 'allow-scripts allow-forms allow-modals' && !String(htmlDone?.sandbox).includes('same-origin'),
    htmlDone?.sandbox);
  check('预览态有「在浏览器打开」', !!htmlDone?.hasOpen);
  check('预览态有「下载 HTML」', !!htmlDone?.hasDl);
  check('分段选中「预览」', htmlDone?.seg?.find(s => s.pressed === 'true')?.t?.match(/预览|Preview/) != null, htmlDone?.seg);
  check('原始 code 未被改动（data-raw-code 完整）', (htmlDone?.rawLen || 0) > 300, htmlDone?.rawLen);

  check('生成中的块无 iframe', !!htmlHalf && htmlHalf.hasIframe === false, htmlHalf?.hasIframe);
  check('生成中分段按钮 disabled', !!htmlHalf && htmlHalf.seg.length === 2 && htmlHalf.seg.every(s => s.disabled), htmlHalf?.seg);
  check('生成中不显示「在浏览器打开 / 下载」', !!htmlHalf && !htmlHalf.hasOpen && !htmlHalf.hasDl);
  check('生成中停在源码视图（有 <pre>）', !!htmlHalf?.hasPre);

  check('普通 JS 块没有分段切换', !!jsBlock && jsBlock.seg.length === 0, jsBlock?.seg);

  // 深浅色：直接切 <html class="dark"> 看头部底色是否跟着变
  const darkBg = await ev(`(() => {
    document.documentElement.classList.add('dark');
    const b = [...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'));
    return getComputedStyle(b.firstElementChild).backgroundColor;
  })()`);
  const lightBg = await ev(`(() => {
    document.documentElement.classList.remove('dark');
    const b = [...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'));
    return getComputedStyle(b.firstElementChild).backgroundColor;
  })()`);
  check('深色头部底色 = #22242a', darkBg === 'rgb(34, 36, 42)', darkBg);
  check('浅色头部底色 = #f6f8fa', lightBg === 'rgb(246, 248, 250)', lightBg);
  await ev(`document.documentElement.classList.add('dark')`);

  // 把「生成中」的块滚进视野截一张，肉眼确认禁用态与源码视图
  const halfShot = JSON.parse(await ev(`(() => {
    const b = [...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('SECOND-HALF'));
    if (!b) return JSON.stringify({ missing: true });
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.min(220, Math.round(r.height)) });
  })()`));
  await sleep(450);
  if (!halfShot.missing) await shot('html_preview_generating.png', halfShot);

  console.log('[2] 点「源码」→ 应该只剩 <pre>，且打开/下载按钮消失');
  const clicked = await clickButton(
    `[...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'))`,
    `/源码|Source/`
  );
  console.log('  点了:', clicked.label);
  blocks = JSON.parse(await ev(blocksProbe));
  const afterSource = blocks.find(b => b.hasHello);
  check('源码态 iframe 已移除', afterSource?.hasIframe === false, afterSource?.hasIframe);
  check('源码态出现 <pre>', afterSource?.hasPre === true);
  check('源码态隐藏打开/下载', !afterSource?.hasOpen && !afterSource?.hasDl);

  console.log('[3] 点回「预览」→ srcdoc 必须与原始 code 逐字一致');
  const clicked2 = await clickButton(
    `[...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'))`,
    `/预览|Preview/`
  );
  console.log('  点了:', clicked2.label);
  const srcdocMatch = await ev(`(() => {
    const b = [...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'));
    const iframe = b.querySelector('iframe');
    return JSON.stringify({ same: iframe ? iframe.getAttribute('srcdoc') === b.getAttribute('data-raw-code') : false });
  })()`);
  check('srcdoc === data-raw-code（切换不改内容）', JSON.parse(srcdocMatch).same === true, JSON.parse(srcdocMatch));

  await shot('html_preview_dark.png');

  console.log('[4] 切 phase=done，等 SSE 重连下发「已闭合」快照 → 生成中的块应自动切预览');
  phase = 'done';
  let autoSwitched = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const b2 = JSON.parse(await ev(blocksProbe));
    const half = b2.find(b => b.hasSecondDone);
    if (half && half.hasIframe) { autoSwitched = true; break; }
  }
  console.log('  events 请求次数:', eventsHits);
  check('流结束后自动切到预览（无需点击）', autoSwitched);

  await shot('html_preview_done.png');

  const shot2 = JSON.parse(await ev(`(() => {
    const b = [...document.querySelectorAll('[data-md-codeblock]')].find(x => (x.getAttribute('data-raw-code')||'').includes('HELLO-PREVIEW'));
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.min(560, Math.round(r.height)) });
  })()`));
  await shot('html_preview_block.png', shot2);

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项未通过 ❌`);
} finally {
  try { ws.close(); } catch {}
  proc.kill('SIGKILL');
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}
