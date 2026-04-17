const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOpenConsulateAction,
  buildOpenCountryAction,
  buildOpenCountryLetterAction,
  buildPatternPresenceAction,
  buildOpenRegistrationAction,
  buildRefreshCaptchaClickPointAction,
  buildRefreshCaptchaAction,
  buildSelectAction,
  buildSnapshotAction,
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
  assert.match(source, /getOrderedVisibleHomepageLanguageTriggers/);
  assert.match(source, /findHomepageLanguageTrigger/);
  assert.match(source, /switchHomepageLanguageToEnglish/);
  assert.match(source, /isLanguageFieldPattern/);
  assert.match(source, /getOrderedVisibleChoiceTriggers/);
  assert.match(source, /getChoiceFieldOrderIndex/);
  assert.match(source, /findCustomSelectByFieldOrder/);
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

  assert.match(source, /englishServicePattern/);
  assert.match(source, /englishLocationPattern/);
  assert.match(source, /englishServiceFieldPattern/);
  assert.match(source, /englishLocationFieldPattern/);
  assert.match(source, /languageFieldPattern/);
  assert.match(source, /\[aria-haspopup='true'\]/);
  assert.match(source, /mat-select/);
  assert.match(source, /united states of america/i);
  assert.match(source, /stany zjednoczone ameryki/i);
  assert.match(source, /consulate general of the republic of poland in los angeles/i);
  assert.match(source, /konsulat generaln.*los angeles/i);
  assert.match(source, /register the form/i);
  assert.match(source, /Rodzaj usługi|rodzaj usługi/i);
  assert.match(source, /Lokalizacja|lokalizacja/i);
  assert.match(source, /Chwilowo wszystkie udostępnione terminy zostały zarezerwowane/i);
  assert.match(source, /unavailableNormalizedPattern/);
  assert.match(source, /normalizeLooseText\(normalizedText\)/);
  assert.match(source, /selection_step/);
  assert.match(source, /getSelectionLabelEvidence/);
  assert.match(source, /getCaptchaDataVariants/);
  assert.match(source, /processed-threshold/);
  assert.match(source, /refreshPattern/);
  assert.match(source, /inspectChoiceField/);
  assert.match(buildSnapshotAction(), /selectionDiagnostics/);
  assert.match(buildSnapshotAction(), /selectionLabelEvidence/);
});

/**
 * 作用：
 * 验证页面状态判定会优先认定 post-captcha 下拉页，而不是被 captcha 路径误导。
 *
 * 为什么这样写：
 * 真实站点在通过验证码后，URL 仍可能保留 `weryfikacja-obrazkowa`。
 * 如果判断顺序错了，CLI 会把下一页误判成 `captcha_step`，导致终端继续等待。
 *
 * 输入：
 * @param {object} 无 - 直接检查运行时代码中关键判断片段的先后顺序。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只锁住顺序，不执行浏览器内逻辑。
 * - `selection_step` 和 `date_options_present` 都必须先于 `captcha_step` 判断。
 */
