const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * 作用：
 * 返回启用 macOS 辅助功能权限时的用户提示。
 *
 * 为什么这样写：
 * 真实鼠标点击 fallback 依赖系统级事件注入。
 * 如果终端或 Codex 没有辅助功能权限，用户需要看到明确的修复路径，而不是只看到 Quartz 相关报错。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 面向用户的辅助功能权限提示。
 *
 * 注意：
 * - 文案以 macOS 英文设置路径为准。
 * - 这里只是帮助提示，不做权限探测。
 */
function getAccessibilityHelpText() {
  return "In macOS System Settings > Privacy & Security > Accessibility, allow your terminal or Codex app to control the computer, then run the command again.";
}

/**
 * 作用：
 * 识别 Chrome 是否关闭了 Apple Events JavaScript 权限。
 *
 * 为什么这样写：
 * 这是命令行版最常见的前置阻塞，需要单独识别并给出明确修复路径。
 *
 * 输入：
 * @param {string} stderrText - 命令失败时的输出文本。
 *
 * 输出：
 * @returns {boolean} 是否命中了该权限错误。
 *
 * 注意：
 * - 这里只匹配已知错误文案。
 * - 如果 Chrome 后续修改错误文案，可能需要同步更新。
 */
function isAppleEventsJavaScriptDisabled(stderrText) {
  return /allow javascript from apple events/i.test(String(stderrText || ""));
}

/**
 * 作用：
 * 返回开启 Chrome Apple Events JavaScript 的用户提示。
 *
 * 为什么这样写：
 * 把修复指引固定成一条文案，CLI 在多个地方都能复用，避免提示不一致。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 面向用户的修复说明。
 *
 * 注意：
 * - 文案以 macOS 英文菜单路径为准。
 * - 这不是程序逻辑，只是诊断辅助信息。
 */
function getAppleEventsHelpText() {
  return "In Google Chrome, open View > Developer > Allow JavaScript from Apple Events, then run the command again.";
}

/**
 * 作用：
 * 执行一段 AppleScript，并统一返回标准输出文本。
 *
 * 为什么这样写：
 * Chrome CLI 版所有浏览器控制都基于 AppleScript，统一封装后便于集中处理权限和错误信息。
 *
 * 输入：
 * @param {string[]} lines - 逐行 AppleScript 源码。
 *
 * 输出：
 * @returns {Promise<string>} 执行后的标准输出文本。
 *
 * 注意：
 * - 调用方应保证每一行是完整的 AppleScript 语句。
 * - 报错时会保留原始 stderr 供上层诊断。
 */
async function runAppleScript(lines) {
  const args = lines.flatMap((line) => ["-e", line]);

  try {
    const { stdout } = await execFileAsync("osascript", args);
    return String(stdout || "").trim();
  } catch (error) {
    const stderr = String(error.stderr || error.stdout || error.message || "");

    if (isAppleEventsJavaScriptDisabled(stderr)) {
      error.appleEventsHelpText = getAppleEventsHelpText();
    }

    throw error;
  }
}

/**
 * 作用：
 * 执行一段 JXA 脚本，并统一返回标准输出文本。
 *
 * 为什么这样写：
 * 真实鼠标点击 fallback 需要通过 JXA 调用 Quartz 事件。
 * 单独封装后可以与 AppleScript 桥接并存，并集中处理辅助功能权限提示。
 *
 * 输入：
 * @param {string} source - JXA 源码。
 *
 * 输出：
 * @returns {Promise<string>} 执行后的标准输出文本。
 *
 * 注意：
 * - 调用方应保证源码是完整的 JXA 片段。
 * - 报错时会附带辅助功能权限提示，便于排查真实点击失败原因。
 */
async function runJxaScript(source) {
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", String(source || "")]);
    return String(stdout || "").trim();
  } catch (error) {
    error.accessibilityHelpText = getAccessibilityHelpText();
    throw error;
  }
}

/**
 * 作用：
 * 把任意 JavaScript 源码编码成可安全嵌入 AppleScript 的表达式。
 *
 * 为什么这样写：
 * 直接把大量源码塞进 AppleScript 字符串容易出现引号和换行转义问题，转成 base64 后更稳。
 *
 * 输入：
 * @param {string} source - 原始 JavaScript 源码。
 *
 * 输出：
 * @returns {string} 可在页面中 eval 的包装表达式。
 *
 * 注意：
 * - 这里只负责传输安全，不负责源码正确性。
 * - 页面返回值需要在源代码内部自行返回字符串。
 */
function wrapJavaScriptForAppleScript(source) {
  const base64 = Buffer.from(String(source), "utf8").toString("base64");
  return `(function(){return eval(atob(${JSON.stringify(base64)}));})()`;
}

/**
 * 作用：
 * 从目标网址中提取用于匹配 Chrome 标签页的主机名。
 *
 * 为什么这样写：
 * 命令行版需要稳定锁定签证站点标签页，使用主机名匹配比依赖前台活动标签页更可靠。
 *
 * 输入：
 * @param {string} url - 完整目标网址。
 *
 * 输出：
 * @returns {string} 可用于 AppleScript contains 匹配的主机名。
 *
 * 注意：
 * - 输入无效时会抛异常，让调用方尽早发现配置问题。
 * - 当前仅返回 host，不包含路径。
 */
