// ASR（语音识别）服务托管模块 —— SenseVoice-Small (GGUF) via audio.cpp
//
// 职责：把「本地语音识别」作为与基础模型服务、知识库服务并列的第三个受管服务，
// 内置到 SimpleUI 的 Node 服务层：
//   - 随 SimpleUI 启动自动拉起 audiocpp_server（enabled 开关，默认开启）；
//   - SimpleUI 退出时一并终止（与 kiwix / TTF 行为对齐）；
//   - 配置持久化在 SimpleUI 自己的 asr_config.json，运行时据此生成 audiocpp 的
//     server.json（含 sense_asr 的 default_request_options）。
//
// 模型与运行时（严格按官方说明）：
//   - 模型：FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp 的 Q8_0 GGUF
//           sensevoice-small-q8-audiocpp-v1.gguf（~254MB）
//   - 运行时：audio.cpp 的 audiocpp_server（`--config server.json`）
//   - 请求选项（sense_asr）：language(auto|zh|en|yue|ja|ko|...) / enable_itn /
//     keep_tags / audio_chunk_mode(auto|fixed|none) / audio_chunk_duration_sec
//     经 server.json 的 default_request_options 下发（服务端契约只对
//     /v1/audio/transcriptions 暴露 model/file/language/prompt/busy_timeout_ms，
//     ITN 与分块策略属模型请求选项，必须走 default_request_options）。
//   - 转写端点：POST /v1/audio/transcriptions（OpenAI 兼容 multipart）。
//
// 中英语音场景：language=auto 由模型自行做语种判定（LID），中英混说最稳；
// 纯中文/纯英文可显式指定以获得更稳定的语种标签；enable_itn=true 输出带标点。
//
// 退出兜底：与 ttf_service 同款 detached watchdog——Node 意外死亡（含 SIGKILL）时
// 由 watchdog 兜底终止 audiocpp_server；正常退出走 proxy 的 cleanupAndExit 钩子。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();

// ----------------------------- 路径与常量 -----------------------------

const userConfigDir = path.join(HOME, 'Library', 'Application Support', 'SimpleUI');
const CONFIG_FILE = path.join(userConfigDir, 'asr_config.json');
const MODELS_DIR = path.join(userConfigDir, 'models');
// 运行时生成的 audiocpp 服务端配置（每次启动/改配置都重写，是派生文件不是用户配置）
const SERVER_JSON_FILE = path.join(userConfigDir, 'asr_server.json');
const LOG_FILE = process.env.SIMPLEUI_ASR_LOG || path.join(HOME, 'Library', 'Logs', 'simpleui-asr.log');
const PID_FILE = '/tmp/simpleui_audiocpp.pid';

// 官方推荐的独立 Q8 GGUF 包（见 HuggingFace 模型卡与 audio.cpp 文档）
const MODEL_FILENAME = 'sensevoice-small-q8-audiocpp-v1.gguf';
const MODEL_DOWNLOAD_URL =
  'https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/' + MODEL_FILENAME;
// 国内镜像（huggingface.co 在大陆常不可达；auto 模式下官方源失败会自动回退到这里）
const MODEL_MIRROR_URL =
  'https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/' + MODEL_FILENAME;

// audiocpp 服务端里该模型的 id（客户端在 /v1/audio/transcriptions 里引用）
const SERVER_MODEL_ID = 'sense_asr';
const BINARY_BASENAME = 'audiocpp_server';

export const DEFAULT_ASR_CONFIG = {
  // 随 SimpleUI 自动启动语音识别服务
  enabled: true,
  // audiocpp_server 监听端口（1236 —— 旧 LAYA 门禁退役后空出）
  port: 1236,
  // 推理后端：Apple Silicon 默认走 Metal（原生 GPU 加速，比 CPU 更快更省电）；
  // cpu 仅作兜底（Metal 不可用时回退）；best = 引擎自动选最优（本机即 Metal）
  backend: 'metal',
  threads: 4,
  // ---- SenseVoice 请求选项（参考官方说明，默认面向中英场景）----
  // auto 由模型做语种判定，中英混说最稳；也可显式 zh / en
  language: 'auto',
  // 逆文本归一化：开 = 输出带标点与规范数字
  enableItn: true,
  // 分块策略：none = 整段一次编码（短语音最准）；auto = 内置 silero VAD 切分长音频
  audioChunkMode: 'none',
  audioChunkDurationSec: 30,
  // 是否在转写结果里保留 <|event|>/<|emotion|>/<|language|> 元标签（默认关）
  keepTags: false,
  // 模型下载源：auto = 官方源失败自动回退国内镜像
  downloadSource: 'auto',
  // ---- 本体与模型位置 ----
  projectDir: path.join(HOME, 'audio.cpp'),
  // 留空则自动探测（见 findBinary）
  binaryPath: '',
  modelPath: path.join(MODELS_DIR, MODEL_FILENAME),
};

