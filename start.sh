#!/usr/bin/env bash

# ==============================================================================
# 🚀 TurboFieldfare Chat 启动脚本
# ==============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PORT="${PORT:-3000}"
TURBO_API="${TURBO_API_URL:-http://127.0.0.1:1235}"

echo "=========================================================="
echo "✨ 启动 TurboFieldfare Chat 现代化知识问答客户端"
echo "=========================================================="

# 1. 探测后端服务状态
echo "🔍 检查 TurboFieldfareServer ($TURBO_API)..."
if curl -s --connect-timeout 2 "$TURBO_API/health" > /dev/null; then
    echo "🟢 TurboFieldfare 服务在线，状态正常。"
else
    echo "⚠️ 提示: 未检测到 $TURBO_API 响应。"
    echo "   如果服务尚未启动，可前往 ~/Projects/turbo-fieldfare 运行 ./server.sh start 启动推理服务。"
fi

# 2. 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装前端依赖..."
    npm install
fi

# 3. 运行模式判断
if [ "$1" = "dev" ]; then
    echo "⚡ 正在以 Vite 开发模式启动 (热重载)..."
    open "http://127.0.0.1:5173" 2>/dev/null || true
    npx vite --host 127.0.0.1
else
    # 生产构建模式
    if [ ! -d "dist" ]; then
        echo "🔨 正在编译静态资源..."
        npm run build
    fi
    echo "🚀 服务运行中: http://127.0.0.1:$PORT"
    open "http://127.0.0.1:$PORT" 2>/dev/null || true
    PORT="$PORT" TURBO_API_URL="$TURBO_API" node server/proxy.js
fi
