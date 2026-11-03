// 模型服务托管模块（支持 TurboFieldfare / Mference / Maple MLX 三引擎切换）
//
// 职责：把模型服务的日常管理能力（启停 / 运行参数 / 路径 / 日志）
// 内置到 SimpleUI 的 Node 服务层，SimpleUI 成为本地模型服务的唯一管理方：
//   - 支持在 TurboFieldfare (Gemma 4)、Mference (Qwen 3.6)、Maple MLX (Maple 20B-A1B) 之间切换；
//   - 随 SimpleUI 启动自动拉起选中的基础模型服务（enabled 开关，默认开启）；
//   - 切换引擎时严格互斥，安全停止前一个模型以彻底释放统一显存；
//   - SimpleUI 退出时一并终止服务（与 wiki 数据库服务行为对齐）；
//   - 配置持久化在 SimpleUI 自己的 model_config.json。
//
// 运行时依赖：
//   - TurboFieldfare: ttf_server.sh -> .build/release/TurboFieldfareServer (默认端口 1235)
//   - Mference: mference_server.sh -> .build/release/MferenceServer (默认端口 1241)
//   - Maple MLX: maple_mlx_server.sh -> 独立 Python venv 里的 mlx_lm.server (默认端口 1242)
//     运行时与权重都由本模块托管（见 maple_download.js），首次使用需在设置面板下载。

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { MapleModelDownloader, MapleRuntimeInstaller } from './maple_download.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();

// ----------------------------- 配置持久化 -----------------------------

const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'model_config.json');

// 兼容导出：TurboFieldfareBar 读取的 config.env
const ENV_EXPORT_DIR = path.join(HOME, 'Library', 'Application Support', 'TurboFieldfare');
const ENV_EXPORT_FILE = path.join(ENV_EXPORT_DIR, 'config.env');

export const ENGINE_METADATA = {
  'turbo-fieldfare': {
    name: 'TurboFieldfare',
    modelName: 'Gemma 4 26B',
    defaultPort: 1235,
    binaryBasename: 'TurboFieldfareServer',
    pidFile: '/tmp/turbo_fieldfare_server.pid',
    logFile: process.env.TTF_LOG_FILE || path.join(HOME, 'Library', 'Logs', 'turbo-fieldfare.log'),
    projectUrl: 'https://github.com/drumih/turbo-fieldfare',
    scriptBasename: 'ttf_server.sh',
  },
  'mference': {
    name: 'Mference',
    modelName: 'Qwen 3.6 35B-A3B',
    defaultPort: 1241,
    binaryBasename: 'MferenceServer',
    pidFile: '/tmp/mference_server.pid',
    logFile: path.join(HOME, 'Library', 'Logs', 'mference.log'),
    projectUrl: 'https://github.com/NeelM0906/Mference',
    scriptBasename: 'mference_server.sh',
  },
  'maple-mlx': {
    name: 'Maple MLX',
    modelName: 'Maple Preview 20B-A1B',
    defaultPort: 1242,
    // 看门狗只拿它做命令行校验（`ps -o args=` 里含 mlx_lm.server），不做全局匹配
    binaryBasename: 'mlx_lm.server',
    pidFile: '/tmp/maple_mlx_server.pid',
    logFile: path.join(HOME, 'Library', 'Logs', 'maple-mlx.log'),
    projectUrl: 'https://github.com/deepgrove-ai/mlx-lm-deepgrove',
    scriptBasename: 'maple_mlx_server.sh',
  },
};

/** 全部受管引擎（顺序即界面顺序） */
export const ALL_ENGINES = ['turbo-fieldfare', 'mference', 'maple-mlx'];

const defaultMferenceDir = path.join(HOME, 'Mference');

// Maple MLX 的运行时与权重由 SimpleUI 托管（非用户自备仓库）
export const SUPPORT_DIR = path.join(userConfigDir);
export const DEFAULT_MAPLE_RUNTIME_DIR = path.join(SUPPORT_DIR, 'runtimes', 'maple-mlx');
export const DEFAULT_MAPLE_MODEL_DIR = path.join(SUPPORT_DIR, 'models', 'maple-preview-2bit-mlx');

export const DEFAULT_MODEL_CONFIG = {
  enabled: false,
  engine: 'turbo-fieldfare', // 'turbo-fieldfare' | 'mference' | 'maple-mlx'
  ttfEnabled: false,
  mferenceEnabled: false,
  mapleEnabled: false,

  // 1. TurboFieldfare 配置参数
  projectDir: path.join(HOME, 'turbo-fieldfare'),
  port: 1235,
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

  // 2. Mference 配置参数
  mferenceProjectDir: defaultMferenceDir,
  mferencePort: 1241,
  mferenceMaxContext: 16384,
  mferencePromptCacheMode: 'single-prefix',
  mferenceShadowBudget: 4,
  mferenceVerify: 'auto',
  mferenceQueueLimit: 4,
  mferencePrefillChunk: '2048',

  // 3. Maple MLX 配置参数（运行时 + 权重由 SimpleUI 托管）
  maplePort: 1242,
  maplePromptCacheSize: 4,
  maplePrefillStepSize: 2048,
  mapleFlashHead: false,

  // 闲置自动重置
  idleAutoResetMinutes: 30,
};

