const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppleEventsUnavailableMessage,
  buildCaptchaPromptMessage,
  buildSchengenRegistrationUrl,
  extractBestCaptchaTextCandidate,
  getMissingValueRetryDelayMs,
  hasPostCaptchaEvidence,
  isAppleScriptMissingValue,
  isRecoverableMissingValueError,
  isLikelyManualCaptchaText,
  isLikelyCaptchaText,
  normalizeManualCaptchaText,
  normalizeChromeStatus,
  resolveCaptchaAnswer,
  resolveCaptchaPromptDecision,
  sanitizeCaptchaText,
  shouldAutoSubmitOcrCaptcha,
  shouldReopenRegistrationAfterCaptcha,
} = require("../src/chrome-utils");

/**
 * 作用：
 * 验证 Apple Events 权限失效时的统一错误文案。
 *
 * 为什么这样写：
 * 这次真实问题的关键是把模糊的 `missing value` 转成可执行的修复提示。
 * 测试需要锁住这条面向用户的诊断文案，避免后续回归成难懂报错。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例帮助文案。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 结果应包含桥接不可用的判断。
 * - 结果也应保留具体的修复步骤。
 */
test("buildAppleEventsUnavailableMessage combines root cause and help text", () => {
  const message = buildAppleEventsUnavailableMessage(
    "In Google Chrome, open View > Developer > Allow JavaScript from Apple Events."
  );

  assert.match(message, /appears unavailable/i);
  assert.match(message, /Allow JavaScript from Apple Events/i);
});

/**
 * 作用：
 * 验证 OCR 验证码清洗逻辑会保留真实符号字符，只删除空白和控制字符。
 *
 * 为什么这样写：
 * 真实样本已经证明验证码可能包含 `@`、`+`、`=` 等符号。
 * 如果继续按“只保留英数字”清洗，会把正确答案直接改坏。
 *
 * 输入：
 * @param {object} 无 - 直接传入带空白和符号的示例字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里锁住的是“保留可见符号”的规则。
 * - 如果未来站点引入更宽字符集，需要同步更新断言。
 */
test("sanitizeCaptchaText preserves visible captcha symbols while removing whitespace", () => {
  assert.equal(sanitizeCaptchaText("  xw@C \n"), "xw@C");
  assert.equal(sanitizeCaptchaText(" \t+=Bb \r"), "+=Bb");
  assert.equal(sanitizeCaptchaText(" A8Bd?! "), "A8Bd");
});

/**
 * 作用：
 * 验证 OCR 候选值提炼逻辑会尽量收敛到 4 位验证码。
 *
 * 为什么这样写：
 * 新策略要求 OCR 必须尽量产出 4 位候选值后再提交，
 * 即使原始 OCR 文本里夹了噪声，也应该优先提取出最可信的 4 位块。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 OCR 原始文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 先匹配恰好 4 位的合法 token。
 * - 找不到时才退回清洗结果的前 4 位。
 */
test("extractBestCaptchaTextCandidate prefers exact four-character captcha tokens", () => {
  assert.equal(extractBestCaptchaTextCandidate("  xw@C \n"), "xw@C");
  assert.equal(extractBestCaptchaTextCandidate("foo A8Bd bar"), "A8Bd");
  assert.equal(extractBestCaptchaTextCandidate("A8Bd?!?"), "A8Bd");
  assert.equal(extractBestCaptchaTextCandidate("ab123"), "ab12");
  assert.equal(extractBestCaptchaTextCandidate("??"), "");
});

/**
 * 作用：
 * 验证人工输入的验证码不会错误删除符号。
 *
 * 为什么这样写：
 * 这次真实问题就是人工输入被按 OCR 规则清洗，导致符号丢失；测试需要锁住这个修复。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例人工输入。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只去首尾空白，不改中间字符。
 * - 如果后续要支持更复杂预处理，需要重新评估这个测试。
 */
test("normalizeManualCaptchaText preserves symbol characters", () => {
  assert.equal(normalizeManualCaptchaText("  W2@#  "), "W2@#");
});

/**
 * 作用：
 * 验证字段标签强证据会被归一化并保留下来。
 *
 * 为什么这样写：
 * 当前 post-captcha 的关键修复是“字段标签已出现也算过页”。
 * 如果归一化时把这层证据丢了，CLI 仍会继续误刷 captcha。
 *
 * 输入：
 * @param {object} 无 - 直接传入带标签证据的示例页面快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - `hasStrongEvidence` 必须保留。
 * - 核心字段的布尔值也需要保持稳定结构。
 */
