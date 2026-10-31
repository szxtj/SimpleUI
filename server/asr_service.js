// ASR（语音输入识别）服务托管模块 —— 双引擎可切换
//
// 职责：把「本地高精度语音识别」作为与基础模型服务、知识库服务并列的受管服务，
// 内置到 SimpleUI 的 Node 服务层：
//   - 纯按需待命模式（与 TTS、OCR、字幕服务保持完全统一的生命周期与四态逻辑）；
//   - 启动时不常驻占用 1236 端口与数 GB GPU 显存，保持天蓝色「待命」状态；
//   - 用户在全系统任意位置长按右侧 Command 键录音时，由 Node 侧透明现场拉起并转写；
//   - 闲置超时（默认 30 分钟）自动安全卸载进程并释放显存，重回「待命」状态。
//
// 两个引擎（config.engine）：
//   * 'qwen3'  —— Qwen3-ASR-0.6B-8bit (MLX / mlx-audio / 内置 Python)。**默认**。
//                 整段非流式：录音结束一次性转写（0.6B 的增量解码只在 vLLM 存在，macOS 没有）。
//   * 'r2t2'   —— Confucius4-R2T2 Q8_0 GGUF via audio.cpp，真流式、逐词上屏。
//                 与字幕服务共用同一份模型文件与原生推理内核。
//
// 二者对外是同一套 API（/live/* 会话 + /transcribe + 四态 status），所以 Swift 端与前端
// 都感知不到差异；只有「录音过程中有没有实时文字」不同 —— Qwen3 路径在 finish 之前不发 delta。
// 识别语言也各存一份：r2t2 用 config.language，qwen3 用 config.qwen3Language（默认 Auto = 中英混说）。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { startWatchdog } from './watchdog.js';
import { SUBTITLE_MODELS_DIR, subtitleService } from './subtitle_service.js';
import { Qwen3ModelDownloader, QWEN3_TOTAL_BYTES } from './asr_model_download.js';
import { formatBytes } from './format_bytes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();

// ----------------------------- 路径与常量 -----------------------------

const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'asr_config.json');
const MODELS_DIR = path.join(userConfigDir, 'models');
const SERVER_JSON_FILE = path.join(userConfigDir, 'asr_server.json');
const LOG_FILE = process.env.SIMPLEUI_ASR_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-asr.log');
// 两个引擎共用同一个 PID 文件：同一时刻只会有一个引擎在跑，切换 = 先停后起。
// （Swift 侧 ProcessManager 的退出清扫清单里已经列着它，所以不需要跟着改。）
const PID_FILE = '/tmp/simpleui_audiocpp.pid';

// 统一复用字幕服务的 Confucius4-R2T2 Q8_0 模型（~2.48 GB，约 2.31 GiB）
export const MODEL_FILENAME = 'r2t2-q8_0.gguf';
export const EXPECTED_MODEL_BYTES = 2477512064;
export const MIN_MODEL_BYTES = 2300 * 1024 * 1024;

// audiocpp 服务端里该模型的 id
export const SERVER_MODEL_ID = 'confucius_asr';
export const BINARY_BASENAME = 'audiocpp_server';

// Qwen3-ASR（MLX）引擎：模型目录 + Python 包装脚本。模型由面板下载、放这里。
export const QWEN3_MODEL_DIR = path.join(userConfigDir, 'models', 'asr', 'qwen3-asr-0.6b-8bit');
const QWEN3_SCRIPT = path.join(__dirname, 'asr', 'qwen3_asr_server.py');
// Python 包装脚本在 argv 里的可识别名（看门狗靠它做「命令行校验」防 PID 复用误杀）
const QWEN3_BIN_TAG = 'qwen3_asr_server.py';

export const ENGINE_QWEN3 = 'qwen3';
export const ENGINE_R2T2 = 'r2t2';
const ENGINES = [ENGINE_QWEN3, ENGINE_R2T2];

export const DEFAULT_ASR_CONFIG = {
  engine: ENGINE_QWEN3, // 默认走 Qwen3-ASR（中英混说更准、热态快）；r2t2 作为可选引擎保留
  port: 1236,
  backend: 'metal',
  threads: 4,
  // R2T2 的识别语言（audio.cpp 的 language 参数）
  language: 'Auto',
  // Qwen3-ASR 自己的识别语言，与上面互不影响。
  // 'Auto' = 中英混说（模型逐段自判语种，中文为基础、英文原词保留），这是它的推荐默认值。
  qwen3Language: 'Auto',
  idleUnloadMin: 30, // 默认闲置 30 分钟自动退出进程返回待命（与 OCR 服务保持一致）
  projectDir: path.join(userConfigDir, 'runtime', 'asr'),
  binaryPath: '',
  modelPath: path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
  qwen3ModelDir: QWEN3_MODEL_DIR,
};

// ----------------------------- 配置持久化 -----------------------------

function loadStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        if (data.modelPath && String(data.modelPath).toLowerCase().includes('sensevoice')) {
          data.modelPath = path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME);
        }
        return { ...DEFAULT_ASR_CONFIG, ...data };
      }
    }
  } catch (e) {
    // ignore
  }
  return { ...DEFAULT_ASR_CONFIG };
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function resolveDir(dir, fallback) {
  const expanded = expandHome(String(dir || '').trim() || fallback);
  try {
    if (fs.existsSync(expanded)) return fs.realpathSync(expanded);
  } catch (e) {
    // ignore
  }
  return expanded;
}

