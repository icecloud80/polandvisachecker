const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractUnavailableMessage,
  inferAvailability,
  normalizeAvailabilityText,
} = require("../src/status");

/**
 * 作用：
 * 覆盖页面文本规范化会处理换行和重音差异的基础规则。
 *
 * 为什么这样写：
 * 最终无号文案现在要支持从页面正文样本里兜底提取。
 * 如果规范化不能稳定处理换行和重音，业务层仍会漏掉用户肉眼已经看到的最终状态。
 *
 * 输入：
 * @param {object} 无 - 直接传入带换行和波兰语重音的示例文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证业务匹配用规范化，不涉及页面展示。
 * - 结果应统一为小写且去重音。
 */
test("normalizeAvailabilityText collapses whitespace and strips diacritics", () => {
  assert.equal(
    normalizeAvailabilityText("Chwilowo  wszystkie\nudostępnione  terminy"),
    "chwilowo wszystkie udostepnione terminy"
  );
});

/**
 * 作用：
 * 覆盖业务层会从页面文本样本里兜底提取无号文案的规则。
 *
 * 为什么这样写：
 * live 站点已经证明：最终页面正文里有 Polish 无号文案，
 * 但 runtime 某些轮次没有及时把它填进 `unavailabilityText`。
 * 这条测试锁住最终版的兜底提取行为。
 *
 * 输入：
 * @param {object} 无 - 直接传入只带 bodyTextTailSample 的示例信号对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当显式 `unavailabilityText` 为空时，应该回退检查页面正文样本。
 * - 命中后应返回稳定的 Polish 文案。
 */
test("extractUnavailableMessage falls back to page text samples when explicit text is missing", () => {
  assert.equal(
    extractUnavailableMessage({
      unavailabilityText: "",
      bodyTextTailSample:
        "Rodzaj usługi Wiza Schengen Lokalizacja Los Angeles Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym.",
    }),
    "Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym"
  );
});

/**
 * 作用：
 * 覆盖“日期下拉框非空时视为有号”的核心规则。
 *
 * 为什么这样写：
 * 这是用户最关心的业务判断，必须保证即使提示文案缺失，也能靠 dropdown 选项得出正确结果。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造信号对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该规则优先级高于提示文案。
 * - 未来站点若改提示语，此测试仍应保持成立。
 */
test("inferAvailability returns available when date options exist", () => {
  const result = inferAvailability({
    optionTexts: ["15.04.2026 09:00", "15.04.2026 09:20"],
    unavailabilityText: "All available dates have been reserved",
  });

  assert.equal(result.isAvailable, true);
  assert.equal(result.reason, "date_options_present");
  assert.equal(result.availableDateCount, 2);
});

/**
 * 作用：
 * 覆盖“保留提示语出现且无日期选项时视为无号”的规则。
 *
 * 为什么这样写：
 * 该提示语是用户提供的明确业务信号，测试能防止后续重构时误改逻辑。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造信号对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 文案匹配应不区分大小写。
 * - 本测试不依赖具体页面结构。
 */
test("inferAvailability returns unavailable when the exact Polish reserved message is shown", () => {
  const result = inferAvailability({
    dropdownOptions: 0,
    unavailabilityText:
      "Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym",
  });

  assert.equal(result.isAvailable, false);
  assert.equal(result.reason, "all_dates_reserved");
  assert.equal(result.availableDateCount, 0);
});

/**
 * 作用：
 * 覆盖“显式字段为空但正文样本已经显示最终无号文案”时仍判定为无号。
 *
 * 为什么这样写：
 * 这是这次最终版修复的核心业务问题。
 * 如果正文里已经出现最终结果，CLI 不应该再停在 `selection_step`。
 *
 * 输入：
 * @param {object} 无 - 直接传入页面正文样本和 selection_step 回退原因。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这条规则是对 runtime 信号缺失的业务层兜底。
 * - 一旦正文样本命中，无号判断应高于 fallbackReason。
 */
test("inferAvailability uses page text samples to detect all-dates-reserved as a final fallback", () => {
  const result = inferAvailability({
    dropdownOptions: 0,
    unavailabilityText: "",
    bodyTextTailSample:
      "Rodzaj usługi Wiza Schengen Lokalizacja Los Angeles Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym.",
    fallbackReason: "selection_step",
  });

  assert.equal(result.isAvailable, false);
  assert.equal(result.reason, "all_dates_reserved");
  assert.equal(result.availableDateCount, 0);
});

/**
 * 作用：
 * 覆盖“下拉选项证据优先于无号提示”的规则。
 *
 * 为什么这样写：
 * 真实站点上文案和控件状态可能短暂不同步，真实可选日期比提示语更可靠。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造信号对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该规则可以降低误报“无号”的风险。
 * - 未来如果站点改为别的日期控件，这条业务优先级仍应保持。
 */
test("inferAvailability prefers date options over the reserved message", () => {
  const result = inferAvailability({
    dropdownOptions: 1,
    unavailabilityText:
      "Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym",
  });

  assert.equal(result.isAvailable, true);
  assert.equal(result.reason, "date_options_present");
  assert.equal(result.availableDateCount, 1);
});

/**
 * 作用：
 * 覆盖“无日期也无明确提示”时回退到调用方给出的页面阶段原因。
 *
 * 为什么这样写：
 * v1 需要区分 `selection_step`、`captcha_step` 和一般未知状态，
 * 不能把所有缺证据场景都压成一个统一原因。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造信号对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这是保守兜底逻辑，不代表业务真相，只代表当前证据不足。
 * - fallbackReason 由页面层提供，纯函数只负责保留它。
 */
test("inferAvailability falls back to the provided page-stage reason", () => {
  const result = inferAvailability({
    dropdownOptions: 0,
    unavailabilityText: "",
    fallbackReason: "selection_step",
  });

  assert.equal(result.isAvailable, false);
  assert.equal(result.reason, "selection_step");
  assert.equal(result.availableDateCount, 0);
});
