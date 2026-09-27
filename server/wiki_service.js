import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { parse as parseHtml } from 'node-html-parser';
import * as OpenCC from 'opencc-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const KIWIX_PORT = 31236;

// 主力模型（TurboFieldfare）。承担实体规划、长文目录路由与最终答案生成。
// 注意：TTF 不支持多路并发，禁止在并行分支里调用。
export const MAIN_API_URL = process.env.MAIN_API_URL || 'http://127.0.0.1:1235';
export const MAIN_MODEL = process.env.MAIN_MODEL || 'gemma-4-26b-a4b-it';

const userConfigDir = path.join(
  process.env.HOME || '',
  'Library',
  'Application Support',
  'SimpleUI'
);
if (!fs.existsSync(userConfigDir)) {
  try {
    fs.mkdirSync(userConfigDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}
const CONFIG_FILE = path.join(userConfigDir, 'wiki_config.json');
const DEV_CONFIG_FILE = path.resolve(__dirname, 'wiki_config.json');

// Forward converters from Mainland Simplified to Traditional / Regional
const cvtCnToT = OpenCC.Converter({ from: 'cn', to: 't' });
const cvtCnToTw = OpenCC.Converter({ from: 'cn', to: 'tw' });
const cvtCnToTwp = OpenCC.Converter({ from: 'cn', to: 'twp' });
const cvtCnToHk = OpenCC.Converter({ from: 'cn', to: 'hk' });

// Backward converters to Mainland Simplified
const cvtTwpToCn = OpenCC.Converter({ from: 'twp', to: 'cn' });
const cvtHkToCn = OpenCC.Converter({ from: 'hk', to: 'cn' });

/**
 * Normalizes any Chinese text (Traditional, HK, TW phrases, or TW phrases written in simplified characters)
 * to standard Mainland Simplified Chinese.
 * Step 1: cn -> t aligns simplified-written TW/HK phrases (e.g. "记忆体", "软体") to OpenCC's traditional dictionary index ("記憶體", "軟體").
 * Step 2: twp -> cn and hk -> cn convert regional idioms and traditional characters to Mainland Simplified ("内存", "软件").
 */
export function toSimplifiedChinese(text) {
  if (!text || typeof text !== 'string') return text || '';
  try {
    const t = cvtCnToT(text);
    const tw = cvtTwpToCn(t);
    return cvtHkToCn(tw);
  } catch (e) {
    return text;
  }
}

/**
 * Generates the minimal, high-precision search variant set for Kiwix offline Wikipedia lookup.
 * Since entities planned by Qwen 3.5 2B or user queries are already normalized to Mainland Simplified Chinese,
 * this matrix outputs:
 * 1. The original keyword itself (e.g. '激光', '鼠标', '周杰伦')
 * 2. Traditional character standard (cn -> t, e.g. '激光', '鼠標', '周杰倫')
 * 3. Taiwan Traditional characters (cn -> tw)
 * 4. Taiwan Traditional regional phrase (cn -> twp, e.g. '雷射', '滑鼠')
 * 5. Hong Kong Traditional (cn -> hk)
 */
export function getAllVariants(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const mainland = toSimplifiedChinese(trimmed);
  const set = new Set([trimmed, mainland]);
  try {
    set.add(cvtCnToT(mainland));
    set.add(cvtCnToTw(mainland));
    set.add(cvtCnToTwp(mainland));
    set.add(cvtCnToHk(mainland));
  } catch (e) {
    // ignore
  }
  return Array.from(set).filter(Boolean);
}

// End of OpenCC variants helper

// 说明：命名空间前缀过滤已改为「数据表 + 前缀比对」（见下方 NON_ARTICLE_NAMESPACE_PREFIXES）。

function loadStoredZimPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && data.zimPath) return data.zimPath.trim();
    }
    if (fs.existsSync(DEV_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEV_CONFIG_FILE, 'utf-8'));
      if (data && data.zimPath) return data.zimPath.trim();
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// 读取持久化的知识库服务配置：ZIM 路径 + 服务总开关
function loadStoredConfig() {
  try {
    let data = null;
    if (fs.existsSync(CONFIG_FILE)) {
      data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } else if (fs.existsSync(DEV_CONFIG_FILE)) {
      data = JSON.parse(fs.readFileSync(DEV_CONFIG_FILE, 'utf-8'));
    }
    if (data) {
      return {
        zimPath: (data.zimPath || '').trim() || null,
        enabled: data.enabled !== undefined ? data.enabled !== false : true,
      };
    }
  } catch (e) {
    // ignore
  }
  return { zimPath: null, enabled: true };
}

function saveStoredConfig(zimPath, enabled) {
  const payload = { zimPath: (zimPath || '').trim(), enabled: enabled !== false };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (e) {
    console.error('[WikiService] Failed to save wiki_config.json:', e);
  }
  try {
    if (DEV_CONFIG_FILE !== CONFIG_FILE && fs.existsSync(DEV_CONFIG_FILE)) {
      fs.writeFileSync(
        DEV_CONFIG_FILE,
        JSON.stringify(payload, null, 2),
        'utf-8'
      );
    }
  } catch (e) {
    // ignore
  }
}

// Safe JSON parser with auto-repair for slightly truncated LLM outputs
function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Attempt auto-repair of unclosed JSON brackets
    let repaired = cleaned;
    if (!repaired.endsWith('}')) {
      if (repaired.includes('"intent_tokens":') && !repaired.endsWith(']')) {
        repaired = repaired.replace(/,[^,]*$/, '') + ']}';
      } else {
        repaired = repaired + '}';
      }
      try {
        return JSON.parse(repaired);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// ==========================================
// Phase 1: Structured Wikipedia DOM Decomposition（DOM 解析版）
// ==========================================
//
// 设计：不再用正则去"伺候"HTML，而是解析成 DOM 树后按**节点类型**抽取。这样天然解决
// 旧正则版的三个固有缺陷：
//   1) 内容类型覆盖：<p>/<ul>/<ol>/<table>/<dl>/<blockquote>/<pre> 都能抽到，不再漏掉
//      定义列表与公式（旧版只抽 p/ul/ol/table，会出现「…可以陈述为：」之后公式丢失的断句）；
//   2) Infobox 行：按 <tr> 遍历，**不要求** <th> 在 <td> 之前，也不怕嵌套子表格；
//   3) 章节层级：按文档顺序遇到 <h2> 切段，<h3>/<h4> 的内容归属其所在小节。
//
// 剪枝只依据 HTML 标签本身与 MediaWiki 的 class 名（结构性、跨语言），不依赖任何
// 具体语言词表或某个站点的排版细节。

// 注：figure 不在此列——它的 <figcaption> 是正文内容（图注），需要保留
const DROP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'iframe']);

// 结构性「非正文」class 标记（MediaWiki 标准命名，跨语言通用）
const NON_CONTENT_CLASS_TOKENS = new Set([
  'navbox', 'vertical-navbox', 'sidebar', 'ambox', 'metadata', 'mbox-small',
  'hatnote', 'mw-indicator', 'reflist', 'references', 'mw-references-wrap',
  'mw-editsection', 'sortkey', 'noprint', 'stub', 'catlinks',
  'printfooter', 'toc', 'mw-jump-link', 'mw-hidden-catlinks', 'navbox-styles',
  'mw-empty-elt', 'magnify', 'mw-cite-backlink', 'mw-file-description',
  'navigation-not-searchable', 'shortdescription', 'mw-hidden-catlinks',
  // 注：thumb / gallerybox / gallery 不在此列——它们承载图片与图注，需保留
  //     （曾把 thumb 留在这里，导致图集与老式缩略图的 <img> 被整枝删掉、面板只剩图注文字）
]);

// 结构性「非正文」id（同上，属结构标记）
const NON_CONTENT_IDS = new Set(['toc', 'catlinks', 'printfooter', 'mw-navigation', 'mw-panel']);

// 章节级「样板」标题：数据化清单（不是正则），中英双语，便于继续扩充
const BOILERPLATE_SECTIONS = [
  '注释', '註釋', '脚注', '腳註', '参考资料', '參考資料', '参考文献', '參考文獻',
  '出处', '出處', '文献', '文獻', '外部链接', '外部連結', '外部鏈接',
  '参见', '參見', '相关条目', '相關條目', '另见', '另見', '延伸阅读', '延伸閱讀',
  'notes', 'references', 'external links', 'see also', 'further reading',
  'footnotes', 'sources', 'bibliography',
];

// 块级正文标签；figure / .thumb / .gallerybox 是"带图注的图片容器"，产出图片标记
const BLOCK_SELECTOR =
  'p, ul, ol, table, dl, blockquote, pre, h2, h3, h4, h5, h6, figure, .thumb, .gallerybox';

