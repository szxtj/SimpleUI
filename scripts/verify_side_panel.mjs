/**
 * 右侧面板（浏览器式多标签）的无头验证 · P0。
 *
 * 用 CDP 拦截 /api/sessions/* 与 /api/wiki/* 注入合成数据，然后断言：
 * 面板开合、`+` 单例、胶囊去重、注入原文在正文之后、参考文本跳转、
 * 搜索页 → 条目页开新标签、切标签不丢状态、关闭语义、标签栏几何。
 *
 * 用法：node scripts/verify_side_panel.mjs            （THEME=light 可切浅色）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9341;
const TARGET = 'http://127.0.0.1:5173/';
const OUT = '/tmp';
const THEME = process.env.THEME || 'dark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARTICLE_TEXT = [
  '条形码',
  '[基本档案]',
  '类型: 编码方式 | 发明时间: 1949 | 应用: 零售、物流',
  '[定义]',
  '条形码是将宽度不等的多个黑条和空白，按照一定的编码规则排列，用以表达一组信息的图形标识符。',
  '· 一维条码：只在一个方向表达信息，如 EAN-13。',
  '· 二维条码：在两个方向表达信息，如 QR 码、PDF417。',
  ...Array.from({ length: 24 }, (_, i) => `[小节 ${i + 1}]\n这是第 ${i + 1} 段正文，用于把条目撑长，检验底部注入块与跳转按钮。`),
  '[参考公式]',
  '信噪比的近似表达为 \uE000tex|\\mathrm{SNR}=10\\log_{10}\\frac{P_s}{P_n}\uE001 。',
].join('\n');

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SNAPSHOT = JSON.stringify({
  sessions: [
    {
      id: 'sess-panel',
      title: '面板验证会话',
      createdAt: 1,
      updatedAt: 2,
      contextUsed: 0,
      messages: [
        {
          id: 'u0',
          role: 'user',
          content: '这张图里的条形码是什么编码？',
          images: [PNG, PNG],
          timestamp: 1000,
        },
        {
          id: 'a0',
          role: 'assistant',
          content: '## 回答\n\n这是一段用于验证面板的回答正文。\n\n- 要点一\n- 要点二\n',
          timestamp: 1001,
          citations: [
            { title: '条形码', url: 'http://127.0.0.1:31236/wiki/条形码', context: '条形码（barcode）注入原文 A：用于验证注入块位置。' },
            { title: '二维码', url: 'http://127.0.0.1:31236/wiki/二维码', context: '二维码（QR code）注入原文 B。' },
          ],
        },
      ],
    },
  ],
  mainSessionId: 'sess-panel',
  generatingSessionIds: [],
  liveStreamingTokens: {},
  settings: { language: 'zh', theme: THEME },
});

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-panel`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', TARGET,
  ],
  { stdio: 'ignore' }
);

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('127.0.0.1:5173')
      );
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

async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  console.log('  saved', `${OUT}/${file}`);
}

/** 用 JS 原生 click 触发（React 合成事件照样能收到） */
const click = (sel) =>
  ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
};

/** 知识库服务可用性开关：末段置 true 模拟「服务未就绪」 */
let wikiDown = false;

