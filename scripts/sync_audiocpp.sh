#!/usr/bin/env bash
# 准备「随 App 分发的语音识别与字幕 ASR 运行时」——把 audiocpp_server 与内置 silero VAD
# 同步到 bin/audiocpp/，供 build_mac_app.sh 打进 App 包（Contents/Resources/asr）。
#
# 用法：
#   ./scripts/sync_audiocpp.sh                # 从已有 audio.cpp 构建产物同步
#   ./scripts/sync_audiocpp.sh --build        # 若没有构建产物，则克隆并编译
#
# 环境变量：
#   AUDIOCPP_DIR    audio.cpp 本体目录（默认 ~/audio.cpp）
#   CMAKE_BIN       cmake 可执行文件（默认用 PATH 里的 cmake）
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

AUDIOCPP_DIR="${AUDIOCPP_DIR:-$HOME/audio.cpp}"
CMAKE_BIN="${CMAKE_BIN:-cmake}"
STAGE="bin/audiocpp"
DO_BUILD=0

for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "未知参数: $arg" >&2; exit 1 ;;
    esac
done

VAD_SRC="$AUDIOCPP_DIR/assets/framework/models/silero_vad/silero_vad_16k.safetensors"

# ---------- 1. 必要时克隆 + 编译 ----------
if [ ! -x "$AUDIOCPP_DIR/build/bin/audiocpp_server" ]; then
    if [ "$DO_BUILD" -ne 1 ]; then
        echo "✗ 未找到 $AUDIOCPP_DIR/build/bin/audiocpp_server" >&2
        echo "  先自行编译，或加 --build 让本脚本克隆并编译（需要 cmake）。" >&2
        echo "  提示：macOS 无 libomp 时需关掉 OpenMP，否则 find_package(OpenMP REQUIRED) 会中止配置。" >&2
        exit 1
    fi
    echo "==> 克隆 audio.cpp 到 $AUDIOCPP_DIR"
    [ -d "$AUDIOCPP_DIR/.git" ] || git clone --depth 1 https://github.com/0xShug0/audio.cpp "$AUDIOCPP_DIR"
    echo "==> 配置 audio.cpp (Metal)"
    "$CMAKE_BIN" -S "$AUDIOCPP_DIR" -B "$AUDIOCPP_DIR/build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DENGINE_ENABLE_OPENMP=OFF
    echo "==> 编译 audiocpp_server"
    "$CMAKE_BIN" --build "$AUDIOCPP_DIR/build" --target audiocpp_server --parallel "$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi

# ---------- 2. 同步二进制与 VAD 资源（清理旧模型） ----------
echo "==> 同步运行时到 $STAGE"
rm -rf "$STAGE/models"
mkdir -p "$STAGE/bin" "$STAGE/assets/framework/models/silero_vad"
cp "$AUDIOCPP_DIR/build/bin/audiocpp_server" "$STAGE/bin/"
chmod +x "$STAGE/bin/audiocpp_server"
if [ -f "$VAD_SRC" ]; then
    cp "$VAD_SRC" "$STAGE/assets/framework/models/silero_vad/"
else
    echo "  ⚠ 未找到内置 silero VAD（$VAD_SRC）：audio_chunk_mode=auto/fixed 将不可用" >&2
fi
echo "  -> $(du -sh "$STAGE" | cut -f1)"

echo
echo "✅ 完成。接下来执行 ./build_mac_app.sh install 即可打出自带语音识别运行时的 App。"
