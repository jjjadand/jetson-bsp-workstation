#!/bin/bash

# 颜色配置
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# 配置文件路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/onedrive_config.conf"
CACHE_FILE="$SCRIPT_DIR/.upload_cache.txt"

# 加载配置文件
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
    echo -e "${GREEN}✓ 已加载配置文件${RESET}"
else
    echo -e "${RED}✗ 配置文件不存在: $CONFIG_FILE${RESET}"
    exit 1
fi

# 设置NAS路径
NAS_PATH="$HOME/NAS-stu"

# 检查并挂载NAS
if [ ! -d "$NAS_PATH" ]; then
    echo -e "${CYAN}📁 创建挂载目录: $NAS_PATH${RESET}"
    mkdir -p "$NAS_PATH"
fi

if ! mountpoint -q "$NAS_PATH" 2>/dev/null; then
    echo -e "${CYAN}🔗 挂载NAS到 $NAS_PATH...${RESET}"

    # 检查cifs-utils
    if ! command -v mount.cifs &> /dev/null; then
        echo -e "${YELLOW}⚠️  未安装 cifs-utils，正在安装...${RESET}"
        sudo apt-get update -qq && sudo apt-get install -y cifs-utils
    fi

    sudo mount -t cifs "$NAS_REMOTE_PATH" "$NAS_PATH" -o username="$NAS_USER",password="$NAS_PASS",vers=3.0,uid=1000,gid=1000,rw,file_mode=0664
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ NAS挂载成功${RESET}\n"
    else
        echo -e "${RED}✗ NAS挂载失败，请检查网络连接和NAS地址${RESET}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ NAS已挂载${RESET}\n"
fi

# 检查rclone配置
if ! rclone listremotes | grep -q "^${REMOTE_NAME}:"; then
    # 检查配置文件是否有完整参数
    if [ -z "$ONEDRIVE_GLOBAL_USER" ] && [ -z "$ONEDRIVE_CHINA_USER" ]; then
        # 配置文件为空，进入交互式配置
    echo -e "${YELLOW}╔════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${YELLOW}║${RESET}  ${BOLD}⚙️  OneDrive 配置向导${RESET}                                ${YELLOW}║${RESET}"
    echo -e "${YELLOW}╚════════════════════════════════════════════════════════════╝${RESET}\n"

    echo -e "${CYAN}📋 配置步骤说明：${RESET}\n"

    echo -e "${BOLD}步骤 1:${RESET} 创建新的远程连接"
    echo -e "  ${DIM}看到 n/s/q> 提示时，输入字母:${RESET} ${GREEN}n${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 2:${RESET} 设置连接名称"
    echo -e "  ${DIM}看到 name> 提示时，输入:${RESET} ${GREEN}${REMOTE_NAME}${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 3:${RESET} 选择存储类型"
    echo -e "  ${DIM}看到 Storage> 提示时，输入:${RESET} ${GREEN}onedrive${RESET} ${DIM}或数字编号，然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 4:${RESET} OAuth 客户端配置"
    echo -e "  ${DIM}看到 client_id> 提示时:${RESET} ${GREEN}直接按回车${RESET} ${DIM}(留空)${RESET}"
    echo -e "  ${DIM}看到 client_secret> 提示时:${RESET} ${GREEN}直接按回车${RESET} ${DIM}(留空)${RESET}\n"

    echo -e "${BOLD}步骤 5:${RESET} 选择区域"
    echo -e "  ${DIM}看到 region> 提示时，输入数字:${RESET} ${GREEN}1${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 6:${RESET} 高级配置"
    echo -e "  ${DIM}看到 Edit advanced config? 提示时，输入:${RESET} ${GREEN}y${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 7:${RESET} 自动配置授权"
    echo -e "  ${DIM}看到 Use auto config? 提示时，输入:${RESET} ${GREEN}y${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 8:${RESET} 浏览器登录"
    echo -e "  ${DIM}浏览器会自动打开，使用以下账号登录:${RESET}"
    echo -e "  ${DIM}账号:${RESET} ${BLUE}youjiang.yu@seeedstudio88.onmicrosoft.com${RESET}\n"

    echo -e "${BOLD}步骤 9:${RESET} 确认配置"
    echo -e "  ${DIM}看到 Yes this is OK 提示时，输入:${RESET} ${GREEN}y${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${BOLD}步骤 10:${RESET} 退出配置"
    echo -e "  ${DIM}看到 e/n/d/r/c/s/q> 提示时，输入:${RESET} ${GREEN}q${RESET} ${DIM}然后按回车${RESET}\n"

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
    echo -e "${CYAN}按回车键开始配置...${RESET}"
    read -r

    rclone config
    exit 0
    else
        # 配置文件有参数，自动配置rclone
        echo -e "${CYAN}🔧 使用配置文件自动配置 rclone...${RESET}\n"

        # 根据版本选择账号
        if [ "$ONEDRIVE_VERSION" = "china" ]; then
            ONEDRIVE_USER="$ONEDRIVE_CHINA_USER"
            echo -e "${BLUE}📍 使用国内版 OneDrive${RESET}"
            echo -e "${DIM}账号: $ONEDRIVE_USER${RESET}\n"
        else
            ONEDRIVE_USER="$ONEDRIVE_GLOBAL_USER"
            echo -e "${BLUE}📍 使用国际版 OneDrive${RESET}"
            echo -e "${DIM}账号: $ONEDRIVE_USER${RESET}\n"
        fi

        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}开始自动配置流程...${RESET}\n"

        # 使用expect自动化配置
        if ! command -v expect &> /dev/null; then
            echo -e "${YELLOW}⚠️  未安装 expect，正在安装...${RESET}"
            sudo apt-get update -qq && sudo apt-get install -y expect
        fi

        # 创建expect脚本
        EXPECT_SCRIPT=$(mktemp)

        if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
            # 使用自定义凭据
            cat > "$EXPECT_SCRIPT" << EXPECT_EOF