test("getPageRuntimeSource prioritizes selection evidence before captcha-step detection", () => {
  const source = getPageRuntimeSource();
  const selectionIndex = source.indexOf('reason: "selection_step"');
  const availableIndex = source.indexOf('reason: "date_options_present"');
  const captchaIndex = source.indexOf('reason: "captcha_step"');

  assert.ok(selectionIndex >= 0);
  assert.ok(availableIndex >= 0);
  assert.ok(captchaIndex >= 0);
  assert.ok(selectionIndex < captchaIndex);
  assert.ok(availableIndex < captchaIndex);
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
 * 验证自定义下拉在文本匹配失败时会回退到固定顺序映射。
 *
 * 为什么这样写：
 * 这次 live 证据已经证明 4 个 `mat-select` 没有可用标签上下文，
 * 如果顺序回退逻辑被删掉，post-captcha 页面会再次全部 `not_found`。
 *
 * 输入：
 * @param {object} 无 - 直接检查运行时代码中关键回退调用是否存在。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只锁住源码契约，不执行浏览器内排序逻辑。
 * - 文本优先策略仍应保留，因此测试只要求回退存在。
 */
test("getPageRuntimeSource falls back to field-order mapping for custom selects", () => {
  const source = getPageRuntimeSource();

  assert.match(source, /return findCustomSelectByFieldOrder\(fieldPattern\)/);
  assert.match(source, /const homepageLanguageTrigger = findHomepageLanguageTrigger\(\)/);
  assert.match(source, /filter\(\(element\) => element !== homepageLanguageTrigger\)/);
  assert.match(source, /if \(orderedTriggers\.length < 2\)/);
  assert.match(source, /if \(\/rodzaj\|service\|uslug\/i\.test\(matcherSource\)\)/);
  assert.match(source, /if \(\/lokalizacja\|location\/i\.test\(matcherSource\)\)/);
  assert.match(source, /if \(\/rezerwowac\|reserve\|people\|osob\/i\.test\(matcherSource\)\)/);
  assert.match(source, /if \(\/date\|data\|termin\/i\.test\(matcherSource\)\)/);
});

/**
 * 作用：
 * 验证英文切换动作会通过首页语言下拉专用逻辑完成，而不是复用普通字段选择。
 *
 * 为什么这样写：
 * 新流程要求先通过右上角黄色横条里的语言下拉切到 English。
 * 这条测试锁住英文切换走首页专用动作，避免再退回到上下文脆弱的通用字段匹配。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码契约，不执行真实页面。
 * - 动作应回显 `controlType`，便于 CLI 记录是否找到了首页语言下拉。
 */
test("buildSwitchEnglishAction delegates to the homepage language dropdown helper", () => {
  const action = buildSwitchEnglishAction();

  assert.match(action, /switchHomepageLanguageToEnglish/);
  assert.match(action, /controlType/);
  assert.doesNotMatch(action, /selectChoiceByText/);
  assert.doesNotMatch(action, /href:/);
  assert.doesNotMatch(action, /window\.location/);
});

/**
 * 作用：
 * 验证页面运行时代码显式包含首页语言下拉定位和 English 切换逻辑。
 *
 * 为什么这样写：
 * 用户现场已经明确指出必须选黄色横条里那个 dropdown。
 * 这条测试锁住首页专用定位器和切换动作都存在，避免后续再次退回到抽象得过头的泛化逻辑。
 *
 * 输入：
 * @param {object} 无 - 直接读取运行时代码字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证源码契约，不执行真实页面排序逻辑。
 * - 逻辑必须同时关注顶部版位、语言标签上下文和 English/Angielska 选项文本。
 */
test("getPageRuntimeSource includes a dedicated homepage language dropdown switcher", () => {
  const source = getPageRuntimeSource();

  assert.match(source, /function findHomepageLanguageTrigger\(\)/);
  assert.match(source, /function switchHomepageLanguageToEnglish\(\)/);
  assert.match(source, /CONFIG\.languageFieldPattern\.test\(contextText\)/);
  assert.match(source, /CONFIG\.englishPattern\.test\(text\)/);
  assert.match(source, /selectCustomOptionByText\(languageTrigger, CONFIG\.englishPattern\)/);
  assert.match(source, /window\.innerWidth \* 0\.6/);
  assert.match(source, /window\.innerHeight \* 0\.25/);
});

/**
 * 作用：
 * 验证新的入口导航动作既支持真实 href，也支持空 href 的页内点击导航。
 *
 * 为什么这样写：
 * 用户现场已经给出 live DOM：领馆列表里的 `<a>` 可能是空 href，只靠点击事件跳页。
 * 这条测试要锁住入口动作会返回 href / clicked / controlType 这三层证据，避免 CLI 再次因为空 href 直接失败。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - `U` 字母筛选属于页内点击，因此不在这条 href 断言里。
 * - 这里只检查源码结构，不验证真实页面是否立刻跳转。
 */
test("entry navigation link actions support href and inline-click navigation", () => {
  const source = getPageRuntimeSource();

  assert.match(source, /function isPlaceholderAnchor\(element\)/);
  assert.match(source, /if \(!isPlaceholderAnchor\(candidate\)\)/);
  assert.match(source, /function findNavigationTarget\(pattern\)/);
  assert.match(source, /leftTextLength - rightTextLength/);
  assert.match(source, /elementMatchesPattern\(element, matcher\)/);
  assert.match(buildOpenCountryAction(), /findNavigationTarget/);
  assert.match(buildOpenConsulateAction(), /findNavigationTarget/);
  assert.match(buildOpenRegistrationAction(), /findNavigationTarget/);
  assert.match(buildOpenCountryAction(), /href/);
  assert.match(buildOpenConsulateAction(), /href/);
  assert.match(buildOpenRegistrationAction(), /href/);
  assert.match(buildOpenCountryAction(), /clicked/);
  assert.match(buildOpenConsulateAction(), /clicked/);
  assert.match(buildOpenRegistrationAction(), /clicked/);
  assert.match(buildOpenCountryAction(), /getAttribute\("href"\)/);
  assert.match(buildOpenConsulateAction(), /getAttribute\("href"\)/);
  assert.match(buildOpenRegistrationAction(), /getAttribute\("href"\)/);
  assert.match(buildOpenCountryAction(), /inline_click_navigation/);
  assert.match(buildOpenConsulateAction(), /inline_click_navigation/);
  assert.match(buildOpenRegistrationAction(), /inline_click_navigation/);
  assert.doesNotMatch(buildOpenCountryAction(), /window\.location/);
  assert.doesNotMatch(buildOpenConsulateAction(), /window\.location/);
  assert.doesNotMatch(buildOpenRegistrationAction(), /window\.location/);
});

/**
 * 作用：
 * 验证入口证据动作既能接受主目标文本，也能接受更后续的页面阶段结果。
 *
 * 为什么这样写：
 * 用户现场已经证明：点击 `United States of America` 后，页面可能直接落到更后面的申请页，
 * 而不会短暂停留在我们原本预期的 Los Angeles 列表页。
 * 这条测试锁住“更后续的有效页面也算成功”的契约，避免入口等待再次误报失败。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证动作源码结构，不执行真实 DOM。
 * - 页面阶段原因应由 runtime.readAvailability() 提供。
 */
test("buildPatternPresenceAction accepts fallback patterns and downstream page reasons", () => {
  const action = buildPatternPresenceAction(
    "runtime.CONFIG.consulatePattern",
    "expectConsulateList",
    ["runtime.CONFIG.registrationPattern", "runtime.CONFIG.imageVerificationPattern"],
    ["registration_home", "captcha_step", "selection_step", "all_dates_reserved", "date_options_present"]
  );

  assert.match(action, /const matchers = \[/);
  assert.match(action, /runtime\.readAvailability\(\)/);
  assert.match(action, /acceptedReasonList/);
  assert.match(action, /matchedByPattern/);
  assert.match(action, /matchedByReason/);
  assert.match(action, /availabilityReason/);
  assert.match(action, /runtime\.CONFIG\.registrationPattern/);
  assert.match(action, /runtime\.CONFIG\.imageVerificationPattern/);
  assert.match(action, /all_dates_reserved/);
  assert.match(action, /date_options_present/);
});

/**
 * 作用：
 * 验证 `U` 字母筛选动作属于页内点击，而不是链接导航。
 *
 * 为什么这样写：
 * 新入口链路明确要求先点 `U` 再选美国。
 * 这条测试锁住 `U` 步骤仍是页内点击，避免未来误改成 href 导航动作。
 *
 * 输入：
 * @param {object} 无 - 直接构造动作源码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证点击契约，不依赖真实 DOM。
 * - 动作应返回 `controlType`，便于 CLI 记录是否找到了字母控件。
 */
test("buildOpenCountryLetterAction uses a clickable in-page activation", () => {
  const action = buildOpenCountryLetterAction();

  assert.match(action, /findClickable/);
  assert.match(action, /activateElement/);
  assert.match(action, /controlType/);
  assert.doesNotMatch(action, /href:/);
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
