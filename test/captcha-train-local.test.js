const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFiveAttemptSuccessEstimate,
  buildPositionAwarePrototypeIndex,
  buildPositionMetrics,
  buildPrototypeModel,
  buildSerifConfusionSummary,
  buildSymbolErrorSummary,
  chooseGlyphBoundaries,
  computeOtsuThreshold,
  extractGlyphFeatureVector,
  parseLocalTrainArgs,
  paethPredictor,
  predictCharacterVector,
  selectBestGlyphSegmentation,
  selectRepresentativeExemplars,
  unfilterPngScanlines,
  vectorizeMaskRegion,
} = require("../src/captcha-train-local");

/**
 * 作用：
 * 验证 Paeth 预测器能返回距离最近的候选值。
 *
 * 为什么这样写：
 * PNG 解码依赖 Paeth 反滤波。
 * 这条测试锁住最底层的预测规则，避免图片解码被悄悄改坏。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例字节值。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前断言的是 PNG 标准算法的基础行为。
 * - 这里只测纯函数，不依赖真实图片文件。
 */
test("paethPredictor returns the nearest predictor candidate", () => {
  assert.equal(paethPredictor(10, 40, 12), 40);
  assert.equal(paethPredictor(60, 20, 58), 20);
});

/**
 * 作用：
 * 验证 PNG 的 Sub 滤波能被正确还原。
 *
 * 为什么这样写：
 * 第一版本地训练脚本自己解码 PNG。
 * 这条测试先锁住最常见的逐行反滤波行为。
 *
 * 输入：
 * @param {object} 无 - 直接构造简单扫描行数据。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里用的是 filter type 1（Sub）。
 * - 每像素 1 字节，便于人工验证结果。
 */
test("unfilterPngScanlines reconstructs Sub-filtered rows", () => {
  const inflated = Buffer.from([
    1,
    10,
    5,
    5,
  ]);
  const restored = unfilterPngScanlines(inflated, 3, 1, 1);

  assert.deepEqual(Array.from(restored), [10, 15, 20]);
});

/**
 * 作用：
 * 验证 Otsu 阈值能把深色和浅色像素分开。
 *
 * 为什么这样写：
 * 第一版模型依赖自适应阈值做前景提取。
 * 这条测试锁住最基本的双峰分离行为。
 *
 * 输入：
 * @param {object} 无 - 直接构造双峰灰度样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 不强求精确阈值，只要能落在合理分界区间即可。
 * - 阈值过低或过高都会导致分割失真。
 */
test("computeOtsuThreshold separates bimodal grayscale values", () => {
  const grayscale = Uint8Array.from([30, 32, 35, 210, 215, 220]);
  const indices = [0, 1, 2, 3, 4, 5];
  const threshold = computeOtsuThreshold(grayscale, indices);

  assert.ok(threshold >= 35);
  assert.ok(threshold <= 190);
});

/**
 * 作用：
 * 验证字符边界选择会倾向列投影低谷。
 *
 * 为什么这样写：
 * 当前 4 字分割是整套训练链路里最容易漂的部分。
 * 这条测试锁住“优先切在谷值附近”的基本倾向。
 *
 * 输入：
 * @param {object} 无 - 直接构造带低谷的列投影。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 返回结果是局部列索引边界。
 * - 这里只验证大方向，不要求每个切点完全精确。
 */
test("chooseGlyphBoundaries prefers low-projection valleys", () => {
  const projection = [
    8, 9, 7, 1,
    8, 8, 7, 1,
    9, 7, 8, 1,
    8, 8, 7, 6,
  ];
  const boundaries = chooseGlyphBoundaries(projection);

  assert.equal(boundaries.length, 5);
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries[4], projection.length);
  assert.ok(Math.abs(boundaries[1] - 4) <= 1);
  assert.ok(Math.abs(boundaries[2] - 8) <= 1);
  assert.ok(Math.abs(boundaries[3] - 12) <= 1);
});

/**
 * 作用：
 * 验证区域向量化会输出固定维度和合理占据率。
 *
 * 为什么这样写：
 * 原型模型直接吃这个向量。
 * 如果这里的采样逻辑漂掉，模型效果会大幅波动。
 *
 * 输入：
 * @param {object} 无 - 直接构造简单掩码和区域。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前输出特征值范围应在 0-1。
 * - 中间高亮区域应该带来非零占据率。
 */
