#!/usr/bin/env python3
"""SimpleUI PaddleOCR-VL 常驻识别进程。

基于 mlx-vlm 加载 OpenGryd/PaddleOCR-VL-1.6-MLX-8bit 本地模型。
模型在启动时加载一次，之后常驻，供 SimpleUI 节点服务调用。

接口：
  GET  /health     -> {"ready": true, "model_dir": "..."}
  POST /recognize  -> {"image_path": str, "task": str, "max_pixels": int} 返回 {"ok": bool, "text": str, "duration_ms": int}
"""

import argparse
import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_model = None
_processor = None
_model_lock = threading.Lock()
_model_dir = ""

PROMPTS = {
    "ocr": "OCR:",
    "table": "Table Recognition:",
    "formula": "Formula Recognition:",
    "chart": "Chart Recognition:",
    "spotting": "Spotting:",
    "seal": "Seal Recognition:",
}

MAX_TOKENS = {
    "ocr": 4096,
    "table": 2048,
    "formula": 512,
    "chart": 1024,
    "spotting": 1024,
    "seal": 512,
}

DEFAULT_MAX_PIXELS = 1_806_336  # 默认高分辨率档


def resize_image_by_area(source_path: str, max_pixels: int) -> str:
    """按像素面积上限缩小图片，保持宽高比；不放大小图。若无需缩小则直接返回原路径。"""
    if max_pixels <= 0:
        return source_path

    try:
        from PIL import Image, ImageOps
    except ImportError:
        return source_path

    source = Path(source_path)
    if not source.is_file():
        return source_path

    with Image.open(source) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        area = w * h
        if area <= max_pixels:
            return source_path

        scale = math.sqrt(max_pixels / area)
        new_size = (max(1, round(w * scale)), max(1, round(h * scale)))
        resized = im.resize(new_size, Image.Resampling.LANCZOS)

        dest = Path(f"/tmp/simpleui_ocr_resized_{os.getpid()}_{int(time.time() * 1000)}.png")
        resized.save(dest, format="PNG", optimize=True)
        return str(dest)


def load(model_dir: str):
    global _model, _processor, _model_dir
    from mlx_vlm import load as load_vlm

    _model_dir = model_dir
    t0 = time.time()
    print(f"[ocr] loading model from {model_dir}...", flush=True)
    _model, _processor = load_vlm(model_dir, trust_remote_code=True)
    print(f"[ocr] model loaded in {time.time() - t0:.1f}s", flush=True)


def recognize(image_path: str, task: str = "ocr", max_pixels: int = DEFAULT_MAX_PIXELS) -> str:
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    task_key = (task or "ocr").lower().strip()
    prompt = PROMPTS.get(task_key, PROMPTS["ocr"])
    max_tokens = MAX_TOKENS.get(task_key, 4096)

    actual_image_path = resize_image_by_area(image_path, max_pixels)
    is_resized_temp = actual_image_path != image_path

    try:
        with _model_lock:
            formatted_prompt = apply_chat_template(
                _processor,
                _model.config,
                prompt=prompt,
                num_images=1,
            )

            result = generate(
                model=_model,
                processor=_processor,
                prompt=formatted_prompt,
                image=actual_image_path,
                max_tokens=max_tokens,
                temperature=0.0,
            )
            text = getattr(result, "text", str(result))
            return text
    finally:
        if is_resized_temp:
            try:
                os.unlink(actual_image_path)
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 日志由 Node.js 托管侧统一接管

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "ready": _model is not None,
                "model_dir": _model_dir,
                "prompts": list(PROMPTS.keys()),
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/recognize":
            self._json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._json(400, {"error": f"bad json: {e}"})
            return

        image_path = payload.get("image_path") or payload.get("image") or ""
        if not image_path or not os.path.isfile(image_path):
            self._json(400, {"error": f"image not found: {image_path}"})
            return

        task = payload.get("task", "ocr")
        max_pixels = int(payload.get("max_pixels") or DEFAULT_MAX_PIXELS)

        t0 = time.time()
        print(f"[ocr] recognize request: image={image_path}, task={task}, max_pixels={max_pixels}", flush=True)

        try:
            text = recognize(image_path, task=task, max_pixels=max_pixels)
            duration_ms = int((time.time() - t0) * 1000)
            print(f"[ocr] recognized {len(text)} chars in {duration_ms}ms", flush=True)
            self._json(200, {
                "ok": True,
                "text": text,
                "duration_ms": duration_ms,
                "task": task,
            })
        except Exception as e:
            print(f"[ocr] recognition failed: {e}", flush=True)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1256)
    args = ap.parse_args()

    load(args.model_dir)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[ocr] listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
