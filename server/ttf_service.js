// TTF（TurboFieldfare）模型服务托管模块
//
// 职责：把 turbo-fieldfare-manager 的日常管理能力（启停 / 运行参数 / 路径 / 日志）
// 内置到 SimpleUI 的 Node 服务层，SimpleUI 成为模型服务的唯一管理方：
//   - 随 SimpleUI 启动自动拉起模型服务（enabled 开关，默认开启）；
//   - SimpleUI 退出时一并终止服务（与 wiki 数据库服务行为对齐）；
//   - 配置持久化在 SimpleUI 自己的 model_config.json，同时同步导出
//     TurboFieldfareBar 兼容格式的 config.env（双向兼容，两边改任一处互通）。
//
// 实现原则：不重写已验证的启停逻辑。server.sh（复制自 manager 项目，运行时资产
// ttf_server.sh）承载全部核心行为（PID 管理 / 健康探测 / 自动克隆 / 自动编译 /
// vision 收据自愈），本模块只做「配置生成 + 调脚本 + 状态聚合 + JSON API」。
//
// 与 manager 的状态探测完全同源：PID 文件 /tmp/turbo_fieldfare_server.pid、
// 健康端点 /v1/models、日志 ~/Library/Logs/turbo-fieldfare.log——无论服务由谁
// 拉起，状态都准确。
//
// 退出兜底：TurboFieldfareServer 本体没有 kiwix 那样的 --attachToProcess 机制，
// 因此首次启动时拉起一个 detached watchdog（仅监视本 Node 进程），Node 意外死亡
// （含 SIGKILL）时由 watchdog 兜底终止模型服务。正常退出走 cleanupAndExit 钩子。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

// ESM 环境没有 __dirname，从 import.meta.url 推导（与 proxy.js / wiki_service.js 同款写法）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();

// ----------------------------- 配置持久化 -----------------------------

const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'model_config.json');

// 兼容导出：TurboFieldfareBar 读取的 config.env（键名与其 ServerConfiguration 完全一致）
const ENV_EXPORT_DIR = path.join(HOME, 'Library', 'Application Support', 'TurboFieldfare');
const ENV_EXPORT_FILE = path.join(ENV_EXPORT_DIR, 'config.env');

// 与 ttf_server.sh / TurboFieldfareBar 保持同源的运行时路径
const TTF_LOG_FILE = process.env.TTF_LOG_FILE ||
  path.join(HOME, 'Library', 'Logs', 'turbo-fieldfare.log');
const PID_FILE = '/tmp/turbo_fieldfare_server.pid';
const BINARY_BASENAME = 'TurboFieldfareServer';

export const DEFAULT_MODEL_CONFIG = {
  // 随 SimpleUI 自动启动模型服务（用户明确要求 SimpleUI 作为唯一管理方）
  enabled: true,
  // 本体项目目录（支持 ~ 与符号链接，启动前解析为物理路径）
  projectDir: path.join(HOME, 'turbo-fieldfare'),
  port: 1235,
  // 与 TurboFieldfareBar 默认值不同：这里按用户实际运行配置（16K / 32 槽）作为 SimpleUI 默认
  maxContext: 16384,
  expertCacheSlots: 32,
  expertCachePolicy: 'lfu',
  prefill: 'on',
  prefillChunkTokens: 'auto',
  visionResidency: 'on-demand',
  promptCacheMode: 'single-prefix',
  thinking: 'default',
  rdadvise: 'adaptive',
  allowUnbackedContext: false,
  // 闲置自动重置（极低负载保护）：闲置满 N 分钟平滑重启释放显存，0 = 关闭；其余定义与 manager 一致
  idleAutoResetMinutes: 15,
};

// 合法取值域（与 ttf_server.sh 支持范围一致，用于校验前端提交）
const ENUMS = {
  expertCacheSlots: [8, 16, 24, 32],
  expertCachePolicy: ['lfu', 'lru'],
  prefill: ['on', 'off'],
  prefillChunkTokens: ['auto', '32', '64', '128', '256'],
  visionResidency: ['on-demand', 'keep-ready'],
  promptCacheMode: ['single-prefix', 'off'],
  thinking: ['default', 'on', 'off'],
  rdadvise: ['adaptive', 'bounded', 'default', 'off'],
  maxContext: [4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144],
};

function loadStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        return { ...DEFAULT_MODEL_CONFIG, ...data };
      }
    }
  } catch (e) {
    // 配置损坏时回退默认值，不阻断服务
  }
  return { ...DEFAULT_MODEL_CONFIG };
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// 规范化本体目录：展开 ~，符号链接解析为物理真实路径（与 manager resolveCanonicalPath 行为一致）
function resolveProjectDir(dir) {
  const expanded = expandHome(String(dir || '').trim() || DEFAULT_MODEL_CONFIG.projectDir);
  try {
    if (fs.existsSync(expanded)) {
      return fs.realpathSync(expanded);
    }
  } catch (e) {
    // ignore
  }
  return expanded;
}

function sanitizeConfig(partial) {
  const out = {};
  if (partial.enabled !== undefined) out.enabled = partial.enabled === true || partial.enabled === 'true';
  if (partial.projectDir !== undefined) {
    const dir = String(partial.projectDir || '').trim();
    if (dir) out.projectDir = dir; // 存原始输入，使用时再解析
  }
  if (partial.port !== undefined) {
    const port = Number(partial.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  }
  if (partial.maxContext !== undefined) {
    const v = Number(partial.maxContext);
    if (ENUMS.maxContext.includes(v)) out.maxContext = v;
  }
  if (partial.expertCacheSlots !== undefined) {
    const v = Number(partial.expertCacheSlots);
    if (ENUMS.expertCacheSlots.includes(v)) out.expertCacheSlots = v;
  }
  for (const key of ['expertCachePolicy', 'prefill', 'visionResidency', 'promptCacheMode', 'thinking', 'rdadvise']) {
    if (partial[key] !== undefined && ENUMS[key].includes(partial[key])) out[key] = partial[key];
  }
  if (partial.prefillChunkTokens !== undefined) {
    // 兼容数字 / 字符串两种提交形态
    const v = String(partial.prefillChunkTokens);
    if (ENUMS.prefillChunkTokens.includes(v)) out.prefillChunkTokens = v;
  }
  if (partial.allowUnbackedContext !== undefined) {
    out.allowUnbackedContext = partial.allowUnbackedContext === true || partial.allowUnbackedContext === 'true';
  }
  if (partial.idleAutoResetMinutes !== undefined) {
    // 与 manager 的 Stepper 范围一致：0 = 关闭，1~360 分钟
    const v = Number(partial.idleAutoResetMinutes);
    if (Number.isInteger(v) && v >= 0 && v <= 360) out.idleAutoResetMinutes = v;
  }
  return out;
}

// ----------------------------- 服务状态探测 -----------------------------

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch (e) {
    // ignore
  }
  return null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// ----------------------------- 服务模块 -----------------------------

class TtfService {
  constructor() {
    this.config = loadStoredConfig();
    this.pendingOp = null; // 'start' | 'stop' | 'restart'，供状态聚合区分过渡态
    this.lastActionLog = ''; // 最近一次脚本动作的输出尾部（错误排查用）
    this.lastActionAt = 0;
    this.watchdog = null; // 兜底守护进程（Node 意外死亡时终止模型服务）
    // 闲置自动重置追踪（与 manager ServiceManager 同款状态）
    this.idleTimer = null;
    this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
  }

  // server.sh 运行时资产：开发态与打包态都在本模块同目录（Resources/server/）
  findScript() {
    const candidates = [
      path.join(__dirname, 'ttf_server.sh'),
      path.resolve(__dirname, '../server/ttf_server.sh'),
      '/Applications/SimpleUI.app/Contents/Resources/server/ttf_server.sh',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // 生成脚本环境变量（manager 同款键名；同时写 config.env 供 TurboFieldfareBar 互操作）
  buildEnv() {
    const projectDir = resolveProjectDir(this.config.projectDir);
    return {
      TURBO_FIELDFARE_DIR: projectDir,
      TURBO_PORT: String(this.config.port),
      TURBO_MAX_CONTEXT: String(this.config.maxContext),
      TURBO_EXPERT_CACHE_SLOTS: String(this.config.expertCacheSlots),
      TURBO_EXPERT_CACHE_POLICY: this.config.expertCachePolicy,
      TURBO_PREFILL: this.config.prefill,
      TURBO_PREFILL_CHUNK_TOKENS: this.config.prefillChunkTokens,
      TURBO_VISION_RESIDENCY: this.config.visionResidency,
      TURBO_PROMPT_CACHE_MODE: this.config.promptCacheMode,
      TURBO_THINKING: this.config.thinking,
      TURBO_FIELDFARE_ALLOW_UNBACKED_CONTEXT: this.config.allowUnbackedContext ? '1' : '0',
      TURBO_RDADVISE: this.config.rdadvise,
      TURBO_IDLE_RESET_MINUTES: String(this.config.idleAutoResetMinutes ?? 15),
    };
  }

  exportEnvFile() {
    try {
      if (!fs.existsSync(ENV_EXPORT_DIR)) fs.mkdirSync(ENV_EXPORT_DIR, { recursive: true });
      const env = this.buildEnv();
      const lines = [
        '# TurboFieldfare 运行配置 (由 SimpleUI 模型服务管理自动生成)',
        ...Object.entries(env).map(([k, v]) => `export ${k}="${v}"`),
        '',
      ];
      fs.writeFileSync(ENV_EXPORT_FILE, lines.join('\n'));
    } catch (e) {
      // 导出失败不影响本机管理（仅影响与菜单栏 App 的互操作）
    }
  }

  async checkHealth() {
    const port = this.config.port;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/v1/models`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // 聚合状态：
  //   running  — PID 存活且健康探测 200
  //   loading  — PID 存活但尚未就绪（加载权重 / 编译后首启）
  //   starting / stopping / restarting — 脚本动作进行中
  //   stopped  — 无存活进程
  async getStatus() {
    const pid = readPid();
    const alive = isPidAlive(pid);
    const healthy = alive ? await this.checkHealth() : false;

    let status;
    if (this.pendingOp) {
      status = this.pendingOp;
    } else if (alive && healthy) {
      status = 'running';
    } else if (alive) {
      status = 'loading';
    } else {
      status = 'stopped';
    }

    const projectDir = resolveProjectDir(this.config.projectDir);
    const modelPath = path.join(projectDir, 'scratch/gemma4.gturbo');
    const visionPath = path.join(projectDir, 'scratch/gemma4.vision.gturbo');

    return {
      enabled: this.config.enabled,
      status,
      pid: alive ? pid : null,
      port: this.config.port,
      projectDir,
      modelPath,
      checks: {
        repo: fs.existsSync(path.join(projectDir, 'Package.swift')),
        binary: fs.existsSync(path.join(projectDir, '.build/release/TurboFieldfareServer')),
        model: fs.existsSync(modelPath),
        vision: fs.existsSync(visionPath),
      },
      lastActionAt: this.lastActionAt || undefined,
      lastActionLog: this.lastActionLog || undefined,
    };
  }

  // 兜底守护：仅在首次真正启动服务时拉起一次，监视本 Node 进程；
  // Node 死亡（含被 SIGKILL）后重读 PID 文件并终止模型服务。
  ensureWatchdog() {
    if (this.watchdog) return;
    const owner = process.pid;
    const script = [
      `while kill -0 ${owner} 2>/dev/null; do sleep 2; done`,
      `PID=$(cat ${PID_FILE} 2>/dev/null)`,
      `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
      `  kill -TERM "$PID" 2>/dev/null`,
      `  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done`,
      `  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null`,
      `fi`,
      `pkill -f "[${BINARY_BASENAME[0]}]${BINARY_BASENAME.slice(1)}" 2>/dev/null`,
      `rm -f ${PID_FILE} 2>/dev/null`,
    ].join('\n');
    try {
      this.watchdog = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' });
      this.watchdog.unref();
    } catch (e) {
      // watchdog 失败不阻断启动（正常退出仍由 proxy 退出钩子兜底）
    }
  }

  // ----------------------------- 闲置自动重置 (极低负载保护) -----------------------------
  //
  // 与 TurboFieldfareBar ServiceManager 同源，但修正了其计数缺陷：
  //   - 每 2s 扫描服务日志，统计 "] request ... accepted" 行与三种终态行
  //     （completed in / cancelled by client / failed phase=，词汇来自本体 ServerLog.swift）；
  //   - accepted − 终态数 即在途请求数（生成中绝不重置 = 计时停止）；
  //   - 任一终态到达 = 本轮生成结束，从该行时间戳重新起算闲置（计时开始）；
  //   - 从未处理过请求时不重置（启动后本身就是 ~75MB 极低待机）；
  //   - 闲置（最后一次终态起算）满 idleAutoResetMinutes 分钟 → 平滑重启，
  //     释放 2~4GB 显存回退至极低待机；重启会清空日志，状态自然归零。
  // 注意：manager 只统计 completed，cancelled/failed 的请求会被它永远算作在途
  // （用户点一次「停止」后闲置重置即失效）；本实现以源码确认的三终态为准。

  startIdleMonitor() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      Promise.resolve(this.checkIdleAutoReset()).catch(() => { /* ignore */ });
    }, 2000);
    this.idleTimer.unref();
  }

  stopIdleMonitor() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // 从日志行首解析 ISO8601 时间戳：[2026-09-22T19:08:10Z] request ...
  parseLogTimestamp(line) {
    const m = /^\[([^\]]+)\]/.exec(line);
    if (!m) return null;
    const ts = Date.parse(m[1]);
    return Number.isFinite(ts) ? ts : null;
  }

  async checkIdleAutoReset() {
    const minutes = Number(this.config.idleAutoResetMinutes) || 0;
    if (minutes <= 0) return;
    if (this.pendingOp) return; // 启停/重启进行中，不做判定
    if (!isPidAlive(readPid())) return; // 服务未运行

    // 扫描日志（start 每次截断重写，tail 窗口足以覆盖本生命周期内的全部请求行）
    // 请求终态以本体 ServerLog.swift 的词汇为准，恰好三种：
    //   "request <id> completed in ..."   — 正常完成
    //   "request <id> cancelled by client in ..." — 客户端中断（用户点停止/断连）
    //   "request <id> failed phase=..."   — 请求失败
    // 三种都算「生成结束」：在途数 = accepted − 全部终态；最后终态时刻 = 计时起点。
    // 漏掉 cancelled/failed 会让在途数永远 >0，闲置重置从此失效。
    const { lines } = this.tailLog(5000);
    let acceptedCount = 0;
    let terminalCount = 0;
    let latestTerminalAt = null;
    for (const line of lines) {
      if (!line.includes('] request ')) continue;
      const isTerminal =
        line.includes(' completed in ') ||
        line.includes(' cancelled by client ') ||
        line.includes(' failed phase=');
      if (line.includes(' accepted')) acceptedCount++;
      if (isTerminal) {
        terminalCount++;
        const ts = this.parseLogTimestamp(line);
        if (ts && (latestTerminalAt === null || ts > latestTerminalAt)) latestTerminalAt = ts;
      }
    }

    if (acceptedCount > 0) {
      this.idleState.hasHandled = true;
      this.idleState.inFlight = Math.max(0, acceptedCount - terminalCount);
      if (latestTerminalAt !== null) {
        this.idleState.lastFinishedAt = latestTerminalAt;
      } else if (this.idleState.lastFinishedAt === null) {
        // 有请求被接受但尚未见到任何终态（正在生成 / 时间戳缺失），以当前时间兜底
        this.idleState.lastFinishedAt = Date.now();
      }
    } else {
      // 启动/重置后尚无任何请求：本就处于 ~75MB 极低负载待机，无需重置
      this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
      return;
    }

    if (!this.idleState.hasHandled || this.idleState.inFlight > 0) return;
    if (this.idleState.lastFinishedAt === null) return;

    const elapsedMs = Date.now() - this.idleState.lastFinishedAt;
    if (elapsedMs < minutes * 60 * 1000) return;

    // 触发重置：先归零状态防止重复触发，再平滑重启
    this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
    const notice = `💤 [极低负载保护] 服务已闲置满 ${minutes} 分钟，正在自动平滑重置以释放显存与缓存，回退至约 75MB 极低待机状态...`;
    console.log(`[TtfService] ${notice}`);
    this.lastActionLog = notice;
    this.lastActionAt = Date.now();
    await this.restartService();
    // 重启会截断重写日志，通知在重启后追加，保证 UI 日志里能看到本次重置的原因
    try {
      fs.appendFileSync(TTF_LOG_FILE, `${notice}\n`);
    } catch (e) { /* ignore */ }
  }

  // 启动模型服务（异步执行脚本；结果通过 getStatus 轮询反映）
  async startService() {
    if (!this.config.enabled) {
      return { accepted: false, reason: 'disabled' };
    }
    const script = this.findScript();
    if (!script) {
      this.lastActionLog = 'ttf_server.sh not found (server/ 运行时资产缺失)';
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'script_not_found' };
    }
    const alive = isPidAlive(readPid());
    if (alive && !this.pendingOp) {
      // 已在运行（无论由谁拉起），无需重复启动
      return { accepted: true, alreadyRunning: true };
    }

    this.exportEnvFile();
    this.ensureWatchdog();
    this.pendingOp = 'start';
    this.lastActionAt = Date.now();

    await new Promise((resolve) => {
      const env = { ...process.env, ...this.buildEnv() };
      const child = spawn('/bin/bash', [script, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', () => {
        this.lastActionLog = out.split('\n').filter(Boolean).slice(-8).join('\n');
        resolve();
      });
      // 脚本内含自动编译等长任务，给足上限（10 分钟）防悬挂
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }, 10 * 60 * 1000);
      child.on('exit', () => clearTimeout(timer));
    });
    this.pendingOp = null;
    return { accepted: true };
  }

  // 停止模型服务（等待脚本优雅停止完成）
  async stopService() {
    const script = this.findScript();
    this.pendingOp = 'stop';
    this.lastActionAt = Date.now();
    try {
      if (script) {
        await new Promise((resolve) => {
          const child = spawn('/bin/bash', [script, 'stop'], { stdio: 'ignore' });
          child.on('exit', resolve);
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            resolve();
          }, 30 * 1000);
        });
      }
      // 兜底：脚本失败时直接对 PID 动手
      const pid = readPid();
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
        for (let i = 0; i < 10 && isPidAlive(pid); i++) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (isPidAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
        }
      }
    } finally {
      this.pendingOp = null;
    }
    return { accepted: true };
  }

  async restartService() {
    this.pendingOp = 'restart';
    await this.stopService();
    const result = await this.startService();
    return result;
  }

  // 应用配置：合并校验 → 持久化 → 导出兼容 env → 按需热重启
  async applyConfig(partial, restartIfRunning) {
    const clean = sanitizeConfig(partial);
    if (Object.keys(clean).length === 0) {
      return { success: false, error: 'NO_VALID_FIELDS' };
    }
    const wasRunning = isPidAlive(readPid());
    this.config = { ...this.config, ...clean };
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      return { success: false, error: e.message };
    }
    this.exportEnvFile();

    let restarted = false;
    if (restartIfRunning && wasRunning) {
      await this.restartService();
      restarted = true;
    }
    return { success: true, restarted, config: this.publicConfig() };
  }

  publicConfig() {
    // projectDir 返回用户原始输入（未强制解析物理路径，便于编辑）
    return { ...this.config };
  }

  // 随 SimpleUI 启动自动拉起（enabled 开关控制；失败不阻断主服务）
  init() {
    // 闲置重置监控常驻（内部按配置与运行状态自判，配置改动即时生效）
    this.startIdleMonitor();
    if (!this.config.enabled) {
      console.log('[TtfService] auto-start disabled (enabled=false)');
      return;
    }
    this.startService()
      .then((r) => {
        if (r && r.alreadyRunning) {
          console.log('[TtfService] model service already running, reused');
        } else if (r && r.accepted) {
          console.log('[TtfService] model service auto-start issued');
        } else {
          console.log(`[TtfService] auto-start skipped: ${r && r.reason}`);
        }
      })
      .catch((e) => console.error('[TtfService] auto-start failed:', e.message));
  }

  // 退出清理（SIGINT/SIGTERM 优雅路径；'exit' 钩子里只能尽力 SIGTERM）
  shutdownSync() {
    this.stopIdleMonitor();
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    }
  }

  shutdownForce() {
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
  }

  tailLog(maxLines = 200) {
    try {
      const st = fs.statSync(TTF_LOG_FILE);
      if (!st.isFile()) return { found: false, lines: [] };
      const TAIL = 512 * 1024;
      const start = Math.max(0, st.size - TAIL);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(TTF_LOG_FILE, 'r');
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      const all = buf.toString('utf-8').split('\n').filter((l) => l.trim());
      return { found: true, lines: all.slice(-maxLines), size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      return { found: false, lines: [] };
    }
  }

  async handleApi(req, res) {
    try {
      const host = req.headers.host || `127.0.0.1:31235`;
      const urlObj = new URL(req.url, `http://${host}`);
      const pathname = urlObj.pathname.replace(/^\/api\/model/, '');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const readBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
        });
        req.on('error', reject);
      });

      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }

      if (pathname === '/start' && req.method === 'POST') {
        const r = await this.startService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/stop' && req.method === 'POST') {
        const r = await this.stopService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/restart' && req.method === 'POST') {
        // 未运行时 restart 等价于 start（方便前端单一按钮语义）
        const alive = isPidAlive(readPid());
        const r = alive ? await this.restartService() : await this.startService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/config' && req.method === 'GET') {
        sendJson(200, this.publicConfig());
        return;
      }

      if (pathname === '/config' && req.method === 'POST') {
        const body = await readBody();
        const restartIfRunning = body.restartIfRunning === true;
        delete body.restartIfRunning;
        sendJson(200, await this.applyConfig(body, restartIfRunning));
        return;
      }

      if (pathname === '/logs' && req.method === 'GET') {
        const maxLines = Math.min(Number(urlObj.searchParams.get('lines')) || 200, 1000);
        sendJson(200, this.tailLog(maxLines));
        return;
      }

      sendJson(404, { error: 'Unknown model endpoint' });
    } catch (err) {
      console.error('[TtfService] handleApi error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
}

export const ttfService = new TtfService();
