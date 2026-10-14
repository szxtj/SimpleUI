#!/usr/bin/env python3
"""
SimpleUI 实时双语字幕系统 — 专属模型下载与清理管理器 (国内高速镜像源)
三级极速流式架构：
  1. TEN-framework/ten-vad                                  -> ten_vad.onnx (~315 KB, 帧级声学活动检测)
  2. aufklarer/Nemotron-Speech-Streaming-0.6B-CoreML-INT8   -> nemotron_asr/ (~580 MB, M系列 ANE 160ms 原生流式英文识别+标点)
  3. IndexTeam/Index-Translate-2B-GGUF                      -> index_translate_2b_q4_k_m.gguf (~1.25 GB, 专精神经机器翻译)
"""

import os
import sys
import json
import time
import shutil
import argparse
import urllib.request
import urllib.error

TARGET_DIR = os.path.expanduser('~/Library/Application Support/SimpleUI/models/subtitles_pipeline')
MIRROR_BASE = "https://hf-mirror.com"
OFFICIAL_BASE = "https://huggingface.co"

# 已废弃的历史模型与残留目录清单（用于 --clean 自动清理释放空间）
LEGACY_PATHS = [
    "qwen3_asr_1.7b.gguf",
    "mmproj_qwen3_asr_1.7b.gguf",
    "audio_encoder.mlmodelc",
    "punct",
]

MODEL_SPECS = {
    "vad": {
        "title": "第 1 级: TEN-VAD (16ms 帧级声学活动检测)",
        "repo": "TEN-framework/ten-vad",
        "files": [
            {
                "src": "src/onnx_model/ten-vad.onnx",
                "dst": "ten_vad.onnx",
                "min_bytes": 300 * 1024,
                "expected_mb": 0.3,
                "optional": False,
            }
        ],
    },
    "asr": {
        "title": "第 2 级: Nemotron-Speech-Streaming-0.6B-CoreML-INT8 (ANE 160ms 原生流式英文 ASR + 内嵌标点)",
        "repo": "aufklarer/Nemotron-Speech-Streaming-0.6B-CoreML-INT8",
        "use_repo_tree": True,
        "dst_prefix": "nemotron_asr",
        "files": [
            {
                "src": "config.json",
                "dst": "nemotron_asr/config.json",
                "min_bytes": 100,
                "expected_mb": 0.001,
                "optional": False,
            },
            {
                "src": "vocab.json",
                "dst": "nemotron_asr/vocab.json",
                "min_bytes": 2 * 1024,
                "expected_mb": 0.02,
                "optional": False,
            },
            {
                "src": "encoder.mlmodelc/weights/weight.bin",
                "dst": "nemotron_asr/encoder.mlmodelc/weights/weight.bin",
                "min_bytes": 500 * 1024 * 1024,
                "expected_mb": 560.9,
                "optional": False,
            },
            {
                "src": "encoder.mlmodelc/model.mil",
                "dst": "nemotron_asr/encoder.mlmodelc/model.mil",
                "min_bytes": 100 * 1024,
                "expected_mb": 0.8,
                "optional": False,
            },
            {
                "src": "encoder.mlmodelc/coremldata.bin",
                "dst": "nemotron_asr/encoder.mlmodelc/coremldata.bin",
                "min_bytes": 100,
                "expected_mb": 0.001,
                "optional": False,
            },
            {
                "src": "encoder.mlmodelc/analytics/coremldata.bin",
                "dst": "nemotron_asr/encoder.mlmodelc/analytics/coremldata.bin",
                "min_bytes": 50,
                "expected_mb": 0.001,
                "optional": True,
            },
            {
                "src": "decoder.mlmodelc/weights/weight.bin",
                "dst": "nemotron_asr/decoder.mlmodelc/weights/weight.bin",
                "min_bytes": 10 * 1024 * 1024,
                "expected_mb": 13.8,
                "optional": False,
            },
            {
                "src": "decoder.mlmodelc/model.mil",
                "dst": "nemotron_asr/decoder.mlmodelc/model.mil",
                "min_bytes": 1024,
                "expected_mb": 0.01,
                "optional": False,
            },
            {
                "src": "decoder.mlmodelc/coremldata.bin",
                "dst": "nemotron_asr/decoder.mlmodelc/coremldata.bin",
                "min_bytes": 100,
                "expected_mb": 0.001,
                "optional": False,
            },
            {
                "src": "decoder.mlmodelc/analytics/coremldata.bin",
                "dst": "nemotron_asr/decoder.mlmodelc/analytics/coremldata.bin",
                "min_bytes": 50,
                "expected_mb": 0.001,
                "optional": True,
            },
            {
                "src": "joint.mlmodelc/weights/weight.bin",
                "dst": "nemotron_asr/joint.mlmodelc/weights/weight.bin",
                "min_bytes": 2 * 1024 * 1024,
                "expected_mb": 3.3,
                "optional": False,
            },
            {
                "src": "joint.mlmodelc/model.mil",
                "dst": "nemotron_asr/joint.mlmodelc/model.mil",
                "min_bytes": 1024,
                "expected_mb": 0.004,
                "optional": False,
            },
            {
                "src": "joint.mlmodelc/coremldata.bin",
                "dst": "nemotron_asr/joint.mlmodelc/coremldata.bin",
                "min_bytes": 100,
                "expected_mb": 0.001,
                "optional": False,
            },
            {
                "src": "joint.mlmodelc/analytics/coremldata.bin",
                "dst": "nemotron_asr/joint.mlmodelc/analytics/coremldata.bin",
                "min_bytes": 50,
                "expected_mb": 0.001,
                "optional": True,
            },
        ],
    },
    "translate": {
        "title": "第 3 级: Index-Translate-2B Q4_K_M (专精神经机器翻译)",
        "repo": "IndexTeam/Index-Translate-2B-GGUF",
        "files": [
            {
                "src": "Index-Translate-2B.Q4_K_M.gguf",
                "dst": "index_translate_2b_q4_k_m.gguf",
                "min_bytes": 1200 * 1024 * 1024,
                "expected_mb": 1251.4,
                "optional": False,
            }
        ],
    },
}


