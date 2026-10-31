// 模型下载的「暂存 → 提交」统一实现。
//
// 背景：以前四份下载器（语音 Qwen3 / 字幕 / 语音合成 / 视觉识别）都是**边下边往目标目录落地** ——
// `.part` 就躺在正式目录里，下完一个文件立刻 rename 成正式名。后果：
//   * 下载中途「打开模型目录」能看到半成品；
//   * `ready()` 只校验必需文件，非必需的小配置还没到就可能显示「就绪」；
//   * 两个下载器写同一目录时（例如下载中改了模型目录），两条写入流会写同一个 `.part`，
//     交错写入后大小反而可能「凑够」，校验通过 → 留下坏权重。
//
// 现在统一成：先把文件下载到 `<modelDir>/.incoming/<key>/`（同卷、点号目录，Finder 默认不可见），
// 全部到齐并逐个校验后再一次性 rename 到目标目录；成功后在目标目录写一个封条 `.ready-<key>`。
// 同卷 rename 是原子的，所以目标目录里永远只有「完整的旧版本」或「完整的新版本」。
//
// 为什么暂存区放在目标目录下而不是系统临时区：rename 只有同卷才原子，跨卷会 EXDEV 退化成复制
// （1GB 要占双份空间、耗时翻倍，且中途失败会留残渣）。模型目录可能被用户放到外置盘，
// 放在它内部才能保证「下载卷 == 提交卷」。

import fs from 'fs';
import path from 'path';

export const INCOMING_DIRNAME = '.incoming';
const COMPLETE_MARK = '.complete';
const LOCK_FILE = '.lock';
const READY_MARK_PREFIX = '.ready-';

/** 目标目录可能是个符号链接；所有路径都基于真实目录计算，避免 rename 到链接本身 */
export function realModelDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export function stagingRoot(modelDir) {
  return path.join(realModelDir(modelDir), INCOMING_DIRNAME);
}

export function stagingDir(modelDir, key) {
  return path.join(stagingRoot(modelDir), key);
}

/** 封条路径（落在**目标目录**，不是暂存区）：.ready-qwen3 / .ready-tts … */
export function readyMarkPath(modelDir, key) {
  return path.join(realModelDir(modelDir), `${READY_MARK_PREFIX}${key}`);
}

export function readReadyMark(modelDir, key) {
  try {
    const raw = fs.readFileSync(readyMarkPath(modelDir, key), 'utf-8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function writeReadyMark(modelDir, key, info = {}) {
  try {
    const p = readyMarkPath(modelDir, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ key, at: Date.now(), ...info }, null, 0));
    return true;
  } catch {
    return false;
  }
}

export function clearReadyMark(modelDir, key) {
  try {
    fs.rmSync(readyMarkPath(modelDir, key), { force: true });
  } catch {
    // ignore
  }
}

/**
 * 判断「这个模型是否已完整就绪」。
 *
 * @param modelDir 模型目录
 * @param key      模型 key（qwen3 / asr / segment / translate / tts / ocr）
 * @param checkFiles 由调用方提供的文件校验函数：() => boolean（大小是否达标）
 *
 * 规则：
 *   - 文件齐全但没有封条 → 视为**老版本下载的模型**，补写封条后算就绪（一次性迁移）；
 *   - 有封条但文件不全 → 说明目录被外部动过，清掉封条并判为未就绪（避免假就绪）。
 */
export function isModelReady(modelDir, key, checkFiles) {
  let filesOk = false;
  try {
    filesOk = Boolean(checkFiles());
  } catch {
    filesOk = false;
  }
  const mark = readReadyMark(modelDir, key);
  if (filesOk && !mark) {
    writeReadyMark(modelDir, key, { migrated: true });
    return true;
  }
  if (!filesOk && mark) {
    clearReadyMark(modelDir, key);
    return false;
  }
  return filesOk;
}

function lockOwner(lockPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    const pid = Number(raw?.pid) || 0;
    if (!pid) return { pid: 0, alive: false };
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch {
    return { pid: 0, alive: false };
  }
}

/**
 * 同一进程内的单例表：下载器都是跑在这一个 Node 进程里（字幕 / TTS / OCR / 语音共用），
 * pid 天然相同，所以「靠 pid 判断是否被占用」在这里无效 —— 用一个进程内注册表兜住。
 * 跨进程才看 `.lock` 文件里的 pid。
 */
const ACTIVE = new Map();

function slotId(modelDir, key) {
  return `${modelDir}|${key}`;
}

