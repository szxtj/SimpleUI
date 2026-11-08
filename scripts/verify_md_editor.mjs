/**
 * Markdown 编辑器窗口回归验证（无头浏览器 + CDP）。
 *
 * 覆盖：
 *  A. 默认三态布局与顶栏（52px 与红绿灯同一行、功能项右对齐）
 *  B. 渲染一致性：公式 / 表格 / Mermaid / 代码块 / 中文加粗（与对话区共用 MarkdownRenderer）
 *  C. 三态切换：编辑 / 分栏 / 浏览
 *  D. 打开文件（伪造原生回传）→ 文件名、内容、未保存标记
 *  E. 编辑 → 未保存标记 → 保存 → 标记消失；另存为带建议文件名
 *  F. 「保存并关闭」链路：__mdRequestSaveClose → save → closeNow
 *  G. 原生状态同步：{action:'state', name, edited, path}
 *  H. 主界面入口按钮位置：Markdown 在 3D 左侧、3D 在设置左侧
 *  I. 顶栏窄窗：先丢文件名、再丢按钮文字，且绝不换行
 *
 * 用法：先 `npx vite build`，再 `npx vite preview --port 4173 --strictPort`，
 *       BASE=http://127.0.0.1:4173 node scripts/verify_md_editor.mjs
 */
import { spawn } from 'node:child_process';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const PORT = 9391;
const TARGET = `${BASE}/#/markdown`;

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/edge-prof-md-editor',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1200,820',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('about:blank')
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no debug target');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const logged = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logged.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`EVAL FAILED: ${r.exceptionDetails.text} :: ${expression.slice(0, 120)}`);
  }
  return r.result.value;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 轮询等待条件成立。
 * 固定 sleep 在这套页面里不可靠：Mermaid 动态 import、KaTeX 重排、生成本身都会阻塞主线程，
 * 同一段代码在不同轮次可能差 200~600ms —— 用「等条件」代替「等时间」。
 */
async function waitFor(expression, timeout = 4000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await ev(expression)) return true;
    } catch {
      /* 元素还没渲染出来时表达式可能抛错，继续等 */
    }
    await sleep(interval);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');

/** 伪造原生桥：记录页面发出的每条消息，并按需回放「原生回话」 */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const sent = [];
      window.__mdSent = sent;
      const mdEditor = {
        postMessage(payload) {
          sent.push(payload);
          // 模拟原生落盘成功：页面发出 save / saveAs 后立刻回话
          if (payload.action === 'save') {
            setTimeout(() => window.__mdFileSaved && window.__mdFileSaved({
              ok: true, path: payload.path, name: payload.path.split('/').pop(),
            }), 30);
          } else if (payload.action === 'saveAs') {
            setTimeout(() => window.__mdFileSaved && window.__mdFileSaved({
              ok: true, path: '/tmp/另存为文档.md', name: '另存为文档.md',
            }), 30);
          }
        },
      };
      window.webkit = {
        messageHandlers: {
          mdEditor,
          openMarkdownEditor: { postMessage() { sent.push({ action: '__openWindow' }); } },
          setAppTheme: { postMessage() {} },
          setModalOpen: { postMessage() {} },
          // 划选浮标 / 公式工具条的复制通路（原生侧真实处理器：NSPasteboard）
          translateSelection: { postMessage(p) { window.__translated = p; } },
          copyRichData: { postMessage(p) { window.__copiedRich = p; } },
          copyWordEquation: { postMessage(p) { window.__copiedWord = p; } },
        },
      };
      window.__mdErrors = [];
      window.addEventListener('error', (e) => window.__mdErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__mdErrors.push('rejection: ' + e.reason));
    })();
  `,
});

await send('Emulation.setDeviceMetricsOverride', {
  width: 1200,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: TARGET });
await sleep(2500);

// ---------------------------------------------------------------- A. 布局
const layout = await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const modes = [...document.querySelectorAll('[data-md-mode]')].map(b => b.dataset.mdMode);
  const active = document.querySelector('[data-md-mode].shadow-sm')?.dataset.mdMode;
  const root = getComputedStyle(document.querySelector('.h-screen'));
  const band = document.querySelector('[data-md-action="open"]').closest('.h-screen')?.firstElementChild;
  const toolbar = document.querySelector('[data-md-action="open"]')?.closest('div.flex-shrink-0');
  const tb = toolbar?.getBoundingClientRect();
  const r = ta?.getBoundingClientRect();
  return JSON.stringify({
    hasTextarea: !!ta,
    modes, active,
    bandHeight: band?.getBoundingClientRect().height,
    toolbarTop: tb?.top, toolbarHeight: tb?.height,
    editorWidth: r?.width,
    innerWidth: window.innerWidth,
    bg: root.backgroundColor,
  });
})()`);
const L = JSON.parse(layout);
check('默认分栏：编辑器与预览同时存在', L.hasTextarea === true);
check('三态按钮齐备（edit/split/preview）', L.modes.join(',') === 'edit,split,preview', L.modes.join(','));
check('默认激活「分栏」', L.active === 'split', L.active);
check('顶栏 52px（与红绿灯同一行）', Math.round(L.bandHeight) === 52, `${L.bandHeight}px`);
check(
  '功能项就在顶栏里（不再单独占一行）',
  Math.round(L.toolbarTop) === 0,
  `top=${L.toolbarTop}`
);
check(
  '分栏时编辑区约占一半宽',
  Math.abs(L.editorWidth - L.innerWidth / 2) <= 3,
  `${Math.round(L.editorWidth)} / ${L.innerWidth}`
);