#!/usr/bin/expect -f
set timeout 60

spawn rclone config

expect "n/s/q>"
send "n\r"

expect "name>"
send "onedrive\r"

expect "Storage>"
send "onedrive\r"

expect "client_id>"
send "$CLIENT_ID\r"

expect "client_secret>"
send "$CLIENT_SECRET\r"

expect "region>"
send "1\r"

expect "Edit advanced config?"
send "n\r"

expect "Use auto config?"
send "y\r"

expect {
    "Yes this is OK" {
        send "y\r"
    }
    timeout {
        puts "\n配置超时，请检查浏览器授权"
        exit 1
    }
}

expect "e/n/d/r/c/s/q>"
send "q\r"

expect eof
EXPECT_EOF
        else
            # 使用rclone内置凭据
            cat > "$EXPECT_SCRIPT" << 'EXPECT_EOF'
#!/usr/bin/expect -f
set timeout 60

spawn rclone config

expect "n/s/q>"
send "n\r"

expect "name>"
send "onedrive\r"

expect "Storage>"
send "onedrive\r"

expect "client_id>"
send "\r"

expect "client_secret>"
send "\r"

expect "region>"
send "1\r"

expect "Edit advanced config?"
send "n\r"

expect "Use auto config?"
send "y\r"

expect {
    "Yes this is OK" {
        send "y\r"
    }
    timeout {
        puts "\n配置超时，请检查浏览器授权"
        exit 1
    }
}

expect "e/n/d/r/c/s/q>"
send "q\r"

expect eof
EXPECT_EOF
        fi

        chmod +x "$EXPECT_SCRIPT"

        echo -e "${CYAN}🌐 即将打开浏览器进行授权...${RESET}"
        echo -e "${BOLD}请在浏览器中使用以下账号登录：${RESET}"
        echo -e "${BLUE}$ONEDRIVE_USER${RESET}\n"

        sleep 2

        $EXPECT_SCRIPT

        if [ $? -eq 0 ]; then
            echo -e "\n${GREEN}✓ rclone 配置成功！${RESET}"
            rm -f "$EXPECT_SCRIPT"
        else
            echo -e "\n${RED}✗ 配置失败${RESET}"
            rm -f "$EXPECT_SCRIPT"
            exit 1
        fi
    fi
fi