function bundledAsrRoot() {
  const candidates = [
    path.resolve(__dirname, '../asr'),
    '/Applications/SimpleUI.app/Contents/Resources/asr',
    path.resolve(__dirname, '../bin/audiocpp'),
    path.join(userConfigDir, 'runtime', 'asr'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function sanitizeConfig(partial) {
  const out = {};
  if (partial.enabled !== undefined) out.enabled = partial.enabled === true || partial.enabled === 'true';
  if (partial.engine !== undefined) {
    const engine = String(partial.engine).toLowerCase();
    if (ENGINES.includes(engine)) out.engine = engine;
  }
  if (partial.qwen3Language !== undefined) {
    const lang = String(partial.qwen3Language || '').trim();
    // 'Auto' = 中英混说（推荐默认）；其余按 Qwen3-ASR 的语种名原样透传
    if (lang && lang.length <= 32) out.qwen3Language = lang;
  }
  if (partial.qwen3ModelDir !== undefined) {
    const dir = String(partial.qwen3ModelDir || '').trim();
    if (dir) out.qwen3ModelDir = expandHome(dir);
  }
  if (partial.port !== undefined) {
    const port = Number(partial.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  }
  if (partial.backend !== undefined && ['cpu', 'metal', 'best'].includes(partial.backend)) {
    out.backend = partial.backend;
  }
  if (partial.idleUnloadMin !== undefined) {
    const m = Number(partial.idleUnloadMin);
    if (Number.isFinite(m) && m >= 0) out.idleUnloadMin = m;
  }
  return out;
}

/**
 * 把编译期/包内/工程内的 Python 解释器找出来。
 *
 * 只服务 Qwen3 引擎，所以刻意不去改 tts_service 里那份已有的解析逻辑 —— 朗读链路
 * 正在正常服役，把它的解析器抽出来共享只会带来无收益的回归面。顺序与它保持一致：
 * 显式环境变量 → 随包的 server/tts/python → 开发机的 bin/tts_runtime → 系统 python3。
 */
function resolvePython() {
  const candidates = [
    process.env.SIMPLEUI_ASR_PYTHON,
    path.join(__dirname, 'tts', 'python', 'bin', 'python3'),
    path.join(process.resourcesPath || '', 'tts', 'python', 'bin', 'python3'),
    path.resolve(__dirname, '..', 'bin', 'tts_runtime', 'python', 'bin', 'python3'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

// ----------------------------- 资源探测 -----------------------------

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

class AsrService {
  constructor() {
    this.config = loadStoredConfig();
    this.pendingOp = null; // 'start' | 'stop' | 'restart'
    this.lastActionLog = '';
    this.lastActionAt = 0;
    this.watchdog = null;
    this.child = null;
    this.logStream = null;
    this.childLogTail = [];
    this.idleTimer = null;
    this.lastUsedAt = 0;
    this.inFlight = 0;
    this.startingPromise = null;
    this.liveSessions = new Map();
    /** Qwen3-ASR 的模型下载器（目录随配置走，切换目录时重建） */
    this.qwen3Downloader = null;
    this.qwen3DownloaderDir = '';
  }

  // ----------------------------- 引擎 -----------------------------

  /**
   * 当前引擎 = 配置里选的引擎。
   *
   * 不做任何「另一个模型顶上」的自动切换：模型没就绪就是 incomplete，
   * 与 TTS / OCR / 字幕完全同一条规范（缺模型 → 面板提示下载）。
   */
  activeEngine() {
    return ENGINES.includes(this.config.engine) ? this.config.engine : ENGINE_QWEN3;
  }

  qwen3ModelDir() {
    return resolveDir(String(this.config.qwen3ModelDir || '').trim(), QWEN3_MODEL_DIR);
  }

  /** 懒建下载器；模型目录被改过就换一个新的（旧下载器的状态自然作废） */
  /**
   * 取 Qwen3 下载器（一个目录一个实例）。
   *
   * 目录被改过时，先把旧实例上正在跑的下载**停掉**再换新的：否则旧实例失去引用、
   * 却仍握着 socket 与写流继续下（既占带宽又没法取消），甚至会和新的写同一批文件。
   */
  qwen3Download() {
    const dir = this.qwen3ModelDir();
    if (this.qwen3Downloader && this.qwen3DownloaderDir !== dir) {
      try {
        this.qwen3Downloader.cancel();
      } catch {
        /* ignore */
      }
      this.qwen3Downloader = null;
    }
    if (!this.qwen3Downloader) {
      this.qwen3Downloader = new Qwen3ModelDownloader(dir);
      this.qwen3DownloaderDir = dir;
    }
    return this.qwen3Downloader;
  }

  /** Qwen3 模型是否就绪（目录里必需文件齐全且大小达标） */
  findQwen3Model() {
    const dir = this.qwen3ModelDir();
    try {
      return this.qwen3Download().ready() ? dir : null;
    } catch (e) {
      return null;
    }
  }

  /** Qwen3 引擎的运行时就绪信息：内置 Python + 包装脚本 */
  findQwen3Runtime() {
    const python = resolvePython();
    let scriptReady = false;
    try {
      scriptReady = fs.existsSync(QWEN3_SCRIPT) && fs.statSync(QWEN3_SCRIPT).isFile();
    } catch (e) {
      scriptReady = false;
    }
    return { python, script: QWEN3_SCRIPT, ready: Boolean(python) && scriptReady };
  }

  findBinary() {
    const candidates = [];
    const custom = expandHome(String(this.config.binaryPath || '').trim());
    if (custom) candidates.push(custom);
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(path.join(bundled, 'bin', BINARY_BASENAME));
    const projectDir = resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
    candidates.push(path.join(projectDir, 'build/bin', BINARY_BASENAME));
    candidates.push(path.join(projectDir, 'bin', BINARY_BASENAME));
    candidates.push('/opt/homebrew/bin/' + BINARY_BASENAME);
    candidates.push('/usr/local/bin/' + BINARY_BASENAME);
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  resolveRuntimeRoot() {
    const candidates = [];
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(bundled);
    candidates.push(resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir));
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      } catch (e) {
        // ignore
      }
    }
    return resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
  }

  findModel() {
    const explicit = expandHome(String(this.config.modelPath || '').trim());
    if (explicit && !explicit.toLowerCase().includes('sensevoice')) {
      try {
        if (fs.existsSync(explicit) && fs.statSync(explicit).isFile() && fs.statSync(explicit).size >= MIN_MODEL_BYTES) {
          return explicit;
        }
      } catch (e) {
        // ignore
      }
    }
    const searchDirs = [
      SUBTITLE_MODELS_DIR,
      MODELS_DIR,
      path.join(userConfigDir, 'models'),
    ];
    for (const dir of searchDirs) {
      try {
        const candidate = path.join(dir, MODEL_FILENAME);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && fs.statSync(candidate).size >= MIN_MODEL_BYTES) {
          return candidate;
        }
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  buildServerJson() {
    const modelPath = this.findModel();
    const rawLang = this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;
    const modelEntry = {
      id: SERVER_MODEL_ID,
      family: 'confucius4_r2t2',
      path: modelPath || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
      task: 'asr',
      mode: 'streaming',
      session_options: {
        'confucius4_r2t2.chunk_size_ms': '960',
        'confucius4_r2t2.unfixed_chunk_num': '1',
        'confucius4_r2t2.unfixed_token_num': '2',
        'confucius4_r2t2.rollback_punctuation': 'false',
        'confucius4_r2t2.max_tokens': '16',
      },
      default_request_options: {
        language: lang,
        max_tokens: 512,
      },
    };
    const serverJson = {
      host: '127.0.0.1',
      port: this.config.port || 1236,
      backend: this.config.backend || 'metal',
      device: 0,
      threads: this.config.threads || 4,
      lazy_load: false,
      max_loaded_models: 1,
      idle_unload_ms: 0,
      min_free_memory_mb: 0,
      busy_timeout_ms: 0,
      ui: false,
      live_ingest: { total_timeout_ms: 1800000, max_chunk_bytes: 8388608 },
      models: [modelEntry],
    };
    if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(SERVER_JSON_FILE, JSON.stringify(serverJson, null, 2));
    return { serverJsonFile: SERVER_JSON_FILE, modelPath: modelEntry.path };
  }

  checkHealth() {
    const port = this.config.port || 1236;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
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

  // 刷新闲置计时器，超时自动释放进程回到待命状态
  touch() {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = Number(this.config.idleUnloadMin ?? 30);
    if (minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const pid = readPid();
      if (!isPidAlive(pid)) return;
      if (this.inFlight > 0) {
        this.touch();
        return;
      }
      const idleMs = Date.now() - (this.lastUsedAt || 0);
      if (idleMs < minutes * 60_000) {
        this.touch();
        return;
      }
      console.log(`[AsrService] 语音输入服务闲置超过 ${minutes} 分钟，自动退出进程返回待命状态 (standby)`);
      this.stopService();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  // 统一的四态返回：模型就绪但进程未开启时返回 'standby'（待命）
  async getStatus() {
    const pid = readPid();
    const alive = isPidAlive(pid);
    const healthy = alive ? await this.checkHealth() : false;
    const engine = this.activeEngine();

    // 两个引擎各自探测一次：当前引擎决定 status，另一个只用于面板上的就绪点
    const r2t2Path = this.findModel();
    const r2t2Ready = Boolean(
      r2t2Path && fs.existsSync(r2t2Path) && fs.statSync(r2t2Path).size >= MIN_MODEL_BYTES
    );
    let r2t2Stat = null;
    if (r2t2Path && fs.existsSync(r2t2Path)) {
      try {
        r2t2Stat = fs.statSync(r2t2Path);
      } catch (e) {
        // ignore
      }
    }
    const qwen3Dir = this.qwen3ModelDir();
    const qwen3Ready = Boolean(this.findQwen3Model());
    const qwen3Bytes = this.qwen3Download().presentBytes();

    // 与其余服务同构：runtime 就是「跑这个模型的可执行程序」，模型就是权重
    const r2t2Binary = this.findBinary();
    const qwen3Runtime = this.findQwen3Runtime();
    const runtimeReady = engine === ENGINE_QWEN3 ? qwen3Runtime.ready : Boolean(r2t2Binary);
    const modelReady = engine === ENGINE_QWEN3 ? qwen3Ready : r2t2Ready;
    const binaryPath = engine === ENGINE_QWEN3 ? qwen3Runtime.python : r2t2Binary;
    const modelPath =
      engine === ENGINE_QWEN3
        ? qwen3Dir
        : r2t2Path || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME);

    let status = 'incomplete';
    if (!modelReady || !runtimeReady) {
      status = 'incomplete';
    } else if (this.pendingOp === 'start' || this.pendingOp === 'restart' || this.startingPromise) {
      status = 'loading';
    } else if (this.pendingOp === 'stop') {
      status = 'stopping';
    } else if (alive && healthy) {
      status = 'ready';
    } else if (alive && !healthy) {
      status = 'loading';
    } else {
      status = 'standby';
    }

    // 面板要显示的三个事实：多大、什么格式、是不是与字幕共用同一份权重。
    // 两个模型都是「用户下载」的（R2T2 那份就是字幕管线在用的同一个文件），
    // 没有任何一个随包分发 —— 文案由前端按这三个字段拼，不再按引擎猜。
    const model =
      engine === ENGINE_QWEN3
        ? {
            shortName: 'Qwen3-ASR 0.6B',
            ready: qwen3Ready,
            path: qwen3Dir,
            sizeBytes: qwen3Bytes,
            expectedBytes: QWEN3_TOTAL_BYTES,
            sizeMb: (qwen3Bytes / (1024 * 1024)).toFixed(1),
            sizeDesc: formatBytes(QWEN3_TOTAL_BYTES),
            format: 'MLX 8bit',
            sharedWithSubtitles: false,
            streaming: false,
          }
        : {
            shortName: 'Confucius4-R2T2 Q8_0',
            ready: r2t2Ready,
            path: r2t2Path || path.join(SUBTITLE_MODELS_DIR, MODEL_FILENAME),
            sizeBytes: r2t2Stat?.size || 0,
            expectedBytes: EXPECTED_MODEL_BYTES,
            sizeMb: r2t2Stat ? (r2t2Stat.size / (1024 * 1024)).toFixed(1) : '0',
            sizeDesc: formatBytes(EXPECTED_MODEL_BYTES),
            format: 'GGUF Q8_0',
            sharedWithSubtitles: true,
            streaming: true,
          };

    return {
      status,
      running: alive && healthy,
      ready: alive && healthy,
      modelsReady: modelReady,
      runtimeReady,
      engine,
      // 面板的两个选项只需要「这个引擎能不能切」+「它自己选的识别语言」
      engines: [
        { id: ENGINE_QWEN3, ready: qwen3Ready, language: this.config.qwen3Language || 'Auto' },
        { id: ENGINE_R2T2, ready: r2t2Ready, language: this.config.language || 'Auto' },
      ],
      pid: alive ? pid : null,
      port: this.config.port || 1236,
      backend: this.config.backend || 'metal',
      language: this.config.language || 'Auto',
      qwen3Language: this.config.qwen3Language || 'Auto',
      idleUnloadMin: this.config.idleUnloadMin ?? 30,
      projectDir: resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir),
      runtimeRoot: this.resolveRuntimeRoot(),
      bundled: !!bundledAsrRoot(),
      checks: { binary: runtimeReady, model: modelReady, binaryPath, modelPath },
      model,
      // 每个引擎只有一个下载器，status 就报当前引擎的那个，与 TTS/OCR 同构
      download: engine === ENGINE_QWEN3 ? this.qwen3Download().status() : subtitleService.downloadState,
      lastActionAt: this.lastActionAt || undefined,
      lastActionLog: this.lastActionLog || undefined,
    };
  }

  /**
   * 看门狗跟着「当前这次启动的引擎」重建。
   *
   * 同一个 PID 文件会承载两个不同的可执行程序（audiocpp_server / qwen3_asr_server.py），
   * 而看门狗的命令行校验只认创建时那个名字；Node 存活期间换过引擎 ⇒ 名字对不上 ⇒
   * 崩溃时它会把该清理的进程放走。所以每次启动前先结束旧看门狗，再按当前引擎名新建。
   */
  ensureWatchdog(engine = this.activeEngine()) {
    try {
      if (this.watchdog) {
        this.watchdog.kill('SIGKILL');
        this.watchdog = null;
      }
      this.watchdog = startWatchdog({
        pidFile: PID_FILE,
        binaryBasename: engine === ENGINE_QWEN3 ? QWEN3_BIN_TAG : BINARY_BASENAME,
      });
    } catch (e) {
      // ignore
    }
  }

  openLogStream() {
    if (this.logStream) return this.logStream;
    try {
      if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      this.logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    } catch (e) {
      this.logStream = null;
    }
    return this.logStream;
  }

  async startService() {
    const engine = this.activeEngine();

    // ---- 1) 运行时与模型就绪校验（两个引擎各查各的） ----
    let command = null;
    let args = null;
    let engineLabel = '';
    let modelDir = null;

    if (engine === ENGINE_QWEN3) {
      const rt = this.findQwen3Runtime();
      if (!rt.ready) {
        const why = !rt.python
          ? '未找到内置 Python 运行时（bin/tts_runtime 或包内 server/tts/python）'
          : `未找到 Qwen3-ASR 包装脚本 ${QWEN3_SCRIPT}`;
        this.lastActionLog = why;
        this.lastActionAt = Date.now();
        return { accepted: false, reason: !rt.python ? 'python_not_found' : 'script_not_found' };
      }
      modelDir = this.findQwen3Model();
      if (!modelDir) {
        this.lastActionLog = 'Qwen3-ASR 模型未就绪（请在服务管理面板中点击下载）';
        this.lastActionAt = Date.now();
        return { accepted: false, reason: 'model_not_found' };
      }
      command = rt.python;
      args = [QWEN3_SCRIPT, '--model-dir', modelDir, '--port', String(this.config.port || 1236)];
      engineLabel = 'Qwen3-ASR-0.6B-8bit (MLX)';
    } else {
      const binary = this.findBinary();
      if (!binary) {
        this.lastActionLog = `${BINARY_BASENAME} 未找到（请检查本地 audiocpp 构建产物）`;
        this.lastActionAt = Date.now();
        return { accepted: false, reason: 'binary_not_found' };
      }
      if (!this.findModel()) {
        this.lastActionLog = `Confucius4-R2T2 模型未就绪（请在服务管理面板中点击下载）`;
        this.lastActionAt = Date.now();
        return { accepted: false, reason: 'model_not_found' };
      }
      command = binary;
      engineLabel = 'Confucius4-R2T2 Q8_0 (audio.cpp)';
    }

    const alive = isPidAlive(readPid());
    if (alive && !this.pendingOp) {
      return { accepted: true, alreadyRunning: true };
    }

    this.pendingOp = 'start';
    this.lastActionAt = Date.now();

    if (engine === ENGINE_R2T2) {
      try {
        // 只有 audio.cpp 引擎需要 server.json；Qwen3 的参数全部走 argv
        this.buildServerJson();
        args = ['--config', SERVER_JSON_FILE];
      } catch (e) {
        this.pendingOp = null;
        this.lastActionLog = `生成 server.json 失败: ${e.message}`;
        return { accepted: false, reason: 'config_write_failed' };
      }
    }

    this.ensureWatchdog(engine);
    const log = this.openLogStream();

    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: userConfigDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      this.child = child;
      try {
        fs.writeFileSync(PID_FILE, String(child.pid));
      } catch (e) {
        // ignore
      }
      if (log) {
        log.write(`[${new Date().toISOString()}] start(${engine}): ${command} ${args.join(' ')}\n`);
      }
      this.childLogTail = [];
      const captureTail = (d) => {
        const text = String(d);
        if (log) log.write(d);
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          this.childLogTail.push(t);
          if (this.childLogTail.length > 12) this.childLogTail.shift();
        }
      };
      child.stdout.on('data', captureTail);
      child.stderr.on('data', captureTail);
      let exitedBadly = false;
      child.on('exit', (code, signal) => {
        if (log) log.write(`\n[${new Date().toISOString()}] ${engine} exited code=${code} signal=${signal}\n`);
        if (this.child === child) this.child = null;
        // 只清理「自己写的那条」PID 记录：启动失败（如端口被占）的子进程退出时若无条件
        // unlink，会把另一个活着的实例的 PID 文件删掉，服务就彻底失联（不会被空闲卸载、
        // 也不会被退出清扫），下次启动还会撞端口。
        try {
          if (readPid() === child.pid) fs.unlinkSync(PID_FILE);
        } catch (e) {
          /* ignore */
        }
        if (code !== null && code !== 0) {
          exitedBadly = true;
          this.lastActionLog = `${engineLabel} 异常退出 (code=${code})：\n${this.childLogTail.slice(-4).join('\n')}`;
          this.lastActionAt = Date.now();
        }
      });
      this.lastActionLog = `已拉起 ${engineLabel} (pid=${child.pid})`;

      // 等待健康探测通过。两个引擎的冷启动都在秒级（实测 Qwen3 ~1.3s、R2T2 ~6.5s，
      // 磁盘冷 / 机器忙时会更久）。这里沿用原来的 90s 余量 —— 调用方（语音输入）
      // 在等待期间持续把音频缓存着，所以「等」不会丢数据，而提前放弃才会。
      let healthy = false;
      const healthDeadline = Date.now() + 90000;
      while (Date.now() < healthDeadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await this.checkHealth()) {
          healthy = true;
          break;
        }
        if (!isPidAlive(readPid())) break;
      }
      this.pendingOp = null;
      if (healthy) {
        this.touch();
        return { accepted: true };
      }
      if (exitedBadly || !isPidAlive(readPid())) {
        return { accepted: false, reason: 'exited', error: this.lastActionLog };
      }
      return { accepted: false, reason: 'health_timeout' };
    } catch (e) {
      this.pendingOp = null;
      this.lastActionLog = `启动失败: ${e.message}`;
      return { accepted: false, reason: 'spawn_failed', error: e.message };
    }
  }

  // 按需唤醒入口：有录音请求来时若尚未拉起则现场拉起并重置闲置计时。
  // 并发调用（长按时的 /warmup 与 /live/start，或连点两次启动）共享同一次启动，
  // 绝不各自 spawn 一个进程 —— 后到的那个只会等同一个 Promise。
  async ensureRunning() {
    const engine = this.activeEngine();
    if (engine === ENGINE_QWEN3) {
      if (!this.findQwen3Runtime().ready) {
        return { ok: false, error: 'RUNTIME_MISSING' };
      }
      if (!this.findQwen3Model()) {
        return { ok: false, error: 'MODEL_MISSING' };
      }
    } else {
      if (!this.findBinary()) {
        return { ok: false, error: 'BINARY_MISSING' };
      }
      if (!this.findModel()) {
        return { ok: false, error: 'MODEL_MISSING' };
      }
    }
    const pid = readPid();
    if (isPidAlive(pid) && (await this.checkHealth())) {
      this.touch();
      return { ok: true, existing: true };
    }

    if (!this.startingPromise) {
      this.startingPromise = this.startService().finally(() => {
        this.startingPromise = null;
      });
    }
    const res = await this.startingPromise;
    if (res && res.accepted) {
      this.touch();
      return { ok: true, existing: false };
    }
    return { ok: false, error: res?.reason || 'SPAWN_FAILED', detail: this.lastActionLog };
  }

  async stopService() {
    this.pendingOp = 'stop';
    this.lastActionAt = Date.now();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const session of this.liveSessions.values()) {
      try { session.abort(); } catch {}
    }
    this.liveSessions.clear();
    try {
      const pid = readPid();
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
        for (let i = 0; i < 20 && isPidAlive(pid); i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (isPidAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
        }
      }
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    } finally {
      this.child = null;
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

  async applyConfig(partial, restartIfRunning) {
    const clean = sanitizeConfig(partial);
    if (Object.keys(clean).length === 0) {
      return { success: false, error: 'NO_VALID_FIELDS' };
    }
    const wasRunning = isPidAlive(readPid());
    // 换引擎 / 换模型目录：旧进程必须让位，否则它会继续占着端口用旧模型答话
    const engineChanged =
      (clean.engine !== undefined && clean.engine !== this.activeEngine()) ||
      (clean.qwen3ModelDir !== undefined && clean.qwen3ModelDir !== this.qwen3ModelDir());
    this.config = { ...this.config, ...clean };
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      return { success: false, error: e.message };
    }

    // 模型目录变了：立刻把旧目录上正在跑的下载停掉（不等下一次 status 轮询才发现）
    if (clean.qwen3ModelDir !== undefined) {
      try {
        this.qwen3Download();
      } catch {
        /* ignore */
      }
    }

    // 切引擎后回到待命：**不顺手把新引擎拉起来**，等长按右 ⌘ 时才按需加载。
    // 只改其它参数（如 idleUnloadMin）且进程在跑时，按原逻辑热重启。
    let restarted = false;
    let stopped = false;
    if (wasRunning && engineChanged) {
      await this.stopService();
      stopped = true;
      this.lastActionLog = `已切换识别引擎: ${this.activeEngine()}（回到待命）`;
      this.lastActionAt = Date.now();
    } else if (wasRunning && restartIfRunning) {
      await this.restartService();
      restarted = true;
    } else if (wasRunning) {
      this.touch();
    }
    return { success: true, restarted, stopped, config: this.publicConfig() };
  }

  publicConfig() {
    return { ...this.config };
  }

  // 统一按需待命：启动时不拉起模型与进程，由录音请求现场唤醒
  init() {
    const pid = readPid();
    if (!isPidAlive(pid)) {
      try { fs.unlinkSync(PID_FILE); } catch {}
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
    console.log('[AsrService] 语音输入识别服务已注册（按需待命模式：首句录音现场拉起，闲置超时自动卸载）');
  }

  shutdownSync() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
    }
  }

  shutdownForce() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pid = readPid();
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore */ }
    }
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    try { if (this.logStream) this.logStream.end(); } catch (e) { /* ignore */ }
  }

  tailLog(maxLines = 200) {
    try {
      const st = fs.statSync(LOG_FILE);
      if (!st.isFile()) return { found: false, lines: [] };
      const TAIL = 256 * 1024;
      const start = Math.max(0, st.size - TAIL);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(LOG_FILE, 'r');
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

  // ----------------------------- 转写与流式引擎 -----------------------------

  /**
   * 会话入口：按当前引擎分流。
   *
   * 两者的对外契约完全一致（write / finish / abort / broadcast / SSE 事件），
   * 区别只有「finish 之前会不会有 delta」：
   *   - r2t2：真流式，边录边出词；
   *   - qwen3：只累积 PCM，finish 时一次性整段转写，中途不发任何 delta。
   */
  createLiveSession(opts) {
    return this.activeEngine() === ENGINE_QWEN3
      ? this.createBufferedSession(opts)
      : this.createR2T2Session(opts);
  }

  /**
   * Qwen3-ASR 的「会话」——其实是个缓冲器。
   *
   * 为什么还要维持会话形状：Swift 侧的 LiveAsrSession 与 /api/asr/live/* 协议完全不变，
   * 这样切引擎只是服务端内部的事，原生端一行都不用改、也不需要重新编译验证。
   */
  createBufferedSession({ onDelta, onDone, onError }) {
    const session = {
      state: 'open', // 'open' | 'finishing' | 'done' | 'error'
      abandoned: false,
      finished: false,
      chunks: [],
      bytes: 0,
      sseClients: new Set(),
      onDelta,
      onDone,
      onError,
      text: '',
    };

    session.broadcast = (msg) => {
      const payload = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of session.sseClients) {
        try {
          client.write(payload);
        } catch {
          session.sseClients.delete(client);
        }
      }
    };

    // 只累积，不截断：录音长度由 Swift 侧决定，这里不做任何机械裁剪
    session.write = (pcm) => {
      if (session.abandoned || session.state !== 'open') return false;
      session.chunks.push(pcm);
      session.bytes += pcm.length;
      return true;
    };

    session.finish = () => {
      if (session.finished) return;
      session.finished = true;
      if (session.abandoned) return;
      session.state = 'finishing';

      const pcm = session.chunks.length ? Buffer.concat(session.chunks) : Buffer.alloc(0);
      session.chunks = [];

      this.postQwen3Transcribe(pcm)
        .then((result) => {
          if (session.abandoned) return;
          session.state = 'done';
          session.text = result.text || '';
          session.onDone?.(session.text, null);
          session.broadcast({ type: 'done', text: session.text });
        })
        .catch((err) => {
          if (session.abandoned) return;
          session.state = 'error';
          session.onError?.(err);
          session.broadcast({ type: 'error', error: err.message });
        });
    };

    session.abort = () => {
      session.abandoned = true;
      session.state = 'error';
      session.chunks = [];
    };

    return session;
  }

  /**
   * 调 Python 侧整段转写：PCM(s16le/16k/mono) 进，文本出。
   * 语言只用 Qwen3 自己的那份配置（qwen3Language，默认 Auto = 中英混说），
   * 不读 R2T2 的 language —— 两个模型的配置互不影响。
   */
  postQwen3Transcribe(pcm) {
    const port = this.config.port || 1236;
    const lang = String(this.config.qwen3Language || 'Auto');
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/transcribe?sample_rate=16000&language=${encodeURIComponent(lang)}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': pcm.length,
          },
          timeout: 180000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            let parsed = null;
            try {
              parsed = JSON.parse(body);
            } catch (e) {
              reject(new Error(`bad_upstream_json: ${body.slice(0, 120)}`));
              return;
            }
            if (res.statusCode !== 200 || !parsed?.ok) {
              reject(new Error(parsed?.error || `upstream_${res.statusCode}`));
              return;
            }
            resolve({ text: String(parsed.text || ''), language: parsed.language || '' });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('upstream_timeout')));
      req.on('error', reject);
      req.end(pcm);
    });
  }

  createR2T2Session({ language, onDelta, onDone, onError }) {
    const port = this.config.port || 1236;
    const rawLang = language || this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;

    const session = {
      state: 'open', // 'open' | 'rotating' | 'finishing' | 'done' | 'error'
      abandoned: false,
      committedText: '',
      subStreamText: '',
      subStreamBytes: 0,
      activeReq: null,
      rotateTimer: null,
      pendingChunks: [],
      finished: false,
      sseClients: new Set(),
      onDelta,
      onDone,
      onError,
    };

    // 辅助属性：session.text 返回当前完整累积文本 (committedText + subStreamText)
    Object.defineProperty(session, 'text', {
      get() {
        return session.committedText + session.subStreamText;
      },
      set(val) {
        session.committedText = String(val || '');
        session.subStreamText = '';
      },
      configurable: true,
      enumerable: true,
    });

    session.broadcast = (msg) => {
      const payload = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of session.sseClients) {
        try {
          client.write(payload);
        } catch {
          session.sseClients.delete(client);
        }
      }
    };

    const handleSubStreamDone = (finalText) => {
      if (session.rotateTimer) {
        clearTimeout(session.rotateTimer);
        session.rotateTimer = null;
      }
      const extra = extractFinalExtra(session.subStreamText, finalText);
      session.committedText += (session.subStreamText + extra);
      session.subStreamText = '';
      session.subStreamBytes = 0;
      session.activeReq = null;

      if (session.state === 'finishing') {
        if (session.pendingChunks.length > 0) {
          openSubStream();
          while (session.pendingChunks.length > 0) {
            const c = session.pendingChunks.shift();
            try {
              session.activeReq.write(c);
              session.subStreamBytes += c.length;
            } catch {}
          }
          try {
            session.activeReq.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
            session.activeReq.end();
          } catch {}
        } else {
          session.state = 'done';
          const fullText = session.text;
          session.onDone?.(fullText, null);
          session.broadcast({ type: 'done', text: fullText });
        }
      } else if (session.state === 'rotating') {
        session.state = 'open';
        openSubStream();
        while (session.pendingChunks.length > 0) {
          const c = session.pendingChunks.shift();
          try {
            session.activeReq.write(c);
            session.subStreamBytes += c.length;
          } catch {}
        }
      }
    };

    const openSubStream = () => {
      if (session.abandoned || session.state === 'done' || session.state === 'error') return;
      session.subStreamText = '';
      session.subStreamBytes = 0;
      let subStreamDone = false;

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/v1/audio/transcriptions/live?model=${SERVER_MODEL_ID}&sample_rate=16000&channels=1&sample_format=s16le&language=${lang}`,
          method: 'POST',
          headers: {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'application/octet-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            if (!session.abandoned && session.state !== 'done') {
              session.state = 'error';
              const err = new Error(`upstream_${res.statusCode}`);
              session.onError?.(err);
              session.broadcast({ type: 'error', error: err.message });
            }
            return;
          }
          let buf = '';
          res.on('data', (chunk) => {
            if (session.abandoned) return;
            buf += chunk.toString('utf-8');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const rawEvent = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of rawEvent.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;
                try {
                  const ev = JSON.parse(payload);
                  if (ev.type === 'transcript.text.delta' && typeof ev.delta === 'string') {
                    session.subStreamText += ev.delta;
                    const fullText = session.text;
                    session.onDelta?.(ev.delta, fullText);
                    session.broadcast({ type: 'delta', delta: ev.delta, text: fullText });
                  } else if (ev.type === 'transcript.text.done') {
                    if (!subStreamDone) {
                      subStreamDone = true;
                      handleSubStreamDone(typeof ev.text === 'string' ? ev.text : session.subStreamText);
                    }
                  }
                } catch {}
              }
            }
          });
          res.on('error', (err) => {
            if (!session.abandoned && session.state !== 'done') {
              session.state = 'error';
              session.onError?.(err);
              session.broadcast({ type: 'error', error: err.message });
            }
          });
          res.on('end', () => {
            if (session.abandoned) return;
            if (!subStreamDone && (session.state === 'rotating' || session.state === 'finishing')) {
              subStreamDone = true;
              handleSubStreamDone(session.subStreamText);
            }
          });
        }
      );

      session.activeReq = req;

      req.on('error', (err) => {
        if (!session.abandoned && session.state !== 'done') {
          session.state = 'error';
          session.onError?.(err);
          session.broadcast({ type: 'error', error: err.message });
        }
      });
    };

    const rotateSubStream = () => {
      if (session.state !== 'open' || !session.activeReq) return;
      session.state = 'rotating';
      const req = session.activeReq;
      try {
        req.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
        req.end();
      } catch {}

      session.rotateTimer = setTimeout(() => {
        if (session.state === 'rotating') {
          console.warn('[AsrService] ⚠️ sub-stream rotation timeout, forcing next session');
          try { req.destroy(); } catch {}
          handleSubStreamDone(session.subStreamText);
        }
      }, 4000);
      session.rotateTimer.unref?.();
    };

    session.write = (pcm) => {
      if (session.abandoned || session.state === 'done' || session.state === 'error') return false;
      if (session.state === 'rotating' || session.state === 'finishing') {
        session.pendingChunks.push(pcm);
        return true;
      }

      if (!session.activeReq) {
        openSubStream();
      }

      try {
        session.activeReq.write(pcm);
        session.subStreamBytes += pcm.length;

        // 核心防积压机制：
        // 1. 单条 live 流控制在 <= 9.6s（307,200 字节 = 10 个 960ms 分块）
        // 2. 若流持续 >= 5.0s（160,000 字节）且当前分块为停顿静音帧，顺势在停顿处轮转
        const isSilent = isChunkSilent(pcm);
        if (session.subStreamBytes >= 307200 || (session.subStreamBytes >= 160000 && isSilent)) {
          rotateSubStream();
        }
        return true;
      } catch {
        return false;
      }
    };

    session.finish = () => {
      if (session.finished || session.state === 'done') return;
      session.finished = true;
      if (session.state === 'rotating') {
        session.state = 'finishing';
        return;
      }
      session.state = 'finishing';
      if (session.activeReq) {
        try {
          session.activeReq.write(Buffer.alloc(Math.floor(16000 * 0.36) * 2));
          session.activeReq.end();
        } catch {}
      } else {
        session.state = 'done';
        const fullText = session.text;
        session.onDone?.(fullText, null);
        session.broadcast({ type: 'done', text: fullText });
      }
    };

    session.abort = () => {
      if (session.state === 'done') return;
      session.abandoned = true;
      session.state = 'error';
      if (session.rotateTimer) {
        clearTimeout(session.rotateTimer);
        session.rotateTimer = null;
      }
      session.pendingChunks = [];
      try {
        session.activeReq?.destroy();
      } catch {}
    };

    return session;
  }

  transcribe(audio, language) {
    const rawLang = language || this.config.language || 'Auto';
    const lang = String(rawLang).toLowerCase() === 'auto' ? 'Auto' : rawLang;
    const pcm = extractPcm(audio);

    return new Promise((resolve) => {
      let resolved = false;
      const doneCallback = (rawText) => {
        if (resolved) return;
        resolved = true;
        const text = stripLonePunctuation(String(rawText || '').trim());
        resolve({
          ok: true,
          text,
          language: lang,
          raw: String(rawText || '').trim(),
          droppedPunctuation: text === '' && String(rawText || '').trim() !== '',
        });
      };

      const errorCallback = (err) => {
        if (resolved) return;
        resolved = true;
        resolve({ ok: false, error: err.message || 'transcribe_failed' });
      };

      // Qwen3 走整段直连：不分块、不建会话，一次请求拿回全文
      if (this.activeEngine() === ENGINE_QWEN3) {
        this.postQwen3Transcribe(pcm)
          .then((r) => doneCallback(r.text))
          .catch(errorCallback);
        return;
      }

      const session = this.createLiveSession({
        language: lang,
        onDone: (finalText) => doneCallback(finalText),
        onError: (err) => errorCallback(err),
      });

      // 以 960ms 分块 (30720 字节) 喂入流式引擎，支持长音频自动轮转，彻底杜绝 GPU 队列积压与注意力跳字
      const CHUNK_SIZE = 30720;
      for (let offset = 0; offset < pcm.length; offset += CHUNK_SIZE) {
        session.write(pcm.slice(offset, offset + CHUNK_SIZE));
      }
      session.finish();

      setTimeout(() => {
        if (!resolved) {
          session.abort();
          errorCallback(new Error('upstream_timeout'));
        }
      }, 60000).unref?.();
    });
  }

  // ----------------------------- HTTP API -----------------------------

  async handleApi(req, res) {
    try {
      const host = req.headers.host || '127.0.0.1:31235';
      const urlObj = new URL(req.url, `http://${host}`);
      const pathname = urlObj.pathname.replace(/^\/api\/asr/, '');

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
      const readRawBody = () => new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

      if (pathname === '/status' && req.method === 'GET') {
        sendJson(200, await this.getStatus());
        return;
      }

      // 按需唤醒与预热接口：录音启动时后台静默触发，提前加载模型权重与 Metal 图
      if (pathname === '/warmup' && req.method === 'POST') {
        const r = await this.ensureRunning();
        sendJson(r.ok ? 200 : 503, r);
        return;
      }

      // 手动启动与语音输入的按需唤醒走同一条路（共享同一次 spawn），
      // 这样连点两次 /start、或 /start 与录音同时到达都不会拉起两个进程。
      if (pathname === '/start' && req.method === 'POST') {
        const r = await this.ensureRunning();
        sendJson(r.ok ? 200 : 503, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/stop' && req.method === 'POST') {
        const r = await this.stopService();
        sendJson(200, { ...r, status: (await this.getStatus()).status });
        return;
      }

      if (pathname === '/restart' && req.method === 'POST') {
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

      // 模型下载控制
      //   ?engine=qwen3 -> 走 Qwen3 自己的下载器（MLX 权重，放到 models/asr/ 下）
      //   其它/缺省     -> 走字幕服务那套 R2T2 GGUF 下载器（两个引擎共用同一份 GGUF）
      if (pathname === '/models/download' && req.method === 'POST') {
        const target = urlObj.searchParams.get('engine');
        if (target === ENGINE_QWEN3) {
          this.qwen3Download()
            .start()
            .catch((err) => console.error('[AsrService] qwen3 download error:', err.message));
          sendJson(200, { ok: true, downloadState: this.qwen3Download().status() });
          return;
        }
        subtitleService.startDownload('asr').catch((err) => {
          console.error('[AsrService] start download error:', err.message);
        });
        sendJson(200, { ok: true, downloadState: subtitleService.downloadState });
        return;
      }

      if (pathname === '/models/cancel-download' && req.method === 'POST') {
        const target = urlObj.searchParams.get('engine');
        if (target === ENGINE_QWEN3) {
          sendJson(200, { ok: true, downloadState: this.qwen3Download().cancel() });
          return;
        }
        sendJson(200, { ok: true, downloadState: subtitleService.cancelDownload() });
        return;
      }

      if (pathname === '/open-dir' && req.method === 'POST') {
        try {
          const dir =
            this.activeEngine() === ENGINE_QWEN3 ? this.qwen3ModelDir() : SUBTITLE_MODELS_DIR;
          fs.mkdirSync(dir, { recursive: true });
          spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
          sendJson(200, { ok: true, path: dir });
        } catch (e) {
          sendJson(500, { ok: false, error: e.message });
        }
        return;
      }

      // 流式会话管理接口
      if (pathname === '/live/start' && req.method === 'POST') {
        const startRes = await this.ensureRunning();
        if (!startRes.ok) {
          sendJson(503, { ok: false, error: 'service_not_ready', detail: startRes.detail || startRes.error });
          return;
        }
        const lang = urlObj.searchParams.get('language') || this.config.language || 'Auto';
        const sid = 'live_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        this.inFlight++;
        const session = this.createLiveSession({
          language: lang,
          onDone: () => {
            this.touch();
          },
        });
        session.createdAt = Date.now();
        this.liveSessions.set(sid, session);
        this.touch();
        sendJson(200, { ok: true, sessionId: sid });
        return;
      }

      if (pathname === '/live/events' && req.method === 'GET') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        if (session.text) {
          res.write(`data: ${JSON.stringify({ type: 'delta', delta: '', text: session.text })}\n\n`);
        }
        if (session.state === 'done') {
          res.write(`data: ${JSON.stringify({ type: 'done', text: session.text })}\n\n`);
          res.end();
          return;
        }
        session.sseClients.add(res);
        req.on('close', () => {
          session.sseClients.delete(res);
        });
        return;
      }

      if (pathname === '/live/chunk' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        const chunk = await readRawBody();
        session.write(chunk);
        this.touch();
        sendJson(200, { ok: true, received: chunk.length });
        return;
      }

      if (pathname === '/live/finish' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (!session) {
          sendJson(404, { ok: false, error: 'session_not_found' });
          return;
        }
        this.touch();

        if (session.state === 'done') {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.liveSessions.delete(sid);
          const raw = (session.text || '').trim();
          const text = stripLonePunctuation(raw);
          sendJson(200, {
            ok: true,
            text,
            raw,
            droppedPunctuation: text === '' && raw !== '',
          });
          return;
        }

        let finished = false;
        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            const raw = (session.text || '').trim();
            const text = stripLonePunctuation(raw);
            sendJson(200, {
              ok: true,
              text,
              raw,
              droppedPunctuation: text === '' && raw !== '',
            });
          }
        }, 60000);
        timer.unref?.();

        const origDone = session.onDone;
        session.onDone = (finalText, timing) => {
          origDone?.(finalText, timing);
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            const raw = (typeof finalText === 'string' ? finalText : session.text).trim();
            const text = stripLonePunctuation(raw);
            sendJson(200, {
              ok: true,
              text,
              raw,
              droppedPunctuation: text === '' && raw !== '',
            });
          }
        };

        const origError = session.onError;
        session.onError = (err) => {
          origError?.(err);
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            this.inFlight = Math.max(0, this.inFlight - 1);
            this.liveSessions.delete(sid);
            sendJson(502, { ok: false, error: err.message || 'live_error' });
          }
        };

        session.finish();
        return;
      }

      if (pathname === '/live/abort' && req.method === 'POST') {
        const sid = urlObj.searchParams.get('sessionId');
        const session = this.liveSessions.get(sid);
        if (session) {
          session.abort();
          this.liveSessions.delete(sid);
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
        sendJson(200, { ok: true });
        return;
      }

      // 语音转写：现场按需拉起进程（若在待命中），转写完成后刷新闲置计时
      if (pathname === '/transcribe' && req.method === 'POST') {
        const audio = await readRawBody();
        if (!audio || audio.length < 256) {
          sendJson(400, { ok: false, error: 'empty_audio' });
          return;
        }
        const startRes = await this.ensureRunning();
        if (!startRes.ok) {
          sendJson(503, { ok: false, error: 'service_not_ready', detail: startRes.detail || startRes.error });
          return;
        }
        const lang = urlObj.searchParams.get('language') || undefined;
        this.inFlight++;
        try {
          const result = await this.transcribe(audio, lang);
          this.touch();
          sendJson(result.ok ? 200 : 502, result);
        } finally {
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
        return;
      }

      sendJson(404, { error: 'Unknown asr endpoint' });
    } catch (err) {
      console.error('[AsrService] handleApi error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
}

// ----------------------------- 工具函数 -----------------------------

function extractFinalExtra(streamText, finalText) {
  const final = String(finalText || '');
  if (!final) return '';
  if (final.startsWith(streamText)) {
    return final.slice(streamText.length);
  }
  let common = 0;
  const maxLen = Math.min(streamText.length, final.length);
  while (common < maxLen && streamText[common] === final[common]) {
    common += 1;
  }
  if (common >= streamText.length - 3) {
    return final.slice(streamText.length);
  }
  return '';
}

function isChunkSilent(pcmBuffer, threshold = 180) {
  const sampleCount = pcmBuffer.length >> 1;
  if (sampleCount === 0) return true;
  const step = sampleCount > 512 ? 4 : 1;
  for (let i = 0; i < sampleCount; i += step) {
    const val = pcmBuffer.readInt16LE(i << 1);
    if (val >= threshold || val <= -threshold) return false;
  }
  return true;
}

const PUNCTUATION_ONLY_RE =
  /^[\s,，.．。、!！?？;；:：…‥·•—–\-_~～'"“”‘’`()（）\[\]【】{}｛｝<>＜＞《》〈〉«»\/\\|｜+＋*＊=＝#＃@＆&^%％$＄￥€£]+$/u;

function stripLonePunctuation(text) {
  if (!text) return '';
  return PUNCTUATION_ONLY_RE.test(text) ? '' : text;
}

function extractPcm(buffer) {
  if (!buffer || buffer.length < 44) return buffer;
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WAVE') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return buffer.slice(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize;
    }
    return buffer.slice(44);
  }
  return buffer;
}

export const asrService = new AsrService();