// ---------------------------------------------------------------- D. 打开文件
await ev(`window.__mdFileOpened({
  ok: true, path: '/tmp/demo.md', name: 'demo.md',
  content: '# 打开测试\\n\\n这是一段**加粗**内容。\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |'
})`);
await sleep(600);

const opened = await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const name = [...document.querySelectorAll('span')].map(s => s.textContent).includes('demo.md');
  return JSON.stringify({ value: ta.value, name, dirty: !!document.querySelector('.bg-amber-500') });
})()`);
const O = JSON.parse(opened);
check('打开文件：内容写入编辑区', O.value.startsWith('# 打开测试'), O.value.slice(0, 20));
check('打开文件：工具条显示文件名', O.name === true);
check('刚打开的文件不算「未保存」', O.dirty === false);

// ---------------------------------------------------------------- E. 编辑 + 保存
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value + '\\n\\n新增一行');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await waitFor(`!!document.querySelector('.bg-amber-500')`);
await waitFor(`(window.__mdSent.filter(s => s.action === 'state').pop() || {}).edited === true`);

const dirtyState = await ev(`(() => JSON.stringify({
  dirty: !!document.querySelector('.bg-amber-500'),
  state: (window.__mdSent || []).filter(p => p.action === 'state').pop(),
}))()`);
const D = JSON.parse(dirtyState);
check('编辑后出现未保存标记', D.dirty === true);
check(
  '状态已同步给原生（name/edited/path）',
  D.state && D.state.name === 'demo.md' && D.state.edited === true && D.state.path === '/tmp/demo.md',
  JSON.stringify(D.state)
);

await ev(`document.querySelector('[data-md-action="save"]').click()`);
await waitFor(`!document.querySelector('.bg-amber-500') && (window.__mdSent || []).some(p => p.action === 'save')`);
const saved = await ev(`(() => JSON.stringify({
  save: (window.__mdSent || []).filter(p => p.action === 'save').pop(),
  dirty: !!document.querySelector('.bg-amber-500'),
}))()`);
const S = JSON.parse(saved);
check('保存走已知路径（不弹另存为）', S.save && S.save.path === '/tmp/demo.md', JSON.stringify(S.save?.path));
check('保存成功后未保存标记消失', S.dirty === false);

await ev(`document.querySelector('[data-md-action="saveAs"]').click()`);
await sleep(400);
const saveAs = await ev(`JSON.stringify((window.__mdSent || []).filter(p => p.action === 'saveAs').pop())`);
const SA = JSON.parse(saveAs);
check('另存为带建议文件名', !!SA && typeof SA.suggestedName === 'string' && SA.suggestedName.length > 0, SA?.suggestedName);

// ---------------------------------------------------------------- F. 保存并关闭
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value + '\\n关闭前的一次修改');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  window.__mdSent.length = 0;
  window.__mdRequestSaveClose();
})()`);
await waitFor(`(window.__mdSent || []).some(p => p.action === 'closeNow')`);
const closeFlow = await ev(`JSON.stringify((window.__mdSent || []).map(p => p.action))`);
check(
  '「保存并关闭」：先写入再通知关窗',
  closeFlow.includes('save') && closeFlow.includes('closeNow'),
  closeFlow
);

