#!/usr/bin/env bash

# ==============================================================================
# 📖 Qwen 3.5 9B 问答引擎运行时脚本（mlx-lm OpenAI 兼容服务）
#
# 与 ttf_server.sh / mference_server.sh / maple_mlx_server.sh 同一套「受管服务」约定：
#   start / stop / restart / status / logs / help
#
# 定位：基础模型服务的第 4 个选项 —— **高速、通用问答、默认不推理**。
#   - 权重：mlx-community/Qwen3.5-9B-4bit（5.95GB，按需下载，见 qwen_qa_download.js）
#   - 运行时：**复用 Maple 那套随包 Python**（mlx 0.32 / mlx-lm 0.31.3，自带 qwen3_5 实现），
#     不再单独背一份 300MB+ 的运行时。找不到运行时说明打包缺件，直接报错而不是静默兜底。
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

# 2. 运行时（复用 Maple 的 Python）与权重目录
RUNTIME_DIR="${QWEN_QA_RUNTIME_DIR:-$SUPPORT_DIR/runtimes/maple-mlx}"
MODEL_DIR="${QWEN_QA_MODEL_DIR:-$SUPPORT_DIR/models/qwen35-9b-mlx}"

# 运行时探测顺序：环境变量 → 随包 → 开发态 bin/
PYTHON="${QWEN_QA_PYTHON:-}"
if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
    for candidate in \
        "$RUNTIME_DIR/bin/python" \
        "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/maple-mlx/bin/python" \
        "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/maple_runtime/bin/python"
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            PYTHON="$candidate"
            break
        fi
    done
fi

# 3. 生成与采样默认值
#    服务级只是兜底：App 每次请求都会带自己的 max_tokens / 采样参数
MAX_TOKENS="${QWEN_QA_MAX_TOKENS:-4096}"
TEMPERATURE="${QWEN_QA_TEMPERATURE:-0.7}"
TOP_P="${QWEN_QA_TOP_P:-0.8}"
TOP_K="${QWEN_QA_TOP_K:-20}"
MIN_P="${QWEN_QA_MIN_P:-0}"

# 4. 性能/内存项
#    prompt cache 默认只留 2 份：16GB 机器上 9B 的 KV 缓存才是内存大头
PROMPT_CACHE_SIZE="${QWEN_QA_PROMPT_CACHE_SIZE:-2}"
PREFILL_STEP_SIZE="${QWEN_QA_PREFILL_STEP_SIZE:-2048}"

# 5. 思考开关：这是「问答」引擎，默认关推理；需要时可开
THINKING="${QWEN_QA_THINKING:-off}"
CHAT_TEMPLATE_ARGS='{"enable_thinking":false}'
[ "$THINKING" = "on" ] && CHAT_TEMPLATE_ARGS='{"enable_thinking":true}'

LOG_FILE="${QWEN_QA_LOG_FILE:-$HOME/Library/Logs/qwen-qa.log}"
PID_FILE="/tmp/qwen_qa_server.pid"
PROJECT_URL="https://github.com/ml-explore/mlx-lm"
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
    echo "   ├─ 运行时: $(dirname "$(dirname "$PYTHON")")"
    echo "   ├─ 模型: $MODEL_DIR"
    echo "   ├─ 最大生成: $MAX_TOKENS tokens"
    echo "   ├─ 采样: temp=$TEMPERATURE top_p=$TOP_P top_k=$TOP_K min_p=$MIN_P"
    echo "   └─ 思考模式: $THINKING（$CHAT_TEMPLATE_ARGS）"

    nohup "$PYTHON" -m mlx_lm server \
        --model "$MODEL_DIR" \
        --host 127.0.0.1 \
        --port "$PORT" \
        --trust-remote-code \
        --chat-template-args "$CHAT_TEMPLATE_ARGS" \
        --max-tokens "$MAX_TOKENS" \
        --temp "$TEMPERATURE" \
        --top-p "$TOP_P" \
        --top-k "$TOP_K" \
        --min-p "$MIN_P" \
        --prompt-cache-size "$PROMPT_CACHE_SIZE" \
        --prefill-step-size "$PREFILL_STEP_SIZE" \
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
            curl -s --noproxy '*' -m 60 -o /dev/null \
                -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
                -H 'Content-Type: application/json' \
                -d '{"model":"default_model","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}' &
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
    # 兜底：只清理「命令行里同时含 mlx_lm + 本引擎端口」的残留进程，
    # 绝不用裸 pkill -x python（会误伤 Maple 或用户自己的 Python 进程）。
    local residual
    residual=$(pgrep -f "mlx_lm(\.server)? server.*--port $PORT" 2>/dev/null | head -1)
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

  start    后台启动 mlx_lm server（默认端口 $PORT）
  stop     停止服务（先 SIGTERM，20s 未退再 SIGKILL）
  restart  重启
  status   运行状态 + 健康检查
  logs     查看运行日志

模型: $MODEL_REPO
运行时: 复用 Maple 的 Python（mlx-lm），无需单独安装
项目: $PROJECT_URL
EOF
        ;;
esac
