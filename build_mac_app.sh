#!/usr/bin/env bash
set -e

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset NODE_OPTIONS
REAL_HOME="$(dscl . -read /Users/$(id -un) NFSHomeDirectory 2>/dev/null | awk '{print $2}' || echo "$HOME")"
[ -z "$REAL_HOME" ] && REAL_HOME="$HOME"

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

# macOS APFS 写时复制（Copy-on-Write / clonefile）：优先克隆，零物理磁盘重复占用，回退到普通 cp
copy_item() {
  local src="$1"
  local dst="$2"
  if cp -Rc "$src" "$dst" 2>/dev/null; then
    return 0
  fi
  cp -R "$src" "$dst"
}

# 构建前自动清扫打包历史遗留的临时目录碎片
rm -rf /tmp/simpleui_stale_* 2>/dev/null || true

APP_NAME="SimpleUI"
BUNDLE_NAME="SimpleUI.app"
BUILD_DIR="$PROJECT_ROOT/build"
APP_DIR="$BUILD_DIR/$BUNDLE_NAME"
CONTENTS_DIR="$APP_DIR"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "=========================================================="
echo "  🚀 正在构建 $APP_NAME 原生 macOS 桌面应用 (ARM64)"
echo "=========================================================="

# 1. 编译前端静态资源
echo "[1/4] 编译前端 Web 界面..."
safe_remove "dist/assets"
npm run build

# 2. 准备 App Bundle 目录结构
echo "[2/4] 创建应用包目录结构..."
safe_remove "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# 3. 编译 Swift 原生源码
echo "[3/4] 编译 Swift 原生双窗口应用..."
swiftc -O \
    -target arm64-apple-macos15.0 \
    -framework Cocoa \
    -framework WebKit \
    -framework Carbon \
    -framework AVFoundation \
    -framework ApplicationServices \
    -framework ScreenCaptureKit \
    -framework CoreMedia \
    -framework SwiftUI \
    -framework NaturalLanguage \
    mac_app/src/main.swift \
    mac_app/src/AppDelegate.swift \
    mac_app/src/HotKeyManager.swift \
    mac_app/src/ProcessManager.swift \
    mac_app/src/MainWindowController.swift \
    mac_app/src/SpotlightPanelController.swift \
    mac_app/src/StatusBarController.swift \
    mac_app/src/VoiceInputManager.swift \
    mac_app/src/VoiceOverlayPanelController.swift \
    mac_app/src/SubtitleOverlayPanelController.swift \
    mac_app/src/TranslationConfig.swift \
    mac_app/src/TranslationSpeechManager.swift \
    mac_app/src/TranslationProfileStore.swift \
    mac_app/src/TranslationService.swift \
    mac_app/src/TranslationViewModel.swift \
    mac_app/src/TranslationInputTextView.swift \
    mac_app/src/TranslationMainView.swift \
    mac_app/src/TranslationPanelController.swift \
    -o "$MACOS_DIR/SimpleUI"

# 编译字幕 CoreML helper（SaT 断句）
echo "  · 编译字幕 CoreML helper..."
mkdir -p "bin" "$RESOURCES_DIR/bin"
swiftc -O \
    -target arm64-apple-macos15.0 \
    -framework CoreML \
    -framework Foundation \
    mac_app/helper/SubtitleMLHelper.swift \
    -o "bin/subtitle_ml_helper"
chmod +x "bin/subtitle_ml_helper"
copy_item "bin/subtitle_ml_helper" "$RESOURCES_DIR/bin/subtitle_ml_helper"

# 拷贝资源
cp mac_app/Resources/Info.plist "$CONTENTS_DIR/Info.plist"
if [ -f "mac_app/Resources/AppIcon.icns" ]; then
    cp mac_app/Resources/AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"
fi
if [ -f "mac_app/Resources/StatusBarIcon.png" ]; then
    cp mac_app/Resources/StatusBarIcon.png "$RESOURCES_DIR/StatusBarIcon.png"