// ---------------------------------------------------------------- B. 渲染一致性
// 先切回分栏并清空，才能点到「载入示例」（空态才出现该按钮）
await ev(`document.querySelector('[data-md-mode="split"]').click()`);
await sleep(300);
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(400);
const sampleClicked = await ev(`(() => {
  const btn = document.querySelector('[data-md-sample]');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
check('空态提供「载入示例」入口', sampleClicked === true);
await sleep(4500);

const render = await ev(`(() => {
  const body = document.querySelector('.markdown-body');
  const txt = body ? body.textContent : '';
  const stripped = (() => {
    const clone = body ? body.cloneNode(true) : null;
    if (!clone) return '';
    clone.querySelectorAll('code, pre, .katex, .mermaid-diagram').forEach(n => n.remove());
    return clone.textContent;
  })();
  return JSON.stringify({
    hasBody: !!body,
    katexInline: document.querySelectorAll('.katex').length,
    katexDisplay: document.querySelectorAll('.katex-display').length,
    tables: document.querySelectorAll('.markdown-body table').length,
    codeBlocks: document.querySelectorAll('[data-md-codeblock]').length,
    mermaidSvg: document.querySelectorAll('.mermaid-diagram svg').length,
    bold: document.querySelectorAll('.markdown-body strong').length,
    literalStars: /\\*\\*/.test(stripped),
    fontVar: getComputedStyle(body || document.body).fontSize,
  });
})()`);
const R = JSON.parse(render);
check('预览挂载了 markdown-body', R.hasBody === true);
check('行内公式渲染（KaTeX）', R.katexInline >= 1, String(R.katexInline));
check('块级公式渲染', R.katexDisplay >= 1, String(R.katexDisplay));
check('表格渲染', R.tables >= 1, String(R.tables));
check('代码块使用对话区同一套 CodeBlock', R.codeBlocks >= 1, String(R.codeBlocks));
check('Mermaid 出图（含 SVG）', R.mermaidSvg >= 1, String(R.mermaidSvg));
check('中文/普通加粗生效且无字面星号', R.bold >= 1 && R.literalStars === false, `strong=${R.bold}`);

// ---------------------------------------------------------------- C. 三态切换
await ev(`document.querySelector('[data-md-mode="edit"]').click()`);
await sleep(350);
const editOnly = await ev(`JSON.stringify({
  ta: !!document.querySelector('[data-md-editor]'),
  body: !!document.querySelector('.markdown-body'),
  w: document.querySelector('[data-md-editor]')?.getBoundingClientRect().width,
  iw: window.innerWidth,
})`);
const EO = JSON.parse(editOnly);
check('编辑态：只有编辑区且占满宽度', EO.ta && !EO.body && EO.w > EO.iw - 5, `${EO.w}/${EO.iw}`);

await ev(`document.querySelector('[data-md-mode="preview"]').click()`);
await sleep(350);
const previewOnly = await ev(`JSON.stringify({
  ta: !!document.querySelector('[data-md-editor]'),
  body: !!document.querySelector('.markdown-body'),
})`);
const PO = JSON.parse(previewOnly);
check('浏览态：只有预览', PO.ta === false && PO.body === true);

await ev(`document.querySelector('[data-md-mode="split"]').click()`);
await sleep(350);

// ---------------------------------------------------------------- I. 划选浮标（复用 SelectionSpeak）
const selSetup = await ev(`(() => {
  const p = document.querySelector('.markdown-body p');
  if (!p) return 'no-paragraph';
  const range = document.createRange();
  range.selectNodeContents(p);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return p.textContent.slice(0, 24);
})()`);
await waitFor(`!!document.querySelector('[data-tts-toolbar]')`);
const tts = await ev(`(() => {
  const el = document.querySelector('[data-tts-toolbar]');
  if (!el) return JSON.stringify({ found: false });
  const r = el.getBoundingClientRect();
  const pane = document.querySelector('.markdown-body')?.closest('div[class*="overflow-y-auto"]');
  const pr = pane?.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
    hasTranslate: /翻译|Translate/.test(el.textContent),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    pane: pr ? { left: Math.round(pr.left), right: Math.round(pr.right) } : null,
    topInset: getComputedStyle(document.documentElement).getPropertyValue('--window-top-inset').trim(),
  });
})()`);
const T = JSON.parse(tts);
check('划选后弹出快捷菜单（与对话区同一组件）', T.found === true, selSetup);
check('浮标含 翻译 / 朗读 / 复制 三个动作', T.found && T.hasTranslate && T.buttons.length >= 3, (T.buttons || []).join('|'));
check('浮标避开顶部 52px 原生拖拽带', T.found && T.rect.y >= 52, `y=${T.rect?.y} inset=${T.topInset}`);
check(
  '浮标完整落在窗口内',
  T.found && T.rect.x >= 0 && T.rect.x + T.rect.w <= 1200 && T.rect.y + T.rect.h <= 820,
  JSON.stringify(T.rect)
);

// 点「复制」应把选中的纯文本写进剪贴板（这里只验证按钮可点、不抛错）
await ev(`(() => { const b = [...document.querySelectorAll('[data-tts-toolbar] button')].pop(); b && b.click(); })()`);
await sleep(300);
const copiedSel = await ev(`JSON.stringify({ stillThere: !!document.querySelector('[data-tts-toolbar]') })`);
check('点击浮标按钮不报错、浮标仍在（可连续操作）', JSON.parse(copiedSel).stillThere === true);

// ---------------------------------------------------------------- J. 公式复制按钮（复用 InteractiveMath）
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  const filler = Array.from({ length: 12 }, (_, i) => '第 ' + (i + 1) + ' 段填充文本，用来把后面的内容推到可见区之外。').join('\\n\\n');
  setter.call(ta, '# 公式测试\\n\\n开头就有行内公式 $x^2$ 和结尾。\\n\\n' + filler + '\\n\\n最后一行 $y^2$。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  window.getSelection().removeAllRanges();
})()`);
await sleep(900);