// 合法取值域（与 audio.cpp / sense_asr 支持的取值一致，用于校验前端提交）
const ENUMS = {
  backend: ['cpu', 'metal', 'best'],
  // 仅列出模型的「原生语种标签」——其余标签会回退到 auto，故不暴露
  language: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
  audioChunkMode: ['none', 'auto', 'fixed'],
  downloadSource: ['auto', 'huggingface', 'mirror'],
};

// ----------------------------- 配置持久化 -----------------------------

function loadStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        return { ...DEFAULT_ASR_CONFIG, ...data };
      }
    }
  } catch (e) {
    // 配置损坏时回退默认值，不阻断服务
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

// sense_asr 内置 silero VAD 的默认**相对**路径。
// 它同时是「运行时根目录」的判定依据：该目录下存在它，就说明这棵目录能当 audiocpp 的 cwd。
const VAD_RELATIVE_PATH = 'assets/framework/models/silero_vad';

/**
 * 打包态资源根目录（随 App 分发的 audiocpp 运行时）。
 * build_mac_app.sh 会把项目里的 bin/audiocpp 拷到 Contents/Resources/asr，
 * 因此打包后结构为 Resources/asr/{bin/audiocpp_server, assets/..., models/}。
 */
function bundledAsrRoot() {
  const candidates = [
    path.resolve(__dirname, '../asr'), // 打包态：Resources/server → Resources/asr
    '/Applications/SimpleUI.app/Contents/Resources/asr',
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
  if (partial.projectDir !== undefined) {
    const dir = String(partial.projectDir || '').trim();
    if (dir) out.projectDir = dir; // 存原始输入，使用时再解析
  }
  if (partial.binaryPath !== undefined) out.binaryPath = String(partial.binaryPath || '').trim();
  if (partial.modelPath !== undefined) out.modelPath = String(partial.modelPath || '').trim();
  if (partial.port !== undefined) {
    const port = Number(partial.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  }
  if (partial.threads !== undefined) {
    const t = Number(partial.threads);
    if (Number.isInteger(t) && t >= 1 && t <= 64) out.threads = t;
  }
  if (partial.audioChunkDurationSec !== undefined) {
    const v = Number(partial.audioChunkDurationSec);
    if (Number.isFinite(v) && v >= 1 && v <= 300) out.audioChunkDurationSec = v;
  }
  for (const key of ['backend', 'language', 'audioChunkMode', 'downloadSource']) {
    if (partial[key] !== undefined && ENUMS[key].includes(partial[key])) out[key] = partial[key];
  }
  if (partial.enableItn !== undefined) out.enableItn = partial.enableItn === true || partial.enableItn === 'true';
  if (partial.keepTags !== undefined) out.keepTags = partial.keepTags === true || partial.keepTags === 'true';
  return out;
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
    this.pendingOp = null; // 'start' | 'stop' | 'restart'，供状态聚合区分过渡态
    this.lastActionLog = '';
    this.lastActionAt = 0;
    this.watchdog = null;
    this.child = null; // 当前托管的 audiocpp_server 进程
    this.logStream = null;
    // 子进程最近输出（环形缓冲）：进程异常退出时把真实原因带进 lastActionLog，
    // 让设置卡片能直接显示「GGUF 读取失败」这类信息，而不只是「服务未就绪」
    this.childLogTail = [];
    // 模型下载状态（/download-model 异步进行，进度经 /status 暴露）
    this.download = { active: false, received: 0, total: 0, error: null };
  }

  // audiocpp_server 可执行文件：优先用户指定，其次**随 App 分发的运行时**，
  // 再退到本体构建产物与常见安装路径（release 用户因此无需自建 audio.cpp）
  findBinary() {
    const candidates = [];
    const custom = expandHome(String(this.config.binaryPath || '').trim());
    if (custom) candidates.push(custom);
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(path.join(bundled, 'bin', BINARY_BASENAME));
    const projectDir = resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
    candidates.push(path.join(projectDir, 'build/bin', BINARY_BASENAME));
    candidates.push(path.join(projectDir, 'build/sense/bin', BINARY_BASENAME));
    candidates.push(path.join(projectDir, 'build/release/bin', BINARY_BASENAME));
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

  /**
   * 运行时根目录 —— audiocpp 进程的 cwd，也是它解析相对资源路径（内置 silero VAD）的基准。
   * 优先随包目录，其次本体目录；以「该目录下确实存在 VAD」为准，避免选到没有资源的目录。
   */
  resolveRuntimeRoot() {
    const candidates = [];
    const bundled = bundledAsrRoot();
    if (bundled) candidates.push(bundled);
    candidates.push(resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir));
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, VAD_RELATIVE_PATH))) return dir;
      } catch (e) {
        // ignore
      }
    }
    // 都不含资源时退回本体目录（保持既有行为，错误交由服务自身报出）
    return resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
  }

  // SenseVoice GGUF：优先用户指定，其次随包 models/，再退到 App 的 models/ 与本体 models/
  findModel() {
    const explicit = expandHome(String(this.config.modelPath || '').trim());
    if (explicit) {
      try {
        if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;
      } catch (e) {
        // ignore
      }
    }
    const projectDir = resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir);
    const searchDirs = [];
    const bundled = bundledAsrRoot();
    if (bundled) searchDirs.push(path.join(bundled, 'models'));
    searchDirs.push(MODELS_DIR, path.join(projectDir, 'models'));
    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const hit = findGgufRecursive(dir, 3);
        if (hit) return hit;
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  // 生成 audiocpp 的 server.json（派生文件）：把配置映射为模型请求选项
  buildServerJson() {
    const modelPath = this.findModel();
    const modelEntry = {
      id: SERVER_MODEL_ID,
      family: 'sense_asr',
      path: modelPath || this.config.modelPath,
      task: 'asr',
      // offline 已足够：一次性转写一段录音；live 端点不参与本链路
      mode: 'offline',
      // 关键：服务端契约只对 /v1/audio/transcriptions 暴露 language，
      // ITN / 分块策略必须经 default_request_options 下发
      default_request_options: {
        language: this.config.language,
        enable_itn: this.config.enableItn,
        keep_tags: this.config.keepTags,
        audio_chunk_mode: this.config.audioChunkMode,
        audio_chunk_duration_sec: this.config.audioChunkDurationSec,
      },
    };
    const serverJson = {
      host: '127.0.0.1',
      port: this.config.port,
      backend: this.config.backend,
      device: 0,
      threads: this.config.threads,
      // 单模型常驻即可，首次请求时加载（约 280MB，加载 <1s）
      lazy_load: true,
      max_loaded_models: 1,
      ui: false,
      models: [modelEntry],
    };
    if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(SERVER_JSON_FILE, JSON.stringify(serverJson, null, 2));
    return { serverJsonFile: SERVER_JSON_FILE, modelPath: modelEntry.path };
  }

  checkHealth() {
    const port = this.config.port;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
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

    const binaryPath = this.findBinary();
    const modelPath = this.findModel();

    return {
      enabled: this.config.enabled,
      status,
      pid: alive ? pid : null,
      port: this.config.port,
      backend: this.config.backend,
      language: this.config.language,
      projectDir: resolveDir(this.config.projectDir, DEFAULT_ASR_CONFIG.projectDir),
      // audiocpp 实际使用的运行时根目录（打包态为 App 内 Resources/asr）
      runtimeRoot: this.resolveRuntimeRoot(),
      bundled: !!bundledAsrRoot(),
      checks: {
        binary: !!binaryPath,
        model: !!modelPath,
        binaryPath,
        modelPath,
      },
      download: this.download,
      lastActionAt: this.lastActionAt || undefined,
      lastActionLog: this.lastActionLog || undefined,
    };
  }

  // 兜底守护：监视本 Node 进程，Node 死亡（含 SIGKILL）后终止 audiocpp_server
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

  openLogStream() {
    if (this.logStream) return this.logStream;
    try {
      if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      // 每次启动截断重写，tail 窗口即覆盖本次生命周期
      this.logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    } catch (e) {
      this.logStream = null;
    }
    return this.logStream;
  }

  async startService() {
    if (!this.config.enabled) {
      return { accepted: false, reason: 'disabled' };
    }
    const binary = this.findBinary();
    if (!binary) {
      this.lastActionLog = `${BINARY_BASENAME} 未找到（请在设置中填写 audio.cpp 构建产物路径）`;
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'binary_not_found' };
    }
    const model = this.findModel();
    if (!model) {
      this.lastActionLog = `SenseVoice GGUF 模型未找到（可点击「下载模型」或手动放置到 ${MODELS_DIR}）`;
      this.lastActionAt = Date.now();
      return { accepted: false, reason: 'model_not_found' };
    }
    const alive = isPidAlive(readPid());
    if (alive && !this.pendingOp) {
      return { accepted: true, alreadyRunning: true };
    }

    this.pendingOp = 'start';
    this.lastActionAt = Date.now();

    let serverJsonFile;
    try {
      serverJsonFile = this.buildServerJson().serverJsonFile;
    } catch (e) {
      this.pendingOp = null;
      this.lastActionLog = `生成 server.json 失败: ${e.message}`;
      return { accepted: false, reason: 'config_write_failed' };
    }

    this.ensureWatchdog();
    const log = this.openLogStream();

    try {
      const child = spawn(binary, ['--config', serverJsonFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 必须以「运行时根目录」为工作目录：sense_asr 内置 silero VAD 的默认路径是**相对路径**
        // （assets/framework/models/silero_vad）。打包态取随包目录，开发态取本体目录；
        // 否则 audio_chunk_mode=auto/fixed 会直接报 "Silero VAD model path does not exist"。
        cwd: this.resolveRuntimeRoot(),
        env: { ...process.env },
      });
      this.child = child;
      try {
        fs.writeFileSync(PID_FILE, String(child.pid));
      } catch (e) {
        // ignore
      }
      if (log) {
        log.write(`[${new Date().toISOString()}] start: ${binary} --config ${serverJsonFile}\n`);
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
        if (log) log.write(`\n[${new Date().toISOString()}] audiocpp_server exited code=${code} signal=${signal}\n`);
        if (this.child === child) this.child = null;
        try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
        if (code !== null && code !== 0) {
          exitedBadly = true;
          this.lastActionLog = `audiocpp_server 异常退出 (code=${code})：\n${this.childLogTail.slice(-4).join('\n')}`;
          this.lastActionAt = Date.now();
        }
      });
      this.lastActionLog = `已拉起 audiocpp_server (pid=${child.pid}) · ${this.config.backend} · ${this.config.language}`;

      // 等待健康探测通过（首次加载模型通常 <2s），最多 ~12s
      let healthy = false;
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.checkHealth()) {
          healthy = true;
          break;
        }
        if (!isPidAlive(readPid())) break;
      }
      this.pendingOp = null;
      if (healthy) return { accepted: true };
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

  async stopService() {
    this.pendingOp = 'stop';
    this.lastActionAt = Date.now();
    try {
      const pid = readPid();
      if (isPidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ignore */ }
        for (let i = 0; i < 20 && isPidAlive(pid); i++) {
          await new Promise((r) => setTimeout(r, 250));
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
    this.config = { ...this.config, ...clean };
    try {
      if (!fs.existsSync(userConfigDir)) fs.mkdirSync(userConfigDir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      return { success: false, error: e.message };
    }

    let restarted = false;
    if (restartIfRunning && wasRunning) {
      await this.restartService();
      restarted = true;
    }
    return { success: true, restarted, config: this.publicConfig() };
  }

  publicConfig() {
    return { ...this.config };
  }

  // 随 SimpleUI 启动自动拉起（enabled 开关控制；失败不阻断主服务）
  init() {
    if (!this.config.enabled) {
      console.log('[AsrService] auto-start disabled (enabled=false)');
      return;
    }
    this.startService()
      .then((r) => {
        if (r && r.alreadyRunning) {
          console.log('[AsrService] service already running, reused');
        } else if (r && r.accepted) {
          console.log('[AsrService] service auto-start issued');
        } else {
          console.log(`[AsrService] auto-start skipped: ${r && r.reason}`);
        }
      })
      .catch((e) => console.error('[AsrService] auto-start failed:', e.message));
  }

  shutdownSync() {
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

  // ----------------------------- 转写 -----------------------------

  /**
   * 把原始音频字节转写为文本。
   * 由 Node 侧构造 audiocpp 需要的 multipart 请求（客户端只需 POST 裸音频），
   * 这样 Swift 端与浏览器端都能用同一入口，不必各自拼 multipart。
   *
   * @param {Buffer} audio   音频字节（WAV；audio.cpp 内部转 16kHz 单声道）
   * @param {string} [language] 单次覆盖语言（缺省用配置）
   */
  transcribe(audio, language) {
    const port = this.config.port;
    const boundary = '----SimpleUIAsrBoundary' + Date.now().toString(36);
    const lang = ENUMS.language.includes(language) ? language : this.config.language;

    const CRLF = '\r\n';
    const parts = [];
    const field = (name, value) =>
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
        'utf-8'
      );

    parts.push(field('model', SERVER_MODEL_ID));
    parts.push(field('language', lang));
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.wav"${CRLF}` +
            `Content-Type: audio/wav${CRLF}${CRLF}`,
          'utf-8'
        ),
        audio,
        Buffer.from(CRLF, 'utf-8'),
      ])
    );
    parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf-8'));
    const body = Buffer.concat(parts);

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 60000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              resolve({ ok: false, error: `upstream_${res.statusCode}`, detail: data.slice(0, 500) });
              return;
            }
            try {
              const j = JSON.parse(data);
              const raw = String(j.text ?? j.transcript ?? '').trim();
              resolve({
                ok: true,
                text: this.config.keepTags ? raw : stripMetaTags(raw),
                language: j.language || lang,
                raw,
              });
            } catch (e) {
              // 非 JSON：有些实现直接回纯文本
              resolve({ ok: true, text: stripMetaTags(data.trim()), language: lang, raw: data.trim() });
            }
          });
        }
      );
      req.on('error', (e) => resolve({ ok: false, error: 'upstream_unavailable', detail: e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'upstream_timeout' });
      });
      req.write(body);
      req.end();
    });
  }

  // ----------------------------- 模型下载 -----------------------------

  /**
   * 异步下载官方 GGUF（约 254MB）到 App 的 models 目录。
   * 立即返回；进度经 /status 的 download 字段暴露（写 .part 后原子改名）。
   *
   * 下载源：默认 auto —— 先试 HuggingFace 官方源，失败自动回退到 hf-mirror 镜像
   * （huggingface.co 在中国大陆常不可达，镜像是刚需）。也可在设置里强制指定其一。
   */
  startModelDownload() {
    if (this.download.active) return { started: false, reason: 'already_downloading' };
    const dest = path.join(MODELS_DIR, MODEL_FILENAME);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024 * 1024) {
        return { started: false, reason: 'already_present', path: dest };
      }
      if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
    } catch (e) {
      return { started: false, reason: 'mkdir_failed', error: e.message };
    }

    const partFile = dest + '.part';
    this.download = { active: true, received: 0, total: 0, error: null, source: null, host: null };

    const sources =
      this.config.downloadSource === 'huggingface'
        ? [MODEL_DOWNLOAD_URL]
        : this.config.downloadSource === 'mirror'
        ? [MODEL_MIRROR_URL]
        : [MODEL_DOWNLOAD_URL, MODEL_MIRROR_URL];

    // 来源标签只取决于「本次尝试选的是哪个源」，不随 302 跳转改变
    // （跳转后 url 变成 CDN 地址，若按 url 判定会把 mirror 误标成 huggingface）
    const sourceLabel = (u) => (u === MODEL_MIRROR_URL ? 'mirror' : 'huggingface');

    let sourceIndex = 0;

    // 单个源失败时自动切到下一个；全部用尽才落错误
    const fail = (reason) => {
      sourceIndex += 1;
      try { fs.unlinkSync(partFile); } catch (e) { /* ignore */ }
      if (sourceIndex < sources.length) {
        this.download = { active: true, received: 0, total: 0, error: null, source: null, host: null };
        follow(sources[sourceIndex], sourceLabel(sources[sourceIndex]));
        return;
      }
      this.download = { ...this.download, active: false, error: reason };
    };

    const follow = (url, label, redirects = 0) => {
      if (redirects > 6) {
        fail('too_many_redirects');
        return;
      }
      this.download.source = label;
      try { this.download.host = new URL(url).host; } catch (e) { /* ignore */ }
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'SimpleUI-ASR/1.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          follow(new URL(res.headers.location, url).toString(), label, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(`http_${res.statusCode}`);
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        this.download = { active: true, received: 0, total, error: null, source: label, host: this.download.host };
        const out = fs.createWriteStream(partFile);
        res.on('data', (chunk) => {
          this.download.received += chunk.length;
        });
        // 网络中断等异常会让流提前结束——必须校验实际字节数，
        // 否则「0 字节的成功」会被误判为下载完成。
        res.on('error', (e) => {
          try { out.destroy(); } catch (err) { /* ignore */ }
          try { fs.unlinkSync(partFile); } catch (err) { /* ignore */ }
          fail(e.code || e.message || 'stream_error');
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            const received = this.download.received;
            const expected = this.download.total;
            const complete = received >= 1024 * 1024 && (expected === 0 || received >= expected);
            if (!complete) {
              try { fs.unlinkSync(partFile); } catch (e) { /* ignore */ }
              fail(expected > 0 ? `incomplete_${received}_of_${expected}` : 'empty_response');
              return;
            }
            try {
              fs.renameSync(partFile, dest);
              // 下载完成后把配置指向该模型
              this.config = { ...this.config, modelPath: dest };
              fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
              this.download = {
                active: false,
                received,
                total: expected,
                error: null,
                source: label,
                host: this.download.host,
              };
            } catch (e) {
              fail(e.message);
            }
          });
        });
        out.on('error', (e) => {
          fail(e.code || e.message || 'write_error');
        });
      });
      req.on('error', (e) => {
        // Node 的网络错误 message 常为空串，需回退到 code
        fail(e.code || e.message || 'network_error');
      });
    };
    follow(sources[0], sourceLabel(sources[0]));
    return { started: true, path: dest };
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

      if (pathname === '/download-model' && req.method === 'POST') {
        sendJson(200, this.startModelDownload());
        return;
      }

      // 语音转写：接受裸音频字节（Content-Type 任意），language 可经查询串覆盖
      if (pathname === '/transcribe' && req.method === 'POST') {
        const audio = await readRawBody();
        if (!audio || audio.length < 256) {
          sendJson(400, { ok: false, error: 'empty_audio' });
          return;
        }
        const alive = isPidAlive(readPid());
        const healthy = alive ? await this.checkHealth() : false;
        if (!healthy) {
          // 服务未就绪：尽力拉起一次再试（用户可能刚打开 App）
          if (this.config.enabled) {
            await this.startService();
          }
          if (!(await this.checkHealth())) {
            sendJson(503, { ok: false, error: 'service_not_ready' });
            return;
          }
        }
        const lang = urlObj.searchParams.get('language') || undefined;
        const result = await this.transcribe(audio, lang);
        sendJson(result.ok ? 200 : 502, result);
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

// 在目录下递归搜第一个 *.gguf（限制深度，避免扫到大目录）
function findGgufRecursive(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  // 先找文件，再递归子目录（优先浅层命中）
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
      return path.join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findGgufRecursive(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

// 去掉 SenseVoice 的 <|event|>/<|emotion|>/<|language|> 元标签
function stripMetaTags(text) {
  if (!text) return '';
  return text.replace(/<\|[^|]*\|>/g, '').trim();
}

export const asrService = new AsrService();
