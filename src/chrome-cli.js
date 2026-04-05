const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const crypto = require("node:crypto");
const { setTimeout: sleep } = require("node:timers/promises");

const dotenv = require("dotenv");

const {
  clickChromeScreenPoint,
  executeJavaScriptInActiveTab,
  getAppleEventsHelpText,
  prepareChromeTab,
} = require("./chrome-bridge");
const {
  buildPageExpression,
  buildRefreshCaptchaClickPointAction,
  buildRefreshCaptchaAction,
  buildSelectAction,
  buildSnapshotAction,
  buildSubmitCurrentStepAction,
  buildSubmitWithCaptchaAction,
} = require("./chrome-page");
const {
  buildAppleEventsUnavailableMessage,
  buildSchengenRegistrationUrl,
  getMissingValueRetryDelayMs,
  hasPostCaptchaEvidence,
  isAppleScriptMissingValue,
  isLikelyCaptchaText,
  normalizeChromeStatus,
  sanitizeCaptchaText,
  shouldAutoSubmitOcrCaptcha,
  shouldReopenRegistrationAfterCaptcha,
} = require("./chrome-utils");
const { notifyIfNeeded } = require("./notifier");
const { getArtifactsDir, getCurrentCaptchaModelPath } = require("./project-paths");
const { inferAvailability } = require("./status");
const {
  loadLocalCaptchaModel,
  predictCaptchaDataUrl,
} = require("./captcha-train-local");

dotenv.config();

const CHROME_TARGET_URL = "https://secure.e-konsulat.gov.pl/placowki/126";

/**
 * 作用：
 * 从环境变量读取 Chrome CLI 模式配置。
 *
 * 为什么这样写：
 * 单次检查版仍然需要固定产物目录、通知配置和页面等待时间，
 * 独立配置入口可以让 `doctor`、`check`、`debug` 共用同一套默认值。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {object} Chrome CLI 模式配置。
 *
 * 注意：
 * - `check` 模式下验证码会自动尝试提交，不再阻塞等待人工输入。
 */
function loadChromeCliConfig() {
  const artifactsDir = getArtifactsDir();

  fs.mkdirSync(artifactsDir, { recursive: true });

  return {
    baseUrl: CHROME_TARGET_URL,
    artifactsDir,
    notifyMacOs: String(process.env.NOTIFY_MACOS || "true").toLowerCase() === "true",
    notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || "",
    webhookAuthHeader: process.env.WEBHOOK_AUTH_HEADER || "",
    webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || "",
    chromeStepDelayMs: Number(process.env.CHROME_STEP_DELAY_MS || 1800),
    resultDelayMs: Number(process.env.CHROME_RESULT_DELAY_MS || 3500),
    useLocalCaptchaModel:
      String(process.env.USE_LOCAL_CAPTCHA_MODEL || "true").toLowerCase() === "true",
    localCaptchaModelPath: path.resolve(
      process.cwd(),
      process.env.LOCAL_CAPTCHA_MODEL_PATH || getCurrentCaptchaModelPath()
    ),
    localCaptchaModelMaxAverageDistance: Number(
      process.env.LOCAL_CAPTCHA_MODEL_MAX_AVERAGE_DISTANCE || 50
    ),
    localCaptchaModelMinSegmentationQuality: Number(
      process.env.LOCAL_CAPTCHA_MODEL_MIN_SEGMENTATION_QUALITY || 0.44
    ),
    localCaptchaModelMinConfidence: Number(
      process.env.LOCAL_CAPTCHA_MODEL_MIN_CONFIDENCE || 0.04
    ),
    captchaSolveMaxAttempts: Number(process.env.CAPTCHA_SOLVE_MAX_ATTEMPTS || 5),
    captchaCollectCount: Number(process.env.CAPTCHA_COLLECT_COUNT || 20),
    captchaCollectRefreshDelayMs: Number(process.env.CAPTCHA_COLLECT_REFRESH_DELAY_MS || 1200),
    refreshDiagnosticCount: Number(process.env.REFRESH_DIAGNOSTIC_COUNT || 5),
  };
}

/**
 * 作用：
 * 从配置里按需加载本地 captcha 原型模型。
 *
 * 为什么这样写：
 * checker 每轮 captcha 都会反复调用识别逻辑。
 * 把模型缓存到配置对象上后，同一次命令执行里只需加载一次模型文件。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {object|null} 已加载的模型对象；不可用时返回 null。
 *
 * 注意：
 * - 模型文件缺失时不会抛错打断主流程，而是保守返回 null。
 * - 配置对象会被附加 `_localCaptchaModel` 缓存字段。
 */
function getLocalCaptchaModel(config) {
  if (!config || config.useLocalCaptchaModel !== true) {
    return null;
  }

  if (config._localCaptchaModel) {
    return config._localCaptchaModel;
  }

  if (!fs.existsSync(config.localCaptchaModelPath)) {
    return null;
  }

  config._localCaptchaModel = loadLocalCaptchaModel(config.localCaptchaModelPath);
  return config._localCaptchaModel;
}

/**
 * 作用：
 * 判断本地模型预测结果是否足够可信。
 *
 * 为什么这样写：
 * 当前模型几乎总会给出 4 位输出，因此 checker 不能把“有输出”直接等价成“可信”。
 * 这里把平均距离、整串置信度、分割质量三条门槛放在一起，尽量把明显坏分割和低把握候选直接拦在提交前。
 *
 * 输入：
 * @param {object} attempt - 本地模型预测结果。
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {boolean} 是否达到优先提交阈值。
 *
 * 注意：
 * - 当前阈值不是严格概率，只是基于现有训练集和 live 观察的工程门槛。
 * - 若后续模型结构变化，需要同步重新校准这三条阈值。
 */
function isConfidentLocalModelAttempt(attempt, config) {
  return (
    attempt &&
    String(attempt.candidate || "").length === 4 &&
    Number(attempt.averageDistance || Number.POSITIVE_INFINITY) <=
      Number(config.localCaptchaModelMaxAverageDistance || 50) &&
    Number(attempt.segmentationQuality || 0) >=
      Number(config.localCaptchaModelMinSegmentationQuality || 0.44) &&
    Number(attempt.modelConfidence || 0) >= Number(config.localCaptchaModelMinConfidence || 0.04)
  );
}

/**
 * 作用：
 * 在当前 captcha 图片来源上运行本地原型模型预测。
 *
 * 为什么这样写：
 * 用户已经手工标完了一批真实 captcha。
 * 把训练出来的本地模型直接并入 checker，可以先验证它在 live 页面上是否比通用 OCR 更有通过率。
 *
 * 输入：
 * @param {object} config - 运行配置。
 * @param {Array<object>} imageSources - 候选验证码图片来源列表。
 *
 * 输出：
 * @returns {Array<object>} 本地模型尝试结果列表。
 *
 * 注意：
 * - 当前只在模型文件存在时运行。
 * - 单个变体解析失败不会打断整轮识别，而是保留错误信息后继续下一条来源。
 */
function runLocalCaptchaModelAttempts(config, imageSources) {
  const model = getLocalCaptchaModel(config);

  if (!model) {
    return [];
  }

  const attempts = [];

  for (const source of Array.isArray(imageSources) ? imageSources : []) {
    try {
      const prediction = predictCaptchaDataUrl(source.dataUrl, model);

      attempts.push({
        engine: "local-model",
        sourceLabel: source.label,
        passLabel: "serif-hybrid-model",
        rawText: prediction.text,
        candidate: sanitizeCaptchaText(prediction.text),
        confidence: Number(prediction.confidence || 0),
        modelConfidence: Number(prediction.confidence || 0),
        averageDistance: prediction.averageDistance,
        distances: prediction.distances,
        topK: prediction.topK,
        glyphMetrics: prediction.glyphMetrics,
        segmentation: prediction.segmentation,
        segmentationQuality:
          prediction && prediction.segmentation
            ? Number(prediction.segmentation.segmentationQuality || 0)
            : 0,
        isLikely: isLikelyCaptchaText(prediction.text),
        isConfident: isConfidentLocalModelAttempt(
          {
            candidate: prediction.text,
            averageDistance: prediction.averageDistance,
            segmentationQuality:
              prediction && prediction.segmentation
                ? Number(prediction.segmentation.segmentationQuality || 0)
                : 0,
            modelConfidence: Number(prediction.confidence || 0),
          },
          config
        ),
      });
    } catch (error) {
      attempts.push({
        engine: "local-model",
        sourceLabel: source && source.label ? source.label : "unknown-source",
        passLabel: "prototype-model-error",
        rawText: "",
        candidate: "",
        confidence: 0,
        modelConfidence: 0,
        averageDistance: Number.POSITIVE_INFINITY,
        distances: [],
        topK: [],
        glyphMetrics: [],
        segmentation: null,
        segmentationQuality: 0,
        isLikely: false,
        isConfident: false,
        error: String(error.message || error),
      });
    }
  }

  return attempts;
}

/**
 * 作用：
 * 在本地模型尝试结果之间选择当前最值得提交的验证码候选值。
 *
 * 为什么这样写：
 * 用户已经确认 Tesseract 在当前站点上的正确率太低，因此 live checker 现在只使用本地模型。
 * 这里统一处理“哪条结果值得提交、哪条结果只值得记录”，主流程就只需要按统一契约决定提交还是刷新。
 *
 * 输入：
 * @param {Array<object>} localModelAttempts - 本地模型尝试结果。
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {object} 选中的验证码结果对象。
 *
 * 注意：
 * - 当前只有同时满足距离、分割质量、整体置信度的结果才允许提交。
 * - 若没有达标结果，仍会返回最佳候选供日志和 artifact 记录，但主流程应刷新而不是提交。
 */
function selectBestCaptchaSolverResult(localModelAttempts, config) {
  const normalizedAttempts = Array.isArray(localModelAttempts) ? localModelAttempts : [];
  const confidentLocalAttempt = normalizedAttempts
    .filter((attempt) => attempt && attempt.isConfident)
    .sort(
      (left, right) =>
        Number(left.averageDistance || Number.POSITIVE_INFINITY) -
        Number(right.averageDistance || Number.POSITIVE_INFINITY)
    )[0];

  if (confidentLocalAttempt) {
    return {
      captchaText: confidentLocalAttempt.candidate,
      attempts: [...normalizedAttempts],
      winningAttempt: confidentLocalAttempt,
      shouldSubmit: true,
      rejectionReason: "",
    };
  }

  const bestLocalAttempt = normalizedAttempts
    .filter((attempt) => attempt && attempt.candidate)
    .sort(
      (left, right) =>
        Number(left.averageDistance || Number.POSITIVE_INFINITY) -
        Number(right.averageDistance || Number.POSITIVE_INFINITY)
    )[0];

  return {
    captchaText: bestLocalAttempt ? bestLocalAttempt.candidate : "",
    attempts: [...normalizedAttempts],
    winningAttempt: bestLocalAttempt || null,
    shouldSubmit: false,
    rejectionReason: bestLocalAttempt
      ? "model_quality_below_threshold"
      : "no_model_candidate",
  };
}

