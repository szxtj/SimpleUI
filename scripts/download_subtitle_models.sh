#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "  🚀 SimpleUI 实时双语字幕方案 — 专属模型下载管理器"
echo "  🌐 默认镜像源: https://hf-mirror.com (国内极速免翻墙)"
echo "=========================================================="

python3 scripts/download_subtitle_models.py "$@"