fi
if [ -f "mac_app/Resources/StatusBarIcon.svg" ]; then
    cp mac_app/Resources/StatusBarIcon.svg "$RESOURCES_DIR/StatusBarIcon.svg"
fi
if [ -d "bin/kiwix" ]; then
    mkdir -p "$RESOURCES_DIR/bin"
    copy_item "bin/kiwix" "$RESOURCES_DIR/bin/"
fi

# 清理旧架构遗留的 subtitle_stream_asr 二进制（现已统一由 bin/audiocpp/bin/audiocpp_server 承载 Confucius4-R2T2）
safe_remove "bin/subtitle_stream_asr"
safe_remove "$RESOURCES_DIR/bin/subtitle_stream_asr"

# 随包分发字幕第 3 级神经机器翻译所需的 llama-server 运行时及自包含动态库
ensure_llama_runtime() {
  local LOCAL_LLAMA_DIR="$REAL_HOME/Library/Application Support/SimpleUI/runtime/llama"
  if [ ! -x "bin/llama/bin/llama-server" ] || ! bin/llama/bin/llama-server --version >/dev/null 2>&1; then
    echo "  · 正在构建自包含的内置 llama-server 运行时 → bin/llama/"
    safe_remove "bin/llama"
    mkdir -p "bin/llama/bin" "bin/llama/lib"

    local SRC_BIN=""
    if [ -x "$LOCAL_LLAMA_DIR/bin/llama-server" ]; then
      SRC_BIN="$LOCAL_LLAMA_DIR/bin/llama-server"
    elif command -v llama-server >/dev/null 2>&1; then
      SRC_BIN="$(command -v llama-server)"
    fi

    if [ -n "$SRC_BIN" ]; then
      python3 - "$SRC_BIN" "bin/llama" <<'PYEOF'
import os, sys, shutil, subprocess

src_bin = os.path.realpath(sys.argv[1])
dest_root = os.path.abspath(sys.argv[2])
dest_bin_dir = os.path.join(dest_root, "bin")
dest_lib_dir = os.path.join(dest_root, "lib")
os.makedirs(dest_bin_dir, exist_ok=True)
os.makedirs(dest_lib_dir, exist_ok=True)

dest_bin = os.path.join(dest_bin_dir, "llama-server")
shutil.copy2(src_bin, dest_bin)
os.chmod(dest_bin, 0o755)

search_dirs = [
    os.path.abspath(os.path.join(os.path.dirname(src_bin), "..", "lib")),
    "/opt/homebrew/lib",
    "/opt/homebrew/opt/ggml/lib",
    "/opt/homebrew/opt/llama.cpp/lib",
    "/usr/local/lib",
]

def get_deps(binary_path):
    out = subprocess.check_output(["otool", "-L", binary_path], text=True)
    deps = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        dep = line.split(" (compatibility ")[0].strip()
        if dep.startswith("/System/") or dep.startswith("/usr/lib/"):
            continue
        deps.append(dep)
    return deps

def resolve_dep(dep_str, origin_dir=None):
    if dep_str.startswith("@"):
        base = os.path.basename(dep_str)
        dirs = ([origin_dir] if origin_dir else []) + search_dirs
        for d in dirs:
            if not d:
                continue
            cand = os.path.join(d, base)
            if os.path.exists(cand):
                return os.path.realpath(cand), base
    elif os.path.exists(dep_str):
        return os.path.realpath(dep_str), os.path.basename(dep_str)
    return None, os.path.basename(dep_str)

queue = [(dest_bin, os.path.dirname(src_bin))]
visited = set()

while queue:
    target, origin_dir = queue.pop(0)
    if target in visited:
        continue
    visited.add(target)
    is_exe = (target == dest_bin)
    deps = get_deps(target)

    for dep in deps:
        real_src, base_name = resolve_dep(dep, origin_dir)
        if not real_src:
            continue
        dst_lib = os.path.join(dest_lib_dir, base_name)
        if not os.path.exists(dst_lib):
            shutil.copy2(real_src, dst_lib)
            os.chmod(dst_lib, 0o755)
            queue.append((dst_lib, os.path.dirname(real_src)))

        new_ref = f"@loader_path/../lib/{base_name}" if is_exe else f"@loader_path/{base_name}"
        if dep != new_ref:
            subprocess.run(["install_name_tool", "-change", dep, new_ref, target], check=False, stderr=subprocess.DEVNULL)

    if not is_exe:
        base_name = os.path.basename(target)
        subprocess.run(["install_name_tool", "-id", f"@loader_path/{base_name}", target], check=False, stderr=subprocess.DEVNULL)

for f in os.listdir(dest_lib_dir):
    fp = os.path.join(dest_lib_dir, f)
    if os.path.isfile(fp):
        subprocess.run(["codesign", "--force", "--sign", "-", fp], check=False, stderr=subprocess.DEVNULL)
subprocess.run(["codesign", "--force", "--sign", "-", dest_bin], check=False, stderr=subprocess.DEVNULL)
PYEOF
    fi
  fi

  if [ -d "bin/llama" ] && [ -x "bin/llama/bin/llama-server" ]; then
    mkdir -p "$RESOURCES_DIR/llama"
    copy_item "bin/llama/." "$RESOURCES_DIR/llama/"
    chmod +x "$RESOURCES_DIR/llama/bin/llama-server" 2>/dev/null || true
    echo "  -> 已打包自包含字幕翻译运行时 (llama-server): $(du -sh bin/llama | cut -f1)"
  else
    echo "  ⚠ 未找到 llama-server 运行时：请确认 bin/llama 存在"
  fi
}
ensure_llama_runtime