// 合法取值域
const ENUMS = {
  engine: ALL_ENGINES,
  // TurboFieldfare
  expertCacheSlots: [8, 16, 24, 32],
  expertCachePolicy: ['lfu', 'lru'],
  prefill: ['on', 'off'],
  prefillChunkTokens: ['auto', '32', '64', '128', '256'],
  visionResidency: ['on-demand', 'keep-ready'],
  promptCacheMode: ['single-prefix', 'off'],
  thinking: ['default', 'on', 'off'],
  rdadvise: ['adaptive', 'bounded', 'default', 'off'],
  maxContext: [4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144],
  // Mference
  mferenceMaxContext: [4096, 8192, 16384, 32768, 65536, 128000],
  mferencePromptCacheMode: ['single-prefix', 'off'],
  mferenceShadowBudget: [0, 1, 2, 3, 4, 6, 8],
  mferenceVerify: ['auto', 'full-sha256', 'trusted-receipt'],
  mferenceQueueLimit: [1, 2, 4, 8, 16, 32],
  // Maple MLX（mlx_lm.server 只接受生成参数，没有上下文/专家槽概念）
  maplePromptCacheSize: [1, 2, 4, 8, 16],
  maplePrefillStepSize: [512, 1024, 2048, 4096],
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
    // 配置损坏时回退默认值
  }
  return { ...DEFAULT_MODEL_CONFIG };
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function resolveProjectDir(dir, defaultDir) {
  const expanded = expandHome(String(dir || '').trim() || defaultDir);
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
  if (partial.ttfEnabled !== undefined) out.ttfEnabled = partial.ttfEnabled === true || partial.ttfEnabled === 'true';
  if (partial.mferenceEnabled !== undefined) out.mferenceEnabled = partial.mferenceEnabled === true || partial.mferenceEnabled === 'true';
  if (partial.mapleEnabled !== undefined) out.mapleEnabled = partial.mapleEnabled === true || partial.mapleEnabled === 'true';
  if (partial.engine !== undefined && ENUMS.engine.includes(partial.engine)) {
    out.engine = partial.engine;
  }

  // TurboFieldfare
  if (partial.projectDir !== undefined) {
    const dir = String(partial.projectDir || '').trim();
    if (dir) out.projectDir = dir;
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
    const v = String(partial.prefillChunkTokens);
    if (ENUMS.prefillChunkTokens.includes(v)) out.prefillChunkTokens = v;
  }
  if (partial.allowUnbackedContext !== undefined) {
    out.allowUnbackedContext = partial.allowUnbackedContext === true || partial.allowUnbackedContext === 'true';
  }

  // Mference
  if (partial.mferenceProjectDir !== undefined) {
    const dir = String(partial.mferenceProjectDir || '').trim();
    if (dir) out.mferenceProjectDir = dir;
  }
  if (partial.mferencePort !== undefined) {
    const port = Number(partial.mferencePort);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.mferencePort = port;
  }
  if (partial.mferenceMaxContext !== undefined) {
    const v = Number(partial.mferenceMaxContext);
    if (ENUMS.mferenceMaxContext.includes(v)) out.mferenceMaxContext = v;
  }
  if (partial.mferencePromptCacheMode !== undefined && ENUMS.mferencePromptCacheMode.includes(partial.mferencePromptCacheMode)) {
    out.mferencePromptCacheMode = partial.mferencePromptCacheMode;
  }
  if (partial.mferenceShadowBudget !== undefined) {
    const v = Number(partial.mferenceShadowBudget);
    if (ENUMS.mferenceShadowBudget.includes(v)) out.mferenceShadowBudget = v;
  }
  if (partial.mferenceVerify !== undefined && ENUMS.mferenceVerify.includes(partial.mferenceVerify)) {
    out.mferenceVerify = partial.mferenceVerify;
  }
  if (partial.mferenceQueueLimit !== undefined) {
    const v = Number(partial.mferenceQueueLimit);
    if (ENUMS.mferenceQueueLimit.includes(v)) out.mferenceQueueLimit = v;
  }
  if (partial.mferencePrefillChunk !== undefined) {
    out.mferencePrefillChunk = String(partial.mferencePrefillChunk);
  }

  // Maple MLX：运行时与权重目录固定由 App 托管，这里刻意**不接受**路径覆写
  // （设置了也不生效，避免「面板能填、实际不认」的错觉）。
  if (partial.maplePort !== undefined) {
    const port = Number(partial.maplePort);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.maplePort = port;
  }
  for (const key of ['maplePromptCacheSize', 'maplePrefillStepSize']) {
    if (partial[key] !== undefined) {
      const v = Number(partial[key]);
      if (ENUMS[key].includes(v)) out[key] = v;
    }
  }
  if (partial.mapleTemperature !== undefined) {
    const v = Number(partial.mapleTemperature);
    if (Number.isFinite(v) && v >= 0 && v <= 2) out.mapleTemperature = v;
  }
  if (partial.mapleTopP !== undefined) {
    const v = Number(partial.mapleTopP);
    if (Number.isFinite(v) && v > 0 && v <= 1) out.mapleTopP = v;
  }
  if (partial.mapleTopK !== undefined) {
    const v = Number(partial.mapleTopK);
    if (Number.isInteger(v) && v >= 0 && v <= 256) out.mapleTopK = v;
  }
  if (partial.mapleMinP !== undefined) {
    const v = Number(partial.mapleMinP);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out.mapleMinP = v;
  }
  if (partial.mapleRepPenalty !== undefined) {
    const v = Number(partial.mapleRepPenalty);
    if (Number.isFinite(v) && v >= 1 && v <= 2) out.mapleRepPenalty = v;
  }
  if (partial.mapleFlashHead !== undefined) {
    out.mapleFlashHead = partial.mapleFlashHead === true || partial.mapleFlashHead === 'true';
  }

  // 闲置重置
  if (partial.idleAutoResetMinutes !== undefined) {
    const v = Number(partial.idleAutoResetMinutes);
    if (Number.isInteger(v) && v >= 0 && v <= 360) out.idleAutoResetMinutes = v;
  }

  return out;
}

