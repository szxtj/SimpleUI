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

# 4. 代码签名 (优先使用本地免费个人开发证书，若无则使用纯本地无签名 Ad-hoc)
# 策略说明：
#   优先使用本地免费个人开发证书 (Apple Development: ...)，保证应用更新后系统辅助功能与快捷键权限不丢失。
#   开源项目坚决排除 Apple 付费分发证书 (Apple Distribution / Developer ID)。
#   若未检测到个人开发证书，则兜底降级为纯本地无签名 Ad-hoc 模式 (-)。
echo "[4/4] 正在检测代码签名配置..."
SIGNING_IDENTITY=""

if [ -n "$CODESIGN_IDENTITY" ]; then
    echo "  -> [指定] 使用环境变量指定的签名身份: \"$CODESIGN_IDENTITY\""
    SIGNING_IDENTITY="$CODESIGN_IDENTITY"
else
    # 查找本地免费个人开发证书 (严格排除 Apple Distribution / Developer ID 等付费企业/分发证书)
    FREE_DEV_CERT=$(security find-identity -p codesigning -v 2>/dev/null | grep "Apple Development" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')

    if [ -n "$FREE_DEV_CERT" ]; then
        echo "  -> 发现本地免费个人开发证书: \"$FREE_DEV_CERT\""
        echo "     (免付费本地证书，更新后可保留辅助功能与快捷键权限)"
        SIGNING_IDENTITY="$FREE_DEV_CERT"
    else
        echo "  -> 未发现个人证书，采用无签名 / 本地 Ad-hoc 模式 (-)..."
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
