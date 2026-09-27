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

// ---------------------------------------------------------------------------
// 归属判定：TTF 的日志是**全局**的——任何客户端（turbo-fieldfare-manager 的任务、
// CLI、其他应用）的请求都会写进同一条日志。本 APP 的阶段指示器只能显示
// **本代理转发过**的请求，否则别的任务一生成，界面就会出现别人的 prefill 数据
// （实测：tokens 与别的任务完全一致、百分比恒为 99%）。
// proxy.js 在转发 SSE 响应时上报首块携带的请求 id，本注册表保存最近 10 分钟的记录。
// ---------------------------------------------------------------------------
const FORWARD_TTL = 10 * 60 * 1000;
const forwardedRequests = new Map(); // id -> lastSeen epoch ms

export function noteForwardedRequest(id) {
  if (!id || typeof id !== 'string' || !id.startsWith('chatcmpl-')) return;
  const now = Date.now();
  forwardedRequests.set(id, now);
  for (const [k, t] of forwardedRequests) {
    if (now - t > FORWARD_TTL) forwardedRequests.delete(k);
  }
}

function isForwarded(id) {
  const t = forwardedRequests.get(id);
  return t !== undefined && Date.now() - t <= FORWARD_TTL;
}

// 最近一次「本代理转发推理请求」的时刻：SSE 首块（携带 id）可能要到 prefill 结束才到，
// 但转发动作本身发生在请求入口——用于归属兜底（见 prefillStatus 的 recentForward 分支）
let lastChatForwardAt = 0;
export function noteChatForward() {
  lastChatForwardAt = Date.now();
}

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
 *
 * **归属判定**：只统计 `noteForwardedRequest` 上报过（即本代理转发过）的请求。
 * TTF 日志是全局的，其他客户端的任务一律忽略——否则它们的 prefill/token 会被
 * 显示在本 APP 的界面上。若本代理的请求已被 accepted 但尚未 prepared，
 * 说明它正在 TTF 的串行队列里排队（前方有其他任务）→ 返回 `queued:true`。
 */
