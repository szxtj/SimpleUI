import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
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

// 维基命名空间前缀：分类/模板/帮助/文件/门户等"非文章页"。
// 这些页面会命中关键字但不是条目，检索时一律丢弃，只保留文章页。
const NON_ARTICLE_NAMESPACE_RE =
  /^(?:Special|特殊|Talk|討論|讨论|User|用戶|用户|Wikipedia|維基百科|维基百科|Project|File|Image|檔案|文件|档案|MediaWiki|Template|模板|Help|幫助|帮助|Category|分類|分类|Portal|主題|主题|Draft|草稿|Module|模組|模块|Book|Course|Thread|Summary|Page|Index|Topic|TimedText|朗讀|朗读)\s*[:：]/i;

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
// Phase 1: Structured Wikipedia DOM Decomposition
// ==========================================

function stripHtmlAndUnescape(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// 按 class 配对删除整个元素块（处理嵌套）。
// 维基的导航框/维护横幅是「div.navbox > table.navbox-inner > 嵌套表格」的多层结构，
// 非贪婪正则会停在第一个闭合标签处提前断开，把内部的 <li>/<td> 漏进正文，必须配对扫描。
function removeElementsByClass(html, tag, classRe) {
  const openRe = new RegExp(`<${tag}\\b[^>]*\\bclass="[^"]*"[^>]*>`, 'gi');
  const closeRe = new RegExp(`</?${tag}\\b[^>]*>`, 'gi');
  let result = html;
  let from = 0;
  for (let guard = 0; guard < 3000; guard++) {
    openRe.lastIndex = from;
    const m = openRe.exec(result);
    if (!m) break;
    const classAttr = /class="([^"]*)"/i.exec(m[0]);
    if (!classAttr || !classRe.test(classAttr[1])) {
      from = m.index + m[0].length;
      continue;
    }
    closeRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = -1;
    let t;
    while ((t = closeRe.exec(result)) !== null) {
      if (t[0].slice(0, 2) === '</') depth--;
      else depth++;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    if (end === -1) break;
    result = result.slice(0, m.index) + result.slice(end);
    from = m.index;
  }
  return result;
}