def format_size(bytes_num: int) -> str:
    if bytes_num < 1024 * 1024:
        return f"{bytes_num / 1024:.1f} KB"
    elif bytes_num < 1024 * 1024 * 1024:
        return f"{bytes_num / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_num / (1024 * 1024 * 1024):.2f} GB"


def get_dir_or_file_size(path: str) -> int:
    if not os.path.exists(path):
        return 0
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            if os.path.exists(fp):
                total += os.path.getsize(fp)
    return total


def clean_legacy_and_temp():
    """清理废弃模型（Qwen3-ASR 1.7B、残缺 ForcedAligner、独立 Punct）以及未完成的 .part 碎片"""
    if not os.path.exists(TARGET_DIR):
        return 0

    freed_bytes = 0
    removed_items = []

    for rel in LEGACY_PATHS:
        full_p = os.path.join(TARGET_DIR, rel)
        if os.path.exists(full_p):
            sz = get_dir_or_file_size(full_p)
            try:
                if os.path.isdir(full_p) and not os.path.islink(full_p):
                    shutil.rmtree(full_p)
                else:
                    os.remove(full_p)
                freed_bytes += sz
                removed_items.append(f"{rel} ({format_size(sz)})")
            except Exception as e:
                print(f"  ⚠ 无法清理 {rel}: {e}")

    # 递归清理残留的 .part 文件
    for root, _, files in os.walk(TARGET_DIR):
        for f in files:
            if f.endswith(".part"):
                fp = os.path.join(root, f)
                try:
                    sz = os.path.getsize(fp)
                    os.remove(fp)
                    freed_bytes += sz
                    removed_items.append(f"{os.path.relpath(fp, TARGET_DIR)} ({format_size(sz)})")
                except Exception:
                    pass

    if removed_items:
        print("🧹 已清理废弃模型与残留缓存:")
        for item in removed_items:
            print(f"   - {item}")
        print(f"   ✨ 共释放磁盘空间: {format_size(freed_bytes)}\n")
    else:
        print("🧹 检查完毕：无废弃模型或残留 .part 缓存需要清理。\n")
    return freed_bytes


def check_file_ready(rel_path: str, min_bytes: int) -> bool:
    full = os.path.join(TARGET_DIR, rel_path)
    return os.path.exists(full) and os.path.getsize(full) >= min_bytes


