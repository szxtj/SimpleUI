import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import * as OpenCC from 'opencc-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const KIWIX_PORT = 31236;

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

const ccConverters = [
  OpenCC.Converter({ from: 'cn', to: 't' }),
  OpenCC.Converter({ from: 'cn', to: 'tw' }),
  OpenCC.Converter({ from: 'cn', to: 'twp' }),
  OpenCC.Converter({ from: 'cn', to: 'hk' }),
  OpenCC.Converter({ from: 't', to: 'cn' }),
  OpenCC.Converter({ from: 'tw', to: 'cn' }),
  OpenCC.Converter({ from: 'twp', to: 'cn' }),
  OpenCC.Converter({ from: 'hk', to: 'cn' }),
];

export function getAllVariants(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  const set = new Set([trimmed]);
  for (const cvt of ccConverters) {
    try {
      const res = cvt(trimmed);
      if (res && res.trim()) {
        set.add(res.trim());
      }
    } catch (e) {
      // ignore
    }
  }
  return Array.from(set);
}

// Multi-tier question intent & property stripper
export function cleanQueryToEntityCandidates(query) {
  if (!query || typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (!trimmed) return [];

  let q = trimmed
    .replace(/^[？?！!。，,、：“”"''（）()\s]+/, '')
    .replace(
      /^(?:请问|請問|什么是|什麼是|请简要|請簡要|帮我|幫我|介绍一下|介紹一下|总结一下|總結一下|关于|關於|谈谈|談談|讲讲|講講|你知道|告诉我|告訴我|查一下|搜索|查询|查詢|了解一下|谁是|誰是|到底什么是|简述|我想知道)\s*/gi,
      ''
    )
    .replace(/[？?！!。，,、：“”"''（）()\s]+$/, '');

  const candidates = new Set();
  candidates.add(q);

  // Progressive pattern stripping for natural language question suffixes
  const patterns = [
    // 1. Specific questions on property / person / metrics
    /(?:现在|目前|如今|今年|历史上的|当今)?(?:的)?(?:创始人|創始人|创办人|老总|老板|老闆|董事长|董事長|CEO|高管|员工|員工|人员|人員|人数|人數|规模|規模|市值|营收|營收|利润|利潤|总部|總部|地址|位置|成立时间|成立時間|代表作|作品|专辑|專輯|歌曲|奖项|獎項|金曲奖|金曲獎|荣誉|榮譽|主要产品|主要產品|产品|產品|业务|業務|原理|概念|优缺点|優缺點|评价|評價|历史|歷史|背景|介绍|介紹|资料|資料)?(?:是多少|有多少人|有多少员工|有多少|有几个人|是哪一年|什么时候|哪一年|在什么地方|在哪个国家|在哪个城市|在哪里|何处|是谁|有哪些|是什么|怎么样|怎么回事|如何|为什么|好不好|多大年纪|多大)[？?！!。，, ]*$/i,
    // 2. Timeline / historical facts
    /(?:是)?(?:哪一年|什么时候|何时|何处|在哪里)?(?:出生|成立|创立|诞生|去世|逝世|上市|创立的|成立的|出生的|去世的|上市的)[？?！!。，, ]*$/i,
    // 3. Actions / achievements
    /(?:获得过|獲得過|拿过|拿過|得过|得過|出过|唱过|演过|拥有|包含|包括).*$/i,
    // 4. Quantities
    /(?:共有|总共有|有)?(?:多少人|多少员工|几个人|多大规模)[？?！!。，, ]*$/i,
    // 5. Ending modal particles
    /(?:吗|嘛|呢|呀|吧|啊|一下|详细点|具体点|简要)$/i,
  ];

  let current = q;
  for (const p of patterns) {
    current = current.replace(p, '').trim();
  }
  current = current.replace(/的+$/, '').trim();

  if (current && current.length >= 2) {
    candidates.add(current);
  }

  // Also include 2-6 char prefix candidate if it looks like an entity
  if (current.length > 4) {
    const sub = current.slice(0, 4);
    if (sub.length >= 2) candidates.add(sub);
  }

  return Array.from(candidates).reverse();
}

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

function saveStoredZimPath(zimPath) {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ zimPath: zimPath.trim() }, null, 2),
      'utf-8'
    );
  } catch (e) {
    console.error('[WikiService] Failed to save wiki_config.json:', e);
  }
  try {
    if (DEV_CONFIG_FILE !== CONFIG_FILE && fs.existsSync(DEV_CONFIG_FILE)) {
      fs.writeFileSync(
        DEV_CONFIG_FILE,
        JSON.stringify({ zimPath: zimPath.trim() }, null, 2),
        'utf-8'
      );
    }
  } catch (e) {
    // ignore
  }
}

// Expand query or tokens to all Simplified and Traditional Chinese variants
export function getExpandedTokens(queryOrTokens) {
  if (!queryOrTokens) return [];
  const activeTokensSet = new Set();
  const baseTokens = Array.isArray(queryOrTokens) ? queryOrTokens : [queryOrTokens];
  for (const bt of baseTokens) {
    if (!bt || typeof bt !== 'string') continue;
    const trimmed = bt.trim();
    if (!trimmed) continue;
    for (const v of getAllVariants(trimmed)) {
      activeTokensSet.add(v);
    }
  }
  return Array.from(activeTokensSet);
}

// In-Memory Query & Context Cache (LRU style, max 200 items, TTL 10 mins)
const queryPlanCache = new Map();
const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function getCachedContext(query) {
  if (!query || typeof query !== 'string') return null;
  const key = query.trim().toLowerCase();
  const entry = queryPlanCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    queryPlanCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedContext(query, data) {
  if (!query || typeof query !== 'string') return;
  const key = query.trim().toLowerCase();
  if (queryPlanCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = queryPlanCache.keys().next().value;
    queryPlanCache.delete(oldestKey);
  }
  queryPlanCache.set(key, { data, timestamp: Date.now() });
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

export const PLANNER_SYSTEM_PROMPT = `你是一个知识库检索规划助手。分析用户的提问，判断是否需要检索百科知识库。

输出规范：
1. needs_wiki: 若为打招呼、日常闲聊、写代码、数学运算、语言翻译等无需查百科事实的问题，为 false；若为询问客观事实、人物、公司、历史、地理、科学概念、作品、定义等，为 true。
2. target_articles: 推断最可能包含答案的核心中文百科条目名（1-3个中文规范名称，例如写"苹果公司"而非"Apple"，写"特斯拉"或"特斯拉公司"而非"Tesla"，写"微软"而非"Microsoft"）。
3. intent_tokens: 预测在百科词条（Infobox属性表或正文）中最可能出现的4-8个属性关键词、同义词或细节词。例如：
   - 问高度/长度：["海拔", "高度", "长", "千米", "米"]
   - 问人数/规模：["员工", "人数", "人员", "规模", "总数"]
   - 问出生/籍贯：["出生", "籍贯", "出生地", "早年", "生于"]
   - 问创始人/领导：["创办人", "创始人", "董事长", "总裁", "CEO", "代表人物"]
   - 问时间/年份：["时间", "年份", "成立", "逝世", "结束", "建立"]
   - 问产品/业务：["产品", "车型", "业务", "型号", "服务"]

只输出纯JSON：{"needs_wiki": true/false, "target_articles": [...], "intent_tokens": [...]}，严禁输出任何多余解释。`;

export async function planQueryWithSLM(query) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n现在处理：\n输入：${trimmed}\n输出：`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4.0s timeout

  try {
    const res = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'qwen3.5-2b-optiq',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 180,
      }),
    });

    clearTimeout(timeoutId);
    if (!res.ok) {
      console.warn('[WikiService SLM] 2B server HTTP', res.status);
      return null;
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(text);

    if (parsed && typeof parsed.needs_wiki === 'boolean') {
      return {
        needs_wiki: parsed.needs_wiki,
        target_articles: Array.isArray(parsed.target_articles)
          ? parsed.target_articles.map((a) => String(a).trim()).filter(Boolean).slice(0, 3)
          : [],
        intent_tokens: Array.isArray(parsed.intent_tokens)
          ? parsed.intent_tokens.map((t) => String(t).trim()).filter(Boolean)
          : [],
        planner: 'slm-2b',
      };
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn('[WikiService SLM] 2B planning timed out (>4000ms), falling back');
    } else {
      console.warn('[WikiService SLM] 2B planning error:', err.message);
    }
  }

  return null;
}

// 80% Core Regex & Segmenter Fallback Pipeline
export function fallbackRegexPlan(query) {
  if (!query || typeof query !== 'string') {
    return { needs_wiki: false, target_articles: [], intent_tokens: [], planner: 'regex-fallback' };
  }
  const q = query.trim().toLowerCase();

  // Negative patterns: casual chat, greetings, code instructions, math
  const nonWikiRegex = /^(?:你好|您好|早安|早上好|晚上好|嗨|hello|hi|hey|在吗|在嗎|哈哈|谢谢|謝謝|多谢|多謝|再见|再見|拜拜|bye)[！!。，,\s]*$|^(?:写个|写一个|编写|实现|优化|请用|用python|用c\+\+|用java|用js|用ts|用swift|用rust|写段代码|写一段|写个函数|解释一下这段代码)|^(?:帮我翻译|翻译成|翻译为|英译中|中译英)|^(?:讲个笑话|讲个故事|讲个段子)|^(?:计算|算一下|\d+\s*[\+\-\*\/×÷]\s*\d+)|^(?:你是谁|你叫什么|你能做什么)/i;

  if (nonWikiRegex.test(q)) {
    return { needs_wiki: false, target_articles: [], intent_tokens: [], planner: 'regex-fallback' };
  }

  const candidates = cleanQueryToEntityCandidates(query);

  if (!candidates || candidates.length === 0) {
    return { needs_wiki: false, target_articles: [], intent_tokens: [], planner: 'regex-fallback' };
  }

  return {
    needs_wiki: true,
    target_articles: candidates.slice(0, 3),
    intent_tokens: candidates.slice(0, 2),
    planner: 'regex-fallback',
  };
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
    if (this.isStarting) return false;
    this.isStarting = true;

    try {
      const zimPath = this.findZimFile(customPath);
      if (!zimPath) {
        this.isOnline = false;
        this.currentZimPath = customPath || loadStoredZimPath() || null;
        this.isStarting = false;
        return false;
      }

      this.currentZimPath = zimPath;

      // If running and path matches, verify health
      if (this.kiwixProcess && this.isOnline) {
        const healthy = await this.checkHealth();
        if (healthy) {
          this.isStarting = false;
          return true;
        }
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

  // Periodic health check & external disk disconnect/reconnect watcher
  initWatcher() {
    this.startService();
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = setInterval(async () => {
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

  // Search articles with robust entity extraction & bidirectional matching
  async search(rawQuery) {
    if (!rawQuery || !rawQuery.trim() || !this.isOnline) return [];
    const entityCandidates = cleanQueryToEntityCandidates(rawQuery);
    const content = this.contentId || 'wikipedia_zh_all_maxi';

    // Collect all variants of all entity candidates
    const allSearchTerms = new Set();
    for (const cand of entityCandidates) {
      for (const v of getAllVariants(cand)) {
        allSearchTerms.add(v);
      }
    }

    const candidateMap = new Map();

    // 1. Query Kiwix suggest endpoint for all candidate terms in parallel
    const suggestPromises = Array.from(allSearchTerms).map(async (v) => {
      try {
        const suggestUrl = `http://127.0.0.1:${KIWIX_PORT}/suggest?content=${encodeURIComponent(content)}&term=${encodeURIComponent(v)}`;
        const res = await fetch(suggestUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json)) {
            return json
              .filter((item) => item.kind === 'path' && item.value)
              .map((item) => ({
                title: item.value,
                path: item.path || item.value,
                url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${item.path || encodeURIComponent(item.value)}`,
              }));
          }
        }
      } catch (e) {
        // ignore
      }
      return [];
    });

    const suggestResultLists = await Promise.all(suggestPromises);
    for (const list of suggestResultLists) {
      for (const item of list) {
        if (!candidateMap.has(item.title) && !candidateMap.has(item.path)) {
          candidateMap.set(item.title, item);
        }
      }
    }

    // 2. If suggest yielded few results, fallback to pattern search for top candidate terms
    if (candidateMap.size < 3) {
      const searchPromises = Array.from(allSearchTerms).slice(0, 3).map(async (v) => {
        try {
          const searchUrl = `http://127.0.0.1:${KIWIX_PORT}/search?content=${encodeURIComponent(content)}&pattern=${encodeURIComponent(v)}`;
          const res = await fetch(searchUrl, { signal: AbortSignal.timeout(2500) });
          if (res.ok) {
            const html = await res.text();
            const matches = [...html.matchAll(/<a href="\/content\/[^/]+\/([^"]+)">\s*([^<]+)\s*<\/a>/g)];
            return matches.map((m) => {
              const rawPath = m[1];
              const title = decodeURIComponent(m[2].trim());
              return {
                title,
                path: rawPath,
                url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${rawPath}`,
              };
            });
          }
        } catch (e) {
          // ignore
        }
        return [];
      });

      const searchResultLists = await Promise.all(searchPromises);
      for (const list of searchResultLists) {
        for (const item of list) {
          if (!candidateMap.has(item.title) && !candidateMap.has(item.path)) {
            candidateMap.set(item.title, item);
          }
        }
      }
    }

    const allResults = Array.from(candidateMap.values());
    if (allResults.length === 0) return [];

    // 3. Relevance ranking with bidirectional matching:
    // exact matches across candidates come first, then prefix/suffix, then bidirectional substring
    const scoreItem = (item) => {
      let score = 0;
      const title = item.title;
      if (title.startsWith('Category:') || title.startsWith('分类:') || title.startsWith('分類:')) {
        score -= 50;
      }
      for (const v of allSearchTerms) {
        if (title === v) {
          score = Math.max(score, 100);
        } else if (title.startsWith(v) || v.startsWith(title)) {
          score = Math.max(score, 85);
        } else if (title.endsWith(v) || v.endsWith(title)) {
          score = Math.max(score, 75);
        } else if (title.includes(v) || v.includes(title)) {
          score = Math.max(score, 60);
        }
      }
      return score;
    };

    allResults.sort((a, b) => scoreItem(b) - scoreItem(a));
    return allResults.slice(0, 8);
  }

  // Extract structured infobox facts + lead paragraphs + query-relevant sections
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

      // Disambiguation page handler (strict Wikipedia category check, e.g. 特斯拉 -> 特斯拉公司)
      const isDisambig =
        /"全部(?:主條目|主条目)?消歧[义義]頁?面"/.test(html) ||
        html.includes('id="disambigbox"') ||
        html.includes('class="disambig');

      if (isDisambig) {
        let activeTokens = [];
        if (Array.isArray(userQuery)) {
          activeTokens = userQuery;
        } else if (userQuery && typeof userQuery === 'string') {
          activeTokens = expandIntentKeywords(userQuery);
        }

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

      // Expand user query / intent tokens for both Infobox prioritization and paragraph scoring
      const activeTokens = getExpandedTokens(userQuery);

      // 1. Extract Infobox key attributes
      const priorityInfoboxFacts = [];
      const normalInfoboxFacts = [];
      const infoboxMatch = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>(.*?)<\/table>/is);
      if (infoboxMatch) {
        const rows = [...infoboxMatch[1].matchAll(/<tr[^>]*>\s*<th[^>]*>(.*?)<\/th>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gis)];
        for (const r of rows) {
          const k = r[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const v = r[2]
            .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gis, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (
            k.length >= 2 &&
            v.length >= 1 &&
            !k.includes('logo') &&
            !k.includes('图标') &&
            !k.includes('其他名稱') &&
            !v.startsWith('http')
          ) {
            const line = `${k}: ${v}`;
            // Match key or value with active tokens (single char only matches key to avoid false positives)
            const isMatch = activeTokens.some((tk) => (tk.length >= 2 ? (k.includes(tk) || v.includes(tk)) : k.includes(tk)));
            if (isMatch) {
              priorityInfoboxFacts.push(line);
            } else {
              normalInfoboxFacts.push(line);
            }
          }
        }
      }

      // Priority facts come first, then general facts, up to 25 items total
      const infoboxFacts = [...priorityInfoboxFacts, ...normalInfoboxFacts].slice(0, 25);

      // 2. Clean HTML for body paragraphs
      const cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>.*?<\/table>/gis, '')
        .replace(/<div[^>]*class="[^"]*navbox[^"]*"[^>]*>.*?<\/div>/gis, '')
        .replace(/<div[^>]*class="[^"]*hatnote[^"]*"[^>]*>.*?<\/div>/gis, '');

      const pMatches = [...cleaned.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
      const allParagraphs = [];

      for (const m of pMatches) {
        const text = m[1]
          .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gis, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 25) {
          allParagraphs.push(text);
        }
      }

      if (allParagraphs.length === 0 && infoboxFacts.length === 0) return null;

      // 3. Lead overview paragraphs
      const leadParagraphs = allParagraphs.slice(0, 2);

      // 4. Query-sensitive section extraction
      let matchedParagraphs = [];
      if (activeTokens.length > 0) {
        const scored = allParagraphs.slice(2).map((p) => {
          let score = 0;
          let checkText = p;
          if (checkText.includes('个人数据') || checkText.includes('個人數據')) {
            checkText = checkText.replace(/个人数据|個人數據/g, '');
          }
          // Matching active intent tokens is the primary signal
          for (const tk of activeTokens) {
            if (checkText.includes(tk)) {
              score += (tk.length >= 2 ? 10 : 3);
            }
          }
          // Heavy bonus when intent keywords match AND paragraph contains quantities/numbers
          if (score > 0 && /\d+[\s,]*(?:人|名|位|万|萬|%|元|亿美元|港元)/.test(checkText)) {
            score += 15;
          }
          return { p, score };
        });

        scored.sort((a, b) => b.score - a.score);
        matchedParagraphs = scored
          .filter((item) => item.score >= 10)
          .slice(0, 3)
          .map((item) => item.p);
      }

      // Assemble structured summary
      const sections = [];
      if (infoboxFacts.length > 0) {
        sections.push(`【核心属性信息】\n` + infoboxFacts.join('\n'));
      }
      if (leadParagraphs.length > 0) {
        sections.push(`【概述】\n` + leadParagraphs.join('\n\n'));
      }
      if (matchedParagraphs.length > 0) {
        sections.push(`【相关重点细节】\n` + matchedParagraphs.join('\n\n'));
      }

      const fullSummary = sections.join('\n\n');

      return {
        title,
        summary: fullSummary.slice(0, 2500),
        url: articleUrl,
      };
    } catch (e) {
      console.error('[WikiService] getSummary error:', e);
      return null;
    }
  }

  // Atomic High-Performance RAG Pipeline
  async getRagContext(query) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { needsWiki: false, citations: [], promptContext: '', metadata: { latencyMs: 0 } };
    }

    // 快速熔断：若知识库离线或文件已拔出/移走，0ms 立即退出，避免浪费小模型推理和产生网络挂起
    if (!this.isOnline || !this.currentZimPath || !fs.existsSync(this.currentZimPath)) {
      return {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: { latencyMs: 0, offline: true },
      };
    }

    const trimmed = query.trim();

    // 1. In-memory LRU cache check
    const cached = getCachedContext(trimmed);
    if (cached) {
      return {
        ...cached,
        metadata: { ...cached.metadata, fromCache: true },
      };
    }

    const startTime = Date.now();

    // 2. Query Planning (2B model with 4s timeout + fallback to regex)
    let plan = await planQueryWithSLM(trimmed);
    let plannerName = 'slm-2b';
    if (!plan) {
      plan = fallbackRegexPlan(trimmed);
      plannerName = 'regex-fallback';
    }

    // 3. Negative check: if chit-chat / code / math / non-encyclopedic
    if (!plan.needs_wiki || !plan.target_articles || plan.target_articles.length === 0) {
      const negativeResult = {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: {
          fromCache: false,
          planner: plannerName,
          latencyMs: Date.now() - startTime,
          plan,
        },
      };
      setCachedContext(trimmed, negativeResult);
      return negativeResult;
    }

    // 4. Multi-entity parallel lookup (cap at max 3 entities)
    // Merge 2B model target articles with direct entity candidates in query
    const directCandidates = cleanQueryToEntityCandidates(query);
    const combinedTargets = [];
    const seen = new Set();
    for (const t of [...(plan.target_articles || []), ...directCandidates]) {
      const clean = (t || '').trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        combinedTargets.push(clean);
      }
    }
    const targetArticles = combinedTargets.slice(0, 3);
    const intentTokens = plan.intent_tokens || [];

    const fetchPromises = targetArticles.map(async (entity) => {
      // Step A: Search for the entity in Kiwix
      const matches = await this.search(entity);
      if (!matches || matches.length === 0) return null;

      // Step B: Try top matches (up to 3) in case the first is an empty or unresolvable disambiguation page
      let summaryData = null;
      for (const m of matches.slice(0, 3)) {
        summaryData = await this._fetchSummaryForTitle(m.title, intentTokens);
        if (summaryData && summaryData.summary) break;
      }
      if (!summaryData || !summaryData.summary) return null;

      return {
        title: summaryData.title,
        url: summaryData.url,
        summary: summaryData.summary.slice(0, 2500), // Cap single entity at 2500 chars
      };
    });

    const results = await Promise.allSettled(fetchPromises);
    const validCitations = [];
    const seenTitles = new Set();

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        if (!seenTitles.has(r.value.title)) {
          seenTitles.add(r.value.title);
          validCitations.push(r.value);
        }
      }
    }

    // If 0 citations found in knowledge base, do not inject junk
    if (validCitations.length === 0) {
      const emptyResult = {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: {
          fromCache: false,
          planner: plannerName,
          latencyMs: Date.now() - startTime,
          plan,
        },
      };
      setCachedContext(trimmed, emptyResult);
      return emptyResult;
    }

    // 5. Assemble structured prompt context
    const isEnglishQuery = !/[\u4e00-\u9fff]/.test(trimmed);
    const contextSections = validCitations.map((c, idx) => {
      const header = isEnglishQuery
        ? (validCitations.length > 1 ? `[Reference Article ${idx + 1}: ${c.title}]` : `[Reference Article: ${c.title}]`)
        : (validCitations.length > 1 ? `【参考条目 ${idx + 1}：${c.title}】` : `【参考条目：${c.title}】`);
      return `${header}\n${c.summary}`;
    });

    let fullPromptContext =
      (isEnglishQuery
        ? `[Authoritative reference material retrieved from the local knowledge base]\n\n`
        : `[以下为从本地知识库检索到的权威参考资料]\n\n`) +
      contextSections.join('\n\n---\n\n');

    // Cap total context budget at 7000 chars
    if (fullPromptContext.length > 7000) {
      fullPromptContext = fullPromptContext.slice(0, 7000) + (isEnglishQuery ? '\n...[Knowledge base context limit reached]' : '\n...[已达知识库检索字数上限]');
    }

    const finalResult = {
      needsWiki: true,
      citations: validCitations.map((c) => ({
        title: c.title,
        url: c.url,
        summary: c.summary.slice(0, 300),
      })),
      promptContext: fullPromptContext,
      metadata: {
        fromCache: false,
        planner: plannerName,
        latencyMs: Date.now() - startTime,
        plan,
        articleCount: validCitations.length,
      },
    };

    setCachedContext(trimmed, finalResult);
    return finalResult;
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

            // Save to persistent config
            saveStoredZimPath(newPath);

            // Restart service with new path
            await this.startService(newPath);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
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

      // Summary
      if (pathname === '/api/wiki/summary') {
        const title = urlObj.searchParams.get('title') || '';
        const query = urlObj.searchParams.get('query') || '';
        const data = await this.getSummary(title, query);
        if (data) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Article summary not found' }));
        }
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

export const wikiService = new WikiService();