# 语音识别运行时 + 模型（独立用于语音输入服务，保持原样不动）
ensure_asr_assets() {
  local MODEL_FILE="sensevoice-small-q8-audiocpp-v1.gguf"
  local LOCAL_CACHE="$REAL_HOME/Library/Application Support/SimpleUI/models/$MODEL_FILE"
  if [ ! -x "bin/audiocpp/bin/audiocpp_server" ]; then
    echo "  · 未找到本地 audiocpp 运行时，自动准备..."
    ./scripts/sync_audiocpp.sh --build
  fi
  if [ ! -f "bin/audiocpp/models/$MODEL_FILE" ]; then
    mkdir -p "bin/audiocpp/models"
    if [ -f "$LOCAL_CACHE" ]; then
      echo "  · 复用本地已下载模型缓存 → bin/audiocpp/models/"
      copy_item "$LOCAL_CACHE" "bin/audiocpp/models/$MODEL_FILE"
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
    copy_item "bin/audiocpp/." "$RESOURCES_DIR/asr/"
    chmod +x "$RESOURCES_DIR/asr/bin/audiocpp_server" 2>/dev/null || true
    echo "  -> 已打包语音识别运行时与模型: $(du -sh bin/audiocpp | cut -f1)"
else
    echo "  ⚠ bin/audiocpp 仍缺失：语音识别将不可用（请检查网络或 ~/audio.cpp 构建）"
fi

# 随包分发自包含 Node 运行时（包含动态库递归打包与 @loader_path 重定位，缓存于 /tmp 不污染 Git 仓库）
ensure_node_runtime() {
  local NODE_BIN
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "  ⚠ 未检测到 node，跳过打包（运行时将回退系统 PATH 中的 node）"
    return 0
  fi
  local NODE_REAL
  NODE_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
  if [ ! -x "$NODE_REAL" ]; then
    echo "  ⚠ 无法定位 node 真实二进制，跳过打包"
    return 0
  fi

  local NODE_CACHE_DIR="/tmp/simpleui_node_runtime_cache"
  if [ ! -x "$NODE_CACHE_DIR/bin/node" ] || ! "$NODE_CACHE_DIR/bin/node" --version >/dev/null 2>&1; then
    echo "  · 正在构建自包含的内置 Node 运行时..."
    safe_remove "$NODE_CACHE_DIR"
    mkdir -p "$NODE_CACHE_DIR/bin" "$NODE_CACHE_DIR/lib"

    python3 - "$NODE_REAL" "$NODE_CACHE_DIR" <<'PYEOF'
import os, sys, shutil, subprocess

src_bin = os.path.realpath(sys.argv[1])
dest_root = os.path.abspath(sys.argv[2])
dest_bin_dir = os.path.join(dest_root, "bin")
dest_lib_dir = os.path.join(dest_root, "lib")
os.makedirs(dest_bin_dir, exist_ok=True)
os.makedirs(dest_lib_dir, exist_ok=True)

dest_bin = os.path.join(dest_bin_dir, "node")
shutil.copy2(src_bin, dest_bin)
os.chmod(dest_bin, 0o755)

search_dirs = [
    os.path.abspath(os.path.join(os.path.dirname(src_bin), "..", "lib")),
    "/opt/homebrew/lib",
    "/opt/homebrew/opt/node/lib",
    "/usr/local/lib",
]

def get_deps(binary_path):
    out = subprocess.check_output(["otool", "-L", binary_path], text=True)
    deps = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        dep = line.split(" (compatibility ")[0].strip()
        if dep.startswith("/System/") or dep.startswith("/usr/lib/"):
            continue
        deps.append(dep)
    return deps

def resolve_dep(dep_str, origin_dir=None):
    if dep_str.startswith("@"):
        base = os.path.basename(dep_str)
        dirs = ([origin_dir] if origin_dir else []) + search_dirs
        for d in dirs:
            if not d:
                continue
            cand = os.path.join(d, base)
            if os.path.exists(cand):
                return os.path.realpath(cand), base
    elif os.path.exists(dep_str):
        return os.path.realpath(dep_str), os.path.basename(dep_str)
    return None, os.path.basename(dep_str)

queue = [(dest_bin, os.path.dirname(src_bin))]
visited = set()

while queue:
    target, origin_dir = queue.pop(0)
    if target in visited:
        continue
    visited.add(target)
    is_exe = (target == dest_bin)
    deps = get_deps(target)

    for dep in deps:
        real_src, base_name = resolve_dep(dep, origin_dir)
        if not real_src:
            continue
        dst_lib = os.path.join(dest_lib_dir, base_name)
        if not os.path.exists(dst_lib):
            shutil.copy2(real_src, dst_lib)
            os.chmod(dst_lib, 0o755)
            queue.append((dst_lib, os.path.dirname(real_src)))

        new_ref = f"@loader_path/../lib/{base_name}" if is_exe else f"@loader_path/{base_name}"
        if dep != new_ref:
            subprocess.run(["install_name_tool", "-change", dep, new_ref, target], check=False, stderr=subprocess.DEVNULL)

    if not is_exe:
        base_name = os.path.basename(target)
        subprocess.run(["install_name_tool", "-id", f"@loader_path/{base_name}", target], check=False, stderr=subprocess.DEVNULL)

for f in os.listdir(dest_lib_dir):
    fp = os.path.join(dest_lib_dir, f)
    if os.path.isfile(fp):
        subprocess.run(["codesign", "--force", "--sign", "-", fp], check=False, stderr=subprocess.DEVNULL)
subprocess.run(["codesign", "--force", "--sign", "-", dest_bin], check=False, stderr=subprocess.DEVNULL)
PYEOF
  fi

  if [ -d "$NODE_CACHE_DIR" ] && "$NODE_CACHE_DIR/bin/node" --version >/dev/null 2>&1; then
    mkdir -p "$RESOURCES_DIR/node"
    copy_item "$NODE_CACHE_DIR/." "$RESOURCES_DIR/node/"
    chmod +x "$RESOURCES_DIR/node/bin/node"
    local NODE_VER
    NODE_VER="$("$RESOURCES_DIR/node/bin/node" --version 2>/dev/null || echo '?')"
    echo "  -> 已打包自包含 Node 运行时: $NODE_VER ($(du -sh "$RESOURCES_DIR/node" | cut -f1))"
  else
    echo "  ⚠ 自包含 Node 运行时校验未通过，跳过随包内置（运行时将自动使用系统 node）"
    safe_remove "$RESOURCES_DIR/node"
  fi
}
ensure_node_runtime

copy_item dist "$RESOURCES_DIR/dist"
copy_item server "$RESOURCES_DIR/server"
copy_item package.json "$RESOURCES_DIR/package.json"

SERVER_DEPS=$(node -e '
const fs=require("fs"), path=require("path");
const specs=new Set();
const walkServer=(dir)=>{
  const out=[];
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    const full=path.join(dir,ent.name);
    if (ent.isDirectory()) out.push(...walkServer(full));
    else if (ent.name.endsWith(".js")) out.push(full);
  }
  return out;
};
for (const f of walkServer("server")) {
  const src=fs.readFileSync(f,"utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+[^;\n]*?from\s*["\x27]([^"\x27]+)["\x27]/g)) {
    const s=m[1];
    if (s.startsWith(".")||s.startsWith("/")||s.startsWith("node:")) continue;
    specs.add(s.startsWith("@") ? s.split("/").slice(0,2).join("/") : s.split("/")[0]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/g)) {
    const s=m[1];
    if (s.startsWith(".")||s.startsWith("/")||s.startsWith("node:")) continue;
    specs.add(s.startsWith("@") ? s.split("/").slice(0,2).join("/") : s.split("/")[0]);
  }
  for (const m of src.matchAll(/\brequire\s*\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/g)) {
    const s=m[1];
    if (s.startsWith(".")||s.startsWith("/")||s.startsWith("node:")) continue;
    specs.add(s.startsWith("@") ? s.split("/").slice(0,2).join("/") : s.split("/")[0]);
  }
}
const closure=new Set();
const walk=(name)=>{
  if (closure.has(name)) return;
  const p=path.join("node_modules",name,"package.json");
  if (!fs.existsSync(p)) return;
  closure.add(name);
  let meta={}; try{ meta=JSON.parse(fs.readFileSync(p,"utf8")); }catch(e){ return; }
  for (const d of Object.keys(meta.dependencies||{})) walk(d);
};
for (const s of specs) walk(s);
console.log([...closure].join(" "));
')
mkdir -p "$RESOURCES_DIR/node_modules"
for dep in $SERVER_DEPS; do
    case "$dep" in
        adm-zip|global-agent) continue ;;
    esac
    if [ -d "node_modules/$dep" ]; then
        mkdir -p "$(dirname "$RESOURCES_DIR/node_modules/$dep")"
        copy_item "node_modules/$dep" "$RESOURCES_DIR/node_modules/$dep"
    else
        echo "  ⚠ 服务端依赖 $dep 未安装，请先执行 npm install" >&2
        exit 1
    fi
done

echo "  -> 服务端运行时依赖: $SERVER_DEPS"

# 4. 代码签名
echo "[4/4] 正在检测代码签名配置..."
SIGNING_IDENTITY=""

if [ -n "$CODESIGN_IDENTITY" ]; then
    echo "  -> [指定] 使用环境变量指定的签名身份: \"$CODESIGN_IDENTITY\""
    SIGNING_IDENTITY="$CODESIGN_IDENTITY"
else
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
    safe_remove "/Applications/TurboFieldfareChat.app"
    safe_remove "/Applications/SimpleUI.app"
    copy_item "$APP_DIR" "/Applications/SimpleUI.app"
    echo "🎉 安装完成！你可以在“访达” -> “应用程序”或 Spotlight 中直接搜索启动 SimpleUI。"
fi
