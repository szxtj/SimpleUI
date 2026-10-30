#!/usr/bin/env python3
"""SimpleUI 语音输入 · Qwen3-ASR 常驻进程（MLX / mlx-audio）。

只做一件事：把 mlx-audio 的 `qwen3_asr` 包成本地 HTTP 接口，供 asr_service.js 调用。
模型与进程的生命周期全部由 Node 侧控制（录音现场拉起、闲置超时卸载），这里不自己起停。

与 TTS / OCR 复用同一份内置 Python 运行时（mlx-audio 0.6.x 已原生包含 qwen3_asr 族）。

接口：
  GET  /health      -> 200 {"ready": true, "loaded": true, ...}；模型仍在加载时返回 503
  POST /warmup      -> 等待模型加载完成（幂等），返回 health 体
  POST /transcribe  -> body = 原始 s16le / 单声道 / 16kHz PCM（也接受 RIFF WAV）
                       返回 {"ok": true, "text": "...", "language": "..."}

设计约束：
  * **非流式**：Qwen3-ASR 的增量解码只在 vLLM 后端存在，macOS 上没有；这里只做
    「整段音频进 → 整段文本出」。边录边出字由 Node 侧决定要不要做前缀重转，本进程不做。
  * 模型加载放在后台线程，HTTP 端口先起来：这样 Node 侧能正确区分
    「加载中(503)」与「进程死了(连接拒绝)」，四态状态机的 loading 才不会误判。
  * 推理串行化（一把全局锁）：MLX 共用一块 GPU，并发 decode 只会互相拖慢且吃内存。
  * 静音/纯噪声时模型输出空串（实测不会幻觉出文字），直接原样返回空串。
"""

import argparse
import os
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_model = None
_model_error = None
_model_dir = ""
_ready = threading.Event()
# 推理锁：同一时刻只跑一段音频（0.6B 在长音频上会占 ~1.9GB 峰值显存）
_infer_lock = threading.Lock()

# 单次请求的音频上限：16kHz * 2B * 300s = 9.6MB，挡异常输入（正常语音输入远小于此）
MAX_BODY_BYTES = 16000 * 2 * 300


def log(msg):
    print(f"[qwen3-asr] {msg}", flush=True)


