const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnalysisReport,
  parseAnalyzeArgs,
  readAnalysisArtifacts,
} = require("../src/captcha-analyze");

/**
 * 作用：
 * 验证分析命令参数解析会读取模型目录覆盖项。
 *
 * 为什么这样写：
 * 新增 `captcha:analyze` 后，最常见的操作就是指定某次训练产物目录做复盘。
 * 这条测试锁住入口参数契约，避免命令行覆盖路径失效。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 默认目录仍应指向 `model/captcha-model-current`。
 * - 这里只验证解析行为，不触发实际训练。
 */
test("parseAnalyzeArgs reads the model directory override", () => {
  const parsed = parseAnalyzeArgs([
    "node",
    "src/captcha-analyze.js",
    "--model-dir",
    "model/captcha-model-v2",
  ]);

  assert.equal(parsed.modelDir, path.resolve(process.cwd(), "model/captcha-model-v2"));
});

/**
 * 作用：
 * 验证分析报告会重算位置指标、混淆摘要和 5 次预算估算。
 *
 * 为什么这样写：
 * 这版计划要求 `captcha:analyze` 不只是回显 summary，而是输出更适合补数据和调参的 hard-case 报告。
 * 这条测试锁住分析命令的核心结构，避免后续只剩一份原始 metrics 回显。
 *
 * 输入：
 * @param {object} 无 - 直接传入伪造的 val/test 预测。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前重点分析 holdout，因此 train predictions 不参与重算。
 * - serif confusion 和 five-attempt estimate 都必须存在。
 */
test("buildAnalysisReport recomputes holdout-focused captcha analysis fields", () => {
  const report = buildAnalysisReport({
    modelDir: "/tmp/fake-model",
    summary: {
      metrics: {
        val: { exactMatchRate: 0.4 },
        test: { exactMatchRate: 0.5 },
      },
      characterCategoryCoverage: {
        digits: 10,
        uppercase: 12,
        lowercase: 9,
        symbols: 6,
      },
    },
    trainPredictions: [],
    valPredictions: [
      {
        expectedText: "C@t=",
        exactMatch: false,
        characters: ["c", "a", "t", "t"],
      },
    ],
    testPredictions: [
      {
        expectedText: "P#K7",
        exactMatch: false,
        characters: ["p", "H", "k", "+"],
      },
      {
        expectedText: "A8Bd",
        exactMatch: true,
        characters: ["A", "8", "B", "d"],
      },
    ],
  });

  assert.ok(Array.isArray(report.positionMetrics));
  assert.ok(Array.isArray(report.confusionSummary));
  assert.ok(Array.isArray(report.serifConfusionSummary));
  assert.ok(report.fiveAttemptSuccessEstimate);
  assert.equal(report.fiveAttemptSuccessEstimate.sampleCount, 3);
});

/**
 * 作用：
 * 验证分析命令可以从模型目录读取所需产物。
 *
 * 为什么这样写：
 * `captcha:analyze` 依赖现成的 summary 和 prediction 文件。
 * 这条测试锁住文件读取契约，避免未来训练产物命名漂移后分析命令悄悄失效。
 *
 * 输入：
 * @param {object} 无 - 在临时目录中写入最小模型产物。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前最少需要 `summary.json`、`train-predictions.json`、`val-predictions.json`、`test-predictions.json`。
 * - 这里只验证读取，不验证训练逻辑。
 */
test("readAnalysisArtifacts loads summary and split predictions from a model directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "captcha-analyze-"));
  const summaryPath = path.join(tempDir, "summary.json");
  const trainPredictionsPath = path.join(tempDir, "train-predictions.json");
  const valPredictionsPath = path.join(tempDir, "val-predictions.json");
  const testPredictionsPath = path.join(tempDir, "test-predictions.json");

  fs.writeFileSync(summaryPath, JSON.stringify({ metrics: {} }, null, 2));
  fs.writeFileSync(trainPredictionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(valPredictionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(testPredictionsPath, JSON.stringify([], null, 2));

  const artifacts = readAnalysisArtifacts(tempDir);

  assert.equal(artifacts.modelDir, tempDir);
  assert.deepEqual(artifacts.summary, { metrics: {} });
  assert.deepEqual(artifacts.trainPredictions, []);
  assert.deepEqual(artifacts.valPredictions, []);
  assert.deepEqual(artifacts.testPredictions, []);
});
