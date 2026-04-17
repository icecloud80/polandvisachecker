const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 作用：
 * 验证前台循环脚本会在当前终端内重复执行 `npm run check`，并把周期控制在 120 秒。
 *
 * 为什么这样写：
 * 这份脚本是给用户直接运行的稳定入口。
 * 用静态内容测试锁住关键行为后，后续重构时就不容易把“前台循环”误改回后台调度或一次性命令。
 *
 * 输入：
 * @param {object} 无 - 直接读取脚本文件文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证脚本契约，不真的启动无限循环。
 * - 关键契约是切到项目目录、执行 `npm run check`、并按 120 秒节拍补偿 sleep。
 */
test("run-check-every-2-minutes script keeps a foreground 120-second check loop", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "run-check-every-2-minutes.sh");
  const scriptText = fs.readFileSync(scriptPath, "utf8");

  assert.match(scriptText, /PROJECT_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(scriptText, /INTERVAL_SECONDS=120/);
  assert.match(scriptText, /while true; do/);
  assert.match(scriptText, /npm run check/);
  assert.match(scriptText, /sleep_seconds="\$\(\(INTERVAL_SECONDS - elapsed_seconds\)\)"/);
  assert.match(scriptText, /sleep "\$sleep_seconds"/);
});
