#!/usr/bin/env python3
"""SimpleUI 文字转语音常驻进程。

只做一件事：把 mlx-audio 的 Qwen3-TTS 包成一个本地 HTTP 接口，供 tts_service.js 调用。
模型在启动时加载一次，之后常驻；生成是串行的（单 GPU 队列）。

接口：
  GET  /health  -> {"ready": true, "sample_rate": 24000, "voices": [...]}
  POST /speak   -> {"text", "voice", "language", "speed"} 返回 WAV 字节流
"""

import argparse
import glob
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_model = None
_model_lock = threading.Lock()
_sample_rate = 24000
_voices = []


def load(model_dir):
    global _model, _sample_rate, _voices
    from mlx_audio.tts.utils import load_model

    t0 = time.time()
    _model = load_model(model_dir)
    _sample_rate = int(getattr(_model, "sample_rate", 24000) or 24000)
    try:
        _voices = list(getattr(_model, "supported_speakers", []) or [])
    except Exception:
        _voices = []
    print(f"[tts] model loaded in {time.time() - t0:.1f}s, sample_rate={_sample_rate}, voices={len(_voices)}",
          flush=True)


def synthesize(text, voice, language, speed):
    """返回 WAV 字节流。"""
    from mlx_audio.tts.generate import generate_audio

    tmp_prefix = f"/tmp/simpleui_tts_{os.getpid()}"
    # 短文本会让模型拖长音、甚至跑飞（实测「你好」在 aiden 上生成 12 秒）。
    # 用与字数成比例的硬上限兜底：正常语速约 3–4 帧/字（12.5 帧/秒）。
    chars = len(text.strip())
    max_tokens = max(60, min(1200, int(chars * 5) + 40))
    with _model_lock:
        generate_audio(
            text,
            model=_model,
            voice=voice or "serena",
            lang_code=language or "auto",
            speed=speed or 1.0,
            max_tokens=max_tokens,
            output_path="/tmp",
            file_prefix=os.path.basename(tmp_prefix),
            audio_format="wav",
            save=True,
            verbose=False,
        )
    path = None
    candidates = sorted(glob.glob(tmp_prefix + "*.wav"), key=os.path.getmtime)
    if candidates:
        path = candidates[-1]
    try:
        if not path:
            raise RuntimeError("合成未产生音频文件")
        with open(path, "rb") as f:
            return f.read()
    finally:
        for p in candidates:
            try:
                os.unlink(p)
            except OSError:
                pass


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
            self._json(200, {"ready": _model is not None, "sample_rate": _sample_rate,
                             "voices": _voices})
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
        print(f"[tts] request: {len(text)} chars, voice={payload.get('voice')}", flush=True)

        try:
            wav = synthesize(text, payload.get("voice"), payload.get("language"),
                             payload.get("speed"))
        except Exception as e:
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
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