export function prefillStatus(sinceMs) {
  const text = readTail();
  if (text === null) {
    return { found: false, reason: 'log_unavailable', logFile: TTF_LOG_FILE };
  }

  const lines = text.split('\n');

  // 从后往前找最近一条**本代理转发过**的请求生命周期事件（accepted/prepared/queued/generating/…）
  let lastIdx = -1;
  let lastId = '';
  let lastKind = '';
  let promptTokens = 0;
  let at = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/request (chatcmpl-[0-9a-f]+) (accepted|prepared|queued|generating|completed|failed|cancelled)/);
    if (!m || !isForwarded(m[1])) continue; // 其他客户端的任务：跳过
    lastIdx = i;
    lastId = m[1];
    lastKind = m[2];
    const ts = lines[i].match(/^\[([^\]]+)\]/);
    at = ts ? ts[1] : '';
    break;
  }
  if (lastIdx === -1) {
    // 归属兜底：本代理转发的请求在 SSE 首块到来前无法获知 id（TTF 串行排队时
    // 可能长时间无响应）。此时模型是否被占用以日志里**最近一条**生命周期事件为准：
    //   仍在进行中（accepted/prepared/queued/generating）→ 模型被占用，本请求在排队
    //   已结束（completed/failed/cancelled）→ 模型空闲，本请求瞬态未入日志
    // 仅当事件过于陈旧（>10 分钟，多为异常残留的僵尸行）才忽略。
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/request (chatcmpl-[0-9a-f]+) (accepted|prepared|queued|generating|completed|failed|cancelled)/);
      if (!m) continue;
      const tsm = lines[i].match(/^\[([^\]]+)\]/);
      const atMs = tsm ? Date.parse(tsm[1].endsWith('Z') ? tsm[1] : tsm[1] + 'Z') : NaN;
      if (Number.isNaN(atMs)) continue;
      const inFlight = m[2] === 'accepted' || m[2] === 'prepared' || m[2] === 'queued' || m[2] === 'generating';
      if (!inFlight || Date.now() - atMs > 10 * 60 * 1000) {
        return { found: false, reason: 'model_idle_or_stale', logFile: TTF_LOG_FILE };
      }
      return { found: true, queued: true, at: tsm[1], logFile: TTF_LOG_FILE };
    }
    return { found: false, reason: 'no_forwarded_request', logFile: TTF_LOG_FILE };
  }

  // promptTokens / 精确时间戳：回溯该请求的 prepared 行（generating/queued 行上没有 prompt=）
  for (let i = lastIdx; i >= 0; i--) {
    const m = lines[i].match(/request (chatcmpl-[0-9a-f]+) prepared prompt=(\d+)/);
    if (m && m[1] === lastId) {
      promptTokens = Number(m[2]);
      const ts = lines[i].match(/^\[([^\]]+)\]/);
      if (ts) at = ts[1];
      break;
    }
  }

  // 该请求是否已结束：最后事件本身就是终态（completed/failed/cancelled），
  // 或其后出现了终态行
  let inFlight = !(lastKind === 'completed' || lastKind === 'failed' || lastKind === 'cancelled');
  if (inFlight) {
    for (let i = lastIdx + 1; i < lines.length; i++) {
      if (
        lines[i].includes('request ' + lastId + ' completed') ||
        lines[i].includes('request ' + lastId + ' failed') ||
        lines[i].includes('request ' + lastId + ' cancelled')
      ) {
        inFlight = false;
        break;
      }
    }
  }
  if (!inFlight) {
    // 归属兜底：最近一条已登记事件是「终态」，但本代理**刚刚转发过**推理请求——
    // 该新请求的 id 要到 SSE 首块才出现（prefill 期间无输出），尚未登记。
    // 此时日志里最近的生命周期事件（无论属于谁）若仍在进行中，即为本请求或
    // 排在其前的任务 → 显示"等待模型空闲"；若为 prepared/generating（带 prompt=N）
    // 则视为本请求的 prefill，按圆环估算显示。
    if (Date.now() - lastChatForwardAt < 3 * 60 * 1000) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/request (chatcmpl-[0-9a-f]+) (accepted|prepared|queued|generating|completed|failed|cancelled)/);
        if (!m) continue;
        const tsm = lines[i].match(/^\[([^\]]+)\]/);
        const kind = m[2];
        const busy = kind === 'accepted' || kind === 'prepared' || kind === 'queued' || kind === 'generating';
        if (!busy) break; // 最近事件已结束：模型空闲（本请求若已结束，指示器也会撤下）
        let promptTokens = 0;
        if (kind === 'prepared' || kind === 'generating') {
          for (let k = i; k >= 0; k--) {
            const pm = lines[k].match(/request (chatcmpl-[0-9a-f]+) prepared prompt=(\d+)/);
            if (pm && pm[1] === m[1]) { promptTokens = Number(pm[2]); break; }
          }
        }
        const ts = tsm[1];
        if (kind === 'accepted' || kind === 'queued' || promptTokens === 0) {
          return { found: true, queued: true, at: ts, logFile: TTF_LOG_FILE };
        }
        return { found: true, queued: false, id: m[1], promptTokens, at: ts, logFile: TTF_LOG_FILE };
      }
    }
    return { found: false, reason: 'request_finished', id: lastId, logFile: TTF_LOG_FILE };
  }

  // 排队中：TTF 的生命周期是 accepted → prepared → queued → generating，
  // **prepared 在 queued 之前写入**，不能用"有没有 prepared"判定排队；
  // 正确信号是最后事件为 queued（TTF 明确的排队标记）或 accepted（旧版无 queued 行）
  const queued = lastKind === 'queued' || lastKind === 'accepted';

  // 实时分块进度（仅当运行中的 TTF 二进制带进度日志时出现；无则前端用估算）
  let progress = null;
  if (!queued) {
    for (let i = lastIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/\] prefill (\d+)\/(\d+)\s*$/);
      if (m) progress = { done: Number(m[1]), total: Number(m[2]) };
    }
  }

  // 近期实测 prefill 速率（最近 5 个非零 pp_tok_s 的平均；无数据时用保守默认值）
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
    id: lastId,
    queued, // true = 已受理但排在其他任务后面（尚未开始 prefill）
    promptTokens,
    at, // ISO UTC，前端用它过滤掉上一轮残留的记录
    progress,
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
      const sinceRaw = Number(urlObj.searchParams.get('since'));
      const sinceMs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ logFile: TTF_LOG_FILE, ...prefillStatus(sinceMs) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unknown_ttf_endpoint' }));
  },
};