const fetchListener = async (msg) => {
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
      await fulfill(`event: snapshot\ndata: ${SNAPSHOT}\n\n`, 'text/event-stream');
    } else if (url.includes('/api/sessions/state')) {
      await fulfill(SNAPSHOT);
    } else if (url.includes('/api/wiki/status')) {
      await fulfill(JSON.stringify({
        enabled: true,
        connected: !wikiDown,
        status: wikiDown ? 'stopped' : 'running',
        port: 31236,
        zimPath: wikiDown ? null : '/tmp/wikipedia.zim',
        contentId: wikiDown ? null : 'zim',
        bookTitle: 'Wikipedia',
        articleCount: wikiDown ? 0 : 123456,
        mediaCount: wikiDown ? 0 : 88,
      }));
    } else if (url.includes('/api/wiki/article')) {
      const title = decodeURIComponent((url.split('title=')[1] || '').split('&')[0]);
      await fulfill(wikiDown ? '{}' : JSON.stringify({ title, url: '', context: ARTICLE_TEXT }));
    } else if (url.includes('/api/wiki/search')) {
      await fulfill(wikiDown ? '{}' : JSON.stringify({
        results: [
          { title: '条形码', exact: true },
          { title: '二维码', exact: false },
          { title: '条形码扫描器', exact: false },
        ],
      }));
    } else {
      await fulfill('{}');
    }
  } catch {}
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 2, mobile: false,
  });

  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }],
  });

  listeners.push(fetchListener);

  // 面板宽度是持久化的（上个用例可能留下 360）：在新文档里、React 挂载前清掉，保证从 440 起测
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem('simpleui_side_panel_width') } catch (e) {}`,
  });
  await send('Page.reload');
  await sleep(3200);

  // ---------------------------------------------------------------- 初始：面板收起
  const init = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    return JSON.stringify({
      alive: document.body.innerText.length > 0,
      panel: p ? Math.round(p.getBoundingClientRect().width) : -1,
      toggle: !!document.querySelector('[data-panel-toggle="true"]'),
      chips: [...document.querySelectorAll('button[title]')].filter(b => b.textContent.includes('条形码') || b.textContent.includes('二维码')).length,
    });
  })()`));
  check('页面存活 & 面板初始收起', init.alive && init.panel === 0, JSON.stringify(init));
  check('顶栏面板开关存在', init.toggle === true);

  // ---------------------------------------------------------------- 侧边栏开合：窗口联动 + 遮罩
  await ev(`(() => {
    window.__grow = [];
    window.webkit = window.webkit || {};
    window.webkit.messageHandlers = window.webkit.messageHandlers || {};
    window.webkit.messageHandlers.growWindow = { postMessage: (m) => { window.__grow.push(m); } };
    return 'ok';
  })()`);

  // 收起左栏：应通知原生向左收缩 260，并给中部盖遮罩
  await click('[data-sidebar-toggle="true"]');
  await sleep(120);
  const leftClosing = JSON.parse(await ev(`(() => {
    const veil = document.querySelector('[data-chat-resize-veil="true"]');
    const pill = document.querySelector('[data-chat-size-pill="true"]');
    return JSON.stringify({
      grew: window.__grow,
      chatVeil: !!veil,
      pill: pill ? pill.textContent.trim() : null,
      panelVeil: !!document.querySelector('[data-panel-resize-veil="true"]'),
    });
  })()`));
  check('收起左栏：窗口本来就够宽 → 不动窗口（growWindow 一次都不发）',
    leftClosing.grew.length === 0, JSON.stringify(leftClosing.grew));
  check('收起左栏：中部盖遮罩，且不显示尺寸胶囊',
    leftClosing.chatVeil === true && leftClosing.pill === null,
    JSON.stringify({ veil: leftClosing.chatVeil, pill: leftClosing.pill }));

  // 开合结束后也要"多盖一会儿"再淡出：240ms（过渡结束）+ 140ms hold 之内必须还是不透明
  await sleep(160);
  const toggleHold = JSON.parse(await ev(`(() => {
    const cv = document.querySelector('[data-chat-resize-veil="true"]');
    return JSON.stringify({
      mounted: !!cv,
      visible: cv ? cv.dataset.veilVisible : null,
      opacity: cv ? getComputedStyle(cv).opacity : null,
      busy: !!document.querySelector('[data-chat-resize-veil="true"][data-veil-visible="true"]'),
    });
  })()`));
  check('开合结束后遮罩仍保持不透明（hold），不会一点完就闪掉',
    toggleHold.mounted === true && toggleHold.visible === 'true' && toggleHold.opacity === '1',
    JSON.stringify(toggleHold));
  await sleep(500);
  await shot(`panel-07-left-collapsed-${THEME}.png`);

  // 再展开左栏：+260 向左长
  await click('[data-sidebar-toggle="true"]');
  await sleep(120);
  const leftOpening = JSON.parse(await ev(`JSON.stringify(window.__grow)`));
  check('展开左栏：中部仍够宽 → 依旧不动窗口',
    leftOpening.length === 0, JSON.stringify(leftOpening));
  await sleep(500);

  // ---------------------------------------------------------------- 打开面板 = 搜索页
  await click('[data-panel-toggle="true"]');
  await sleep(110);
  const midSlide = JSON.parse(await ev(`(() => {
    const aside = document.querySelector('[data-side-panel="true"]');
    const surface = document.querySelector('[data-panel-surface="true"]');
    return JSON.stringify({
      asideW: Math.round(aside.getBoundingClientRect().width),
      surfaceW: Math.round(surface.getBoundingClientRect().width),
      transform: getComputedStyle(surface).transform,
      grew: window.__grow,
      panelVeil: !!document.querySelector('[data-panel-resize-veil="true"]'),
      chatVeil: !!document.querySelector('[data-chat-resize-veil="true"]'),
      panelPill: document.querySelector('[data-panel-size-pill="true"]')?.textContent.trim() || null,
      chatPill: document.querySelector('[data-chat-size-pill="true"]')?.textContent.trim() || null,
    });
  })()`));
  await sleep(500);
  const opened = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    const strip = document.querySelector('[data-tab-strip="true"]');
    const pr = p.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    return JSON.stringify({
      width: Math.round(pr.width),
      stripH: Math.round(sr.height),
      stripTop: Math.round(sr.top),
      tabs: [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId),
      input: !!document.querySelector('[data-page-host="wiki-search"] input'),
    });
  })()`));
  check('面板展开为 440 宽', opened.width === 440, `width=${opened.width}`);
  check('标签栏高 52 且贴顶', opened.stripH === 52 && opened.stripTop === 0, JSON.stringify({ h: opened.stripH, top: opened.stripTop }));
  check('无标签点开关 → 直接给一个搜索页', opened.tabs.length === 1 && opened.tabs[0] === 'wiki:search', JSON.stringify(opened.tabs));
  check('搜索页有搜索输入框', opened.input === true);

  check('展开右栏动画中途：外层在长、内层整块宽度不变（滑入而非缩放）',
    midSlide.asideW < 440 && Math.abs(midSlide.surfaceW - 440) <= 2 && midSlide.transform !== 'none',
    JSON.stringify(midSlide));
  check('展开右栏：只盖中部遮罩（右栏整块滑入），且没有尺寸胶囊',
    midSlide.chatVeil === true && midSlide.panelVeil === false &&
      midSlide.panelPill === null && midSlide.chatPill === null,
    JSON.stringify({ panelVeil: midSlide.panelVeil, chat: midSlide.chatVeil }));
  check('展开右栏：中部 580 ≥ 460 → 不动窗口',
    midSlide.grew.length === 0, JSON.stringify(midSlide.grew));
  await shot(`panel-01-open-${THEME}.png`);

  // ---------------------------------------------------------------- `+` 单例
  await click('[data-new-tab="true"]');
  await click('[data-new-tab="true"]');
  await sleep(300);
  const afterPlus = JSON.parse(await ev(
    `JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId))`
  ));
  check('`+` 连点 2 次不新增搜索页（单例）', afterPlus.length === 1, JSON.stringify(afterPlus));

  // ---------------------------------------------------------------- 左沿拖拽改宽
  await ev(`(() => {
    window.__panelWidthSent = null;
    window.webkit = window.webkit || {};
    window.webkit.messageHandlers = window.webkit.messageHandlers || {};
    window.webkit.messageHandlers.setPanelWidth = { postMessage: (w) => { window.__panelWidthSent = w; } };
    return 'ok';
  })()`);
  await sleep(400); // 等展开动画停稳，再量把手位置与起始宽度
  const hRect = JSON.parse(await ev(`(() => {
    const h = document.querySelector('[data-panel-resize="true"]');
    const r = h.getBoundingClientRect();
    const panel = document.querySelector('[data-side-panel="true"]');
    const left = document.querySelector('[data-left-sidebar="true"]')?.getBoundingClientRect().width || 0;
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: 420,
      startW: Math.round(panel.getBoundingClientRect().width),
      maxW: Math.min(820, window.innerWidth - left - 460),
    });
  })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hRect.x, y: hRect.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hRect.x - 160, y: hRect.y, button: 'left', buttons: 1 });
  await sleep(250);
  const live = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    return JSON.stringify({ w: Math.round(p.getBoundingClientRect().width), transition: getComputedStyle(p).transitionProperty });
  })()`));

  // 拖拽中（松手之前）：两块遮罩 + 胶囊 + 两边内容都冻结
  const veilState = JSON.parse(await ev(`(() => {
    const veil = document.querySelector('[data-panel-resize-veil="true"]');
    const chatVeil = document.querySelector('[data-chat-resize-veil="true"]');
    const host = document.querySelector('[data-page-host]');
    const chat = document.querySelector('.chat-container');
    return JSON.stringify({
      veil: !!veil,
      pill: veil ? veil.innerText.trim() : null,
      contentHidden: host ? getComputedStyle(host.parentElement).contentVisibility : null,
      chatVeil: !!chatVeil,
      chatFrozen: chat ? chat.classList.contains('freeze-children') : null,
    });
  })()`));

  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hRect.x - 160, y: hRect.y, button: 'left', buttons: 0 });
  // 松手后先"保持不透明"一小段（hold），再开始淡出：
  // 这样内容在遮罩下完成重排，不会出现"遮罩先没了、内容还在跳"的闪现
  await sleep(60);
  const holdState = JSON.parse(await ev(`(() => {
    const pv = document.querySelector('[data-panel-resize-veil="true"]');
    const cv = document.querySelector('[data-chat-resize-veil="true"]');
    return JSON.stringify({
      panelVisible: pv ? pv.dataset.veilVisible : null,
      chatVisible: cv ? cv.dataset.veilVisible : null,
      panelOpacity: pv ? getComputedStyle(pv).opacity : null,
      chatOpacity: cv ? getComputedStyle(cv).opacity : null,
    });
  })()`));
  check('松手后遮罩先保持不透明（hold 期），不立刻淡出',
    holdState.panelVisible === 'true' && holdState.chatVisible === 'true' &&
      holdState.panelOpacity === '1' && holdState.chatOpacity === '1',
    JSON.stringify(holdState));

  await sleep(200);
  const resized = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    return JSON.stringify({
      w: Math.round(p.getBoundingClientRect().width),
      stored: localStorage.getItem('simpleui_side_panel_width'),
      sent: window.__panelWidthSent,
    });
  })()`));
  check('拖把手时面板实时变宽（拖拽中无过渡，且不越过中部最小宽度）',
    Math.abs(live.w - Math.min(hRect.startW + 160, hRect.maxW)) <= 2 && live.transition === 'none',
    JSON.stringify({ live, start: hRect.startW, max: hRect.maxW }));

  check('拖拽中：面板遮罩 + 尺寸胶囊 + 面板内容暂停渲染',
    veilState.veil && /\d+ px/.test(veilState.pill || '') && veilState.contentHidden === 'hidden',
    JSON.stringify(veilState));
  check('拖拽中：对话区也盖遮罩',
    veilState.chatVeil === true, JSON.stringify(veilState));
  // 淡出时序：hold 结束后遮罩仍在（可见性已切 0），再淡出后才彻底移除
  const fadeMid = JSON.parse(await ev(`(() => {
    const pv = document.querySelector('[data-panel-resize-veil="true"]');
    const cv = document.querySelector('[data-chat-resize-veil="true"]');
    return JSON.stringify({
      panel: pv ? pv.dataset.veilVisible : null,
      chat: cv ? cv.dataset.veilVisible : null,
      panelOpacity: pv ? getComputedStyle(pv).opacity : null,
    });
  })()`));
  check('松手后遮罩先转透明（淡出过程中仍盖着）',
    fadeMid.panel === 'false' && fadeMid.chat === 'false',
    JSON.stringify(fadeMid));

  await sleep(500);
  const veilGone = await ev(`!document.querySelector('[data-panel-resize-veil="true"]') && !document.querySelector('[data-chat-resize-veil="true"]')`);
  check('淡出结束后两块遮罩都卸载', veilGone === true);

  check('松手写 localStorage 并通知原生 setPanelWidth',
    Math.abs(resized.w - live.w) <= 1 && Number(resized.stored) === resized.w && resized.sent === resized.w,
    JSON.stringify(resized));

  // 双击复位
  await ev(`(() => { document.querySelector('[data-panel-resize="true"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  const resetW = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    return JSON.stringify({ w: Math.round(p.getBoundingClientRect().width), stored: localStorage.getItem('simpleui_side_panel_width') });
  })()`));
  check('双击把手复位 440', resetW.w === 440 && resetW.stored === '440', JSON.stringify(resetW));

  // ---------------------------------------------------------------- 引用胶囊 → 条目页
  await click('button[title="条形码"]');
  await sleep(900);
  const art = JSON.parse(await ev(`(() => {
    const page = document.querySelector('[data-page="wiki-article"]');
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    const injected = page?.querySelector('[data-injected="true"]');
    const body = page?.querySelector('[data-wiki-body="true"]');
    const jump = page?.querySelector('[data-jump-injected="true"]');
    return JSON.stringify({
      tabs,
      hasInjected: !!injected,
      injectedAfterBody: !!(injected && body && (body.compareDocumentPosition(injected) & Node.DOCUMENT_POSITION_FOLLOWING)),
      jump: !!jump,
      injectedText: injected?.innerText || '',
    });
  })()`));
  check('点胶囊开新标签（搜索 + 条目）', art.tabs.length === 2 && art.tabs.includes('wiki:article:条形码'), JSON.stringify(art.tabs));
  check('条目页存在注入原文块', art.hasInjected === true);
  check('注入原文在正文之后（下侧）', art.injectedAfterBody === true);
  check('页头有「参考文本 ↓」跳转', art.jump === true);
  check('注入块内容为胶囊原文', art.injectedText.includes('注入原文 A'), art.injectedText.slice(0, 40));

  const heights = JSON.parse(await ev(`(() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    return JSON.stringify({
      chatHeader: h(document.querySelector('.chat-container > div')),
      strip: h(document.querySelector('[data-tab-strip="true"]')),
      pageHeader: h(document.querySelector('[data-page="wiki-article"]')?.firstElementChild),
      pageHeaderBg: getComputedStyle(document.querySelector('[data-page="wiki-article"]')?.firstElementChild).backgroundColor,
    });
  })()`));
  check('页面二级头与标签栏 / 对话顶栏严格同高（52）',
    heights.strip === 52 && heights.pageHeader === 52 && heights.chatHeader === 52, JSON.stringify(heights));
  check('页面二级头与标签栏同材质（半透明底 + 模糊）',
    /rgba\((248, 249, 251|24, 25, 28)/.test(heights.pageHeaderBg), heights.pageHeaderBg);
  await shot(`panel-02-article-${THEME}.png`);

  // ---------------------------------------------------------------- 重复点同一胶囊
  await click('button[title="条形码"]');
  await sleep(400);
  const dup = JSON.parse(await ev(
    `JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId))`
  ));
  check('同一胶囊重复点不新增标签', dup.length === 2, JSON.stringify(dup));

  // ---------------------------------------------------------------- 第二个胶囊
  await click('button[title="二维码"]');
  await sleep(900);
  const third = JSON.parse(await ev(
    `JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId))`
  ));
  check('不同胶囊各开一页', third.length === 3 && third.includes('wiki:article:二维码'), JSON.stringify(third));

  // ---------------------------------------------------------------- 参考文本跳转
  const jumpBefore = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="wiki-article"]')].find(el => el.style.display !== 'none');
    const scroller = host.querySelector('.overflow-y-auto');
    scroller.scrollTop = 0;
    host.querySelector('[data-jump-injected="true"]').click();
    return JSON.stringify({
      top: Math.round(scroller.scrollTop),
      sh: scroller.scrollHeight,
      ch: scroller.clientHeight,
      cls: scroller.className.slice(0, 60),
    });
  })()`));
  await sleep(800);
  const jumpAfter = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="wiki-article"]')].find(el => el.style.display !== 'none');
    const scroller = host.querySelector('.overflow-y-auto');
    const injected = host.querySelector('[data-injected="true"]');
    const sr = scroller.getBoundingClientRect(), ir = injected.getBoundingClientRect();
    return JSON.stringify({ top: Math.round(scroller.scrollTop), visible: ir.top < sr.bottom && ir.bottom > sr.top });
  })()`));
  check('点「参考文本 ↓」后注入块进入视口', jumpAfter.top > 0 && jumpAfter.visible === true,
    JSON.stringify({ before: jumpBefore, after: jumpAfter }));

  // ---------------------------------------------------------------- 切标签保留搜索状态
  await click('[data-tab-id="wiki:search"]');
  await sleep(300);
  await ev(`(() => {
    const input = document.querySelector('[data-page-host="wiki-search"] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '条码');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(200);
  await ev(`(() => {
    const input = document.querySelector('[data-page-host="wiki-search"] input');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const searched = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-page-host="wiki-search"]');
    return JSON.stringify({
      rows: host.querySelectorAll('.divide-y button').length,
      text: host.innerText.includes('条形码'),
    });
  })()`));
  check('搜索页回车出结果', searched.rows === 3, JSON.stringify(searched));

  await ev(`(() => {
    const btns = [...document.querySelectorAll('[data-page-host="wiki-search"] .divide-y button')];
    (btns[btns.length - 1] || btns[0]).click();
    return 'ok';
  })()`);
  await sleep(900);
  const fromSearch = JSON.parse(await ev(
    `JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId))`
  ));
  check('搜索结果点条目 → 再开一页（重复命中已存在条目则只激活）',
    fromSearch.length === 4 && fromSearch.includes('wiki:article:条形码扫描器'), JSON.stringify(fromSearch));

  // 标签溢出：横向滚动条必须看得见（用户明确要求）
  const strip = JSON.parse(await ev(`(() => {
    const el = document.querySelector('[data-tab-strip="true"] .scrollbar-invisible');
    const bar = document.querySelector('[data-tab-scrollbar="true"]');
    const thumb = document.querySelector('[data-tab-scrollbar-thumb="true"]');
    const br = bar?.getBoundingClientRect();
    const tr = thumb?.getBoundingClientRect();
    return JSON.stringify({
      sw: el.scrollWidth, cw: el.clientWidth, hasBar: !!bar,
      thumbW: tr ? Math.round(tr.width) : 0, trackW: br ? Math.round(br.width) : 0,
      trackY: br ? Math.round(br.top) : 0,
    });
  })()`));
  check('标签溢出时出现可拖动的横向滚动条',
    strip.sw > strip.cw && strip.hasBar && strip.thumbW > 0 && strip.thumbW < strip.trackW,
    JSON.stringify(strip));
  {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 840, y: 0, width: 440, height: 56, scale: 2 },
    });
    fs.writeFileSync(`${OUT}/panel-tabbar-${THEME}.png`, Buffer.from(r.data, 'base64'));
    console.log('  saved', `${OUT}/panel-tabbar-${THEME}.png`);
  }

  // Esc 不关标签（按用户要求：主窗口不做这个快捷键）
  const beforeEsc = await ev(`document.querySelectorAll('[data-tab-id]').length`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  const afterEsc = await ev(`document.querySelectorAll('[data-tab-id]').length`);
  check('Esc 不会关闭标签', beforeEsc === afterEsc, JSON.stringify({ before: beforeEsc, after: afterEsc }));

  // 切回搜索页：关键词与结果仍在（keep-mounted）
  await click('[data-tab-id="wiki:search"]');
  await sleep(300);
  const persisted = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-page-host="wiki-search"]');
    return JSON.stringify({ value: host.querySelector('input').value, rows: host.querySelectorAll('.divide-y button').length });
  })()`));
  check('切走再切回，关键词与结果都还在', persisted.value === '条码' && persisted.rows === 3, JSON.stringify(persisted));
  await shot(`panel-03-search-${THEME}.png`);

  // ---------------------------------------------------------------- 关闭语义
  await ev(`(() => {
    const t = [...document.querySelectorAll('[data-tab-id]')].find(e => e.dataset.tabId === 'wiki:article:二维码');
    t.click(); return 'ok';
  })()`);
  await sleep(200);
  await ev(`(() => { document.querySelector('[data-tab-id="wiki:article:二维码"] [data-tab-close]').click(); return 'ok'; })()`);
  await sleep(400);
  const afterClose = JSON.parse(await ev(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    const active = document.querySelector('[data-tab-id][aria-selected="true"]')?.dataset.tabId;
    const p = document.querySelector('[data-side-panel="true"]');
    return JSON.stringify({ tabs, active, width: Math.round(p.getBoundingClientRect().width) });
  })()`));
  check('关激活标签 → 右邻接管（无右邻取左邻）且面板仍在',
    !afterClose.tabs.includes('wiki:article:二维码') &&
      afterClose.active === 'wiki:article:条形码扫描器' && afterClose.width === 440,
    JSON.stringify(afterClose));

  // 关完 → 面板收起
  for (let i = 0; i < 3; i++) {
    await ev(`(() => { const b = document.querySelector('[data-tab-id] [data-tab-close]'); b && b.click(); return 'ok'; })()`);
    await sleep(350);
  }
  await sleep(900);
  const empty = JSON.parse(await ev(`(() => {
    const p = document.querySelector('[data-side-panel="true"]');
    const cs = getComputedStyle(p);
    return JSON.stringify({
      width: Math.round(p.getBoundingClientRect().width),
      offset: p.offsetWidth,
      css: cs.width,
      tabs: document.querySelectorAll('[data-tab-id]').length,
    });
  })()`));
  check('关掉最后一个标签 → 面板收起', empty.offset === 0 && empty.tabs === 0, JSON.stringify(empty));

  // ---------------------------------------------------------------- 原文页
  await click('[data-panel-toggle="true"]');
  await sleep(500);
  await click('[data-open-raw="true"]');
  await sleep(500);
  await click('[data-open-raw="true"]');
  await sleep(400);
  const raw = JSON.parse(await ev(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    const body = document.querySelector('[data-raw-body="true"]');
    return JSON.stringify({ tabs, text: body?.innerText || '', active: document.querySelector('[data-tab-id][aria-selected="true"]')?.dataset.tabId });
  })()`));
  check('点原文开「原文」页（连点不重复）',
    raw.tabs.length === 2 && raw.tabs.includes('raw:a0') && raw.active === 'raw:a0', JSON.stringify(raw.tabs));
  check('原文页内容与消息正文一致', raw.text.includes('这是一段用于验证面板的回答正文'), raw.text.slice(0, 30));
  const rawTools = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="raw-text"]')].find(el => el.style.display !== 'none');
    return JSON.stringify({
      copy: !!host.querySelector('[data-raw-copy="true"]'),
      hint: /划选|Drag to select/.test(host.innerText),
      stats: /字符|characters/.test(host.innerText),
    });
  })()`));
  check('原文页保留复制全部 / 字数统计 / 脚注', rawTools.copy && rawTools.hint && rawTools.stats, JSON.stringify(rawTools));

  // ---------------------------------------------------------------- 图片页
  await ev(`(() => { document.querySelectorAll('[data-message-image="true"]')[0].click(); return 'ok'; })()`);
  await sleep(600);
  await ev(`(() => { document.querySelectorAll('[data-message-image="true"]')[0].click(); return 'ok'; })()`);
  await sleep(500);
  const img = JSON.parse(await ev(`(() => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')].map(e => e.dataset.tabId);
    const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
    const im = host?.querySelector('img');
    return JSON.stringify({ tabs, nw: im?.naturalWidth || 0, title: host?.innerText.slice(0, 20) });
  })()`));
  check('点图片开「图片」页（连点不重复）',
    img.tabs.length === 3 && img.tabs.includes('img:u0'), JSON.stringify(img.tabs));
  check('图片页真的渲染出位图', img.nw > 0, `naturalWidth=${img.nw}`);

  const imgTools = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
    const has = (c) => !!host.querySelector('.' + c);
    return JSON.stringify({
      zoomIn: has('lucide-zoom-in'), zoomOut: has('lucide-zoom-out'), copy: has('lucide-copy'),
      download: has('lucide-download'), external: has('lucide-external-link'),
      pct: (host.innerText.match(/(\\d+)%/) || [])[1],
    });
  })()`));
  check('图片页保留缩放 / 复制 / 下载 / 预览按钮',
    imgTools.zoomIn && imgTools.zoomOut && imgTools.copy && imgTools.download && imgTools.external,
    JSON.stringify(imgTools));

  // 等图片量到自然尺寸并应用了初始 transform（嵌入模式下首帧可能还没 ready）
  for (let i = 0; i < 20; i++) {
    const ready = await ev(`(() => {
      const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
      const im = host?.querySelector('img');
      return !!(im && im.style.transform && im.style.transform.includes('scale'));
    })()`);
    if (ready) break;
    await sleep(100);
  }

  // 点一次放大：比例与 transform 都要变（说明嵌入模式下缩放链路仍然生效）
  await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
    host.querySelector('.lucide-zoom-in').closest('button').click();
    return 'ok';
  })()`);
  await sleep(400);
  const zoomed = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
    const im = host.querySelector('img');
    return JSON.stringify({
      pct: (host.innerText.match(/(\\d+)%/) || [])[1],
      transform: im?.style.transform || '',
    });
  })()`));
  check('图片页可以放大（比例变化 + transform 生效）',
    Number(zoomed.pct) > Number(imgTools.pct || 100) && /scale\(/.test(zoomed.transform),
    JSON.stringify(zoomed));

  // 拖到最窄（360）：标题与尺寸全隐藏，只留图标
  const hRect2 = JSON.parse(await ev(`(() => {
    const h = document.querySelector('[data-panel-resize="true"]');
    const r = h.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: 420 });
  })()`));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hRect2.x, y: hRect2.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hRect2.x + 200, y: hRect2.y, button: 'left', buttons: 1 });
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hRect2.x + 200, y: hRect2.y, button: 'left', buttons: 0 });
  await sleep(500);
  const narrow = JSON.parse(await ev(`(() => {
    const host = [...document.querySelectorAll('[data-page-host="image"]')].find(el => el.style.display !== 'none');
    const spans = [...host.querySelectorAll('span')];
    const title = spans.find((s) => s.className.includes('truncate') && s.className.includes('font-semibold'));
    const stats = spans.find((s) => s.className.includes('font-mono') && s.innerText.includes('/'));
    const icon = host.querySelector('svg');
    return JSON.stringify({
      width: Math.round(document.querySelector('[data-side-panel="true"]').getBoundingClientRect().width),
      titleDisplay: title ? getComputedStyle(title).display : null,
      statsDisplay: stats ? getComputedStyle(stats).display : null,
      iconVisible: !!icon,
    });
  })()`));
  check('最窄时图片页只留图标（标题与尺寸隐藏）',
    narrow.width <= 361 && narrow.titleDisplay === 'none' && narrow.statsDisplay === 'none' && narrow.iconVisible,
    JSON.stringify(narrow));
  await shot(`panel-06-image-narrow-${THEME}.png`);
  await shot(`panel-05-image-${THEME}.png`);

  // ---------------------------------------------------------------- 未连接语义
  // 切回搜索页，再把 status 切成「未就绪」，等状态轮询（6s）落到前端
  await click('[data-tab-id="wiki:search"]');
  await sleep(400);
  wikiDown = true;
  await sleep(7000);
  const offline = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-page-host="wiki-search"]');
    return JSON.stringify({
      notice: /尚未就绪|未开启/.test(host.innerText),
      inputDisabled: host.querySelector('input')?.disabled === true,
    });
  })()`));
  check('服务不可用：搜索框仍在但禁用 + 统一提醒', offline.notice === true && offline.inputDisabled === true, JSON.stringify(offline));
  await shot(`panel-04-offline-${THEME}.png`);

  // ---------------------------------------------------------------- 窗口不够宽：只补缺口
  // 视口 1000：左 260 + 右 440 → 中部只剩 300，缺口 160
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const panelWNow = await ev(`Math.round(document.querySelector('[data-side-panel="true"]').getBoundingClientRect().width)`);
  const leftNow = await ev(`Math.round(document.querySelector('[data-left-sidebar="true"]').getBoundingClientRect().width)`);
  const shortfallExpected = Math.max(0, 460 - (1000 - leftNow - panelWNow));

  await ev(`window.__grow.length = 0`);
  // 面板此时是展开的（收起按钮在标签栏最右）；header 的开关键只在关闭时才渲染
  await click('[data-panel-collapse="true"]'); // 关掉右栏
  await sleep(450);
  const narrowClose = JSON.parse(await ev(`JSON.stringify({ grew: window.__grow })`));
  check('关右栏（中部变宽）不动窗口', narrowClose.grew.length === 0, JSON.stringify(narrowClose.grew));

  await ev(`window.__grow.length = 0`);
  await click('[data-panel-toggle="true"]'); // 再打开：中部会被压到 300，缺口 160
  await sleep(300);
  const narrowOpen = JSON.parse(await ev(`JSON.stringify({
    grew: window.__grow,
    middlePill: document.querySelector('[data-chat-size-pill="true"]')?.textContent.trim() || null,
  })`));
  check('窗口不够宽时：只扩出缺口那一段',
    shortfallExpected > 0 &&
      narrowOpen.grew.some((g) => Math.abs(g.delta - shortfallExpected) <= 2 && g.anchor === 'right') &&
      narrowOpen.middlePill === null,
    JSON.stringify({ ...narrowOpen, expected: shortfallExpected, panelW: panelWNow }));

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(300);

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
