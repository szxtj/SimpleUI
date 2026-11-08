#!/usr/bin/env bash
# 准备「3D 场景构建 · 单图 → GLB」模型的运行时：mlx-serve（MIT，Zig 原生二进制）。
#
# 为什么单独放 bin/ → 不入库：
#   bin/mlxserve 解包后 301MB，其中 lib/mlx.metallib 单文件 213MB，超过 GitHub 单文件
#   100MB 上限。与 bin/tts_runtime（821MB）、bin/maple_runtime（363MB）同策略：
#   **不进仓库**，构建/首次使用前由本脚本拉到 bin/mlxserve/，build_mac_app.sh 再拷进
#   App 包的 Contents/Resources/mlxserve。
#
# 用法：
#   ./scripts/sync_mlxserve.sh            # 缺就下载，已有就跳过
#   ./scripts/sync_mlxserve.sh --force    # 强制重下（版本升级时用）
#
# 环境变量：
#   MLXSERVE_VERSION   发行版 tag（默认 v26.11.2；改这里同时要确认 mlx-serve 仍支持 idol）
#   MLXSERVE_BASE_URL  下载前缀（默认 GitHub Releases；内网可指向镜像）
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="${MLXSERVE_VERSION:-v26.11.2}"
BASE_URL="${MLXSERVE_BASE_URL:-https://github.com/ddalcu/mlx-serve/releases/download}"
ASSET="mlx-serve-bin-macos-arm64.tar.gz"
STAGE="bin/mlxserve"
TARBALL="$(mktemp -t mlxserve).tar.gz"
TMPDIR_EXTRACT="$(mktemp -d)"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "未知参数: $arg" >&2; exit 1 ;;
    esac
done

cleanup() { rm -f "$TARBALL"; rm -rf "$TMPDIR_EXTRACT"; }
trap cleanup EXIT

if [ -x "$STAGE/mlx-serve" ] && [ "$FORCE" -ne 1 ]; then
    echo "✓ 已存在 ${STAGE}/mlx-serve（$(du -sh "${STAGE}" | cut -f1)），跳过"
    exit 0
fi

if [ "$(uname -m)" != "arm64" ]; then
    echo "✗ mlx-serve 发行版只有 macOS arm64 版本（当前 $(uname -m)）" >&2
    exit 1
fi

URL="$BASE_URL/$VERSION/$ASSET"
echo "==> 下载 $URL"

# 沙箱/公司网络里常设 http_proxy：先按环境默认拉，失败再用 --noproxy 直连重试。
if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$TARBALL" "$URL"; then
    echo "   · 默认（可能经代理）失败，改用直连重试"
    curl -fL --noproxy '*' --retry 3 --retry-delay 2 --connect-timeout 20 -o "$TARBALL" "$URL"
fi

echo "==> 解包到 $STAGE"
tar -xzf "$TARBALL" -C "$TMPDIR_EXTRACT"
SRC="$(find "$TMPDIR_EXTRACT" -maxdepth 2 -name mlx-serve -type f -print -quit | xargs -I{} dirname {})"
if [ -z "$SRC" ] || [ ! -f "$SRC/mlx-serve" ]; then
    echo "✗ 压缩包里没找到 mlx-serve（结构变了？）" >&2
    exit 1
fi

mkdir -p "$STAGE"
cp -R "$SRC/." "$STAGE/"
chmod +x "$STAGE/mlx-serve"

# 自检：主程序必须存在，且 lib/ 里的 metallib 也要在（缺了 Metal 内核跑不起来）
if [ ! -x "$STAGE/mlx-serve" ] || [ ! -f "$STAGE/lib/mlx.metallib" ]; then
    echo "✗ 安装不完整：${STAGE} 缺 mlx-serve 或 lib/mlx.metallib" >&2
    exit 1
fi

echo "✓ 完成：${STAGE}（$(du -sh "${STAGE}" | cut -f1)）"
echo "  下一版升级：MLXSERVE_VERSION=vX.Y.Z ./scripts/sync_mlxserve.sh --force"
