#!/usr/bin/env bash

# ==============================================================================
# 📖 Qwen 3.5 9B 问答引擎运行时脚本（mlx-vlm OpenAI 兼容服务 · 支持图片输入）
#
# 与 ttf_server.sh / mference_server.sh / maple_mlx_server.sh 同一套「受管服务」约定：
#   start / stop / restart / status / logs / help
#
# 定位：基础模型服务的第 4 个选项 —— **通用问答 + 图片理解，默认不推理**。
#   - 权重：mlx-community/Qwen3.5-9B-4bit（5.95GB，含完整视觉塔，按需下载，
#     见 qwen_qa_download.js）
#   - 运行时：**随包的 TTS/OCR Python**（mlx-vlm 0.7.9，自带 qwen3_5 实现），
#     与语音合成 / OCR 共用同一份，不单独背运行时。找不到说明打包缺件，直接报错。
#   - 为什么不是 mlx-lm：mlx-lm 是纯文本，Qwen3.5 的视觉塔不会被加载；
#     mlx-vlm 才会把 vision_tower 挂上（实测 image_url 请求返回正确描述）。
#   - 与其它三个引擎严格互斥（由 ttf_service.js 的 ALL_ENGINES 遍历负责）。
# ==============================================================================

CONFIG_ENV_FILE="${QWEN_QA_CONFIG_FILE:-$HOME/Library/Application Support/SimpleUI/qwen_qa.env}"
if [ -f "$CONFIG_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_ENV_FILE"
fi

SUPPORT_DIR="$HOME/Library/Application Support/SimpleUI"

# 1. 监听端口（1243：与 TTF 1235 / Mference 1241 / Maple 1242 / ASR 1236 / 字幕 1249-1250 错开）
PORT="${QWEN_QA_PORT:-1243}"

# 2. 运行时（TTS/OCR 共用的那份 Python，带 mlx-vlm）与权重目录
RUNTIME_DIR="${QWEN_QA_RUNTIME_DIR:-}"
MODEL_DIR="${QWEN_QA_MODEL_DIR:-$SUPPORT_DIR/models/qwen35-9b-mlx}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 运行时探测顺序：环境变量 → 随包 tts/python → 开发态 bin/tts_runtime
# 注意：必须是带 mlx-vlm 的那份（tts/ocr 共用），Maple 的 mlx-lm 运行时跑不了它
PYTHON="${QWEN_QA_PYTHON:-}"
if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
    for candidate in \
        "$SCRIPT_DIR/tts/python/bin/python3" \
        "$SCRIPT_DIR/../bin/tts_runtime/python/bin/python3"
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            PYTHON="$candidate"
            RUNTIME_DIR="$(dirname "$(dirname "$candidate")")"
            break
        fi
    done
fi

# 3. 生成默认值
#    服务级只是兜底：App 每次请求都会带自己的 max_tokens / 采样参数 /
#    enable_thinking（mlx-vlm 的 server 支持请求级思考开关，按会话状态下发）
MAX_TOKENS="${QWEN_QA_MAX_TOKENS:-4096}"
THINKING="${QWEN_QA_THINKING:-off}"

LOG_FILE="${QWEN_QA_LOG_FILE:-$HOME/Library/Logs/qwen-qa.log}"
PID_FILE="/tmp/qwen_qa_server.pid"
PROJECT_URL="https://github.com/Blaizzy/mlx-vlm"
MODEL_REPO="mlx-community/Qwen3.5-9B-4bit"

# ==============================================================================

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

probe() {
    curl -s --noproxy '*' -m 1 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1
}

start() {
    if is_running; then
        echo "⚠️  Qwen 3.5 9B 服务已在运行中 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
        exit 0
    fi

    # 1. 运行时
    if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
        echo "❌ 未找到 MLX 运行时（应与 Maple MLX 共用同一份 Python）"
        echo "   已尝试: $RUNTIME_DIR/bin/python"
        echo "   请重新执行 ./build_mac_app.sh install（运行时随包分发）。"
        exit 1
    fi

    # 2. 权重完整性：config.json + 至少一个 safetensors 分片 + 量化配置
    if [ ! -f "$MODEL_DIR/config.json" ]; then
        echo "❌ 未找到 Qwen 3.5 9B 权重: $MODEL_DIR"
        echo "   请在「设置 → 服务管理 → 基础模型服务 → Qwen 3.5 9B」点「下载模型」。"
        exit 1
    fi
    if ! ls "$MODEL_DIR"/*.safetensors >/dev/null 2>&1; then
        echo "❌ 权重分片缺失: $MODEL_DIR/*.safetensors"
        exit 1
    fi

    # 3. 端口被别的进程占着时不要硬抢
    if probe && ! is_running; then
        echo "❌ 端口 $PORT 已被其他进程占用，请先释放或改端口。"
        exit 1
    fi

    mkdir -p "$(dirname "$LOG_FILE")"

    echo "🚀 正在后台启动 Qwen 3.5 9B 问答服务..."
    echo "   ├─ 端口: $PORT"
    echo "   ├─ 运行时: $RUNTIME_DIR（mlx-vlm，与 TTS/OCR 共用）"
    echo "   ├─ 模型: $MODEL_DIR（含视觉塔，支持图片输入）"
    echo "   ├─ 最大生成: $MAX_TOKENS tokens"
    echo "   └─ 思考模式: $THINKING（可被每条消息的 enable_thinking 覆盖）"

    nohup "$PYTHON" -m mlx_vlm.server \
        --model "$MODEL_DIR" \
        --host 127.0.0.1 \
        --port "$PORT" \
        --max-tokens "$MAX_TOKENS" \
        --log-level INFO > "$LOG_FILE" 2>&1 &

    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 9B / 4bit ≈ 6GB 权重读进统一内存，M4 上实测 8~15s；低配/磁盘冷留足 120s
    echo -n "⏳ 等待服务初始化..."
    local waited=0
    while [ $waited -lt 120 ]; do
        sleep 1
        waited=$((waited + 1))
        echo -n "."
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        if probe; then
            echo ""
            # Metal/graph 预热：这份 mlx-lm 没有暴露 --compile，kernel 是懒编译的，
            # 启动后第一条真实消息要多付 ~2.4s 的编译开销（实测 2.37s）。
            # 这里在后台发一条 1 token 的迷你请求，把 prefill/decode 两条路径的
            # kernel 先编译好 —— 冷请求的代价就不落在用户第一条消息上。
            # （失败不阻塞启动：预热只是省时间，不是服务可用的前提）
            curl -s --noproxy '*' -m 90 -o /dev/null \
                -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
                -H 'Content-Type: application/json' \
                -d "{\"model\":\"$MODEL_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1,\"stream\":false,\"enable_thinking\":false}" &
            echo "✅ 服务启动成功！"
            echo "📍 API Base URL: http://127.0.0.1:$PORT/v1"
            echo "📄 运行日志: $LOG_FILE"
            return 0
        fi
    done

    echo ""
    if is_running; then
        echo "⚠️  进程已起但健康检查未通过，请查看日志: $LOG_FILE"
        return 0
    fi

    echo "❌ 服务未能正常运行，最后 20 行日志:"
    echo "----------------------------------------"
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
    echo "----------------------------------------"
    rm -f "$PID_FILE"
    exit 1
}

stop() {
    local pid=""
    [ -f "$PID_FILE" ] && pid=$(cat "$PID_FILE" 2>/dev/null)

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "🛑 正在停止 Qwen 3.5 9B 服务 (PID: $pid)..."
        kill -15 "$pid" 2>/dev/null

        local waited=0
        while kill -0 "$pid" 2>/dev/null && [ $waited -lt 20 ]; do
            sleep 0.5
            waited=$((waited + 1))
        done

        if kill -0 "$pid" 2>/dev/null; then
            echo "⚠️  服务未能及时退出，执行强制终止 (SIGKILL)..."
            kill -9 "$pid" 2>/dev/null
        fi
        rm -f "$PID_FILE"
        echo "✅ 服务已停止。"
        return 0
    fi

    rm -f "$PID_FILE"
    # 兜底：只清理「命令行里同时含 mlx_vlm.server + 本引擎端口」的残留进程，
    # 绝不用裸 pkill -x python（会误伤 Maple 或用户自己的 Python 进程）。
    local residual
    residual=$(pgrep -f "mlx_vlm\.server.*--port $PORT" 2>/dev/null | head -1)
    if [ -n "$residual" ]; then
        echo "🛑 清理残留进程 (PID: $residual)..."
        kill -9 "$residual" 2>/dev/null
    fi
    echo "ℹ️  服务未在运行。"
}

status() {
    if is_running; then
        echo "✅ Qwen 3.5 9B 运行中 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
        probe && echo "   └─ 健康检查: 通过" || echo "   └─ 健康检查: 未通过（可能仍在加载权重）"
    else
        echo "⛔ Qwen 3.5 9B 未运行"
    fi
    echo "   模型: $MODEL_DIR"
    echo "   日志: $LOG_FILE"
}

case "${1:-help}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; sleep 1; start ;;
    status)  status ;;
    logs)    tail -n "${2:-80}" "$LOG_FILE" 2>/dev/null || echo "暂无日志: $LOG_FILE" ;;
    help|*)
        cat <<EOF
Qwen 3.5 9B 问答引擎（MLX）

用法: $(basename "$0") {start|stop|restart|status|logs [行数]|help}

  start    后台启动 mlx_vlm server（默认端口 $PORT，支持图片输入）
  stop     停止服务（先 SIGTERM，20s 未退再 SIGKILL）
  restart  重启
  status   运行状态 + 健康检查
  logs     查看运行日志

模型: $MODEL_REPO（含视觉塔，支持图片输入）
运行时: 随包 TTS/OCR Python（mlx-vlm 0.7.9），与语音合成/OCR 共用
项目: $PROJECT_URL
EOF
        ;;
esac