test("normalizeChromeStatus preserves strong selection-label evidence", () => {
  const status = normalizeChromeStatus({
    reason: "captcha_step",
    selectionLabelEvidence: {
      fields: {
        service: true,
        location: true,
        people: true,
        date: false,
      },
      matchedFieldCount: 3,
      coreFieldCount: 3,
      hasStrongEvidence: true,
    },
  });

  assert.equal(status.selectionLabelEvidence.hasStrongEvidence, true);
  assert.equal(status.selectionLabelEvidence.fields.service, true);
  assert.equal(status.selectionLabelEvidence.coreFieldCount, 3);
});

/**
 * 作用：
 * 验证字段标签强证据会让页面被视为已经过了 captcha。
 *
 * 为什么这样写：
 * 用户的真实问题是页面已经到了下一步，但终端还在继续刷新 captcha。
 * 这条测试锁住新的纯函数判断，避免以后再次退回到只看控件或 URL。
 *
 * 输入：
 * @param {object} 无 - 直接传入仍标记为 captcha_step 的示例状态。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 即便 `reason` 还是 `captcha_step`，只要字段标签强证据存在，也应返回 true。
 * - 这里验证的是“是否过页”，不是最终业务可用性。
 */
test("hasPostCaptchaEvidence returns true when strong selection labels are already visible", () => {
  assert.equal(
    hasPostCaptchaEvidence({
      reason: "captcha_step",
      selectionLabelEvidence: {
        fields: {
          service: true,
          location: true,
          people: true,
          date: false,
        },
        matchedFieldCount: 3,
        coreFieldCount: 3,
        hasStrongEvidence: true,
      },
    }),
    true
  );
});

/**
 * 作用：
 * 验证验证码提示语会在有 OCR 猜测时明确告诉用户可直接回车接受。
 *
 * 为什么这样写：
 * 这条提示语决定了新交互是否直观，测试可以防止后续改动把关键说明删掉。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例截图路径和 OCR 文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 有 OCR 猜测时必须出现 `Press Enter` 说明。
 * - 提示语应包含截图路径，方便用户快速核对。
 */
test("buildCaptchaPromptMessage includes screenshot path and OCR acceptance hint", () => {
  const prompt = buildCaptchaPromptMessage("/tmp/captcha.png", "AB12");

  assert.match(prompt, /\/tmp\/captcha\.png/);
  assert.match(prompt, /AB12/);
  assert.match(prompt, /Press Enter to accept/i);
});

/**
 * 作用：
 * 验证固定注册入口地址的拼接规则。
 *
 * 为什么这样写：
 * CLI 现在直接导航到已知 Schengen 注册 URL，这条拼接规则一旦出错，整条流程都会进错页面。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 baseUrl。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 需要兼容 baseUrl 末尾是否带斜杠。
 * - 当前测试绑定洛杉矶领馆的固定路径。
 */
test("buildSchengenRegistrationUrl appends the fixed registration path", () => {
  assert.equal(
    buildSchengenRegistrationUrl("https://secure.e-konsulat.gov.pl/placowki/126"),
    "https://secure.e-konsulat.gov.pl/placowki/126/wiza-schengen/wizyty/weryfikacja-obrazkowa"
  );
  assert.equal(
    buildSchengenRegistrationUrl("https://secure.e-konsulat.gov.pl/placowki/126/"),
    "https://secure.e-konsulat.gov.pl/placowki/126/wiza-schengen/wizyty/weryfikacja-obrazkowa"
  );
});

/**
 * 作用：
 * 验证 `missing value` 重试等待时间会逐步增加。
 *
 * 为什么这样写：
 * 桥接层现在依赖递增等待来跨过慢加载页面，这个测试能防止后续误改回过短固定值。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 attempt。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证单调递增，不绑定某个具体魔法数字。
 * - 如果将来改成指数退避，这个测试仍可继续成立。
 */
test("getMissingValueRetryDelayMs grows with the attempt number", () => {
  assert.ok(getMissingValueRetryDelayMs(2) > getMissingValueRetryDelayMs(1));
  assert.ok(getMissingValueRetryDelayMs(6) > getMissingValueRetryDelayMs(2));
});

/**
 * 作用：
 * 验证 `missing value` 特殊返回值能被桥接层识别出来。
 *
 * 为什么这样写：
 * 真实 Chrome + AppleScript 链路已经出现过这个值，测试可以防止后续改动把重试入口删掉。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里按大小写不敏感匹配。
 * - 仅验证识别逻辑，不验证重试流程本身。
 */
test("isAppleScriptMissingValue detects the special AppleScript placeholder", () => {
  assert.equal(isAppleScriptMissingValue("missing value"), true);
  assert.equal(isAppleScriptMissingValue("Missing Value"), true);
  assert.equal(isAppleScriptMissingValue("{\"ok\":true}"), false);
});

