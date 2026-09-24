import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import * as OpenCC from 'opencc-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const KIWIX_PORT = 31236;

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

class WikiService {
  constructor() {
    this.kiwixProcess = null;
    this.currentZimPath = null;
    this.contentId = null;
    this.bookTitle = '维基百科';
    this.articleCount = 0;
    this.mediaCount = 0;
    this.isOnline = false;
    this.isStarting = false;
    this.scanInterval = null;
  }

  // Find ZIM file on external SSD or user-specified path
  findZimFile(preferredDir) {
    const candidates = [];
    if (preferredDir && fs.existsSync(preferredDir)) {
      candidates.push(preferredDir);
    }
    // Specific JustinSSD location found on this machine
    candidates.push('/Volumes/JustinSSD/wikipedia');
    candidates.push('/Volumes/JustinSSD');

    // Dynamically check any other mounted volumes in /Volumes
    try {
      if (fs.existsSync('/Volumes')) {
        const vols = fs.readdirSync('/Volumes');
        for (const vol of vols) {
          if (vol === 'Macintosh HD' || vol === 'Recovery') continue;
          candidates.push(path.join('/Volumes', vol, 'wikipedia'));
          candidates.push(path.join('/Volumes', vol));
        }
      }
    } catch (e) {
      // ignore
    }

    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) continue;
        const stat = fs.statSync(dir);
        if (stat.isFile() && dir.endsWith('.zim')) {
          return dir;
        }
        if (stat.isDirectory()) {
          const files = fs.readdirSync(dir);
          const zim = files.find((f) => f.endsWith('.zim'));
          if (zim) {
            return path.join(dir, zim);
          }
        }
      } catch (e) {
        // ignore unreadable dirs
      }
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
        // When started with -z, content ID drops the date
        this.contentId = `${nameMatch[1]}_${flavourMatch[1]}`;
      } else {
        // Fallback to match content link
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
  async startService(customDir) {
    if (this.isStarting) return;
    this.isStarting = true;

    try {
      const zimPath = this.findZimFile(customDir);
      if (!zimPath) {
        this.isOnline = false;
        this.currentZimPath = null;
        this.isStarting = false;
        return false;
      }

      this.currentZimPath = zimPath;

      // Check if already running and responding
      const healthy = await this.checkHealth();
      if (healthy) {
        this.isOnline = true;
        this.isStarting = false;
        return true;
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
      for (let i = 0; i < 15; i++) {
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

  // Periodic watch to auto-reconnect if SSD is plugged in or unplugged
  initWatcher() {
    this.startService();
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = setInterval(async () => {
      const alive = await this.checkHealth();
      if (!alive) {
        await this.startService();
      }
    }, 8000);
  }

  // Search articles by term / query with Chinese variant invariance
  async search(query) {
    if (!query || !query.trim()) return [];
    const rawTerm = query.trim();
    const variants = getAllVariants(rawTerm);
    const content = this.contentId || 'wikipedia_zh_all_maxi_2026-08';

    // 1. Query Kiwix suggest endpoint for all variants in parallel
    const suggestPromises = variants.map(async (v) => {
      try {
        const suggestUrl = `http://127.0.0.1:${KIWIX_PORT}/suggest?content=${encodeURIComponent(content)}&term=${encodeURIComponent(v)}`;
        const res = await fetch(suggestUrl);
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
    const candidateMap = new Map();

    for (const list of suggestResultLists) {
      for (const item of list) {
        if (!candidateMap.has(item.title) && !candidateMap.has(item.path)) {
          candidateMap.set(item.title, item);
        }
      }
    }

    // 2. If suggest yielded very few results, fallback to search pattern for variants
    if (candidateMap.size < 3) {
      const searchPromises = variants.slice(0, 3).map(async (v) => {
        try {
          const searchUrl = `http://127.0.0.1:${KIWIX_PORT}/search?content=${encodeURIComponent(content)}&pattern=${encodeURIComponent(v)}`;
          const res = await fetch(searchUrl);
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

    // 3. Relevance ranking: exact matches across variants come first, then prefix, etc.
    const scoreItem = (item) => {
      let score = 0;
      const title = item.title;
      if (title.startsWith('Category:') || title.startsWith('分类:') || title.startsWith('分類:')) {
        score -= 50;
      }
      for (const v of variants) {
        if (title === v) {
          score = Math.max(score, 100);
        } else if (title.startsWith(v)) {
          score = Math.max(score, 80);
        } else if (title.endsWith(v)) {
          score = Math.max(score, 60);
        } else if (title.includes(v)) {
          score = Math.max(score, 40);
        }
      }
      return score;
    };

    allResults.sort((a, b) => scoreItem(b) - scoreItem(a));
    return allResults.slice(0, 8);
  }

  // Extract clean lead paragraph summary for RAG ingestion
  async getSummary(title) {
    if (!title) return null;
    const variants = getAllVariants(title);
    for (const v of variants) {
      const summary = await this._fetchSummaryForTitle(v);
      if (summary) return summary;
    }
    return null;
  }

  async _fetchSummaryForTitle(title) {
    const content = this.contentId || 'wikipedia_zh_all_maxi_2026-08';
    const articleUrl = `http://127.0.0.1:${KIWIX_PORT}/content/${content}/${encodeURIComponent(title)}`;

    try {
      const res = await fetch(articleUrl);
      if (!res.ok) return null;
      const html = await res.text();

      // Clean HTML: Remove scripts, styles, infoboxes, navbars, references
      let cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>.*?<\/table>/gis, '')
        .replace(/<div[^>]*class="[^"]*navbox[^"]*"[^>]*>.*?<\/div>/gis, '')
        .replace(/<div[^>]*class="[^"]*hatnote[^"]*"[^>]*>.*?<\/div>/gis, '');

      // Extract paragraphs
      const pMatches = [...cleaned.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
      const paragraphs = [];

      for (const m of pMatches) {
        const text = m[1]
          .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gis, '') // remove [1][2]
          .replace(/<[^>]+>/g, '') // strip all HTML tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 25) {
          paragraphs.push(text);
          if (paragraphs.length >= 3) break;
        }
      }

      const summary = paragraphs.join('\n\n');
      if (!summary) return null;

      return {
        title,
        summary: summary.slice(0, 1800), // bounded context window
        url: articleUrl,
      };
    } catch (e) {
      console.error('[WikiService] getSummary error:', e);
      return null;
    }
  }

  // Handle incoming HTTP requests on /api/wiki/*
  async handleApi(req, res) {
    try {
      const host = req.headers.host || '127.0.0.1:31235';
      const urlObj = new URL(req.url, `http://${host}`);
      const pathname = urlObj.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

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

    if (pathname === '/api/wiki/search') {
      const q = urlObj.searchParams.get('q') || '';
      const results = await this.search(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: q, results }));
      return;
    }

    if (pathname === '/api/wiki/summary') {
      const title = urlObj.searchParams.get('title') || '';
      const data = await this.getSummary(title);
      if (data) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Article summary not found' }));
      }
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