test("vectorizeMaskRegion returns a fixed-size occupancy vector", () => {
  const width = 4;
  const mask = Uint8Array.from([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ]);
  const vector = vectorizeMaskRegion(
    mask,
    width,
    {
      minX: 0,
      maxX: 3,
      minY: 0,
      maxY: 3,
    },
    2,
    2
  );

  assert.equal(vector.length, 4);
  assert.ok(vector.every((value) => value >= 0 && value <= 1));
  assert.ok(vector.some((value) => value > 0));
});

/**
 * 作用：
 * 验证字符原型模型能按最近距离完成分类。
 *
 * 为什么这样写：
 * 第一版训练脚本的核心是假设“同字符向量会聚到一起”。
 * 这条测试锁住最小可用分类行为。
 *
 * 输入：
 * @param {object} 无 - 直接传入人工构造的字符向量样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证最近邻，不测试整串分割。
 * - 如果未来改成更复杂模型，这条测试需要同步调整。
 */
test("buildPrototypeModel and predictCharacterVector classify nearest vectors", () => {
  const model = buildPrototypeModel([
    { label: "A", vector: [1, 0, 0, 1] },
    { label: "A", vector: [0.9, 0.1, 0, 1] },
    { label: "B", vector: [0, 1, 1, 0] },
    { label: "B", vector: [0, 0.9, 1, 0.1] },
  ]);
  const prediction = predictCharacterVector([0.95, 0.05, 0, 1], model);

  assert.equal(prediction.label, "A");
  assert.ok(prediction.distance >= 0);
  assert.equal(prediction.topK[0].label, "A");
});

/**
 * 作用：
 * 验证衬线特征提取会输出稳定维度和范围。
 *
 * 为什么这样写：
 * 新版模型已经不再只靠 occupancy grid。
 * 这条测试锁住组合特征的基本契约，避免后续加特征时把值域或维度改坏。
 *
 * 输入：
 * @param {object} 无 - 直接构造一个简单的字符掩码区域。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前断言的是组合向量非空且所有值都非负。
 * - 这里也顺手验证边缘型 serif-sensitive 特征能产出辅助 metrics。
 */
test("extractGlyphFeatureVector returns weighted serif-sensitive features", () => {
  const width = 6;
  const mask = Uint8Array.from([
    0, 0, 1, 1, 0, 0,
    0, 1, 1, 1, 1, 0,
    0, 1, 1, 1, 1, 0,
    0, 1, 1, 1, 1, 0,
    0, 1, 1, 1, 1, 0,
    0, 0, 1, 1, 0, 0,
  ]);
  const feature = extractGlyphFeatureVector(
    mask,
    width,
    {
      minX: 1,
      maxX: 4,
      minY: 0,
      maxY: 5,
    },
    4,
    6
  );

  assert.ok(feature.vector.length > 40);
  assert.ok(feature.vector.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(feature.metrics.density > 0);
  assert.ok(feature.metrics.aspectRatio > 0);
});

/**
 * 作用：
 * 验证双分支分割会给出 4 段边界和质量分数。
 *
 * 为什么这样写：
 * 精度提升计划的关键之一就是让分割从“单一列投影”升级成可比较的多方案选择。
 * 这条测试锁住分割输出结构，后续 checker 才能拿质量门槛做刷新决策。
 *
 * 输入：
 * @param {object} 无 - 直接构造一个 4 段竖条字符掩码。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证结构和质量范围，不强求必须选中某一种方法。
 * - 返回边界必须始终是 5 个点，对应 4 个字符窗口。
 */
test("selectBestGlyphSegmentation returns four glyph windows with a quality score", () => {
  const width = 16;
  const height = 8;
  const mask = new Uint8Array(width * height);

  for (let y = 1; y <= 6; y += 1) {
    for (const [start, end] of [
      [1, 2],
      [5, 6],
      [9, 10],
      [13, 14],
    ]) {
      for (let x = start; x <= end; x += 1) {
        mask[y * width + x] = 1;
      }
    }
  }

  const bounds = {
    minX: 1,
    maxX: 14,
    minY: 1,
    maxY: 6,
  };
  const projection = Array.from({ length: 14 }, (_, index) => {
    const x = index + bounds.minX;
    let total = 0;

    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      total += mask[y * width + x];
    }

    return total;
  });
  const segmentation = selectBestGlyphSegmentation(mask, width, height, bounds, projection);

  assert.equal(segmentation.boundaries.length, 5);
  assert.ok(segmentation.segmentationQuality >= 0);
  assert.ok(segmentation.segmentationQuality <= 1);
  assert.ok(Array.isArray(segmentation.candidateScores));
  assert.ok(segmentation.candidateScores.length >= 2);
});

