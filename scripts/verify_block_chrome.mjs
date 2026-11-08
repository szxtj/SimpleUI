/**
 * 回归：代码块 / 表格 / Mermaid 迁到 BlockChrome 之后，三个块的外观是否真的统一、行为是否没变。
 *
 * 重点不是"能渲染"，而是**头部三处必须完全一致**（底色、描边、按钮尺寸），
 * 这是这次重构唯一的验收标准 —— 之前它们分别漂到了 #f0f2f5 / #f6f8fa。
 *
 * 用法：先 `npx vite`（5173），再 `node scripts/verify_block_chrome.mjs`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9352;
const TARGET = 'http://127.0.0.1:5173/';
const OUT = '/tmp';

const proc = spawn(
  EDGE,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--in-process-gpu',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/edge-prof-blockchrome`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1080,900', TARGET,
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

const CONTENT = [
  '先看一张表：',
  '',
  '| 算法 | 复杂度 | 用途 |',
  '| --- | --- | --- |',
  '| Prim | O(E log V) | 最小生成树 |',
  '| Kruskal | O(E log E) | 最小生成树 |',
  '',
  '再看一张图：',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[结束]',
  '```',
  '',
  '最后是一段脚本：',
  '',
  '```python',
  ...Array.from({ length: 60 }, (_, i) => `print("line ${i + 1}")`),
  '```',
].join('\n');

const now = Date.now();
const SNAPSHOT = {
  mainSessionId: 'sess-blocks',
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
      id: 'sess-blocks', title: '块外壳回归', createdAt: now, updatedAt: now, contextUsed: 0,
      enableThinking: false, enableWikiSearch: false,
      messages: [
        { id: 'b1', role: 'user', content: '给我表格、图、脚本各一个', timestamp: now - 3000 },
        { id: 'b2', role: 'assistant', content: CONTENT, timestamp: now - 2000 },
      ],
    },
  ],
};

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params;
    const headers = [{ name: 'Content-Type', value: 'application/json' }];
    if (/\/api\/sessions\/events/.test(request.url)) {
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Cache-Control', value: 'no-cache' }],
        body: b64(`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}\n\n`),
      });
    } else if (/\/api\/sessions\/state/.test(request.url)) {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: b64(JSON.stringify(SNAPSHOT)) });
    } else {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: b64('{}') });
    }
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.id && (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
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

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ✅ ${name}`);
  else { failures += 1; console.log(`  ❌ ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); }
};

const probe = `(() => {
  const shells = [...document.querySelectorAll('[data-md-codeblock]')];
  const tableShell = [...document.querySelectorAll('.markdown-body table')][0]?.closest('div.relative');
  const pick = (el) => {
    if (!el) return null;
    const header = el.firstElementChild;
    const hs = getComputedStyle(header);
    const btns = [...header.querySelectorAll('button')];
    const SEG_LABELS = ['预览', '源码', '图表', 'Preview', 'Source', 'Diagram', 'Code'];
    const seg = btns.filter(b => SEG_LABELS.includes((b.textContent || '').trim()));
    return {
      bg: hs.backgroundColor,
      height: Math.round(header.getBoundingClientRect().height),
      borderBottom: hs.borderBottomWidth + ' ' + hs.borderBottomColor,
      labels: btns.map(b => (b.textContent || '').trim()).filter(Boolean),
      segCount: seg.length,
      segHeight: seg[0] ? Math.round(seg[0].parentElement.getBoundingClientRect().height) : null,
      preMaxH: (() => { const p = el.querySelector('pre'); return p ? getComputedStyle(p).maxHeight : null; })(),
      preOverflowY: (() => { const p = el.querySelector('pre'); return p ? getComputedStyle(p).overflowY : null; })(),
      preClientH: (() => { const p = el.querySelector('pre'); return p ? Math.round(p.clientHeight) : 0; })(),
      preScrollH: (() => { const p = el.querySelector('pre'); return p ? Math.round(p.scrollHeight) : 0; })(),
      preBarW: (() => { const p = el.querySelector('pre'); return p ? p.offsetWidth - p.clientWidth : 0; })(),
      btnPad: (() => {
        const plain = btns.find(b => !SEG_LABELS.includes((b.textContent || '').trim()));
        return plain ? getComputedStyle(plain).padding : null;
      })(),
      svg: !!el.querySelector('.mermaid-diagram svg'),
    };
  };
  return JSON.stringify({
    code: shells.map(pick),
    table: pick(tableShell),
  });
})()`;

try {
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await sleep(1200);
  await send('Page.reload', {});
  await sleep(6000);

  const p = JSON.parse(await ev(probe));
  const [mermaidBlock, pythonBlock] = p.code;
  const table = p.table;

  console.log('[块头部]', JSON.stringify({ code: p.code.map(b => b && b.bg), table: table && table.bg }));

  check('Mermaid 真的画出来了', mermaidBlock?.svg === true);
  check('Mermaid 有图表/源码分段', mermaidBlock?.segCount === 2, mermaidBlock?.segCount);
  check('Mermaid 分段高度与头部内容等高', mermaidBlock?.segHeight === 21, mermaidBlock?.segHeight);
  check('表格有三个动作', (table?.labels || []).length === 3, table?.labels);
  check('Python 块有「运行」', (pythonBlock?.labels || []).some(l => /运行|Run/.test(l)), pythonBlock?.labels);

  const bgs = [mermaidBlock?.bg, pythonBlock?.bg, table?.bg];
  check('三块头部底色完全一致', new Set(bgs.filter(Boolean)).size === 1, bgs);
  check('头部底色 = 深色 #22242a', bgs[0] === 'rgb(34, 36, 42)', bgs[0]);

  const heights = [mermaidBlock?.height, pythonBlock?.height, table?.height];
  check('三块头部高度一致', new Set(heights.filter(Boolean)).size === 1, heights);

  const pads = [mermaidBlock?.btnPad, pythonBlock?.btnPad, table?.btnPad];
  check('三块按钮内边距一致', new Set(pads.filter(Boolean)).size === 1, pads);

  const borders = [mermaidBlock?.borderBottom, pythonBlock?.borderBottom, table?.borderBottom];
  check('三块分隔线一致', new Set(borders.filter(Boolean)).size === 1, borders);

  check('源码区 max-height = 480px（与 iframe 预览同高）', pythonBlock?.preMaxH === '480px', pythonBlock?.preMaxH);
  check('源码区 overflow-y = auto（有滚动条）', pythonBlock?.preOverflowY === 'auto', pythonBlock?.preOverflowY);
  check('滚动条真的占位可见（宽度 > 0）', (pythonBlock?.preBarW || 0) > 0, pythonBlock?.preBarW);
  check('60 行代码真的被截到 480px 并产生滚动',
    pythonBlock?.preClientH === 480 && pythonBlock?.preScrollH > pythonBlock?.preClientH,
    { client: pythonBlock?.preClientH, scroll: pythonBlock?.preScrollH });

  await shot('block_chrome_dark.png');
  await ev(`document.documentElement.classList.remove('dark')`);
  await sleep(500);
  const light = JSON.parse(await ev(probe));
  const lightBgs = [light.code[0]?.bg, light.code[1]?.bg, light.table?.bg];
  check('浅色下三块头部同样一致且 = #f6f8fa',
    new Set(lightBgs.filter(Boolean)).size === 1 && lightBgs[0] === 'rgb(246, 248, 250)', lightBgs);
  await shot('block_chrome_light.png');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项未通过 ❌`);
} finally {
  try { ws.close(); } catch {}
  proc.kill('SIGKILL');
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}