def load_model_async():
    """后台线程加载权重；完成后置 _ready，供 /health 与 /transcribe 等待。"""
    global _model, _model_error
    try:
        t0 = time.time()
        # 延迟导入：让端口先监听起来，导入耗时不计入「进程活着但端口不通」的窗口
        from mlx_audio.stt.utils import load_model

        log(f"loading model from {_model_dir}")
        _model = load_model(_model_dir)
        log(f"model loaded in {time.time() - t0:.2f}s")

        # 首次推理要现场编译 Metal 图（实测 +0.9s）。在「加载中」阶段用 0.8s 静音先跑一遍，
        # 把这份开销挪到用户看不见的地方，第一句话就是稳态的 0.2s。
        try:
            import numpy as np

            tw = time.time()
            _model.generate(np.zeros(12800, dtype=np.float32), language=None)
            log(f"warmup inference in {time.time() - tw:.2f}s")
        except Exception as e:  # noqa: BLE001 - 预热失败不影响正常推理，只是慢一点
            log(f"warmup skipped: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001 - 任何加载失败都要能被 /health 报出去
        _model_error = f"{type(e).__name__}: {e}"
        log(f"load failed: {_model_error}")
        # 加载失败就直接退出：进程活着但永远 503，只会让上层一直显示「加载中」。
        # 退出后 Node 侧按「进程死了 + 日志尾部」报错，与 audiocpp 的表现一致。
        os._exit(1)
    finally:
        _ready.set()


def decode_audio(body, sample_rate):
    """把请求体解成 float32 单声道波形。

    支持两种输入：裸 s16le PCM（正常路径，Node 侧直接转发录音缓冲）与 RIFF WAV
    （手工调试 / 兜底转发 /api/asr/transcribe 时可能出现）。
    """
    import numpy as np

    data = body
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        # 极简 WAV 解析：找 fmt 与 data 两个块，只支持 16bit PCM
        pos = 12
        channels = 1
        bits = 16
        rate = sample_rate
        payload = b""
        while pos + 8 <= len(data):
            cid = data[pos : pos + 4]
            size = int.from_bytes(data[pos + 4 : pos + 8], "little")
            chunk = data[pos + 8 : pos + 8 + size]
            if cid == b"fmt " and len(chunk) >= 16:
                channels = int.from_bytes(chunk[2:4], "little") or 1
                rate = int.from_bytes(chunk[4:8], "little") or rate
                bits = int.from_bytes(chunk[14:16], "little") or 16
            elif cid == b"data":
                payload = chunk
            pos += 8 + size + (size & 1)
        if payload:
            data = payload
        if bits != 16:
            raise ValueError(f"unsupported wav bit depth: {bits}")
        if channels > 1:
            x = np.frombuffer(data, dtype="<i2").astype("float32") / 32768.0
            x = x.reshape(-1, channels).mean(axis=1)
            return x, rate

    x = np.frombuffer(data, dtype="<i2").astype("float32") / 32768.0
    return x, sample_rate


def transcribe(pcm_bytes, sample_rate, language):
    """整段转写，返回 (text, language)。"""
    import mlx.core as mx

    audio, sr = decode_audio(pcm_bytes, sample_rate)
    if audio.size == 0:
        return "", ""

    # 'Auto' -> None（模型自带 LID，输出 language 前缀再剥离）；其余按名字强制指定
    lang = None
    if language and str(language).strip().lower() not in ("", "auto"):
        lang = str(language).strip()

    with _infer_lock:
        out = _model.generate(audio, language=lang)
        # 每次推理完归还缓存页：常驻只保留权重（实测 ~990MB），不把激活留在池子里
        try:
            mx.clear_cache()
        except Exception:
            pass

    text = getattr(out, "text", None)
    if text is None:
        text = str(out or "")
    detected = getattr(out, "language", "") or ""
    if isinstance(detected, (list, tuple)):
        detected = detected[0] if detected else ""
    return str(text).strip(), str(detected)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 不刷 basehttp 的访问日志，Node 侧有完整日志
        return

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _health_payload(self, ready):
        return {
            "ready": ready,
            "loaded": _model is not None,
            "model": _model_dir.rsplit("/", 1)[-1],
            "error": _model_error,
        }

    def do_GET(self):
        if self.path.split("?")[0] != "/health":
            self._send(404, {"ok": False, "error": "unknown endpoint"})
            return
        loaded = _ready.is_set() and _model is not None
        if loaded:
            self._send(200, self._health_payload(True))
        elif _ready.is_set():
            # 加载线程已结束但没模型 = 硬失败，让 Node 侧立刻报错而不是干等
            self._send(500, self._health_payload(False))
        else:
            self._send(503, self._health_payload(False))

    def do_POST(self):
        path, _, query = self.path.partition("?")
        params = {}
        for pair in query.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                params[k] = v

        if path == "/warmup":
            _ready.wait(timeout=180)
            ok = _model is not None
            self._send(200 if ok else 500, self._health_payload(ok))
            return

        if path != "/transcribe":
            self._send(404, {"ok": False, "error": "unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send(400, {"ok": False, "error": "empty_body"})
            return
        if length > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "error": "audio_too_long"})
            return
        body = self.rfile.read(length)

        if not _ready.wait(timeout=180):
            self._send(503, {"ok": False, "error": "model_loading"})
            return
        if _model is None:
            self._send(500, {"ok": False, "error": _model_error or "model_not_loaded"})
            return

        sample_rate = int(params.get("sample_rate") or 16000)
        language = params.get("language") or "Auto"
        t0 = time.time()
        try:
            text, detected = transcribe(body, sample_rate, language)
        except Exception as e:  # noqa: BLE001 - 单次推理失败不该带走整个进程
            log(f"transcribe failed: {type(e).__name__}: {e}")
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
            return

        log(
            f"transcribed {len(body) / 2 / sample_rate:.2f}s audio in "
            f"{time.time() - t0:.2f}s -> {len(text)} chars"
        )
        self._send(
            200,
            {
                "ok": True,
                "text": text,
                "language": detected,
                "seconds": round(time.time() - t0, 3),
            },
        )


def main():
    global _model_dir
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    _model_dir = args.model_dir
    # 端口先起来，模型在后台加载：Node 侧靠 /health 的 503 判断「加载中」
    threading.Thread(target=load_model_async, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on 127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