// ----------------------------- 进程状态辅助 -----------------------------

function readPidForFile(pidFile) {
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
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

// ----------------------------- 服务类定义 -----------------------------

class TtfService {
  constructor() {
    this.config = loadStoredConfig();
    this.pendingOp = null; // 'start' | 'stop' | 'restart'
    this.pendingOpEngine = null; // 'turbo-fieldfare' | 'mference' | null
    this.lastActionLog = '';
    this.lastActionAt = 0;
    this.watchdog = null;
    this.watchdogs = new Map();
    this.idleTimer = null;
    this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
    // Maple MLX：运行时安装与权重下载（首次使用需要按需下载）
    this.mapleModelDownloader = null;
    this.mapleRuntimeInstaller = null;
  }

  getActiveEngine() {
    const engine = this.config.engine;
    return ALL_ENGINES.includes(engine) ? engine : 'turbo-fieldfare';
  }

  getActivePort() {
    return this.portForEngine(this.getActiveEngine());
  }

  /** 该引擎的「自动启动」独立开关对应的配置键 */
  engineEnabledKey(engine) {
    if (engine === 'mference') return 'mferenceEnabled';
    if (engine === 'maple-mlx') return 'mapleEnabled';
    return 'ttfEnabled';
  }

  isEngineEnabled(engine) {
    return Boolean(this.config[this.engineEnabledKey(engine)]);
  }

  // ---- Maple MLX 托管资源（惰性构造：只有用到才建目录/对象） ----

  /**
   * Maple 的运行时与权重目录是**固定**的（App 托管），与语音输入 / 语音合成 / 实时字幕 /
   * 快速翻译 / 视觉识别五个服务保持同一套约定：用户只需要「安装/下载/启停」，
   * 不提供路径选择。配置里即使残留旧的 mapleModelDir/mapleRuntimeDir 也不采信。
   *
   * 运行时随包优先（打包态 Resources/server/maple-mlx，开发态 bin/maple_runtime，
   * 由 scripts/build_maple_runtime.sh 构建并带 .ready 标记）；两者都不存在时
   * 才回落用户目录的 venv（旧装配 / 未构建随包运行时的开发机）。
   */
  mapleDirs() {
    const bundled = [
      path.resolve(__dirname, 'maple-mlx'),
      path.resolve(__dirname, '..', 'bin', 'maple_runtime'),
    ].find((p) => fs.existsSync(path.join(p, 'bin', 'python')));
    return {
      runtimeDir: bundled || DEFAULT_MAPLE_RUNTIME_DIR,
      modelDir: DEFAULT_MAPLE_MODEL_DIR,
    };
  }

  getMapleModelDownloader() {
    const { modelDir } = this.mapleDirs();
    if (!this.mapleModelDownloader || this.mapleModelDownloader.modelDir !== modelDir) {
      this.mapleModelDownloader = new MapleModelDownloader(modelDir);
    }
    return this.mapleModelDownloader;
  }

  getMapleRuntimeInstaller() {
    const { runtimeDir } = this.mapleDirs();
    if (!this.mapleRuntimeInstaller || this.mapleRuntimeInstaller.runtimeDir !== runtimeDir) {
      this.mapleRuntimeInstaller = new MapleRuntimeInstaller(runtimeDir);
    }
    return this.mapleRuntimeInstaller;
  }

  getActiveMeta() {
    return ENGINE_METADATA[this.getActiveEngine()];
  }

  readPid(engine = this.getActiveEngine()) {
    const meta = ENGINE_METADATA[engine];
    return readPidForFile(meta.pidFile);
  }

  findScript(engine = this.getActiveEngine()) {
    const scriptBasename = ENGINE_METADATA[engine].scriptBasename;
    const candidates = [
      path.join(__dirname, scriptBasename),
      path.resolve(__dirname, `../server/${scriptBasename}`),
      `/Applications/SimpleUI.app/Contents/Resources/server/${scriptBasename}`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  buildEnv(engine = this.getActiveEngine()) {
    if (engine === 'mference') {
      const projectDir = resolveProjectDir(this.config.mferenceProjectDir, DEFAULT_MODEL_CONFIG.mferenceProjectDir);
      return {
        MFERENCE_DIR: projectDir,
        MFERENCE_PORT: String(this.config.mferencePort || 1241),
        MFERENCE_MAX_CONTEXT: String(this.config.mferenceMaxContext || 16384),
        MFERENCE_PROMPT_CACHE_MODE: this.config.mferencePromptCacheMode || 'single-prefix',
        MFERENCE_SHADOW_BUDGET: String(this.config.mferenceShadowBudget ?? 4),
        MFERENCE_VERIFY: this.config.mferenceVerify || 'auto',
        MFERENCE_QUEUE_LIMIT: String(this.config.mferenceQueueLimit || 4),
        MFERENCE_PREFILL_CHUNK: String(this.config.mferencePrefillChunk || '2048'),
        MFERENCE_MODEL_ID: 'qwen3.6-35b-a3b',
      };
    }

    if (engine === 'maple-mlx') {
      const { runtimeDir, modelDir } = this.mapleDirs();
      return {
        MAPLE_PORT: String(this.config.maplePort || 1242),
        MAPLE_RUNTIME_DIR: runtimeDir,
        MAPLE_MODEL_DIR: modelDir,
        MAPLE_PROMPT_CACHE_SIZE: String(this.config.maplePromptCacheSize || 4),
        MAPLE_PREFILL_STEP_SIZE: String(this.config.maplePrefillStepSize || 2048),
        MAPLE_FLASH_HEAD: this.config.mapleFlashHead === false ? 'off' : 'on',
      };
    }

    const projectDir = resolveProjectDir(this.config.projectDir, DEFAULT_MODEL_CONFIG.projectDir);
    return {
      TURBO_FIELDFARE_DIR: projectDir,
      TURBO_PORT: String(this.config.port || 1235),
      TURBO_MAX_CONTEXT: String(this.config.maxContext || 16384),
      TURBO_EXPERT_CACHE_SLOTS: String(this.config.expertCacheSlots || 32),
      TURBO_EXPERT_CACHE_POLICY: this.config.expertCachePolicy || 'lfu',
      TURBO_PREFILL: this.config.prefill || 'on',
      TURBO_PREFILL_CHUNK_TOKENS: this.config.prefillChunkTokens || 'auto',
      TURBO_VISION_RESIDENCY: this.config.visionResidency || 'on-demand',
      TURBO_PROMPT_CACHE_MODE: this.config.promptCacheMode || 'single-prefix',
      TURBO_THINKING: this.config.thinking || 'default',
      TURBO_FIELDFARE_ALLOW_UNBACKED_CONTEXT: this.config.allowUnbackedContext ? '1' : '0',
      TURBO_RDADVISE: this.config.rdadvise || 'adaptive',
      TURBO_IDLE_RESET_MINUTES: String(this.config.idleAutoResetMinutes ?? 30),
    };
  }

  exportEnvFile() {
    // 所有配置已统一收敛至 ~/Library/Application Support/SimpleUI/model_config.json
  }

  /** 任一引擎的监听端口（三引擎唯一端口映射来源） */
  portForEngine(engine) {
    if (engine === 'mference') return Number(this.config.mferencePort) || 1241;
    if (engine === 'maple-mlx') return Number(this.config.maplePort) || 1242;
    return Number(this.config.port) || 1235;
  }

  async checkHealth(engine = this.getActiveEngine()) {
    const port = this.portForEngine(engine);
    return new Promise((resolve) => {
      // 先尝试 /health，再尝试 /v1/models
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        const req2 = http.get(`http://127.0.0.1:${port}/v1/models`, { timeout: 1500 }, (res2) => {
          res2.resume();
          resolve(res2.statusCode === 200);
        });
        req2.on('error', () => resolve(false));
        req2.on('timeout', () => {
          req2.destroy();
          resolve(false);
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async getStatus() {
    // 1. 独立探测 TurboFieldfare
    const ttfPid = this.readPid('turbo-fieldfare');
    const ttfAlive = isPidAlive(ttfPid);
    const ttfHealthy = ttfAlive ? await this.checkHealth('turbo-fieldfare') : false;
    let ttfStatus = 'stopped';
    if (this.pendingOp && this.pendingOpEngine === 'turbo-fieldfare') {
      ttfStatus = this.pendingOp;
    } else if (ttfAlive && ttfHealthy) {
      ttfStatus = 'running';
    } else if (ttfAlive) {
      ttfStatus = 'loading';
    }

    const ttfProjectDir = resolveProjectDir(this.config.projectDir, DEFAULT_MODEL_CONFIG.projectDir);
    const ttfModelPath = path.join(ttfProjectDir, 'scratch/gemma4.gturbo');
    const ttfVisionPath = path.join(ttfProjectDir, 'scratch/gemma4.vision.gturbo');
    const ttfChecks = {
      repo: fs.existsSync(path.join(ttfProjectDir, 'Package.swift')),
      binary: fs.existsSync(path.join(ttfProjectDir, '.build/release/TurboFieldfareServer')),
      model: fs.existsSync(ttfModelPath),
      vision: fs.existsSync(ttfVisionPath),
    };
    const ttfPort = Number(this.config.port) || 1235;

    // 2. 独立探测 Mference
    const mferencePid = this.readPid('mference');
    const mferenceAlive = isPidAlive(mferencePid);
    const mferenceHealthy = mferenceAlive ? await this.checkHealth('mference') : false;
    let mferenceStatus = 'stopped';
    if (this.pendingOp && this.pendingOpEngine === 'mference') {
      mferenceStatus = this.pendingOp;
    } else if (mferenceAlive && mferenceHealthy) {
      mferenceStatus = 'running';
    } else if (mferenceAlive) {
      mferenceStatus = 'loading';
    }

    const mferenceProjectDir = resolveProjectDir(this.config.mferenceProjectDir, DEFAULT_MODEL_CONFIG.mferenceProjectDir);
    const mferenceModelPath = path.join(mferenceProjectDir, 'scratch/qwen36.gturbo');
    const mferenceChecks = {
      repo: fs.existsSync(path.join(mferenceProjectDir, 'Package.swift')),
      binary: fs.existsSync(path.join(mferenceProjectDir, '.build/release/MferenceServer')),
      model: fs.existsSync(path.join(mferenceModelPath, 'manifest.json')),
      vision: false,
    };
    const mferencePort = Number(this.config.mferencePort) || 1241;

    // 3. 独立探测 Maple MLX
    const maplePid = this.readPid('maple-mlx');
    const mapleAlive = isPidAlive(maplePid);
    const mapleHealthy = mapleAlive ? await this.checkHealth('maple-mlx') : false;
    let mapleStatus = 'stopped';
    if (this.pendingOp && this.pendingOpEngine === 'maple-mlx') {
      mapleStatus = this.pendingOp;
    } else if (mapleAlive && mapleHealthy) {
      mapleStatus = 'running';
    } else if (mapleAlive) {
      mapleStatus = 'loading';
    }

    const { runtimeDir: mapleRuntimeDir, modelDir: mapleModelDir } = this.mapleDirs();
    const mapleRuntimeReady = this.getMapleRuntimeInstaller().ready();
    const mapleModelReady = this.getMapleModelDownloader().ready();
    const mapleChecks = {
      // 与另外两个引擎的字段对齐：repo→运行时，binary→可执行 python，model→权重
      repo: mapleRuntimeReady,
      binary: fs.existsSync(path.join(mapleRuntimeDir, 'bin', 'python')),
      model: mapleModelReady,
      vision: false,
    };
    const maplePort = Number(this.config.maplePort) || 1242;
    const mapleRuntime = this.getMapleRuntimeInstaller();
    const mapleDownload = this.getMapleModelDownloader();
    const mapleAssets = {
      runtime: {
        ready: mapleRuntimeReady,
        dir: mapleRuntimeDir,
        presentBytes: mapleRuntime.presentBytes(),
        totalBytes: mapleRuntime.state.totalBytes,
        installState: mapleRuntime.status(),
      },
      model: {
        ready: mapleModelReady,
        dir: mapleModelDir,
        presentBytes: mapleDownload.presentBytes(),
        totalBytes: mapleDownload.state.totalBytes,
        downloadState: mapleDownload.status(),
      },
    };

    // 当前活跃引擎：谁在跑就是谁；都没跑则回落到配置里的选择
    const runningEngine = ttfAlive
      ? 'turbo-fieldfare'
      : mferenceAlive
      ? 'mference'
      : mapleAlive
      ? 'maple-mlx'
      : null;
    const activeEngine = runningEngine || this.getActiveEngine();

    const byEngine = {
      'turbo-fieldfare': {
        engine: 'turbo-fieldfare',
        status: ttfStatus,
        port: ttfPort,
        pid: ttfAlive ? ttfPid : null,
        enabled: Boolean(this.config.ttfEnabled),
        checks: ttfChecks,
        projectDir: ttfProjectDir,
        modelPath: ttfModelPath,
        projectUrl: ENGINE_METADATA['turbo-fieldfare'].projectUrl,
      },
      mference: {
        engine: 'mference',
        status: mferenceStatus,
        port: mferencePort,
        pid: mferenceAlive ? mferencePid : null,
        enabled: Boolean(this.config.mferenceEnabled),
        checks: mferenceChecks,
        projectDir: mferenceProjectDir,
        modelPath: mferenceModelPath,
        projectUrl: ENGINE_METADATA['mference'].projectUrl,
      },
      'maple-mlx': {
        engine: 'maple-mlx',
        status: mapleStatus,
        port: maplePort,
        pid: mapleAlive ? maplePid : null,
        enabled: Boolean(this.config.mapleEnabled),
        checks: mapleChecks,
        projectDir: mapleRuntimeDir,
        modelPath: mapleModelDir,
        projectUrl: ENGINE_METADATA['maple-mlx'].projectUrl,
        assets: mapleAssets,
      },
    };

    const current = byEngine[activeEngine];

    return {
      activeEngine,
      engine: activeEngine,
      status: current.status,
      port: current.port,
      pid: current.pid,
      projectDir: current.projectDir,
      modelPath: current.modelPath,
      projectUrl: current.projectUrl,
      checks: current.checks,
      enabled: current.enabled,

      // 独立三服务数据（彻底独立，前端各取所需）
      ttf: byEngine['turbo-fieldfare'],
      mference: byEngine.mference,
      maple: byEngine['maple-mlx'],

      lastActionAt: this.lastActionAt || undefined,
      lastActionLog: this.lastActionLog || undefined,
      config: this.publicConfig(),
    };
  }

  ensureWatchdogs() {
    if (!this.watchdogs) this.watchdogs = new Map();
    for (const engine of ALL_ENGINES) {
      const meta = ENGINE_METADATA[engine];
      if (meta && !this.watchdogs.has(meta.pidFile)) {
        try {
          const w = startWatchdog({
            pidFile: meta.pidFile,
            binaryBasename: meta.binaryBasename,
          });
          this.watchdogs.set(meta.pidFile, w);
          if (engine === this.getActiveEngine()) {
            this.watchdog = w;
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }

  ensureWatchdog() {
    this.ensureWatchdogs();
  }

  // ----------------------------- 闲置自动重置 -----------------------------

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

  parseLogTimestamp(line) {
    const m = /^\[([^\]]+)\]/.exec(line);
    if (!m) return null;
    const ts = Date.parse(m[1]);
    return Number.isFinite(ts) ? ts : null;
  }

  async checkIdleAutoReset() {
    const minutes = Number(this.config.idleAutoResetMinutes) || 0;
    if (minutes <= 0) return;
    if (this.pendingOp) return;
    if (!isPidAlive(this.readPid())) return;

    const engine = this.getActiveEngine();
    const { lines } = this.tailLog(engine, 5000);
    let acceptedCount = 0;
    let terminalCount = 0;
    let latestTerminalAt = null;

    if (engine === 'maple-mlx') {
      // mlx_lm.server 用的是 Python http.server 日志：请求在**响应结束时**才落一行
      // `127.0.0.1 - - [02/Nov/2026 16:17:35] "POST /v1/chat/completions HTTP/1.1" 200 -`
      // 所以「有这行 = 已完成」，不像 TTF/Mference 那样有 accepted/completed 两段。
      for (const line of lines) {
        if (!/"(POST|GET) \/v1\/(chat\/completions|completions|models)/.test(line)) continue;
        if (!/"\s(200|4\d\d|5\d\d)\s/.test(line)) continue;
        const m = /\[(\d{2})\/(\w{3})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\]/.exec(line);
        acceptedCount++;
        terminalCount++;
        if (m) {
          const ts = Date.parse(`${m[2]} ${m[1]}, ${m[3]} ${m[4]}:${m[5]}:${m[6]}`);
          if (Number.isFinite(ts) && (latestTerminalAt === null || ts > latestTerminalAt)) latestTerminalAt = ts;
        }
      }
    } else {
      for (const line of lines) {
        if (!line.includes('] request ')) continue;
        // 兼容 TTF 与 Mference 日志词汇
        const isTerminal =
          line.includes(' completed in ') ||
          line.includes(' cancelled by client ') ||
          line.includes(' cancelled streaming=') ||
          line.includes(' failed phase=') ||
          line.includes(' failed status=') ||
          line.includes(' stream aborted');

        if (line.includes(' accepted') || line.includes(' started streaming=')) {
          acceptedCount++;
        }
        if (isTerminal) {
          terminalCount++;
          const ts = this.parseLogTimestamp(line);
          if (ts && (latestTerminalAt === null || ts > latestTerminalAt)) latestTerminalAt = ts;
        }
      }
    }

    if (acceptedCount > 0) {
      this.idleState.hasHandled = true;
      this.idleState.inFlight = Math.max(0, acceptedCount - terminalCount);
      if (latestTerminalAt !== null) {
        this.idleState.lastFinishedAt = latestTerminalAt;
      } else if (this.idleState.lastFinishedAt === null) {
        this.idleState.lastFinishedAt = Date.now();
      }
    } else {
      this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
      return;
    }

    if (!this.idleState.hasHandled || this.idleState.inFlight > 0) return;
    if (this.idleState.lastFinishedAt === null) return;

    const elapsedMs = Date.now() - this.idleState.lastFinishedAt;
    if (elapsedMs < minutes * 60 * 1000) return;

    this.idleState = { hasHandled: false, inFlight: 0, lastFinishedAt: null };
    const notice = `💤 [极低负载保护] 模型服务已闲置满 ${minutes} 分钟，正在自动平滑重置以释放显存与缓存...`;
    console.log(`[ModelService] ${notice}`);
    this.lastActionLog = notice;
    this.lastActionAt = Date.now();
    await this.restartService();

    try {
      fs.appendFileSync(this.getActiveMeta().logFile, `${notice}\n`);
    } catch (e) { /* ignore */ }
  }

  // ----------------------------- 启停动作 -----------------------------

  async stopEngine(engine) {
    const meta = ENGINE_METADATA[engine];
    const script = this.findScript(engine);
    if (script) {
      await new Promise((resolve) => {
        const child = spawn('/bin/bash', [script, 'stop'], { stdio: 'ignore' });
        child.on('exit', resolve);
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
          resolve();
        }, 15 * 1000);
      });
    }

    const pid = readPidForFile(meta.pidFile);
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
      for (let i = 0; i < 10 && isPidAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
      }
    }
  }

  async startService(engineToStart) {
    const activeEngine = engineToStart || this.getActiveEngine();
    this.config.engine = activeEngine;
    this.config[this.engineEnabledKey(activeEngine)] = true;
    this.config.enabled = true;

    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) { /* ignore */ }

    // 显存严格互斥：三个引擎两两互斥，确保非当前选中的引擎完全停止
    for (const otherEngine of ALL_ENGINES) {
      if (otherEngine === activeEngine) continue;
      const otherPid = this.readPid(otherEngine);
      if (isPidAlive(otherPid)) {
        console.log(`[ModelService] 正在停止互斥的旧引擎 (${otherEngine})...`);
        await this.stopEngine(otherEngine);
      }
    }

    const script = this.findScript(activeEngine);
    if (!script) {
      const missing = ENGINE_METADATA[activeEngine].scriptBasename;
      this.lastActionLog = `${missing} not found (server/ 运行时资产缺失)`;
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'script_not_found' };
    }

    this.ensureWatchdogs();
    const alive = isPidAlive(this.readPid(activeEngine));
    if (alive && !this.pendingOp) {
      return { accepted: true, alreadyRunning: true };
    }

    this.exportEnvFile();
    this.pendingOp = 'start';
    this.pendingOpEngine = activeEngine;
    this.lastActionAt = Date.now();

    await new Promise((resolve) => {
      const env = { ...process.env, ...this.buildEnv(activeEngine) };
      const child = spawn('/bin/bash', [script, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', () => {
        this.lastActionLog = out.split('\n').filter(Boolean).slice(-8).join('\n');
        resolve();
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }, 10 * 60 * 1000);
      child.on('exit', () => clearTimeout(timer));
    });

    this.pendingOp = null;
    this.pendingOpEngine = null;
    return { accepted: true };
  }

  async stopService(engineToStop) {
    this.pendingOp = 'stop';
    this.pendingOpEngine = engineToStop || null;
    this.lastActionAt = Date.now();
    try {
      if (ALL_ENGINES.includes(engineToStop)) {
        this.config[this.engineEnabledKey(engineToStop)] = false;
        await this.stopEngine(engineToStop);
      } else {
        // 无参数 = 全停（退出 App / 关闭总开关）
        for (const engine of ALL_ENGINES) this.config[this.engineEnabledKey(engine)] = false;
        this.config.enabled = false;
        for (const engine of ALL_ENGINES) {
          await this.stopEngine(engine);
        }
      }
    } finally {
      this.pendingOp = null;
      this.pendingOpEngine = null;
    }

    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) { /* ignore */ }

    return { accepted: true };
  }

  async restartService(engineToRestart) {
    const target = engineToRestart || this.getActiveEngine();
    this.pendingOp = 'restart';
    this.pendingOpEngine = target;
    await this.stopService(target);
    const result = await this.startService(target);
    return result;
  }

  async applyConfig(partial, restartIfRunning) {
    const clean = sanitizeConfig(partial);
    if (Object.keys(clean).length === 0) {
      return { success: false, error: 'NO_VALID_FIELDS' };
    }

    // 若只传了通用的 enabled（如状态栏原生菜单），根据当前活跃引擎同步到对应的独立开关
    if (
      clean.enabled !== undefined &&
      clean.ttfEnabled === undefined &&
      clean.mferenceEnabled === undefined &&
      clean.mapleEnabled === undefined
    ) {
      clean[this.engineEnabledKey(this.getActiveEngine())] = clean.enabled;
    }

    const oldEngine = this.getActiveEngine();
    const wasRunning = isPidAlive(this.readPid(oldEngine));

    this.config = { ...this.config, ...clean };
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      return { success: false, error: e.message };
    }

    this.exportEnvFile();

    const newEngine = this.getActiveEngine();
    const engineChanged = oldEngine !== newEngine;

    let restarted = false;
    if (restartIfRunning && (wasRunning || engineChanged)) {
      if (engineChanged && wasRunning) {
        await this.stopEngine(oldEngine);
      }
      await this.restartService();
      restarted = true;
    }

    return { success: true, restarted, config: this.publicConfig() };
  }

  publicConfig() {
    return { ...this.config };
  }

  init() {
    this.startIdleMonitor();
    this.ensureWatchdogs();
    if (!this.config.enabled) {
      console.log('[ModelService] auto-start disabled (enabled=false)');
      return;
    }
    const target = this.getActiveEngine();
    const isTargetEnabled = this.isEngineEnabled(target);
    if (!isTargetEnabled) {
      console.log(`[ModelService] auto-start disabled for ${target} (${this.engineEnabledKey(target)}=false)`);
      return;
    }
    this.startService(target)
      .then((r) => {
        if (r && r.alreadyRunning) {
          console.log(`[ModelService] ${target} already running, reused`);
        } else if (r && r.accepted) {
          console.log(`[ModelService] ${target} auto-start issued`);
        } else {
          console.log(`[ModelService] auto-start skipped: ${r && r.reason}`);
        }
      })
      .catch((e) => console.error('[ModelService] auto-start failed:', e.message));
  }

  shutdownSync() {
    this.stopIdleMonitor();
    for (const engine of ALL_ENGINES) {
      const pid = this.readPid(engine);
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
      }
    }
  }

  shutdownForce() {
    for (const engine of ALL_ENGINES) {
      const pid = this.readPid(engine);
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
      }
      try { fs.unlinkSync(ENGINE_METADATA[engine].pidFile); } catch (e) { /* ignore */ }
      const bin = ENGINE_METADATA[engine]?.binaryBasename;
      if (!bin) continue;
      try {
        if (engine === 'maple-mlx') {
          // 进程名是 python3.12，不是 mlx_lm.server —— `pkill -x` 一定匹配不到。
          // 这里只按「命令行含 mlx_lm.server + 本引擎端口」精确兜底，
          // 绝不裸杀 python（会误伤用户自己的脚本）。
          const port = Number(this.config.maplePort) || 1242;
          execSync(`pkill -f "mlx_lm\\.server.*--port ${port}"`, { stdio: 'ignore' });
        } else {
          // 兜底双保险：若仍有同名孤儿进程残留，按二进制全名精确清理
          execSync(`pkill -x "${bin}"`, { stdio: 'ignore' });
        }
      } catch (e) {
        // ignore (pkill returns 1 when no matching processes exist)
      }
    }
  }

  tailLog(engine = this.getActiveEngine(), maxLines = 200) {
    if (typeof engine === 'number') {
      maxLines = engine;
      engine = this.getActiveEngine();
    }
    const meta = ENGINE_METADATA[engine] || this.getActiveMeta();
    const logFile = meta.logFile;
    try {
      const st = fs.statSync(logFile);
      if (!st.isFile()) return { found: false, lines: [] };
      const TAIL = 512 * 1024;
      const start = Math.max(0, st.size - TAIL);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logFile, 'r');
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
        const body = await readBody().catch(() => ({}));
        const engine = body.engine || urlObj.searchParams.get('engine') || this.getActiveEngine();
        const r = await this.startService(engine);
        sendJson(200, { ...r, status: await this.getStatus() });
        return;
      }

      if (pathname === '/stop' && req.method === 'POST') {
        const body = await readBody().catch(() => ({}));
        const engine = body.engine || urlObj.searchParams.get('engine') || this.getActiveEngine();
        const r = await this.stopService(engine);
        sendJson(200, { ...r, status: await this.getStatus() });
        return;
      }

      if (pathname === '/restart' && req.method === 'POST') {
        const body = await readBody().catch(() => ({}));
        const engine = body.engine || urlObj.searchParams.get('engine') || this.getActiveEngine();
        const r = await this.restartService(engine);
        sendJson(200, { ...r, status: await this.getStatus() });
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
        const engine = urlObj.searchParams.get('engine') || this.getActiveEngine();
        const maxLines = Math.min(Number(urlObj.searchParams.get('lines')) || 200, 1000);
        sendJson(200, this.tailLog(engine, maxLines));
        return;
      }

      // ---------------- Maple MLX 托管资源（运行时 / 权重） ----------------
      // 与其它受管服务一致：只暴露状态与动作，真正的下载逻辑在 maple_download.js。
      const mapleState = () => {
        const runtime = this.getMapleRuntimeInstaller();
        const model = this.getMapleModelDownloader();
        const { runtimeDir, modelDir } = this.mapleDirs();
        return {
          runtime: {
            ready: runtime.ready(),
            dir: runtimeDir,
            presentBytes: runtime.presentBytes(),
            totalBytes: runtime.state.totalBytes,
            state: runtime.status(),
          },
          model: {
            ready: model.ready(),
            dir: modelDir,
            presentBytes: model.presentBytes(),
            totalBytes: model.state.totalBytes,
            state: model.status(),
          },
        };
      };

      if (pathname === '/maple/state' && req.method === 'GET') {
        sendJson(200, mapleState());
        return;
      }

      if (pathname === '/maple/runtime/install' && req.method === 'POST') {
        const installer = this.getMapleRuntimeInstaller();
        if (!installer.state.active) {
          // 不阻塞请求：安装是分钟级任务，前端轮询 /maple/state
          Promise.resolve(installer.start()).catch((e) => console.error('[ModelService] maple runtime install:', e.message));
        }
        sendJson(200, mapleState());
        return;
      }

      if (pathname === '/maple/runtime/cancel' && req.method === 'POST') {
        this.getMapleRuntimeInstaller().cancel();
        sendJson(200, mapleState());
        return;
      }

      if (pathname === '/maple/download/start' && req.method === 'POST') {
        const dl = this.getMapleModelDownloader();
        if (!dl.state.active) {
          Promise.resolve(dl.start()).catch((e) => console.error('[ModelService] maple model download:', e.message));
        }
        sendJson(200, mapleState());
        return;
      }

      if (pathname === '/maple/download/cancel' && req.method === 'POST') {
        this.getMapleModelDownloader().cancel();
        sendJson(200, mapleState());
        return;
      }

      sendJson(404, { error: 'Unknown model endpoint' });
    } catch (err) {
      console.error('[ModelService] handleApi error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
}

export const ttfService = new TtfService();
