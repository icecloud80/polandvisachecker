#!/bin/zsh
: <<'DOC'
/**
 * 作用：
 * 在当前终端前台按固定分钟周期重复执行 `npm run check`，直到操作者手动停止脚本。
 *
 * 为什么这样写：
 * 用户现在希望前台循环主入口统一成 `run-check.sh`，
 * 默认按 2 分钟节拍运行，同时允许通过 `-m=3` 这类参数快速改成别的分钟数，
 * 这样既保留“立刻开始、留在当前 terminal、Ctrl-C 停止”的使用方式，又避免脚本名和默认周期绑定死。
 *
 * 输入：
 * @param {string[]} "$@" - 可选命令行参数；当前支持 `-m=<minutes>` 和 `-m <minutes>`。
 *
 * 输出：
 * @returns {number} 脚本退出码；通常由用户按 Ctrl-C 中断。
 *
 * 注意：
 * - 通过脚本自身位置反推出项目根目录，避免依赖当前启动目录。
 * - 当前分钟参数只接受正整数，避免把 shell 算术和 sleep 带进不稳定的小数路径。
 * - 每轮会补偿本次 `npm run check` 的执行耗时，尽量维持配置的 start-to-start 周期。
 */
DOC

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INTERVAL_MINUTES=2

while [ "$#" -gt 0 ]; do
  case "$1" in
    -m=*)
      INTERVAL_MINUTES="${1#-m=}"
      ;;
    -m)
      if [ "$#" -lt 2 ]; then
        echo 'Usage: ./scripts/run-check.sh [-m=<minutes>]' >&2
        exit 1
      fi
      INTERVAL_MINUTES="$2"
      shift
      ;;
    -h|--help)
      echo 'Usage: ./scripts/run-check.sh [-m=<minutes>]'
      exit 0
      ;;
    *)
      printf 'Unsupported argument: %s\n' "$1" >&2
      echo 'Usage: ./scripts/run-check.sh [-m=<minutes>]' >&2
      exit 1
      ;;
  esac
  shift
done

if ! [[ "$INTERVAL_MINUTES" == <-> && "$INTERVAL_MINUTES" -gt 0 ]]; then
  printf 'Invalid minute value: %s\n' "$INTERVAL_MINUTES" >&2
  echo 'The -m value must be a positive integer.' >&2
  exit 1
fi

INTERVAL_SECONDS="$((INTERVAL_MINUTES * 60))"

cd "$PROJECT_DIR"

while true; do
  cycle_start="$(date +%s)"
  printf '\n[%s] starting npm run check (interval=%s minute(s))\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$INTERVAL_MINUTES"
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