def print_status_table():
    print("================================================================================")
    print("       🚀 SimpleUI 实时英译中流式字幕三级模型状态 (镜像: hf-mirror.com)")
    print(f"       📂 存储目录: {TARGET_DIR}")
    print("================================================================================")
    all_ready = True
    total_expected_mb = 0
    total_existing_mb = 0

    for key, spec in MODEL_SPECS.items():
        print(f"\n【{spec['title']}】")
        for f in spec["files"]:
            if f.get("optional"):
                continue
            total_expected_mb += f["expected_mb"]
            dest_path = os.path.join(TARGET_DIR, f["dst"])
            if check_file_ready(f["dst"], f["min_bytes"]):
                sz = os.path.getsize(dest_path)
                total_existing_mb += sz / (1024 * 1024)
                print(f"  • {f['dst']:<52} [✅ 就绪] ({format_size(sz)})")
            else:
                all_ready = False
                cur_sz = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
                print(
                    f"  • {f['dst']:<52} [⏳ 缺失] (预计 {f['expected_mb']:.1f} MB, 当前 {format_size(cur_sz)})"
                )

    legacy_found = []
    if os.path.exists(TARGET_DIR):
        for rel in LEGACY_PATHS:
            p = os.path.join(TARGET_DIR, rel)
            if os.path.exists(p):
                legacy_found.append(f"{rel} ({format_size(get_dir_or_file_size(p))})")

    print("\n--------------------------------------------------------------------------------")
    print(f"总计体量: 预计 {total_expected_mb / 1024:.2f} GB | 本地已就绪: {total_existing_mb / 1024:.2f} GB")
    if legacy_found:
        print(f"⚠ 发现可清理的旧版冗余模型: {', '.join(legacy_found)}")
        print("  可运行 `python3 scripts/download_subtitle_models.py --clean` 立即释放空间。")
    if all_ready:
        print("🎉 全部 3 级流式模型均已就绪，实时英译中字幕服务已可启动！")
    else:
        print("💡 尚有模型未下载。可运行 `./scripts/download_subtitle_models.sh --all` 一键清理旧模型并下载。")
    print("================================================================================\n")
    return all_ready