const formulaClick = await ev(`(() => {
  const el = document.querySelector('.interactive-math');
  if (!el) return 'no-formula';
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'clicked';
})()`);
await waitFor(`!!document.querySelector('[data-math-toolbar]')`);
const mathBar = await ev(`(() => {
  const host = document.querySelector('.interactive-math');
  const bar = host?.querySelector('[data-math-toolbar]');
  if (!bar) return JSON.stringify({ found: false });
  const r = bar.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  const pane = document.querySelector('.markdown-body')?.closest('div[class*="overflow-y-auto"]');
  const pr = pane?.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    buttons: [...bar.querySelectorAll('button')].map(b => b.textContent.trim()),
    flippedBelow: r.top >= hr.bottom,
    rect: { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) },
    host: { top: Math.round(hr.top), bottom: Math.round(hr.bottom) },
    pane: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), left: Math.round(pr.left), right: Math.round(pr.right) } : null,
  });
})()`);
const MB = JSON.parse(mathBar);
check('点击公式弹出工具条（LaTeX + Word 两个复制按钮）', MB.found === true, formulaClick);
check('工具条含两种复制动作', MB.found && MB.buttons.length === 2, (MB.buttons || []).join('|'));
check(
  '工具条完整落在预览区内（不被滚动容器裁掉）',
  MB.found &&
    MB.pane &&
    MB.rect.top >= MB.pane.top - 1 &&
    MB.rect.bottom <= MB.pane.bottom + 1,
  `bar.top=${MB.rect?.top} pane.top=${MB.pane?.top}`
);
check(
  '工具条横向夹紧在预览区内',
  MB.found && MB.pane && MB.rect.left >= MB.pane.left - 1 && MB.rect.right <= MB.pane.right + 1,
  `bar=${MB.rect?.left}..${MB.rect?.right} pane=${MB.pane?.left}..${MB.pane?.right}`
);

// 复制 LaTeX 原文
await ev(`(() => { const b = document.querySelectorAll('[data-math-toolbar] button')[0]; b && b.click(); })()`);
await sleep(400);
const latexCopy = await ev(`JSON.stringify(window.__copiedRich || null)`);
const LC = JSON.parse(latexCopy);
check('复制 LaTeX 走原生剪贴板桥且带 $ 定界符', !!LC && /\$x\^2\$/.test(LC.plainText || ''), LC?.plainText);