// 图片标记：[[图|图片src|图注]]。注入上下文时转成 `[图略] 图注`；
// APP 内的条目页面则据此渲染真图片（src 为相对路径，前端按文章 URL 解析）。
/** 带图注的图片容器 → 图片标记（无图注的装饰图不产出） */
function imageMarker(el) {
  const tag = tagNameOf(el);
  const cls = classTokens(el);
  let captionEl = null;
  if (tag === 'figure') captionEl = el.querySelector('figcaption');
  else if (cls.has('thumb')) captionEl = el.querySelector('.thumbcaption');
  else if (cls.has('gallerybox')) captionEl = el.querySelector('.gallerytext');
  else return null;

  const img = el.querySelector('img');
  const src = img ? (img.getAttribute('src') || '').trim() : '';
  const caption = captionEl ? escapeForNesting(textOf(captionEl)) : '';
  if (!src && !caption) return null;
  return mark('img', src + '|' + caption);
}

function emptyDom() {
  return { infobox: [], section0: [], sections: [] };
}

function tagNameOf(el) {
  return String((el && el.tagName) || '').toLowerCase();
}

function classTokens(el) {
  const raw = (el && el.getAttribute && el.getAttribute('class')) || '';
  const set = new Set();
  for (const t of raw.split(/\s+/)) if (t) set.add(t);
  return set;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    });
}

// MathJax 的两种"排版样式"外壳：只影响渲染样式，不含任何数学信息
const MATHJAX_WRAPPER_TOKENS = ['{\\displaystyle ', '{\\textstyle '];

/**
 * 去掉 MathJax 的排版样式命令 `\displaystyle` / `\textstyle`，**保留其外层花括号**。
 * 只删样式命令、不动分组括号：`{\textstyle 1 \over 2}R` → `{1 \over 2}R`，
 * 分组语义不变（若连括号一起删会得到 `1 \over 2R`，反而产生歧义）。
 */
function stripMathjaxWrappers(tex) {
  let s = tex;
  for (let guard = 0; guard < 50; guard++) {
    const before = s;
    for (const token of MATHJAX_WRAPPER_TOKENS) s = s.split(token).join('{');
    if (s === before) break;
  }
  return s.trim();
}

/**
 * 数学公式的文本形式。
 * 离线维基里公式只有"图片 + LaTeX 源码"这一种文本表示（img.alt / math.alttext /
 * <annotation> 三者同源，img.title 为空），因此**保留公式 = 注入其 LaTeX**——
 * `\pi`、`\sqrt {2}`、`f:[0,1]\rightarrow \mathbb {C}` 这类是 LLM 能直接读懂的形式；
 * 仅剥掉 MathJax 的排版外壳，数学内容一字不动。
 */
function mathTexFromImage(img) {
  const raw = (img.getAttribute('alt') || '').trim();
  if (!raw) return '';
  return stripMathjaxWrappers(raw);
}

/** 图片的 alt 文本：公式图取其 LaTeX；普通装饰图不带入（旧行为一致） */
function imageAltText(img) {
  const cls = classTokens(img);
  const isMath =
    cls.has('mwe-math-fallback-image-inline') ||
    cls.has('mwe-math-fallback-image-display') ||
    cls.has('tex') ||
    (img.parentNode && classTokens(img.parentNode).has('mwe-math-element'));
  if (!isMath) return '';
  const tex = mathTexFromImage(img);
  // 注入侧还原后即「空格 + LaTeX + 空格」，与引入标记前完全一致；面板侧则渲染成真公式
  return tex ? ' ' + mark('tex', tex) + ' ' : '';
}

/** 单个节点的可见文本；<br> → ；，公式图保留 alt */
function nodeText(node) {
  if (!node) return '';
  let out = '';
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) {
      out += child.text != null ? child.text : (child.rawText || '');
    } else if (child.nodeType === 1) {
      const tn = tagNameOf(child);
      if (DROP_TAGS.has(tn)) continue;
      if (tn === 'br') { out += '；'; continue; }
      // 上/下标：纯文本抽取会把 10⁸ 拉平成 "108"、H₂O 拉平成 "H2O"，
      // 分别用 ^ 和 _ 标记保留幂次/下标语义
      if (tn === 'sup') { out += '^' + nodeText(child); continue; }
      if (tn === 'sub') { out += '_' + nodeText(child); continue; }
      if (tn === 'img') { out += imageAltText(child); continue; }
      out += nodeText(child);
    }
  }
  return out;
}

