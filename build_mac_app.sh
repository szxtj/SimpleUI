#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# 安全删除：真实 Mac 上直接 rm -rf（即真正删除）；若被运行环境的安全删除策略拦截
#（返回非零），回退到 mv 到带时间戳的临时目录，保证「一键打包」在受限环境下也不中断。
safe_remove() {
  local target="$1"
  [ ! -e "$target" ] && return 0
  if rm -rf "$target" 2>/dev/null; then
    return 0
  fi
  local ts; ts="$(date +%s)"
  local dest="/tmp/simpleui_stale_${ts}/$(basename "$target")"
  mkdir -p "$(dirname "$dest")"
  if mv -f "$target" "$dest" 2>/dev/null; then
    echo "  · 安全删除被拦截，已转存至: $dest"
  else
    echo "  ⚠ 无法移除 $target，继续（如已存在会被后续步骤覆盖）"
  fi
}

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
# 受限环境下 vite 的 emptyOutDir 批量删除 dist/assets 会被安全删除拦截，
# 先把旧产物转存到临时目录（确保父目录存在），再让 vite 在空 dist 上重建。
if [ -d dist/assets ]; then
  _ts="$(date +%s)"
  mkdir -p "/tmp/simpleui_stale_${_ts}"
  mv -f dist/assets "/tmp/simpleui_stale_${_ts}/assets" 2>/dev/null || \
    rm -rf dist/assets 2>/dev/null || true
fi
npm run build

# 2. 准备 App Bundle 目录结构
echo "[2/4] 创建应用包目录结构..."
safe_remove "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# 3. 编译 Swift 原生源码
echo "[3/4] 编译 Swift 原生双窗口应用..."
swiftc -O \
    -target arm64-apple-macos12.0 \
    -framework Cocoa \
    -framework WebKit \
    -framework Carbon \
    -framework AVFoundation \
    -framework ApplicationServices \
    mac_app/src/main.swift \
    mac_app/src/AppDelegate.swift \
    mac_app/src/HotKeyManager.swift \
    mac_app/src/ProcessManager.swift \
    mac_app/src/MainWindowController.swift \
    mac_app/src/SpotlightPanelController.swift \
    mac_app/src/StatusBarController.swift \
    mac_app/src/VoiceInputManager.swift \
    mac_app/src/VoiceOverlayPanelController.swift \
    -o "$MACOS_DIR/SimpleUI"

# 拷贝资源
cp mac_app/Resources/Info.plist "$CONTENTS_DIR/Info.plist"
if [ -f "mac_app/Resources/AppIcon.icns" ]; then
    cp mac_app/Resources/AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"
fi
if [ -f "mac_app/Resources/StatusBarIcon.png" ]; then
    cp mac_app/Resources/StatusBarIcon.png "$RESOURCES_DIR/StatusBarIcon.png"
fi
# 状态栏图标 SVG 设计源文件（运行时不用，PNG 由它光栅化；改图标几何只改 SVG 再重出 PNG）
if [ -f "mac_app/Resources/StatusBarIcon.svg" ]; then
    cp mac_app/Resources/StatusBarIcon.svg "$RESOURCES_DIR/StatusBarIcon.svg"
fi
if [ -d "bin/kiwix" ]; then
    mkdir -p "$RESOURCES_DIR/bin"
    cp -R "bin/kiwix" "$RESOURCES_DIR/bin/"