/**
 * 作用：
 * 输出命令行版的分步进度日志。
 *
 * 为什么这样写：
 * 用户反馈“没动”时，最需要的是看见每一步是否真的在执行，而不是只看到最终结果。
 *
 * 输入：
 * @param {string} message - 需要输出的日志文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 日志应保持简短，避免淹没真正的错误信息。
 * - 时间戳使用本地时间即可，方便人工观察。
 */
function logStep(message) {
  console.log(`[chrome-cli ${new Date().toLocaleTimeString()}] ${message}`);
}

/**
 * 作用：
 * 判断当前错误是否属于“Chrome 目标标签页丢失”。
 *
 * 为什么这样写：
 * 真实采集过程中标签页可能被关闭、重建或临时失焦。
 * 把这类错误单独识别出来后，采集流程就能自动重开入口继续执行，而不是整批任务直接失败。
 *
 * 输入：
 * @param {unknown} error - 捕获到的异常对象。
 *
 * 输出：
 * @returns {boolean} 是否属于可恢复的标签页丢失错误。
 *
 * 注意：
 * - 这里只匹配已知错误文案，不代表所有 AppleScript 错误都可恢复。
 * - 如果未来底层错误文案变化，需要同步更新测试。
 */
function isChromeTabNotFoundError(error) {
  return /Chrome tab not found/i.test(error && error.message ? error.message : String(error || ""));
}

/**
 * 作用：
 * 判断“复用现有 Chrome 标签页导航”失败后是否应退回到新建标签页路径。
 *
 * 为什么这样写：
 * 现在批量采集更适合优先复用已经存在的签证标签页，减少反复走完整 prepare AppleScript 的次数。
 * 只有在明确找不到目标标签页时，才应该退回到 `prepareChromeTab()` 这条更重的补救路径。
 *
 * 输入：
 * @param {Error|object|string} error - 导航阶段抛出的异常。
 *
 * 输出：
 * @returns {boolean} 是否应继续走 prepareChromeTab fallback。
 *
 * 注意：
 * - 当前只对白名单错误生效。
 * - 其他错误应继续向上抛出，避免吞掉真实桥接故障。
 */
function shouldPrepareChromeTabAfterNavigationError(error) {
  return isChromeTabNotFoundError(error);
}

/**
 * 作用：
 * 判断当前快照是否已经足够作为新一轮采集的起点。
 *
 * 为什么这样写：
 * 连续采集多批时，上一批结束后 Chrome 往往还停留在 captcha 页。
 * 这时没必要每次都重新走一遍“打开/导航 Chrome”的桥接步骤，直接复用当前页会更稳。
 *
 * 输入：
 * @param {object} snapshot - 当前归一化页面快照。
 *
 * 输出：
 * @returns {boolean} 是否可以直接把当前页当作采集起点。
 *
 * 注意：
 * - 这里只接受仍处于 captcha step 的页面。
 * - 真正的桥接可用性仍需要由调用方先确认。
 */
function canReuseExistingCaptchaCollectionSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.isCaptchaStep === true);
}

/**
 * 作用：
 * 在真实 Chrome 页面里执行一个最小 JavaScript 探针，确认 Apple Events 桥接仍然可用。
 *
 * 为什么这样写：
 * 实战里 `missing value` 既可能是页面尚未稳定，也可能是 Chrome 的 Apple Events JavaScript 权限失效。
 * 用一个确定会返回字符串的最小探针二次确认后，CLI 才能给出明确可操作的诊断，而不是模糊空值报错。
 *
 * 输入：
 * @param {string} targetUrl - 当前要锁定的 Chrome 页面网址。
 *
 * 输出：
 * @returns {Promise<void>} 桥接可用时返回成功。
 *
 * 注意：
 * - 这里只验证“能否执行 JavaScript”，不验证业务页面是否正确。
 * - 一旦探针也返回 `missing value`，优先按桥接不可用处理。
 */
async function assertChromeJavaScriptBridgeReady(targetUrl) {
  const helpText = getAppleEventsHelpText();

  try {
    const probeValue = await executeJavaScriptInActiveTab(
      "String(document.readyState || '')",
      targetUrl
    );

    if (isAppleScriptMissingValue(probeValue)) {
      const error = new Error(buildAppleEventsUnavailableMessage(helpText));
      error.appleEventsHelpText = helpText;
      throw error;
    }
  } catch (error) {
    if (error && error.appleEventsHelpText) {
      throw error;
    }

    const wrappedError = new Error(buildAppleEventsUnavailableMessage(helpText));
    wrappedError.appleEventsHelpText = helpText;
    wrappedError.cause = error;
    throw wrappedError;
  }
}

/**
 * 作用：
 * 执行页面动作并解析 JSON 结果。
 *
 * 为什么这样写：
 * 页面侧统一返回 JSON 字符串，CLI 在这里集中解码和错误处理，可以保持主流程简洁。
 *
 * 输入：
 * @param {string} actionSource - 页面动作源码。
 *
 * 输出：
 * @returns {Promise<object>} 解码后的页面动作结果。
 *
 * 注意：
 * - 页面内部业务错误会通过 ok:false 返回，而不是抛到 Node 层。
 * - 这里假设返回内容始终是 JSON 字符串。
 */
async function runPageAction(actionSource) {
  let raw = "";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    raw = await executeJavaScriptInActiveTab(
      buildPageExpression(actionSource),
      CHROME_TARGET_URL
    );

    if (!isAppleScriptMissingValue(raw)) {
      break;
    }

    logStep(`AppleScript returned missing value, retrying page action (${attempt}/6)`);
    await sleep(getMissingValueRetryDelayMs(attempt));
  }

  if (isAppleScriptMissingValue(raw)) {
    await assertChromeJavaScriptBridgeReady(CHROME_TARGET_URL);
    throw new Error("AppleScript returned missing value after retries.");
  }

  const payload = JSON.parse(raw);

  if (!payload.ok) {
    throw new Error(payload.error && payload.error.message ? payload.error.message : "Unknown page action error.");
  }

  return payload.result;
}

/**
 * 作用：
 * 引导真实 Chrome 页面走到目标预约表单状态。
 *
 * 为什么这样写：
 * 当前 v1 只支持一个固定入口地址，直接导航可以减少菜单点击不稳定带来的失败率。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<void>} 页面准备完成后的 Promise。
 *
 * 注意：
 * - 这里不再依赖首页菜单点击。
 * - 导航后保留额外等待，给真实页面和反爬中间层留出稳定时间。
 */
async function driveChromeToRegistrationEntry(config) {
  const registrationUrl = buildSchengenRegistrationUrl(config.baseUrl);

  logStep("opening Schengen registration");

  try {
    await executeJavaScriptInActiveTab(
      `window.location.href = ${JSON.stringify(registrationUrl)}; "navigated";`,
      config.baseUrl
    );
  } catch (error) {
    if (!shouldPrepareChromeTabAfterNavigationError(error)) {
      throw error;
    }

    await prepareChromeTab(registrationUrl);
  }

  await sleep(Math.max(config.chromeStepDelayMs, 9000));
}

/**
 * 作用：
 * 在验证码通过后填写后续服务类型、地点和人数字段。
 *
 * 为什么这样写：
 * 当前 v1 只关注验证码后的三个可变下拉框，
 * 把它们集中处理可以避免旧版国家和领馆步骤误干扰实际流程。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 每一步选择动作的结果对象。
 *
 * 注意：
 * - 每一步之间都保留等待，给 Angular 页面联动渲染留时间。
 */
async function fillPostCaptchaSelections(config) {
  const result = {
    service: null,
    location: null,
    people: null,
  };

  logStep("selecting service");
  result.service = await runPageAction(
    buildSelectAction(
      "runtime.CONFIG.serviceFieldPattern",
      "runtime.CONFIG.servicePattern",
      "selectService"
    )
  );
  if (!result.service.changed) {
    logStep(`service selection did not change the page (${result.service.controlType})`);
  }
  await sleep(config.chromeStepDelayMs);
  logStep("selecting location");
  result.location = await runPageAction(
    buildSelectAction(
      "runtime.CONFIG.locationFieldPattern",
      "runtime.CONFIG.locationPattern",
      "selectLocation"
    )
  );
  if (!result.location.changed) {
    logStep(`location selection did not change the page (${result.location.controlType})`);
  }
  await sleep(config.chromeStepDelayMs);
  logStep("selecting people count");
  result.people = await runPageAction(
    buildSelectAction(
      "runtime.CONFIG.peopleFieldPattern",
      "runtime.CONFIG.peoplePattern",
      "selectPeople"
    )
  );
  if (!result.people.changed) {
    logStep(`people selection did not change the page (${result.people.controlType})`);
  }
  await sleep(config.chromeStepDelayMs);

  return result;
}

/**
 * 作用：
 * 构造当前验证码可尝试的 OCR 图像来源列表。
 *
 * 为什么这样写：
 * 当前策略需要先对原始抓图重试 OCR，再在必要时切换到另一种抓图/预处理方式。
 * 统一在这里整理、去重后，OCR 主逻辑就能按固定顺序消费这些候选源。
 *
 * 输入：
 * @param {string} primaryDataUrl - 旧字段里的主验证码图像。
 * @param {Array<object>} variantList - 页面侧返回的多种验证码抓图变体。
 *
 * 输出：
 * @returns {Array<object>} 去重后的 OCR 图像来源列表。
 *
 * 注意：
 * - 会优先保留页面声明的 variant 顺序。
 * - primaryDataUrl 即使不在 variantList 里，也会被补成最后的保底来源。
 */
function buildCaptchaImageSources(primaryDataUrl, variantList) {
  const normalizedSources = [];

  for (const variant of Array.isArray(variantList) ? variantList : []) {
    if (!variant || typeof variant !== "object") {
      continue;
    }

    const dataUrl = String(variant.dataUrl || "");

    if (!dataUrl || normalizedSources.some((source) => source.dataUrl === dataUrl)) {
      continue;
    }

    normalizedSources.push({
      label: String(variant.label || `variant-${normalizedSources.length + 1}`),
      dataUrl,
    });
  }

  if (
    String(primaryDataUrl || "") &&
    !normalizedSources.some((source) => source.dataUrl === String(primaryDataUrl || ""))
  ) {
    normalizedSources.push({
      label: "legacy-primary",
      dataUrl: String(primaryDataUrl || ""),
    });
  }

  return normalizedSources;
}

