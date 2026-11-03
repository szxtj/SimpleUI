#!/usr/bin/env bash

# ==============================================================================
# 📖 Maple MLX 运行时管理脚本（mlx-lm OpenAI 兼容服务）
#
# 与 ttf_server.sh / mference_server.sh 同一套「受管服务」约定：
#   start / stop / restart / status / logs / help
#
# 运行时与权重都由 SimpleUI 托管：
#   运行时（随包内置，~363MB; Resources/server/maple-mlx）: $MAPLE_RUNTIME_DIR
#   权重（2-bit MLX，5.31GB，按需下载）                    : $MAPLE_MODEL_DIR
#
# 注意：这里的 Python 是随包固化的完整运行时（scripts/build_maple_runtime.sh 预构建），
#       mlx-lm 与原生 Maple kernel 已内置 —— 首次使用无需 uv、无需联网。
#       仅开发机未构建 bin/maple_runtime 时才回落到下载器现场装配的 venv。
# ==============================================================================

CONFIG_ENV_FILE="${MAPLE_CONFIG_FILE:-$HOME/Library/Application Support/SimpleUI/maple_mlx.env}"
if [ -f "$CONFIG_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_ENV_FILE"
fi

SUPPORT_DIR="$HOME/Library/Application Support/SimpleUI"

# 1. 监听端口（1242：与 TTF 1235 / Mference 1241 / ASR 1236 / 字幕 1249-1250 错开）
PORT="${MAPLE_PORT:-1242}"

# 2. 运行时与权重目录
RUNTIME_DIR="${MAPLE_RUNTIME_DIR:-$SUPPORT_DIR/runtimes/maple-mlx}"
MODEL_DIR="${MAPLE_MODEL_DIR:-$SUPPORT_DIR/models/maple-preview-2bit-mlx}"

# 3. 生成默认值（与 SimpleUI 设置面板的默认项一致）
#    Maple 的 chat template 会先开 <think> 思考块：实测长推理能烧掉 2000+ tokens，
#    预算给小了会「只有思考、没有答案」（finish=length），所以默认给 4096
# 服务级上限只是兜底：App 每次请求都会带自己的 max_tokens（= 上下文的 50%）
MAX_TOKENS=4096
# 官方/社区推荐采样默认。仅为进程兜底：App 每次请求都会带自己的采样参数
# （温度/top-p/top-k/min-p/重复惩罚在「Chat Model → Maple」里调）。
TEMPERATURE=1.0
TOP_P=0.95
TOP_K=40
# 官方/社区推荐采样：min_p 过滤低概率 token
MIN_P=0.05

# 4. 性能项
#    flash-head: 官方近似采样头，实测 159 → 209 tok/s（M4 16GB）
FLASH_HEAD="${MAPLE_FLASH_HEAD:-on}"
#    prompt cache: 保留最近 N 个 prompt 的 KV，多轮对话免重复 prefill
PROMPT_CACHE_SIZE="${MAPLE_PROMPT_CACHE_SIZE:-4}"
#    prefill 分块：2840 token 的 prompt 在 2048 下最快
PREFILL_STEP_SIZE="${MAPLE_PREFILL_STEP_SIZE:-2048}"

LOG_FILE="${MAPLE_LOG_FILE:-$HOME/Library/Logs/maple-mlx.log}"
PID_FILE="/tmp/maple_mlx_server.pid"
PYTHON="$RUNTIME_DIR/bin/python"
PROJECT_URL="https://github.com/deepgrove-ai/mlx-lm-deepgrove"

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
        echo "⚠️  Maple MLX 服务已在运行中 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
        exit 0
    fi

    # 1. 运行时（venv）是否存在
    if [ ! -x "$PYTHON" ]; then
        echo "❌ 未找到 Maple 运行时: $PYTHON"
        echo "   请在「设置 → 服务管理 → 基础模型服务 → Maple MLX」点「下载运行时」。"
        exit 1
    fi

    # 2. 权重是否完整（config.json + 至少一个 safetensors 分片）
    if [ ! -f "$MODEL_DIR/config.json" ]; then
        echo "❌ 未找到 Maple 权重: $MODEL_DIR"
        echo "   请在「设置 → 服务管理 → 基础模型服务 → Maple MLX」点「下载模型」。"
        exit 1
    fi
    if ! ls "$MODEL_DIR"/model-*.safetensors >/dev/null 2>&1; then
        echo "❌ 权重分片缺失: $MODEL_DIR/model-*.safetensors"
        exit 1
    fi

    # 3. 端口被别的进程占着时不要硬抢
    if probe && ! is_running; then
        echo "❌ 端口 $PORT 已被其他进程占用，请先释放或改端口。"
        exit 1
    fi

    mkdir -p "$(dirname "$LOG_FILE")"

    local head_flags="--flash-head"
    [ "$FLASH_HEAD" = "off" ] && head_flags="--no-flash-head"

    echo "🚀 正在后台启动 Maple MLX 服务..."
    echo "   ├─ 端口: $PORT"
    echo "   ├─ 运行时: $RUNTIME_DIR"
    echo "   ├─ 模型: $MODEL_DIR"
    echo "   ├─ 最大生成: $MAX_TOKENS tokens"
    echo "   ├─ 采样: temp=$TEMPERATURE top_p=$TOP_P top_k=$TOP_K min_p=$MIN_P"
    echo "   ├─ 近似采样头: $FLASH_HEAD"
    echo "   └─ prompt 缓存: $PROMPT_CACHE_SIZE 份"

    # shellcheck disable=SC2086
    nohup "$PYTHON" -m mlx_lm.server \
        --model "$MODEL_DIR" \
        --host 127.0.0.1 \
        --port "$PORT" \
        --trust-remote-code \
        $head_flags \
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

    # 首次加载要把 6.5GB 权重读进统一内存，实测 ~9s，低配机留足 90s
    echo -n "⏳ 等待服务初始化..."
    local waited=0
    while [ $waited -lt 90 ]; do
        sleep 1
        waited=$((waited + 1))
        echo -n "."
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        if probe; then
            echo ""
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
        echo "🛑 正在停止 Maple MLX 服务 (PID: $pid)..."
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
    # 兜底：只清理「命令行里同时含 mlx_lm.server 与本端口」的残留进程，
    # 绝不用裸 pkill -x python（会误伤用户其它 Python 进程）。
    local residual
    residual=$(pgrep -f "mlx_lm\.server.*--port $PORT" 2>/dev/null | head -1)
    if [ -n "$residual" ]; then
        echo "🛑 正在清理残留的 Maple MLX 进程 (PID: $residual)..."
        kill -9 "$residual" 2>/dev/null
        echo "✅ 残留进程已清理。"
    else
        echo "⚠️  未发现正在运行的 Maple MLX 服务。"
    fi
}