function extractHostFromUrl(url) {
  return new URL(url).host;
}

/**
 * 作用：
 * 生成用于锁定 Chrome 标签页的匹配主机名。
 *
 * 为什么这样写：
 * 目标站点在流程中可能跨越同一主域下的不同子域，锁到整个业务主域比锁单一子域更稳。
 *
 * 输入：
 * @param {string} url - 完整目标网址。
 *
 * 输出：
 * @returns {string} 用于 AppleScript contains 判断的主机匹配串。
 *
 * 注意：
 * - 当前对 e-konsulat.gov.pl 做了特化处理。
 * - 如果后续流程跨到完全不同的主域，需要重新审视这条规则。
 */
function buildChromeTabMatchHost(url) {
  const host = extractHostFromUrl(url);

  if (host.endsWith(".e-konsulat.gov.pl")) {
    return "e-konsulat.gov.pl";
  }

  return host;
}

/**
 * 作用：
 * 把传入的屏幕坐标规范成可用于真实点击的整数点位。
 *
 * 为什么这样写：
 * 页面侧返回的坐标可能带小数或字符串。
 * 在进入 Quartz 事件前先统一转成整数，可以减少系统级点击的兼容性问题。
 *
 * 输入：
 * @param {object} screenPoint - 包含 x、y 的坐标对象。
 *
 * 输出：
 * @returns {{x:number, y:number}} 规范后的整数坐标。
 *
 * 注意：
 * - 非法值会回退到 0。
 * - 调用方仍需自行判断 0,0 是否可接受。
 */
function normalizeScreenPoint(screenPoint) {
  return {
    x: Math.round(Number(screenPoint && screenPoint.x ? screenPoint.x : 0)),
    y: Math.round(Number(screenPoint && screenPoint.y ? screenPoint.y : 0)),
  };
}

/**
 * 作用：
 * 生成用于真实鼠标点击的 JXA 源码。
 *
 * 为什么这样写：
 * 把 Quartz 鼠标事件序列集中封装成纯函数后，测试可以直接锁住坐标注入和事件顺序，
 * 不需要在单元测试里真的触发系统点击。
 *
 * 输入：
 * @param {object} screenPoint - 包含 x、y 的屏幕坐标。
 *
 * 输出：
 * @returns {string} 可执行真实点击的 JXA 源码。
 *
 * 注意：
 * - 这里使用左键单击。
 * - 坐标应为全局屏幕坐标，而不是页面内部坐标。
 */
function buildMouseClickJxaSource(screenPoint) {
  const normalizedPoint = normalizeScreenPoint(screenPoint);

  return `
    ObjC.import("ApplicationServices");
    ObjC.import("Foundation");
    const clickPoint = $.CGPointMake(${normalizedPoint.x}, ${normalizedPoint.y});
    const moveEvent = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, clickPoint, $.kCGMouseButtonLeft);
    const downEvent = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, clickPoint, $.kCGMouseButtonLeft);
    const upEvent = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, clickPoint, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, moveEvent);
    $.NSThread.sleepForTimeInterval(0.03);
    $.CGEventPost($.kCGHIDEventTap, downEvent);
    $.NSThread.sleepForTimeInterval(0.03);
    $.CGEventPost($.kCGHIDEventTap, upEvent);
  `;
}

/**
 * 作用：
 * 把目标 Chrome 标签页切到前台，但不改动当前页面网址。
 *
 * 为什么这样写：
 * 真实鼠标点击必须落到正确的 Chrome 窗口和标签页上。
 * 先聚焦目标标签页后再发系统点击，才能避免点击落到别的应用或错误标签页。
 *
 * 输入：
 * @param {string} url - 用于锁定 Chrome 标签页的目标网址。
 *
 * 输出：
 * @returns {Promise<void>} 聚焦完成后的 Promise。
 *
 * 注意：
 * - 若未找到匹配标签页，会抛出与现有桥接一致的 missing-tab 错误。
 * - 该函数不会触发页面导航。
 */
async function focusChromeTab(url) {
  const targetHost = buildChromeTabMatchHost(url);

  await runAppleScript([
    'tell application "Google Chrome" to activate',
    'tell application "Google Chrome"',
    'set targetWindowIndex to 0',
    'set targetTabIndex to 0',
    'repeat with wi from 1 to count of windows',
    'repeat with ti from 1 to count of tabs of window wi',
    `if (URL of tab ti of window wi contains ${JSON.stringify(targetHost)}) then`,
    'set targetWindowIndex to wi',
    'set targetTabIndex to ti',
    'exit repeat',
    'end if',
    'end repeat',
    'if targetTabIndex is not 0 then exit repeat',
    'end repeat',
    'if targetTabIndex is 0 then error "Poland visa Chrome tab not found."',
    'set index of window targetWindowIndex to 1',
    'set active tab index of window targetWindowIndex to targetTabIndex',
    'activate',
    'end tell',
  ]);
}