/**
 * 作用：
 * 选择最适合作为人工标注底图的验证码图像来源。
 *
 * 为什么这样写：
 * 后续训练前的人工标注应尽量基于用户在真实页面上看到的原始验证码，
 * 因此优先使用原始图片来源；只有原始图缺失时才退回到其他变体。
 *
 * 输入：
 * @param {Array<object>} sourceList - 候选验证码图像来源列表。
 *
 * 输出：
 * @returns {object | null} 最适合标注的验证码图像来源。
 *
 * 注意：
 * - 优先级为 `raw-image-src`、`copied-canvas`、其他来源。
 * - 返回值为 null 时说明当前快照没有可保存的验证码图像。
 */
function selectPreferredCaptchaLabelSource(sourceList) {
  const sources = Array.isArray(sourceList) ? sourceList : [];

  return (
    sources.find((source) => source && source.label === "raw-image-src") ||
    sources.find((source) => source && source.label === "copied-canvas") ||
    sources.find((source) => source && source.label === "legacy-primary") ||
    sources.find((source) => source && typeof source.dataUrl === "string" && source.dataUrl !== "") ||
    null
  );
}

/**
 * 作用：
 * 为当前验证码快照提取一个可比较的签名字符串。
 *
 * 为什么这样写：
 * 采集模式需要判断“刷新后是不是真的换了一张 captcha”，
 * 直接基于优先抓图来源的 data URL 做签名比较，能在不引入额外图像库的前提下稳定去重。
 *
 * 输入：
 * @param {object} snapshot - 当前页面快照。
 *
 * 输出：
 * @returns {string} 当前验证码签名；无可用图像时返回空字符串。
 *
 * 注意：
 * - 优先基于人工标注底图来源比较。
 * - 返回空字符串时，调用方应视为“当前无法确认是否换图”。
 */
function getCaptchaSnapshotSignature(snapshot) {
  const imageSources = buildCaptchaImageSources(
    snapshot && snapshot.captchaDataUrl,
    snapshot && snapshot.captchaDataVariants
  );
  const preferredSource = selectPreferredCaptchaLabelSource(imageSources);

  if (preferredSource && preferredSource.dataUrl) {
    return String(preferredSource.dataUrl);
  }

  return String((snapshot && snapshot.captchaDataUrl) || "");
}

/**
 * 作用：
 * 判断当前验证码快照是否相对上一张样本真正换过图。
 *
 * 为什么这样写：
 * 真实站点里“点了刷新”不代表图片已经变了。
 * 把“是否允许保存下一张样本”的判定抽成单独函数后，采集循环就能明确跳过重复图，避免污染标注集。
 *
 * 输入：
 * @param {string} previousSignature - 上一张已保存样本的验证码签名。
 * @param {object} snapshot - 当前页面快照。
 *
 * 输出：
 * @returns {boolean} 当前快照是否可以视为一张新 captcha。
 *
 * 注意：
 * - 首张样本没有上一张签名时，默认允许保存。
 * - 如果当前签名为空，说明无法确认换图，必须保守返回 false。
 */
function hasFreshCaptchaSnapshot(previousSignature, snapshot) {
  const currentSignature = getCaptchaSnapshotSignature(snapshot);

  if (!currentSignature) {
    return false;
  }

  if (!previousSignature) {
    return true;
  }

  return currentSignature !== String(previousSignature);
}

/**
 * 作用：
 * 判断页面返回的刷新点击坐标是否可用于真实鼠标点击。
 *
 * 为什么这样写：
 * 真实点击 fallback 需要一组明确的屏幕坐标。
 * 先在 Node 侧做一次保守校验，可以避免把空值或非法点位直接交给系统事件层。
 *
 * 输入：
 * @param {object} refreshTarget - 页面动作返回的刷新目标信息。
 *
 * 输出：
 * @returns {boolean} 是否包含可用的屏幕坐标。
 *
 * 注意：
 * - 这里只验证 x、y 是否为有限数字。
 * - 不负责判断坐标是否真的落在当前显示器范围内。
 */
function hasUsableRefreshClickPoint(refreshTarget) {
  const xValue = refreshTarget && refreshTarget.clickPoint ? refreshTarget.clickPoint.x : undefined;
  const yValue = refreshTarget && refreshTarget.clickPoint ? refreshTarget.clickPoint.y : undefined;

  return Boolean(
    refreshTarget &&
    refreshTarget.clickPoint &&
    xValue !== null &&
    xValue !== undefined &&
    yValue !== null &&
    yValue !== undefined &&
    xValue !== "" &&
    yValue !== "" &&
    Number.isFinite(Number(xValue)) &&
    Number.isFinite(Number(yValue))
  );
}

/**
 * 作用：
 * 读取当前刷新按钮的真实点击坐标。
 *
 * 为什么这样写：
 * 站点现在已经证明 synthetic click 可能不被接受。
 * 把坐标读取独立封装后，采集和 OCR 流程都能在需要时退回到真实鼠标点击。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {Promise<object>} 包含 found 和 clickPoint 的页面动作结果。
 *
 * 注意：
 * - 找不到按钮时，结果中的 found 会是 false。
 * - 调用方仍需自己决定是否执行真实点击。
 */
async function readRefreshCaptchaClickPoint() {
  return runPageAction(buildRefreshCaptchaClickPointAction());
}

/**
 * 作用：
 * 把任意标签文本转换成适合文件名的安全片段。
 *
 * 为什么这样写：
 * 验证码来源标签会被写入图片文件名，统一清洗后可以避免路径非法字符和空白导致的兼容性问题。
 *
 * 输入：
 * @param {string} value - 原始标签文本。
 *
 * 输出：
 * @returns {string} 适合文件名使用的安全片段。
 *
 * 注意：
 * - 只保留小写字母、数字和连字符。
 * - 结果为空时会回退到 `item`，避免生成空文件名。
 */
function sanitizeFileNamePart(value) {
  const normalizedValue = String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return normalizedValue || "item";
}

/**
 * 作用：
 * 生成本次验证码采集任务的目录名。
 *
 * 为什么这样写：
 * 把每次采集结果隔离到独立目录里，可以让后续标注、训练和回溯更清晰，不会和历史散图混在一起。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 采集任务目录名。
 *
 * 注意：
 * - 目录名包含时间戳，方便按时间排序。
 * - 不依赖随机数，便于人工查找。
 */
function buildCaptchaCollectionRunName() {
  return `captcha-collection-${Date.now()}`;
}

/**
 * 作用：
 * 生成验证码采集样本的文件前缀。
 *
 * 为什么这样写：
 * 统一的样本编号格式更适合人工标注和后续训练脚本按顺序读取。
 *
 * 输入：
 * @param {number} index - 样本序号，从 1 开始。
 *
 * 输出：
 * @returns {string} 样本文件前缀。
 *
 * 注意：
 * - 当前固定为 4 位补零格式。
 * - 输入异常时会保守回退到 1。
 */
function buildCaptchaCollectionSamplePrefix(index) {
  const normalizedIndex = Math.max(1, Number(index || 1));
  return `sample-${String(normalizedIndex).padStart(4, "0")}`;
}

/**
 * 作用：
 * 把 data URL 验证码图片保存到指定路径。
 *
 * 为什么这样写：
 * 采集模式需要把同一张验证码的多个抓图变体保存成稳定文件名，复用统一落盘逻辑更容易维护。
 *
 * 输入：
 * @param {string} outputPath - 目标文件路径。
 * @param {string} captchaDataUrl - 验证码图片 data URL。
 *
 * 输出：
 * @returns {boolean} 是否成功写入图片文件。
 *
 * 注意：
 * - 当前仅支持 `data:image/...;base64,...` 形式。
 * - 写入失败时返回 false，由调用方决定是否跳过当前样本。
 */
function writeCaptchaImageFile(outputPath, captchaDataUrl) {
  const match = String(captchaDataUrl || "").match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);

  if (!match) {
    return false;
  }

  fs.writeFileSync(outputPath, Buffer.from(match[2], "base64"));
  return true;
}

/**
 * 作用：
 * 在 artifacts 下创建一个新的验证码采集任务目录。
 *
 * 为什么这样写：
 * 采集模式会生成图片和 manifest，放到单独目录后更便于人工标注、版本管理和训练脚本消费。
 *
 * 输入：
 * @param {string} artifactsDir - artifacts 根目录。
 *
 * 输出：
 * @returns {object} 包含 runName、runDir、manifestPath 和 summaryPath 的任务目录信息。
 *
 * 注意：
 * - 目录会立即创建。
 * - manifest 文件初始内容由上层流程写入。
 */
function createCaptchaCollectionRunContext(artifactsDir) {
  const runName = buildCaptchaCollectionRunName();
  const runDir = path.join(artifactsDir, runName);

  fs.mkdirSync(runDir, { recursive: true });

  return {
    runName,
    runDir,
    manifestPath: path.join(runDir, "labels.json"),
    summaryPath: path.join(runDir, "summary.json"),
  };
}

/**
 * 作用：
 * 把完整验证码签名压缩成适合 manifest 使用的摘要值。
 *
 * 为什么这样写：
 * 采集去重依赖的原始签名通常是完整 data URL，直接写进标注文件会让 JSON 过大且难以人工查看。
 * 用稳定的 SHA-1 摘要后，既能保留“这张图是谁”的追踪证据，也能让批次摘要保持紧凑。
 *
 * 输入：
 * @param {string} signature - 当前验证码图片签名。
 *
 * 输出：
 * @returns {string} 适合写入元数据的摘要字符串；无签名时返回空字符串。
 *
 * 注意：
 * - 这里只服务于采集追踪和去重观察，不是安全校验用途。
 * - 若后续改摘要算法，需要同步更新测试和文档。
 */
function buildCaptchaSignatureDigest(signature) {
  const normalizedSignature = String(signature || "");

  if (!normalizedSignature) {
    return "";
  }

  return crypto.createHash("sha1").update(normalizedSignature).digest("hex");
}

/**
 * 作用：
 * 生成验证码刷新诊断任务的目录名。
 *
 * 为什么这样写：
 * 刷新诊断会同时保存 JSON、前后验证码图片和按钮元信息。
 * 用单独目录隔离每次诊断批次，后续排查时更容易按轮次回溯。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 诊断任务目录名。
 *
 * 注意：
 * - 目录名包含时间戳，方便与真实运行日志对应。
 * - 与普通 captcha collection 目录分开，避免用途混淆。
 */
function buildRefreshDiagnosticRunName() {
  return `captcha-refresh-diagnostic-${Date.now()}`;
}

