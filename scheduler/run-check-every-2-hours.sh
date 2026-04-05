#!/bin/zsh
: <<'DOC'
/**
 * 作用：
 * 作为 launchd 的真实执行入口，进入项目目录并运行一次单次检查。
 *
 * 为什么这样写：
 * launchd 自带的环境变量通常比交互终端更少。
 * 把目录切换、日志目录准备和 Node 入口固定下来后，定时任务的行为会更稳定。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {number} 进程退出码。
 *
 * 注意：
 * - 这里调用的是单次 `check`，不在脚本里重复调度。
 * - 通过脚本自身位置推导项目根目录，避免把个人目录写进仓库文件。
 */
DOC

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/artifacts/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"
/usr/bin/env node "$PROJECT_DIR/src/chrome-cli.js" check
