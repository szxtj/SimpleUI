#!/bin/bash
# scripts/setup_local_cert.sh
# 用于为 SimpleUI 创建纯本地、免费、永久有效的自签名代码签名证书
# 该证书保存在本地登录钥匙串中，可保证 SimpleUI 在多次重新编译/更新后，系统辅助功能/快捷键权限不丢失。

set -e

CERT_NAME="SimpleUI-CodeSign"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

echo "=========================================================="
echo "  🛠️  创建 SimpleUI 本地纯免费自签名代码签名证书"
echo "=========================================================="
echo "目标证书名称: $CERT_NAME"
echo "目标钥匙串:   $KEYCHAIN"
echo ""

# 检查是否已存在有效代码签名证书
if security find-identity -p codesigning -v 2>/dev/null | grep -q "$CERT_NAME"; then
    echo "✅ 证书 \"$CERT_NAME\" 已存在且处于受信任状态，无需重复创建！"
    exit 0
fi

# 创建临时工作区
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[1/4] 生成 RSA 私钥和自签名代码签名证书 (有效期 10 年)..."
openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
  -keyout "$WORK_DIR/dev.key" \
  -out "$WORK_DIR/dev.crt" \
  -subj "/CN=$CERT_NAME/O=SimpleUI/OU=Local Development" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning"

echo "[2/4] 打包为 PKCS#12 证书包..."
openssl pkcs12 -export -legacy \
  -in "$WORK_DIR/dev.crt" \
  -inkey "$WORK_DIR/dev.key" \
  -out "$WORK_DIR/dev.p12" \
  -password pass:simpleui

echo "[3/4] 导入证书至登录钥匙串..."
security delete-certificate -c "$CERT_NAME" "$KEYCHAIN" 2>/dev/null || true
security import "$WORK_DIR/dev.p12" -k "$KEYCHAIN" -P simpleui -T /usr/bin/codesign

echo "[4/4] 设置代码签名信任级别 (macOS 系统可能会弹出授权弹窗，请输入系统密码或使用 Touch ID)..."
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORK_DIR/dev.crt"

echo ""
echo "=========================================================="
if security find-identity -p codesigning -v 2>/dev/null | grep -q "$CERT_NAME"; then
    echo "  🎉 成功！本地自签名证书 \"$CERT_NAME\" 已建立并生效！"
    echo "  现在执行 ./build_mac_app.sh 将自动优先使用该本地自签名。"
else
    echo "  ℹ️ 证书已导入钥匙串。若终端未自动信任，您也可在“钥匙串访问”中："
    echo "     1. 搜索 \"$CERT_NAME\""
    echo "     2. 双击打开 -> 展开“信任” -> 将“代码签名”改为“始终信任”"
fi
echo "=========================================================="
