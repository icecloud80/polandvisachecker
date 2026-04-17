#!/bin/zsh
: <<'DOC'
/**
 * 作用：
 * 兼容旧命令入口，并转交到新的 90 秒前台循环脚本。
 *
 * 为什么这样写：
 * 之前仓库已经暴露了 `run-check-every-2-minutes.sh` 这个文件名。
 * 为了在把实际频率改成 90 秒时不打断旧命令，当前文件保留为一个薄包装器，直接转发到新的主脚本。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {number} 被转发脚本的退出码。
 *
 * 注意：
 * - 这里保留旧文件名只是为了兼容，新的实际周期是 90 秒。
 * - 若未来要清理旧入口，应先同步 README、需求文档和用户习惯用法。
 */
DOC

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/run-check-every-90-seconds.sh"
