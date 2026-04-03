# OneDrive 手动配置指南

## 问题原因
自动配置时浏览器授权回调失败，需要手动配置。

## 配置步骤

### 1. 启动配置
```bash
rclone config
```

### 2. 按照提示输入：
- `n/s/q>` → 输入 `n`
- `name>` → 输入 `onedrive`
- `Storage>` → 输入 `onedrive`
- `client_id>` → 输入 `<your-client-id>`
- `client_secret>` → 输入 `<your-client-secret>`
- `region>` → 输入 `1`
- `Edit advanced config?` → 输入 `n`
- `Use auto config?` → 输入 `n` (关键！)

### 3. 获取授权码
会显示一个 URL，复制这个 URL 到浏览器打开：
```
https://login.microsoftonline.com/...
```

### 4. 浏览器登录
- 账号：youjiang.yu@seeedstudio88.onmicrosoft.com
- 密码：Seeed2025..

### 5. 复制授权码
授权成功后会显示一串代码，复制整段代码

### 6. 粘贴授权码
回到终端，粘贴刚才复制的代码

### 7. 完成配置
- `Yes this is OK` → 输入 `y`
- `e/n/d/r/c/s/q>` → 输入 `q`

## 验证配置
```bash
rclone lsd onedrive:
```

## 开始上传
```bash
./upload_to_onedrive.sh
```
