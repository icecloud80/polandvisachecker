const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assignTrainingSplit,
  buildTrainingRecord,
  countCharacterFrequency,
  isRetryableDirectoryRemovalError,
  normalizeTrainingLabel,
  parseTrainingArgs,
  removeDirectoryWithRetries,
  sleepSync,
  summarizeOcrBaseline,
  validateTrainingEntries,
} = require("../src/captcha-training");

/**
 * 作用：
 * 验证训练标签归一化只去掉首尾空白。
 *
 * 为什么这样写：
 * 训练标签必须保持和人工确认结果一致，不能把符号或大小写错误改坏。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例标签。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 中间符号字符必须原样保留。
 * - 这里只做最轻量归一化。
 */
test("normalizeTrainingLabel preserves symbol characters in confirmed labels", () => {
  assert.equal(normalizeTrainingLabel("  S+k= "), "S+k=");
});

/**
 * 作用：
 * 验证训练切分规则是稳定且只返回预期 split。
 *
 * 为什么这样写：
 * 后续训练和评估要依赖固定 split，不应因为导出次数不同而漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例样本 ID。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 相同 ID 必须始终得到相同 split。
 * - 当前只允许 `train`、`val`、`test` 三种值。
 */
test("assignTrainingSplit is deterministic and returns a known bucket", () => {
  const left = assignTrainingSplit("captcha-0001");
  const right = assignTrainingSplit("captcha-0001");

  assert.equal(left, right);
  assert.match(left, /^(train|val|test)$/);
});

/**
 * 作用：
 * 验证训练前校验会识别缺标签和缺图片问题。
 *
 * 为什么这样写：
 * 训练导出不应默默吞掉脏数据。
 * 这条测试锁住最关键的两类错误，避免坏样本混入训练集。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前要求标签长度固定为 4。
 * - 图片路径必须真实存在才算合法。
 */
test("validateTrainingEntries reports missing labels and missing images", () => {
  const issues = validateTrainingEntries([
    {
      id: "captcha-0001",
      expectedText: "",
      imagePath: "/tmp/missing-1.png",
    },
    {
      id: "captcha-0002",
      expectedText: "ABC",
      imagePath: "/tmp/missing-2.png",
    },
  ]);

  assert.ok(issues.some((issue) => issue.problem === "missing_label"));
  assert.ok(issues.some((issue) => issue.problem === "label_length_not_4"));
  assert.ok(issues.some((issue) => issue.problem === "missing_image"));
});

/**
 * 作用：
 * 验证训练目录删除重试器只会对白名单里的临时错误码返回 true。
 *
 * 为什么这样写：
 * 这次真实训练是被 `ENOTEMPTY` 挡住的。
 * 这条测试锁住可重试错误边界，避免以后把真正的逻辑错误也误判成“再试一次就好”。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例错误对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只对白名单错误码开放重试。
 * - 未知错误码必须保持 false。
 */
test("isRetryableDirectoryRemovalError only accepts transient directory removal errors", () => {
  assert.equal(isRetryableDirectoryRemovalError({ code: "ENOTEMPTY" }), true);
  assert.equal(isRetryableDirectoryRemovalError({ code: "EBUSY" }), true);
  assert.equal(isRetryableDirectoryRemovalError({ code: "EPERM" }), true);
  assert.equal(isRetryableDirectoryRemovalError({ code: "ENOENT" }), false);
});

/**
 * 作用：
 * 验证训练目录删除重试器会在临时错误后再次尝试。
 *
 * 为什么这样写：
 * 真实 bug 并不是目录永久删不掉，而是第一次删除偶发失败。
 * 这条测试锁住“第一次 ENOTEMPTY，第二次成功”的重试行为，避免修复只停留在文档层面。
 *
 * 输入：
 * @param {object} 无 - 通过临时替换 `fs.rmSync` 来模拟文件系统错误。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 测试结束后必须恢复原始 `fs.rmSync`。
 * - `retryDelayMs` 设为 0，避免单元测试白白等待。
 */
