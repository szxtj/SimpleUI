// TTF（TurboFieldfare）服务端日志只读探针
//
// 背景：TTF 的 HTTP 面只有 /health、/v1/models、/v1/chat/completions，
// **没有** /stats、/metrics 之类的轮询端点；`usage` 也只在最后一个 chunk 才给。
// 但 TTF 会把请求生命周期写进日志（由 turbo-fieldfare-manager 的 server.sh 指定）：
//
//   request <id> accepted streaming=true
//   request <id> prepared prompt=212          ← 生成开始前就有真实 prompt token 数
//   request <id> generating
//   request <id> completed in 7.2s prompt=212 cached=0 completion=17 pp=..s pp_tok_s=.. tg=..s tg_tok_s=.. finish=stop
//
// 实测：发出请求后约 180ms 即可读到 `prepared prompt=`，且与最终 usage.prompt_tokens 完全一致。
// 本模块只做**只读**解析，供前端在生成过程中取真实的 prompt token 数（替代估算值）。
//
// 降级：日志不存在（非 TTF 引擎 / 被清空）时返回 found:false，前端自动回退到估算器。

import fs from 'fs';
import os from 'os';
import path from 'path';

export const TTF_LOG_FILE =
  process.env.TTF_LOG_FILE ||
  path.join(os.homedir(), 'Library', 'Logs', 'turbo-fieldfare.log');

// 只读文件尾部：日志可能很大，而目标请求一定在末尾
const TAIL_BYTES = 512 * 1024;
// 已完成的记录可缓存（不会再变）；仅 prepared 的记录不缓存，以便下一次轮询能看到 completed
const completedCache = new Map();
const MAX_CACHE = 64;

function readTail() {
  try {
    const st = fs.statSync(TTF_LOG_FILE);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(TTF_LOG_FILE, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf-8');
  } catch (e) {
    return null; // 文件不存在 / 无权限
  }
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 查询某个请求（chatcmpl-…）在 TTF 日志里的记录 */
export function lookupRequest(id) {
  if (!id) return { found: false, reason: 'missing_id' };

  const cached = completedCache.get(id);
  if (cached) return cached;

  const text = readTail();
  if (text === null) {
    return { found: false, reason: 'log_unavailable', logFile: TTF_LOG_FILE };
  }

  const rec = { found: false, id };

  const prepared = text.match(new RegExp('request ' + esc(id) + ' prepared prompt=(\\d+)'));
  if (prepared) {
    rec.found = true;
    rec.promptTokens = Number(prepared[1]);
  }

  const completed = text.match(
    new RegExp(
      'request ' + esc(id) + ' completed in ([\\d.]+)s prompt=(\\d+) cached=(\\d+) completion=(\\d+)' +
      ' pp=([\\d.]+)s pp_tok_s=([\\d.]+) tg=([\\d.]+)s tg_tok_s=([\\d.]+) finish=(\\S+)'
    )
  );
  if (completed) {
    rec.found = true;
    rec.completed = true;
    rec.promptTokens = Number(completed[2]);
    rec.cachedTokens = Number(completed[3]);
    rec.completionTokens = Number(completed[4]);
    rec.prefillSeconds = Number(completed[5]);
    rec.prefillTokPerSec = Number(completed[6]);
    rec.decodeSeconds = Number(completed[7]);
    rec.decodeTokPerSec = Number(completed[8]);
    rec.finishReason = completed[9];
    if (completedCache.size >= MAX_CACHE) completedCache.clear();
    completedCache.set(id, rec);
  }

  return rec;
}

/**
 * prefill 阶段状态（供前端在等待首个 token 时显示估算进度）。
 *
 * TTF server **不暴露**实时 prefill 进度（`Prefill (N/M)` 只存在于它自己的 macOS App 里，
 * 见 Sources/TurboFieldfareApp/Core/State/AppPresentationState.swift）。
 * 但日志里有两条真实信息可以用：
 *   1. `prepared prompt=N` —— 本次请求的真实 prompt token 总数（生成开始前就写好）
 *   2. `completed ... pp_tok_s=R` —— 历史请求的实测 prefill 速率
 * 由此可估算：percent ≈ 已等待秒数 × 速率 ÷ N（封顶 99%，因为真实进度未知）。
 * 同时返回 `inFlight`：该请求是否尚未结束（前端可据此停止显示）。
 */
export function prefillStatus() {
  const text = readTail();
  if (text === null) {
    return { found: false, reason: 'log_unavailable', logFile: TTF_LOG_FILE };
  }

  const lines = text.split('\n');

  // 1) 最近一条 prepared（从后往前）
  let preparedIdx = -1;
  let preparedId = '';
  let promptTokens = 0;
  let at = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/request (chatcmpl-[0-9a-f]+) prepared prompt=(\d+)/);
    if (m) {
      preparedIdx = i;
      preparedId = m[1];
      promptTokens = Number(m[2]);
      const ts = lines[i].match(/^\[([^\]]+)\]/);
      at = ts ? ts[1] : '';
      break;
    }
  }
  if (preparedIdx === -1) {
    return { found: false, reason: 'no_prepared', logFile: TTF_LOG_FILE };
  }

  // 2) 该请求是否已结束（prepared 之后出现 completed / failed / cancelled）
  let inFlight = true;
  for (let i = preparedIdx + 1; i < lines.length; i++) {
    if (
      lines[i].includes('request ' + preparedId + ' completed') ||
      lines[i].includes('request ' + preparedId + ' failed') ||
      lines[i].includes('request ' + preparedId + ' cancelled')
    ) {
      inFlight = false;
      break;
    }
  }

  // 3) 近期实测 prefill 速率（最近 5 个非零 pp_tok_s 的平均；无数据时用保守默认值）
  const rates = [];
  for (const l of lines) {
    const m = l.match(/pp_tok_s=([\d.]+)/);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) rates.push(v);
    }
  }
  const recent = rates.slice(-5);
  const rate = recent.length
    ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10
    : 30;

  return {
    found: true,
    id: preparedId,
    promptTokens,
    at, // ISO UTC，前端用它过滤掉上一轮残留的 prepared 记录
    inFlight,
    rate,
    logFile: TTF_LOG_FILE,
  };
}

export const ttfLogService = {
  /** 处理 /api/ttf/* （只读） */
  handleApi(req, res) {
    const host = req.headers.host || '127.0.0.1:31235';
    let urlObj;
    try {
      urlObj = new URL(req.url, 'http://' + host);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'bad_request' }));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (urlObj.pathname === '/api/ttf/request') {
      const id = urlObj.searchParams.get('id') || '';
      const rec = lookupRequest(id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ logFile: TTF_LOG_FILE, ...rec }));
      return;
    }

    if (urlObj.pathname === '/api/ttf/prefill') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ logFile: TTF_LOG_FILE, ...prefillStatus() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unknown_ttf_endpoint' }));
  },
};