function collapse(s) {
  return decodeEntities(String(s)).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 结构化标记：面板渲染富文本的载体（公式 / 表格 / 图片 / 子标题）
//
// 设计要点：
//  1. 用 **Unicode 私有区字符**（U+E000 / U+E001）包裹，维基正文绝不会出现这些字符，
//     因此不存在「正文里的 `[[` 被误当标记」的冲突问题。
//  2. 标记**只服务于面板展示**；注入给模型的文本会经 convertMarkers() 还原成纯文本，
//     且还原结果与引入标记之前**逐字节一致**（有基线回归测试守着）。
//  3. 载荷用 `kind|payload` 形式，payload 内部允许出现 `|`，因为终止符是 U+E001 而非 `|`。
// ---------------------------------------------------------------------------
const MD_START = '\uE000';
const MD_END = '\uE001';
const MARKER_RE = new RegExp(MD_START + '([a-z0-9]+)\\|([\\s\\S]*?)' + MD_END, 'g');

function mark(kind, payload) {
  return MD_START + kind + '|' + payload + MD_END;
}

// 标记可以嵌套（例如表格单元格里放公式）：内层标记的**终止符**若原样出现在外层载荷里，
// 会把外层标记提前截断（JSON 拦腰断掉、内容泄漏）。嵌套载荷统一把 U+E001 转义为 U+E002，
// 解析时再还原。维基正文不会出现这两个字符，因此不存在与原文冲突的问题。
const MD_ESC = '\uE002';
const escapeForNesting = (s) => String(s).split(MD_END).join(MD_ESC);
const unescapeNesting = (s) => String(s).split(MD_ESC).join(MD_END);

/** 结构化标记 → 注入给模型的纯文本（此处每一项都必须与"没有标记的时代"完全一致） */
function markerToInjectionText(kind, payload) {
  if (kind === 'img') {
    const i = payload.indexOf('|');
    // 图注里可能嵌套公式标记 → 先还原转义再递归转换，否则标记会泄漏给模型
    const caption = convertMarkers(unescapeNesting(i === -1 ? '' : payload.slice(i + 1)));
    return caption ? `[图略] ${caption}` : '[图略]';
  }
  if (kind === 'tex') return payload; // 公式：注入侧照旧给 LaTeX 原文
  if (kind === 'sh') return '';       // 子标题：注入侧照旧不含标题文字
  if (kind === 'tbl') {
    // 还原为管道表文本：空白单元格会被丢弃（与引入标记前的行为一致）。
    // 单元格文本里可能嵌套公式标记（表格里放公式很常见）→ 同样要递归还原。
    try {
      const t = JSON.parse(payload);
      return (t.r || [])
        .map((cells) =>
          cells
            .map((c) => convertMarkers(unescapeNesting(String(c[0] == null ? '' : c[0]))))
            .filter((x) => x)
        )
        .filter((cells) => cells.length > 0)
        .map((cells) => '| ' + cells.join(' | ') + ' |')
        .join('\n');
    } catch (e) {
      return '';
    }
  }
  return '';
}

/** 把一串文本里的所有结构化标记还原为注入用纯文本 */
function convertMarkers(s) {
  return String(s).replace(MARKER_RE, (_m, kind, payload) => markerToInjectionText(kind, payload));
}

function textOf(node) {
  return collapse(nodeText(node));
}

function isNonContent(el) {
  if (NON_CONTENT_IDS.has(el.getAttribute('id') || '')) return true;
  const cls = classTokens(el);
  for (const t of cls) if (NON_CONTENT_CLASS_TOKENS.has(t)) return true;
  return false;
}

/** 结构性整枝剪枝：脚本/样式/图表 + 导航框/维护横幅/参考资料包裹层/编辑链接等 */
function pruneNonContent(content) {
  for (const el of content.querySelectorAll('*')) {
    const tn = tagNameOf(el);
    if (DROP_TAGS.has(tn)) { el.remove(); continue; }
    // 内联 display:none：浏览器不渲染的内容（隐藏分类、MathML 无障碍副本…），
    // 纯文本抽取会把它们带进正文（例如公式的 {\displaystyle ...} 源码）。
    const style = el.getAttribute('style') || '';
    if (/display\s*:\s*none/i.test(style)) { el.remove(); continue; }
    if (tn === 'sup') {
      const cls = classTokens(el);
      if (cls.has('reference') || cls.has('noprint')) { el.remove(); continue; }
    }
    if (isNonContent(el)) { el.remove(); continue; }
  }
}

/**
 * Infobox 整体截出（截出后从正文中移除）。
 * 按 <tr> 遍历，不要求 <th> 在 <td> 之前；同一行多个值以 " | " 连接；
 * 「仅有值」的续行归属到最近的键名上。
 */
function extractInfobox(content) {
  const out = [];
  let table = null;
  for (const t of content.querySelectorAll('table')) {
    if (classTokens(t).has('infobox')) { table = t; break; }
  }
  if (!table) return out;

  let lastKey = '';
  for (const tr of table.querySelectorAll('tr')) {
    const ths = tr.querySelectorAll('th');
    const tds = tr.querySelectorAll('td');
    const key = ths.length ? textOf(ths[0]) : '';
    if (key) lastKey = key; // 记住最近的键：供「仅有值」的续行归属
    const value = tds.map((td) => textOf(td)).filter((v) => v).join(' | ');

    if (key && value) out.push({ key, value });
    else if (!key && value && lastKey) out.push({ key: lastKey, value });
  }

  table.remove();
  return out;
}

/** 章节标题是否属于「样板尾部」（注释/参考文献/外部链接/参见…），命中即自此截断 */
function isBoilerplateHeading(title) {
  const t = String(title).trim().toLowerCase();
  if (!t) return false;
  for (const b of BOILERPLATE_SECTIONS) if (t.includes(b)) return true;
  return false;
}

/**
 * 按文档顺序取出「最外层」块级元素。
 * 只保留没有被其它块级元素包裹的那些，避免嵌套表格/列表被重复抽取。
 */
function orderedBlocks(content) {
  // 图集容器（ul.gallery）本身不作为独立块：改由其 .gallerybox 逐项产出图片标记
  const all = content
    .querySelectorAll(BLOCK_SELECTOR)
    .filter((el) => !classTokens(el).has('gallery'));
  const set = new Set(all);
  const out = [];
  for (const el of all) {
    let p = el.parentNode;
    let nested = false;
    while (p) {
      if (set.has(p)) { nested = true; break; }
      p = p.parentNode;
    }
    if (!nested) out.push(el);
  }
  return out;
}

function listToText(el) {
  const items = [];
  for (const li of el.querySelectorAll('li')) {
    const t = textOf(li);
    if (t) items.push('· ' + t);
  }
  return items.join('\n');
}

/**
 * 表格 → 结构化标记（供面板渲染真表格）。
 * 保留合并单元格信息（colspan / rowspan）与表头行数——实测 70% 的维基正文表格含合并单元格，
 * 管道文本根本无法还原；注入侧再由 markerToInjectionText 还原为管道表。
 * 单元格统一编码为 [文本] 或 [文本, colspan, rowspan]，保留空白单元格以保证列对齐。
 */
function tableToMarker(el) {
  const rows = [];
  let headerRows = 0;
  let dataStarted = false;

  for (const tr of el.querySelectorAll('tr')) {
    const cells = [];
    let allHeader = true;
    for (const c of tr.childNodes) {
      if (c.nodeType !== 1) continue;
      const tn = tagNameOf(c);
      if (tn !== 'th' && tn !== 'td') continue;
      if (tn !== 'th') allHeader = false;
      const cs = Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1);
      const rs = Math.max(1, parseInt(c.getAttribute('rowspan') || '1', 10) || 1);
      const t = escapeForNesting(textOf(c));
      cells.push(cs === 1 && rs === 1 ? [t] : [t, cs, rs]);
    }
    if (cells.length === 0) continue;
    if (allHeader && !dataStarted) headerRows++;
    else dataStarted = true;
    rows.push(cells);
  }

  if (rows.length === 0) return '';
  return mark('tbl', JSON.stringify({ h: headerRows, r: rows }));
}

function definitionListToText(el) {
  const lines = [];
  let pendingKey = '';
  for (const c of el.childNodes) {
    if (c.nodeType !== 1) continue;
    const tn = tagNameOf(c);
    const t = textOf(c);
    if (!t) continue;
    if (tn === 'dt') pendingKey = t;
    else if (tn === 'dd') { lines.push(pendingKey ? `${pendingKey}：${t}` : t); pendingKey = ''; }
    else lines.push(t);
  }
  return lines.join('\n');
}

function blockToText(el) {
  const tn = tagNameOf(el);
  if (tn === 'ul' || tn === 'ol') return listToText(el);
  if (tn === 'table') return tableToMarker(el);
  if (tn === 'dl') return definitionListToText(el);
  return textOf(el);
}

export function parseWikipediaDOM(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return emptyDom();

  let root;
  try {
    root = parseHtml(rawHtml);
  } catch (e) {
    return emptyDom();
  }

  const content =
    root.querySelector('.mw-parser-output') ||
    root.querySelector('#mw-content-text') ||
    root.querySelector('body') ||
    root;
  if (!content) return emptyDom();

  pruneNonContent(content);
  const infobox = extractInfobox(content);

  const section0 = [];
  const sections = [];
  let current = null;

  // h3/h4 的标题文字：**挂到紧随其后的内容块前面**（而不是自成一个段落）。
  // 这样注入侧还原后与"没有子标题标记的时代"完全一致；若该小节以子标题结尾，则自然丢弃。
  let pendingSubheads = '';

  for (const el of orderedBlocks(content)) {
    const tn = tagNameOf(el);

    if (tn === 'h2') {
      const title = textOf(el);
      if (isBoilerplateHeading(title)) break; // 样板尾部：自此截断
      pendingSubheads = '';
      current = { title, paragraphs: [] };
      sections.push(current);
      continue;
    }

    if (tn === 'h3' || tn === 'h4') {
      // 子标题文字里也可能嵌公式标记（如「计算 π 的意义」）→ 载荷必须转义，
      // 否则内层终止符会把 sh 标记提前截断，留下孤立的 U+E001 泄漏到注入文本。
      pendingSubheads += mark('sh', (tn === 'h3' ? '3' : '4') + '|' + escapeForNesting(textOf(el)));
      continue;
    }
    if (tn === 'h5' || tn === 'h6') continue;

    // 带图注的图片容器 → 图片标记（注入时转 [图略]，APP 内渲染真图）
    const marker = imageMarker(el);
    if (marker) {
      (current ? current.paragraphs : section0).push(pendingSubheads + marker);
      pendingSubheads = '';
      continue;
    }

    const text = (pendingSubheads + blockToText(el)).trim();
    pendingSubheads = '';
    if (!text) continue;
    (current ? current.paragraphs : section0).push(text);
  }

  return {
    infobox,
    section0,
    sections: sections.filter((s) => s.title && s.paragraphs.length > 0),
  };
}

// 主力模型目录语义路由：超长条目（> 3500 字）从大纲目录与 Infobox 键名中
// 挑选最可能包含答案的小节与属性。规则放 system，数据放 user。
export async function routeArticleSectionsWithSLM(query, headings, infoboxKeys) {
  if (!query || (!headings.length && !infoboxKeys.length)) {
    return { sections: [], keys: [] };
  }

  const systemPrompt = `[任务] 从百科条目的章节大纲与 Infobox 属性列表中，挑选最可能直接包含用户问题答案的小节与属性。
[输出] 只输出一个 JSON 对象：{"sections": ["小节名称"], "keys": ["属性名称"]}，不要输出任何其他文字。
[规则]
1. sections 选 1~2 个最相关小节；keys 选 1~3 个最相关属性。
2. 名称必须与给定列表逐字一致，不要改写、翻译或补充。
3. 若都无法确定，输出空数组。`;

  const userPrompt = `用户问题：${query}
章节大纲：${JSON.stringify(headings.slice(0, 25))}
属性列表：${JSON.stringify(infoboxKeys.slice(0, 30))}

输出：`;

  const out = await callMainModel(userPrompt, {
    systemPrompt,
    maxTokens: 80,
    timeoutMs: 30000,
  });
  if (!out) return { sections: [], keys: [] };

  const parsed = safeParseJson(out);
  if (parsed) {
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
    };
  }
  return { sections: [], keys: [] };
}