/**
 * 作用：
 * 在 artifacts 下创建一次验证码刷新诊断任务目录。
 *
 * 为什么这样写：
 * Phase A 的目标是积累刷新证据而不是立即过页。
 * 把诊断产物集中到单独目录后，后续可以直接比对每次尝试的 JSON 和图片。
 *
 * 输入：
 * @param {string} artifactsDir - artifacts 根目录。
 *
 * 输出：
 * @returns {object} 包含 runName、runDir 和 summaryPath 的目录上下文。
 *
 * 注意：
 * - 目录会立即创建。
 * - summary 文件由上层流程逐步写入。
 */
function createRefreshDiagnosticRunContext(artifactsDir) {
  const runName = buildRefreshDiagnosticRunName();
  const runDir = path.join(artifactsDir, runName);

  fs.mkdirSync(runDir, { recursive: true });

  return {
    runName,
    runDir,
    summaryPath: path.join(runDir, "summary.json"),
  };
}

/**
 * 作用：
 * 生成刷新诊断尝试的文件前缀。
 *
 * 为什么这样写：
 * 诊断模式会为每次刷新尝试保存多份产物。
 * 固定前缀规则能让 JSON 和图片天然按尝试序号分组。
 *
 * 输入：
 * @param {number} index - 尝试序号，从 1 开始。
 *
 * 输出：
 * @returns {string} 本次尝试的文件名前缀。
 *
 * 注意：
 * - 当前固定为 4 位补零格式。
 * - 输入异常时保守回退到 1。
 */
function buildRefreshDiagnosticAttemptPrefix(index) {
  const normalizedIndex = Math.max(1, Number(index || 1));
  return `attempt-${String(normalizedIndex).padStart(4, "0")}`;
}

/**
 * 作用：
 * 把单个页面快照保存成可标注的验证码样本。
 *
 * 为什么这样写：
 * 当前快照里可能同时带有原图和多个处理变体，统一在这里落盘并生成 manifest 项，
 * 可以保证后续标注工具拿到一致的数据结构。
 *
 * 输入：
 * @param {string} runDir - 采集任务目录。
 * @param {number} sampleIndex - 样本序号，从 1 开始。
 * @param {object} snapshot - 当前页面快照。
 * @param {object} options - 当前样本对应的刷新来源元数据。
 *
 * 输出：
 * @returns {object | null} 当前样本的 manifest 项；无可用图像时返回 null。
 *
 * 注意：
 * - labelImagePath 优先指向原始验证码图。
 * - variantImages 会保留所有成功写入的抓图版本。
 * - refreshMethod 等元数据用于后续排查“这张图是怎么来的”。
 */
function saveCaptchaCollectionSample(runDir, sampleIndex, snapshot, options = {}) {
  const samplePrefix = buildCaptchaCollectionSamplePrefix(sampleIndex);
  const imageSources = buildCaptchaImageSources(
    snapshot && snapshot.captchaDataUrl,
    snapshot && snapshot.captchaDataVariants
  );
  const preferredSource = selectPreferredCaptchaLabelSource(imageSources);
  const signature = getCaptchaSnapshotSignature(snapshot);
  const variantImages = [];

  for (const source of imageSources) {
    const variantLabel = sanitizeFileNamePart(source.label);
    const outputPath = path.join(runDir, `${samplePrefix}-${variantLabel}.png`);

    if (!writeCaptchaImageFile(outputPath, source.dataUrl)) {
      continue;
    }

    variantImages.push({
      label: String(source.label || ""),
      path: outputPath,
    });
  }

  if (variantImages.length === 0) {
    return null;
  }

  const labelImage = preferredSource
    ? variantImages.find((image) => image.label === preferredSource.label) || variantImages[0]
    : variantImages[0];

  return {
    id: samplePrefix,
    index: sampleIndex,
    capturedAt: new Date().toISOString(),
    pageUrl: String((snapshot && snapshot.pageUrl) || ""),
    signatureHash: buildCaptchaSignatureDigest(signature),
    labelImageLabel: String((labelImage && labelImage.label) || ""),
    labelImagePath: labelImage.path,
    expectedText: "",
    notes: "",
    refreshMethod: String(options.refreshMethod || "unknown"),
    refreshRecordPath: String(options.refreshRecordPath || ""),
    refreshContext: String(options.refreshContext || ""),
    variantCount: variantImages.length,
    variantLabels: variantImages.map((image) => image.label),
    variantImages,
  };
}

/**
 * 作用：
 * 把当前验证码采集样本清单写成待标注 manifest。
 *
 * 为什么这样写：
 * 采集过程中随时落盘 manifest，可以避免中途异常退出时丢失已经保存的样本元数据。
 *
 * 输入：
 * @param {string} manifestPath - manifest 文件路径。
 * @param {Array<object>} entries - 当前样本清单。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前使用 JSON，方便后续 Node 脚本直接读取。
 * - expectedText 默认为空，留给人工标注填写。
 */
function writeCaptchaCollectionManifest(manifestPath, entries) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * 作用：
 * 把整批验证码采集任务的摘要写入 summary 文件。
 *
 * 为什么这样写：
 * Phase A 现在的目标是先拿到“可标注、可追踪、可判断质量”的数据集。
 * 额外写一个批次级 summary 后，用户无需通读 `labels.json`，就能先判断这批样本是否足够干净。
 *
 * 输入：
 * @param {string} summaryPath - 采集摘要文件路径。
 * @param {object} summary - 批次摘要对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该文件会被覆盖写入，始终反映当前最新状态。
 * - 内容应保留批次统计和关键路径，不重复嵌入整份 manifest。
 */
