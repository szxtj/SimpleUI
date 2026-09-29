#!/usr/bin/env bash
# 准备「随 App 分发的语音识别运行时」——把 audiocpp_server 与内置 silero VAD
# 同步到 bin/audiocpp/，供 build_mac_app.sh 打进 App 包（Contents/Resources/asr）。
#
# 用法：
#   ./scripts/sync_audiocpp.sh                # 从已有 audio.cpp 构建产物同步
#   ./scripts/sync_audiocpp.sh --build        # 若没有构建产物，则克隆并编译（仅 sense_asr）
#   ./scripts/sync_audiocpp.sh --with-model   # 额外下载 SenseVoice GGUF 到 bin/audiocpp/models/
#                                             # （约 254MB，随包分发时用户装完即可用，无需联网）
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
WITH_MODEL=0

for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=1 ;;
        --with-model) WITH_MODEL=1 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "未知参数: $arg" >&2; exit 1 ;;
    esac
done

MODEL_FILE="sensevoice-small-q8-audiocpp-v1.gguf"
MODEL_URL="https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/$MODEL_FILE"
MODEL_MIRROR="https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/$MODEL_FILE"
VAD_SRC="$AUDIOCPP_DIR/assets/framework/models/silero_vad/silero_vad_16k.safetensors"

# ---------- 1. 必要时克隆 + 编译（仅 sense_asr，显著缩短编译时间）----------
if [ ! -x "$AUDIOCPP_DIR/build/bin/audiocpp_server" ]; then
    if [ "$DO_BUILD" -ne 1 ]; then
        echo "✗ 未找到 $AUDIOCPP_DIR/build/bin/audiocpp_server" >&2
        echo "  先自行编译，或加 --build 让本脚本克隆并编译（需要 cmake）。" >&2
        echo "  提示：macOS 无 libomp 时需关掉 OpenMP，否则 find_package(OpenMP REQUIRED) 会中止配置。" >&2
        exit 1
    fi
    echo "==> 克隆 audio.cpp 到 $AUDIOCPP_DIR"
    [ -d "$AUDIOCPP_DIR/.git" ] || git clone --depth 1 https://github.com/0xShug0/audio.cpp "$AUDIOCPP_DIR"
    echo "==> 配置（custom 模型集，只编 sense_asr）"
    "$CMAKE_BIN" -S "$AUDIOCPP_DIR" -B "$AUDIOCPP_DIR/build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=sense_asr \
        -DENGINE_ENABLE_OPENMP=OFF
    echo "==> 编译 audiocpp_server"
    "$CMAKE_BIN" --build "$AUDIOCPP_DIR/build" --target audiocpp_server --parallel "$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi

# ---------- 2. 同步二进制与 VAD 资源 ----------
echo "==> 同步运行时到 $STAGE"
mkdir -p "$STAGE/bin" "$STAGE/assets/framework/models/silero_vad"
cp "$AUDIOCPP_DIR/build/bin/audiocpp_server" "$STAGE/bin/"
chmod +x "$STAGE/bin/audiocpp_server"
if [ -f "$VAD_SRC" ]; then
    cp "$VAD_SRC" "$STAGE/assets/framework/models/silero_vad/"
else
    echo "  ⚠ 未找到内置 silero VAD（$VAD_SRC）：audio_chunk_mode=auto/fixed 将不可用" >&2
fi
echo "  -> $(du -sh "$STAGE" | cut -f1)"

# ---------- 3. 可选：把模型也放进包里（真正「装完即用」，无需联网）----------
if [ "$WITH_MODEL" -eq 1 ]; then
    mkdir -p "$STAGE/models"
    DEST="$STAGE/models/$MODEL_FILE"
    LOCAL_CACHE="$HOME/Library/Application Support/SimpleUI/models/$MODEL_FILE"
    if [ -f "$DEST" ] && [ "$(stat -f%z "$DEST" 2>/dev/null || echo 0)" -gt 100000000 ]; then
        echo "==> 模型已存在，跳过（$(du -sh "$DEST" | cut -f1)）"
    elif [ -f "$LOCAL_CACHE" ]; then
        echo "==> 复用本地模型缓存（$(du -sh "$LOCAL_CACHE" | cut -f1)）→ $DEST"
        cp "$LOCAL_CACHE" "$DEST"
    else
        echo "==> 下载模型（约 254MB）到 $DEST"
        if ! curl -fL --retry 2 -o "$DEST.part" "$MODEL_URL"; then
            echo "  官方源失败，回退镜像 hf-mirror.com" >&2
            curl -fL --retry 2 -o "$DEST.part" "$MODEL_MIRROR"
        fi
        mv "$DEST.part" "$DEST"
        echo "  -> $(du -sh "$DEST" | cut -f1)"
    fi
fi

echo
echo "✅ 完成。接下来执行 ./build_mac_app.sh install 即可打出自带语音识别运行时的 App。"
[ "$WITH_MODEL" -eq 1 ] || echo "   注：模型未随包。首次使用需在设置页点「下载模型」，或用 --with-model 重新打包。"
