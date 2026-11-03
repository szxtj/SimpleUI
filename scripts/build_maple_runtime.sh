#!/usr/bin/env bash
# ==============================================================================
# 📖 构建 Maple MLX 随包运行时（bin/maple_runtime）
#
# 产出一份「完全自包含、可重定位」的 Python 运行时：
#   - 底座复用 bin/tts_runtime/python（python-build-standalone 全量安装，
#     已在 TTS/OCR 上验证可重定位；剥掉 TTS 的 site-packages，只留标准库）
#   - 叠加 Maple 的 site-packages（mlx-lm deepgrove fork + 原生内核，
#     来源是本机已装配好的 venv：~/Library/.../runtimes/maple-mlx）
#   - 写 .ready 标记（与 MapleRuntimeInstaller.ready() 的判定对齐）
#
# 一次性构建工具（开发机执行）；build_mac_app.sh 会把产物拷进
# Contents/Resources/server/maple-mlx。打包后 Maple 首次使用不再需要
# uv / 联网装依赖 —— 满足「运行时完全内置，权重用户下载」。
# ==============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_BASE="$PROJECT_ROOT/bin/tts_runtime/python"
SRC_VENV="${MAPLE_SRC_VENV:-$HOME/Library/Application Support/SimpleUI/runtimes/maple-mlx}"
DST="$PROJECT_ROOT/bin/maple_runtime"

[ -x "$SRC_BASE/bin/python3" ] || { echo "❌ 缺少 TTS python 底座: $SRC_BASE"; exit 1; }
[ -d "$SRC_VENV/lib/python3.12/site-packages" ] || { echo "❌ 缺少 Maple venv: $SRC_VENV（先在 App 里完成一次运行时装配）"; exit 1; }

echo "  · 清理旧产物..."
# rm -rf 会被 safe-delete 批量拦截：转存到 /tmp 再新建（项目既定惯例）
if [ -d "$DST" ]; then
    STALE="/tmp/simpleui_maple_runtime_stale_$(date +%s)"
    mv "$DST" "$STALE" && echo "    旧产物已转存: $STALE"
fi
mkdir -p "$DST"

echo "  · 复制 python 底座（剥掉 TTS site-packages）..."
mkdir -p "$DST/bin" "$DST/lib/python3.12" "$DST/share"
cp -R "$SRC_BASE/bin/." "$DST/bin/"
# 标准库 = lib/python3.12 下除 site-packages 外的一切
for entry in "$SRC_BASE/lib/python3.12/"*; do
    name="$(basename "$entry")"
    [ "$name" = "site-packages" ] && continue
    cp -R "$entry" "$DST/lib/python3.12/"
done
[ -d "$SRC_BASE/lib/python3.12/site-packages" ] && rm -rf "$DST/lib/python3.12/site-packages"
# TTS 的 lib/python3.12 之外可能还有 app-specific 目录（如 tk），整层兜底复制但排除 site-packages
for entry in "$SRC_BASE/lib/"*; do
    name="$(basename "$entry")"
    [ "$name" = "python3.12" ] && continue
    cp -R "$entry" "$DST/lib/" 2>/dev/null || true
done

echo "  · 叠加 Maple site-packages（mlx-lm fork + 原生内核）..."
cp -R "$SRC_VENV/lib/python3.12/site-packages" "$DST/lib/python3.12/site-packages"

echo "  · 无损瘦身（__pycache__ / *.pyc / 测试套件）..."
find "$DST" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DST" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true
find "$DST/lib/python3.12/site-packages" -type d \( -name "tests" -o -name "test" \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$DST/lib/python3.12/site-packages"/{include,share/man,share/doc} 2>/dev/null || true

echo "  · 写 .ready 标记..."
date +%s > "$DST/.ready"

echo "  · 校验关键 import..."
"$DST/bin/python3" - <<'PYEOF'
import sys
from importlib.metadata import version
assert sys.version_info[:2] == (3, 12), sys.version
import mlx
import mlx_lm
import mlx_lm_maple  # Maple 原生内核
import transformers
import numpy
print(f"    python={sys.version.split()[0]} mlx={version('mlx')} "
      f"mlx_lm={version('mlx_lm')} transformers={version('transformers')}")
print("    ✅ 全部 import 通过")
PYEOF

echo "  · 校验 mlx_lm.server 入口..."
"$DST/bin/python3" -m mlx_lm.server --help >/dev/null 2>&1 || "$DST/bin/python3" -m mlx_lm.server --help 2>&1 | head -3

du -sh "$DST" | awk '{print "✅ bin/maple_runtime 构建完成: " $1}'
