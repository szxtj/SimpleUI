import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import * as OpenCC from 'opencc-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const KIWIX_PORT = 31236;
export const LAYA_API_URL = process.env.LAYA_API_URL || 'http://127.0.0.1:1236';
export const QWEN_API_URL = process.env.QWEN_API_URL || 'http://127.0.0.1:1234';

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

// End of OpenCC variants helper

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

// ==========================================
// Phase 2: LAYA Model System 1 Fast Decision Client
// ==========================================

export async function callLayaSystemOne(state, questions, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Primary: Native Laya-Serve / Jev POST /v1/systemone endpoint
    const res = await fetch(`${LAYA_API_URL}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ state, questions }),
    });
    clearTimeout(timer);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    clearTimeout(timer);
    // 2. Secondary: Compatible OpenAI endpoint on port 1236 if run with proxy wrapper
    try {
      const qKey = Object.keys(questions)[0] || 'decision';
      const prompt = `State: ${state}\nQuestion: ${qKey}\nAnswer with strictly YES or NO:`;
      const res2 = await fetch(`${LAYA_API_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.0,
          max_tokens: 10,
        }),
      });
      if (res2.ok) {
        const json2 = await res2.json();
        const text = json2.choices?.[0]?.message?.content?.toLowerCase() || '';
        const isYes = text.includes('yes') || text.includes('true') || text.includes('是');
        return {
          [qKey]: {
            choice: isYes ? 'yes' : 'no',
            probability: isYes ? 0.95 : 0.05,
          },
        };
      }
    } catch (e2) {
      // ignore
    }
  }
  return null;
}

export async function judgeNeedsWikiWithLaya(query) {
  if (!query || typeof query !== 'string') return false;
  const trimmed = query.trim();
  if (!trimmed) return false;

  const result = await callLayaSystemOne(
    trimmed,
    {
      intent: {
        type: 'choice',
        instructions: 'Classify the user input intent.',
        criteria: {
          chitchat_or_code: 'Casual greetings (e.g. 你好, 在吗, hello, hi), emotional sharing, seeking comfort or companionship, small talk, chitchat, jokes, conversational questions, or writing code/programming',
          knowledge_lookup: 'Factual questions asking for objective information about real world entities, people, companies, history, facts, science, or definitions',
        },
      },
    },
    1500
  );

  const answer = result?.answers?.intent || result?.intent;
  if (answer && answer.choice) {
    return answer.choice === 'knowledge_lookup';
  }
  return null; // Unreachable or not configured
}

export async function verifyFactWithLaya(query, fact) {
  if (!query || !fact) return false;

  const result = await callLayaSystemOne(
    `Question: ${query}\nCandidate answer: ${fact}`,
    {
      fact_eval: {
        type: 'choice',
        instructions: 'Evaluate whether the candidate answer directly answers the question.',
        criteria: {
          relevant: 'The candidate answer provides direct, accurate, and relevant factual information that answers the question.',
          irrelevant: 'The candidate answer is completely unrelated, off-topic, or answers a different question.',
        },
      },
    },
    1500
  );

  const answer = result?.answers?.fact_eval || result?.fact_eval;
  if (answer && answer.choice) {
    const isRelevant = answer.choice === 'relevant';
    const prob = answer.probabilities?.relevant ?? (isRelevant ? 0.9 : 0.1);
    return isRelevant && prob >= 0.45;
  }
  return false;
}

// ==========================================
// Phase 1: 4-Tier Aggressive Wikipedia HTML Cleaner
// ==========================================

