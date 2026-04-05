const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const { isLikelyCaptchaText } = require("./chrome-utils");
const {
  readLabelEntries,
  resolveLabelManifestPath,
  writeLabelEntries,
} = require("./captcha-labeler");
const {
  loadLocalCaptchaModel,
  predictCaptchaImagePath,
} = require("./captcha-train-local");
const { getArtifactsDir, getCurrentCaptchaModelPath, getDataDir } = require("./project-paths");

/**
 * 作用：
 * 判断一条标注记录当前是否还需要 OCR 建议。
 *
 * 为什么这样写：
 * 已经人工确认过的条目不应该被机器建议重写。
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
 * - 旧的 `ocrText` 会被新的批量建议覆盖，方便重新跑改进后的本地模型规则。
 */
function shouldSuggestOcrForEntry(entry) {
  return String((entry && entry.expectedText) || "").trim() === "";
}

/**
 * 作用：
 * 从多轮机器建议尝试中选出最值得作为默认值的候选结果。
 *
 * 为什么这样写：
 * 同一张 captcha 图后续可能会引入多轮本地模型变体尝试。
 * 如果其中某一轮已经拿到 4 位候选，就优先采用；否则退回到“长度更接近 4 且置信度更高”的结果。
 *
 * 输入：
 * @param {Array<object>} attempts - 当前图片的机器建议结果列表。
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
 * 返回 `captcha:suggest` 默认使用的本地模型路径。
 *
 * 为什么这样写：
 * live checker 和标注预填应当基于同一份模型产物。
 * 把默认路径收成一个函数后，CLI 入口和测试都能共享同一条契约。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 默认模型文件路径。
 *
 * 注意：
 * - 允许通过 `LOCAL_CAPTCHA_MODEL_PATH` 覆盖默认模型路径。
 * - 默认仍然指向 `model/captcha-model-current/model.json`。
 */
function getDefaultLocalSuggestionModelPath() {
  return path.resolve(process.cwd(), process.env.LOCAL_CAPTCHA_MODEL_PATH || getCurrentCaptchaModelPath());
}

/**
 * 作用：
 * 把本地模型预测结果转换成兼容现有 manifest 的建议结构。
 *
 * 为什么这样写：
 * 标注清单和 UI 目前仍然消费 `ocrText`、`ocrConfidence` 这组字段。
 * 把字段映射单独抽成纯函数后，测试可以直接锁住“本地模型输出如何进入 manifest”，
 * 不需要在单元测试里真的加载图片和模型。
 *
 * 输入：
 * @param {object} prediction - 本地模型预测结果。
 *
 * 输出：
 * @returns {object} 兼容现有 manifest 的建议结果对象。
 *
 * 注意：
 * - 当前 `ocrAttempts` 只写入一条 `local-model` 记录。
 * - 这里保留 `ocr*` 字段名只是为了兼容现有 manifest 与标注器。
 */
