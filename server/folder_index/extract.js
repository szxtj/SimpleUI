import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readZipEntries } from './zip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tiff', '.tif', '.gif', '.bmp',
]);

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.log', '.xml', '.html', '.htm', '.rtf', '.srt', '.vtt', '.tex',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.java', '.go', '.rs', '.sh', '.zsh', '.css', '.sql', '.toml', '.ini',
]);

/** 单文件最大读取量：超过就只索引前 8MB，避免一个日志文件把索引撑爆 */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** 单文件最多抽多少页（PDF/PPT 页数上限） */
const MAX_PAGES = 2000;

let pdfHelperPath = null;
function findPdfHelper() {
  if (pdfHelperPath) return pdfHelperPath;
  const candidates = [
    path.resolve(__dirname, '..', '..', 'bin', 'pdftext'),
    path.resolve(__dirname, '..', '..', '..', 'bin', 'pdftext'),
    path.resolve(process.cwd(), 'bin', 'pdftext'),
    '/Applications/SimpleUI.app/Contents/Resources/bin/pdftext',
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      pdfHelperPath = p;
      return p;
    } catch {}
  }
  return null;
}

/** 归一化：去掉 PDF 排版带出来的多余空格与断行（中文尤其明显） */
export function normalizeText(s) {
  if (!s) return '';
  let t = s.replace(/\r\n?/g, '\n');
  t = t.replace(/\u00ad/g, ''); // soft hyphen
  t = t.replace(/-\n(?=[a-z])/g, ''); // 英文断词
  // 中文字符之间的空格是排版产物，全部去掉；中英之间保留一个空格
  t = t.replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/g, '$1$2');
  t = t.replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/g, '$1$2');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function runPdfText(bin, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pages = [];
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.error) { err = obj.error; continue; }
          if (typeof obj.t === 'string' && obj.t.trim()) pages.push({ page: obj.p || pages.length + 1, text: obj.t });
        } catch {}
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8').slice(0, 400); });
    child.on('error', reject);
    child.on('close', () => {
      if (!pages.length && err) reject(new Error(err));
      else resolve(pages.slice(0, MAX_PAGES));
    });
  });
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
function stripXml(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function docxPages(file) {
  const zip = readZipEntries(file);
  const xml = zip.read('word/document.xml');
  if (!xml) return [];
  const text = xml.toString('utf8')
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n');
  return [{ page: 1, text: normalizeText(stripXmlKeepLines(text)) }];
}
function stripXmlKeepLines(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ');
}

function pptxPages(file) {
  const zip = readZipEntries(file);
  const slides = zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
  const pages = [];
  slides.slice(0, MAX_PAGES).forEach((name, i) => {
    const xml = zip.read(name);
    if (!xml) return;
    const text = stripXml(xml.toString('utf8'));
    if (text) pages.push({ page: i + 1, text });
  });
  return pages;
}

function xlsxPages(file) {
  const zip = readZipEntries(file);
  const shared = zip.read('xl/sharedStrings.xml');
  const strings = [];
  if (shared) {
    const s = shared.toString('utf8');
    for (const m of s.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(stripXml(m[1]));
  }
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  const pages = [];
  sheets.slice(0, 200).forEach((name, i) => {
    const xml = zip.read(name);
    if (!xml) return;
    const cells = [...xml.toString('utf8').matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1]);
    const inline = [...xml.toString('utf8').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
    const vals = [...cells, ...inline].map((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n < strings.length && /^\d+$/.test(v) ? strings[n] : v;
    }).filter((v) => v && String(v).trim());
    if (vals.length) pages.push({ page: i + 1, text: decodeEntities(vals.join(' ')) });
  });
  return pages;
}

function htmlText(file) {
  const raw = fs.readFileSync(file, 'utf8').slice(0, MAX_TEXT_BYTES);
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  return [{ page: 1, text: normalizeText(decodeEntities(body.replace(/<[^>]+>/g, ' '))) }];
}

/**
 * 抽一个文件的内容。
 * 返回 { kind: 'text' | 'image' | 'none', pages: [{page, text}] }
 *   - text：有可嵌入的文本（PDF / Office / 纯文本 / 网页）
 *   - image：走视觉编码器（不抽文本）
 *   - none：不认识，只索引文件名/路径
 */
export async function extractFile(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', pages: [] };

  try {
    if (ext === '.pdf') {
      const bin = findPdfHelper();
      if (!bin) return { kind: 'none', pages: [], error: 'pdftext helper missing' };
      const pages = (await runPdfText(bin, absPath)).map((p) => ({ page: p.page, text: normalizeText(p.text) }));
      return { kind: pages.length ? 'text' : 'none', pages };
    }
    if (ext === '.docx') return { kind: 'text', pages: docxPages(absPath) };
    if (ext === '.pptx') return { kind: 'text', pages: pptxPages(absPath) };
    if (ext === '.xlsx') return { kind: 'text', pages: xlsxPages(absPath) };
    if (ext === '.html' || ext === '.htm') return { kind: 'text', pages: htmlText(absPath) };
    if (TEXT_EXTS.has(ext)) {
      const stat = fs.statSync(absPath);
      const fd = fs.openSync(absPath, 'r');
      const len = Math.min(stat.size, MAX_TEXT_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      const text = normalizeText(buf.toString('utf8').replace(/\u0000/g, ''));
      return { kind: text ? 'text' : 'none', pages: text ? [{ page: 1, text }] : [] };
    }
  } catch (err) {
    return { kind: 'none', pages: [], error: err.message };
  }
  return { kind: 'none', pages: [] };
}

/**
 * 把「页/段落」切成可嵌入的小块。
 *
 * 语义检索的召回粒度决定体验：块太大，命中位置模糊、向量被稀释；
 * 块太小，跨句的上下文又断掉。这里按 ~480 字（约 350 token）切，
 * 相邻块重叠 80 字，尽量在句号/问号处断开。
 */
export function chunkPages(pages, { size = 480, overlap = 80 } = {}) {
  const chunks = [];
  for (const { page, text } of pages) {
    if (!text) continue;
    if (text.length <= size) {
      chunks.push({ page, text });
      continue;
    }
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        // 往后找最近的句末，最多多看 60 字
        const windowEnd = Math.min(end + 60, text.length);
        const slice = text.slice(end, windowEnd);
        const m = slice.match(/[。！？!?\n]/);
        if (m) end += m.index + 1;
      }
      const piece = text.slice(start, end).trim();
      if (piece) chunks.push({ page, text: piece });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return chunks;
}
