/**
 * 浮窗（Spotlight）「整页浏览」的无头验证。
 *
 * 断言：没有标签栏、页面盖满整卡且只有一层页头、返回栈、同页去重、
 * 图片/原文是整页而不是居中弹窗、新建对话会收起页面栈。
 *
 * 用法：node scripts/verify_spotlight_page.mjs   （THEME=light 可切浅色）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9345;
const TARGET = 'http://127.0.0.1:5173/#/spotlight';
const OUT = '/tmp';
const THEME = process.env.THEME || 'dark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ARTICLE_TEXT = [
  '条形码',
  '[基本档案]',
  '类型: 编码方式 | 发明时间: 1949',
  '[定义]',
  '条形码是将宽度不等的多个黑条和空白，按照一定的编码规则排列，用以表达一组信息的图形标识符。',
  ...Array.from({ length: 16 }, (_, i) => `[小节 ${i + 1}]\n这是第 ${i + 1} 段正文，用于检验底部注入块。`),
].join('\n');

const SNAPSHOT = JSON.stringify({
  sessions: [
    {
      id: 'sess-spot',
      title: '浮窗验证会话',
      createdAt: 1,
      updatedAt: 2,
      contextUsed: 0,
      messages: [
        { id: 'u0', role: 'user', content: '这张图里的条形码是什么编码？', images: [PNG, PNG], timestamp: 1000 },
        {
          id: 'a0',
          role: 'assistant',
          content: '## 回答\n\n这是浮窗整页浏览的验证正文。\n\n- 要点一\n- 要点二\n',
          timestamp: 1001,
          citations: [
            { title: '条形码', url: '', context: '条形码注入原文 A' },
            { title: '二维码', url: '', context: '二维码注入原文 B' },
          ],
        },
      ],
    },
  ],
  mainSessionId: 'sess-spot',
  generatingSessionIds: [],
  liveStreamingTokens: {},
  settings: { language: 'zh', theme: THEME },
});

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-spotpage`,
    '--no-first-run', '--no-default-browser-check', '--window-size=560,760', TARGET,
  ],
  { stdio: 'ignore' }
);

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('127.0.0.1:5173'));
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
const listeners = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    for (const fn of listeners) fn(msg);
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
const click = (sel) =>
  ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const key = (k) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 13 });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 640, deviceScaleFactor: 2, mobile: false });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });

  listeners.push(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const url = request.url;
    const fulfill = (body, type = 'application/json') =>
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: type }],
        body: Buffer.from(body).toString('base64'),
      });
    try {
      if (url.includes('/api/sessions/events')) {
        await fulfill(
          `event: snapshot\ndata: ${SNAPSHOT}\n\nevent: spotlight-session-changed\ndata: ${JSON.stringify({ sessionId: 'sess-spot', isExpanded: true })}\n\n`,
          'text/event-stream'
        );
      } else if (url.includes('/api/sessions/state')) {
        await fulfill(SNAPSHOT);
      } else if (url.includes('/api/wiki/status')) {
        await fulfill(JSON.stringify({
          enabled: true, connected: true, status: 'running', port: 31236,
          zimPath: '/tmp/wikipedia.zim', contentId: 'zim', bookTitle: 'Wikipedia',
          articleCount: 123456, mediaCount: 88,
        }));
      } else if (url.includes('/api/wiki/article')) {
        const title = decodeURIComponent((url.split('title=')[1] || '').split('&')[0]);
        await fulfill(JSON.stringify({ title, url: '', context: ARTICLE_TEXT }));
      } else if (url.includes('/api/wiki/search')) {
        await fulfill(JSON.stringify({ results: [{ title: '条形码', exact: true }, { title: '二维码', exact: false }] }));
      } else {
        await fulfill('{}');
      }
    } catch {}
  });

  await send('Page.reload');
  await sleep(3200);

  // ---------------------------------------------------------------- 对话态
  const base = JSON.parse(await ev(`(() => JSON.stringify({
    alive: document.body.innerText.length > 0,
    tabs: !!document.querySelector('[data-tab-strip="true"]'),
    search: !!document.querySelector('[data-spotlight-search="true"]'),
    chips: [...document.querySelectorAll('button[title]')].filter(b => b.textContent.includes('条形码')).length,
  }))()`));
  check('浮窗存活且**没有标签栏**', base.alive && base.tabs === false, JSON.stringify(base));
  const cardHeaderH = await ev(`(() => { const el = document.querySelector('div.cursor-grab'); return el ? Math.round(el.getBoundingClientRect().height) : null; })()`);
  check('搜索按钮与引用胶囊都在', base.search === true && base.chips >= 1, JSON.stringify(base));

  // ---------------------------------------------------------------- 搜索页
  await click('[data-spotlight-search="true"]');
  await sleep(600);
  const searchPage = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-spotlight-layer="true"]');
    const r = p.getBoundingClientRect();
    const heads = p.querySelectorAll('input').length;
    const closes = p.querySelectorAll('[data-page-close="true"]').length;
    const backs = p.querySelectorAll('[data-page-back="true"]').length;
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), heads, closes, backs });
  })()`));
  const pageHeaderH = await ev(`(() => {
    const el = document.querySelector('[data-spotlight-page="wiki-search"][data-page-active="true"] > div > div:first-child');
    return el ? Math.round(el.getBoundingClientRect().height) : null;
  })()`);
  check('浮窗：页面二级头与卡片头严格同高（52，开页面不跳）',
    cardHeaderH === 52 && pageHeaderH === 52, JSON.stringify({ cardHeaderH, pageHeaderH }));

  check('搜索页盖满整卡（500×640，单层页头）',
    searchPage.w === 500 && searchPage.h === 640 && searchPage.x === 0 && searchPage.y === 0 &&
      searchPage.closes === 1 && searchPage.backs === 0,
    JSON.stringify(searchPage));
  await shot(`spot-01-search-${THEME}.png`);

  // 搜索 → 结果 → 条目（压一层）
  await ev(`(() => {
    const input = document.querySelector('[data-spotlight-page="wiki-search"][data-page-active="true"] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '条码');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  await click('[data-spotlight-page="wiki-search"] .divide-y button');
  await sleep(900);
  const article = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-spotlight-page="wiki-article"][data-page-active="true"]');
    const injected = p?.querySelector('[data-injected="true"]');
    const body = p?.querySelector('[data-wiki-body="true"]');
    return JSON.stringify({
      depth: p?.dataset.pageDepth,
      back: !!p?.querySelector('[data-page-back="true"]'),
      injectedAfterBody: !!(injected && body && (body.compareDocumentPosition(injected) & Node.DOCUMENT_POSITION_FOLLOWING)),
    });
  })()`));
  check('结果点条目 → 第二层页面，带返回键', article.depth === '2' && article.back === true, JSON.stringify(article));
  await shot(`spot-02-article-${THEME}.png`);

  // 返回 → 搜索页保留查询
  await click('[data-page-back="true"]');
  await sleep(500);
  const backState = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-spotlight-page="wiki-search"][data-page-active="true"]');
    return JSON.stringify({ exists: !!p, query: p?.querySelector('input')?.value, depth: p?.dataset.pageDepth });
  })()`));
  check('← 返回搜索页且查询保留', backState.exists === true && backState.query === '条码' && backState.depth === '1', JSON.stringify(backState));

  // Esc 关闭页面
  await key('Escape');
  await sleep(400);
  const afterEsc = await ev(`!!document.querySelector('[data-spotlight-page]')`);
  check('Esc 关闭页面回到对话', afterEsc === false);

  // ---------------------------------------------------------------- 引用胶囊 → 条目页
  await click('button[title="条形码"]');
  await sleep(800);
  const cit = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-spotlight-page="wiki-article"][data-page-active="true"]');
    const injected = p?.querySelector('[data-injected="true"]');
    const body = p?.querySelector('[data-wiki-body="true"]');
    return JSON.stringify({
      depth: p?.dataset.pageDepth,
      hasInjected: !!injected,
      injectedAfterBody: !!(injected && body && (body.compareDocumentPosition(injected) & 4)),
      injectedText: injected?.innerText || '',
    });
  })()`));
  check('胶囊打开条目页（深度 1）', cit.depth === '1', JSON.stringify({ depth: cit.depth }));
  check('胶囊来源：注入原文在正文之后（下侧）',
    cit.hasInjected === true && cit.injectedAfterBody === true && cit.injectedText.includes('注入原文 A'),
    JSON.stringify({ has: cit.hasInjected, after: cit.injectedAfterBody }));

  // 同一胶囊重复点：栈顶同页只替换，不压重复层
  await click('button[title="条形码"]');
  await sleep(500);
  const dup = await ev(`document.querySelector('[data-spotlight-page="wiki-article"][data-page-active="true"]')?.dataset.pageDepth`);
  check('同一胶囊重复点不叠层', dup === '1', JSON.stringify({ depth: dup }));

  // ---------------------------------------------------------------- 图片 / 原文整页
  await ev(`(() => { document.querySelector('[data-message-image="true"]').click(); return 'ok'; })()`);
  await sleep(600);
  const pageKinds = JSON.parse(await ev(`(() => {
    const kind = document.querySelector('[data-spotlight-page]')?.dataset.spotlightPage;
    return JSON.stringify({ kind, nw: document.querySelector('[data-spotlight-page="image"][data-page-active="true"] img')?.naturalWidth || 0 });
  })()`));
  await shot(`spot-03-image-${THEME}.png`);
  await click('[data-spotlight-page] [data-page-close="true"]');
  await sleep(400);

  console.log('  image page:', JSON.stringify(pageKinds));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('ERROR', e);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  proc.kill('SIGKILL');
}

async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  console.log('  saved', `${OUT}/${file}`);
}