/**
 * 作用：
 * 在前台 Chrome 标签页上执行一次真实鼠标点击。
 *
 * 为什么这样写：
 * 当前站点对页面内 synthetic click 不够敏感。
 * 当 `Odśwież` 需要真实用户手势时，这条桥接能力可以作为最终 fallback。
 *
 * 输入：
 * @param {object} screenPoint - 全局屏幕坐标。
 * @param {string} url - 用于聚焦目标标签页的匹配网址。
 *
 * 输出：
 * @returns {Promise<void>} 点击完成后的 Promise。
 *
 * 注意：
 * - 依赖 Chrome 标签页已存在且位于前台。
 * - 依赖 macOS 辅助功能权限。
 */
async function clickChromeScreenPoint(screenPoint, url) {
  await focusChromeTab(url);
  await runJxaScript(buildMouseClickJxaSource(screenPoint));
}

/**
 * 作用：
 * 激活 Chrome，并把前台标签页导航到目标网址。
 *
 * 为什么这样写：
 * 命令行版依赖真实 Chrome 前台标签页作为执行目标，统一前置准备可以减少后续控制失败率。
 *
 * 输入：
 * @param {string} url - 目标网址。
 *
 * 输出：
 * @returns {Promise<void>} 页面准备完成后的 Promise。
 *
 * 注意：
 * - 当前实现会复用前台标签页。
 * - 如果用户要保留当前前台标签页，建议专门开一个 Chrome 窗口给本工具使用。
 */
async function prepareChromeTab(url) {
  const targetHost = buildChromeTabMatchHost(url);

  await runAppleScript([
    'tell application "Google Chrome" to activate',
    'tell application "Google Chrome" to if (count of windows) = 0 then make new window',
    'tell application "Google Chrome"',
    'set targetWindowIndex to 0',
    'set targetTabIndex to 0',
    'repeat with wi from 1 to count of windows',
    'repeat with ti from 1 to count of tabs of window wi',
    `if (URL of tab ti of window wi contains ${JSON.stringify(targetHost)}) then`,
    'set targetWindowIndex to wi',
    'set targetTabIndex to ti',
    'exit repeat',
    'end if',
    'end repeat',
    'if targetTabIndex is not 0 then exit repeat',
    'end repeat',
    'if targetTabIndex is 0 then',
    'make new tab at end of tabs of front window',
    'set targetWindowIndex to 1',
    'set targetTabIndex to active tab index of front window',
    `set URL of active tab of front window to ${JSON.stringify(url)}`,
    'else',
    'set index of window targetWindowIndex to 1',
    'set active tab index of front window to targetTabIndex',
    `set URL of active tab of front window to ${JSON.stringify(url)}`,
    'end if',
    'end tell',
  ]);
}

/**
 * 作用：
 * 在 Chrome 前台标签页中执行 JavaScript 并返回结果文本。
 *
 * 为什么这样写：
 * 这是命令行版与真实浏览器页面通信的核心桥梁。
 *
 * 输入：
 * @param {string} source - 待执行的 JavaScript 源码。
 *
 * 输出：
 * @returns {Promise<string>} 页面返回的字符串结果。
 *
 * 注意：
 * - 依赖用户在 Chrome 中启用 Apple Events JavaScript 权限。
 * - 结果通常应为 JSON 字符串，便于上层解析。
 */
async function executeJavaScriptInActiveTab(source, url) {
  const targetHost = buildChromeTabMatchHost(url);
  const wrappedSource = wrapJavaScriptForAppleScript(source);

  return runAppleScript([
    'tell application "Google Chrome"',
    'set targetWindowIndex to 0',
    'set targetTabIndex to 0',
    'repeat with wi from 1 to count of windows',
    'repeat with ti from 1 to count of tabs of window wi',
    `if (URL of tab ti of window wi contains ${JSON.stringify(targetHost)}) then`,
    'set targetWindowIndex to wi',
    'set targetTabIndex to ti',
    'exit repeat',
    'end if',
    'end repeat',
    'if targetTabIndex is not 0 then exit repeat',
    'end repeat',
    'if targetTabIndex is 0 then error "Poland visa Chrome tab not found."',
    'set index of window targetWindowIndex to 1',
    'set active tab index of front window to targetTabIndex',
    `execute active tab of front window javascript ${JSON.stringify(wrappedSource)}`,
    'end tell',
  ]);
}

module.exports = {
  buildChromeTabMatchHost,
  buildMouseClickJxaSource,
  clickChromeScreenPoint,
  extractHostFromUrl,
  executeJavaScriptInActiveTab,
  focusChromeTab,
  getAccessibilityHelpText,
  getAppleEventsHelpText,
  isAppleEventsJavaScriptDisabled,
  normalizeScreenPoint,
  prepareChromeTab,
  runAppleScript,
  runJxaScript,
  wrapJavaScriptForAppleScript,
};