export function parseWikipediaDOM(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return { infobox: [], section0: [], sections: [] };
  }

  // 1. Smart tail cutoff at notes / references / external links / see also
  //    兼容 h2 与 h3 两级标题（部分条目的「外部链接」「参考文献」是 h3 级）
  const headingRe = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let cutIndex = -1;
  let hm;
  while ((hm = headingRe.exec(rawHtml)) !== null) {
    const headingText = stripHtmlAndUnescape(hm[2]);
    if (
      /註釋|注释|參考[資资]料|参考[資资]料|參考[文獻献]|参考[文獻献]|腳註|脚注|出處|出处|文獻|文献|外部[連結链接]|參見|参见|延伸[閱讀阅读]|注[釋释]/.test(
        headingText
      )
    ) {
      cutIndex = hm.index;
      break;
    }
  }
  let html = cutIndex > 0 ? rawHtml.slice(0, cutIndex) : rawHtml;

  // 2. Strip scripts, styles, references, edit links, navboxes, thumbnails
  //    以及一切"页面上看不见"的内容：MediaWiki 排序键(sortkey) 与 display:none 元素。
  //    这些内容浏览器不渲染，但纯文本抽取会把诸如 "7008299792458000000♠" 的排序键带进事实里。
  //    再加：维基维护横幅(ambox/metadata/mbox-small)、参考资料包裹层(reflist)、
  //    「[来源请求]」类标记(noprint/Template-Fact/Unreferenced)。
  html = html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, '')
    .replace(/<span[^>]*class="[^"]*sortkey[^"]*"[^>]*>.*?<\/span>/gis, '')
    .replace(/<span[^>]*style="[^"]*display\s*:\s*none[^"]*"[^>]*>.*?<\/span>/gis, '')
    .replace(/<div[^>]*style="[^"]*display\s*:\s*none[^"]*"[^>]*>.*?<\/div>/gis, '')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gis, '')
    .replace(
      /<sup[^>]*class="[^"]*(?:noprint|Template-Fact|Unreferenced)[^"]*"[^>]*>.*?<\/sup>/gis,
      ''
    )
    .replace(/<ol[^>]*class="[^"]*references[^"]*"[^>]*>.*?<\/ol>/gis, '')
    .replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>.*?<\/span>/gis, '')
    .replace(/<figure\b[^<]*(?:(?!<\/figure>)<[^<]*)*<\/figure>/gis, '')
    .replace(/<div[^>]*class="[^"]*thumb[^"]*"[^>]*>.*?<\/div>/gis, '');

  // 配对删除多层嵌套的非内容块：导航框/侧边栏/维护横幅/参考资料包裹层/页面指示器
  html = removeElementsByClass(
    html,
    'table',
    /navbox|vertical-navbox|sidebar|ambox|metadata|mbox-small/i
  );
  html = removeElementsByClass(
    html,
    'div',
    /navbox|vertical-navbox|sidebar|hatnote|mw-indicator|reflist|references|mw-references-wrap/i
  );

  // 3. Extract full Infobox key-values (无长度上限：抓到即留)
  //    Infobox 常嵌套子表格，必须用 <table>/</table> 配对扫描整体截出，
  //    否则非贪婪匹配会在第一个 </table> 处提前断开，把奖项表/参战方表错位漏进正文。
  const infobox = [];
  const infoboxStartMatch = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>/i);
  if (infoboxStartMatch) {
    const start = infoboxStartMatch.index;
    const tagRe = /<\/?table\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let tm;
    while ((tm = tagRe.exec(html)) !== null) {
      if (tm[0].slice(0, 2) === '</') depth--;
      else depth++;
      if (depth === 0) {
        end = tm.index + tm[0].length;
        break;
      }
    }
    if (end !== -1) {
      const infoboxHtml = html.slice(start, end);
      const rows = [
        ...infoboxHtml.matchAll(
          /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gis
        ),
      ];
      for (const row of rows) {
        const k = stripHtmlAndUnescape(row[1]);
        const v = stripHtmlAndUnescape(row[2]);
        if (k && v) {
          infobox.push({ key: k, value: v });
        }
      }
      html = html.slice(0, start) + html.slice(end);
    }
  }

  // 4. Split Section 0 (Lead) and Section Tree
  let section0Html = '';
  let bodyHtml = '';

  const firstHeadingMatch = html.match(/<(?:h2|div\s+id="toc"|table\s+id="toc")[^>]*>/i);
  if (firstHeadingMatch && firstHeadingMatch.index > 0) {
    section0Html = html.slice(0, firstHeadingMatch.index);
    bodyHtml = html.slice(firstHeadingMatch.index);
  } else {
    section0Html = html;
  }

  // ---- 正文块抽取：按出现顺序抓 <p> / <ul>/<ol> 列表 / <table> 表格 ----
  // 列表转成「· 条目」行；表格转成「| 单元格 | 单元格 |」的管道表，对大模型友好。
  const BLOCK_RE =
    /(<p\b[^>]*>[\s\S]*?<\/p>)|(<ul\b[^>]*>[\s\S]*?<\/ul>)|(<ol\b[^>]*>[\s\S]*?<\/ol>)|(<table\b[^>]*>[\s\S]*?<\/table>)/gi;

  const cleanInline = (s) =>
    stripHtmlAndUnescape(String(s).replace(/<br\s*\/?>/gi, '；'))
      .replace(/\s+/g, ' ')
      .trim();

  const listToText = (listHtml) => {
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    const items = [];
    let lm;
    while ((lm = liRe.exec(listHtml)) !== null) {
      const t = cleanInline(lm[1]);
      if (t) items.push('· ' + t);
    }
    return items.join('\n');
  };

  const tableToText = (tableHtml) => {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tm;
    while ((tm = trRe.exec(tableHtml)) !== null) {
      const cellRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi;
      const cells = [];
      let cm;
      while ((cm = cellRe.exec(tm[1])) !== null) {
        cells.push(cleanInline(cm[2]));
      }
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    }
    if (rows.length === 0) return '';
    return rows.map((cells) => '| ' + cells.join(' | ') + ' |').join('\n');
  };

  const extractBlocks = (snippet) => {
    const out = [];
    let bm;
    BLOCK_RE.lastIndex = 0;
    while ((bm = BLOCK_RE.exec(snippet)) !== null) {
      const block = bm[0];
      let text = '';
      if (bm[1]) {
        text = stripHtmlAndUnescape(block.replace(/<br\s*\/?>/gi, '；'));
      } else if (bm[2] || bm[3]) {
        text = listToText(block);
      } else if (bm[4]) {
        text = tableToText(block);
      }
      text = (text || '').trim();
      if (text) out.push(text);
    }
    return out;
  };

  const section0 = extractBlocks(section0Html);

  // Extract sections
  const sections = [];
  if (bodyHtml) {
    const h2Parts = bodyHtml.split(/<h2[^>]*>/i);
    for (let i = 1; i < h2Parts.length; i++) {
      const part = h2Parts[i];
      const endHeading = part.indexOf('</h2>');
      if (endHeading !== -1) {
        const title = stripHtmlAndUnescape(part.slice(0, endHeading));
        const content = part.slice(endHeading + 5);
        const paras = extractBlocks(content);
        if (title && paras.length > 0) {
          sections.push({ title, paragraphs: paras });
        }
      }
    }
  }

  return { infobox, section0, sections };
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

  // Step 2: Global 2-stage normalization to Mainland Simplified Chinese
  const normInfobox = dom.infobox.map((item) => ({
    key: toSimplifiedChinese(item.key),
    value: toSimplifiedChinese(item.value),
  }));

  const normSection0 = dom.section0.map((p) => toSimplifiedChinese(p));
  const normSections = dom.sections.map((s) => ({
    title: toSimplifiedChinese(s.title),
    paragraphs: s.paragraphs.map((p) => toSimplifiedChinese(p)),
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

  // 标题检索：全部字形变体 → Kiwix 精确探针 + 标题联想
  // 只保留「完全命中」或「完全包含关键字」的条目名，再经深度重定向解析后按规范路径去重
  async search(rawTerm) {
    if (!rawTerm || !rawTerm.trim() || !this.isOnline) return [];
    const term = rawTerm.trim();
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const variants = getAllVariants(term);
    if (variants.length === 0) return [];

    // 0. Direct Canonical Probe: Check if exact variants exist directly or are 302 redirects (1ms HEAD request)
    const probePromises = variants.map(async (v) => {
      try {
        const probeUrl = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(v)}`;
        const res = await fetch(probeUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(1200) });
        if (res.status === 200) {
          return {
            title: v,
            path: v,
            url: probeUrl,
            source: 'exact_probe',
            rank: 0,
          };
        }
        if (res.status === 302 || res.status === 301) {
          const loc = res.headers.get('location') || '';
          const targetTitle = decodeURIComponent(loc.split('/').pop() || '');
          if (targetTitle) {
            return {
              title: targetTitle,
              path: targetTitle,
              url: `http://127.0.0.1:${KIWIX_PORT}${loc}`,
              source: 'exact_probe',
              rank: 0,
            };
          }
        }
      } catch (e) {
        // ignore
      }
      return null;
    });

    // 1. Kiwix suggest endpoint (captures exact and prefix titles, count=30 to bypass ascii sort bias)
    const suggestPromises = variants.map(async (v) => {
      try {
        const suggestUrl = `http://127.0.0.1:${KIWIX_PORT}/suggest?content=${encodeURIComponent(content)}&term=${encodeURIComponent(v)}&count=30`;
        const res = await fetch(suggestUrl, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json)) {
            return json
              .filter((item) => item.kind === 'path' && item.value)
              .map((item, idx) => {
                const title = item.value.trim();
                const p = item.path || title;
                return {
                  title,
                  path: p,
                  url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(p)}`,
                  source: 'suggest',
                  rank: idx,
                };
              });
          }
        }
      } catch (e) {
        // ignore
      }
      return [];
    });

    const [probeResults, suggestResultLists] = await Promise.all([
      Promise.all(probePromises),
      Promise.all(suggestPromises),
    ]);

    const kept = [];

    // 精确探针命中（200 存在 / 302 重定向）本身就是「完全命中关键字」，无条件保留
    // （但仍排除命名空间前缀的非文章页）
    for (const item of probeResults) {
      if (item && !NON_ARTICLE_NAMESPACE_RE.test(item.title.trim())) kept.push({ ...item, exact: true });
    }

    // 标题联想结果：只保留条目名「完全等于」或「完全包含」任一关键字变体的文章页，其余丢弃
    // 标题与变体逐字相等者同样视为「完全命中」
    for (const list of suggestResultLists) {
      for (const item of list) {
        const t = item.title.trim();
        if (NON_ARTICLE_NAMESPACE_RE.test(t)) continue;
        const exact = variants.some((v) => v && t === v);
        if (exact || variants.some((v) => v && t.includes(v))) {
          kept.push({ ...item, exact });
        }
      }
    }

    if (kept.length === 0) return [];

    // 深度重定向解析：别名 → 规范条目，再按规范路径去重（同一文章的多个别名只留一篇）
    const resolved = await Promise.all(kept.map((item) => this._resolveCanonical(item)));

    const byCanonical = new Map();
    for (const item of resolved) {
      if (item && !byCanonical.has(item.path)) byCanonical.set(item.path, item);
    }
    // 全量返回（不再截断 6 条）：完全命中在前、包含命中在后，供面板列表完整展示
    return Array.from(byCanonical.values());
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

  async _fetchSummaryForTitle(title, userQuery = '') {
    if (!this.isOnline) return null;
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const articleUrl = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(title)}`;

    try {
      const res = await fetch(articleUrl, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const html = await res.text();

      // Resolve true canonical URL and canonical title (following Kiwix HTTP 302 redirects)
      const finalUrl = res.url || articleUrl;
      let canonicalTitle = title;
      try {
        const urlObj = new URL(finalUrl);
        const rawLast = urlObj.pathname.split('/').pop();
        if (rawLast) canonicalTitle = decodeURIComponent(rawLast);
      } catch (e) {
        // ignore
      }

      const titleTagMatch = html.match(/<title>([^<_\-]+?)(?:\s*[-–—|]\s*.*?)?<\/title>/i);
      if (titleTagMatch && titleTagMatch[1]) {
        canonicalTitle = titleTagMatch[1].trim();
      }

      // Disambiguation page handler (strict Wikipedia category check, e.g. 特斯拉 -> 特斯拉公司)
      const isDisambig =
        /"全部(?:主條目|主条目)?消歧[义義]頁?面"/.test(html) ||
        html.includes('id="disambigbox"') ||
        html.includes('class="disambig');

      if (isDisambig) {
        const queryStr = Array.isArray(userQuery) ? userQuery.join(' ') : (userQuery || '');
        const activeTokens = getAllVariants(queryStr);

        const linkMatches = [...html.matchAll(/<li>\s*<a[^>]*href="([^"#]+)"[^>]*title="([^"]+)"[^>]*>(.*?)<\/li>/gis)];
        let bestTarget = null;
        let bestScore = -1;

        for (const lm of linkMatches) {
          const candTitle = decodeURIComponent(lm[2]);
          const lineText = lm[0].replace(/<[^>]+>/g, '');
          const combined = (candTitle + ' ' + lineText).toLowerCase();
          let score = 0;

          // Score by active intent tokens with variant matching
          for (const tk of activeTokens) {
            for (const v of getAllVariants(tk)) {
              if (combined.includes(v.toLowerCase())) score += 5;
            }
          }

          // Entity type relevance heuristics
          if (/(?:公司|企业|企業|汽车|汽車|车|車|产品|產品|智能|科技|软件|硬件)/i.test(lineText)) {
            score += 3;
          }

          if (score > bestScore && score > 0) {
            bestScore = score;
            bestTarget = candTitle;
          }
        }

        if (bestTarget && bestTarget !== title) {
          const resolved = await this._fetchSummaryForTitle(bestTarget, userQuery);
          if (resolved) return resolved;
        }
      }

      const queryStr = Array.isArray(userQuery) ? userQuery.join(' ') : (userQuery || title);
      const simplifiedTitle = toSimplifiedChinese(canonicalTitle);

      // Assemble structured, zero-truncation context (panoramic or routed)
      const assembled = await assembleArticleContext(html, queryStr);
      if (!assembled || !assembled.context) {
        return null;
      }

      // 不再由小模型改写事实：直接返回归一后的原文，交给主力模型自行定位与综合
      return {
        title: simplifiedTitle,
        context: assembled.context,
        url: finalUrl,
      };
    } catch (e) {
      console.error('[WikiService] _fetchSummaryForTitle error:', e);
      return null;
    }
  }

  // Atomic High-Performance RAG Pipeline
  async getRagContext(query, budgetChars = 0) {
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

    // 严格串行：本环节内会调用主力模型做长文目录路由，而主力模型不支持多路并发
    for (const entity of targetArticles) {
      const matches = await this.search(entity);
      if (!matches || matches.length === 0) continue;

      // 候选已在 search() 内按规范路径去重；这里做跨关键字去重
      const exactHits = matches.filter((m) => m.exact);
      const containmentHits = matches
        .filter((m) => !m.exact)
        // 「包含关键字」时，标题里多出来的字/符号越少越靠前（标题长度升序）
        .sort((a, b) => a.title.length - b.title.length);

      // 完全命中：只取一篇（按顺序尝试，取第一篇成功抓到正文的）
      let loadedForEntity = 0;
      for (const m of exactHits) {
        const articleData = await this._fetchSummaryForTitle(m.title, trimmed);
        if (!articleData || !articleData.context) continue;

        const normTitle = articleData.title.trim().toLowerCase();
        const normUrl = articleData.url.trim().toLowerCase();
        if (seenTitles.has(normTitle) || seenUrls.has(normUrl)) break;

        seenTitles.add(normTitle);
        seenUrls.add(normUrl);
        validCitations.push({
          title: articleData.title,
          url: articleData.url,
          context: articleData.context,
        });
        loadedForEntity++;
        break;
      }

      // 该关键字没有任何「完全命中」（或完全命中全部抓取失败）时，
      // 才使用「包含关键字」的条目：按标题长度升序最多取两篇
      if (loadedForEntity === 0) {
        for (const m of containmentHits.slice(0, 2)) {
          const articleData = await this._fetchSummaryForTitle(m.title, trimmed);
          if (!articleData || !articleData.context) continue;

          const normTitle = articleData.title.trim().toLowerCase();
          const normUrl = articleData.url.trim().toLowerCase();
          if (seenTitles.has(normTitle) || seenUrls.has(normUrl)) continue;

          seenTitles.add(normTitle);
          seenUrls.add(normUrl);
          validCitations.push({
            title: articleData.title,
            url: articleData.url,
            context: articleData.context,
          });
          loadedForEntity++;
          if (loadedForEntity >= 2) break;
        }
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
        },
      };
    }

    // 2. 组装注入内容：条目名 + 归一后原文（不改写、不截断）
    //    budgetChars 为可选的装载预算（由前端按剩余上下文计算）：
    //    超出时按检索优先级整篇丢弃，绝不从中间截断。
    //    若一篇都装不下（上下文已满），向前端返回 contextOverflow 信号，提示用户新开对话。
    const contextSections = [];
    let used = 0;
    let loadedCount = 0;
    let contextOverflow = false;

    if (budgetChars > 0) {
      for (const c of validCitations) {
        const block = `【${c.title}】\n${c.context}`;
        if (used + block.length > budgetChars) {
          if (loadedCount === 0) contextOverflow = true;
          continue;
        }
        used += block.length;
        loadedCount++;
        contextSections.push(block);
      }
    } else {
      for (const c of validCitations) {
        contextSections.push(`【${c.title}】\n${c.context}`);
        loadedCount++;
      }
    }

    // 上下文已满：一篇都装不下，交由前端提示用户新开对话
    if (contextOverflow) {
      return {
        needsWiki: false,
        citations: [],
        promptContext: '',
        contextOverflow: true,
        metadata: {
          planner: plannerName,
          latencyMs: Date.now() - startTime,
          plan,
          articleCount: 0,
        },
      };
    }

    const fullPromptContext = contextSections.join('\n\n');

    return {
      needsWiki: true,
      citations: validCitations.map((c) => ({
        title: c.title,
        url: c.url,
        context: c.context,
      })),
      promptContext: fullPromptContext,
      metadata: {
        planner: plannerName,
        latencyMs: Date.now() - startTime,
        plan,
        articleCount: loadedCount,
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
            const budget = Number(data.budgetChars) > 0 ? Number(data.budgetChars) : 0;
            const result = await this.getRagContext(data.query || '', budget);
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

export const wikiService = new WikiService();