export function cleanWikipediaHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  let html = rawHtml;

  // Level 1: Smart tail cutoff at notes / references / external links / see also
  const cutoffRegex = /<h2[^>]*>(?:(?!<\/h2>).)*?(?:註釋|注释|參考[資资]料|参考[資资]料|參考[文獻献]|参考[文獻献]|外部[連結链接]|參見|参见|延伸[閱讀阅读])/i;
  const match = html.match(cutoffRegex);
  if (match && match.index > 0) {
    html = html.slice(0, match.index);
  }

  // Level 2: Strip inline citations, reference lists, scripts, and styles
  html = html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, '')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gis, '')
    .replace(/<ol[^>]*class="[^"]*references[^"]*"[^>]*>.*?<\/ol>/gis, '');

  // Level 3: Strip sidebars, navboxes, infoboxes, hatnotes, thumbnails, catlinks
  html = html
    .replace(/<table[^>]*class="[^"]*(?:sidebar|vertical-navbox|navbox|infobox)[^"]*"[^>]*>.*?<\/table>/gis, '')
    .replace(/<div[^>]*class="[^"]*(?:sidebar|navbox|hatnote)[^"]*"[^>]*>.*?<\/div>/gis, '')
    .replace(/<div[^>]*id="catlinks"[^>]*>.*?<\/div>/gis, '')
    .replace(/<figure\b[^<]*(?:(?!<\/figure>)<[^<]*)*<\/figure>/gis, '')
    .replace(/<div[^>]*class="[^"]*thumb[^"]*"[^>]*>.*?<\/div>/gis, '');

  // Level 4: Entity decoding & whitespace normalization
  let text = html
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

  return text;
}

// ==========================================
// Phase 3: Qwen 3.5 2B Neural Machine Reading Comprehension
// ==========================================