function writeCaptchaCollectionSummary(summaryPath, summary) {
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * 作用：
 * 从页面快照中提取刷新诊断所需的精简字段。
 *
 * 为什么这样写：
 * 真实快照里包含大量调试字段和 base64 图片。
 * 诊断 JSON 只保留“页面处于什么状态、按钮文本、验证码签名是什么”这类关键证据，更方便人工分析。
 *
 * 输入：
 * @param {object} snapshot - 当前页面快照。
 *
 * 输出：
 * @returns {object} 适合写入诊断文件的精简快照摘要。
 *
 * 注意：
 * - 不直接写入完整 base64，避免 JSON 过大。
 * - 若快照缺失，返回保守默认值。
 */
function summarizeSnapshotForRefreshDiagnostic(snapshot) {
  return {
    reason: String((snapshot && snapshot.reason) || ""),
    pageUrl: String((snapshot && snapshot.pageUrl) || ""),
    title: String((snapshot && snapshot.title) || ""),
    isCaptchaStep: Boolean(snapshot && snapshot.isCaptchaStep),
    captchaPresent: Boolean(snapshot && snapshot.captchaPresent),
    captchaFilled: Boolean(snapshot && snapshot.captchaFilled),
    likelyCaptchaError: Boolean(snapshot && snapshot.likelyCaptchaError),
    buttonTexts: Array.isArray(snapshot && snapshot.buttonTexts) ? snapshot.buttonTexts : [],
    inputHints: Array.isArray(snapshot && snapshot.inputHints) ? snapshot.inputHints : [],
    signature: getCaptchaSnapshotSignature(snapshot),
  };
}

/**
 * 作用：
 * 为刷新诊断保存指定快照的验证码图片集合。
 *
 * 为什么这样写：
 * Phase A 的关键不是 OCR，而是弄清刷新前后图片到底有没有变化。
 * 把每次尝试的前后验证码图按固定前缀落盘，可以直接肉眼比对真实变化。
 *
 * 输入：
 * @param {string} runDir - 诊断任务目录。
 * @param {string} filePrefix - 文件名前缀，例如 `attempt-0001-before`。
 * @param {object} snapshot - 当前页面快照。
 *
 * 输出：
 * @returns {Array<object>} 已保存的图片元数据列表。
 *
 * 注意：
 * - 若没有可保存的图片，会返回空数组。
 * - 保存规则复用现有 captcha 来源优先级和文件名清洗逻辑。
 */
function saveRefreshDiagnosticSnapshotImages(runDir, filePrefix, snapshot) {
  const imageSources = buildCaptchaImageSources(
    snapshot && snapshot.captchaDataUrl,
    snapshot && snapshot.captchaDataVariants
  );
  const savedImages = [];

  for (const source of imageSources) {
    const outputPath = path.join(
      runDir,
      `${filePrefix}-${sanitizeFileNamePart(source.label)}.png`
    );

    if (!writeCaptchaImageFile(outputPath, source.dataUrl)) {
      continue;
    }

    savedImages.push({
      label: String(source.label || ""),
      path: outputPath,
    });
  }

  return savedImages;
}

/**
 * 作用：
 * 把单次刷新尝试的诊断结果写入 JSON 文件。
 *
 * 为什么这样写：
 * 页面刷新问题已经不能只靠终端日志排查。
 * 每次尝试都落一份独立 JSON 后，我们就能回溯“点了什么、前后签名怎样、用了哪条 fallback”。
 *
 * 输入：
 * @param {string} runDir - 诊断任务目录。
 * @param {number} attemptIndex - 尝试序号。
 * @param {object} record - 本次刷新诊断记录。
 *
 * 输出：
 * @returns {string} 已写入的 JSON 文件路径。
 *
 * 注意：
 * - 文件内容使用 JSON，便于后续脚本消费。
 * - 调用方负责保证 record 已经是可序列化对象。
 */
function writeRefreshDiagnosticRecord(runDir, attemptIndex, record) {
  const outputPath = path.join(
    runDir,
    `${buildRefreshDiagnosticAttemptPrefix(attemptIndex)}.json`
  );

  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return outputPath;
}

/**
 * 作用：
 * 把整批刷新诊断的摘要写入 summary 文件。
 *
 * 为什么这样写：
 * 单个尝试 JSON 适合深挖细节，但用户更需要一个批次级别的总览，
 * 例如成功换图了几次、用了哪些方法、产物目录在哪里。
 *
 * 输入：
 * @param {string} summaryPath - 批次摘要文件路径。
 * @param {object} summary - 诊断摘要对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该文件会被覆盖写入，始终反映当前最新状态。
 * - 内容应保持紧凑，避免重复嵌入所有单次记录细节。
 */
function writeRefreshDiagnosticSummary(summaryPath, summary) {
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * 作用：
 * 在点击验证码刷新后等待页面真正出现一张新的 captcha。
 *
 * 为什么这样写：
 * 刚才真实采集已经证明“点击刷新”不等于“图片立刻换了”，
 * 只有等到验证码签名变化后再继续保存样本，才能避免整批数据都变成同一张图。
 *
 * 输入：
 * @param {object} config - 运行配置。
 * @param {string} previousSignature - 刷新前的验证码签名。
 *
 * 输出：
 * @returns {Promise<object>} 刷新后拿到的页面快照。
 *
 * 注意：
 * - 若多次等待后签名仍未变化，会返回最后一次快照，由调用方决定是否继续重试。
 * - 这里只负责等待换图，不负责点击刷新按钮。
 */
async function waitForCaptchaSignatureChange(config, previousSignature) {
  let snapshot = await readSnapshotWithCaptchaWait(config);

  if (!previousSignature || getCaptchaSnapshotSignature(snapshot) !== previousSignature) {
    return snapshot;
  }

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await sleep(config.captchaCollectRefreshDelayMs);
    snapshot = await readSnapshotWithCaptchaWait(config);

    if (getCaptchaSnapshotSignature(snapshot) !== previousSignature) {
      return snapshot;
    }
  }

  return snapshot;
}

/**
 * 作用：
 * 尝试刷新验证码，并在普通 DOM 点击失败时退回到真实鼠标点击。
 *
 * 为什么这样写：
 * 真实页面已经证明 `Odśwież` 可能忽略注入脚本派发的 synthetic click。
 * 统一把“DOM 刷新 -> 等待换图 -> 真实点击 fallback -> 再等待换图”封装起来，
 * 可以让采集和 OCR 主流程都复用同一套兜底逻辑。
 *
 * 输入：
 * @param {object} config - 运行配置。
 * @param {string} previousSignature - 刷新前的验证码签名。
 *
 * 输出：
 * @returns {Promise<object>} 刷新结果，包含最新快照和采用的方法。
 *
 * 注意：
 * - 若真实点击因辅助功能权限失败，不会中断流程，只会记录日志并返回最后快照。
 * - 返回的 method 仅用于日志和调试，不影响最终业务状态结构。
 */
async function refreshCaptchaWithFallback(config, previousSignature, options = {}) {
  const beforeSnapshot = options.currentSnapshot || await readSnapshotWithCaptchaWait(config);
  const attemptIndex = Number(options.attemptIndex || 0);
  const beforeSignature = previousSignature || getCaptchaSnapshotSignature(beforeSnapshot);
  const diagnosticRecord = {
    attemptIndex,
    context: String(options.context || ""),
    startedAt: new Date().toISOString(),
    before: summarizeSnapshotForRefreshDiagnostic(beforeSnapshot),
    expectedPreviousSignature: String(beforeSignature || ""),
    beforeImages: options.diagnosticRunDir
      ? saveRefreshDiagnosticSnapshotImages(
          options.diagnosticRunDir,
          `${buildRefreshDiagnosticAttemptPrefix(attemptIndex || 1)}-before`,
          beforeSnapshot
        )
      : [],
    domRefreshTriggered: false,
    refreshTarget: null,
    realPointerClick: null,
    errors: [],
  };
  let recordPath = "";

  await runPageAction(buildRefreshCaptchaAction());
  diagnosticRecord.domRefreshTriggered = true;
  let snapshot = await waitForCaptchaSignatureChange(config, previousSignature);

  if (hasFreshCaptchaSnapshot(previousSignature, snapshot)) {
    const result = {
      method: "dom_refresh",
      snapshot,
    };

    diagnosticRecord.method = result.method;
    diagnosticRecord.after = summarizeSnapshotForRefreshDiagnostic(snapshot);
    diagnosticRecord.afterImages = options.diagnosticRunDir
      ? saveRefreshDiagnosticSnapshotImages(
          options.diagnosticRunDir,
          `${buildRefreshDiagnosticAttemptPrefix(attemptIndex || 1)}-after`,
          snapshot
        )
      : [];
    diagnosticRecord.finishedAt = new Date().toISOString();

    if (options.diagnosticRunDir) {
      recordPath = writeRefreshDiagnosticRecord(options.diagnosticRunDir, attemptIndex || 1, diagnosticRecord);
    }

    result.recordPath = recordPath;
    return result;
  }

  const refreshTarget = await readRefreshCaptchaClickPoint();
  diagnosticRecord.refreshTarget = refreshTarget;

  if (!hasUsableRefreshClickPoint(refreshTarget)) {
    const result = {
      method: "no_click_point",
      snapshot,
    };

    diagnosticRecord.method = result.method;
    diagnosticRecord.after = summarizeSnapshotForRefreshDiagnostic(snapshot);
    diagnosticRecord.afterImages = options.diagnosticRunDir
      ? saveRefreshDiagnosticSnapshotImages(
          options.diagnosticRunDir,
          `${buildRefreshDiagnosticAttemptPrefix(attemptIndex || 1)}-after`,
          snapshot
        )
      : [];
    diagnosticRecord.finishedAt = new Date().toISOString();

    if (options.diagnosticRunDir) {
      recordPath = writeRefreshDiagnosticRecord(options.diagnosticRunDir, attemptIndex || 1, diagnosticRecord);
    }

    result.recordPath = recordPath;
    return result;
  }

  const x = Math.round(Number(refreshTarget.clickPoint.x));
  const y = Math.round(Number(refreshTarget.clickPoint.y));

  try {
    logStep(`DOM refresh did not change captcha; trying real pointer click at (${x}, ${y})`);
    diagnosticRecord.realPointerClick = {
      x,
      y,
      attempted: true,
    };
    await clickChromeScreenPoint({ x, y }, config.baseUrl);
    await sleep(Math.max(250, config.captchaCollectRefreshDelayMs));
    snapshot = await waitForCaptchaSignatureChange(config, previousSignature);
  } catch (error) {
    logStep(
      `real pointer refresh click failed: ${error.message}${
        error.accessibilityHelpText ? ` | ${error.accessibilityHelpText}` : ""
      }`
    );

    diagnosticRecord.errors.push({
      stage: "real_pointer_click",
      message: String(error.message || error),
      help: error.accessibilityHelpText || "",
    });

    const result = {
      method: "real_click_failed",
      snapshot,
    };

    diagnosticRecord.method = result.method;
    diagnosticRecord.after = summarizeSnapshotForRefreshDiagnostic(snapshot);
    diagnosticRecord.afterImages = options.diagnosticRunDir
      ? saveRefreshDiagnosticSnapshotImages(
          options.diagnosticRunDir,
          `${buildRefreshDiagnosticAttemptPrefix(attemptIndex || 1)}-after`,
          snapshot
        )
      : [];
    diagnosticRecord.finishedAt = new Date().toISOString();

    if (options.diagnosticRunDir) {
      recordPath = writeRefreshDiagnosticRecord(options.diagnosticRunDir, attemptIndex || 1, diagnosticRecord);
    }

    result.recordPath = recordPath;
    return result;
  }

  const result = {
    method: hasFreshCaptchaSnapshot(previousSignature, snapshot) ? "real_pointer_click" : "unchanged",
    snapshot,
  };

  diagnosticRecord.method = result.method;
  diagnosticRecord.after = summarizeSnapshotForRefreshDiagnostic(snapshot);
  diagnosticRecord.afterImages = options.diagnosticRunDir
    ? saveRefreshDiagnosticSnapshotImages(
        options.diagnosticRunDir,
        `${buildRefreshDiagnosticAttemptPrefix(attemptIndex || 1)}-after`,
        snapshot
      )
    : [];
  diagnosticRecord.finishedAt = new Date().toISOString();

  if (options.diagnosticRunDir) {
    recordPath = writeRefreshDiagnosticRecord(options.diagnosticRunDir, attemptIndex || 1, diagnosticRecord);
  }

  result.recordPath = recordPath;
  return result;
}

/**
 * 作用：
 * 用本地 captcha 模型识别页面返回的验证码图像。
 *
 * 为什么这样写：
 * 用户已经确认当前 live checker 不再使用 Tesseract，而是完全依赖本地模型。
 * 这里直接对页面提供的 captcha 图像变体运行本地模型，并挑出当前最值得提交的候选值。
 *
 * 输入：
 * @param {object} config - 运行配置。
 * @param {string} captchaDataUrl - 主验证码图片的 data URL 或直接 URL。
 * @param {Array<object>} captchaDataVariants - 页面侧提供的验证码抓图变体。
 *
 * 输出：
 * @returns {Promise<object>} 最终 OCR 结果对象。
 *
 * 注意：
 * - 本地模型结果不保证正确，但会同时带回质量门槛判断，供主流程决定提交还是刷新。
 * - 当前该入口不再调用 Tesseract。
 */
async function solveCaptchaFromPageData(config, captchaDataUrl, captchaDataVariants) {
  const imageSources = buildCaptchaImageSources(captchaDataUrl, captchaDataVariants);
  const localModelAttempts = runLocalCaptchaModelAttempts(config, imageSources);

  if (imageSources.length === 0) {
    return {
      captchaText: "",
      attempts: localModelAttempts,
    };
  }

  return selectBestCaptchaSolverResult(localModelAttempts, config);
}

/**
 * 作用：
 * 将 data URL 形式的验证码图片保存到本地产物目录。
 *
 * 为什么这样写：
 * 用户想先看截图再决定是否接受 OCR，落盘后终端和 Finder 都能复用这份图片证据。
 *
 * 输入：
 * @param {string} artifactsDir - 产物目录路径。
 * @param {string} captchaDataUrl - 页面返回的验证码图片 data URL。
 * @param {number} attempt - 当前验证码尝试次数。
 *
 * 输出：
 * @returns {string} 保存后的验证码图片路径；若无法保存则返回空字符串。
 *
 * 注意：
 * - 当前仅处理 `data:image/...;base64,...` 形式的数据。
 * - 保存失败不应阻断整轮检查，只是少了辅助截图。
 */
function saveCaptchaImageFromDataUrl(artifactsDir, captchaDataUrl, attempt) {
  const match = String(captchaDataUrl || "").match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);

  if (!match) {
    return "";
  }

  const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const outputPath = path.join(
    artifactsDir,
    `chrome-captcha-${Date.now()}-attempt-${attempt}.${extension}`
  );

  fs.writeFileSync(outputPath, Buffer.from(match[2], "base64"));
  return outputPath;
}

/**
 * 作用：
 * 判断当前页面快照里是否还存在可求解的验证码图像证据。
 *
 * 为什么这样写：
 * 用户反馈的真实问题是：页面肉眼已经进入下一步，但 CLI 还把它当成 captcha 页继续刷新。
 * 这类误判常见于“旧 reason 还像 captcha_step，但验证码图片本身已经消失”的瞬间。
 * 抽成纯函数后，主循环就能在刷新前先重新确认是否其实已经过页。
 *
 * 输入：
 * @param {object} snapshot - 当前归一化页面快照。
 *
 * 输出：
 * @returns {boolean} 是否仍有可用的验证码图像证据。
 *
 * 注意：
 * - 这里只检查图像来源，不检查输入框是否存在。
 * - 任何一个 captcha 变体可用都应视为“仍可求解验证码”。
 */
