#!/usr/bin/env bash

# ==============================================================================
# 📖 MferenceServer 管理脚本
#
# 常用命令:
#    - 启动服务: ./mference_server.sh start   (或直接 ./mference_server.sh)
#    - 停止服务: ./mference_server.sh stop
#    - 重启服务: ./mference_server.sh restart
#    - 运行状态: ./mference_server.sh status
#    - 实时日志: ./mference_server.sh logs    (按 Ctrl + C 退出查看)
#    - 帮助信息: ./mference_server.sh help
#
# ⚙️ MferenceServer 运行配置区
# ==============================================================================

# 加载环境变量文件（若存在）
CONFIG_ENV_FILE="${MFERENCE_CONFIG_FILE:-$HOME/Library/Application Support/Mference/config.env}"
if [ -f "$CONFIG_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_ENV_FILE"
fi

# 1. 监听端口 (默认: 1241)
PORT=1241
PORT="${MFERENCE_PORT:-${PORT:-1241}}"

# 2. 最大上下文长度 (支持: 4096, 8192, 16384, 32768, 65536, 128000)
#    - 16384 (16K): 官方默认值，日常多轮对话与统一内存占用平衡
#    - 32768 (32K): 推荐值，适合长文本分析
#    - 65536 (64K) / 128000 (128K): 进阶超长上下文
MAX_CONTEXT=16384
MAX_CONTEXT="${MFERENCE_MAX_CONTEXT:-${MAX_CONTEXT:-16384}}"

# 3. 投机性专家预取深度 (shadow-budget, 支持 0...8)
#    - 4: 针对 16GB~24GB Mac 统一内存的推荐预取深度
#    - 0: 关闭预取
SHADOW_BUDGET=4
SHADOW_BUDGET="${MFERENCE_SHADOW_BUDGET:-${SHADOW_BUDGET:-4}}"

# 4. KV 缓存复用模式 (支持: single-prefix 开启单前缀复用, off 关闭)
PROMPT_CACHE_MODE="single-prefix"
PROMPT_CACHE_MODE="${MFERENCE_PROMPT_CACHE_MODE:-${PROMPT_CACHE_MODE:-single-prefix}}"

# 5. 模型完整性校验策略 (支持: auto, full-sha256, trusted-receipt)
VERIFY="auto"
VERIFY="${MFERENCE_VERIFY:-${VERIFY:-auto}}"

# 6. 请求队列上限 (默认: 4)
QUEUE_LIMIT=4
QUEUE_LIMIT="${MFERENCE_QUEUE_LIMIT:-${QUEUE_LIMIT:-4}}"

# 7. Prefill Chunk 大小环境变量 (针对 16GB+ 设备加速长 prompt 吞吐)
PREFILL_CHUNK="${MFERENCE_PREFILL_CHUNK:-2048}"
export MFERENCE_SERVER_PREFILL_CHUNK="$PREFILL_CHUNK"

# 8. 路径与本体配置 (默认指向 ~/Mference)
DEFAULT_DIR="$HOME/Mference"
MFERENCE_DIR="${MFERENCE_DIR:-$DEFAULT_DIR}"

# 展开波浪号 ~
if [[ "$MFERENCE_DIR" == ~* ]]; then
    MFERENCE_DIR="${MFERENCE_DIR/#~/$HOME}"
fi

# 若指定目录为符号链接，自动内部解析至物理真实链接目标
if [ -L "$MFERENCE_DIR" ]; then
    MFERENCE_DIR="$(cd -P "$MFERENCE_DIR" 2>/dev/null && pwd -P)"
fi

PROJECT_DIR="$MFERENCE_DIR"
MODEL_PATH="${MFERENCE_MODEL_PATH:-$PROJECT_DIR/scratch/qwen36.gturbo}"
LOG_FILE="$HOME/Library/Logs/mference.log"
PID_FILE="/tmp/mference_server.pid"
BINARY="$PROJECT_DIR/.build/release/MferenceServer"
PROJECT_URL="https://github.com/justinxie/Mference"

# ==============================================================================

# 检查进程是否真实存活
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

start() {
    if is_running; then
        echo "⚠️  MferenceServer 已经在后台运行中 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
        exit 0
    fi

    # 1. 检查是否存在同名/冲突的模型进程（遵守 Mference 安全规范）
    CONFLICT_PATTERN='(^|/)(MferenceServer|MferenceCLI|MferenceRepack|MferencePackageTests|swiftpm-testing-helper|mlx_lm|mlx-lm)( |$)'
    if pgrep -fl "$CONFLICT_PATTERN" >/dev/null 2>&1; then
        echo "⚠️  检测到已有冲突模型进程正在运行，尝试清理残留..."
        pkill -f "$CONFLICT_PATTERN" 2>/dev/null || true
        sleep 1
    fi

    # 2. 前置检查：本体仓库是否存在
    if [ ! -f "$PROJECT_DIR/Package.swift" ]; then
        echo "❌ 未找到 Mference 本体: $PROJECT_DIR"
        exit 1
    fi

    # 3. 前置检查：模型权重是否存在
    if [[ ! -d "$MODEL_PATH" || ! -f "$MODEL_PATH/manifest.json" ]]; then
        echo "❌ 未找到已完成下载的 Qwen 3.6 模型: $MODEL_PATH"
        exit 1
    fi

    # 4. 确保日志所在目录存在
    mkdir -p "$(dirname "$LOG_FILE")"

    # 5. 检查二进制是否存在，若无则自动编译
    if [ ! -f "$BINARY" ]; then
        echo "📦 正在编译发布版本 MferenceServer..."
        (cd "$PROJECT_DIR" && swift build -c release --product MferenceServer)
        if [ $? -ne 0 ] || [ ! -f "$BINARY" ]; then
            echo "❌ 编译失败，请检查编译输出与环境设置。"
            exit 1
        fi
    fi

    echo "🚀 正在后台启动 Mference 服务 (Qwen 3.6)..."
    echo "   ├─ 端口: $PORT"
    echo "   ├─ 上下文: $MAX_CONTEXT"
    echo "   ├─ 预取深度 (shadow-budget): $SHADOW_BUDGET"
    echo "   ├─ 缓存复用: $PROMPT_CACHE_MODE"
    echo "   ├─ Prefill 分块: $PREFILL_CHUNK"
    echo "   ├─ 校验策略: $VERIFY"
    echo "   └─ 模型路径: $MODEL_PATH"

    nohup "$BINARY" \
        --model "$MODEL_PATH" \
        --port "$PORT" \
        --bind loopback \
        --max-context "$MAX_CONTEXT" \
        --prompt-cache-mode "$PROMPT_CACHE_MODE" \
        --shadow-budget "$SHADOW_BUDGET" \
        --verify "$VERIFY" \
        --queue-limit "$QUEUE_LIMIT" > "$LOG_FILE" 2>&1 &

    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 等待并探测进程就绪
    echo -n "⏳ 等待服务初始化..."
    local waited=0
    local ready=0
    while [ $waited -lt 15 ]; do
        sleep 1
        waited=$((waited + 1))
        echo -n "."
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        # 尝试通过 HTTP 探针确认就绪 (/health 或 /v1/models)
        if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
            ready=1
            break
        fi
    done
    echo ""

    if is_running; then
        echo "✅ 服务启动成功！"
        echo "📍 API Base URL: http://127.0.0.1:$PORT/v1"
        echo "📄 运行日志: $LOG_FILE"
        echo "🧪 测试命令:"
        echo "   curl http://127.0.0.1:$PORT/v1/chat/completions \\"
        echo "     -H 'Content-Type: application/json' \\"
        echo "     -d '{\"model\":\"qwen3.6-35b-a3b\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}'"
    else
        echo "❌ 服务未能正常运行，请查看最后 20 行日志排查错误:"
        echo "----------------------------------------"
        tail -n 20 "$LOG_FILE" 2>/dev/null || true
        echo "----------------------------------------"
        rm -f "$PID_FILE"
        exit 1
    fi
}

stop() {
    local pid=""
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE" 2>/dev/null)
    fi

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "🛑 正在停止 MferenceServer (PID: $pid)..."
        kill -15 "$pid" 2>/dev/null

        local waited=0
        while kill -0 "$pid" 2>/dev/null && [ $waited -lt 10 ]; do
            sleep 0.5
            waited=$((waited + 1))
        done

        if kill -0 "$pid" 2>/dev/null; then
            echo "⚠️  服务未能及时退出，执行强制终止 (SIGKILL)..."
            kill -9 "$pid" 2>/dev/null
        fi
        rm -f "$PID_FILE"
        echo "✅ 服务已成功停止。"
    else
        # 兜底清理
        if pgrep -x "MferenceServer" >/dev/null 2>&1; then
            echo "🛑 正在清理残留的 MferenceServer 进程..."
            pkill -x "MferenceServer" 2>/dev/null
            rm -f "$PID_FILE"
            echo "✅ 残留进程已清理完毕。"
        else
            echo "⚠️  未发现正在运行的 MferenceServer 服务。"
            rm -f "$PID_FILE"
        fi
    fi
}

restart() {
    echo "🔄 正在重启 Mference 服务..."
    stop
    sleep 1
    start
}

status() {
    if is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        echo "🟢 MferenceServer 正在运行中 (PID: $pid)"
        echo "   ├─ 端口: $PORT"
        echo "   ├─ 日志: $LOG_FILE"
        if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
            echo "   └─ 健康状态: 在线 (OK)"
        else
            echo "   └─ 健康状态: 加载中 / 尚未响应"
        fi
    else
        echo "🔴 MferenceServer 未在运行"
    fi
}

logs() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "⚠️  日志文件尚不存在: $LOG_FILE"
        exit 1
    fi
    echo "📄 查看实时运行日志 (Ctrl + C 退出):"
    tail -f "$LOG_FILE"
}

help() {
    echo "📖 MferenceServer 管理脚本使用说明:"
    echo "   ./mference_server.sh start    - 后台启动推理服务"
    echo "   ./mference_server.sh stop     - 优雅停止推理服务"
    echo "   ./mference_server.sh restart  - 重启推理服务"
    echo "   ./mference_server.sh status   - 查看当前运行状态"
    echo "   ./mference_server.sh logs     - 跟踪查看实时日志"
    echo "   ./mference_server.sh help     - 打印此帮助信息"
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