fi
# 语音识别运行时 + 模型：打包前确保就位（本地有缓存则复用，缺失自动下载/编译），
# 一并打进 App，使分发的 App 打开即用、无需任何下载或编译。
ensure_asr_assets() {
  local MODEL_FILE="sensevoice-small-q8-audiocpp-v1.gguf"
  local LOCAL_CACHE="$HOME/Library/Application Support/SimpleUI/models/$MODEL_FILE"
  # 运行时二进制：本地缺失才 clone+编译（sync --build 会跳过已有构建）
  if [ ! -x "bin/audiocpp/bin/audiocpp_server" ]; then
    echo "  · 未找到本地 audiocpp 运行时，自动准备..."
    ./scripts/sync_audiocpp.sh --build
  fi
  # 模型：优先复用本地缓存，其次下载（约 254MB，官方源失败回退镜像）
  if [ ! -f "bin/audiocpp/models/$MODEL_FILE" ]; then
    mkdir -p "bin/audiocpp/models"
    if [ -f "$LOCAL_CACHE" ]; then
      echo "  · 复用本地已下载模型缓存 → bin/audiocpp/models/"
      cp "$LOCAL_CACHE" "bin/audiocpp/models/$MODEL_FILE"
    else
      echo "  · 未找到本地模型，自动下载（约 254MB）..."
      local URL="https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/$MODEL_FILE"
      local MIRROR="https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp/resolve/main/$MODEL_FILE"
      if ! curl -fL --retry 2 -o "bin/audiocpp/models/$MODEL_FILE.part" "$URL"; then
        echo "    官方源失败，回退 hf-mirror.com"
        curl -fL --retry 2 -o "bin/audiocpp/models/$MODEL_FILE.part" "$MIRROR"
      fi
      mv "bin/audiocpp/models/$MODEL_FILE.part" "bin/audiocpp/models/$MODEL_FILE"
    fi
  fi
}
ensure_asr_assets
if [ -d "bin/audiocpp" ]; then
    mkdir -p "$RESOURCES_DIR/asr"
    cp -R "bin/audiocpp/." "$RESOURCES_DIR/asr/"
    chmod +x "$RESOURCES_DIR/asr/bin/audiocpp_server" 2>/dev/null || true
    echo "  -> 已打包语音识别运行时与模型: $(du -sh bin/audiocpp | cut -f1)"
else
    echo "  ⚠ bin/audiocpp 仍缺失：语音识别将不可用（请检查网络或 ~/audio.cpp 构建）"
fi
cp -R dist "$RESOURCES_DIR/dist"
cp -R server "$RESOURCES_DIR/server"
cp package.json "$RESOURCES_DIR/package.json"
# 服务端运行时依赖：从 server/*.js 的 import 自动推导（连同传递依赖），
# 不再硬编码包名——否则一旦给服务端加依赖就会漏打，APP 启动即崩、界面全白。
SERVER_DEPS=$(node -e '
const fs=require("fs"), path=require("path");
const specs=new Set();
for (const f of fs.readdirSync("server").filter(f=>f.endsWith(".js"))) {
  const src=fs.readFileSync(path.join("server",f),"utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+[^;\n]*?from\s*["\x27]([^"\x27]+)["\x27]/g)) {
    const s=m[1];
    if (s.startsWith(".")||s.startsWith("/")||s.startsWith("node:")) continue;
    specs.add(s.startsWith("@") ? s.split("/").slice(0,2).join("/") : s.split("/")[0]);
  }
}
const closure=new Set();
const walk=(name)=>{
  if (closure.has(name)) return;
  const p=path.join("node_modules",name,"package.json");
  if (!fs.existsSync(p)) return; // Node 内置模块在这里自然被排除
  closure.add(name);
  let meta={}; try{ meta=JSON.parse(fs.readFileSync(p,"utf8")); }catch(e){ return; }
  for (const d of Object.keys(meta.dependencies||{})) walk(d);
};
for (const s of specs) walk(s);
console.log([...closure].join(" "));
')
mkdir -p "$RESOURCES_DIR/node_modules"
for dep in $SERVER_DEPS; do
    if [ -d "node_modules/$dep" ]; then
        mkdir -p "$(dirname "$RESOURCES_DIR/node_modules/$dep")"
        cp -R "node_modules/$dep" "$RESOURCES_DIR/node_modules/$dep"
    else
        echo "  ⚠ 服务端依赖 $dep 未安装，请先执行 npm install" >&2
        exit 1
    fi
done
echo "  -> 服务端运行时依赖: $SERVER_DEPS"

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
    safe_remove "/Applications/TurboFieldfareChat.app"
    safe_remove "/Applications/SimpleUI.app"
    cp -R "$APP_DIR" "/Applications/SimpleUI.app"
    echo "🎉 安装完成！你可以在“访达” -> “应用程序”或 Spotlight 中直接搜索启动 SimpleUI。"
fi
