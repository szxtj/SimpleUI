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

# 4. 代码签名 (优先使用本地免费个人开发证书，若无则使用纯本地无签名 Ad-hoc)
echo "[4/4] 正在执行应用代码签名..."
SIGNING_IDENTITY=""
DEV_IDENTITY=$(security find-identity -p codesigning -v 2>/dev/null | grep "Apple Development" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')

if [ -n "$DEV_IDENTITY" ]; then
    echo "  -> 发现本地免费个人开发者证书: \"$DEV_IDENTITY\""
    SIGNING_IDENTITY="$DEV_IDENTITY"
else
    echo "  -> 未发现个人证书，采用无签名 / 本地 Ad-hoc 签名模式 (-)..."
    SIGNING_IDENTITY="-"
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
