/**
 * 「右侧定位横线 + 5 轮窗口化加载」的无头验证。
 *
 * 不依赖真实会话：用 CDP Fetch 拦截 /api/sessions/* 注入一份 12 轮的合成会话
 * （每轮含正文、代码块、公式、表格，制造真实高度差异），然后断言：
 * 挂载轮数、刻度三档长短、悬停预览、点击贴顶、滚轮整格滚动、按住放大/模糊/预览跟中心、
 * 拖拽方向（转表盘）、指针捕获不丢、滚回底部释放、连续上滚到开头、自然滚动抽搐。
 *
 * 用法：
 *   node scripts/verify_turn_rail.mjs            # 主窗口
 *   MODE=spot node scripts/verify_turn_rail.mjs  # Spotlight 浮窗
 *   THEME=light ...                              # 浅色主题
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9337;
const SPOT = process.env.MODE === 'spot';
const TARGET = SPOT ? 'http://127.0.0.1:5173/#/spotlight' : 'http://127.0.0.1:5173/';
const TAG = SPOT ? 'spot' : 'main';
const SLOT = SPOT ? 10 : 11;
const OUT = '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSnapshot() {
  const messages = [];
  for (let i = 0; i < 12; i++) {
    const lines = Array.from(
      { length: 5 + (i % 4) * 2 },
      (_, k) => `第 ${i + 1} 轮正文段落 ${k + 1}：用于制造真实高度差异。`
    ).join('\n\n');
    const code =
      i % 3 === 0
        ? '\n\n```ts\n' +
          Array.from({ length: 12 }, (_, k) => `const v${k} = compute(${i}, ${k});`).join('\n') +
          '\n```\n'
        : '';
    const math = i % 2 === 0 ? '\n\n$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$\n' : '';
    const table = i % 4 === 0 ? '\n\n| 项 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n' : '';
    messages.push({
      id: `u${i}`,
      role: 'user',
      content: `第 ${i + 1} 轮提问：定位横线与窗口化加载怎么验证？`,
      timestamp: 1000 + i * 10,
    });
    messages.push({
      id: `a${i}`,
      role: 'assistant',
      content: `## 第 ${i + 1} 轮回答\n\n${lines}${code}${math}${table}`,
      reasoningContent: `这是第 ${i + 1} 轮的思考过程，预览卡片里绝对不能出现。`,
      thinkingDuration: 1.2,
      timestamp: 1001 + i * 10,
    });
  }
  return {
    sessions: [
      { id: 'sess-verify', title: '横线验证会话', messages, createdAt: 1, updatedAt: 2, contextUsed: 0 },
    ],
    mainSessionId: 'sess-verify',
    generatingSessionIds: [],
    liveStreamingTokens: {},
    settings: { language: 'zh', theme: process.env.THEME || 'dark' },
  };
}

const SNAPSHOT = JSON.stringify(buildSnapshot());

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-rail-${TAG}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', TARGET,
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

async function shotClip(file, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 } });
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  console.log('  saved', `${OUT}/${file}`, JSON.stringify(clip));
}

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : 1,
    ...extra,
  });
}

/** 当前"最长的那枚刻度"= 中心轮下标 */
async function currentCenter() {
  const raw = await ev(`(() => {
    const cur = [...document.querySelectorAll('[data-turn-slot]')]
      .map(el => ({ i: Number(el.dataset.turnSlot), w: Math.round(el.firstElementChild?.getBoundingClientRect().width || 0) }))
      .sort((a, b) => b.w - a.w)[0];
    return JSON.stringify({ cur: cur?.i });
  })()`);
  return JSON.parse(raw).cur;
}