/**
 * 作用：
 * 验证可恢复的 `missing value` 错误识别逻辑。
 *
 * 为什么这样写：
 * CLI 现在会在非关键步骤上对这类错误做降级处理，测试需要锁住错误分类逻辑。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例错误。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证错误分类，不验证 CLI 分支行为。
 * - 非 `missing value` 错误不应被误判。
 */
test("isRecoverableMissingValueError matches missing value error text", () => {
  assert.equal(
    isRecoverableMissingValueError(new Error("AppleScript returned missing value after retries.")),
    true
  );
  assert.equal(
    isRecoverableMissingValueError(new Error("Permission denied")),
    false
  );
});

/**
 * 作用：
 * 验证验证码可信度启发式规则。
 *
 * 为什么这样写：
 * 真实样本说明验证码长度固定为 4 个可见字符，并且可能包含符号。
 * CLI 会依据这个判断来决定是直接提交 OCR 结果还是回退人工输入。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例验证码文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里验证的是基于真实样本的启发式阈值，不是长期业务真理。
 * - 如果实站验证码长度被确认不同，需要同步调整测试和文档。
 */
test("isLikelyCaptchaText requires exactly four visible captcha characters", () => {
  assert.equal(isLikelyCaptchaText("ab1"), false);
  assert.equal(isLikelyCaptchaText("Fpex"), true);
  assert.equal(isLikelyCaptchaText("xw@C"), true);
  assert.equal(isLikelyCaptchaText("+=Bb"), true);
  assert.equal(isLikelyCaptchaText("ab123"), false);
});

/**
 * 作用：
 * 验证默认策略会对任意 OCR 结果直接自动提交。
 *
 * 为什么这样写：
 * 新的 CLI 行为不再因为 OCR 偏弱而阻塞等待人工确认，
 * 而是始终直接尝试提交并等待下一张验证码或下一页。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 OCR 文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前策略不再把 OCR 强弱作为是否提交的门槛。
 * - 如果未来重新引入人工回退，这个测试需要同步调整。
 */
test("shouldAutoSubmitOcrCaptcha always enables automated captcha submission", () => {
  assert.equal(shouldAutoSubmitOcrCaptcha("ooz"), true);
  assert.equal(shouldAutoSubmitOcrCaptcha("A8Bd"), true);
  assert.equal(shouldAutoSubmitOcrCaptcha("9tYs"), true);
  assert.equal(shouldAutoSubmitOcrCaptcha("xw@C"), true);
  assert.equal(shouldAutoSubmitOcrCaptcha("+=Bb"), true);
  assert.equal(shouldAutoSubmitOcrCaptcha(""), true);
});

/**
 * 作用：
 * 验证人工输入采用更宽松的最小长度规则。
 *
 * 为什么这样写：
 * 人工输入应避免被过严启发式误伤，只要不是空值或明显误输就允许提交。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例字符串。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该规则只适用于人工输入，不适用于 OCR。
 * - 真实站点若后续明确验证码长度，可再收紧。
 */
test("isLikelyManualCaptchaText accepts short but plausible manual entries", () => {
  assert.equal(isLikelyManualCaptchaText(" "), false);
  assert.equal(isLikelyManualCaptchaText("W2"), true);
  assert.equal(isLikelyManualCaptchaText("W2@#"), true);
});

/**
 * 作用：
 * 验证验证码最终提交值的选择规则。
 *
 * 为什么这样写：
 * 新交互既支持“按回车接受 OCR”，也支持“人工覆盖 OCR”，这两个分支都需要被测试锁住。
 *
 * 输入：
 * @param {object} 无 - 直接传入 OCR 猜测和人工输入。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 非空人工输入应优先级最高。
 * - 空人工输入时应回退到 OCR 猜测。
 */
test("resolveCaptchaAnswer prefers manual input and falls back to OCR guess", () => {
  assert.equal(resolveCaptchaAnswer("AB12", ""), "AB12");
  assert.equal(resolveCaptchaAnswer("AB12", "W2@#"), "W2@#");
});

/**
 * 作用：
 * 验证验证码提示交互能正确区分接受 OCR 和“我会在页面里手动处理”。
 *
 * 为什么这样写：
 * 这是这次真实交互里新增的关键分支，测试可以防止以后又把空输入误判成错误。
 *
 * 输入：
 * @param {object} 无 - 直接传入 OCR 和人工输入示例。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 无 OCR 猜测且空输入时，应该进入页面内手动处理模式。
 * - 有 OCR 猜测且空输入时，应该视为接受 OCR。
 */