function hasCaptchaImageEvidence(snapshot) {
  const status = snapshot && typeof snapshot === "object" ? snapshot : {};

  if (String(status.captchaDataUrl || "") !== "") {
    return true;
  }

  return Array.isArray(status.captchaDataVariants) && status.captchaDataVariants.length > 0;
}

/**
 * 作用：
 * 判断当前状态是否更像“已离开 captcha，但快照还没稳定”。
 *
 * 为什么这样写：
 * live 页面在 captcha 提交后的短窗口里，可能先移除验证码输入框和图片，
 * 但页面原因字段还暂时保留为 `captcha_step`。如果此时直接刷新 captcha，
 * 就会把已经成功的过页状态打断。
 *
 * 输入：
 * @param {object} snapshot - 当前归一化页面快照。
 *
 * 输出：
 * @returns {boolean} 是否应优先重新观察 post-captcha 状态，而不是立刻刷新验证码。
 *
 * 注意：
 * - 只有在 `captcha_step` 且“既无输入框也无图像证据”时才返回 true。
 * - 这是一个保守的过页保护，不代表最终一定已经成功进入下一页。
 */
function shouldRecheckPostSubmitState(snapshot) {
  const status = snapshot && typeof snapshot === "object" ? snapshot : {};

  return Boolean(
    status.isCaptchaStep === true &&
    status.captchaPresent !== true &&
    !hasCaptchaImageEvidence(status)
  );
}

/**
 * 作用：
 * 把“captcha UI 已消失”的过渡状态强制提升为 post-captcha 选择页状态。
 *
 * 为什么这样写：
 * 用户已经在真实页面确认：只要出现“captcha UI 已经不见了，需要重查下一页”的瞬间，
 * 实际上就应该视为已经过了验证码页。继续走 captcha 求解或刷新分支只会把状态搞乱。
 * 因此这里把这类过渡快照直接提升成 `selection_step`，让主流程立刻进入下一步。
 *
 * 输入：
 * @param {object} snapshot - 当前归一化页面快照。
 * @param {string} transitionSource - 本次提升的来源标签。
 *
 * 输出：
 * @returns {object} 强制提升后的 post-captcha 页面快照。
 *
 * 注意：
 * - 这里只改页面阶段判断，不伪造日期可用或无号结论。
 * - 一旦真实页面后续快照拿到更强证据，主流程仍会继续覆盖这个保守状态。
 */
function promoteSnapshotToPostCaptchaSelection(snapshot, transitionSource) {
  const status = snapshot && typeof snapshot === "object" ? snapshot : {};

  return {
    ...status,
    reason: "selection_step",
    isCaptchaStep: false,
    captchaPresent: false,
    captchaFilled: false,
    captchaDataUrl: "",
    captchaDataVariants: [],
    postCaptchaTransitionSource: String(transitionSource || "captcha_ui_gone"),
  };
}

/**
 * 作用：
 * 把关键页面状态和业务推断写成 post-captcha 调试证据文件。
 *
 * 为什么这样写：
 * 现在 captcha 已经能过去，新的主要问题变成“后续页面为什么没选上 / 没读出来”。
 * 把过页后的快照、选择动作结果和最终推断统一落盘后，下一轮排障就不需要再猜。
 *
 * 输入：
 * @param {string} artifactsDir - 产物目录。
 * @param {string} stageLabel - 当前证据阶段名称。
 * @param {object} snapshot - 当前归一化页面快照。
 * @param {object} extraPayload - 额外上下文信息。
 *
 * 输出：
 * @returns {string} 已写入的 JSON 文件路径。
 *
 * 注意：
 * - 该文件会包含页面文本摘要，但不包含完整 base64 captcha 图。
 * - stageLabel 会进入文件名，请保持简短稳定。
 */
function writeChromeStatusArtifact(artifactsDir, stageLabel, snapshot, extraPayload = {}) {
  const safeStageLabel = sanitizeFileNamePart(stageLabel);
  const outputPath = path.join(
    artifactsDir,
    `chrome-status-${Date.now()}-${safeStageLabel}.json`
  );
  const payload = {
    capturedAt: new Date().toISOString(),
    stage: safeStageLabel,
    snapshot,
    extra: extraPayload && typeof extraPayload === "object" ? extraPayload : {},
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outputPath;
}

/**
 * 作用：
 * 把最终检查结果转换成用户可直接阅读的中文状态行。
 *
 * 为什么这样写：
 * 用户希望 CLI 在 JSON 之外再给出一句非常直观的结论，
 * 这样即使不看结构化字段，也能立刻知道当前是否有预约时间。
 * 单独抽成纯函数后，测试可以稳定锁住文案，不会和浏览器流程耦合。
 *
 * 输入：
 * @param {object} result - `runChromeCheck` 生成的最终结果对象。
 *
 * 输出：
 * @returns {string} 面向用户的中文状态行。
 *
 * 注意：
 * - 当前只区分“有预约时间”和“没有预约时间”。
 * - 未知状态、无号状态、captcha 未过状态都保守归入“没有预约时间”。
 */
function buildFinalAvailabilityLine(result) {
  const input = result && typeof result === "object" ? result : {};
  const status = input.status && typeof input.status === "object" ? input.status : {};

  if (status.isAvailable === true) {
    return "有预约时间";
  }

  return "没有预约时间";
}

/**
 * 作用：
 * 读取当前页面快照，并在验证码图片尚未挂到 DOM 时做短暂补偿等待。
 *
 * 为什么这样写：
 * 目标页是前端渲染页面，验证码输入框有时会先出现，而图片会稍后才挂载。
 * 在 OCR 之前补一小段轮询，可以减少“只能让用户盯着 Chrome 页面手打”的次数。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 归一化后的页面快照。
 *
 * 注意：
 * - 这里只做短时等待，不会替代业务级轮询。
 * - 一旦离开 captcha 步骤，或已拿到任意一种验证码抓图变体，就应立即返回当前快照。
 */
async function readSnapshotWithCaptchaWait(config) {
  let snapshot = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));

  if (
    !snapshot.isCaptchaStep ||
    snapshot.captchaDataUrl ||
    (Array.isArray(snapshot.captchaDataVariants) && snapshot.captchaDataVariants.length > 0)
  ) {
    return snapshot;
  }

  for (let attempt = 1; attempt <= Math.max(1, config.captchaSolveMaxAttempts); attempt += 1) {
    await sleep(Math.max(400, Math.floor(config.chromeStepDelayMs / 2)));
    snapshot = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));

    if (
      !snapshot.isCaptchaStep ||
      snapshot.captchaDataUrl ||
      (Array.isArray(snapshot.captchaDataVariants) && snapshot.captchaDataVariants.length > 0)
    ) {
      return snapshot;
    }
  }

  return snapshot;
}

/**
 * 作用：
 * 在提交验证码后持续观察页面是否已经切换到下一步表单。
 *
 * 为什么这样写：
 * 原来的等待逻辑偏向“等 captcha 图挂载出来”，并不适合判断“是否已经过页”。
 * 提交后单独轮询 post-captcha 证据，才能避免用户明明看到下一页了，terminal 还继续等 captcha。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 观察窗口结束后的最新页面快照。
 *
 * 注意：
 * - 只要出现下拉页字段、日期选项或无号提示中的任意一个，就会立即返回。
 * - 若一直没有过页证据，才保守返回最后一次快照。
 */
async function readSnapshotAfterCaptchaSubmit(config) {
  let snapshot = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));

  if (hasPostCaptchaEvidence(snapshot) || !snapshot.isCaptchaStep) {
    return snapshot;
  }

  for (let attempt = 1; attempt <= Math.max(4, config.captchaSolveMaxAttempts * 2); attempt += 1) {
    await sleep(Math.max(500, Math.floor(config.resultDelayMs / 3)));
    snapshot = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));

    if (hasPostCaptchaEvidence(snapshot) || !snapshot.isCaptchaStep) {
      return snapshot;
    }
  }

  return snapshot;
}

/**
 * 作用：
 * 解析一次页面快照，并在需要时完成验证码提交。
 *
 * 为什么这样写：
 * 把 captcha 求解、自动提交和重试集中在一起，主检查流程只需关心最终状态。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 最终标准化状态。
 *
 * 注意：
 * - 如果页面已经直接出现预约日期，不会再触发验证码提交流程。
 * - 当前策略不会等待人工输入，而是按质量门槛决定“提交本地模型结果”还是“直接刷新重试”。
 */