// Assemble zero-truncation, high-fidelity article context
export async function assembleArticleContext(rawHtml, userQuery) {
  const dom = parseWikipediaDOM(rawHtml);

  // Step 2: 全局二次归一 + 结构化标记还原。
  // 关键：标记必须在**统计字数之前**还原——否则 U+E000/E001 与 JSON 载荷会虚增 totalLength，
  // 令 3500 字分支判断（panoramic / routed）与改造前不一致，注入内容就会变。
  const normInfobox = dom.infobox.map((item) => ({
    key: convertMarkers(toSimplifiedChinese(item.key)),
    value: convertMarkers(toSimplifiedChinese(item.value)),
  }));

  const normSection0 = dom.section0
    .map((p) => convertMarkers(toSimplifiedChinese(p)))
    .filter((p) => p.trim().length > 0);
  const normSections = dom.sections.map((s) => ({
    title: convertMarkers(toSimplifiedChinese(s.title)),
    paragraphs: s.paragraphs
      .map((p) => convertMarkers(toSimplifiedChinese(p)))
      .filter((p) => p.trim().length > 0),
  }));

  const totalLength =
    normSection0.reduce((acc, p) => acc + p.length, 0) +
    normSections.reduce((acc, s) => acc + s.paragraphs.reduce((p1, p2) => p1 + p2.length, 0), 0);

  // Branch A: Standard & Short Articles (<= 3500 chars, ~75% of Wikipedia)
  if (totalLength <= 3500) {
    const parts = [];

    if (normInfobox.length > 0) {
      const kvs = normInfobox.map((item) => `${item.key}: ${item.value}`);
      parts.push(`[基本档案]\n${kvs.join(' | ')}`);
    }

    if (normSection0.length > 0) {
      parts.push(`[核心导言]\n${normSection0.join('\n\n')}`);
    }

    for (const s of normSections) {
      parts.push(`[${s.title}]\n${s.paragraphs.join('\n\n')}`);
    }

    return {
      mode: 'panoramic',
      totalLength,
      context: parts.join('\n\n'),
    };
  }

  // Branch B: Extra-Long Articles (> 3500 chars, e.g. 周杰伦)
  const headings = normSections.map((s) => s.title);
  const infoboxKeys = normInfobox.map((item) => item.key);

  const route = await routeArticleSectionsWithSLM(userQuery, headings, infoboxKeys);

  const parts = [];

  // 1. Infobox: Filter by selected keys, or take first 8 if none matched
  const selectedKeysSet = new Set(route.keys.map((k) => k.trim()));
  let chosenInfobox = normInfobox.filter((item) => selectedKeysSet.has(item.key));
  if (chosenInfobox.length === 0) {
    chosenInfobox = normInfobox.slice(0, 8);
  }
  if (chosenInfobox.length > 0) {
    const kvs = chosenInfobox.map((item) => `${item.key}: ${item.value}`);
    parts.push(`[基本档案]\n${kvs.join(' | ')}`);
  }

  // 2. Section 0: 保留完整引言（不再只取第一段）
  if (normSection0.length > 0) {
    parts.push(`[核心导言]\n${normSection0.join('\n\n')}`);
  }

  // 3. Target Sections: Load complete paragraphs of selected sections
  const selectedSectionsSet = new Set(route.sections.map((s) => s.trim().toLowerCase()));
  let loadedSections = normSections.filter(
    (s) =>
      selectedSectionsSet.has(s.title.trim().toLowerCase()) ||
      route.sections.some((target) => s.title.includes(target) || target.includes(s.title))
  );

  // Fallback: If SLM didn't match sections, take the first 2 sections
  if (loadedSections.length === 0) {
    loadedSections = normSections.slice(0, 2);
  }

  for (const s of loadedSections) {
    parts.push(`[${s.title}]\n${s.paragraphs.join('\n\n')}`);
  }

  return {
    mode: 'routed',
    totalLength,
    route,
    context: parts.join('\n\n'),
  };
}

// 说明：原「MRC 事实抽取」环节（Qwen 3.5 2B 改写一句事实）已整体移除。
// 现在直接把抓取并归一后的原文交给主力模型，由它自行定位相关信息并生成答案——
// 没有改写就没有编造，且问「列出所有作品」这类问题时原文列表可以直接照抄。

/**
 * 调用主力模型（TurboFieldfare，端口 1235）。
 *
 * 严格遵循项目既有调用约定（见 src/services/api.ts）：
 * - TurboFieldfareServer 的 OpenAIModels **严格拒绝未识别字段**，payload 只能用白名单内的键
 * - 深度思考由 `chat_template_kwargs` 与 `reasoning_effort` **成对**控制，
 *   关闭时必须同时给 enable_thinking:false 与 reasoning_effort:'none'
 * - 主力模型**不支持多路并发**，调用方必须串行
 */
