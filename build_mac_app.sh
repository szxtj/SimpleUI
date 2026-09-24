#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

APP_NAME="SimpleUI"
BUNDLE_NAME="SimpleUI.app"
BUILD_DIR="$PROJECT_ROOT/build"
APP_DIR="$BUILD_DIR/$BUNDLE_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "=========================================================="
echo "  🚀 正在构建 $APP_NAME 原生 macOS 桌面应用 (ARM64)"
echo "=========================================================="

# 1. 编译前端静态资源
echo "[1/4] 编译前端 Web 界面..."
npm run build

# 2. 准备 App Bundle 目录结构
echo "[2/4] 创建应用包目录结构..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# 3. 编译 Swift 原生源码
echo "[3/4] 编译 Swift 原生双窗口应用..."
swiftc -O \
    -target arm64-apple-macos12.0 \
    -framework Cocoa \
    -framework WebKit \
    -framework Carbon \
    mac_app/src/main.swift \
    mac_app/src/AppDelegate.swift \
    mac_app/src/HotKeyManager.swift \
    mac_app/src/ProcessManager.swift \
    mac_app/src/MainWindowController.swift \
    mac_app/src/SpotlightPanelController.swift \
    -o "$MACOS_DIR/SimpleUI"

# 拷贝资源
cp mac_app/Resources/Info.plist "$CONTENTS_DIR/Info.plist"
if [ -f "mac_app/Resources/AppIcon.icns" ]; then
    cp mac_app/Resources/AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"
fi
if [ -d "bin/kiwix" ]; then
    mkdir -p "$RESOURCES_DIR/bin"
    cp -R "bin/kiwix" "$RESOURCES_DIR/bin/"
fi
cp -R dist "$RESOURCES_DIR/dist"
cp -R server "$RESOURCES_DIR/server"
cp package.json "$RESOURCES_DIR/package.json"
if [ -d "node_modules/opencc-js" ]; then
    mkdir -p "$RESOURCES_DIR/node_modules"
    cp -R "node_modules/opencc-js" "$RESOURCES_DIR/node_modules/"
fi

# 4. 代码签名 (支持本地纯免费自签名证书 / 免费个人开发证书 / 无签名降级)
# 策略说明：
#   为了防止应用每次重新编译/更新后系统辅助功能(Accessibility)与快捷键权限丢失，需要稳定的代码签名标识。
#   开源项目坚决排除 Apple 付费分发证书 (Apple Distribution / Developer ID)。
# 优先级：
#   1. 环境变量 CODESIGN_IDENTITY (若手动指定)
#   2. 本地建立的自建免费证书 (如 SimpleUI-CodeSign 或自定义本地自签名证书)
#   3. 本地免费个人开发证书 (Apple Development: ...)
#   4. 兜底降级为无签名 / 本地 Ad-hoc 模式 (-)
echo "[4/4] 正在检测代码签名配置..."
SIGNING_IDENTITY=""

if [ -n "$CODESIGN_IDENTITY" ]; then
    echo "  -> [指定] 使用环境变量指定的签名身份: \"$CODESIGN_IDENTITY\""
    SIGNING_IDENTITY="$CODESIGN_IDENTITY"
else
    # 查找本地自建代码签名证书 (优先匹配 SimpleUI，或任何非 Apple 官方的本地证书)
    LOCAL_CERT=$(security find-identity -p codesigning -v 2>/dev/null | grep -E '"SimpleUI' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$LOCAL_CERT" ]; then
        LOCAL_CERT=$(security find-identity -p codesigning -v 2>/dev/null | grep -v 'Apple Development' | grep -v 'Apple Distribution' | grep -v 'Developer ID' | grep -v '3rd Party Mac Developer' | grep '"' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    # 查找本地免费个人开发证书 (严格排除 Apple Distribution / Developer ID 等付费企业/分发证书)
    FREE_DEV_CERT=$(security find-identity -p codesigning -v 2>/dev/null | grep "Apple Development" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')

    if [ -n "$LOCAL_CERT" ]; then
        echo "  -> [首选] 发现本地建立的免费自签名证书: \"$LOCAL_CERT\""
        echo "     (本地自建证书完全免费且永久有效，更新后可保留辅助功能与快捷键权限)"
        SIGNING_IDENTITY="$LOCAL_CERT"
    elif [ -n "$FREE_DEV_CERT" ]; then
        echo "  -> [次选] 发现本地免费个人开发证书: \"$FREE_DEV_CERT\""
        echo "     (免费个人开发证书，更新后可保留辅助功能与快捷键权限)"
        SIGNING_IDENTITY="$FREE_DEV_CERT"
    else
        echo "  -> [兜底] 未发现本地签名证书，降级采用无签名 / 本地 Ad-hoc 模式 (-)..."
        echo "     💡 提示: 无签名模式在应用更新后可能会导致系统权限丢失。若需保持权限，可运行:"
        echo "        ./scripts/setup_local_cert.sh 创建本地自签名证书。"
        SIGNING_IDENTITY="-"
    fi
fi

codesign --force --deep --sign "$SIGNING_IDENTITY" "$APP_DIR"
touch "$APP_DIR"

echo "=========================================================="
echo "  ✅ 构建成功！"
echo "  📦 应用路径: $APP_DIR"
echo "=========================================================="

if [ "$1" = "install" ]; then
    echo "正在安装至 /Applications/SimpleUI.app..."
    # 清理旧包名
    rm -rf "/Applications/TurboFieldfareChat.app"
    rm -rf "/Applications/SimpleUI.app"
    cp -R "$APP_DIR" "/Applications/SimpleUI.app"
    echo "🎉 安装完成！你可以在“访达” -> “应用程序”或 Spotlight 中直接搜索启动 SimpleUI。"
fi