function buildSuggestionFromLocalPrediction(prediction) {
  const attempts = [
    {
      engine: "local-model",
      passLabel: "serif-hybrid-model",
      rawText: String((prediction && prediction.text) || ""),
      candidate: String((prediction && prediction.text) || ""),
      confidence: Number((prediction && prediction.confidence) || 0),
      averageDistance: Number(
        prediction && Number.isFinite(prediction.averageDistance)
          ? prediction.averageDistance
          : Number.POSITIVE_INFINITY
      ),
      topK: Array.isArray(prediction && prediction.topK) ? prediction.topK : [],
      glyphMetrics: Array.isArray(prediction && prediction.glyphMetrics)
        ? prediction.glyphMetrics
        : [],
      segmentation: (prediction && prediction.segmentation) || null,
      segmentationQuality:
        prediction && prediction.segmentation
          ? Number(prediction.segmentation.segmentationQuality || 0)
          : 0,
      isLikely: isLikelyCaptchaText(prediction && prediction.text),
    },
  ];
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
 * 用当前本地 captcha 模型对单张本地图片生成默认建议值。
 *
 * 为什么这样写：
 * 用户已经明确要求把 `captcha:suggest` 从 Tesseract 切回本地模型。
 * 这里直接复用 live checker 的同一套模型、分割和置信度字段，能让标注预填更贴近线上实际策略。
 *
 * 输入：
 * @param {object} model - 已加载的本地 captcha 模型。
 * @param {string} imagePath - 当前 captcha 图片路径。
 *
 * 输出：
 * @returns {object} 包含建议文本、置信度和模型诊断信息的结果对象。
 *
 * 注意：
 * - 这里保留 `ocr*` 字段名只是为了兼容现有 manifest 与标注器，不代表底层仍在使用 OCR。
 * - 实际字段映射委托给 `buildSuggestionFromLocalPrediction()`，避免逻辑分叉。
 */
function recognizeCaptchaSuggestionWithLocalModel(model, imagePath) {
  const prediction = predictCaptchaImagePath(imagePath, model);
  return buildSuggestionFromLocalPrediction(prediction);
}

/**
 * 作用：
 * 把 OCR 建议结果回写到单条标注记录。
 *
 * 为什么这样写：
 * `expectedText` 是人工确认结果，`ocrText` 是机器建议值。
 * 保留这组字段后，标注器仍然可以直接把建议值作为默认输入展示，而不用迁移现有 manifest 结构。
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
 * - 会记录 `ocrUpdatedAt`，方便后续知道建议是否来自最新一轮模型建议。
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
 * 当前只需要支持选择目标数据集和目标模型，自己解析足够直接，也方便和现有 CLI 习惯保持一致。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数数组。
 *
 * 输出：
 * @returns {object} 解析后的参数对象。
 *
 * 注意：
 * - 当前支持 `--dataset` 和 `--model`。
 * - 未传 `--dataset` 时会复用标注器的默认目标选择逻辑。
 */
function parseSuggestArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: "",
    modelPath: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--dataset") {
      options.datasetInput = String(args[index + 1] || "");
      index += 1;
      continue;
    }

    if (arg === "--model") {
      options.modelPath = String(args[index + 1] || "");
      index += 1;
    }
  }

  return options;
}

/**
 * 作用：
 * 批量为未标注 captcha 图片生成本地模型建议并回写到标注文件。
 *
 * 为什么这样写：
 * 用户当前最大的瓶颈不是没有标注工具，而是从空白开始输入太慢。
 * 批量预填本地模型建议后，后续确认速度会明显提升，而且与 live checker 的判断路径一致。
 *
 * 输入：
 * @param {string} manifestPath - 目标标注文件路径。
 * @param {string} modelPath - 本地模型文件路径。
 *
 * 输出：
 * @returns {Promise<object>} 本轮 OCR 建议的摘要结果。
 *
 * 注意：
 * - 只处理 `expectedText` 仍为空的条目。
 * - 任一图片预测失败时会记录错误并继续后续条目，避免整批中断。
 */
async function generateOcrSuggestions(manifestPath, modelPath = "") {
  const entries = readLabelEntries(manifestPath);
  const resolvedModelPath = path.resolve(
    process.cwd(),
    modelPath || getDefaultLocalSuggestionModelPath()
  );
  const model = loadLocalCaptchaModel(resolvedModelPath);
  let suggestedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

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
      const suggestion = recognizeCaptchaSuggestionWithLocalModel(model, imagePath);

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
    modelPath: resolvedModelPath,
    totalCount: entries.length,
    suggestedCount,
    skippedCount,
    failedCount,
  };
}

/**
 * 作用：
 * 运行本地模型建议命令主入口。
 *
 * 为什么这样写：
 * 该命令负责选出当前活跃标注文件，批量生成未标注条目的机器默认值，并输出摘要结果。
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
  const dataDir = getDataDir();
  const artifactsDir = getArtifactsDir();
  const manifestPath =
    resolveLabelManifestPath(options.datasetInput, dataDir) ||
    resolveLabelManifestPath(options.datasetInput, artifactsDir);

  if (!manifestPath) {
    throw new Error("No label manifest was found. Pass --dataset or prepare a captcha dataset first.");
  }

  const result = await generateOcrSuggestions(manifestPath, options.modelPath);

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
  buildSuggestionFromLocalPrediction,
  getDefaultLocalSuggestionModelPath,
  generateOcrSuggestions,
  parseSuggestArgs,
  recognizeCaptchaSuggestionWithLocalModel,
  selectBestOcrAttempt,
  shouldSuggestOcrForEntry,
};
