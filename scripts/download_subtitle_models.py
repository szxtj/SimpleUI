#!/usr/bin/env python3
"""
SimpleUI 实时双语字幕系统 — 专属模型全量下载器 (国内高速镜像源)
严格对齐四级架构方案：
  1. TEN-framework/ten-vad                    -> ten_vad.onnx (~315 KB)
  2. ggml-org/Qwen3-ASR-1.7B-GGUF             -> qwen3_asr_1.7b.gguf (~2.06 GB)
  3. aufklarer/Qwen3-ForcedAligner-CoreML-INT8 -> audio_encoder.mlmodelc (~303 MB)
  4. IndexTeam/Index-Translate-2B-GGUF        -> index_translate_2b_q4_k_m.gguf (~1.25 GB)
  5. jiangzhuo9357/edge-punct-casing-en-onnx -> punct/model.int8.onnx (~7.5 MB, 独立句末判定)
"""

import os
import sys
import time
import argparse
import urllib.request
from typing import Dict, List, Any

TARGET_DIR = os.path.expanduser('~/Library/Application Support/SimpleUI/models/subtitles_pipeline')
MIRROR_BASE = "https://hf-mirror.com"
OFFICIAL_BASE = "https://huggingface.co"

MODEL_SPECS = {
    "vad": {
        "title": "第 1 级: TEN-VAD (声学活动检测与流式断句)",
        "repo": "TEN-framework/ten-vad",
        "files": [
            {
                "src": "src/onnx_model/ten-vad.onnx",
                "dst": "ten_vad.onnx",
                "min_bytes": 300 * 1024,
                "expected_mb": 0.3
            }
        ]
    },
    "aligner": {
        "title": "第 3 级: Qwen3-ForcedAligner-0.6B-CoreML-INT8 (ANE 原生词级毫秒对齐)",
        "repo": "aufklarer/Qwen3-ForcedAligner-0.6B-CoreML-INT8",
        "files": [
            {
                "src": "audio_encoder.mlmodelc/weights/weight.bin",
                "dst": "audio_encoder.mlmodelc/weights/weight.bin",
                "min_bytes": 310 * 1024 * 1024,
                "expected_mb": 302.3
            },
            {
                "src": "audio_encoder.mlmodelc/model.mil",
                "dst": "audio_encoder.mlmodelc/model.mil",
                "min_bytes": 1000 * 1024,
                "expected_mb": 1.3
            },
            {
                "src": "audio_encoder.mlmodelc/metadata.json",
                "dst": "audio_encoder.mlmodelc/metadata.json",
                "min_bytes": 1024,
                "expected_mb": 0.01
            },
            {
                "src": "audio_encoder.mlmodelc/coremldata.bin",
                "dst": "audio_encoder.mlmodelc/coremldata.bin",
                "min_bytes": 100,
                "expected_mb": 0.001
            },
            {
                "src": "audio_encoder.mlmodelc/analytics/coremldata.bin",
                "dst": "audio_encoder.mlmodelc/analytics/coremldata.bin",
                "min_bytes": 100,
                "expected_mb": 0.001
            }
        ]
    },
    "punct": {
        "title": "句末判定: Edge-Punct-Casing (独立流式标点 / 句末检测, 取代按静音机械断句)",
        "repo": "jiangzhuo9357/edge-punct-casing-en-onnx",
        "files": [
            {
                "src": "model.int8.onnx",
                "dst": "punct/model.int8.onnx",
                "min_bytes": 7 * 1024 * 1024,
                "expected_mb": 7.5
            },
            {
                "src": "bpe.vocab",
                "dst": "punct/bpe.vocab",
                "min_bytes": 100 * 1024,
                "expected_mb": 0.15
            }
        ]
    },
    "translate": {
        "title": "第 4 级: Index-Translate-2B Q4_K_M (专精神经机器翻译)",
        "repo": "IndexTeam/Index-Translate-2B-GGUF",
        "files": [
            {
                "src": "Index-Translate-2B.Q4_K_M.gguf",
                "dst": "index_translate_2b_q4_k_m.gguf",
                "min_bytes": 1200 * 1024 * 1024,
                "expected_mb": 1251.4
            }
        ]
    },
    "asr": {
        "title": "第 2 级: Qwen3-ASR-1.7B-Q8_0 (高精度流式英文/多语言语音识别)",
        "repo": "ggml-org/Qwen3-ASR-1.7B-GGUF",
        "files": [
            {
                "src": "Qwen3-ASR-1.7B-Q8_0.gguf",
                "dst": "qwen3_asr_1.7b.gguf",
                "min_bytes": 2000 * 1024 * 1024,
                "expected_mb": 2064.7
            },
            {
                "src": "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
                "dst": "mmproj_qwen3_asr_1.7b.gguf",
                "min_bytes": 330 * 1024 * 1024,
                "expected_mb": 339.2
            }
        ]
    }
}

