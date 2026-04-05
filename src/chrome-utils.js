const CAPTCHA_ALLOWED_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#+=";

/**
 * 作用：
 * 清洗 OCR 识别得到的验证码文本。
 *
 * 为什么这样写：
 * 真实站点的验证码是固定 4 个字符，字符集以字母、数字和少量符号为主。
 * 因此这里不再保留所有可见字符，而是只保留业务上已经确认可出现的字符，
 * 这样可以把 OCR 产生的多余标点噪声提前剔除掉。
 *
 * 输入：
 * @param {string} value - 原始验证码文本。
 *
 * 输出：
 * @returns {string} 仅保留已知验证码字符集后的文本。
 *
 * 注意：
 * - 当前允许的符号字符是 `@`、`#`、`+`、`=`。
 * - 该规则只用于 OCR，不应用于人工输入。
 * - 如果未来确认站点使用更宽字符集，需要重新评估这里的过滤范围。
 */
function sanitizeCaptchaText(value) {
  const normalizedValue = String(value || "").normalize("NFKC");
  const allowedCharacters = normalizedValue.match(/[A-Za-z0-9@#+=]/g);

  return Array.isArray(allowedCharacters) ? allowedCharacters.join("") : "";
}

/**
 * 作用：
 * 从 OCR 原始文本中提炼出最适合提交的 4 位验证码候选值。
 *
 * 为什么这样写：
 * OCR 经常会在正确答案前后带出额外噪声字符，或者把整段内容粘成一个更长的字符串。
 * 这里优先找“恰好 4 位的合法字符块”，找不到时再退回到清洗后结果的前 4 位，
 * 让主流程在不人工干预的前提下尽量稳定地产出 4 位候选值。
 *
 * 输入：
 * @param {string} value - OCR 原始输出文本。
 *
 * 输出：
 * @returns {string} 最适合提交的验证码候选值。
 *
 * 注意：
 * - 这里是 OCR 专用启发式，不代表人工输入规则。
 * - 若返回值不足 4 位，说明当前 OCR 证据仍然很弱。
 */
function extractBestCaptchaTextCandidate(value) {
  const normalizedValue = String(value || "").normalize("NFKC");
  const exactToken = normalizedValue
    .split(/[^A-Za-z0-9@#+=]+/g)
    .find((token) => token.length === 4);

  if (exactToken) {
    return exactToken;
  }

  const sanitizedValue = sanitizeCaptchaText(normalizedValue);

  if (sanitizedValue.length >= 4) {
    return sanitizedValue.slice(0, 4);
  }

  return sanitizedValue;
}

/**
 * 作用：
 * 对人工输入的验证码做最轻量清洗。
 *
 * 为什么这样写：
 * 用户手动输入时可能本来就包含符号，如果像 OCR 一样删掉非字母数字，会把正确答案改坏。
 *
 * 输入：
 * @param {string} value - 用户手动输入的验证码文本。
 *
 * 输出：
 * @returns {string} 保留原字符、仅去除首尾空白的验证码文本。
 *
 * 注意：
 * - 不会删除中间的符号字符。
 * - 只去首尾空白，避免无意修改用户真实输入。
 */
function normalizeManualCaptchaText(value) {
  return String(value || "").trim();
}

/**
 * 作用：
 * 生成 Chrome Apple Events JavaScript 不可用时的统一错误文案。
 *
 * 为什么这样写：
 * 真实运行里同一个根因可能在 doctor、check、debug 多个入口出现。
 * 把提示语集中起来后，所有模式都能给用户一致且可执行的修复步骤。
 *
 * 输入：
 * @param {string} helpText - 面向用户的修复说明。
 *
 * 输出：
 * @returns {string} 完整的错误提示文案。
 *
 * 注意：
 * - 这里返回的是人类可读文案，不是机器错误码。
 * - helpText 为空时仍会返回一条保守的基础说明。
 */
function buildAppleEventsUnavailableMessage(helpText) {
  const normalizedHelpText = String(helpText || "").trim();

  if (normalizedHelpText) {
    return `Chrome Apple Events JavaScript appears unavailable. ${normalizedHelpText}`;
  }

  return "Chrome Apple Events JavaScript appears unavailable.";
}

/**
 * 作用：
 * 判断 OCR 结果是否足够可信，可以直接提交。
 *
 * 为什么这样写：
 * 真实业务里当前验证码长度固定为 4 个可见字符。
 * 把规则收紧为“正好 4 个字符”，既能支持带符号的真实验证码，
 * 也能避免 5 个以上的 OCR 噪声被误当成可提交结果。
 *
 * 输入：
 * @param {string} value - OCR 输出或清洗后的验证码文本。
 *
 * 输出：
 * @returns {boolean} 是否达到可提交阈值。
 *
 * 注意：
 * - 当前阈值使用正好 4 个可见字符，是基于真实验证码样本的启发式规则。
 * - 真实验证码长度如果后续确认不同，需要同步更新测试和文档。
 */
function isLikelyCaptchaText(value) {
  return sanitizeCaptchaText(value).length === 4;
}

/**
 * 作用：
 * 判断当前验证码是否应该直接使用 OCR 结果自动提交。
 *
 * 为什么这样写：
 * 当前主流程策略已经改成“无论 OCR 强弱都先提交一轮”，
 * 这样脚本就不会被人工输入阻塞，而是持续依赖站点返回的新验证码继续推进。
 * 单独封装后可以被 CLI 和旧入口共用，也便于测试锁住这条默认行为。
 *
 * 输入：
 * @param {string} value - OCR 清洗后的验证码文本。
 *
 * 输出：
 * @returns {boolean} 是否应当直接自动提交。
 *
 * 注意：
 * - 当前策略不会因为 OCR 偏弱而等待人工确认。
 * - 如果后续要重新引入人工回退，应优先扩展这里。
 */
function shouldAutoSubmitOcrCaptcha(value) {
  void value;
  return true;
}

/**
 * 作用：
 * 判断人工输入的验证码是否达到最基本可提交长度。
 *
 * 为什么这样写：
 * 人工输入不应像 OCR 那样被强约束，但仍需要挡住空输入或误回车这种明显无效情况。
 *
 * 输入：
 * @param {string} value - 用户手动输入后的验证码文本。
 *
 * 输出：
 * @returns {boolean} 是否满足最低提交条件。
 *
 * 注意：
 * - 当前只要求去空白后至少 2 个字符。
 * - 这是兜底规则，不代表站点验证码的真实长度定义。
 */
function isLikelyManualCaptchaText(value) {
  return normalizeManualCaptchaText(value).length >= 2;
}

/**
 * 作用：
 * 生成验证码辅助输入提示语。
 *
 * 为什么这样写：
 * 将截图路径、OCR 猜测和人工输入说明统一组织起来后，命令行交互会更清晰，也更方便做测试。
 *
 * 输入：
 * @param {string} imagePath - 已保存的验证码截图路径。
 * @param {string} ocrGuess - OCR 猜测出的验证码文本。
 *
 * 输出：
 * @returns {string} 展示给用户的提示语。
 *
 * 注意：
 * - OCR 猜测为空时，不应误导用户按回车直接提交。
 * - 提示语应明确说明按回车的行为。
 */
function buildCaptchaPromptMessage(imagePath, ocrGuess) {
  const normalizedGuess = normalizeManualCaptchaText(ocrGuess);

  if (normalizedGuess) {
    return `Captcha screenshot saved to ${imagePath}. OCR guess: ${normalizedGuess}. Press Enter to accept it, or type a corrected captcha: `;
  }

  return `Captcha screenshot saved to ${imagePath}. Type the captcha you see in Chrome: `;
}

/**
 * 作用：
 * 根据 OCR 猜测和用户输入，决定最终要提交的验证码文本。
 *
 * 为什么这样写：
 * 这个选择规则既要支持“按回车接受 OCR”，也要支持“人工覆盖 OCR”，单独抽出后更容易测试。
 *
 * 输入：
 * @param {string} ocrGuess - OCR 猜测出的验证码文本。
 * @param {string} userAnswer - 用户在终端里的输入文本。
 *
 * 输出：
 * @returns {string} 最终用于提交的验证码文本。
 *
 * 注意：
 * - 用户输入非空时应始终优先于 OCR 猜测。
 * - 返回值遵循人工输入规则，只做首尾空白清理。
 */
function resolveCaptchaAnswer(ocrGuess, userAnswer) {
  const normalizedAnswer = normalizeManualCaptchaText(userAnswer);

  if (normalizedAnswer) {
    return normalizedAnswer;
  }

  return normalizeManualCaptchaText(ocrGuess);
}

/**
 * 作用：
 * 解析验证码提示交互后的用户意图。
 *
 * 为什么这样写：
 * 终端里空输入可能代表两种完全不同的意思：接受 OCR 猜测，或者表示“我已经在 Chrome 页面里手动处理好了”。
 * 单独建模后，CLI 才能正确区分这两种场景。
 *
 * 输入：
 * @param {string} ocrGuess - OCR 猜测出的验证码文本。
 * @param {string} userAnswer - 用户在终端里的输入文本。
 *
 * 输出：
 * @returns {object} 包含 mode 和 captchaText 的决策对象。
 *
 * 注意：
 * - 有 OCR 猜测且用户回车时，默认接受 OCR。
 * - 无 OCR 猜测且用户回车时，表示用户准备在页面里手动处理。
 */
function resolveCaptchaPromptDecision(ocrGuess, userAnswer) {
  const normalizedGuess = normalizeManualCaptchaText(ocrGuess);
  const normalizedAnswer = normalizeManualCaptchaText(userAnswer);

  if (normalizedAnswer) {
    return {
      mode: "manual_override",
      captchaText: normalizedAnswer,
    };
  }

  if (normalizedGuess) {
    return {
      mode: "accept_ocr",
      captchaText: normalizedGuess,
    };
  }

  return {
    mode: "manual_in_browser_wait",
    captchaText: "",
  };
}

/**
 * 作用：
 * 判断验证码通过后是否需要重新进入 Schengen 注册入口。
 *
 * 为什么这样写：
 * 真实站点在验证码通过后可能回到领馆首页，而不是直接进入后续表单。
 * 将这个判断抽成纯函数后，CLI 主流程更清晰，也便于测试覆盖。
 *
 * 输入：
 * @param {object} status - 当前页面快照归一化结果。
 *
 * 输出：
 * @returns {boolean} 是否需要重新点击 Schengen 注册入口。
 *
 * 注意：
 * - 只在已离开 captcha 页、未命中 availability、且回到了 registration 首页时返回 true。
 * - 不应在被反爬拦截或已经发现日期时触发。
 */
function shouldReopenRegistrationAfterCaptcha(status) {
  const input = status && typeof status === "object" ? status : {};

  return (
    input.isAvailable !== true &&
    input.blockedByChallenge !== true &&
    input.isCaptchaStep !== true &&
    String(input.reason || "") === "registration_home"
  );
}

/**
 * 作用：
 * 判断 AppleScript 执行 JavaScript 后返回的文本是否是 `missing value`。
 *
 * 为什么这样写：
 * 真实 Chrome + AppleScript 链路偶发会返回这个特殊值，CLI 需要识别后重试，而不是直接按 JSON 解析报错。
 *
 * 输入：
 * @param {string} rawValue - AppleScript 返回的原始文本。
 *
 * 输出：
 * @returns {boolean} 是否为 `missing value`。
 *
 * 注意：
 * - 这里按忽略大小写处理，避免平台细节差异。
 * - 仅用于桥接层的兜底判断。
 */
function isAppleScriptMissingValue(rawValue) {
  return String(rawValue || "").trim().toLowerCase() === "missing value";
}

/**
 * 作用：
 * 判断某个错误是否属于可恢复的 AppleScript `missing value` 场景。
 *
 * 为什么这样写：
 * 某些页面步骤本身并不是硬阻塞，比如切英文失败时后续双语匹配依然可以继续。
 * 将识别逻辑抽成纯函数后，CLI 可以更安全地做降级处理。
 *
 * 输入：
 * @param {unknown} error - 捕获到的错误对象或文本。
 *
 * 输出：
 * @returns {boolean} 是否属于可恢复的 `missing value` 错误。
 *
 * 注意：
 * - 当前仅通过错误文案匹配。
 * - 如果未来错误文案变化，需要同步调整。
 */
function isRecoverableMissingValueError(error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message || "")
      : String(error || "");

  return /missing value/i.test(message);
}

/**
 * 作用：
 * 生成 Schengen 注册流程的固定入口地址。
 *
 * 为什么这样写：
 * 真实站点上左侧菜单点击在 AppleScript 环境里不稳定，但当前业务路径的注册页 URL 是固定的。
 * 将 URL 拼接规则抽成纯函数后，CLI 可以直接导航过去并保持测试覆盖。
 *
 * 输入：
 * @param {string} baseUrl - 领馆首页地址。
 *
 * 输出：
 * @returns {string} Schengen 注册入口地址。
 *
 * 注意：
 * - 该规则绑定当前洛杉矶领馆的固定路径。
 * - 若站点后续改路径，需要同步更新这里和相关文档。
 */
function buildSchengenRegistrationUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/wiza-schengen/wizyty/weryfikacja-obrazkowa`;
}

/**
 * 作用：
 * 计算 AppleScript `missing value` 重试时的等待时间。
 *
 * 为什么这样写：
 * 目标站点在真实 Chrome 中有时加载较慢，固定极短重试间隔不够稳。
 * 抽成纯函数后可以统一调整桥接层的重试节奏并补测试。
 *
 * 输入：
 * @param {number} attempt - 当前重试序号，从 1 开始。
 *
 * 输出：
 * @returns {number} 本次重试前应等待的毫秒数。
 *
 * 注意：
 * - 当前采用递增等待，而不是恒定等待。
 * - 返回值只用于短时桥接重试，不应用作业务轮询间隔。
 */
function getMissingValueRetryDelayMs(attempt) {
  return 800 + Math.max(0, Number(attempt || 1) - 1) * 700;
}

/**
 * 作用：
 * 将 Chrome 端返回的原始状态归一化为统一结果。
 *
 * 为什么这样写：
 * CLI 层需要稳定消费结果对象，先在这里做兜底可以减少上层分支复杂度。
 *
 * 输入：
 * @param {object | null | undefined} payload - 页面返回的原始状态。
 *
 * 输出：
 * @returns {object} 归一化后的状态对象。
 *
 * 注意：
 * - 未知状态默认视为 unavailable，避免误报。
 * - optionTexts 始终返回数组，方便日志和通知复用。
 * - captchaDataVariants 始终返回数组，方便 OCR 重试链路复用。
 */
function normalizeChromeStatus(payload) {
  const input = payload && typeof payload === "object" ? payload : {};

  return {
    isAvailable: input.isAvailable === true,
    reason: String(input.reason || "unknown"),
    optionTexts: Array.isArray(input.optionTexts) ? input.optionTexts : [],
    captchaPresent: input.captchaPresent === true,
    captchaFilled: input.captchaFilled === true,
    captchaDataUrl: String(input.captchaDataUrl || ""),
    captchaDataVariants: Array.isArray(input.captchaDataVariants)
      ? input.captchaDataVariants
          .filter((variant) => variant && typeof variant === "object")
          .map((variant) => ({
            label: String(variant.label || ""),
            dataUrl: String(variant.dataUrl || ""),
          }))
          .filter((variant) => variant.dataUrl !== "")
      : [],
    pageUrl: String(input.pageUrl || ""),
    bodyTextSample: String(input.bodyTextSample || ""),
    unavailabilityText: String(input.unavailabilityText || ""),
    title: String(input.title || ""),
    selectCount: Number(input.selectCount || 0),
    customSelectCount: Number(input.customSelectCount || 0),
    linkCount: Number(input.linkCount || 0),
    iframeCount: Number(input.iframeCount || 0),
    blockedByChallenge: input.blockedByChallenge === true,
    inputCount: Number(input.inputCount || 0),
    buttonTexts: Array.isArray(input.buttonTexts) ? input.buttonTexts : [],
    inputHints: Array.isArray(input.inputHints) ? input.inputHints : [],
    isCaptchaStep: input.reason === "captcha_step",
    likelyCaptchaError: input.likelyCaptchaError === true,
    bodyTextTailSample: String(input.bodyTextTailSample || ""),
  };
}

module.exports = {
  CAPTCHA_ALLOWED_CHARACTERS,
  buildAppleEventsUnavailableMessage,
  buildCaptchaPromptMessage,
  buildSchengenRegistrationUrl,
  extractBestCaptchaTextCandidate,
  getMissingValueRetryDelayMs,
  isAppleScriptMissingValue,
  isRecoverableMissingValueError,
  shouldAutoSubmitOcrCaptcha,
  isLikelyManualCaptchaText,
  isLikelyCaptchaText,
  normalizeManualCaptchaText,
  normalizeChromeStatus,
  resolveCaptchaAnswer,
  resolveCaptchaPromptDecision,
  sanitizeCaptchaText,
  shouldReopenRegistrationAfterCaptcha,
};