# 初始化缓存文件
touch "$CACHE_FILE"

# 查找最近7天的mfi_开头的tar包
echo -e "\n${CYAN}🔍 正在扫描备份文件...${RESET}"
files=$(find "$NAS_PATH" -name "mfi_*.tar*" -type f -mtime -7 | sort -r)

if [ -z "$files" ]; then
    echo -e "${YELLOW}⚠️  未找到符合条件的文件${RESET}"
    exit 0
fi

# 过滤已上传的文件
declare -a new_files
while IFS= read -r file; do
    filename=$(basename "$file")
    if ! grep -q "^$filename$" "$CACHE_FILE"; then
        new_files+=("$file")
    fi
done <<< "$files"

total_count=$(echo "$files" | wc -l)
new_count=${#new_files[@]}

echo -e "${GREEN}✓${RESET} 找到 ${BOLD}${total_count}${RESET} 个文件，其中 ${BOLD}${new_count}${RESET} 个未上传\n"

if [ $new_count -eq 0 ]; then
    echo -e "${YELLOW}⚠️  所有文件都已上传过${RESET}"
    exit 0
fi

# 显示文件列表供选择
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BLUE}║${RESET}  ${BOLD}📋 选择要上传的文件${RESET}                                  ${BLUE}║${RESET}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${RESET}\n"

i=0
for file in "${new_files[@]}"; do
    i=$((i+1))
    filename=$(basename "$file")
    filesize=$(du -h "$file" | cut -f1)
    echo -e "${CYAN}[$i]${RESET} ${filename} ${DIM}(${filesize})${RESET}"
done

echo -e "\n${YELLOW}选项：${RESET}"
echo -e "  ${GREEN}a${RESET} - 上传所有文件"
echo -e "  ${GREEN}1,2,3${RESET} - 上传指定编号的文件（逗号分隔）"
echo -e "  ${GREEN}q${RESET} - 退出\n"
echo -n "请选择: "
read -r choice

if [ "$choice" = "q" ]; then
    echo -e "${YELLOW}已取消${RESET}"
    exit 0
fi

# 确定要上传的文件
declare -a upload_files
if [ "$choice" = "a" ]; then
    upload_files=("${new_files[@]}")
else
    IFS=',' read -ra indices <<< "$choice"
    for idx in "${indices[@]}"; do
        idx=$(echo "$idx" | xargs)
        if [[ "$idx" =~ ^[0-9]+$ ]] && [ "$idx" -ge 1 ] && [ "$idx" -le $new_count ]; then
            upload_files+=("${new_files[$((idx-1))]}")
        fi
    done
fi

if [ ${#upload_files[@]} -eq 0 ]; then
    echo -e "${RED}✗ 无效选择${RESET}"
    exit 1
fi

# 开始上传
echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BLUE}║${RESET}  ${BOLD}📤 开始上传到 OneDrive${RESET}                              ${BLUE}║${RESET}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${RESET}"

i=0
upload_count=${#upload_files[@]}
for file in "${upload_files[@]}"; do
    i=$((i+1))
    filename=$(basename "$file")
    filesize=$(du -h "$file" | cut -f1)

    echo -e "\n${CYAN}┌─────────────────────────────────────────────────────────┐${RESET}"
    echo -e "${CYAN}│${RESET} ${BOLD}[$i/$upload_count]${RESET} 📦 ${filename}"
    echo -e "${CYAN}│${RESET} ${DIM}大小: ${filesize}${RESET}"
    echo -e "${CYAN}└─────────────────────────────────────────────────────────┘${RESET}"

    rclone copy "$file" "${REMOTE_NAME}:${ONEDRIVE_PATH}/" \
        -P \
        --transfers 1 \
        --retries 5 \
        --low-level-retries 10 \
        --stats 5s \
        --stats-one-line

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ 上传成功${RESET}"
        echo "$filename" >> "$CACHE_FILE"
    else
        echo -e "${RED}✗ 上传失败${RESET}"
    fi
done

echo -e "\n${GREEN}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║${RESET}  ${BOLD}🎉 所有文件上传完成！${RESET}                                ${GREEN}║${RESET}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${RESET}\n"
