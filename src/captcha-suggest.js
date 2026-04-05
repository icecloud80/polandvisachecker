const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const { createWorker } = require("tesseract.js");

const {
  CAPTCHA_ALLOWED_CHARACTERS,
  extractBestCaptchaTextCandidate,
  isLikelyCaptchaText,
} = require("./chrome-utils");
const {
  readLabelEntries,
  resolveLabelManifestPath,
  writeLabelEntries,
} = require("./captcha-labeler");

/**
 * 作用：
 * 判断一条标注记录当前是否还需要 OCR 建议。
 *
 * 为什么这样写：
 * 已经人工确认过的条目不应该被 OCR 重写。
 * 只对 `expectedText` 为空的条目生成建议，既能提效，也能避免污染已确认标签。
 *
 * 输入：
 * @param {object} entry - 单条标注记录。
 *
 * 输出：
 * @returns {boolean} 是否应当继续为这条记录生成 OCR 建议。
 *
 * 注意：
 * - 当前只根据 `expectedText` 是否为空判断。
 * - 旧的 `ocrText` 会被新的批量建议覆盖，方便重新跑改进后的 OCR 规则。
 */
function shouldSuggestOcrForEntry(entry) {
  return String((entry && entry.expectedText) || "").trim() === "";
}

/**
 * 作用：
 * 从多轮 OCR 尝试中选出最值得作为默认值的候选结果。
 *
 * 为什么这样写：
 * 同一张 captcha 图我们会跑至少两轮 OCR。
 * 如果其中某一轮已经拿到 4 位候选，就优先采用；否则退回到“长度更接近 4 且置信度更高”的结果。
 *
 * 输入：
 * @param {Array<object>} attempts - 当前图片的 OCR 尝试结果列表。
 *
 * 输出：
 * @returns {object | null} 最佳 OCR 尝试结果；没有结果时返回 null。
 *
 * 注意：
 * - 当前排序优先级是：是否 4 位、候选长度、置信度。
 * - 这里返回的是“默认建议”，不代表人工最终正确答案。
 */
function selectBestOcrAttempt(attempts) {
  const normalizedAttempts = Array.isArray(attempts) ? attempts.filter(Boolean) : [];

  if (normalizedAttempts.length === 0) {
    return null;
  }

  return normalizedAttempts
    .slice()
    .sort((left, right) => {
      const leftLikely = left.isLikely ? 1 : 0;
      const rightLikely = right.isLikely ? 1 : 0;

      return (
        rightLikely - leftLikely ||
        String(right.candidate || "").length - String(left.candidate || "").length ||
        Number(right.confidence || 0) - Number(left.confidence || 0)
      );
    })[0];
}

/**
 * 作用：
 * 用共享 OCR worker 对单张本地 captcha 图片生成建议值。
 *
 * 为什么这样写：
 * 批量 OCR 时重复创建 worker 很慢。
 * 让单张识别复用同一个 worker，既能保持逻辑清晰，也能显著减少 172 张图的处理时间。
 *
 * 输入：
 * @param {object} worker - Tesseract worker 实例。
 * @param {string} imagePath - 当前 captcha 图片路径。
 *
 * 输出：
 * @returns {Promise<object>} 包含建议文本、置信度和原始 OCR 尝试列表的结果对象。
 *
 * 注意：
 * - 当前会先跑白名单严格模式，再跑无白名单兜底模式。
 * - 返回值里的 `ocrText` 仅作为默认建议，不会自动写入 `expectedText`。
 */
async function recognizeCaptchaSuggestionWithWorker(worker, imagePath) {
  const attempts = [];

  for (const pass of [
    {
      label: "strict-whitelist",
      whitelist: CAPTCHA_ALLOWED_CHARACTERS,
    },
    {
      label: "fallback-no-whitelist",
      whitelist: "",
    },
  ]) {
    await worker.setParameters({
      tessedit_char_whitelist: pass.whitelist,
    });

    const {
      data: { text, confidence },
    } = await worker.recognize(imagePath);
    const rawText = String(text || "");
    const candidate = extractBestCaptchaTextCandidate(rawText);

    attempts.push({
      passLabel: pass.label,
      rawText,
      candidate,
      confidence: Number(confidence || 0),
      isLikely: isLikelyCaptchaText(candidate),
    });
  }

  const bestAttempt = selectBestOcrAttempt(attempts);

  return {
    ocrText: String((bestAttempt && bestAttempt.candidate) || ""),
    ocrConfidence: Number((bestAttempt && bestAttempt.confidence) || 0),
    ocrPassLabel: String((bestAttempt && bestAttempt.passLabel) || ""),
    ocrRawText: String((bestAttempt && bestAttempt.rawText) || ""),
    ocrIsLikely: Boolean(bestAttempt && bestAttempt.isLikely),
    ocrAttempts: attempts,
  };
}

