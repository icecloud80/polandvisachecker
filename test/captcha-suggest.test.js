const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyOcrSuggestionToEntry,
  buildSuggestionFromLocalPrediction,
  getDefaultLocalSuggestionModelPath,
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
 * 验证机器建议选择器会优先采用四字符建议。
 *
 * 为什么这样写：
 * 用户需要的是“最像正确答案的默认值”，不是单纯最高置信度。
 * 真实规则里四字符结果比短结果更有业务意义，因此测试要锁住这个优先级。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例机器建议列表。
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
 * 验证本地模型预测会被映射成兼容现有 manifest 的建议结构。
 *
 * 为什么这样写：
 * 这次改动的核心不是字段名变化，而是建议来源从 Tesseract 切到了本地模型。
 * 这条测试锁住“模型输出如何进入 `ocrText` 等字段”，避免标注器在不知不觉间失去默认值。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例本地模型预测结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里仍然保留 `ocr*` 字段名，只是为了兼容现有 manifest。
 * - `ocrAttempts[0].engine` 必须标记为 `local-model`。
 */
test("buildSuggestionFromLocalPrediction stores local-model suggestion metadata", () => {
  const suggestion = buildSuggestionFromLocalPrediction({
    text: "Q8#Y",
    confidence: 0.84,
    averageDistance: 21.5,
    topK: [[{ label: "Q", score: 12.1 }]],
    glyphMetrics: [{ width: 8 }],
    segmentation: {
      segmentationQuality: 0.91,
    },
  });

  assert.equal(suggestion.ocrText, "Q8#Y");
  assert.equal(suggestion.ocrConfidence, 0.84);
  assert.equal(suggestion.ocrPassLabel, "serif-hybrid-model");
  assert.equal(suggestion.ocrIsLikely, true);
  assert.equal(suggestion.ocrAttempts[0].engine, "local-model");
  assert.equal(suggestion.ocrAttempts[0].segmentationQuality, 0.91);
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
 * 验证建议命令参数解析。
 *
 * 为什么这样写：
 * 批量建议也需要支持指定目标数据集和模型路径。
 * 这条测试锁住 `--dataset` 与 `--model` 的参数契约，避免命令入口漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 未传参数时应保留默认空值。
 * - 当前支持 `--dataset` 和 `--model`。
 */
test("parseSuggestArgs reads the dataset and model overrides", () => {
  const parsed = parseSuggestArgs([
    "node",
    "src/captcha-suggest.js",
    "--dataset",
    "artifacts/captcha-images-current-labels.json",
    "--model",
    "artifacts/captcha-model-current/model.json",
  ]);

  assert.equal(parsed.datasetInput, "artifacts/captcha-images-current-labels.json");
  assert.equal(parsed.modelPath, "artifacts/captcha-model-current/model.json");
});

/**
 * 作用：
 * 验证本地模型建议命令默认会指向当前训练产物目录。
 *
 * 为什么这样写：
 * `captcha:suggest` 现在已经改为依赖本地模型。
 * 这条测试锁住默认模型位置，避免后续脚本路径改动让建议命令突然找不到模型。
 *
 * 输入：
 * @param {object} 无 - 直接读取默认模型路径。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前断言只关注尾部相对路径，避免和本机绝对路径耦合。
 */
test("getDefaultLocalSuggestionModelPath points at the current local model artifact", () => {
  assert.match(
    getDefaultLocalSuggestionModelPath(),
    /artifacts[\\/]+captcha-model-current[\\/]+model\.json$/u
  );
});