export async function callMainModel(
  prompt,
  { systemPrompt = null, maxTokens = 64, timeoutMs = 30000, temperature = 0, seed = null } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Gemma 4 原生支持 system role，规则放 system、问题放 user 比全塞 user 更稳。
  // temperature 用 0：实测与官方建议的 1.0 在 12 个全新问题上质量一致，
  // 但 1.0 存在规划结果在 ["Jay"]/["周杰伦"] 间跳变的方差，0 可消除。
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  try {
    const res = await fetch(`${MAIN_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MAIN_MODEL,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature,
        top_p: 0.95,
        top_k: 64,
        repetition_penalty: 1.0,
        max_tokens: maxTokens,
        ...(seed !== null ? { seed } : {}),
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: 'none',
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    // 逐 SSE 片段拼接 content（与前端 streamChat 解析方式一致）
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) out += delta.content;
        } catch (e) {
          // ignore malformed chunk
        }
      }
    }
    return out.trim() || null;
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}


// 规划规则放 system（Gemma 4 原生支持 system role，指令遵循更稳），示例与提问放 user。
// 示例只保留 3 条「演示规则」性质的：消歧 / 事件名映射 / 不凑数。
export const MAIN_PLANNER_SYSTEM = `[任务] 从用户的提问中，提取需要在中文百科全书里检索的条目名称。
[输出] 只输出一个 JSON 对象：{"target_articles": ["条目名"]}，不要输出任何其他文字。
[规则]
1. 默认只给 1 个条目。只有当提问确实同时涉及两个彼此独立、且都必须分别查证的实体时，才给 2 个。严禁为了凑数而推测提问中并未出现的实体。
2. 条目名必须是百科中真实存在的规范名称：人物用全名，机构/作品/事件用通行名，存在歧义时加限定词。
3. 不要保留疑问词、代词或解释性文字。`;

export const MAIN_PLANNER_USER = (query) => `[示例]
问：特斯拉现在的CEO是谁？
答：{"target_articles": ["特斯拉公司", "埃隆·马斯克"]}
问：中国第一颗原子弹爆炸是在什么时候？
答：{"target_articles": ["596工程"]}
问：哥德巴赫猜想是谁提出的？主要是讲的什么内容？
答：{"target_articles": ["哥德巴赫猜想"]}

问：${query}
答：`;

export async function planQueryWithMainModel(query) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  const out = await callMainModel(MAIN_PLANNER_USER(trimmed), {
    systemPrompt: MAIN_PLANNER_SYSTEM,
    maxTokens: 64,
    timeoutMs: 30000,
  });
  if (!out) return null;

  const parsed = safeParseJson(out);
  if (parsed && Array.isArray(parsed.target_articles)) {
    const articles = parsed.target_articles
      .map((a) => String(a).replace(/[《》]/g, '').trim())
      .filter(Boolean)
      .slice(0, 2);
    if (articles.length > 0) {
      return {
        needs_wiki: true,
        target_articles: articles,
        planner: 'main-model',
      };
    }
  }
  return null;
}

// 实体规划入口：由主力模型承担（不做小模型回退——1234 服务已从链路中移除）。
// 规划失败时返回 null，由 getRagContext 使用归一后的原始提问直接检索。
export async function planQuery(query) {
  return planQueryWithMainModel(query);
}

// ==========================================
// 候选筛选与排序（通用：结构性判断 + 纯算术打分，零语言词表）
// ==========================================

// 命名空间前缀表（**数据**，不是正则）。MediaWiki 命名空间是固定标准概念，
// 文章页的标题永远不会带冒号前缀——这是筛掉「非文章页」最可靠、且零成本的一层。
const NON_ARTICLE_NAMESPACE_PREFIXES = new Set([
  // 中文
  'special', '特殊', 'talk', '討論', '讨论', 'user', '用戶', '用户',
  'wikipedia', '維基百科', '维基百科', 'project', 'file', 'image', '檔案', '文件', '档案',
  'mediawiki', 'template', '模板', 'help', '幫助', '帮助', 'category', '分類', '分类',
  'portal', '主題', '主题', 'draft', '草稿', 'module', '模組', '模块',
  'book', 'course', 'thread', 'summary', 'page', 'index', 'topic', 'timedtext', '朗讀', '朗读',
  // 英文/其他站点常见
  'gadget', 'gadget definition', 'media', 'wi', 'wikipedia talk', 'file talk', 'template talk',
]);

const MAX_CANDIDATES = 12;   // 深度解析（HEAD）的候选上限，避免全量扇出
const SUGGEST_COUNT = 30;    // 标题联想条数
const FULLTEXT_COUNT = 8;    // 全文检索结果数
const SENSES_TO_MODEL = 40;  // 送去模型选择的义项上限

/** 标题是否属于「非文章页」（命名空间页） */
function isNonArticleTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  const colon = t.search(/[:：]/);
  if (colon <= 0) return false;
  return NON_ARTICLE_NAMESPACE_PREFIXES.has(t.slice(0, colon).trim().toLowerCase());
}

/**
 * 候选相关度（纯算术，零词表）：
 *   覆盖率（最长匹配变体 ÷ 标题长度）+ 前缀命中加权 + 通道可靠度加权 − 超长标题惩罚
 */
function relevanceScore(candidate, variants) {
  const title = String(candidate.title || '');
  const len = title.length || 1;
  let matched = 0;
  for (const v of variants) {
    if (!v) continue;
    if (title === v || title.includes(v)) matched = Math.max(matched, v.length);
  }
  const coverage = matched / len;
  const prefix = variants.some((v) => v && title.startsWith(v)) ? 0.15 : 0;
  const reliability = typeof candidate.reliability === 'number' ? candidate.reliability : 0.5;
  const lengthPenalty = Math.min(0.3, Math.max(0, len - 20) / 100);
  return coverage + prefix + reliability * 0.5 - lengthPenalty;
}

// 消歧义分类名片段（**数据**，不是判定逻辑）：页面自身的分类命中即视为消歧义页。
// 中英覆盖，便于继续扩充语言。这来自 MediaWiki 的页面分类元数据（wgCategories），
// 而非对版式的猜测——比任何结构启发式都可靠。
const DISAMBIG_CATEGORY_HINTS = ['消歧义', '消歧義', 'disambiguation'];

/**
 * 读取页面自身的分类（MediaWiki 的 wgCategories 元数据）。
 * 返回 true / false；元数据不存在时返回 null（表示「无法判断」）。
 */
function disambiguationByCategory(html) {
  const m = html.match(/"wgCategories"\s*:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const cats = m[1].toLowerCase();
  return DISAMBIG_CATEGORY_HINTS.some((h) => cats.includes(h.toLowerCase()));
}

/**
 * 消歧义页判定（按可靠性从高到低）：
 *   ① 页面分类命中消歧义分类（权威元数据，跨语言）      → isDisambig=true, strong=true
 *   ② 有分类元数据且未命中                            → 明确判定为普通条目，不再猜测
 *   ③ 结构标记：#disambigbox，或**非 <a> 元素**上的 disambig / mw-disambig 类
 *      （<a class="mw-disambig"> 只是"指向消歧义页"的链接，不能当页面标记）
 *   ④ 仅当分类元数据缺失时，才退化为结构特征启发式
 */
function detectDisambiguation(html) {
  if (!html) return { isDisambig: false, strong: false, via: 'empty' };

  // ① / ② 权威元数据优先
  const byCategory = disambiguationByCategory(html);
  if (byCategory === true) return { isDisambig: true, strong: true, via: 'category' };
  if (byCategory === false) return { isDisambig: false, strong: false, via: 'category' };

  try {
    const root = parseHtml(html);
    const content = root.querySelector('.mw-parser-output') || root.querySelector('body') || root;
    if (content.querySelector('#disambigbox')) {
      return { isDisambig: true, strong: true, via: 'disambigbox' };
    }

    for (const el of content.querySelectorAll('*')) {
      if (String(el.tagName || '').toLowerCase() === 'a') continue;
      const cls = classTokens(el);
      if (cls.has('disambig') || cls.has('disambigbox') || cls.has('mw-disambig')) {
        return { isDisambig: true, strong: true, via: 'class' };
      }
    }

    const hasInfobox = [...content.querySelectorAll('table')].some((t) =>
      classTokens(t).has('infobox')
    );
    if (hasInfobox) return { isDisambig: false, strong: false, via: 'structural' };

    const h2Count = content.querySelectorAll('h2').length;
    let prose = 0;
    for (const p of content.querySelectorAll('p')) prose += textOf(p).length;
    const linkItems = content.querySelectorAll('li a').length;

    return {
      isDisambig: h2Count === 0 && prose < 400 && linkItems >= 5,
      strong: false,
      via: 'structural',
    };
  } catch (e) {
    return { isDisambig: false, strong: false, via: 'error' };
  }
}

/** 抽出消歧义页的义项清单 [{title, description}]（纯结构解析，零硬编码） */
function extractSenses(html) {
  const out = [];
  if (!html) return out;
  try {
    const root = parseHtml(html);
    const content = root.querySelector('.mw-parser-output') || root.querySelector('body') || root;
    const seen = new Set();
    for (const a of content.querySelectorAll('a[title]')) {
      const title = (a.getAttribute('title') || '').trim();
      if (!title || seen.has(title) || isNonArticleTitle(title)) continue;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#') || /^[a-z]+:/i.test(href)) continue;

      let lineEl = a.parentNode;
      while (lineEl && String(lineEl.tagName || '').toLowerCase() !== 'li') lineEl = lineEl.parentNode;
      const source = lineEl || a.parentNode;
      // 义项描述会进"义项选择"的提示词，必须先把结构化标记还原成纯文本，避免标记泄漏给模型
      const description = convertMarkers(textOf(source)).slice(0, 200);
      if (!description) continue;

      seen.add(title);
      out.push({ title, description });
      if (out.length >= SENSES_TO_MODEL) break;
    }
    return out;
  } catch (e) {
    return out;
  }
}

// 义项选择的提示词（规则放 system，数据放 user）
const SENSE_PICK_SYSTEM = `[任务] 用户用某个词提问，该词在百科中有多个不同含义。下面给出该词对应的候选条目。
[输出] 只输出一个 JSON 对象：{"pick": "条目名称"} 或 {"pick": null}，不要输出任何其他文字。
[规则]
1. 从候选中选出**最符合用户问题意图**的那一个；名称必须与候选列表逐字一致，不要改写。
2. 若没有任何候选与用户问题相关，输出 {"pick": null}。严禁猜测。`;

/** 用主力模型从义项列表中选一个（返回 null 表示都不匹配 → 该关键字弃权） */
async function pickSenseWithMainModel(question, senses) {
  if (!senses || senses.length === 0) return null;
  const lines = senses.map((s) => `- ${s.title}：${s.description}`).join('\n');
  const userPrompt = `[用户问题]\n${question}\n\n[候选条目]\n${lines}\n\n[输出]`;

  const out = await callMainModel(userPrompt, {
    systemPrompt: SENSE_PICK_SYSTEM,
    maxTokens: 64,
    timeoutMs: 30000,
  });
  if (!out) return null;

  const parsed = safeParseJson(out);
  const pick = parsed && typeof parsed.pick === 'string' ? parsed.pick.trim() : '';
  if (!pick) return null;
  const target = senses.find((s) => s.title === pick);
  return target ? target.title : null;
}
class WikiService {
  constructor() {
    this.kiwixProcess = null;
    this.currentZimPath = null;
    this.contentId = null;
    this.bookTitle = '知识库';
    this.articleCount = 0;
    this.mediaCount = 0;
    this.isOnline = false;
    this.isStarting = false;
    this.scanInterval = null;
    // 知识库服务总开关：关闭时完全停服（不拉起 kiwix、不自动重连）
    const stored = loadStoredConfig();
    this.enabled = stored.enabled;
  }

  // Find ZIM file strictly by verifying path existence (no SSD specific detection)
  findZimFile(preferredPath) {
    const target = (
      preferredPath ||
      loadStoredZimPath() ||
      '/Volumes/JustinSSD/wikipedia/wikipedia_zh_all_maxi_2026-08.zim'
    ).trim();

    if (!target) return null;

    try {
      if (!fs.existsSync(target)) return null;
      const stat = fs.statSync(target);
      if (stat.isFile() && target.endsWith('.zim')) {
        return target;
      }
      if (stat.isDirectory()) {
        const files = fs.readdirSync(target);
        const zim = files.find((f) => f.endsWith('.zim'));
        if (zim) return path.join(target, zim);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  // Find kiwix-serve executable
  findKiwixServeBin() {
    const candidates = [
      path.resolve(__dirname, '../bin/kiwix/kiwix-serve'),
      path.resolve(__dirname, '../../Resources/bin/kiwix/kiwix-serve'),
      '/Applications/SimpleUI.app/Contents/Resources/bin/kiwix/kiwix-serve',
      '/opt/homebrew/bin/kiwix-serve',
      '/usr/local/bin/kiwix-serve',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  // Check if kiwix-serve is healthy and responding
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${KIWIX_PORT}/catalog/v2/entries`,
        { timeout: 1500 },
        (res) => {
          if (res.statusCode === 200) {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              this.parseCatalogData(data);
              this.isOnline = true;
              resolve(true);
            });
          } else {
            this.isOnline = false;
            resolve(false);
          }
        }
      );
      req.on('error', () => {
        this.isOnline = false;
        resolve(false);
      });
      req.on('timeout', () => {
        req.destroy();
        this.isOnline = false;
        resolve(false);
      });
    });
  }

  parseCatalogData(xml) {
    try {
      const nameMatch = xml.match(/<name>(.*?)<\/name>/);
      const flavourMatch = xml.match(/<flavour>(.*?)<\/flavour>/);
      const titleMatch = xml.match(/<title>(.*?)<\/title>/);
      const articleCountMatch = xml.match(/<articleCount>(\d+)<\/articleCount>/);
      const mediaCountMatch = xml.match(/<mediaCount>(\d+)<\/mediaCount>/);

      if (nameMatch && flavourMatch) {
        this.contentId = `${nameMatch[1]}_${flavourMatch[1]}`;
      } else {
        const linkMatch = xml.match(/href="\/content\/([^"]+)"/);
        if (linkMatch) {
          this.contentId = linkMatch[1];
        }
      }

      if (titleMatch) this.bookTitle = titleMatch[1];
      if (articleCountMatch) this.articleCount = parseInt(articleCountMatch[1], 10);
      if (mediaCountMatch) this.mediaCount = parseInt(mediaCountMatch[1], 10);
    } catch (e) {
      console.error('[WikiService] Failed to parse catalog XML:', e);
    }
  }

  // Start or restart kiwix-serve daemon
  async startService(customPath) {
    // 总开关关闭：确保没有任何 kiwix 进程在跑
    if (!this.enabled) {
      await this.stopService();
      return false;
    }
    if (this.isStarting) return false;
    this.isStarting = true;

    try {
      const zimPath = this.findZimFile(customPath);
      if (!zimPath) {
        this.isOnline = false;
        this.currentZimPath = customPath || loadStoredConfig().zimPath || null;
        this.isStarting = false;
        return false;
      }

      this.currentZimPath = zimPath;

      // If already healthy on port 31236, reuse without port collision
      const healthy = await this.checkHealth();
      if (healthy) {
        this.isOnline = true;
        this.isStarting = false;
        return true;
      }

      // Kill previous process if restarting with new file
      if (this.kiwixProcess) {
        try {
          this.kiwixProcess.kill('SIGTERM');
        } catch (e) {
          // ignore
        }
        this.kiwixProcess = null;
        await new Promise((r) => setTimeout(r, 400));
      }

      const bin = this.findKiwixServeBin();
      if (!bin) {
        console.error('[WikiService] kiwix-serve binary not found');
        this.isStarting = false;
        return false;
      }

      console.log(`[WikiService] Launching kiwix-serve for: ${zimPath}`);
      const args = [
        '-p', `${KIWIX_PORT}`,
        '-i', '127.0.0.1',
        '-n', // no top search bar overlay
        '-m', // no home button overlay
        '-z', // no date aliases
        `--attachToProcess=${process.pid}`, // exit when proxy.js dies
        zimPath,
      ];

      const child = spawn(bin, args, {
        detached: false,
        stdio: 'ignore',
      });

      this.kiwixProcess = child;

      child.on('exit', (code) => {
        console.log(`[WikiService] kiwix-serve exited with code: ${code}`);
        this.isOnline = false;
        this.kiwixProcess = null;
      });

      // Poll until ready (up to 4 seconds)
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const ready = await this.checkHealth();
        if (ready) {
          console.log(`[WikiService] kiwix-serve ready on port ${KIWIX_PORT}, content: ${this.contentId}`);
          this.isOnline = true;
          this.isStarting = false;
          return true;
        }
      }

      this.isStarting = false;
      return false;
    } catch (e) {
      console.error('[WikiService] startService error:', e);
      this.isStarting = false;
      return false;
    }
  }

  // 彻底停服：杀掉 kiwix-serve 进程并清空在线状态
  async stopService() {
    if (this.kiwixProcess) {
      try {
        this.kiwixProcess.kill('SIGTERM');
      } catch (e) {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
      if (this.kiwixProcess && !this.kiwixProcess.killed) {
        try {
          this.kiwixProcess.kill('SIGKILL');
        } catch (e) {
          // ignore
        }
      }
      this.kiwixProcess = null;
    }
    this.isOnline = false;
    this.isStarting = false;
    return true;
  }

  // 切换知识库服务总开关
  async setEnabled(enabled) {
    this.enabled = enabled !== false;
    saveStoredConfig(this.currentZimPath, this.enabled);
    if (this.enabled) {
      await this.startService(this.currentZimPath || undefined);
    } else {
      await this.stopService();
    }
    return this.enabled;
  }

  // Periodic health check & external disk disconnect/reconnect watcher
  initWatcher() {
    this.startService();
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = setInterval(async () => {
      // 0. 总开关关闭时不托管服务，并确保没有残留进程
      if (!this.enabled) {
        if (this.kiwixProcess || this.isOnline) {
          await this.stopService();
        }
        return;
      }

      // 1. 如果配置了 ZIM 路径，先检测文件是否在磁盘上依然存在 (支持硬盘弹出平滑断开)
      if (this.currentZimPath && !fs.existsSync(this.currentZimPath)) {
        if (this.isOnline || this.kiwixProcess) {
          console.log(`[WikiService] 检测到 ZIM 文件已断开或被移走: ${this.currentZimPath}`);
          this.isOnline = false;
          this.articleCount = 0;
          if (this.kiwixProcess) {
            try {
              this.kiwixProcess.kill('SIGKILL');
            } catch (e) {
              // ignore
            }
            this.kiwixProcess = null;
          }
        }
        return;
      }

      // 2. 文件就绪时检测服务健康状态；若断开或异常退出则自动重新拉起
      const alive = await this.checkHealth();
      if (!alive && this.currentZimPath && fs.existsSync(this.currentZimPath)) {
        console.log(`[WikiService] 检测到 ZIM 服务离线但文件就绪，正在自动重新连接...`);
        await this.startService(this.currentZimPath);
      }
    }, 5000);
  }

  // ---------- 召回通道（多通道 + 来源标记 + 可靠度）----------
  // 通道只负责「产出候选」，不做取舍；取舍由 _resolveForKeyword 按关键字进行。

  /** 通道 A：精确探针（HEAD 200 / 301/302 跟随）——关键词就是条目标题 */
  async _probeExact(variants) {
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const results = await Promise.all(
      variants.map(async (v) => {
        try {
          const url = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(v)}`;
          const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(1200),
          });
          if (res.status === 200) {
            return { title: v, path: v, url, source: 'exact', reliability: 0.95 };
          }
          if (res.status === 301 || res.status === 302) {
            const loc = res.headers.get('location') || '';
            const target = decodeURIComponent(loc.split('/').pop() || '');
            if (target) {
              return {
                title: target,
                path: target,
                url: `http://127.0.0.1:${KIWIX_PORT}${loc}`,
                source: 'exact',
                reliability: 0.95,
              };
            }
          }
        } catch (e) {
          // ignore
        }
        return null;
      })
    );
    return results.filter((x) => x && !isNonArticleTitle(x.title));
  }

  /** 通道 B：标题联想（标题「包含」关键词，含各种字形/用词变体） */
  async _suggestTitles(variants) {
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const lists = await Promise.all(
      variants.map(async (v) => {
        try {
          const url = `http://127.0.0.1:${KIWIX_PORT}/suggest?content=${encodeURIComponent(
            content
          )}&term=${encodeURIComponent(v)}&count=${SUGGEST_COUNT}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) return [];
          const json = await res.json();
          if (!Array.isArray(json)) return [];
          return json
            .filter((it) => it.kind === 'path' && it.value)
            .map((it, idx) => {
              const title = String(it.value).trim();
              const p = it.path || title;
              return {
                title,
                path: p,
                rank: idx,
                source: 'suggest',
                reliability: 0.6,
                url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(p)}`,
              };
            });
        } catch (e) {
          return [];
        }
      })
    );
    const out = [];
    for (const list of lists) {
      for (const item of list) {
        const t = item.title;
        if (isNonArticleTitle(t)) continue;
        if (variants.some((v) => v && t.includes(v))) out.push(item);
      }
    }
    return out;
  }

  /** 通道 D：Kiwix 全文检索（末位手段：只在 A/B/C 无可用候选时启用） */
  async _fullTextSearch(term) {
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    try {
      const url = `http://127.0.0.1:${KIWIX_PORT}/search?content=${encodeURIComponent(
        content
      )}&pattern=${encodeURIComponent(term)}&books.count=1&pageLength=${FULLTEXT_COUNT}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return [];
      const body = await res.text();
      const out = [];
      const seen = new Set();
      for (const m of body.matchAll(/href="\/content\/[^/]+\/([^"#?]+)"/g)) {
        const title = decodeURIComponent(m[1]);
        if (!title || seen.has(title) || isNonArticleTitle(title)) continue;
        seen.add(title);
        out.push({
          title,
          path: title,
          source: 'fulltext',
          reliability: 0.35,
          url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(title)}`,
        });
        if (out.length >= FULLTEXT_COUNT) break;
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  /**
   * 候选收敛：先按通用相关度粗排，只对前 MAX_CANDIDATES 个做规范路径解析（HEAD），
   * 再按规范路径去重——同一文章的多个别名只留一篇。
   */
  async _resolveCandidates(candidates, variants) {
    if (!candidates || candidates.length === 0) return [];
    const ranked = [...candidates].sort(
      (a, b) => relevanceScore(b, variants) - relevanceScore(a, variants)
    );
    const top = ranked.slice(0, MAX_CANDIDATES);
    // 精确探针的候选路径已是规范路径，无需再发一次 HEAD（避免重复探测）
    const resolved = await Promise.all(
      top.map((c) => (c.source === 'exact' ? c : this._resolveCanonical(c)))
    );
    const byPath = new Map();
    for (const item of resolved) {
      if (item && !byPath.has(item.path)) byPath.set(item.path, item);
    }
    return Array.from(byPath.values());
  }

  // 标题检索（面板用）：A 精确探针 + B 标题联想 → 规范化去重后返回标题列表
  async search(rawTerm) {
    if (!rawTerm || !rawTerm.trim() || !this.isOnline) return [];
    const variants = getAllVariants(rawTerm.trim());
    if (variants.length === 0) return [];

    const [probe, suggest] = await Promise.all([
      this._probeExact(variants),
      this._suggestTitles(variants),
    ]);
    const merged = [...probe, ...suggest];
    if (merged.length === 0) return [];

    const resolved = await this._resolveCandidates(merged, variants);
    return resolved.map((c) => ({
      title: c.title,
      path: c.path,
      url: c.url,
      exact: c.source === 'exact' || variants.some((v) => v && c.title === v),
    }));
  }
  // 解析 Kiwix 条目的规范路径：HEAD /content/{title}，跟随 302 取得真实目标
  async _resolveCanonical(item) {
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const raw = item.path || item.title;
    const url = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(raw)}`;
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        return { ...item, path: raw, url };
      }
      if (res.status === 301 || res.status === 302) {
        const loc = res.headers.get('location') || '';
        const canonicalPath = decodeURIComponent(loc.split('/').pop() || '');
        if (canonicalPath) {
          return {
            ...item,
            title: canonicalPath,
            path: canonicalPath,
            url: `http://127.0.0.1:${KIWIX_PORT}${loc}`,
          };
        }
      }
    } catch (e) {
      // ignore
    }
    // 解析失败时保留原名，不丢候选
    return { ...item, path: raw, url };
  }

  /**
   * 完整条目文本：Infobox + 完整引言 + 全部小节（无视 3500 分支与路由），
   * 供面板原生渲染。与 RAG 注入文本相互独立。
   */
  async getFullArticleText(title) {
    if (!title || !this.isOnline) return null;
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const articleUrl = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(title)}`;
    try {
      const res = await fetch(articleUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const html = await res.text();
      const finalUrl = res.url || articleUrl;
      let canonicalTitle = title;
      try {
        const urlObj = new URL(finalUrl);
        const rawLast = urlObj.pathname.split('/').pop();
        if (rawLast) canonicalTitle = decodeURIComponent(rawLast);
      } catch (e) {
        // ignore
      }

      const dom = parseWikipediaDOM(html);
      const infobox = dom.infobox.map((i) => ({
        key: toSimplifiedChinese(i.key),
        value: toSimplifiedChinese(i.value),
      }));
      const lead = dom.section0.map((p) => toSimplifiedChinese(p));
      const sections = dom.sections.map((s) => ({
        title: toSimplifiedChinese(s.title),
        paragraphs: s.paragraphs.map((p) => toSimplifiedChinese(p)),
      }));

      const parts = [];
      if (infobox.length > 0) {
        parts.push(`[基本档案]\n${infobox.map((i) => `${i.key}: ${i.value}`).join(' | ')}`);
      }
      if (lead.length > 0) {
        parts.push(`[核心导言]\n${lead.join('\n\n')}`);
      }
      for (const s of sections) {
        parts.push(`[${s.title}]\n${s.paragraphs.join('\n\n')}`);
      }
      const context = parts.join('\n\n');
      if (!context) return null;

      return { title: toSimplifiedChinese(canonicalTitle), url: finalUrl, context };
    } catch (e) {
      return null;
    }
  }

  /** 按标题抓取条目（含字形变体尝试），返回 { title, url, context } */
  async getSummary(title, userQuery = '') {
    if (!title) return null;
    const variants = getAllVariants(title);
    for (const v of variants) {
      const summary = await this._fetchSummaryForTitle(v, userQuery);
      if (summary) return summary;
    }
    return null;
  }

  /** 抓取一个条目的 HTML 并解析出规范标题（供取正文与消歧义判定共用） */
  async _getPage(title) {
    if (!this.isOnline || !title) return null;
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const articleUrl = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(title)}`;
    try {
      const res = await fetch(articleUrl, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const html = await res.text();

      const finalUrl = res.url || articleUrl;
      let canonicalTitle = title;
      try {
        const rawLast = new URL(finalUrl).pathname.split('/').pop();
        if (rawLast) canonicalTitle = decodeURIComponent(rawLast);
      } catch (e) {
        // ignore
      }
      const titleTagMatch = html.match(/<title>([^<_\-]+?)(?:\s*[-–—|]\s*.*?)?<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) canonicalTitle = titleTagMatch[1].trim();

      return { html, finalUrl, canonicalTitle };
    } catch (e) {
      return null;
    }
  }

  /**
   * 抓取单个条目的归一原文。
   * rejectStrongDisambig：命中「强标记」的消歧义页直接判为不可用（包含命中/全文检索轨使用，
   * 避免把「XX可以指：…」的链接列表当正文注入）。
   */
  async _fetchSummaryForTitle(title, userQuery = '', rejectStrongDisambig = false) {
    const page = await this._getPage(title);
    if (!page) return null;

    if (rejectStrongDisambig && detectDisambiguation(page.html).strong) return null;

    const queryStr = Array.isArray(userQuery) ? userQuery.join(' ') : userQuery || title;
    const assembled = await assembleArticleContext(page.html, queryStr);
    if (!assembled || !assembled.context) return null;

    // 不再由小模型改写事实：直接返回归一后的原文，交给主力模型自行定位与综合
    return {
      title: toSimplifiedChinese(page.canonicalTitle),
      context: assembled.context,
      url: page.finalUrl,
    };
  }

  /**
   * 按关键字解析条目（每个关键字**独立、串行**）：
   *   ① 精确命中且非消歧义页 → 取该篇（1 篇，该关键字结束）
   *   ② 精确命中是消歧义页   → 主力模型读义项列表选 1 个；选中即视为「完全命中」（1 篇，结束）
   *   ③ 模型回答「都不匹配」 → 落到包含命中（按通用相关度取 ≤2 篇）
   *   ④ A/B/C 全无可用候选   → 才启用全文检索（按通用相关度取 ≤2 篇）
   */
  async _resolveForKeyword(keyword, question) {
    const variants = getAllVariants(keyword);
    if (variants.length === 0) return { articles: [], trace: 'no-variant' };

    // ---- ① / ② 精确命中 ----
    const exactCands = await this._resolveCandidates(await this._probeExact(variants), variants);
    for (const cand of exactCands) {
      const page = await this._getPage(cand.title);
      if (!page) continue;

      const dis = detectDisambiguation(page.html);
      if (dis.isDisambig) {
        const senses = extractSenses(page.html);
        const pick = await pickSenseWithMainModel(question, senses);
        if (pick) {
          const article = await this._fetchSummaryForTitle(pick, question);
          if (article) return { articles: [article], trace: 'disambig-picked' };
        }
        if (dis.strong) continue; // 强标记的消歧义页：不注入链接列表，继续看下一个候选
        // 弱判定且模型未选：按普通条目处理，避免误杀列表类条目
      }

      const article = await this._fetchSummaryForTitle(cand.title, question);
      if (article) {
        return { articles: [article], trace: dis.isDisambig ? 'disambig-none' : 'exact' };
      }
    }

    // ---- ③ 包含命中（标题包含关键字）----
    const containCands = await this._resolveCandidates(await this._suggestTitles(variants), variants);
    const picked = [];
    for (const cand of containCands) {
      if (picked.length >= 2) break;
      const article = await this._fetchSummaryForTitle(cand.title, question, true);
      if (article) picked.push(article);
    }
    if (picked.length > 0) return { articles: picked, trace: 'containment' };

    // ---- ④ 全文检索（末位手段）----
    const fullCands = await this._resolveCandidates(await this._fullTextSearch(keyword), variants);
    for (const cand of fullCands) {
      if (picked.length >= 2) break;
      const article = await this._fetchSummaryForTitle(cand.title, question, true);
      if (article) picked.push(article);
    }
    return { articles: picked, trace: picked.length ? 'fulltext' : 'none' };
  }
  // Atomic High-Performance RAG Pipeline
  async getRagContext(query) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { needsWiki: false, citations: [], promptContext: '', metadata: { latencyMs: 0 } };
    }

    // 快速熔断：若知识库离线或文件已拔出/移走，0ms 立即退出
    if (!this.isOnline || (this.currentZimPath && !fs.existsSync(this.currentZimPath))) {
      return {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: { latencyMs: 0, offline: true },
      };
    }

    const trimmed = query.trim();

    // 说明：内存 LRU 缓存已移除——同一提问重复率低，缓存收益有限，反而会掩盖调试期的问题。
    // 说明：打招呼正则旁路与 LAYA 意图门禁均已移除。
    // 实测 LAYA 门禁会把约 1/3 的知识类提问误判为闲聊而整条链路拦截（漏引代价 >> 闲聊多花的延迟）。
    // 现在所有提问都进入检索，闲聊类最终检索不到相关条目，自然不注入任何内容。

    const startTime = Date.now();

    // 0ms 归一化：将用户提问规范为大陆标准简体（自动将繁体字形与“记忆体/软体/滑鼠/晶片”等港台特有用法对齐为“内存/软件/鼠标/芯片”）
    const normalizedQuery = toSimplifiedChinese(trimmed);

    // 1. 实体规划（主力模型；不做任何小模型回退——规划失败时直接用归一后的原始提问检索）
    const plan = await planQuery(normalizedQuery);
    const plannerName = plan?.planner || 'raw-fallback';
    const targetArticles =
      plan && Array.isArray(plan.target_articles) && plan.target_articles.length > 0
        ? plan.target_articles.slice(0, 2)
        : [normalizedQuery];

    const validCitations = [];
    const seenTitles = new Set();
    const seenUrls = new Set();
    const traces = [];

    // 每个关键字**独立、串行**解析（本环节会调用主力模型做义项选择与长文目录路由；
    // 主力模型不支持多路并发，故严格串行）。具体规则见 _resolveForKeyword。
    for (const entity of targetArticles) {
      const { articles, trace } = await this._resolveForKeyword(entity, trimmed);
      traces.push(`${entity} → ${trace}`);
      if (!articles || articles.length === 0) continue;

      for (const article of articles) {
        const normTitle = article.title.trim().toLowerCase();
        const normUrl = article.url.trim().toLowerCase();
        if (seenTitles.has(normTitle) || seenUrls.has(normUrl)) continue;

        seenTitles.add(normTitle);
        seenUrls.add(normUrl);
        validCitations.push({
          title: article.title,
          url: article.url,
          context: article.context,
        });
      }
    }

    // 检索不到相关条目 → 静默回退，不注入任何噪音
    if (validCitations.length === 0) {
      return {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: {
          planner: plannerName,
          latencyMs: Date.now() - startTime,
          plan,
          retrieval: traces,
        },
      };
    }

    // 2. 组装注入内容：条目名 + 归一后原文（不改写、不截断，且**无预算约束**）
    //    说明：原「上下文预算装载 / contextOverflow」已整体移除。它仅作用于知识库注入，
    //    且预算值只由前端设置推导、不随对话增长收缩，实际上从不触发，属于虚假保护。
    //    现在检索到多少就整篇注入多少，由使用者把上下文窗口开到足够大来承载。
    const contextSections = validCitations.map((c) => `【${c.title}】\n${c.context}`);

    return {
      needsWiki: true,
      citations: validCitations.map((c) => ({
        title: c.title,
        url: c.url,
        context: c.context,
      })),
      promptContext: contextSections.join('\n\n'),
      metadata: {
        planner: plannerName,
        latencyMs: Date.now() - startTime,
        plan,
        articleCount: contextSections.length,
        retrieval: traces,
      },
    };
  }

  // Handle incoming HTTP requests on /api/wiki/*
  async handleApi(req, res) {
    try {
      const host = req.headers.host || '127.0.0.1:31235';
      const urlObj = new URL(req.url, `http://${host}`);
      const pathname = urlObj.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Check status
      if (pathname === '/api/wiki/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            enabled: this.enabled,
            connected: this.isOnline,
            port: KIWIX_PORT,
            zimPath: this.currentZimPath,
            contentId: this.contentId,
            bookTitle: this.bookTitle,
            articleCount: this.articleCount,
            mediaCount: this.mediaCount,
          })
        );
        return;
      }

      // Update / Save ZIM Path config
      if (pathname === '/api/wiki/config' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');

            // 仅切换服务总开关（不影响 ZIM 路径）
            if (data.enabled !== undefined && !(data.zimPath || '').trim()) {
              await this.setEnabled(data.enabled !== false);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  success: true,
                  enabled: this.enabled,
                  connected: this.isOnline,
                  zimPath: this.currentZimPath,
                  articleCount: this.articleCount,
                  contentId: this.contentId,
                  bookTitle: this.bookTitle,
                })
              );
              return;
            }

            const newPath = (data.zimPath || '').trim();

            if (!newPath) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Path cannot be empty' }));
              return;
            }

            const exists = fs.existsSync(newPath);
            if (!exists) {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  success: false,
                  error: 'FILE_NOT_FOUND',
                  message: '指定的 .zim 文件或目录不存在',
                  connected: false,
                  zimPath: newPath,
                })
              );
              return;
            }

            // Save to persistent config（保留当前启用状态）
            saveStoredConfig(newPath, this.enabled);

            // Restart service with new path
            await this.startService(newPath);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
                enabled: this.enabled,
                connected: this.isOnline,
                zimPath: this.currentZimPath,
                articleCount: this.articleCount,
                contentId: this.contentId,
                bookTitle: this.bookTitle,
              })
            );
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Search
      if (pathname === '/api/wiki/search') {
        const q = urlObj.searchParams.get('q') || '';
        const results = await this.search(q);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ query: q, results }));
        return;
      }

      // Summary（供搜索导航：按标题抓取条目并返回归一原文）
      if (pathname === '/api/wiki/summary') {
        const title = urlObj.searchParams.get('title') || '';
        const query = urlObj.searchParams.get('query') || '';
        const data = await this.getSummary(title, query);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
        return;
      }

      // Full Article（完整条目文本：Infobox + 完整引言 + 全部小节，供面板原生渲染）
      if (pathname === '/api/wiki/article') {
        const title = urlObj.searchParams.get('title') || '';
        const data = await this.getFullArticleText(title);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
        return;
      }

      // Atomic High-Performance RAG Context Endpoint
      if (pathname === '/api/wiki/rag-context' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const result = await this.getRagContext(data.query || '');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
          } catch (e) {
            console.error('[WikiService] rag-context error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                needsWiki: false,
                citations: [],
                promptContext: '',
                error: e.message,
              })
            );
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unknown wiki endpoint' }));
    } catch (err) {
      console.error('[WikiService] handleApi error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
}

// 供测试/自查脚本使用（与 getAllVariants / parseWikipediaDOM 等既有导出保持一致）
export { isNonArticleTitle, relevanceScore, detectDisambiguation, extractSenses };

export const wikiService = new WikiService();
