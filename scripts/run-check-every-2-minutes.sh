#!/bin/zsh
: <<'DOC'
/**
 * 作用：
 * 在当前终端前台每 2 分钟运行一次 `npm run check`，直到操作者手动停止脚本。
 *
 * 为什么这样写：
 * 用户这次需要的是“立刻开始、保持在当前 terminal、按 Ctrl-C 停止”的前台循环，
 * 而不是写入 macOS `launchd` 的后台计划任务。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {number} 脚本退出码；通常由用户按 Ctrl-C 中断。
 *
 * 注意：
 * - 通过脚本自身位置反推出项目根目录，避免依赖当前启动目录。
 * - 每轮会补偿本次 `npm run check` 的执行耗时，尽量维持 120 秒一个周期。
 * - 如果单轮检查本身超过 120 秒，则下一轮立即开始，不再额外 sleep。
 */
DOC

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INTERVAL_SECONDS=120

cd "$PROJECT_DIR"

while true; do
  cycle_start="$(date +%s)"
  printf '\n[%s] starting npm run check\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  npm run check
  cycle_end="$(date +%s)"
  elapsed_seconds="$((cycle_end - cycle_start))"
  sleep_seconds="$((INTERVAL_SECONDS - elapsed_seconds))"

  if [ "$sleep_seconds" -gt 0 ]; then
    printf '[%s] sleeping %s seconds before next run\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$sleep_seconds"
    sleep "$sleep_seconds"
  else
    printf '[%s] previous run took %s seconds, starting next run immediately\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$elapsed_seconds"
  fi
done
