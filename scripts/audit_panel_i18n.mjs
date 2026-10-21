/**
 * 面板的 i18n / 深浅色审计。
 *
 * 用**全 ASCII 的合成数据**（会话、条目、注入原文都只用英文），
 * 于是「面板里出现任何中文字符」就一定是漏翻的 UI 文案。
 *
 * 用法：LANG=en THEME=light node scripts/audit_panel_i18n.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = Number(process.env.PORT || 9361);
const OUT = '/tmp';
const LANG = process.env.LANG_PREF || 'en';
const THEME = process.env.THEME || 'light';
const TAG = `${LANG}-${THEME}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ARTICLE = ['Barcode', '[Overview]', 'A barcode is an optical representation of data.', '· One-dimensional', '· Two-dimensional'].join('\n');

const SNAPSHOT = JSON.stringify({
  sessions: [{
    id: 'sess-audit', title: 'Audit session', createdAt: 1, updatedAt: 2, contextUsed: 0,
    messages: [
      { id: 'u0', role: 'user', content: 'What encoding is this?', images: [PNG, PNG], timestamp: 1 },
      { id: 'a0', role: 'assistant', content: '## Answer\n\nPlain answer body.\n\n- point one\n', timestamp: 2,
        citations: [
          { title: 'Barcode', url: '', context: 'Injected reference text A.' },
          { title: 'QR code', url: '', context: 'Injected reference text B.' },
        ] },
    ],
  }],
  mainSessionId: 'sess-audit', generatingSessionIds: [], liveStreamingTokens: {},
  settings: { language: LANG, theme: THEME },
});

const proc = spawn(EDGE, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-audit-${TAG}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
  'http://127.0.0.1:5173/',
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('127.0.0.1:5173'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no target');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pending = new Map(); const listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) for (const fn of listeners) fn(m);
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  listeners.push(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const url = request.url;
    const body = url.includes('/api/sessions/events') ? `event: snapshot\ndata: ${SNAPSHOT}\n\n`
      : url.includes('/api/sessions/state') ? SNAPSHOT
      : url.includes('/api/wiki/status')
        ? JSON.stringify({ enabled: true, connected: true, status: 'running', port: 31236, zimPath: '/x', contentId: 'x', bookTitle: 'W', articleCount: 100, mediaCount: 1 })
      : url.includes('/api/wiki/article') ? JSON.stringify({ title: 'Barcode', url: '', context: ARTICLE })
      : url.includes('/api/wiki/search') ? JSON.stringify({ results: [{ title: 'Barcode', exact: true }, { title: 'QR code', exact: false }] })
      : '{}';
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: url.includes('/api/sessions/events') ? 'text/event-stream' : 'application/json' }],
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
  });

  await send('Page.reload');
  await sleep(3200);

  const shotPanel = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 840, y: 0, width: 440, height: 560, scale: 2 } });
    fs.writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'));
  };
  const panelText = () => ev(`document.querySelector('[data-side-panel="true"]')?.innerText || ''`);

  await ev(`document.querySelector('[data-panel-toggle="true"]').click()`);
  await sleep(600);
  await shotPanel(`audit-${TAG}-1-search.png`);

  // 引用胶囊 → 条目页
  await ev(`document.querySelector('button[title="Barcode"]').click()`);
  await sleep(900);
  await shotPanel(`audit-${TAG}-2-article.png`);
  {
    const box = JSON.parse(await ev(`(() => {
      const el = document.querySelector('[data-injected="true"]');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) - 12, width: 440, height: 26 });
    })()`));
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 3 } });
    fs.writeFileSync(`${OUT}/audit-${TAG}-sep.png`, Buffer.from(r.data, 'base64'));
  }

  // 原文页
  await ev(`document.querySelector('[data-open-raw]').click()`);
  await sleep(600);
  await shotPanel(`audit-${TAG}-3-raw.png`);

  // 图片页
  await ev(`document.querySelectorAll('[data-message-image]')[0].click()`);
  await sleep(700);
  await shotPanel(`audit-${TAG}-4-image.png`);

  const text = String(await panelText());
  if (LANG === 'en') {
    const cjk = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    check(`[${TAG}] 面板内没有未翻译的中文（UI 文案）`, !cjk, cjk ? [...new Set(cjk)].join('') : 'none');
  } else {
    const need = ['知识库搜索', '原文', '图片'];
    const missing = need.filter((k) => !text.includes(k));
    check(`[${TAG}] 中文模式下四个页面标题均为中文`, missing.length === 0, missing.join(',') || 'ok');
  }

  // 关键色板的明暗一致性：面板底色必须与主题匹配
  const colors = JSON.parse(await ev(`(() => {
    const panel = document.querySelector('[data-side-panel="true"]');
    const strip = document.querySelector('[data-tab-strip="true"]');
    const header = document.querySelector('[data-page-host="image"] > div > div:first-child > div:first-child');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return JSON.stringify({
      panelBg: cs(panel)?.backgroundColor,
      stripBg: cs(strip)?.backgroundColor,
      headerBg: cs(header)?.backgroundColor,
      stripText: cs(strip)?.color,
    });
  })()`));
  const isLight = THEME === 'light';
  const panelLum = /rgb\((\d+), (\d+), (\d+)\)/.exec(colors.panelBg || '');
  const lum = panelLum ? (Number(panelLum[1]) * 299 + Number(panelLum[2]) * 587 + Number(panelLum[3]) * 114) / 1000 : null;
  check(`[${TAG}] 面板底色与主题一致（${THEME}）`,
    lum !== null && (isLight ? lum > 150 : lum < 100), `${colors.panelBg} lum=${lum}`);
  check(`[${TAG}] 页面二级头与标签栏同材质`,
    colors.headerBg === colors.stripBg, JSON.stringify({ strip: colors.stripBg, header: colors.headerBg }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · ${TAG}`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('ERROR', e);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  proc.kill('SIGKILL');
}