export async function extractFactWithQwen(query, articleTitle, cleanedText) {
  if (!query || !cleanedText) return null;
  const textSample = cleanedText.slice(0, 1800); // Fast context window (~1100 tokens, 1.2s inference)
  const prompt = `[任务] 阅读以下百科条目正文，直接提炼出能正面回答问题【${query}】的1~2句核心客观事实与具体数据。
[规则]
1. 只输出提炼出的纯事实原句或确凿数据，严禁任何客套解释、前缀、引导语或推测。
2. 严禁输出任何与问题无关的简介描述、生平概述或泛泛背景。
3. 若正文中未包含能正面回答该问题的明确信息，必须且仅输出单词：NONE。

条目：《${articleTitle}》
正文内容：
${textSample}

事实提炼：`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);

  try {
    const res = await fetch(`${QWEN_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'qwen3.5-2b-optiq',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens: 150,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const out = (json.choices?.[0]?.message?.content || '').trim();
    if (
      !out ||
      out.toUpperCase() === 'NONE' ||
      out.toUpperCase().startsWith('NONE') ||
      out.includes('未提及') ||
      out.includes('没有提及') ||
      out.includes('未包含')
    ) {
      return null;
    }
    // Clean any residual quotation marks or prefixes
    const cleanedFact = out
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/^(?:事实提炼[：:]|答[：:]|提炼事实[：:])\s*/i, '')
      .trim();

    if (cleanedFact.length < 4) return null;
    return cleanedFact.slice(0, 300);
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

export const PLANNER_SYSTEM_PROMPT = `[任务] 分析用户的知识问答，推断或提取其在百科全书中检索的核心规范实体词、事件名或专有名词（1~2个）。
[示例]
问：中国第一颗原子弹爆炸是在什么时候？
答：{"target_articles": ["中国第一颗原子弹", "596工程"]}
问：周杰伦的第一张专辑叫什么？
答：{"target_articles": ["Jay", "周杰伦"]}
问：特斯拉现在的CEO是谁？
答：{"target_articles": ["特斯拉", "埃隆·马斯克"]}
问：光速是多少？
答：{"target_articles": ["光速"]}
问：李白是哪朝人？
答：{"target_articles": ["李白"]}

问：`;

export async function planQueryWithSLM(query) {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  const prompt = `${PLANNER_SYSTEM_PROMPT}${trimmed}\n只输出纯JSON，不要任何多余文字：`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

  try {
    const res = await fetch(`${QWEN_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'qwen3.5-2b-optiq',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 60,
      }),
    });

    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(text);

    if (parsed && Array.isArray(parsed.target_articles)) {
      const articles = parsed.target_articles
        .map((a) => String(a).replace(/[《》]/g, '').trim())
        .filter(Boolean)
        .slice(0, 2);
      if (articles.length > 0) {
        return {
          needs_wiki: true,
          target_articles: articles,
          planner: 'qwen3.5-2b',
        };
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
  }

  return null;
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

  // Search articles with unified suggest + pattern search
  async search(rawTerm) {
    if (!rawTerm || !rawTerm.trim() || !this.isOnline) return [];
    const term = rawTerm.trim();
    const content = this.contentId || 'wikipedia_zh_all_maxi';
    const variants = getAllVariants(term);

    const candidateMap = new Map();

    // 1. Full-text pattern search (captures articles whose content or title matches the query)
    const searchPromises = variants.slice(0, 2).map(async (v) => {
      try {
        const searchUrl = `http://127.0.0.1:${KIWIX_PORT}/search?content=${encodeURIComponent(content)}&pattern=${encodeURIComponent(v)}`;
        const res = await fetch(searchUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const html = await res.text();
          const matches = [...html.matchAll(/<a href="\/content\/[^/]+\/([^"]+)">\s*([^<]+)\s*<\/a>/g)];
          return matches.slice(0, 6).map((m, idx) => {
            const rawPath = decodeURIComponent(m[1].trim());
            const title = decodeURIComponent(m[2].trim());
            return {
              title,
              path: rawPath,
              url: `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(rawPath)}`,
              source: 'pattern',
              rank: idx,
            };
          });
        }
      } catch (e) {
        // ignore
      }
      return [];
    });

    // 2. Kiwix suggest endpoint (captures exact and prefix titles)
    const suggestPromises = variants.slice(0, 3).map(async (v) => {
      try {
        const suggestUrl = `http://127.0.0.1:${KIWIX_PORT}/suggest?content=${encodeURIComponent(content)}&term=${encodeURIComponent(v)}`;
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

    const [patternResultLists, suggestResultLists] = await Promise.all([
      Promise.all(searchPromises),
      Promise.all(suggestPromises),
    ]);

    for (const list of [...patternResultLists, ...suggestResultLists]) {
      for (const item of list) {
        if (!candidateMap.has(item.title) && !candidateMap.has(item.path)) {
          candidateMap.set(item.title, item);
        }
      }
    }

    const allResults = Array.from(candidateMap.values());
    if (allResults.length === 0) return [];

    // Relevance scoring
    const scoreItem = (item) => {
      let score = 0;
      const title = item.title;
      if (/^(?:Category|分类|分類|Portal|Help|帮助|幫助|File|文件|Image|Wikipedia):/i.test(title)) {
        return -100;
      }
      for (const v of variants) {
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
      if (item.source === 'pattern' && item.rank === 0) {
        score = Math.max(score, 92);
      } else if (item.source === 'pattern' && item.rank === 1) {
        score = Math.max(score, 88);
      } else if (item.source === 'suggest' && item.rank === 0) {
        score = Math.max(score, 90);
      }
      return score;
    };

    allResults.sort((a, b) => scoreItem(b) - scoreItem(a));
    return allResults.filter((item) => scoreItem(item) > 0).slice(0, 6);
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

      // Extract high-value factual key-values from Wikipedia infobox table
      const infoboxMatch = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>(.*?)<\/table>/is);
      let infoboxSummary = '';
      if (infoboxMatch) {
        const rows = [...infoboxMatch[1].matchAll(/<tr[^>]*>.*?<th[^>]*>(.*?)<\/th>.*?<td[^>]*>(.*?)<\/td>.*?<\/tr>/gis)];
        const kvs = [];
        for (const row of rows) {
          const k = row[1].replace(/<[^>]+>/g, '').trim();
          const v = row[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (k && v && k.length < 20 && v.length < 100) {
            kvs.push(`${k}: ${v}`);
          }
        }
        if (kvs.length > 0) {
          infoboxSummary = '[基本档案] ' + kvs.slice(0, 10).join(' | ');
        }
      }

      // 4-Tier Deep Cleaning: Cut off references/notes/see-also, strip sidebars, navboxes, tags
      const cleanedText = cleanWikipediaHtml(html);
      if (!cleanedText || cleanedText.length < 20) return null;

      // Combine structured key facts with the cleaned lead text
      const fullContext = (infoboxSummary ? infoboxSummary + '\n\n' : '') + cleanedText.slice(0, 1400);

      // Neural Machine Reading Comprehension via Qwen 3.5 2B
      const queryStr = Array.isArray(userQuery) ? userQuery.join(' ') : (userQuery || title);
      const fact = await extractFactWithQwen(queryStr, title, fullContext);
      if (!fact) return null;

      return {
        title,
        summary: fact,
        url: articleUrl,
      };
    } catch (e) {
      console.error('[WikiService] _fetchSummaryForTitle error:', e);
      return null;
    }
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

    // 1. In-memory LRU cache check
    const cached = getCachedContext(trimmed);
    if (cached) {
      return {
        ...cached,
        metadata: { ...cached.metadata, fromCache: true },
      };
    }

    // Fast Bypass: Trivial greetings and small talk (0ms)
    const GREETING_REGEX = /^(?:你好|您好|早安|早上好|晚上好|嗨|hello|hi|hey|在吗|在嗎|哈哈|谢谢|謝謝|多谢|多謝|再见|再見|拜拜|bye|你是谁|你叫什么|你能做什么)[\s，,！!？?在吗啊呀吧]*$/i;
    if (GREETING_REGEX.test(trimmed)) {
      const negativeResult = {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: { fromCache: false, planner: 'greeting-fast-bypass', latencyMs: 0 },
      };
      setCachedContext(trimmed, negativeResult);
      return negativeResult;
    }

    const startTime = Date.now();

    // 2. LAYA System 1 Fast Decision Gate (15ms)
    const needsWikiLaya = await judgeNeedsWikiWithLaya(trimmed);
    if (needsWikiLaya === false) {
      const negativeResult = {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: {
          fromCache: false,
          planner: 'laya-system1-gated',
          latencyMs: Date.now() - startTime,
        },
      };
      setCachedContext(trimmed, negativeResult);
      return negativeResult;
    }

    // 3. High-Precision Entity Planning via Qwen 3.5 2B (~600ms)
    let plan = await planQueryWithSLM(trimmed);
    let targetArticles = [];
    let plannerName = 'qwen3.5-2b';

    if (plan && plan.target_articles && plan.target_articles.length > 0) {
      targetArticles = plan.target_articles.slice(0, 2);
    } else {
      // Fallback: search the natural query directly without slicing
      const cleanNaturalQuery = trimmed.replace(/[？?！!。，,、：“”"''（）()\s]+$/, '');
      if (cleanNaturalQuery.length >= 2) {
        targetArticles = [cleanNaturalQuery];
      }
      plannerName = 'direct-query-fallback';
      plan = { needs_wiki: true, target_articles: targetArticles, planner: plannerName };
    }

    if (targetArticles.length === 0) {
      const negativeResult = {
        needsWiki: false,
        citations: [],
        promptContext: '',
        metadata: {
          fromCache: false,
          planner: plannerName,
          latencyMs: Date.now() - startTime,
        },
      };
      setCachedContext(trimmed, negativeResult);
      return negativeResult;
    }

    const fetchPromises = targetArticles.map(async (entity) => {
      const matches = await this.search(entity);
      if (!matches || matches.length === 0) return null;

      let summaryData = null;
      for (const m of matches.slice(0, 3)) {
        summaryData = await this._fetchSummaryForTitle(m.title, trimmed);
        if (summaryData && summaryData.summary) break;
      }
      if (!summaryData || !summaryData.summary) return null;

      // LAYA Verification Gate: Validate relevance of the extracted fact
      const isValid = await verifyFactWithLaya(trimmed, summaryData.summary);
      if (!isValid) {
        return null;
      }

      return {
        title: summaryData.title,
        url: summaryData.url,
        summary: summaryData.summary,
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

    // If 0 citations found or verified, do not inject any noise
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

    // 5. Assemble high-density, pure-signal Grounding Facts (< 300 chars)
    const contextSections = validCitations.map((c) => {
      return `【${c.title}】: ${c.summary}`;
    });

    const fullPromptContext = contextSections.join('\n\n');

    const finalResult = {
      needsWiki: true,
      citations: validCitations.map((c) => ({
        title: c.title,
        url: c.url,
        summary: c.summary,
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