async function slotRect(idx) {
  return JSON.parse(await ev(`(() => {
    const el = document.querySelector('[data-turn-slot="${idx}"]');
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
}

async function tickTops() {
  return JSON.parse(await ev(`JSON.stringify(
    [...document.querySelectorAll('[data-turn-slot]')].map(el => parseFloat(el.style.top))
  )`));
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: SPOT ? 500 : 1280,
    height: SPOT ? 780 : 860,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/sessions/events*', requestStage: 'Request' },
      { urlPattern: '*/api/sessions/state*', requestStage: 'Request' },
      { urlPattern: '*/api/*', requestStage: 'Request' },
    ],
  });

  listeners.push(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const url = request.url;
    try {
      if (url.includes('/api/sessions/events')) {
        const body = SPOT
          ? `event: snapshot\ndata: ${SNAPSHOT}\n\nevent: spotlight-session-changed\ndata: ${JSON.stringify({ sessionId: 'sess-verify', isExpanded: true })}\n\n`
          : `event: snapshot\ndata: ${SNAPSHOT}\n\n`;
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }],
          body: Buffer.from(body).toString('base64'),
        });
      } else {
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(url.includes('/api/sessions/state') ? SNAPSHOT : '{}').toString('base64'),
        });
      }
    } catch {}
  });

  await send('Page.reload');
  await sleep(3500);

  const alive = JSON.parse(
    await ev(`JSON.stringify({ text: document.body.innerText.length, buttons: document.querySelectorAll('button').length })`)
  );
  check('页面存活', alive.text > 0 && alive.buttons > 0, JSON.stringify(alive));

  // ---------------------------------------------------------------- 基础窗口
  const d0 = JSON.parse(await ev(`(() => {
    const turns = [...document.querySelectorAll('[data-turn-index]')].map(el => ({ i: Number(el.dataset.turnIndex) }));
    const slots = [...document.querySelectorAll('[data-turn-slot]')].map(el => ({
      i: Number(el.dataset.turnSlot),
      w: Math.round(el.firstElementChild?.getBoundingClientRect().width || 0),
    }));
    const scroller = [...document.querySelectorAll('div')].find(el => el.className.includes('scrollbar-invisible'));
    const sr = scroller?.getBoundingClientRect();
    return JSON.stringify({ turns, slots, scroller: sr ? {
      barGap: scroller.offsetWidth - scroller.clientWidth,
      sbw: getComputedStyle(scroller).scrollbarWidth,
    } : null });
  })()`));
  console.log('  state:', JSON.stringify(d0));

  check('窗口只挂载当前轮 ±2（末尾处只有 3 轮）', d0.turns.length === 3, `渲染 ${d0.turns.length} 轮`);
  check('初始定位在最后一条的末尾', d0.turns.at(-1).i === 11 && d0.turns[0].i === 9,
    JSON.stringify(d0.turns.map((t) => t.i)));
  check('原生滚动条已隐藏', d0.scroller?.sbw === 'none' && d0.scroller?.barGap === 0,
    JSON.stringify(d0.scroller));

  const curTick = d0.slots.find((s) => s.i === 11);
  const loadedTick = d0.slots.find((s) => s.i === 10);
  const hintTick = d0.slots.find((s) => s.i === 7);
  check('横线三档长度：当前 14 / 已加载 10 / 未加载 6',
    curTick?.w === (SPOT ? 12 : 14) && loadedTick?.w === (SPOT ? 8 : 10) && hintTick?.w === 6,
    `current=${curTick?.w} loaded=${loadedTick?.w} hint=${hintTick?.w}`);
  check('横线槽位随会话长度收敛（末尾 7 格：5..11）', d0.slots.length === 7, `slots=${d0.slots.length}`);
  check('刻度整格对齐（无半格错位）',
    (await tickTops()).every((t) => Math.abs(t % SLOT) < 0.01), JSON.stringify(await tickTops()));

  // 回归：公式块（悬停虚线的那个）底座必须是 dashed —— 否则离开时 border-style
  // 会离散地跳成 solid、颜色再淡出，看起来就是"虚线变实线再消失"。
  const mathBorder = await ev(`(() => {
    const el = document.querySelector('.interactive-math');
    if (!el) return 'none';
    const cs = getComputedStyle(el);
    return cs.borderTopStyle + '/' + cs.borderTopWidth;
  })()`);
  check('公式块底座边框恒为 dashed（离开时不闪实线）',
    mathBorder === 'dashed/1px', String(mathBorder));

  // ---------------------------------------------------------------- 悬停预览
  const hintPos = await slotRect(7);
  await mouse('mouseMoved', hintPos.x, hintPos.y);
  await sleep(350);
  const hoverAt = await ev(`(() => {
    const el = document.elementFromPoint(${hintPos.x}, ${hintPos.y});
    const slot = el && el.closest('[data-turn-slot]');
    return slot ? slot.dataset.turnSlot : 'none';
  })()`);
  check('指针确实落在第 7 轮的刻度上', hoverAt === '7', `elementFromPoint → ${hoverAt}`);

  const preview = await ev(`(() => {
    const card = [...document.querySelectorAll('div')].find(el =>
      el.className.includes('dark:bg-[#26272e]') && el.textContent.includes('轮提问'));
    if (!card) return 'null';
    return JSON.stringify({ text: card.innerText.replace(/\\n/g, ' | ') });
  })()`);
  check('悬停出预览卡（问题 + 回答）',
    preview !== 'null' && preview.includes('第 8 轮提问') && preview.includes('第 8 轮回答'),
    String(preview).slice(0, 120));
  check('预览不含思考过程', preview !== 'null' && !preview.includes('思考过程'), '');
  await shot(`${TAG}-hover.png`);

  const railBox = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    const r = host.getBoundingClientRect();
    const w = ${SPOT ? 260 : 330};
    return JSON.stringify({ x: Math.max(0, r.left - (w - 30)), y: r.top - 24, width: w, height: r.height + 48 });
  })()`));
  await shotClip(`${TAG}-zoom.png`, railBox);

  // ---------------------------------------------------------------- 点击跳转
  await mouse('mousePressed', hintPos.x, hintPos.y);
  await sleep(60);
  await mouse('mouseReleased', hintPos.x, hintPos.y);
  await sleep(650);

  const ac = JSON.parse(await ev(`(() => {
    const els = [...document.querySelectorAll('[data-turn-index]')];
    const target = els.find(el => el.dataset.turnIndex === '7');
    const scroller = [...document.querySelectorAll('div')].find(el => el.className.includes('scrollbar-invisible'));
    const off = target ? Math.round(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null;
    const cur = [...document.querySelectorAll('[data-turn-slot]')]
      .map(el => ({ i: Number(el.dataset.turnSlot), w: Math.round(el.firstElementChild?.getBoundingClientRect().width || 0) }))
      .sort((a, b) => b.w - a.w)[0];
    return JSON.stringify({ count: els.length, off, cur: cur?.i });
  })()`));
  check('点击未加载刻度 → 重建窗口并贴顶', ac.off !== null && Math.abs(ac.off - 24) <= 3, JSON.stringify(ac));
  check('跳转后仍只挂载 5 轮', ac.count === 5, String(ac.count));
  check('当前刻度随之切换', ac.cur === 7, String(ac.cur));
  await shot(`${TAG}-jumped.png`);

  // ---------------------------------------------------------------- 滚轮滚横线
  const beforeWheel = await currentCenter();
  await ev(`(() => {
    const rail = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    rail.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const afterWheel = await currentCenter();
  const wheelSnapped = (await tickTops()).every((t) => Math.abs(t % SLOT) < 0.01);
  check('滚轮滚横线：一次滚动退 3 格且停在整格',
    afterWheel === beforeWheel - 3 && wheelSnapped, `${beforeWheel} → ${afterWheel}`);

  // ---------------------------------------------------------------- 按住态 + 拖动
  const cent0 = await currentCenter();
  const grab = await slotRect(cent0 + 3);
  const topBefore = JSON.parse(await ev(`(() => {
    const el = document.querySelector('[data-turn-slot="${cent0}"]');
    return JSON.stringify({ top: parseFloat(el.style.top) });
  })()`)).top;

  await mouse('mousePressed', grab.x, grab.y);
  await sleep(300);
  const ps = JSON.parse(await ev(`(() => {
    const rail = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    const frost = rail.firstElementChild;
    const scaled = rail.children[1];
    const card = [...document.querySelectorAll('div')].find(el =>
      el.className.includes('dark:bg-[#26272e]') && el.textContent.includes('轮提问'));
    const inner = frost.firstElementChild;
    return JSON.stringify({
      pressing: rail.dataset.railPressing,
      transform: getComputedStyle(scaled).transform,
      frostOpacity: getComputedStyle(frost).opacity,
      frostVisibility: getComputedStyle(frost).visibility,
      frostBlur: getComputedStyle(inner).backdropFilter || getComputedStyle(inner).webkitBackdropFilter,
      frostHasTransformAncestor: (() => {
        let p = frost;
        while (p && p !== document.body) {
          if (getComputedStyle(p).transform !== 'none') return true;
          p = p.parentElement;
        }
        return false;
      })(),
      frostLayers: frost.children.length,
      frostChain: (() => {
        const out = [];
        let p = frost.parentElement;
        while (p && p !== document.documentElement && out.length < 10) {
          const cs = getComputedStyle(p);
          out.push({
            tag: p.tagName,
            cls: (p.className || '').toString().slice(0, 28),
            filter: cs.filter,
            opacity: cs.opacity,
            transform: cs.transform,
            mask: (cs.maskImage || cs.webkitMaskImage || 'none').slice(0, 18),
            willChange: cs.willChange,
          });
          p = p.parentElement;
        }
        return out;
      })(),
      frostLayerFilters: [...frost.children].map(el => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter),
      frostBorder: getComputedStyle(frost).borderTopWidth,
      frostBg: getComputedStyle(frost).backgroundColor,
      cardIndex: card ? ((card.querySelector('.font-mono')?.textContent || '').trim().split(' ')[0] || null) : null,
    });
  })()`));

  check('按住时整盘放大 2×（大小窗同款）',
    ps.pressing === 'true' && ps.transform.startsWith('matrix(2'), ps.transform);
  check('按住时模糊层可见且带 blur（无边框）',
    String(ps.frostBlur || '').includes('blur') && ps.frostVisibility === 'visible',
    String(ps.frostBlur));
  console.log('  chain:', JSON.stringify(ps.frostChain));
  check('模糊用三层渐进叠边（不依赖 mask，避免 backdrop root）',
    ps.frostLayers === 3 && ps.frostLayerFilters.every((f) => String(f).includes('blur')),
    `${ps.frostLayers} 层 ${JSON.stringify(ps.frostLayerFilters)}`);
  check('模糊层不在 transform 祖先下（Safari 下才会真正出模糊）',
    ps.frostHasTransformAncestor === false, String(ps.frostHasTransformAncestor));
  check('模糊层无边框、无底色（开放式）',
    ps.frostBorder === '0px' && ps.frostBg === 'rgba(0, 0, 0, 0)',
    `border=${ps.frostBorder} bg=${ps.frostBg}`);
  check('按住即显示中心轮预览（不是空白、也不跟鼠标刻度）',
    ps.cardIndex === String(cent0 + 1), `card=${ps.cardIndex} center=${cent0 + 1}`);

  const pressBox = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    const r = host.getBoundingClientRect();
    const w = ${SPOT ? 250 : 340};
    return JSON.stringify({ x: Math.max(0, r.left - (w - 26)), y: r.top - 26, width: w, height: r.height + 52 });
  })()`));
  await shotClip(`${TAG}-press.png`, pressBox);
  const railTight = JSON.parse(await ev(`(() => {
    const host = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    const r = host.getBoundingClientRect();
    return JSON.stringify({ x: Math.max(0, r.left - 70), y: r.top - 8, width: 96, height: r.height + 16 });
  })()`));
  await shotClip(`${TAG}-press-rail.png`, railTight);

  // 临时探针：在横线正下方铺一段文字，肉眼核对"模糊是否真的生效"
  const probe = await ev(`(() => {
    const host = document.querySelector('[data-turn-slot]').closest('[data-rail-pressing]');
    const r = host.getBoundingClientRect();
    const parent = host.parentElement;
    const pr = parent.getBoundingClientRect();
    let el = document.getElementById('blur-probe');
    if (!el) {
      el = document.createElement('div');
      el.id = 'blur-probe';
      el.textContent = '模糊测试 模糊测试 模糊测试 模糊测试 模糊测试';
      // 必须放进对话容器内部：.chat-container 有 container-type，containment 会形成
      // backdrop root，body 上的探针不会被采样（这会让"模糊是否生效"误判为没效果）
      el.style.cssText = 'position:absolute;z-index:0;color:#e5e7eb;font:13px/18px system-ui;letter-spacing:0.5px;';
      parent.appendChild(el);
    }
    el.style.right = '0px';
    el.style.top = (r.top - pr.top) + 'px';
    el.style.width = (r.width + 46) + 'px';
    return JSON.stringify({ x: Math.max(0, r.left - 46), y: r.top - 4, width: 100, height: r.height + 8 });
  })()`);
  await shotClip(`${TAG}-blur-on.png`, JSON.parse(probe));

  // 向下拉 1 格：刻度跟着下移、中心后退
  await mouse('mouseMoved', grab.x, grab.y + SLOT, { buttons: 1 });
  await sleep(140);
  const dr = JSON.parse(await ev(`(() => {
    const el = document.querySelector('[data-turn-slot="${cent0}"]');
    return JSON.stringify({ top: el ? parseFloat(el.style.top) : null });
  })()`));
  await mouse('mouseReleased', grab.x, grab.y + SLOT, { buttons: 0 });
  await sleep(650);
  const ad = JSON.parse(await ev(`(() => {
    const cur = [...document.querySelectorAll('[data-turn-slot]')]
      .map(el => ({ i: Number(el.dataset.turnSlot), w: Math.round(el.firstElementChild?.getBoundingClientRect().width || 0) }))
      .sort((a, b) => b.w - a.w)[0];
    return JSON.stringify({ cur: cur?.i });
  })()`));
  const dragSnapped = (await tickTops()).every((t) => Math.abs(t % SLOT) < 0.01);
  check('向下拉 1 格 → 刻度跟着下移 1 格、中心后退 1 格（转表盘，基线取中心）',
    Math.abs((dr.top ?? 0) - (topBefore ?? 0) - SLOT) < 0.01 && ad.cur === cent0 - 1,
    `top ${topBefore} → ${dr.top}，cur ${cent0} → ${ad.cur}`);
  check('松手后落在整格', dragSnapped, '');

  // 回归：按在偏下刻度上猛拖（该刻度会被卸载）→ 移回 → 松手，必须退出按住态
  const grab2 = await slotRect(Math.min(ad.cur + 5, 11));
  await mouse('mousePressed', grab2.x, grab2.y);
  await mouse('mouseMoved', grab2.x, grab2.y - 200, { buttons: 1 });
  await sleep(120);
  await mouse('mouseMoved', grab2.x, grab2.y, { buttons: 1 });
  await sleep(120);
  await mouse('mouseReleased', grab2.x, grab2.y, { buttons: 0 });
  await sleep(350);
  const afterLost = await ev(
    `JSON.stringify({ pressing: document.querySelector('[data-rail-pressing]')?.dataset.railPressing })`
  );
  check('拖远/移回后松手不会卡在按住态', JSON.parse(afterLost).pressing === 'false', afterLost);
  await shotClip(`${TAG}-blur-off.png`, JSON.parse(probe));
  await ev(`document.getElementById('blur-probe')?.remove(); 'ok'`);

  // ---------------------------------------------------------------- 双向翻页
  for (let i = 0; i < 14; i++) {
    await ev(`(() => {
      const el = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
      el.scrollTop = el.scrollHeight;
      return 'ok';
    })()`);
    await sleep(360);
  }
  await sleep(900); // 等收拢（TRIM_DELAY=700）
  const atBottom = await ev(
    `JSON.stringify({ idx: [...document.querySelectorAll('[data-turn-index]')].map(el => Number(el.dataset.turnIndex)) })`
  );
  check('滚回下方后旧轮次逐个释放，最终只剩末尾 3 轮',
    JSON.parse(atBottom).idx.join(',') === '9,10,11', atBottom);
  await shot(`${TAG}-bottom.png`);

  await ev(`(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    return 'ok';
  })()`);
  // 用真实手势连续上滚（程序化 scrollTop=0 会被窗口补偿抵消，测不出真实行为）
  for (let i = 0; i < 6; i++) {
    await send('Input.synthesizeScrollGesture', {
      x: SPOT ? 240 : 620, y: SPOT ? 380 : 420,
      yDistance: 1800, speed: 3000, gestureSourceType: 'mouse',
    });
    await sleep(220);
  }
  await sleep(900); // 等收拢
  const atTop = await ev(
    `JSON.stringify({ idx: [...document.querySelectorAll('[data-turn-index]')].map(el => Number(el.dataset.turnIndex)) })`
  );
  const topIdx = JSON.parse(atTop).idx;
  check('连续上滚能一路加载到会话开头，且同时最多 5 轮',
    Math.min(...topIdx) === 0 && topIdx.length <= 5, atTop);
  await shot(`${TAG}-top.png`);
  console.log('  长任务(ms):', await ev(`JSON.stringify(window.__lt || [])`));

  // ---------------------------------------------------------------- 收拢窗口不跳（clamp 双补偿回归）
  // 先把窗口"补大"（贴边滚动），停手 300ms（还没收拢）记下一轮的位置，
  // 再等收拢完成，位置必须基本不动 —— 治的是"收拢时浏览器 clamp + 相对补偿 = 跳两下"。
  await send('Input.synthesizeScrollGesture', {
    x: SPOT ? 240 : 620, y: SPOT ? 380 : 420,
    yDistance: 900, speed: 1500, gestureSourceType: 'mouse',
  });
  await sleep(280);
  const beforeTrim = await ev(`(() => {
    const sc = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
    const c = sc.getBoundingClientRect();
    for (const n of document.querySelectorAll('[data-turn-key]')) {
      const r = n.getBoundingClientRect();
      if (r.top >= c.top && r.top < c.top + 200) {
        return JSON.stringify({ key: n.dataset.turnKey, top: Math.round(r.top - c.top), n: document.querySelectorAll('[data-turn-index]').length });
      }
    }
    return 'null';
  })()`);
  await sleep(1100);
  const afterTrim = await ev(`(() => {
    const sc = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
    const c = sc.getBoundingClientRect();
    const el = document.querySelector('[data-turn-key="${JSON.parse(String(beforeTrim)).key}"]');
    if (!el) return JSON.stringify({ top: null, n: document.querySelectorAll('[data-turn-index]').length });
    return JSON.stringify({ top: Math.round(el.getBoundingClientRect().top - c.top), n: document.querySelectorAll('[data-turn-index]').length });
  })()`);
  const bt = JSON.parse(String(beforeTrim));
  const at = JSON.parse(String(afterTrim));
  check('收拢窗口时同一轮次位置不跳（clamp 与补偿不叠加）',
    at.top !== null && Math.abs(at.top - bt.top) <= 6,
    `before ${bt.top}px(${bt.n} 轮) → after ${at.top}px(${at.n} 轮)`);

  // ---------------------------------------------------------------- 正常翻页不碰 DOM
  // 需求：正常滚动时列表结构必须完全不变（刻度只跟随读数，不反向驱动页面）
  await ev(`(() => {
    const el = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    return 'ok';
  })()`);
  await sleep(500);
  const beforeSmall = await ev(
    `JSON.stringify([...document.querySelectorAll('[data-turn-index]')].map(el => el.dataset.turnIndex))`
  );
  await send('Input.synthesizeScrollGesture', {
    x: SPOT ? 240 : 620, y: SPOT ? 380 : 420,
    yDistance: 120, speed: 700, gestureSourceType: 'mouse',
  });
  await sleep(600);
  const afterSmall = await ev(
    `JSON.stringify([...document.querySelectorAll('[data-turn-index]')].map(el => el.dataset.turnIndex))`
  );
  check('小幅滚动（120px，不贴边）完全不改 DOM 结构（刻度纯跟随）',
    beforeSmall === afterSmall, `${beforeSmall} → ${afterSmall}`);

  // ---------------------------------------------------------------- 自然滚动抽搐（真实滚动手势）
  // 注意：不能用 el.scrollTop = x 模拟 —— 那是"程序化滚动"，会和原生滚动锚定互相干扰，
  // 测不出真实手感。这里用 CDP 的合成滚动手势（浏览器原生滚动 + 惯性）。
  await send('Input.synthesizeScrollGesture', {
    x: SPOT ? 240 : 620, y: SPOT ? 380 : 420,
    yDistance: 0, speed: 800, gestureSourceType: 'mouse',
  });
  await ev(`(() => {
    const el = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
    el.scrollTop = el.scrollHeight;
    return 'ok';
  })()`);
  await sleep(500);
  await ev(`(() => {
    window.__samples = [];
    window.__lt = [];
    window.__sampling = true;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    const el = [...document.querySelectorAll('div')].find(x => x.className.includes('scrollbar-invisible'));
    const tick = () => {
      if (!window.__sampling) return;
      const c = el.getBoundingClientRect();
      for (const n of document.querySelectorAll('[data-turn-key]')) {
        const r = n.getBoundingClientRect();
        if (r.top >= c.top - 1 && r.top < c.top + 120) {
          window.__samples.push({ key: n.dataset.turnKey, top: Math.round(r.top), st: Math.round(el.scrollTop) });
          break;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 'ok';
  })()`);

  // 快速上滚：一次手势滚 1800px
  const gesture = send('Input.synthesizeScrollGesture', {
    x: SPOT ? 240 : 620, y: SPOT ? 380 : 420,
    yDistance: 1800, speed: 1200, gestureSourceType: 'mouse',
  });
  await sleep(2000);
  await gesture;
  await ev(`window.__sampling = false; 'ok'`);
  await sleep(200);

  const jitter = JSON.parse(await ev(`(() => {
    window.__sampling = false;
    const s = window.__samples || [];
    let back = 0, maxBack = 0, pairs = 0, moved = 0, moving = 0, maxStep = 0, stBack = 0, stMaxBack = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i].key !== s[i - 1].key) continue;
      const d = s[i].top - s[i - 1].top;
      pairs += 1;
      moved += d;
      if (Math.abs(d) >= 4) { moving += 1; maxStep = Math.max(maxStep, d); }
      if (d < -2) { back += 1; maxBack = Math.min(maxBack, d); }
    }
    // 上滚时 scrollTop 应单调减小；任何"变大"都是页面被反向拽了一下
    for (let i = 1; i < s.length; i++) {
      const dst = s[i].st - s[i - 1].st;
      if (dst > 8) { stBack += 1; stMaxBack = Math.max(stMaxBack, dst); }
    }
    return JSON.stringify({ frames: s.length, pairs, reversals: back, maxBack, moved, moving, maxStep, stBack, stMaxBack, longTasks: window.__lt || [] });
  })()`));
  check('快速上滚（原生手势 1800px）不出现反向抽搐',
    jitter.pairs > 5 && jitter.reversals === 0, JSON.stringify(jitter));
  // 说明：贴边补内容时会**合理地**把 scrollTop 加回一段（等价于上方变高），
  // 所以不能用"scrollTop 单调"判定；真正的判据是"视觉位置不往回跳"。
  check('快速上滚没有视觉回跳、也没有瞬移',
    jitter.maxStep <= 320, `单帧最大位移 ${jitter.maxStep}px（含贴边补偿）`);
  check('快速上滚确实在移动（手势未被打断）',
    jitter.maxStep >= 15, `单帧最大 ${jitter.maxStep}px，累计 ${jitter.moved}px`);
  check('快速上滚期间无 >50ms 长任务',
    Array.isArray(jitter.longTasks) && jitter.longTasks.length === 0, JSON.stringify(jitter.longTasks));

  // ---------------------------------------------------------------- 冻结期不测量
  // 开合侧边栏时中部会被 content-visibility 冻结：那时所有 rect 都是 0，
  // 若仍去读位置，会把"当前轮"误判成最后一个已挂载轮（刻度跳到末尾、内容闪现）。
  if (!SPOT) {
    const before = await currentCenter();
    await ev(`document.querySelector('[data-sidebar-toggle="true"]').click()`);
    await sleep(60);
    const during = await currentCenter();
    await sleep(900);
    const after = await currentCenter();
    check('冻结期间不测量：刻度不会跳到末尾',
      during === before && after === before,
      JSON.stringify({ before, during, after }));
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} 通过`);
  if (fails.length) {
    console.log('失败项:', fails.map((f) => f.name).join(', '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('ERROR', e);
  process.exitCode = 2;
} finally {
  try { ws.close(); } catch {}
  proc.kill('SIGKILL');
}