/** 清理陈旧暂存区：没有锁、且最近修改超过 maxAge 的目录（崩溃残留） */
export function sweepStaleStaging(modelDir, { maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const root = stagingRoot(modelDir);
  let removed = 0;
  try {
    if (!fs.existsSync(root)) return 0;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const lock = path.join(dir, LOCK_FILE);
      if (fs.existsSync(lock) && lockOwner(lock).alive) continue; // 有活下载在跑
      let newest = 0;
      try {
        newest = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (Date.now() - newest < maxAgeMs) continue; // 还年轻，留给下次续传
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }
    // 空的 .incoming 直接清掉，不留可见杂物
    try {
      if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
  return removed;
}

/**
 * 一次下载的暂存区。
 *
 * 生命周期：begin() →（下载循环把文件写进 pathFor(...)）→ commit(entries) 或 discard()。
 * 同一个 key 同一时刻只允许一个实例持有锁，第二个 begin() 会抛 DOWNLOAD_IN_PROGRESS。
 */
export class ModelStaging {
  constructor(modelDir, key) {
    this.modelDir = realModelDir(modelDir);
    this.key = key;
    this.dir = stagingDir(this.modelDir, key);
    this.locked = false;
  }

  begin() {
    const slot = slotId(this.modelDir, this.key);
    const holder = ACTIVE.get(slot);
    if (holder && holder !== this && holder.locked) {
      const err = new Error('DOWNLOAD_IN_PROGRESS');
      err.code = 'DOWNLOAD_IN_PROGRESS';
      throw err;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const lockPath = path.join(this.dir, LOCK_FILE);
    const owner = lockOwner(lockPath);
    // 跨进程：锁被另一个**活着的**进程持有 → 拒绝；同 pid 是残留锁（本进程没登记过这个槽）→ 覆盖
    if (owner.alive && owner.pid !== process.pid) {
      const err = new Error('DOWNLOAD_IN_PROGRESS');
      err.code = 'DOWNLOAD_IN_PROGRESS';
      throw err;
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
    this.locked = true;
    ACTIVE.set(slot, this);
    // 上一次提交到一半就崩了：暂存区里可能已有 .complete，这里不删，commit 会重新覆盖
    return this;
  }

  /** 暂存区里某个相对路径（父目录会自动创建） */
  pathFor(relPath) {
    const full = path.join(this.dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    return full;
  }

  exists(relPath) {
    try {
      return fs.existsSync(path.join(this.dir, relPath));
    } catch {
      return false;
    }
  }

  sizeOf(relPath) {
    try {
      return fs.statSync(path.join(this.dir, relPath)).size;
    } catch {
      return 0;
    }
  }

  /**
   * 提交：校验 → 打封条 → 逐条 rename 到目标目录 → 清理暂存。
   *
   * @param entries [{ relPath, minBytes }] 本次要提交的文件（暂存区里不存在的条目会被跳过，
   *                因为那意味着目标目录里已经有了、本次没重下）
   * @param markKeys 需要写封条的模型 key（字幕一次可能下多级，如 ['asr','translate']）
   */
  commit(entries, { markKeys = [this.key], totalBytes = 0 } = {}) {
    const movable = [];
    for (const e of entries) {
      if (!this.exists(e.relPath)) continue; // 目标已有 / 本次没下
      const size = this.sizeOf(e.relPath);
      if (e.minBytes && size < e.minBytes) {
        const err = new Error(`FILE_SIZE_MISMATCH (${e.relPath}: ${size} < ${e.minBytes})`);
        err.code = 'FILE_SIZE_MISMATCH';
        throw err;
      }
      movable.push(e.relPath);
    }

    // 封条先写在暂存区：表示「这一批已经校验通过，开始上架」
    try {
      fs.writeFileSync(path.join(this.dir, COMPLETE_MARK), String(Date.now()));
    } catch {
      // ignore
    }

    for (const relPath of movable) {
      const from = path.join(this.dir, relPath);
      const to = path.join(this.modelDir, relPath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to); // 同卷原子；目标已存在则被原子替换
    }

    for (const k of markKeys) writeReadyMark(this.modelDir, k, { files: movable.length, totalBytes });
    this.cleanup();
    return { moved: movable.length };
  }

  /** 取消：用户明确取消就不要残片 */
  discard() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.releaseSlot();
  }

  /** 收尾：删暂存目录与锁（失败时不要调用，留给下次续传） */
  cleanup() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.releaseSlot();
  }

  releaseSlot() {
    const slot = slotId(this.modelDir, this.key);
    if (ACTIVE.get(slot) === this) ACTIVE.delete(slot);
    this.locked = false;
  }
}