/**
 * 作用：
 * 把 OCR 建议结果回写到单条标注记录。
 *
 * 为什么这样写：
 * `expectedText` 是人工确认结果，`ocrText` 是机器建议值。
 * 把两者分开后，标注器就能把 OCR 结果作为默认输入展示，而不会错误地把它算成已标注。
 *
 * 输入：
 * @param {object} entry - 原始标注记录。
 * @param {object} suggestion - OCR 建议结果。
 *
 * 输出：
 * @returns {object} 更新后的标注记录。
 *
 * 注意：
 * - 不会修改 `expectedText`。
 * - 会记录 `ocrUpdatedAt`，方便后续知道建议是否来自最新一轮 OCR。
 */
function applyOcrSuggestionToEntry(entry, suggestion) {
  return {
    ...entry,
    ocrText: String((suggestion && suggestion.ocrText) || ""),
    ocrConfidence: Number((suggestion && suggestion.ocrConfidence) || 0),
    ocrPassLabel: String((suggestion && suggestion.ocrPassLabel) || ""),
    ocrRawText: String((suggestion && suggestion.ocrRawText) || ""),
    ocrIsLikely: Boolean(suggestion && suggestion.ocrIsLikely),
    ocrAttempts: Array.isArray(suggestion && suggestion.ocrAttempts)
      ? suggestion.ocrAttempts
      : [],
    ocrUpdatedAt: new Date().toISOString(),
  };
}

/**
 * 作用：
 * 解析 OCR 建议命令的命令行参数。
 *
 * 为什么这样写：
 * 当前只需要支持选择目标数据集，自己解析足够直接，也方便和现有 CLI 习惯保持一致。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数数组。
 *
 * 输出：
 * @returns {object} 解析后的参数对象。
 *
 * 注意：
 * - 当前支持 `--dataset`。
 * - 未传 `--dataset` 时会复用标注器的默认目标选择逻辑。
 */
function parseSuggestArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--dataset") {
      options.datasetInput = String(args[index + 1] || "");
      index += 1;
    }
  }

  return options;
}

/**
 * 作用：
 * 批量为未标注 captcha 图片生成 OCR 建议并回写到标注文件。
 *
 * 为什么这样写：
 * 用户当前最大的瓶颈不是没有标注工具，而是从空白开始输入太慢。
 * 批量预填 OCR 建议后，后续确认速度会明显提升。
 *
 * 输入：
 * @param {string} manifestPath - 目标标注文件路径。
 *
 * 输出：
 * @returns {Promise<object>} 本轮 OCR 建议的摘要结果。
 *
 * 注意：
 * - 只处理 `expectedText` 仍为空的条目。
 * - 任一图片 OCR 失败时会记录错误并继续后续条目，避免整批中断。
 */
async function generateOcrSuggestions(manifestPath) {
  const entries = readLabelEntries(manifestPath);
  const worker = await createWorker("eng");
  let suggestedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    const nextEntries = [];

    for (const entry of entries) {
      if (!shouldSuggestOcrForEntry(entry)) {
        skippedCount += 1;
        nextEntries.push(entry);
        continue;
      }

      const imagePath = String((entry && entry.imagePath) || (entry && entry.labelImagePath) || "");

      if (!imagePath || !fs.existsSync(imagePath)) {
        failedCount += 1;
        nextEntries.push({
          ...entry,
          ocrText: "",
          ocrError: `Image file is missing: ${imagePath}`,
          ocrUpdatedAt: new Date().toISOString(),
        });
        continue;
      }

      try {
        const suggestion = await recognizeCaptchaSuggestionWithWorker(worker, imagePath);

        nextEntries.push(applyOcrSuggestionToEntry(entry, suggestion));
        suggestedCount += 1;
      } catch (error) {
        failedCount += 1;
        nextEntries.push({
          ...entry,
          ocrText: "",
          ocrError: error && error.message ? error.message : String(error),
          ocrUpdatedAt: new Date().toISOString(),
        });
      }
    }

    writeLabelEntries(manifestPath, nextEntries);

    return {
      manifestPath,
      totalCount: entries.length,
      suggestedCount,
      skippedCount,
      failedCount,
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * 作用：
 * 运行 OCR 建议命令主入口。
 *
 * 为什么这样写：
 * 该命令负责选出当前活跃标注文件，批量生成未标注条目的 OCR 默认值，并输出摘要结果。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {Promise<void>} 命令执行完成后的 Promise。
 *
 * 注意：
 * - 该命令不会改动已经人工确认的 `expectedText`。
 * - 默认目标会跟随标注器当前的默认 manifest 选择逻辑。
 */
async function main(argv) {
  const options = parseSuggestArgs(argv);
  const manifestPath = resolveLabelManifestPath(
    options.datasetInput,
    path.resolve(process.cwd(), "artifacts")
  );

  if (!manifestPath) {
    throw new Error("No label manifest was found. Pass --dataset or prepare a captcha dataset first.");
  }

  const result = await generateOcrSuggestions(manifestPath);

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  applyOcrSuggestionToEntry,
  generateOcrSuggestions,
  parseSuggestArgs,
  recognizeCaptchaSuggestionWithWorker,
  selectBestOcrAttempt,
  shouldSuggestOcrForEntry,
};