// 复制 Word 原生公式块
await ev(`(() => { const b = document.querySelectorAll('[data-math-toolbar] button')[1]; b && b.click(); })()`);
await sleep(500);
const wordCopy = await ev(`JSON.stringify(window.__copiedWord || null)`);
const WC = JSON.parse(wordCopy);
check(
  '复制 Word 公式块走原生桥（含 MathML / OMML）',
  !!WC && typeof WC.mathml === 'string' && WC.mathml.includes('math') && typeof WC.html === 'string',
  WC ? `mathml=${WC.mathml.length}B html=${WC.html.length}B` : 'null'
);

await ev(`document.querySelector('[data-md-mode="split"]').click()`);
await sleep(350);

// 贴顶的极端情形：上方放不下时必须翻到公式下方，否则会被预览区顶边切掉。
// 同时覆盖「选中状态下内容变化」：React 复用组件实例、showToolbar 不变，
// 旧实现不会重新判定方向，工具条会停在 top 上被裁掉。
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '$x^2$\\n\\n下面是一段正文。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(900);
await ev(`(() => {
  let el = document.querySelector('.interactive-math');
  if (!el) return 'no-formula';
  // 内容变化后若选中态已丢失，工具条也不会在；点一下重新打开
  if (!el.querySelector('[data-math-toolbar]')) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'ok';
})()`);
await waitFor(`!!document.querySelector('.interactive-math [data-math-toolbar]')`);
const topEdge = await ev(`(() => {
  const host = document.querySelector('.interactive-math');
  const bar = host?.querySelector('[data-math-toolbar]');
  if (!bar) return JSON.stringify({ found: false });
  const r = bar.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  const pane = document.querySelector('.markdown-body')?.closest('div[class*="overflow-y-auto"]');
  const pr = pane?.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    flippedBelow: r.top >= hr.bottom,
    inPane: pr ? r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1 : null,
    barTop: Math.round(r.top), formulaBottom: Math.round(hr.bottom), paneTop: pr ? Math.round(pr.top) : null,
  });
})()`);
const TE = JSON.parse(topEdge);
check(
  '公式贴预览区顶部时工具条翻到下方',
  TE.found === true && TE.flippedBelow === true && TE.inPane !== false,
  `bar.top=${TE.barTop} formula.bottom=${TE.formulaBottom} pane.top=${TE.paneTop}`
);
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