async function resolveAvailabilityAfterCaptcha(config) {
  let currentSnapshot = await readSnapshotWithCaptchaWait(config);

  logStep(
    `snapshot reason=${currentSnapshot.reason} selects=${currentSnapshot.selectCount} customSelects=${currentSnapshot.customSelectCount} links=${currentSnapshot.linkCount} iframes=${currentSnapshot.iframeCount}`
  );

  if (currentSnapshot.isAvailable) {
    return currentSnapshot;
  }

  if (currentSnapshot.blockedByChallenge) {
    return currentSnapshot;
  }

  if (!currentSnapshot.captchaPresent && !currentSnapshot.isCaptchaStep) {
    return currentSnapshot;
  }

  for (let attempt = 1; attempt <= Math.max(1, config.captchaSolveMaxAttempts); attempt += 1) {
    if (!currentSnapshot.isCaptchaStep && !currentSnapshot.captchaPresent) {
      return currentSnapshot;
    }

    if (shouldRecheckPostSubmitState(currentSnapshot)) {
      logStep("captcha UI is no longer visible, rechecking whether the next page has loaded");
      currentSnapshot = await readSnapshotAfterCaptchaSubmit(config);

      if (hasPostCaptchaEvidence(currentSnapshot) || !currentSnapshot.isCaptchaStep) {
        return currentSnapshot;
      }

      logStep("captcha UI is gone, promoting the flow to the post-captcha selection step");
      return promoteSnapshotToPostCaptchaSelection(currentSnapshot, "initial-loop-recheck");
    }

    if (currentSnapshot.captchaFilled) {
      logStep("captcha field is already filled, submitting the current step");
      await runPageAction(buildSubmitCurrentStepAction());
      await sleep(config.resultDelayMs);
      currentSnapshot = await readSnapshotAfterCaptchaSubmit(config);

      if (hasPostCaptchaEvidence(currentSnapshot) || !currentSnapshot.isCaptchaStep) {
        return currentSnapshot;
      }
    }

    const solverResult = await solveCaptchaFromPageData(
      config,
      currentSnapshot.captchaDataUrl,
      currentSnapshot.captchaDataVariants
    );
    const captchaText = sanitizeCaptchaText(solverResult.captchaText);
    const captchaImagePath = saveCaptchaImageFromDataUrl(
      config.artifactsDir,
      currentSnapshot.captchaDataUrl,
      attempt
    );

    if (Array.isArray(solverResult.attempts) && solverResult.attempts.length > 0) {
      const summary = solverResult.attempts
        .map(
          (ocrAttempt) =>
            `${ocrAttempt.sourceLabel}/${ocrAttempt.passLabel}="${ocrAttempt.candidate}"(${
              ocrAttempt.engine === "local-model" && Number.isFinite(ocrAttempt.averageDistance)
                ? `d=${ocrAttempt.averageDistance.toFixed(1)},q=${Number(
                    ocrAttempt.segmentationQuality || 0
                  ).toFixed(2)},c=${Number(ocrAttempt.modelConfidence || 0).toFixed(2)}`
                : Math.round(Number(ocrAttempt.confidence || 0) * 100)
            })`
        )
        .join(", ");

      logStep(`captcha attempts: ${summary}`);
    }

    if (isLikelyCaptchaText(captchaText)) {
      logStep(
        `model guessed captcha "${captchaText}"${captchaImagePath ? ` using ${captchaImagePath}` : ""}`
      );
    }

    if (solverResult.shouldSubmit !== true) {
      if (solverResult.winningAttempt && solverResult.winningAttempt.candidate) {
        logStep(
          `best captcha candidate "${solverResult.winningAttempt.candidate}" rejected before submit because ${solverResult.rejectionReason}`
        );
      } else {
        logStep(`no captcha candidate passed quality gates because ${solverResult.rejectionReason}`);
      }

      logStep("refreshing captcha because the local model confidence or segmentation quality is too low");
      await refreshCaptchaWithFallback(config, currentSnapshot, attempt, "quality_gate");
      currentSnapshot = await readSnapshotWithCaptchaWait(config);
      continue;
    }

    if (!isLikelyCaptchaText(captchaText)) {
      if (shouldRecheckPostSubmitState(currentSnapshot)) {
        logStep("captcha candidate is empty and captcha UI is gone, rechecking page state");
        currentSnapshot = await readSnapshotAfterCaptchaSubmit(config);

        if (hasPostCaptchaEvidence(currentSnapshot) || !currentSnapshot.isCaptchaStep) {
          return currentSnapshot;
        }

        logStep("captcha UI is gone after submit, promoting the flow to the post-captcha selection step");
        return promoteSnapshotToPostCaptchaSelection(currentSnapshot, "empty-candidate-recheck");
      }

      logStep("model did not produce a 4-character captcha candidate, refreshing captcha");
      const refreshResult = await refreshCaptchaWithFallback(
        config,
        getCaptchaSnapshotSignature(currentSnapshot)
      );
      currentSnapshot = refreshResult.snapshot;
      continue;
    }

    if (shouldAutoSubmitOcrCaptcha(captchaText)) {
      logStep(
        `auto-submitting model captcha "${captchaText}"${captchaImagePath ? ` from ${captchaImagePath}` : ""}`
      );
    }

    await runPageAction(buildSubmitWithCaptchaAction(captchaText));
    logStep(`submitted captcha attempt ${attempt} and waiting for result`);
    await sleep(config.resultDelayMs);
    currentSnapshot = await readSnapshotAfterCaptchaSubmit(config);

    if (hasPostCaptchaEvidence(currentSnapshot) || !currentSnapshot.isCaptchaStep) {
      return currentSnapshot;
    }

    logStep(
      currentSnapshot.likelyCaptchaError
        ? "captcha was rejected by the page, please try again"
        : "still on captcha step after submit, retrying"
    );
  }

  return currentSnapshot;
}

/**
 * 作用：
 * 执行一次完整的真实 Chrome 检查。
 *
 * 为什么这样写：
 * 这是命令行版的主流程入口，统一负责打开页面、驱动表单、读取结果和触发通知。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 一次检查的结果对象。
 *
 * 注意：
 * - 依赖 Chrome 已开启 Apple Events JavaScript 权限。
 * - 这个流程会占用 Chrome 前台活动标签页。
 */
async function runChromeCheck(config) {
  logStep("opening Chrome tab");
  await driveChromeToRegistrationEntry(config);
  logStep("verifying Chrome JavaScript bridge");
  await assertChromeJavaScriptBridgeReady(config.baseUrl);

  let status = await resolveAvailabilityAfterCaptcha(config);
  let postCaptchaArtifactPath = "";
  let postSelectionArtifactPath = "";
  let selectionResults = null;

  if (shouldReopenRegistrationAfterCaptcha(status)) {
    logStep("captcha passed and page returned to registration home, reopening Schengen registration");
    await driveChromeToRegistrationEntry(config);
    status = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));
  }

  if (!status.isCaptchaStep && !status.blockedByChallenge) {
    postCaptchaArtifactPath = writeChromeStatusArtifact(
      config.artifactsDir,
      "post-captcha-before-selection",
      status
    );
    logStep(`saved post-captcha snapshot to ${postCaptchaArtifactPath}`);
  }

  if (
    !status.isAvailable &&
    !status.blockedByChallenge &&
    !status.isCaptchaStep
  ) {
    selectionResults = await fillPostCaptchaSelections(config);
    status = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));
    postSelectionArtifactPath = writeChromeStatusArtifact(
      config.artifactsDir,
      "post-captcha-after-selection",
      status,
      {
        selectionResults,
      }
    );
    logStep(`saved post-selection snapshot to ${postSelectionArtifactPath}`);
    logStep(
      `post-selection snapshot reason=${status.reason} selects=${status.selectCount} inputs=${status.inputCount}`
    );
  }

  const inferredStatus = inferAvailability({
    optionTexts: status.optionTexts,
    unavailabilityText: status.unavailabilityText,
    bodyTextSample: status.bodyTextSample,
    bodyTextTailSample: status.bodyTextTailSample,
    fallbackReason: status.reason,
  });

  const result = {
    checkedAt: new Date().toISOString(),
    status: inferredStatus,
    signals: {
      optionTexts: status.optionTexts,
      pageUrl: status.pageUrl,
      unavailabilityText: status.unavailabilityText,
    },
    artifacts: {
      postCaptchaArtifactPath,
      postSelectionArtifactPath,
    },
  };

  await notifyIfNeeded(config, result);
  console.log(JSON.stringify({
    checkedAt: result.checkedAt,
    isAvailable: result.status.isAvailable,
    reason: result.status.reason,
    availableDateCount: result.status.availableDateCount,
    optionTexts: status.optionTexts,
    pageUrl: status.pageUrl,
  }, null, 2));
  console.log(buildFinalAvailabilityLine(result));

  return result;
}

/**
 * 作用：
 * 输出当前真实 Chrome 页面快照，帮助定位“脚本没动”问题。
 *
 * 为什么这样写：
 * 当前站点可能被风控挑战页拦截，也可能只是字段没匹配到；快照模式能立刻区分这两类问题。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<void>} 调试输出完成后的 Promise。
 *
 * 注意：
 * - 该模式不会提交验证码，也不会继续轮询。
 * - 主要用于人工诊断页面现状。
 */
async function runDebug(config) {
  logStep("opening Chrome tab for debug");
  await driveChromeToRegistrationEntry(config);
  logStep("verifying Chrome JavaScript bridge");
  await assertChromeJavaScriptBridgeReady(config.baseUrl);
  const snapshot = normalizeChromeStatus(await runPageAction(buildSnapshotAction()));

  console.log(JSON.stringify(snapshot, null, 2));

  if (snapshot.blockedByChallenge) {
    console.log("The page is currently blocked by an Imperva / Incapsula challenge in real Chrome.");
  }
}

/**
 * 作用：
 * 运行一次专门的验证码刷新诊断任务。
 *
 * 为什么这样写：
 * Phase A 的首要目标是看清 `Odśwież` 到底发生了什么，而不是继续盲改 OCR。
 * 该模式会把每次刷新尝试的前后签名、方法、按钮目标信息和验证码图片全部落盘，方便后续精确排障。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 本次诊断任务的摘要结果。
 *
 * 注意：
 * - 该模式不会提交 captcha，也不会尝试进入下一页。
 * - 若页面离开 captcha，会自动回到固定入口后继续诊断。
 */
