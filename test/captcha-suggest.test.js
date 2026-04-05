const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyOcrSuggestionToEntry,
  parseSuggestArgs,
  selectBestOcrAttempt,
  shouldSuggestOcrForEntry,
} = require("../src/captcha-suggest");

/**
 * 作用：
 * 验证 OCR 建议只会应用到尚未人工确认的条目。
 *
 * 为什么这样写：
 * 当前策略是“给默认值，但不覆盖人工确认结果”。
 * 这条测试锁住是否继续跑 OCR 的判断条件，避免已确认标签被重复污染。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例标注条目。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 只要 `expectedText` 非空，就视为已人工确认。
 * - 空白字符串仍然应视为未标注。
 */
test("shouldSuggestOcrForEntry skips entries that already have confirmed labels", () => {
  assert.equal(shouldSuggestOcrForEntry({ expectedText: "" }), true);
  assert.equal(shouldSuggestOcrForEntry({ expectedText: "   " }), true);
  assert.equal(shouldSuggestOcrForEntry({ expectedText: "A8Bd" }), false);
});

/**
 * 作用：
 * 验证 OCR 尝试选择器会优先采用四字符建议。
 *
 * 为什么这样写：
 * 用户需要的是“最像正确答案的默认值”，不是单纯最高置信度。
 * 真实规则里四字符结果比短结果更有业务意义，因此测试要锁住这个优先级。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 OCR 尝试列表。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 四字符结果应优先于更高置信度的短结果。
 * - 候选长度和置信度是次级排序条件。
 */
test("selectBestOcrAttempt prefers likely four-character candidates", () => {
  const winner = selectBestOcrAttempt([
    {
      passLabel: "fallback-no-whitelist",
      candidate: "AB",
      confidence: 91,
      isLikely: false,
    },
    {
      passLabel: "strict-whitelist",
      candidate: "A8Bd",
      confidence: 66,
      isLikely: true,
    },
  ]);

  assert.equal(winner.passLabel, "strict-whitelist");
  assert.equal(winner.candidate, "A8Bd");
});

/**
 * 作用：
 * 验证 OCR 建议回写时不会改动人工确认字段。
 *
 * 为什么这样写：
 * 批量 OCR 只是给默认值，不应该把 `expectedText` 直接算成已确认标签。
 * 这条测试锁住字段边界，避免建议值和最终标签混在一起。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目和 OCR 建议。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - `expectedText` 应保持原值。
 * - `ocrText` 和相关元数据应被写入。
 */
test("applyOcrSuggestionToEntry stores OCR metadata without overwriting expectedText", () => {
  const nextEntry = applyOcrSuggestionToEntry({
    id: "captcha-0001",
    expectedText: "",
  }, {
    ocrText: "A8Bd",
    ocrConfidence: 72,
    ocrPassLabel: "strict-whitelist",
    ocrRawText: "A8Bd",
    ocrIsLikely: true,
    ocrAttempts: [
      {
        passLabel: "strict-whitelist",
        candidate: "A8Bd",
        confidence: 72,
        isLikely: true,
      },
    ],
  });

  assert.equal(nextEntry.expectedText, "");
  assert.equal(nextEntry.ocrText, "A8Bd");
  assert.equal(nextEntry.ocrConfidence, 72);
  assert.equal(nextEntry.ocrPassLabel, "strict-whitelist");
  assert.equal(nextEntry.ocrIsLikely, true);
  assert.ok(nextEntry.ocrUpdatedAt);
});

/**
 * 作用：
 * 验证 OCR 建议命令参数解析。
 *
 * 为什么这样写：
 * 批量 OCR 建议也需要支持指定目标数据集。
 * 这条测试锁住 `--dataset` 的参数契约，避免命令入口漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 未传参数时应保留默认空值。
 * - 当前仅支持 `--dataset`。
 */
test("parseSuggestArgs reads the dataset override", () => {
  const parsed = parseSuggestArgs([
    "node",
    "src/captcha-suggest.js",
    "--dataset",
    "artifacts/captcha-images-current-labels.json",
  ]);

  assert.equal(parsed.datasetInput, "artifacts/captcha-images-current-labels.json");
});