// 截图前先恢复成示例文档，画面里同时有公式 / 表格 / Mermaid
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await ev(`(() => {
  const ta = document.querySelector('[data-md-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(400);
await ev(`document.querySelector('[data-md-sample]')?.click()`);
await sleep(4000);
let shot = await send('Page.captureScreenshot', { format: 'png' });
await import('node:fs').then((fs) => fs.writeFileSync('/tmp/md-editor-split.png', Buffer.from(shot.data, 'base64')));
await ev(`document.querySelector('[data-md-mode="preview"]').click()`);
await sleep(500);
shot = await send('Page.captureScreenshot', { format: 'png' });
await import('node:fs').then((fs) => fs.writeFileSync('/tmp/md-editor-preview.png', Buffer.from(shot.data, 'base64')));

// ---------------------------------------------------------------- I. 顶栏窄窗
const chromeProbe = `(() => {
  const band = document.querySelector('[data-md-action="open"]').closest('.h-screen').firstElementChild;
  const openBtn = document.querySelector('[data-md-action="open"]');
  const fileLabel = openBtn.querySelector('span');
  const modeLabel = document.querySelector('[data-md-mode="edit"] span');
  const nameEl = document.querySelector('[data-md-filename]');
  const br = band.getBoundingClientRect();
  const ob = openBtn.getBoundingClientRect();
  return JSON.stringify({
    bandTop: Math.round(br.top), bandH: Math.round(br.height),
    openLeft: Math.round(ob.left), btnW: Math.round(ob.width), btnH: Math.round(ob.height),
    innerW: window.innerWidth,
    fileLabelShown: !!fileLabel && fileLabel.getClientRects().length > 0,
    modeLabelShown: !!modeLabel && modeLabel.getClientRects().length > 0,
    nameShown: !!nameEl && nameEl.getClientRects().length > 0,
  });
})()`;

await send('Emulation.setDeviceMetricsOverride', { width: 1160, height: 760, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const wideChrome = JSON.parse(await ev(chromeProbe));
check('顶栏贴顶：上方没有空白带', wideChrome.bandTop === 0, wideChrome.bandTop);
check('顶栏高度仍为 52px', wideChrome.bandH === 52, wideChrome.bandH);
check(
  '功能项整体靠右（给红绿灯与拖拽留出左侧）',
  wideChrome.openLeft > wideChrome.innerW * 0.35,
  `${wideChrome.openLeft} / ${wideChrome.innerW}`
);
check('宽窗：按钮文字与文件名都在', wideChrome.fileLabelShown && wideChrome.modeLabelShown && wideChrome.nameShown, wideChrome);
const shotWide = await send('Page.captureScreenshot', { format: 'png' });
await import('node:fs').then((fs) => fs.writeFileSync('/tmp/md-chrome-wide.png', Buffer.from(shotWide.data, 'base64')));

await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(800);
const narrowChrome = JSON.parse(await ev(chromeProbe));
check('窄窗：文件名先隐藏', narrowChrome.nameShown === false, narrowChrome.nameShown);
check(
  '窄窗：按钮文字隐藏、只剩图标',
  narrowChrome.fileLabelShown === false && narrowChrome.modeLabelShown === false,
  narrowChrome
);
check(
  '窄窗：按钮不换行（高度仍是 32、宽度收到图标宽）',
  narrowChrome.btnH === 32 && narrowChrome.btnW < 60,
  `${narrowChrome.btnW}x${narrowChrome.btnH}`
);
const narrowClick = await ev(`(() => {
  document.querySelector('[data-md-mode="edit"]').click();
  return true;
})()`);
await sleep(400);
const narrowMode = await ev(`JSON.stringify({
  hasTa: !!document.querySelector('[data-md-editor]'),
  hasPreview: !!document.querySelector('.markdown-body'),
  active: document.querySelector('[data-md-mode].shadow-sm')?.dataset.mdMode,
})`);
const NM = JSON.parse(narrowMode);
check('窄窗：三态切换仍可点（切到编辑只剩编辑区）', narrowClick && NM.hasTa && !NM.hasPreview && NM.active === 'edit', NM);
const shotNarrow = await send('Page.captureScreenshot', { format: 'png' });
await import('node:fs').then((fs) => fs.writeFileSync('/tmp/md-chrome-narrow.png', Buffer.from(shotNarrow.data, 'base64')));

await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(500);

// ---------------------------------------------------------------- 报错检查
const errs = await ev(`JSON.stringify(window.__mdErrors || [])`);
check('页面无未捕获异常', JSON.parse(errs).length === 0, errs);

// ---------------------------------------------------------------- H. 主界面入口
await send('Page.navigate', { url: `${BASE}/` });
await sleep(3500);
const entry = await ev(`(() => {
  const btn = [...document.querySelectorAll('button[title]')];
  const md = btn.find(b => /Markdown/i.test(b.title));
  const scene = btn.find(b => /3D|场景/.test(b.title));
  const settings = btn.find(b => /设置|Settings/.test(b.title));
  const box = (el) => el ? Math.round(el.getBoundingClientRect().x) : null;
  return JSON.stringify({
    found: !!md,
    md: box(md), scene: box(scene), settings: box(settings),
    mdTitle: md?.title, sceneTitle: scene?.title,
  });
})()`);
const E = JSON.parse(entry);
check('侧栏出现 Markdown 入口', E.found === true, E.mdTitle || '');
check(
  '入口顺序：Markdown → 3D → 设置',
  E.md !== null && E.scene !== null && E.settings !== null && E.md < E.scene && E.scene < E.settings,
  `md=${E.md} 3d=${E.scene} settings=${E.settings}`
);

const shotMain = await send('Page.captureScreenshot', { format: 'png' });
await import('node:fs').then((fs) => fs.writeFileSync('/tmp/md-entry-main.png', Buffer.from(shotMain.data, 'base64')));

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '🎉 全部通过' : `⚠️ ${failed.length} 项失败`} (${results.length} 项)`);
if (logged.length) console.log('console.error:', logged.slice(0, 5));

ws.close();
proc.kill('SIGKILL');
process.exit(failed.length === 0 ? 0 : 1);
