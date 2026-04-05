const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOpenRegistrationAction,
  buildRefreshCaptchaClickPointAction,
  buildRefreshCaptchaAction,
  buildSelectAction,
  buildSubmitCurrentStepAction,
  buildSwitchEnglishAction,
  getPageRuntimeSource,
} = require("../src/chrome-page");

/**
 * 作用：
 * 验证页面运行时代码包含自定义下拉所需的关键选择器。
 *
 * 为什么这样写：
 * 当前站点的后半段表单不是原生 `select`，测试要锁住 `combobox` 和 `option` 支持，避免后续回退。
 *
 * 输入：
 * @param {object} 无 - 直接读取运行时代码字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证关键选择器存在，不验证浏览器内实际交互。
 * - 若后续更换组件库，测试内容需要同步更新。
 */
test("getPageRuntimeSource includes custom select selectors", () => {
  const source = getPageRuntimeSource();

  assert.match(source, /\[role='combobox'\]/);
  assert.match(source, /\[role='option'\]/);
  assert.match(source, /selectCustomOptionByText/);
  assert.match(source, /openChoiceTrigger/);
  assert.match(source, /activateElement/);
  assert.match(source, /getScreenClickPointForElement/);
  assert.match(source, /collectPatternCandidates/);
  assert.match(source, /collectVisibleActionableElements/);
  assert.match(source, /getElementSearchTexts/);
  assert.match(source, /elementMatchesPattern/);
  assert.match(source, /normalizeLooseText/);
  assert.match(source, /collapseAdjacentDuplicateWords/);
});

/**
 * 作用：
 * 验证页面运行时代码包含 v1 所需的波兰语字段和无号文案。
 *
 * 为什么这样写：
 * 当前实现重点依赖波兰语字段匹配，如果这些关键文本在源码生成里丢失，
 * CLI 就会在验证码通过后找不到目标下拉框或无号提示。
 *
 * 输入：
 * @param {object} 无 - 直接读取运行时代码字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只锁定关键文本存在，不验证浏览器内实际渲染。
 * - 若站点改文案，需要同时更新实现和测试。
 */
test("getPageRuntimeSource includes Polish field labels and reserved message", () => {
  const source = getPageRuntimeSource();

  assert.match(source, /Rodzaj usługi|rodzaj usługi/i);
  assert.match(source, /Lokalizacja|lokalizacja/i);
  assert.match(source, /Chwilowo wszystkie udostępnione terminy zostały zarezerwowane/i);
  assert.match(source, /selection_step/);
  assert.match(source, /getCaptchaDataVariants/);
  assert.match(source, /processed-threshold/);
  assert.match(source, /refreshPattern/);
});

/**
 * 作用：
 * 验证页面选择动作现在统一通过 choice 选择逻辑，而不是只走原生 `select`。
 *
 * 为什么这样写：
 * 这条动作生成逻辑是 CLI 后续字段选择的入口，测试可以防止将来误改回只支持原生下拉。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证生成的源码片段。
 * - 真实 DOM 行为仍需靠现场调试确认。
 */
test("buildSelectAction delegates to selectChoiceByText", () => {
  const action = buildSelectAction("/location/i", "runtime.CONFIG.locationPattern", "selectLocation");

  assert.match(action, /selectChoiceByText/);
  assert.match(action, /controlType/);
});

/**
 * 作用：
 * 验证页面导航动作现在只返回目标链接，而不直接在页面里触发导航。
 *
 * 为什么这样写：
 * 真实 Chrome + AppleScript 场景下，页面内直接导航会让桥接层收到 `missing value`。
 * 这个测试要锁住“页面只返回 href，Node 侧再导航”的修复。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码里存在 `href` 返回值。
 * - 真实导航行为由 CLI 侧单独处理。
 */
test("navigation actions return href instead of navigating inline", () => {
  assert.match(buildSwitchEnglishAction(), /href:/);
  assert.match(buildOpenRegistrationAction(), /href:/);
  assert.doesNotMatch(buildSwitchEnglishAction(), /window\.location/);
  assert.doesNotMatch(buildOpenRegistrationAction(), /window\.location/);
});

/**
 * 作用：
 * 验证“只提交当前步骤”的页面动作不会覆盖已有输入值。
 *
 * 为什么这样写：
 * 当用户已经在 Chrome 页里手动填好验证码时，
 * CLI 需要继续点击 `Dalej`，但不能再把输入框内容改掉。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码会调用 `submitCurrentStep`。
 * - 实际按钮点击行为仍依赖真实页面。
 */
test("buildSubmitCurrentStepAction only submits the current page state", () => {
  const action = buildSubmitCurrentStepAction();

  assert.match(action, /submitCurrentStep/);
  assert.doesNotMatch(action, /fillCaptcha/);
});

/**
 * 作用：
 * 验证验证码刷新动作会点击刷新按钮，而不是误用提交动作。
 *
 * 为什么这样写：
 * 新的 OCR 链路在拿不到 4 位候选值时会主动刷新验证码。
 * 这条测试能锁住“找刷新按钮并点击”的行为，避免后续回退成提交空值。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码片段，不验证真实 DOM。
 * - 刷新动作不应包含 `submitCurrentStep`。
 */
test("buildRefreshCaptchaAction targets the refresh button instead of submitting", () => {
  const action = buildRefreshCaptchaAction();

  assert.match(action, /refreshCaptcha/);
  assert.match(action, /refreshPattern/);
  assert.match(action, /activateElement|openChoiceTrigger/);
  assert.doesNotMatch(action, /submitCurrentStep/);
});

/**
 * 作用：
 * 验证验证码刷新坐标动作会读取 `Odśwież` 的屏幕点击点。
 *
 * 为什么这样写：
 * 真实鼠标点击 fallback 依赖页面侧计算好的全局坐标。
 * 这条测试可以锁住“刷新按钮 -> clickPoint”这条源码生成契约。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证生成代码，不执行页面逻辑。
 * - 当前结果应包含 `refreshCaptchaClickPoint` 和 `getScreenClickPointForElement`。
 */
test("buildRefreshCaptchaClickPointAction returns the screen point for the refresh control", () => {
  const action = buildRefreshCaptchaClickPointAction();

  assert.match(action, /refreshCaptchaClickPoint/);
  assert.match(action, /getScreenClickPointForElement/);
  assert.match(action, /clickPoint/);
  assert.match(action, /actionableElements/);
  assert.match(action, /candidates/);
  assert.match(action, /collectPatternCandidates/);
  assert.match(action, /visibleActionableElements/);
  assert.match(action, /collectVisibleActionableElements/);
  assert.match(action, /describeElement/);
});
