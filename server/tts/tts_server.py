#!/usr/bin/env python3
"""SimpleUI 文字转语音常驻进程。

只做一件事：把 mlx-audio 的 Qwen3-TTS 包成一个本地 HTTP 接口，供 tts_service.js 调用。
模型的生命周期由 Node 侧控制（每次生成前拉起、生成结束即卸载）。

接口：
  GET  /health  -> {"ready": true, "sample_rate": 24000, "voices": [...], "languages": [...]}
  POST /speak   -> {"text", "voice", "language", "temperature", "top_p", "top_k",
                    "repetition_penalty", "max_tokens"} 返回 WAV 字节流

分段不在这里做：Node 侧按段落切好，一段一次请求，逐段回传进度、逐段拼 PCM。
这里只保证「一次请求 == 一段文本 == 一条 WAV」，避开 mlx-audio 内部按 \n 再切段、
文件模式下只留最后一段的老坑。
"""

import argparse
import io
import json
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_model = None
_model_lock = threading.Lock()
_sample_rate = 24000
_voices = []
_languages = []

# 单段字数上限：正常由前端按句切到 ≤120 字，这里只挡异常输入。
MAX_SEGMENT_CHARS = 600


def load(model_dir):
    global _model, _sample_rate, _voices, _languages
    from mlx_audio.tts.utils import load_model

    t0 = time.time()
    _model = load_model(model_dir)
    _sample_rate = int(getattr(_model, "sample_rate", 24000) or 24000)
    try:
        _voices = list(getattr(_model, "supported_speakers", []) or [])
    except Exception:
        _voices = []
    try:
        _languages = list(getattr(_model, "supported_languages", []) or [])
    except Exception:
        _languages = []
    print(
        f"[tts] model loaded in {time.time() - t0:.1f}s, sample_rate={_sample_rate}, "
        f"voices={len(_voices)}, languages={len(_languages)}",
        flush=True,
    )


def _per_segment_max_tokens(chars, cap):
    """单段 max_tokens：以面板上限为天花板，按字数收敛。

    12.5 帧/秒、正常语速约 4 帧/字，短句给足余量避免截尾，长句不把上限顶满。
    """
    cap = int(cap or 1024)
    want = int(chars * 4) + 96
    return max(256, min(cap, want))


def synthesize(text, voice, language, opts):
    """返回 (wav_bytes, duration_sec)。"""
    # 防御：\n 会让 mlx-audio 内部再切段并逐段 yield，这里只取最后一段。
    flat = re.sub(r"\s+", " ", text).strip()[:MAX_SEGMENT_CHARS]
    if not flat:
        raise ValueError("empty text")

    max_tokens = _per_segment_max_tokens(len(flat), opts.get("max_tokens"))

    import numpy as np

    t0 = time.time()
    result = None
    with _model_lock:
        for result in _model.generate(
            text=flat,
            voice=(voice or "serena"),
            lang_code=(language or "auto"),
            temperature=float(opts.get("temperature") or 0.85),
            top_p=float(opts.get("top_p") or 0.95),
            top_k=int(opts.get("top_k") or 50),
            repetition_penalty=float(opts.get("repetition_penalty") or 1.05),
            max_tokens=max_tokens,
            verbose=False,
        ):
            pass
    if result is None:
        raise RuntimeError("模型没有产出音频")

    pcm = np.asarray(result.audio, dtype=np.float32).reshape(-1)
    pcm = np.clip(pcm, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(_sample_rate)
        w.writeframes(pcm16.tobytes())
    duration = len(pcm16) / float(_sample_rate)
    print(
        f"[tts] segment: {len(flat)} chars -> {duration:.2f}s audio "
        f"in {time.time() - t0:.2f}s (max_tokens={max_tokens})",
        flush=True,
    )
    return buf.getvalue(), duration


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静：日志由 Node 侧统一收
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ready": _model is not None,
                    "sample_rate": _sample_rate,
                    "voices": _voices,
                    "languages": _languages,
                },
            )
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._json(400, {"error": f"bad json: {e}"})
            return

        text = (payload.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "empty text"})
            return

        try:
            wav, duration = synthesize(
                text, payload.get("voice"), payload.get("language"), payload
            )
        except Exception as e:
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("X-Tts-Duration", f"{duration:.3f}")
        self.send_header("X-Tts-Sample-Rate", str(_sample_rate))
        self.end_headers()
        self.wfile.write(wav)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1255)
    args = ap.parse_args()

    load(args.model_dir)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[tts] listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