def format_size(bytes_num: int) -> str:
    if bytes_num < 1024 * 1024:
        return f"{bytes_num / 1024:.1f} KB"
    elif bytes_num < 1024 * 1024 * 1024:
        return f"{bytes_num / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_num / (1024 * 1024 * 1024):.2f} GB"

def check_file_ready(rel_path: str, min_bytes: int) -> bool:
    full = os.path.join(TARGET_DIR, rel_path)
    return os.path.exists(full) and os.path.getsize(full) >= min_bytes

def print_status_table():
    print("================================================================================")
    print("       🚀 SimpleUI 专属实时双语字幕四级模型状态 (国内镜像: hf-mirror.com)")
    print(f"       📂 存储目录: {TARGET_DIR}")
    print("================================================================================")
    all_ready = True
    total_expected_mb = 0
    total_existing_mb = 0

    for key, spec in MODEL_SPECS.items():
        print(f"\n【{spec['title']}】")
        for f in spec["files"]:
            total_expected_mb += f["expected_mb"]
            dest_path = os.path.join(TARGET_DIR, f["dst"])
            if check_file_ready(f["dst"], f["min_bytes"]):
                sz = os.path.getsize(dest_path)
                total_existing_mb += sz / (1024 * 1024)
                print(f"  • {f['dst']:<45} [✅ 就绪] ({format_size(sz)})")
            else:
                all_ready = False
                cur_sz = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
                print(f"  • {f['dst']:<45} [⏳ 缺失] (预计 {f['expected_mb']:.1f} MB, 当前 {format_size(cur_sz)})")

    print("\n--------------------------------------------------------------------------------")
    print(f"总计体量: 预计 {total_expected_mb / 1024:.2f} GB | 本地已就绪: {total_existing_mb / 1024:.2f} GB")
    if all_ready:
        print("🎉 全部 4 级模型均已就绪，实时双语字幕服务已可启动！")
    else:
        print("💡 尚有模型未下载。可运行 `python3 scripts/download_subtitle_models.py --all` 开始下载。")
    print("================================================================================\n")
    return all_ready

