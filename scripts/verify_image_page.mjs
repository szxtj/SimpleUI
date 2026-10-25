/**
 * 验证「图片标签页的左右切换按钮」是否真的能切图。
 *
 * 后端不存在也没关系：用 CDP Fetch 域把 /api/sessions/state 与 /api/sessions/events
 * 伪造成「一条带 3 张图的用户消息」，其余 /api/* 一律回空对象。
 *
 * 步骤：
 *  1. 点消息里的第一张图 → 右侧面板出现图片标签（1 / 3）
 *  2. 用 CDP **真实鼠标事件**（走 Pointer Capture）点右箭头 → 断言 2 / 3 且 <img src> 变了
 *  3. 点左箭头两次 → 回到 1 / 3
 *  4. 记录 click 实际落在哪个元素上（定位"点了没反应"的根因）
 *  5. 回归：画布拖拽平移仍然生效
 *
 * 用法：先起 vite（5173），再 `node scripts/verify_image_page.mjs`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9344;
const TARGET = 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-imgnav`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1080,675', TARGET,
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

const svg = (bg, label) =>
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="${bg}"/><text x="180" y="132" font-size="72" text-anchor="middle" fill="#fff" font-family="Helvetica">${label}</text></svg>`
  );

const IMGS = [svg('#1f6feb', '1'), svg('#2ea043', '2'), svg('#bf3989', '3')];
const now = Date.now();
const SNAPSHOT = {
  mainSessionId: 'sess-img',
  generatingSessionIds: [],
  liveStreamingTokens: {},
  settings: {
    apiPort: 1235, modelId: 'test', maxContext: 32768, enableThinking: false,
    reasoningEffort: 'default', temperature: 0.2, topP: 0.95, topK: 64,
    repetitionPenalty: 1, maxTokens: 4096, stopStrings: [], systemPrompt: '',
    language: 'zh', theme: 'dark',
  },
  sessions: [
    {
      id: 'sess-img', title: '图片验证', createdAt: now, updatedAt: now, contextUsed: 0,
      enableThinking: false, enableWikiSearch: false,
      messages: [
        { id: 'mi1', role: 'user', content: '这三张图分别是什么？', images: IMGS, timestamp: now - 2000 },
        { id: 'mi2', role: 'assistant', content: '第一张是蓝色，第二张是绿色，第三张是粉色。', timestamp: now - 1000 },
      ],
    },
  ],
};

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params;
    const url = request.url;
    const headers = [{ name: 'Content-Type', value: 'application/json' }];
    if (/\/api\/sessions\/state/.test(url)) {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: b64(JSON.stringify(SNAPSHOT)) });
    } else if (/\/api\/sessions\/events/.test(url)) {
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Cache-Control', value: 'no-cache' }],
        body: b64(`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}\n\n`),
      });
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

async function shot(file, width = 1080, height = 675, scale = 1.5) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  console.log('  saved', `${OUT}/${file}`);
}

async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(420);
}

const stateProbe = `(() => {
  const nextBtn = [...document.querySelectorAll('button')].find(b => /^Next/.test(b.getAttribute('title') || ''));
  const prevBtn = [...document.querySelectorAll('button')].find(b => /^Previous/.test(b.getAttribute('title') || ''));
  const canvas = nextBtn ? nextBtn.parentElement : null;
  const stats = [...document.querySelectorAll('span')].map(s => s.textContent || '').filter(s => /\\d+ \\/ \\d+/.test(s));
  const shown = canvas ? canvas.querySelector('img.pointer-events-none') : null;
  const label = shown ? (decodeURIComponent(shown.src).match(/>(\\d)</) || [])[1] : null;
  const at = b => b ? (r => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }))(b.getBoundingClientRect()) : null;
  return JSON.stringify({
    hasNext: !!nextBtn, hasPrev: !!prevBtn,
    rect: at(nextBtn), prevRect: at(prevBtn),
    stats: stats.join(' | '), label,
    tabTitle: (document.querySelector('[data-tab-id="img:mi1"]') || {}).textContent || null,
    clicks: (window.__clicks || []).slice(-3),
  });
})()`;

try {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await sleep(1500);
  await send('Page.reload', {});
  await sleep(5000);

  await ev(`(() => { window.__clicks = []; document.addEventListener('click', e => {
    const el = e.target; window.__clicks.push((el && el.tagName) + '.' + (((el && el.getAttribute && el.getAttribute('class')) || '').split(' ')[0]));
  }, true); return 1; })()`);

  console.log('[1] 点消息里的图片 → 打开图片标签页（标题应显示 1 / 3）');
  const opened = await ev(`(() => {
    const img = document.querySelector('img[data-message-image]');
    if (!img) return 'NO_IMG';
    img.click();   // 开标签不是本次要测的环节，直接用 DOM click
    return 'ok';
  })()`);
  if (opened === 'NO_IMG') throw new Error('消息图片没渲染出来');
  await sleep(900);
  // 注意：shot() 会改 deviceMetrics → 布局重排，坐标必须**在截图之后**再量
  await shot('img_1of3.png');
  const before = JSON.parse(await ev(stateProbe));
  console.log('  ', before.stats, 'label=', before.label, 'hasNext=', before.hasNext);

  console.log('[2] 真实鼠标点「下一张」（右箭头）');
  if (!before.rect) throw new Error('没有右箭头按钮');
  console.log('  命中测试:', await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^Next/.test(x.getAttribute('title') || ''));
    const r = b.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return JSON.stringify({ btn: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], x, y,
      hitTag: hit ? hit.tagName : null, hitIsBtnOrChild: !!(hit && hit.closest('button')) });
  })()`));
  await realClick(before.rect.x, before.rect.y);
  const after = JSON.parse(await ev(stateProbe));
  console.log('  before:', before.stats, '(label', before.label + ', tab=' + before.tabTitle + ') → after:', after.stats, '(label', after.label + ', tab=' + after.tabTitle + ')');
  console.log('  click 实际落点:', after.clicks);
  await shot('img_after_next.png');
  // shot 之后布局又变了，重新量左箭头坐标
  const after2 = JSON.parse(await ev(stateProbe));

  console.log('[3] 点「上一张」两次');
  await realClick(after2.prevRect.x, after2.prevRect.y);
  const back1 = JSON.parse(await ev(stateProbe));
  await realClick(back1.prevRect.x, back1.prevRect.y);
  const back2 = JSON.parse(await ev(stateProbe));
  console.log('  一次:', back1.stats, 'label', back1.label, '| 两次:', back2.stats, 'label', back2.label);

  const ok = /^\d$/.test(before.label || '') &&
    /^\d$/.test(after.label || '') &&
    ((+after.label === +before.label % 3 + 1)) &&
    back1.label === before.label &&
    (after.tabTitle || '').includes(after.label + '/3') &&
    (back1.tabTitle || '').includes(before.label + '/3');
  console.log('\n[4] 回归：画布拖拽平移不能被这次改动带坏');
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Zoom in|放大/i.test(x.getAttribute('title') || '')); b && b.click(); b && b.click(); return !!b; })()`);
  await sleep(500);
  const dragBefore = await ev(`document.querySelector('img.pointer-events-none').style.transform`);
  const c = JSON.parse(await ev(`(() => { const cv = document.querySelector('button[title^="Next"]').parentElement;
    const r = cv.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x - 12 * i, y: c.y + 6 * i, button: 'left', buttons: 1 });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x - 48, y: c.y + 24, button: 'left', clickCount: 1 });
  await sleep(400);
  const dragAfter = await ev(`document.querySelector('img.pointer-events-none').style.transform`);
  const dragOk = dragBefore !== dragAfter;
  console.log('  拖拽前:', dragBefore, '\n  拖拽后:', dragAfter, '\n  拖拽生效:', dragOk);

  console.log('\n结果：', ok && dragOk ? 'PASS 左右切图生效 + 拖拽未受影响' : 'FAIL（切图 ' + ok + ' / 拖拽 ' + dragOk + '）');
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  try { ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  process.exit(0);
}