def fetch_repo_tree_files(repo: str, dst_prefix: str, mirror_url: str):
    """通过 HuggingFace Tree API 动态获取仓库完整文件列表，确保 CoreML bundle 无遗漏"""
    api_url = f"{mirror_url}/api/models/{repo}/tree/main?recursive=true"
    req = urllib.request.Request(
        api_url,
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            items = json.loads(resp.read().decode("utf-8"))
            files = []
            for item in items:
                if item.get("type") != "file":
                    continue
                path = item.get("path", "")
                if not path or path.startswith(".") or path.endswith(".md") or path == "LICENSE":
                    continue
                size = int(item.get("size") or 0)
                files.append(
                    {
                        "src": path,
                        "dst": f"{dst_prefix}/{path}" if dst_prefix else path,
                        "min_bytes": max(1, int(size * 0.95)) if size > 0 else 1,
                        "expected_mb": size / (1024 * 1024) if size > 0 else 0.01,
                        "optional": False,
                    }
                )
            if files:
                return files
    except Exception:
        pass
    return None


def download_single_file(
    repo: str,
    src_path: str,
    dst_path: str,
    min_bytes: int,
    expected_mb: float,
    mirror_url: str,
    optional: bool = False,
):
    full_dst = os.path.join(TARGET_DIR, dst_path)
    if check_file_ready(dst_path, min_bytes):
        print(f"  [跳过] 已存在且完整: {dst_path} ({format_size(os.path.getsize(full_dst))})")
        return True

    os.makedirs(os.path.dirname(full_dst), exist_ok=True)
    part_path = full_dst + ".part"

    download_url = f"{mirror_url}/{repo}/resolve/main/{src_path}"
    print(f"\n📥 正在下载: {dst_path}")
    print(f"   源地址: {download_url}")

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
                total_bytes = (
                    (int(content_len) + existing_bytes)
                    if content_len
                    else int(expected_mb * 1024 * 1024)
                )

                mode = "ab" if (existing_bytes > 0 and code == 206) else "wb"
                if mode == "wb":
                    existing_bytes = 0

                downloaded = existing_bytes
                start_time = time.time()
                last_update = 0

                with open(part_path, mode) as f:
                    while True:
                        chunk = resp.read(256 * 1024)
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
                            eta_sec = (
                                (total_bytes - downloaded) / max(1, speed)
                                if total_bytes > downloaded
                                else 0
                            )
                            eta_str = f"{int(eta_sec // 60)}m{int(eta_sec % 60):02d}s"

                            bar_len = 25
                            filled = int(bar_len * min(100.0, pct) / 100)
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
        except urllib.error.HTTPError as e:
            sys.stdout.write("\n")
            if e.code == 404 and optional:
                print(f"   [可选文件不存在，跳过]: {dst_path}")
                if os.path.exists(part_path):
                    os.remove(part_path)
                return True
            print(f"   ⚠ HTTP {e.code} 下载中断 ({attempt}/{max_retries}): {e}")
        except Exception as e:
            sys.stdout.write("\n")
            print(f"   ⚠ 下载中断 ({attempt}/{max_retries}): {e}")

        if attempt < max_retries:
            time.sleep(2)
            existing_bytes = os.path.getsize(part_path) if os.path.exists(part_path) else 0
            headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
            if existing_bytes > 0:
                headers["Range"] = f"bytes={existing_bytes}-"
            req = urllib.request.Request(download_url, headers=headers)

    return optional


def download_model(key: str, mirror_url: str):
    spec = MODEL_SPECS.get(key)
    if not spec:
        print(f"未知模型标识: {key}")
        return False
    print(f"\n=======================================================")
    print(f"  开始拉取: {spec['title']}")
    print(f"=======================================================")

    files_to_download = spec["files"]
    if spec.get("use_repo_tree"):
        dynamic_files = fetch_repo_tree_files(spec["repo"], spec.get("dst_prefix", ""), mirror_url)
        if dynamic_files:
            files_to_download = dynamic_files

    for f in files_to_download:
        ok = download_single_file(
            spec["repo"],
            f["src"],
            f["dst"],
            f["min_bytes"],
            f["expected_mb"],
            mirror_url,
            optional=f.get("optional", False),
        )
        if not ok:
            print(f"❌ {f['dst']} 下载失败！")
            return False
    return True


def main():
    parser = argparse.ArgumentParser(description="SimpleUI 实时双语字幕三级流式模型下载与清理管理器")
    parser.add_argument("--status", action="store_true", help="查看所有模型下载就绪状态")
    parser.add_argument("--clean", action="store_true", help="清理已废弃的旧模型与 .part 残留缓存")
    parser.add_argument("--all", action="store_true", help="清理旧模型并下载全部缺失模型 (国内镜像源)")
    parser.add_argument("--model", choices=["vad", "asr", "translate"], help="下载指定环节的模型")
    parser.add_argument(
        "--official",
        action="store_true",
        help="使用官方 HuggingFace 源 (默认使用国内镜像源 hf-mirror.com)",
    )
    args = parser.parse_args()

    mirror = OFFICIAL_BASE if args.official else MIRROR_BASE

    if args.clean:
        clean_legacy_and_temp()
        if not args.all and not args.model and not args.status:
            print_status_table()
            return

    if args.status or (not args.all and not args.model):
        print_status_table()
        if not args.all and not args.model:
            print("快捷用法:")
            print("  ./scripts/download_subtitle_models.sh --all            # 自动清理旧模型并下载全部 3 个流式模型")
            print("  ./scripts/download_subtitle_models.sh --clean          # 仅清理废弃的旧模型与临时碎片")
            print("  ./scripts/download_subtitle_models.sh --model asr      # 仅下载 Nemotron CoreML 流式语音模型")
            print("  ./scripts/download_subtitle_models.sh --model translate # 仅下载 Index-Translate 翻译模型")
            return

    if args.all:
        clean_legacy_and_temp()
        print_status_table()
        order = ["vad", "asr", "translate"]
        for k in order:
            success = download_model(k, mirror)
            if not success:
                print(f"\n❌ 模型 {k} 下载中断，请检查网络后重新执行。支持断点续传。")
                sys.exit(1)
        print("\n🎉 全部三级流式模型准备完成！")
        print_status_table()

    elif args.model:
        success = download_model(args.model, mirror)
        if success:
            print_status_table()
        else:
            sys.exit(1)


if __name__ == "__main__":
    main()
