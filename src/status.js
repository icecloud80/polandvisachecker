/**
 * 作用：
 * 根据页面采集到的信号，生成统一的预约状态对象。
 *
 * 为什么这样写：
 * 将“页面解析”和“业务判断”拆开后，测试可以只覆盖纯函数，
 * 这样即使站点结构变动，我们也能更快定位是页面选择器问题还是业务规则问题。
 *
 * 输入：
 * @param {object} signals - 页面上提取到的业务信号集合。
 *
 * 输出：
 * @returns {object} 统一格式的预约状态。
 *
 * 注意：
 * - optionTexts 和 dropdownOptions 二选一即可，都会被折算成真实日期数量。
 * - 当没有命中“全部约满”文案时，会回退到 fallbackReason。
 */
function inferAvailability(signals) {
  const input = signals && typeof signals === "object" ? signals : {};
  const optionTexts = Array.isArray(input.optionTexts) ? input.optionTexts : [];
  const availableDateCount =
    optionTexts.length > 0 ? optionTexts.length : Number(input.dropdownOptions || 0);
  const normalizedUnavailableMessage = String(input.unavailabilityText || "")
    .trim()
    .toLowerCase();
  const fallbackReason = String(input.fallbackReason || "unknown_or_waiting");
  const saysReserved =
    normalizedUnavailableMessage.includes("all available dates have been reserved") ||
    normalizedUnavailableMessage.includes(
      "chwilowo wszystkie udostępnione terminy zostały zarezerwowane"
    );

  if (availableDateCount > 0) {
    return {
      isAvailable: true,
      reason: "date_options_present",
      availableDateCount,
      observedMessage: String(input.unavailabilityText || ""),
    };
  }

  if (saysReserved) {
    return {
      isAvailable: false,
      reason: "all_dates_reserved",
      availableDateCount: 0,
      observedMessage: String(input.unavailabilityText || ""),
    };
  }

  return {
    isAvailable: false,
    reason: fallbackReason,
    availableDateCount: 0,
    observedMessage: String(input.unavailabilityText || ""),
  };
}

module.exports = {
  inferAvailability,
};