/**
 * 作用：
 * 验证代表性 exemplar 会控制数量并保持多样性。
 *
 * 为什么这样写：
 * 新版模型需要 position-aware exemplar，但又不能把所有样本都塞进模型 JSON。
 * 这条测试锁住“限量保留代表样本”的基本行为。
 *
 * 输入：
 * @param {object} 无 - 直接传入 3 个同标签样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前算法是确定性的 farthest-point 近似。
 * - 测试只验证数量和起始样本保留，不依赖完整挑选路径。
 */
test("selectRepresentativeExemplars keeps a bounded diverse subset", () => {
  const exemplars = selectRepresentativeExemplars(
    [
      { sampleId: "a", vector: [0, 0, 0, 0] },
      { sampleId: "b", vector: [1, 1, 1, 1] },
      { sampleId: "c", vector: [0.9, 0.9, 0.8, 0.8] },
    ],
    2
  );

  assert.equal(exemplars.length, 2);
  assert.equal(exemplars[0].sampleId, "a");
  assert.ok(exemplars.some((sample) => sample.sampleId === "b"));
});

/**
 * 作用：
 * 验证位置感知多原型会按位置和标签建索引。
 *
 * 为什么这样写：
 * 新分类器的核心就是 position-aware multi-prototype。
 * 如果这里的索引结构漂掉，后面的 top-k 和 checker 质量门槛都不可靠。
 *
 * 输入：
 * @param {object} 无 - 直接传入两个位置、两个标签的样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证结构，不要求聚类中心的精确数值。
 * - 每个 prototype 向量都必须保持原始维度。
 */
test("buildPositionAwarePrototypeIndex groups prototypes by position and label", () => {
  const index = buildPositionAwarePrototypeIndex(
    [
      { sampleId: "0:A:1", position: 0, label: "A", vector: [1, 0, 0, 1] },
      { sampleId: "0:A:2", position: 0, label: "A", vector: [0.9, 0.1, 0, 1] },
      { sampleId: "1:B:1", position: 1, label: "B", vector: [0, 1, 1, 0] },
      { sampleId: "1:B:2", position: 1, label: "B", vector: [0.1, 0.9, 1, 0] },
    ],
    2
  );

  assert.ok(Array.isArray(index["0"].A));
  assert.ok(Array.isArray(index["1"].B));
  assert.equal(index["0"].A[0].vector.length, 4);
});

/**
 * 作用：
 * 验证位置感知预测会返回 top-k 顺序。
 *
 * 为什么这样写：
 * 新版分类器不再只有单一均值 prototype。
 * 这条测试锁住 top-k 返回和位置感知优先级，后续 analyzer 和 live artifact 都依赖它。
 *
 * 输入：
 * @param {object} 无 - 直接传入带 position prototype / exemplar 的模型。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证位置 0 的预测结果。
 * - topK 第一名必须与最终 label 一致。
 */
test("predictCharacterVector uses position-aware prototypes and returns top-k", () => {
  const prediction = predictCharacterVector(
    [0.95, 0.05, 0, 1],
    {
      labels: ["A", "B"],
      prototypes: {
        A: { count: 2, vector: [0.9, 0.1, 0, 1] },
        B: { count: 2, vector: [0.1, 0.9, 1, 0] },
      },
      positionExemplars: {
        "0": {
          A: [{ sampleId: "a", vector: [1, 0, 0, 1] }],
          B: [{ sampleId: "b", vector: [0, 1, 1, 0] }],
        },
      },
      positionPrototypes: {
        "0": {
          A: [{ count: 2, vector: [0.92, 0.08, 0, 1] }],
          B: [{ count: 2, vector: [0.08, 0.92, 1, 0] }],
        },
      },
    },
    0,
    2
  );

  assert.equal(prediction.label, "A");
  assert.equal(prediction.topK.length, 2);
  assert.equal(prediction.topK[0].label, "A");
  assert.ok(prediction.topK[0].score <= prediction.topK[1].score);
});

/**
 * 作用：
 * 验证位置指标会按 4 位字符输出准确率。
 *
 * 为什么这样写：
 * 计划里明确要求新增 position metrics。
 * 这条测试锁住分析输出的结构，避免后续汇总格式漂掉。
 *
 * 输入：
 * @param {object} 无 - 直接传入两条预测结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前固定输出 4 个位置。
 * - 这里既覆盖全对也覆盖单字符错误。
 */