test("resolveCaptchaPromptDecision distinguishes OCR acceptance from manual page handling", () => {
  assert.deepEqual(resolveCaptchaPromptDecision("AB12", ""), {
    mode: "accept_ocr",
    captchaText: "AB12",
  });
  assert.deepEqual(resolveCaptchaPromptDecision("", ""), {
    mode: "manual_in_browser_wait",
    captchaText: "",
  });
  assert.deepEqual(resolveCaptchaPromptDecision("AB12", "W2@#"), {
    mode: "manual_override",
    captchaText: "W2@#",
  });
});

/**
 * 作用：
 * 验证验证码通过后回到领馆首页时会触发重新进入 Schengen 注册入口。
 *
 * 为什么这样写：
 * 这是当前实站流程里的关键分支，如果这条判断丢了，CLI 会停在首页而不会继续走到后续表单。
 *
 * 输入：
 * @param {object} 无 - 直接构造归一化状态对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 只有 `registration_home` 才应返回 true。
 * - captcha 页和已发现日期的状态不应触发。
 */
test("shouldReopenRegistrationAfterCaptcha only matches registration home state", () => {
  assert.equal(
    shouldReopenRegistrationAfterCaptcha({
      reason: "registration_home",
      isAvailable: false,
      blockedByChallenge: false,
      isCaptchaStep: false,
    }),
    true
  );
  assert.equal(
    shouldReopenRegistrationAfterCaptcha({
      reason: "captcha_step",
      isAvailable: false,
      blockedByChallenge: false,
      isCaptchaStep: true,
    }),
    false
  );
});

/**
 * 作用：
 * 验证 Chrome 页面返回结果的归一化逻辑。
 *
 * 为什么这样写：
 * Apple Events 链路返回字段可能缺失或形态不稳定，这个测试确保 CLI 能拿到稳定对象。
 *
 * 输入：
 * @param {object} 无 - 直接传入原始 payload。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - optionTexts 应始终被归一化成数组。
 * - 缺失字段应有保守默认值。
 */
test("normalizeChromeStatus applies conservative defaults", () => {
  const result = normalizeChromeStatus({
    isAvailable: true,
    optionTexts: ["2026-04-01"],
    captchaPresent: true,
    captchaDataVariants: [
      { label: "raw", dataUrl: "data:image/png;base64,AAAA" },
      { label: "", dataUrl: "" },
    ],
    selectionDiagnostics: {
      service: {
        found: true,
        controlType: "custom_select",
        currentText: "wiza schengen",
        optionTexts: ["wiza schengen"],
      },
    },
  });

  assert.equal(result.isAvailable, true);
  assert.deepEqual(result.optionTexts, ["2026-04-01"]);
  assert.equal(result.captchaPresent, true);
  assert.deepEqual(result.captchaDataVariants, [
    { label: "raw", dataUrl: "data:image/png;base64,AAAA" },
  ]);
  assert.equal(result.reason, "unknown");
  assert.equal(result.selectionDiagnostics.service.found, true);
  assert.equal(result.selectionDiagnostics.service.controlType, "custom_select");
  assert.deepEqual(result.selectionDiagnostics.service.optionTexts, ["wiza schengen"]);
  assert.equal(result.selectionDiagnostics.location.found, false);
});

/**
 * 作用：
 * 验证 post-captcha 证据判断会优先识别下一页的下拉框和日期提示。
 *
 * 为什么这样写：
 * 这次 live bug 的核心就是：页面其实已经过去了，但 CLI 还按 captcha 页继续等待。
 * 这条测试锁住“字段证据优先于 captcha 残余迹象”的规则。
 *
 * 输入：
 * @param {object} 无 - 直接构造归一化状态对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只要任一关键字段已找到，就应视为已经过页。
 * - 日期选项和无号提示也都应算作 post-captcha 证据。
 */
test("hasPostCaptchaEvidence recognizes selection controls and availability signals", () => {
  assert.equal(
    hasPostCaptchaEvidence({
      reason: "captcha_step",
      selectionDiagnostics: {
        service: { found: true },
      },
    }),
    true
  );
  assert.equal(
    hasPostCaptchaEvidence({
      reason: "captcha_step",
      optionTexts: ["15.04.2026 09:00"],
    }),
    true
  );
  assert.equal(
    hasPostCaptchaEvidence({
      reason: "captcha_step",
      unavailabilityText:
        "Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym",
    }),
    true
  );
  assert.equal(
    hasPostCaptchaEvidence({
      reason: "captcha_step",
      selectionDiagnostics: {
        service: { found: false },
        location: { found: false },
        people: { found: false },
        date: { found: false },
      },
      optionTexts: [],
      unavailabilityText: "",
    }),
    false
  );
});
