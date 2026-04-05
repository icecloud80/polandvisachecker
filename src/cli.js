/**
 * 作用：
 * 为历史 CLI 入口提供兼容转发。
 *
 * 为什么这样写：
 * 仓库之前把 `src/cli.js` 作为主入口，但 v1 已切换到 `src/chrome-cli.js`。
 * 保留一个极薄的转发层可以避免旧命令路径意外走回 Playwright / watch 逻辑。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里不再实现任何业务流程。
 * - 所有真实逻辑都以 `src/chrome-cli.js` 为准。
 */
require("./chrome-cli");
