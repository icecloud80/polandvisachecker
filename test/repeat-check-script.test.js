const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 作用：
 * 验证新的前台循环主脚本会在当前终端内重复执行 `npm run check`，默认按 2 分钟周期运行。
 *
 * 为什么这样写：
 * 用户现在要求只保留 `run-check.sh` 作为前台循环入口，并把默认周期恢复为 2 分钟。
 * 用静态内容测试锁住新入口和默认值后，后续重构时就不容易把脚本名或默认节拍再漂掉。
 *
 * 输入：
 * @param {object} 无 - 直接读取脚本文件文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证脚本契约，不真的启动无限循环。
 * - 关键契约是切到项目目录、执行 `npm run check`、并按 120 秒默认节拍补偿 sleep。
 */
test("run-check script keeps a foreground 2-minute check loop by default", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "run-check.sh");
  const scriptText = fs.readFileSync(scriptPath, "utf8");

  assert.match(scriptText, /PROJECT_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(scriptText, /INTERVAL_MINUTES=2/);
  assert.match(scriptText, /INTERVAL_SECONDS="\$\(\(INTERVAL_MINUTES \* 60\)\)"/);
  assert.match(scriptText, /while true; do/);
  assert.match(scriptText, /npm run check/);
  assert.match(scriptText, /sleep_seconds="\$\(\(INTERVAL_SECONDS - elapsed_seconds\)\)"/);
  assert.match(scriptText, /sleep "\$sleep_seconds"/);
});

/**
 * 作用：
 * 验证新的前台循环主脚本支持用 `-m=3` 这类参数覆盖默认分钟数。
 *
 * 为什么这样写：
 * 用户明确要求通过命令行参数把周期改成任意分钟数，例如 `-m=3`。
 * 这条测试锁住参数解析入口，避免后续只保留默认值却丢掉可调周期能力。
 *
 * 输入：
 * @param {object} 无 - 直接读取脚本文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证参数解析结构，不真的执行脚本。
 * - 当前至少要支持 `-m=<minutes>` 形式。
 */
test("run-check script supports overriding the repeat interval with -m=<minutes>", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "run-check.sh");
  const scriptText = fs.readFileSync(scriptPath, "utf8");

  assert.match(scriptText, /case "\$1" in/);
  assert.match(scriptText, /-m=\*/);
  assert.match(scriptText, /INTERVAL_MINUTES="\$\{1#-m=\}"/);
  assert.match(scriptText, /shift/);
});
