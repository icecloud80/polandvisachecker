const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 作用：
 * 验证新的前台循环主脚本会在当前终端内重复执行 `npm run check`，并把周期控制在 90 秒。
 *
 * 为什么这样写：
 * 用户最新把频率改成了 90 秒。
 * 用静态内容测试锁住关键行为后，后续重构时就不容易把“前台循环”误改回旧的 120 秒或后台调度。
 *
 * 输入：
 * @param {object} 无 - 直接读取脚本文件文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证脚本契约，不真的启动无限循环。
 * - 关键契约是切到项目目录、执行 `npm run check`、并按 90 秒节拍补偿 sleep。
 */
test("run-check-every-90-seconds script keeps a foreground 90-second check loop", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "run-check-every-90-seconds.sh");
  const scriptText = fs.readFileSync(scriptPath, "utf8");

  assert.match(scriptText, /PROJECT_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(scriptText, /INTERVAL_SECONDS=90/);
  assert.match(scriptText, /while true; do/);
  assert.match(scriptText, /npm run check/);
  assert.match(scriptText, /sleep_seconds="\$\(\(INTERVAL_SECONDS - elapsed_seconds\)\)"/);
  assert.match(scriptText, /sleep "\$sleep_seconds"/);
});

/**
 * 作用：
 * 验证旧的 2 分钟脚本入口仍然保留，并会转发到新的 90 秒主脚本。
 *
 * 为什么这样写：
 * 仓库里已经存在旧脚本文件名，直接删除会打断已有命令习惯。
 * 这条测试锁住兼容包装器的存在，避免未来在未公告的情况下把旧入口移除。
 *
 * 输入：
 * @param {object} 无 - 直接读取兼容包装器脚本文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证转发关系，不真的执行 `exec`。
 * - 若未来决定删除旧入口，测试、README 和需求文档必须一起更新。
 */
test("run-check-every-2-minutes compatibility wrapper forwards to the 90-second script", () => {
  const wrapperPath = path.join(__dirname, "..", "scripts", "run-check-every-2-minutes.sh");
  const wrapperText = fs.readFileSync(wrapperPath, "utf8");

  assert.match(wrapperText, /exec "\$SCRIPT_DIR\/run-check-every-90-seconds\.sh"/);
});
