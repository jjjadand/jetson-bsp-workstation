#!/bin/bash

CLIENT_ID="<your-client-id>"
CLIENT_SECRET="<your-client-secret>"
REDIRECT_URI="http://localhost:53682/"

echo "=== 获取 OneDrive Token ==="
echo ""
echo "1. 访问以下 URL（复制到浏览器）："
echo ""
AUTH_URL="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${CLIENT_ID}&scope=Files.Read%20Files.ReadWrite%20Files.Read.All%20Files.ReadWrite.All%20offline_access&response_type=code&redirect_uri=${REDIRECT_URI}"
echo "$AUTH_URL"
echo ""
echo "2. 登录账号: youjiang.yu@seeedstudio88.onmicrosoft.com"
echo "3. 授权后浏览器会跳转到 http://localhost:53682/?code=..."
echo "4. 复制 URL 中 code= 后面的内容（到 &session_state 之前）"
echo ""
read -p "请粘贴 code: " AUTH_CODE

echo ""
echo "正在获取 token..."

RESPONSE=$(curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "code=${AUTH_CODE}" \
  -d "redirect_uri=${REDIRECT_URI}" \
  -d "grant_type=authorization_code")

ACCESS_TOKEN=$(echo "$RESPONSE" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)
REFRESH_TOKEN=$(echo "$RESPONSE" | grep -o '"refresh_token":"[^"]*' | cut -d'"' -f4)

if [ -n "$REFRESH_TOKEN" ]; then
    echo ""
    echo "✓ 成功获取 token！"
    echo ""
    echo "将以下内容添加到 onedrive_config.conf："
    echo ""
    echo "REFRESH_TOKEN=\"${REFRESH_TOKEN}\""
    echo ""
else
    echo ""
    echo "✗ 获取失败，响应："
    echo "$RESPONSE"
fi
