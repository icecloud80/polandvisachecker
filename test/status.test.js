const test = require("node:test");
const assert = require("node:assert/strict");

const { inferAvailability } = require("../src/status");

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