restart() {
    echo "🔄 正在重启 Maple MLX 服务..."
    stop
    sleep 1
    start
}

status() {
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        echo "🟢 Maple MLX 正在运行 (PID: $pid)"
        echo "   ├─ 端口: $PORT"
        echo "   ├─ 日志: $LOG_FILE"
        if probe; then
            echo "   └─ 健康状态: 在线 (OK)"
        else
            echo "   └─ 健康状态: 加载中 / 尚未响应"
        fi
    else
        echo "🔴 Maple MLX 未在运行"
    fi
}

logs() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "⚠️  日志文件尚不存在: $LOG_FILE"
        exit 1
    fi
    echo "📄 查看实时日志 (Ctrl + C 退出):"
    tail -f "$LOG_FILE"
}

help() {
    echo "📖 Maple MLX 服务管理脚本:"
    echo "   ./maple_mlx_server.sh start    - 后台启动推理服务"
    echo "   ./maple_mlx_server.sh stop     - 停止推理服务"
    echo "   ./maple_mlx_server.sh restart  - 重启推理服务"
    echo "   ./maple_mlx_server.sh status   - 查看运行状态"
    echo "   ./maple_mlx_server.sh logs     - 跟踪实时日志"
    echo "   ./maple_mlx_server.sh help     - 打印帮助"
    echo ""
    echo "   运行时/权重请先由 SimpleUI 设置面板下载；本项目页: $PROJECT_URL"
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    logs)    logs ;;
    help|--help|-h) help ;;
    *)
        echo "❌ 未知指令: $1"
        help
        exit 1
        ;;
esac
