/**
 * 作用：
 * 规范化页面文本，便于在业务层做稳定的无号文案匹配。
 *
 * 为什么这样写：
 * live 页面里的最终提示可能带换行、非断空格或不同 Unicode 组合形式。
 * 如果业务层只看原始字符串，明明用户已经看到“没有预约时间”，最终结果仍可能停在 `selection_step`。
 * 因此这里统一做空白压缩和去重音归一化，让最终判定更稳。
 *
 * 输入：
 * @param {string} value - 原始页面文本。
 *
 * 输出：
 * @returns {string} 适合做业务匹配的规范化文本。
 *
 * 注意：
 * - 这里只用于匹配无号文案，不应用来替代原始页面文本展示。
 * - 去重音会让波兰语和英文兼容匹配更稳，但不应回写到 UI。
 */
function normalizeAvailabilityText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[łŁ]/g, (match) => (match === "Ł" ? "L" : "l"))
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 作用：
 * 从最终结果信号里提取“当前没有预约时间”的业务文案。
 *
 * 为什么这样写：
 * 当前 live 站点偶尔会出现这样的情况：
 * 页面正文里已经明确出现 Polish 无号文案，但 runtime 没有及时把它写进 `unavailabilityText`。
 * 如果业务层不再补一道兜底，CLI 最后就会错误停在 `selection_step`。
 *
 * 输入：
 * @param {object} signals - 页面上提取到的业务信号集合。
 *
 * 输出：
 * @returns {string} 命中的无号文案；没有命中时返回空串。
 *
 * 注意：
 * - 优先使用显式 `unavailabilityText`，因为它最接近页面层原意。
 * - 只有显式字段为空时，才会回退扫描 `bodyTextSample` 和 `bodyTextTailSample`。
 */
function extractUnavailableMessage(signals) {
  const input = signals && typeof signals === "object" ? signals : {};
  const explicitMessage = String(input.unavailabilityText || "").trim();
  const normalizedExplicitMessage = normalizeAvailabilityText(explicitMessage);
  const fallbackText = `${String(input.bodyTextSample || "")}\n${String(input.bodyTextTailSample || "")}`;
  const normalizedFallbackText = normalizeAvailabilityText(fallbackText);
  const englishNeedle = "all available dates have been reserved";
  const polishNeedle =
    "chwilowo wszystkie udostepnione terminy zostaly zarezerwowane, prosimy sprobowac umowic wizyte w terminie pozniejszym";

  if (
    normalizedExplicitMessage.includes(polishNeedle) ||
    normalizedExplicitMessage.includes(englishNeedle)
  ) {
    return explicitMessage;
  }

  if (normalizedFallbackText.includes(polishNeedle)) {
    return "Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym";
  }

  if (normalizedFallbackText.includes(englishNeedle)) {
    return "All available dates have been reserved, please make an appointment at a later date.";
  }

  return explicitMessage;
}

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
  const unavailableMessage = extractUnavailableMessage(input);
  const normalizedUnavailableMessage = normalizeAvailabilityText(unavailableMessage);
  const fallbackReason = String(input.fallbackReason || "unknown_or_waiting");
  const saysReserved =
    normalizedUnavailableMessage.includes("all available dates have been reserved") ||
    normalizedUnavailableMessage.includes(
      "chwilowo wszystkie udostepnione terminy zostaly zarezerwowane"
    );

  if (availableDateCount > 0) {
    return {
      isAvailable: true,
      reason: "date_options_present",
      availableDateCount,
      observedMessage: unavailableMessage,
    };
  }

  if (saysReserved) {
    return {
      isAvailable: false,
      reason: "all_dates_reserved",
      availableDateCount: 0,
      observedMessage: unavailableMessage,
    };
  }

  return {
    isAvailable: false,
    reason: fallbackReason,
    availableDateCount: 0,
    observedMessage: unavailableMessage,
  };
}

module.exports = {
  extractUnavailableMessage,
  inferAvailability,
  normalizeAvailabilityText,
};
