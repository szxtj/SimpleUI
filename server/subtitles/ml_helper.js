// 字幕 CoreML helper 的 Node 客户端。
// 协议：JSON Lines over stdin/stdout；任何崩溃/超时/协议错误都直接 fatal。

import { spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';

export class SubtitleError extends Error {
  constructor(stage, code, message, detail = null) {
    super(message);
    this.name = 'SubtitleError';
    this.stage = stage;
    this.code = code;
    this.detail = detail;
  }
}

export class SubtitleMlHelper {
  constructor({ helperPath, modelsDir, onFatal }) {
    this.helperPath = helperPath;
    this.modelsDir = modelsDir;
    this.onFatal = onFatal;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.closing = false;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    if (!fs.existsSync(this.helperPath)) {
      return Promise.reject(
        new SubtitleError('segmentation', 'ML_HELPER_MISSING', `CoreML helper 不存在: ${this.helperPath}`)
      );
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.proc = spawn(this.helperPath, ['--models-dir', this.modelsDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', (err) => this._fail('ML_HELPER_SPAWN_FAILED', err.message));
    this.proc.on('exit', (code, sig) => {
      if (this.closing) return;
      this._fail('ML_HELPER_EXITED', `CoreML helper 退出 (code=${code}, sig=${sig})`);
    });
    this.proc.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) console.error('[Subtitles][MLHelper]', text);
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    const timer = setTimeout(() => {
      if (!this.ready) this._fail('ML_HELPER_NOT_READY', 'CoreML helper 启动超时');
    }, 20000);

    return this.readyPromise.finally(() => clearTimeout(timer));
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this._fail('ML_HELPER_PROTOCOL', `CoreML helper 返回非法 JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.ready === true) {
      this.ready = true;
      this.resolveReady?.(true);
      return;
    }
    if (msg.error) {
      const err = new SubtitleError(
        'segmentation',
        'ML_HELPER_ERROR',
        String(msg.error),
        msg.id ?? null
      );
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p.reject(err);
      } else {
        this._fail('ML_HELPER_ERROR', String(msg.error));
      }
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  _fail(code, message) {
    if (this.closing) return;
    this.ready = false;
    const err = new SubtitleError('segmentation', code, message);
    this.rejectReady?.(err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onFatal?.(err);
  }

  _request(payload, timeoutMs) {
    if (!this.ready || !this.proc || this.proc.killed) {
      return Promise.reject(
        new SubtitleError('segmentation', 'ML_HELPER_NOT_READY', 'CoreML helper 未就绪')
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._fail('ML_HELPER_TIMEOUT', `CoreML helper 请求超时 (${payload.cmd})`);
        reject(new SubtitleError('segmentation', 'ML_HELPER_TIMEOUT', 'CoreML helper 请求超时'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SubtitleError('segmentation', 'ML_HELPER_WRITE_FAILED', e.message));
      }
    });
  }

  async segment(ids) {
    const msg = await this._request({ cmd: 'segment', ids }, 3000);
    if (!Array.isArray(msg.probs)) {
      throw new SubtitleError('segmentation', 'ML_HELPER_PROTOCOL', 'segment 响应缺少 probs');
    }
    return msg.probs;
  }

  async turn(pcmBuffer) {
    const msg = await this._request(
      { cmd: 'turn', pcm: Buffer.from(pcmBuffer).toString('base64') },
      3000
    );
    if (typeof msg.probability !== 'number') {
      throw new SubtitleError('segmentation', 'ML_HELPER_PROTOCOL', 'turn 响应缺少 probability');
    }
    return msg.probability;
  }

  close() {
    this.closing = true;
    this.pending.clear();
    try {
      this.proc?.stdin.end();
    } catch {}
    try {
      this.proc?.kill('SIGKILL');
    } catch {}
    this.proc = null;
    this.ready = false;
  }
}