def download_single_file(repo: str, src_path: str, dst_path: str, min_bytes: int, expected_mb: float, mirror_url: str):
    full_dst = os.path.join(TARGET_DIR, dst_path)
    if check_file_ready(dst_path, min_bytes):
        print(f"  [跳过] 已存在且完整: {dst_path} ({format_size(os.path.getsize(full_dst))})")
        return True

    os.makedirs(os.path.dirname(full_dst), exist_ok=True)
    part_path = full_dst + ".part"

    download_url = f"{mirror_url}/{repo}/resolve/main/{src_path}"
    print(f"\n📥 正在下载: {dst_path}")
    print(f"   源地址: {download_url}")

    # 支持断点续传
    existing_bytes = os.path.getsize(part_path) if os.path.exists(part_path) else 0
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }
    if existing_bytes > 0:
        headers["Range"] = f"bytes={existing_bytes}-"
        print(f"   发现已下载碎片: {format_size(existing_bytes)}，从断点处继续...")

    req = urllib.request.Request(download_url, headers=headers)
    max_retries = 3

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                code = resp.getcode()
                content_len = resp.headers.get("Content-Length")
                total_bytes = (int(content_len) + existing_bytes) if content_len else int(expected_mb * 1024 * 1024)

                mode = "ab" if (existing_bytes > 0 and code == 206) else "wb"
                if mode == "wb":
                    existing_bytes = 0

                downloaded = existing_bytes
                start_time = time.time()
                last_update = 0

                with open(part_path, mode) as f:
                    while True:
                        chunk = resp.read(256 * 1024) # 256KB 块
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)

                        now = time.time()
                        if now - last_update >= 0.2:
                            last_update = now
                            elapsed = now - start_time
                            speed = (downloaded - existing_bytes) / max(0.1, elapsed)
                            pct = (downloaded / total_bytes) * 100 if total_bytes > 0 else 0
                            eta_sec = (total_bytes - downloaded) / max(1, speed) if total_bytes > downloaded else 0
                            eta_str = f"{int(eta_sec // 60)}m{int(eta_sec % 60):02d}s"

                            bar_len = 25
                            filled = int(bar_len * pct / 100)
                            bar = "█" * filled + "░" * (bar_len - filled)

                            sys.stdout.write(
                                f"\r   [{bar}] {pct:5.1f}% | {format_size(downloaded)}/{format_size(total_bytes)} | {speed / 1024 / 1024:.2f} MB/s | ETA: {eta_str} "
                            )
                            sys.stdout.flush()

            sys.stdout.write("\n")
            if os.path.getsize(part_path) >= min_bytes:
                os.rename(part_path, full_dst)
                print(f"   ✅ 校验通过并落盘: {dst_path} ({format_size(os.path.getsize(full_dst))})")
                return True
            else:
                print(f"   ⚠ 文件大小不足，重试 ({attempt}/{max_retries})...")
        except Exception as e:
            sys.stdout.write("\n")
            print(f"   ⚠ 下载中断 ({attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(2)
                # 重新计算已有碎片
                existing_bytes = os.path.getsize(part_path) if os.path.exists(part_path) else 0
                if existing_bytes > 0:
                    headers["Range"] = f"bytes={existing_bytes}-"
                req = urllib.request.Request(download_url, headers=headers)

    return False

def download_model(key: str, mirror_url: str):
    spec = MODEL_SPECS.get(key)
    if not spec:
        print(f"未知模型标识: {key}")
        return False
    print(f"\n=======================================================")
    print(f"  开始拉取: {spec['title']}")
    print(f"=======================================================")
    for f in spec["files"]:
        ok = download_single_file(spec["repo"], f["src"], f["dst"], f["min_bytes"], f["expected_mb"], mirror_url)
        if not ok:
            print(f"❌ {f['dst']} 下载失败！")
            return False
    return True

def main():
    parser = argparse.ArgumentParser(description="SimpleUI 实时双语字幕四级模型下载器")
    parser.add_argument("--status", action="store_true", help="查看所有模型下载就绪状态")
    parser.add_argument("--all", action="store_true", help="下载全部缺失模型 (国内镜像源)")
    parser.add_argument("--model", choices=["vad", "asr", "aligner", "translate"], help="下载指定环节的模型")
    parser.add_argument("--official", action="store_true", help="使用官方 HuggingFace 源 (默认使用国内镜像源 hf-mirror.com)")
    args = parser.parse_args()

    mirror = OFFICIAL_BASE if args.official else MIRROR_BASE

    if args.status or (not args.all and not args.model):
        print_status_table()
        if not args.all and not args.model:
            print("快捷下载用法:")
            print("  python3 scripts/download_subtitle_models.py --all           # 一键下载全部 4 个模型 (国内镜像)")
            print("  python3 scripts/download_subtitle_models.py --model aligner # 仅下载 ForcedAligner 对齐模型")
            print("  python3 scripts/download_subtitle_models.py --model translate # 仅下载 Index-Translate 翻译模型")
            print("  python3 scripts/download_subtitle_models.py --model asr     # 仅下载 Qwen3-ASR 语音模型")
            return

    if args.all:
        print_status_table()
        # 按体积从小到大依次下载，保证体验平滑
        order = ["vad", "aligner", "translate", "asr"]
        for k in order:
            success = download_model(k, mirror)
            if not success:
                print(f"\n❌ 模型 {k} 下载中断，请检查网络后重新执行。支持断点续传。")
                sys.exit(1)
        print("\n🎉 全部模型下载完成！")
        print_status_table()

    elif args.model:
        success = download_model(args.model, mirror)
        if success:
            print_status_table()
        else:
            sys.exit(1)

if __name__ == '__main__':
    main()