test("removeDirectoryWithRetries retries after a transient ENOTEMPTY failure", () => {
  const fs = require("node:fs");
  const originalRmSync = fs.rmSync;
  let callCount = 0;

  fs.rmSync = () => {
    callCount += 1;

    if (callCount === 1) {
      const error = new Error("Directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    }
  };

  try {
    removeDirectoryWithRetries("/tmp/example-training-dir", {
      retries: 2,
      retryDelayMs: 0,
    });
  } finally {
    fs.rmSync = originalRmSync;
  }

  assert.equal(callCount, 2);
});

/**
 * 作用：
 * 验证字符频次统计会覆盖字母、数字和符号。
 *
 * 为什么这样写：
 * 这批 captcha 的难点之一就是符号字符覆盖。
 * 测试要锁住统计逻辑，方便后续观察训练集分布。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 统计对象按字符排序。
 * - 这里只关心出现次数，不关心顺序位置。
 */
test("countCharacterFrequency tallies letters, digits, and symbols", () => {
  const frequencies = countCharacterFrequency([
    { expectedText: "A8Bd" },
    { expectedText: "S+k=" },
  ]);

  assert.equal(frequencies.A, 1);
  assert.equal(frequencies["8"], 1);
  assert.equal(frequencies["+"] , 1);
  assert.equal(frequencies["="], 1);
});

/**
 * 作用：
 * 验证 OCR 基线摘要会正确计算覆盖率和精确匹配率。
 *
 * 为什么这样写：
 * 导出 summary 要能告诉我们现有 OCR 建议到底有多大帮助。
 * 这条测试锁住基线统计公式，避免后续报告含义漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - `exactMatchRate` 只在有 OCR 建议的子集上计算。
 * - `coverageRate` 以全部样本为分母。
 */
test("summarizeOcrBaseline computes coverage and exact-match rates", () => {
  const summary = summarizeOcrBaseline([
    { expectedText: "A8Bd", ocrText: "A8Bd" },
    { expectedText: "S+k=", ocrText: "S+kx" },
    { expectedText: "DTCx", ocrText: "" },
  ]);

  assert.equal(summary.totalCount, 3);
  assert.equal(summary.suggestedCount, 2);
  assert.equal(summary.exactMatchCount, 1);
  assert.equal(summary.exactMatchRate, 0.5);
  assert.equal(summary.coverageRate, 0.6667);
});

/**
 * 作用：
 * 验证训练记录构造会保留稳定字段。
 *
 * 为什么这样写：
 * 训练目录里的 JSONL 是后续脚本的输入契约。
 * 测试锁住最小字段集合，防止导出结构意外变化。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目和相对图片路径。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - `text` 使用人工确认结果。
 * - `image` 必须保持相对路径。
 */
test("buildTrainingRecord returns the expected training fields", () => {
  const record = buildTrainingRecord({
    id: "captcha-0001",
    expectedText: "A8Bd",
    sha1: "abc123",
  }, "images/captcha-0001.png");

  assert.equal(record.id, "captcha-0001");
  assert.equal(record.text, "A8Bd");
  assert.equal(record.image, "images/captcha-0001.png");
  assert.equal(record.sha1, "abc123");
  assert.match(record.split, /^(train|val|test)$/);
});

/**
 * 作用：
 * 验证训练导出命令参数解析。
 *
 * 为什么这样写：
 * 训练导出当前只开放最小参数面，测试可以防止命令入口不小心漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前仅支持 `--dataset`。
 * - 未传参数时会保留默认空值。
 */
test("parseTrainingArgs reads the dataset override", () => {
  const parsed = parseTrainingArgs([
    "node",
    "src/captcha-training.js",
    "--dataset",
    "artifacts/captcha-images-current-labels.json",
  ]);

  assert.equal(parsed.datasetInput, "artifacts/captcha-images-current-labels.json");
});
