const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCloseChromeTabAppleScript,
  buildPrepareChromeTabAppleScript,
  buildMouseClickJxaSource,
  buildChromeTabMatchHost,
  extractHostFromUrl,
  getAccessibilityHelpText,
  normalizeScreenPoint,
} = require("../src/chrome-bridge");

/**
 * 作用：
 * 验证 Chrome 桥接层会从完整网址中提取正确主机名。
 *
 * 为什么这样写：
 * 命令行版现在靠主机名锁定签证站点标签页，这个纯函数一旦出错，后续执行就会串到错误标签页。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例网址。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前测试只覆盖标准 https URL。
 * - 若后续支持更多协议或端口格式，应补充更多用例。
 */
test("extractHostFromUrl returns the host portion of the target URL", () => {
  assert.equal(
    extractHostFromUrl("https://secure.e-konsulat.gov.pl/placowki/126"),
    "secure.e-konsulat.gov.pl"
  );
});

/**
 * 作用：
 * 验证 Chrome 标签页匹配规则会把签证站点子域归并到业务主域。
 *
 * 为什么这样写：
 * 真实流程中页面可能在 `secure` 之外的同主域子站跳转，测试能防止标签页追踪再次串掉。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例网址。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这个规则是对当前站点的特化。
 * - 如果将来支持更多站点，需要考虑更通用的主域提取方案。
 */
test("buildChromeTabMatchHost widens e-konsulat subdomains to the site root", () => {
  assert.equal(
    buildChromeTabMatchHost("https://secure.e-konsulat.gov.pl/placowki/126"),
    "e-konsulat.gov.pl"
  );
});

/**
 * 作用：
 * 验证准备 Chrome 标签页的 AppleScript 会退回到最小可用的兜底导航结构。
 *
 * 为什么这样写：
 * 之前 fallback 分支真实撞到了 AppleScript 语法错误。
 * 现在把 fallback 收缩成 `activate + open location` 后，需要测试锁住这条可执行结构。
 *
 * 输入：
 * @param {object} 无 - 直接生成 AppleScript 源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码结构，不真正启动 Chrome。
 * - 复用已有标签页的逻辑不在这里测，而在更高层的页面探测里测。
 */
test("buildPrepareChromeTabAppleScript uses a minimal open-location fallback", () => {
  const lines = buildPrepareChromeTabAppleScript(
    "https://secure.e-konsulat.gov.pl/placowki/126/wiza-schengen/wizyty/weryfikacja-obrazkowa"
  );

  assert.ok(lines.includes('tell application "Google Chrome" to activate'));
  assert.ok(lines.some((line) => /tell application "Google Chrome" to open location/u.test(line)));
  assert.ok(!lines.some((line) => /URL of tab ti of window wi/u.test(line)));
  assert.ok(!lines.some((line) => /make new tab at end of tabs/u.test(line)));
});

/**
 * 作用：
 * 验证关闭签证标签页的 AppleScript 会先按主机名定位目标 tab，再只关闭该 tab。
 *
 * 为什么这样写：
 * 新需求要求 `check` 在“没有预约时间”时自动关闭当前签证 tab。
 * 这条测试锁住“只关闭匹配业务主域的标签页”这一桥接契约，避免误关到别的 Chrome 页面。
 *
 * 输入：
 * @param {object} 无 - 直接生成 AppleScript 源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码结构，不真正启动 Chrome。
 * - 找不到目标标签页时仍应保留既有 missing-tab 错误语义。
 */
test("buildCloseChromeTabAppleScript targets the matching visa tab and closes only that tab", () => {
  const lines = buildCloseChromeTabAppleScript("https://secure.e-konsulat.gov.pl/placowki/126");

  assert.ok(lines.some((line) => /contains "e-konsulat\.gov\.pl"/u.test(line)));
  assert.ok(lines.includes('if targetTabIndex is 0 then error "Poland visa Chrome tab not found."'));
  assert.ok(lines.includes('close tab targetTabIndex of window targetWindowIndex'));
  assert.ok(!lines.some((line) => /open location/u.test(line)));
});

/**
 * 作用：
 * 验证屏幕点击坐标会被规范成整数值。
 *
 * 为什么这样写：
 * 真实鼠标点击 fallback 依赖系统级坐标，测试需要锁住数值清洗规则，
 * 避免页面返回的小数或字符串直接进入 Quartz 事件层。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例坐标对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只验证四舍五入与非法值回退。
 * - 不验证坐标是否落在真实屏幕范围内。
 */
test("normalizeScreenPoint rounds and sanitizes mouse click coordinates", () => {
  assert.deepEqual(normalizeScreenPoint({ x: "101.6", y: 222.2 }), { x: 102, y: 222 });
  assert.deepEqual(normalizeScreenPoint({ x: null, y: undefined }), { x: 0, y: 0 });
});

/**
 * 作用：
 * 验证真实点击 JXA 源码会包含目标坐标和左键事件。
 *
 * 为什么这样写：
 * 真实刷新 fallback 完全依赖这段源码发 Quartz 鼠标事件。
 * 用测试锁住关键事件和坐标插值后，可以避免后续改动把真实点击路径悄悄破坏。
 *
 * 输入：
 * @param {object} 无 - 直接生成示例 JXA 源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码结构，不在单元测试里真正发送系统点击。
 * - 当前要求包含 move、down、up 三类事件。
 */
test("buildMouseClickJxaSource includes the target point and left-click events", () => {
  const source = buildMouseClickJxaSource({ x: 321, y: 654 });

  assert.match(source, /CGPointMake\(321,\s*654\)/);
  assert.match(source, /kCGEventMouseMoved/);
  assert.match(source, /kCGEventLeftMouseDown/);
  assert.match(source, /kCGEventLeftMouseUp/);
});

/**
 * 作用：
 * 验证辅助功能权限提示文案保持可操作。
 *
 * 为什么这样写：
 * 真实鼠标点击 fallback 失败时，用户最需要的是明确的系统设置路径。
 * 这条测试能防止帮助文案回退成难懂的内部错误说明。
 *
 * 输入：
 * @param {object} 无 - 直接读取提示文案。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前文案以英文设置路径为准。
 * - 这里只验证关键路径存在。
 */
test("getAccessibilityHelpText explains how to enable system click permissions", () => {
  assert.match(getAccessibilityHelpText(), /Accessibility/i);
  assert.match(getAccessibilityHelpText(), /System Settings/i);
});