async function runRefreshDiagnostics(config) {
  const runContext = createRefreshDiagnosticRunContext(config.artifactsDir);
  const attempts = [];

  logStep("opening Chrome tab for refresh diagnostics");
  await driveChromeToRegistrationEntry(config);
  logStep("verifying Chrome JavaScript bridge");
  await assertChromeJavaScriptBridgeReady(config.baseUrl);

  for (let attemptIndex = 1; attemptIndex <= Math.max(1, config.refreshDiagnosticCount); attemptIndex += 1) {
    let snapshot = await readSnapshotWithCaptchaWait(config);

    if (!snapshot.isCaptchaStep) {
      logStep("page is not on captcha step during refresh diagnostics, reopening Schengen registration");
      await driveChromeToRegistrationEntry(config);
      snapshot = await readSnapshotWithCaptchaWait(config);
    }

    if (!snapshot.isCaptchaStep) {
      attempts.push({
        attemptIndex,
        skipped: true,
        reason: String(snapshot.reason || "not_on_captcha_step"),
      });
      continue;
    }

    const beforeSignature = getCaptchaSnapshotSignature(snapshot);
    const refreshResult = await refreshCaptchaWithFallback(
      config,
      beforeSignature,
      {
        attemptIndex,
        context: "diagnose-refresh",
        currentSnapshot: snapshot,
        diagnosticRunDir: runContext.runDir,
      }
    );
    const afterSignature = getCaptchaSnapshotSignature(refreshResult.snapshot);

    attempts.push({
      attemptIndex,
      method: String(refreshResult.method || ""),
      changed: Boolean(beforeSignature && afterSignature && beforeSignature !== afterSignature),
      beforeSignature,
      afterSignature,
      recordPath: String(refreshResult.recordPath || ""),
    });
  }

  const result = {
    runName: runContext.runName,
    runDir: runContext.runDir,
    summaryPath: runContext.summaryPath,
    requestedCount: Math.max(1, config.refreshDiagnosticCount),
    changedCount: attempts.filter((attempt) => attempt.changed).length,
    attempts,
  };

  writeRefreshDiagnosticSummary(runContext.summaryPath, result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 作用：
 * 运行环境自检，确认 Chrome Apple Events 链路是否可用。
 *
 * 为什么这样写：
 * 在真正执行预约检查前先做最关键的可行性验证，可以减少用户在长流程里才遇到权限错误的挫败感。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<void>} 自检完成后的 Promise。
 *
 * 注意：
 * - 自检不会执行站点业务流程。
 * - 如果失败，通常是 Chrome 设置问题而不是代码问题。
 */
async function runDoctor(config) {
  try {
    await prepareChromeTab("https://example.com");
    await sleep(1500);
    await assertChromeJavaScriptBridgeReady("https://example.com");
    const title = await executeJavaScriptInActiveTab("document.title", "https://example.com");
    console.log(JSON.stringify({
      ok: true,
      title,
      help: "Chrome Apple Events JavaScript is enabled.",
      next: `Run: npm run check`,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      help: error.appleEventsHelpText || getAppleEventsHelpText(),
    }, null, 2));
    process.exitCode = 1;
  }
}

/**
 * 作用：
 * 执行一次验证码图片采集任务，只保存样本，不提交表单。
 *
 * 为什么这样写：
 * 后续要训练或评估验证码模型，首先需要一批可人工标注的真实样本。
 * 把采集逻辑单独做成命令后，用户可以快速批量抓图，而不必手工刷新和截图。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 本次采集任务的结果摘要。
 *
 * 注意：
 * - 该模式不会提交 captcha，也不会继续进入下一页。
 * - 若当前页离开 captcha，会自动重新打开固定入口。
 */
async function runCaptchaCollection(config) {
  const runContext = createCaptchaCollectionRunContext(config.artifactsDir);
  const entries = [];
  const maxLoopCount = Math.max(config.captchaCollectCount * 5, config.captchaCollectCount + 5);
  const refreshMethodCounts = {};
  let duplicateSkipCount = 0;
  let reopenCount = 0;
  let lastSignature = "";
  let currentSnapshotProvenance = {
    refreshMethod: "initial_page_load",
    refreshRecordPath: "",
    refreshContext: "initial_page_load",
  };
  let startupSnapshot = null;

  try {
    logStep("checking whether the current Chrome tab can be reused for captcha collection");
    await assertChromeJavaScriptBridgeReady(config.baseUrl);
    startupSnapshot = await readSnapshotWithCaptchaWait(config);
  } catch (error) {
    logStep("could not reuse the current Chrome captcha tab, falling back to the standard open-and-navigate path");
  }

  if (canReuseExistingCaptchaCollectionSnapshot(startupSnapshot)) {
    logStep("reusing the current captcha page instead of reopening Chrome navigation");
  } else {
    logStep("opening Chrome tab for captcha collection");
    await driveChromeToRegistrationEntry(config);
    logStep("verifying Chrome JavaScript bridge");
    await assertChromeJavaScriptBridgeReady(config.baseUrl);
  }

  for (let loopIndex = 1; loopIndex <= maxLoopCount; loopIndex += 1) {
    if (entries.length >= config.captchaCollectCount) {
      break;
    }

    let snapshot;

    try {
      snapshot = await readSnapshotWithCaptchaWait(config);
    } catch (error) {
      if (isChromeTabNotFoundError(error)) {
        logStep("Chrome captcha tab was not found, reopening Schengen registration");
        await driveChromeToRegistrationEntry(config);
        reopenCount += 1;
        currentSnapshotProvenance = {
          refreshMethod: "reopen_registration",
          refreshRecordPath: "",
          refreshContext: "tab_not_found",
        };
        continue;
      }

      throw error;
    }

    if (!snapshot.isCaptchaStep) {
      logStep("page is not on captcha step, reopening Schengen registration");
      await driveChromeToRegistrationEntry(config);
      reopenCount += 1;
      currentSnapshotProvenance = {
        refreshMethod: "reopen_registration",
        refreshRecordPath: "",
        refreshContext: "not_on_captcha_step",
      };
      snapshot = await readSnapshotWithCaptchaWait(config);
    }

    if (!snapshot.isCaptchaStep) {
      logStep("captcha step is still unavailable after reopen, retrying");
      continue;
    }

    const currentSignature = getCaptchaSnapshotSignature(snapshot);

    if (currentSignature && currentSignature === lastSignature) {
      logStep("captcha image did not change yet, refreshing and waiting for a new one");
      try {
        const refreshResult = await refreshCaptchaWithFallback(config, currentSignature);

        snapshot = refreshResult.snapshot;
        currentSnapshotProvenance = {
          refreshMethod: String(refreshResult.method || "unknown"),
          refreshRecordPath: String(refreshResult.recordPath || ""),
          refreshContext: "duplicate_signature_retry",
        };
      } catch (error) {
        if (isChromeTabNotFoundError(error)) {
          logStep("Chrome captcha tab disappeared during refresh, reopening");
          await driveChromeToRegistrationEntry(config);
          reopenCount += 1;
          currentSnapshotProvenance = {
            refreshMethod: "reopen_registration",
            refreshRecordPath: "",
            refreshContext: "refresh_tab_lost",
          };
          continue;
        }

        throw error;
      }

      if (!snapshot.isCaptchaStep) {
        logStep("left captcha step while waiting for a refreshed image, reopening");
        await driveChromeToRegistrationEntry(config);
        continue;
      }

      if (!hasFreshCaptchaSnapshot(lastSignature, snapshot)) {
        logStep("captcha image is still unchanged after refresh, skipping this loop");
        duplicateSkipCount += 1;
        continue;
      }
    }

    const sampleEntry = saveCaptchaCollectionSample(
      runContext.runDir,
      entries.length + 1,
      snapshot,
      currentSnapshotProvenance
    );

    if (!sampleEntry) {
      logStep("captcha image was missing, refreshing without saving a sample");
      const refreshResult = await refreshCaptchaWithFallback(
        config,
        getCaptchaSnapshotSignature(snapshot)
      );

      currentSnapshotProvenance = {
        refreshMethod: String(refreshResult.method || "unknown"),
        refreshRecordPath: String(refreshResult.recordPath || ""),
        refreshContext: "missing_snapshot_image",
      };
      continue;
    }

    entries.push(sampleEntry);
    refreshMethodCounts[sampleEntry.refreshMethod] = (refreshMethodCounts[sampleEntry.refreshMethod] || 0) + 1;
    lastSignature = getCaptchaSnapshotSignature(snapshot);
    writeCaptchaCollectionManifest(runContext.manifestPath, entries);
    logStep(
      `saved captcha sample ${entries.length}/${config.captchaCollectCount} to ${sampleEntry.labelImagePath}`
    );

    if (entries.length >= config.captchaCollectCount) {
      break;
    }

    try {
      const refreshResult = await refreshCaptchaWithFallback(config, lastSignature);

      snapshot = refreshResult.snapshot;
      currentSnapshotProvenance = {
        refreshMethod: String(refreshResult.method || "unknown"),
        refreshRecordPath: String(refreshResult.recordPath || ""),
        refreshContext: "post_save_refresh",
      };
    } catch (error) {
      if (isChromeTabNotFoundError(error)) {
        logStep("Chrome captcha tab disappeared after saving a sample, reopening");
        await driveChromeToRegistrationEntry(config);
        reopenCount += 1;
        currentSnapshotProvenance = {
          refreshMethod: "reopen_registration",
          refreshRecordPath: "",
          refreshContext: "post_save_tab_lost",
        };
        continue;
      }

      throw error;
    }

    if (snapshot.isCaptchaStep) {
      if (hasFreshCaptchaSnapshot(lastSignature, snapshot)) {
        logStep("captcha refresh produced a new image");
      } else {
        logStep("captcha refresh did not change the image yet; the next loop will retry");
      }
    }
  }

  const result = {
    runName: runContext.runName,
    runDir: runContext.runDir,
    manifestPath: runContext.manifestPath,
    summaryPath: runContext.summaryPath,
    requestedCount: config.captchaCollectCount,
    savedCount: entries.length,
    duplicateSkipCount,
    reopenCount,
    refreshMethodCounts,
    uniqueSignatureCount: new Set(entries.map((entry) => entry.signatureHash).filter(Boolean)).size,
    completionRatio: config.captchaCollectCount > 0
      ? Number((entries.length / config.captchaCollectCount).toFixed(4))
      : 0,
  };

  writeCaptchaCollectionSummary(runContext.summaryPath, result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 作用：
 * 解析命令行参数并启动对应的 Chrome CLI 模式。
 *
 * 为什么这样写：
 * 把 v1 所需的 doctor、check、debug 与 captcha 采集模式统一到一个入口，便于用户记忆和扩展。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {Promise<void>} 命令执行完成后的 Promise。
 *
 * 注意：
 * - 默认进入 check 模式，更符合“单次检查”工具的主目标。
 * - 非法命令应返回非零退出码。
 */
async function main(argv) {
  const mode = argv[2] || "check";
  const config = loadChromeCliConfig();

  if (mode === "doctor") {
    await runDoctor(config);
    return;
  }

  if (mode === "check") {
    await runChromeCheck(config);
    return;
  }

  if (mode === "debug") {
    await runDebug(config);
    return;
  }

  if (mode === "collect-captcha") {
    await runCaptchaCollection(config);
    return;
  }

  if (mode === "diagnose-refresh") {
    await runRefreshDiagnostics(config);
    return;
  }

  console.error(`Unsupported mode "${mode}". Use "doctor", "check", "debug", "collect-captcha", or "diagnose-refresh".`);
  process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(error.stack || error.message);

    if (error.appleEventsHelpText) {
      console.error(error.appleEventsHelpText);
    }

    process.exitCode = 1;
  });
}

module.exports = {
  buildCaptchaCollectionRunName,
  buildCaptchaCollectionSamplePrefix,
  buildCaptchaSignatureDigest,
  buildFinalAvailabilityLine,
  buildCaptchaImageSources,
  buildRefreshDiagnosticAttemptPrefix,
  buildRefreshDiagnosticRunName,
  createCaptchaCollectionRunContext,
  createRefreshDiagnosticRunContext,
  canReuseExistingCaptchaCollectionSnapshot,
  hasFreshCaptchaSnapshot,
  hasUsableRefreshClickPoint,
  getCaptchaSnapshotSignature,
  isChromeTabNotFoundError,
  main,
  summarizeSnapshotForRefreshDiagnostic,
  sanitizeFileNamePart,
  saveCaptchaCollectionSample,
  saveRefreshDiagnosticSnapshotImages,
  selectPreferredCaptchaLabelSource,
  selectBestCaptchaSolverResult,
  hasCaptchaImageEvidence,
  isConfidentLocalModelAttempt,
  shouldPrepareChromeTabAfterNavigationError,
  promoteSnapshotToPostCaptchaSelection,
  shouldRecheckPostSubmitState,
  waitForCaptchaSignatureChange,
  writeChromeStatusArtifact,
  writeCaptchaCollectionSummary,
  writeRefreshDiagnosticRecord,
  writeRefreshDiagnosticSummary,
  writeCaptchaCollectionManifest,
  writeCaptchaImageFile,
};
