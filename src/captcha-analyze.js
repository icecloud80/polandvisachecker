const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const {
  buildConfusionSummary,
  buildFiveAttemptSuccessEstimate,
  buildPositionMetrics,
  buildSerifConfusionSummary,
  buildSymbolErrorSummary,
} = require("./captcha-train-local");

/**
 * 作用：
 * 解析 captcha 分析命令的参数。
 *
 * 为什么这样写：
 * `captcha:analyze` 的主要输入是现有模型目录。
 * 单独解析参数后，后续读取 summary 和 prediction 文件时可以保持入口简单稳定。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {object} 解析后的分析参数。
 *
 * 注意：
 * - 默认分析 `artifacts/captcha-model-current`。
 * - 当前只支持 `--model-dir`。
 */
function parseAnalyzeArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    modelDir: path.resolve(process.cwd(), "artifacts/captcha-model-current"),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--model-dir" && args[index + 1]) {
      options.modelDir = path.resolve(process.cwd(), String(args[index + 1]));
      index += 1;
    }
  }

  return options;
}

/**
 * 作用：
 * 读取分析命令需要的模型评估产物。
 *
 * 为什么这样写：
 * `captcha:analyze` 的职责是复盘当前模型，而不是重新训练。
 * 直接消费训练阶段落下的 JSON 产物，速度更快，也更适合高频复查。
 *
 * 输入：
 * @param {string} modelDir - 模型产物目录。
 *
 * 输出：
 * @returns {object} 包含 summary 与各 split prediction 的对象。
 *
 * 注意：
 * - 缺少任何关键文件都会直接抛错。
 * - 当前要求目录里至少有 `summary.json`、`train-predictions.json`、`val-predictions.json`、`test-predictions.json`。
 */
function readAnalysisArtifacts(modelDir) {
  const resolvedModelDir = path.resolve(modelDir);
  const summaryPath = path.join(resolvedModelDir, "summary.json");
  const trainPredictionsPath = path.join(resolvedModelDir, "train-predictions.json");
  const valPredictionsPath = path.join(resolvedModelDir, "val-predictions.json");
  const testPredictionsPath = path.join(resolvedModelDir, "test-predictions.json");

  return {
    modelDir: resolvedModelDir,
    summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")),
    trainPredictions: JSON.parse(fs.readFileSync(trainPredictionsPath, "utf8")),
    valPredictions: JSON.parse(fs.readFileSync(valPredictionsPath, "utf8")),
    testPredictions: JSON.parse(fs.readFileSync(testPredictionsPath, "utf8")),
  };
}

/**
 * 作用：
 * 基于当前模型评估产物构造一份聚焦 hard cases 的分析报告。
 *
 * 为什么这样写：
 * 用户现在关心的是“如何继续把精度拉高”，不是只看一堆原始 prediction JSON。
 * 把 confusion、位置准确率、符号错误率和 5 次预算估算压缩成一份报告后，下一轮补数据和调参会更直接。
 *
 * 输入：
 * @param {object} artifacts - 评估产物集合。
 *
 * 输出：
 * @returns {object} 结构化分析报告。
 *
 * 注意：
 * - 重点分析 holdout（val + test），避免训练集指标过于乐观。
 * - 如 summary 已有同名字段，会优先保留最新重算结果。
 */
function buildAnalysisReport(artifacts) {
  const holdoutPredictions = [
    ...(Array.isArray(artifacts.valPredictions) ? artifacts.valPredictions : []),
    ...(Array.isArray(artifacts.testPredictions) ? artifacts.testPredictions : []),
  ];

  return {
    modelDir: artifacts.modelDir,
    metrics: artifacts.summary.metrics,
    positionMetrics: buildPositionMetrics(holdoutPredictions),
    confusionSummary: buildConfusionSummary(holdoutPredictions, 20),
    serifConfusionSummary: buildSerifConfusionSummary(holdoutPredictions, 20),
    symbolErrorSummary: buildSymbolErrorSummary(holdoutPredictions),
    fiveAttemptSuccessEstimate: buildFiveAttemptSuccessEstimate(holdoutPredictions, 5),
    characterCategoryCoverage: artifacts.summary.characterCategoryCoverage || {},
  };
}

/**
 * 作用：
 * 运行 captcha 模型分析命令。
 *
 * 为什么这样写：
 * 用户要求一个新的 `captcha:analyze` 命令。
 * 这个入口负责加载现有训练产物、生成 hard-case 报告并输出 JSON。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前命令只分析已有产物，不会隐式触发训练。
 * - 若模型目录缺文件，应先运行 `npm run captcha:train-local`。
 */
function main(argv) {
  const options = parseAnalyzeArgs(argv);
  const artifacts = readAnalysisArtifacts(options.modelDir);
  const report = buildAnalysisReport(artifacts);

  console.log(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildAnalysisReport,
  main,
  parseAnalyzeArgs,
  readAnalysisArtifacts,
};
