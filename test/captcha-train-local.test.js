const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPrototypeModel,
  chooseGlyphBoundaries,
  computeOtsuThreshold,
  parseLocalTrainArgs,
  paethPredictor,
  predictCharacterVector,
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
});

/**
 * 作用：
 * 验证本地训练参数解析会读取向量尺寸和数据集覆盖项。
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
    "artifacts/captcha-images-current-labels.json",
    "--vector-width",
    "20",
    "--vector-height",
    "24",
  ]);

  assert.equal(parsed.datasetInput, "artifacts/captcha-images-current-labels.json");
  assert.equal(parsed.vectorWidth, 20);
  assert.equal(parsed.vectorHeight, 24);
});