test("buildPositionMetrics computes per-position accuracy", () => {
  const metrics = buildPositionMetrics([
    {
      expectedText: "A8Bd",
      characters: ["A", "8", "B", "d"],
    },
    {
      expectedText: "Fpex",
      characters: ["F", "p", "e", "k"],
    },
  ]);

  assert.equal(metrics.length, 4);
  assert.equal(metrics[0].accuracy, 1);
  assert.equal(metrics[3].accuracy, 0.5);
});

/**
 * 作用：
 * 验证衬线 hard-case 混淆会单独聚合。
 *
 * 为什么这样写：
 * 这版计划的核心前提就是“captcha 看起来像衬线体英文”。
 * 所以分析输出里必须明确暴露这些 hard cases，而不是只看总 confusion。
 *
 * 输入：
 * @param {object} 无 - 直接传入几条大小写/符号混淆样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证 hard-case pair 被统计出来。
 * - 结构相近组和符号混淆都应命中。
 */
test("buildSerifConfusionSummary highlights serif-like hard cases", () => {
  const summary = buildSerifConfusionSummary([
    {
      expectedText: "C@t=",
      characters: ["c", "a", "t", "t"],
    },
    {
      expectedText: "P#K7",
      characters: ["p", "H", "k", "+"],
    },
  ]);

  assert.ok(summary.some((entry) => entry.pair === "C->c"));
  assert.ok(summary.some((entry) => entry.pair === "#->H"));
  assert.ok(summary.some((entry) => entry.pair === "7->+"));
});

/**
 * 作用：
 * 验证符号错误率会单独统计。
 *
 * 为什么这样写：
 * `@ # + =` 是这批 captcha 最难的一类。
 * 把符号错误率单独拉出来，后续才能判断新特征是否真的帮到了 hardest cases。
 *
 * 输入：
 * @param {object} 无 - 直接传入包含符号字符的预测结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只看期待字符是符号的位置。
 * - 无符号位点不会计入 total。
 */
test("buildSymbolErrorSummary isolates symbol-position errors", () => {
  const summary = buildSymbolErrorSummary([
    {
      expectedText: "A@B#",
      characters: ["A", "@", "B", "H"],
    },
    {
      expectedText: "C+=d",
      characters: ["C", "+", "t", "d"],
    },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.errors, 2);
  assert.equal(summary.errorRate, 0.5);
});

/**
 * 作用：
 * 验证 5 次尝试成功率估算会按单次 exact match 推导累计命中率。
 *
 * 为什么这样写：
 * 用户真正关心的是“5 次内通过率”，不是单次 exact match 本身。
 * 这条测试锁住新的离线代理指标，后续训练 summary 才有比较价值。
 *
 * 输入：
 * @param {object} 无 - 直接传入 3 条 holdout 预测。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证数值范围和关键计数。
 * - 精确值取决于当前独立近似公式。
 */
test("buildFiveAttemptSuccessEstimate summarizes single-attempt and five-attempt rates", () => {
  const estimate = buildFiveAttemptSuccessEstimate(
    [
      { exactMatch: true },
      { exactMatch: false },
      { exactMatch: false },
    ],
    5
  );

  assert.equal(estimate.sampleCount, 3);
  assert.equal(estimate.exactMatchCount, 1);
  assert.equal(estimate.singleAttemptExactMatchRate, 0.3333);
  assert.ok(estimate.estimatedSuccessWithinBudget > 0.8);
});

/**
 * 作用：
 * 验证本地训练参数解析会读取向量尺寸、聚类和 exemplar 配置。
 *
 * 为什么这样写：
 * 训练脚本会频繁重复运行，参数解析必须稳定。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只开放最小参数面。
 * - 未传参数时会走默认尺寸。
 */
test("parseLocalTrainArgs reads dataset and vector-size overrides", () => {
  const parsed = parseLocalTrainArgs([
    "node",
    "src/captcha-train-local.js",
    "--dataset",
    "data/captcha-images-current-labels.json",
    "--vector-width",
    "20",
    "--vector-height",
    "24",
    "--cluster-count",
    "4",
    "--exemplar-limit",
    "12",
  ]);

  assert.equal(parsed.datasetInput, "data/captcha-images-current-labels.json");
  assert.equal(parsed.vectorWidth, 20);
  assert.equal(parsed.vectorHeight, 24);
  assert.equal(parsed.clusterCount, 4);
  assert.equal(parsed.exemplarLimit, 12);
});
