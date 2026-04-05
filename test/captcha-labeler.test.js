const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildLabelerHtml,
  extractDatasetTimestamp,
  findLatestDatasetDirectory,
  normalizeLabelText,
  parseLabelerArgs,
  readLabelEntries,
  resolveDefaultLabelManifestPath,
  resolveLabelManifestPath,
  summarizeLabelEntries,
  updateLabelEntries,
  writeLabelEntries,
} = require("../src/captcha-labeler");

/**
 * 作用：
 * 验证数据集目录名时间戳提取规则。
 *
 * 为什么这样写：
 * 标注器默认要自动挑选“最新一批数据”，这依赖目录名里的时间戳排序。
 * 测试要锁住当前命名约定，避免后续自动选择逻辑漂移。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例目录名。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 无法识别的目录名应保守返回 0。
 * - 这里只验证后缀时间戳，不验证目录前缀是否合法。
 */
test("extractDatasetTimestamp reads the numeric suffix from dataset names", () => {
  assert.equal(extractDatasetTimestamp("captcha-dataset-1775371792919"), 1775371792919);
  assert.equal(extractDatasetTimestamp("captcha-collection-1775371488682"), 1775371488682);
  assert.equal(extractDatasetTimestamp("invalid-name"), 0);
});

/**
 * 作用：
 * 验证标注器会优先选择最新的去重数据集目录。
 *
 * 为什么这样写：
 * 用户通常应该标注 `captcha-dataset-*` 而不是更原始的 `captcha-collection-*`。
 * 这条测试锁住优先级，防止工具误打开旧的未整理目录。
 *
 * 输入：
 * @param {object} 无 - 在临时 data 目录中构造多个候选数据集。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前优先 `captcha-dataset-*`。
 * - 如果没有 dataset，再回退到最新 collection。
 */
test("findLatestDatasetDirectory prefers the newest consolidated dataset", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-labeler-artifacts-"));

  fs.mkdirSync(path.join(tempDir, "captcha-collection-100"));
  fs.mkdirSync(path.join(tempDir, "captcha-dataset-200"));
  fs.mkdirSync(path.join(tempDir, "captcha-dataset-150"));

  assert.equal(
    findLatestDatasetDirectory(tempDir),
    path.join(tempDir, "captcha-dataset-200")
  );
});

/**
 * 作用：
 * 验证默认标注入口会优先选择当前总目录清单。
 *
 * 为什么这样写：
 * 用户已经把现有图片整理到了 `captcha-images-current`，因此无参数启动标注器时，
 * 默认目标应该是这份当前总清单，而不是旧的数据集目录。
 *
 * 输入：
 * @param {object} 无 - 在临时 data 目录中构造当前总清单和普通数据集。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 只有 data 当前总清单不存在时才回退到最新数据集。
 * - 这条规则直接影响 `npm run captcha:label` 的默认体验。
 */
test("resolveDefaultLabelManifestPath prefers the current consolidated label file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-labeler-default-"));
  const currentManifestPath = path.join(tempDir, "captcha-images-current-labels.json");
  const datasetDir = path.join(tempDir, "captcha-dataset-300");
  const datasetManifestPath = path.join(datasetDir, "labels.json");

  fs.mkdirSync(datasetDir);
  fs.writeFileSync(currentManifestPath, "[]\n");
  fs.writeFileSync(datasetManifestPath, "[]\n");

  assert.equal(resolveDefaultLabelManifestPath(tempDir), currentManifestPath);
});

/**
 * 作用：
 * 验证 manifest 路径解析既支持自动选择，也支持目录和文件两种输入。
 *
 * 为什么这样写：
 * 标注器命令的易用性高度依赖参数解析。
 * 这条测试锁住“默认选当前主清单、目录自动找 labels.json、文件路径直接使用”的契约。
 *
 * 输入：
 * @param {object} 无 - 在临时目录构造示例数据集和 manifest。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前路径解析使用进程工作目录，所以测试传绝对路径避免歧义。
 * - 找不到 labels.json 时应返回空字符串。
 */
test("resolveLabelManifestPath supports auto, directory, and direct file inputs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-labeler-manifest-"));
  const currentManifestPath = path.join(tempDir, "captcha-images-current-labels.json");
  const datasetDir = path.join(tempDir, "captcha-dataset-300");
  const manifestPath = path.join(datasetDir, "labels.json");

  fs.mkdirSync(datasetDir);
  fs.writeFileSync(currentManifestPath, "[]\n");
  fs.writeFileSync(manifestPath, "[]\n");

  assert.equal(resolveLabelManifestPath("", tempDir), currentManifestPath);
  assert.equal(resolveLabelManifestPath(datasetDir, tempDir), manifestPath);
  assert.equal(resolveLabelManifestPath(manifestPath, tempDir), manifestPath);
  assert.equal(resolveLabelManifestPath(path.join(tempDir, "missing"), tempDir), "");
});

/**
 * 作用：
 * 验证人工标注文本只去掉首尾空白，不删除中间符号。
 *
 * 为什么这样写：
 * 真实 captcha 可能包含 `@`、`+`、`=` 等符号，标注器不能像 OCR 清洗那样把它们删掉。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例标注文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 中间的符号和大小写必须原样保留。
 * - 空白清理仅限首尾。
 */
test("normalizeLabelText preserves symbol characters in human labels", () => {
  assert.equal(normalizeLabelText("  xw@C  "), "xw@C");
  assert.equal(normalizeLabelText(" +=Bb "), "+=Bb");
});

/**
 * 作用：
 * 验证标注摘要会正确给出进度和下一条未标注位置。
 *
 * 为什么这样写：
 * 标注器打开后应该自动跳到第一条未标注数据，而不是永远从头开始。
 * 测试要锁住这个推荐起点，减少标注过程中频繁手动跳转。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 已标注判定仅看 `expectedText` 是否非空。
 * - 全部完成时会回退到最后一条。
 */
test("summarizeLabelEntries reports progress and next unlabeled position", () => {
  const summary = summarizeLabelEntries([
    { id: "captcha-0001", expectedText: "A8Bd" },
    { id: "captcha-0002", expectedText: "" },
    { id: "captcha-0003", expectedText: "" },
  ]);

  assert.equal(summary.totalCount, 3);
  assert.equal(summary.labeledCount, 1);
  assert.equal(summary.unlabeledCount, 2);
  assert.equal(summary.nextUnlabeledIndex, 1);
});

/**
 * 作用：
 * 验证更新单条标注时会保留其它条目并写入更新时间。
 *
 * 为什么这样写：
 * 标注页每次保存只修改当前图片。
 * 这条测试锁住“只更新目标条目”的行为，避免一次保存把整份数据写乱。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例条目数组和更新内容。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 保存时要保留符号字符。
 * - 找不到目标条目时应抛错，而不是静默失败。
 */
test("updateLabelEntries updates only the targeted label entry", () => {
  const nextEntries = updateLabelEntries([
    { id: "captcha-0001", expectedText: "", notes: "" },
    { id: "captcha-0002", expectedText: "", notes: "" },
  ], "captcha-0002", {
    expectedText: " +=Bb ",
    notes: "symbol sample",
  });

  assert.equal(nextEntries[0].expectedText, "");
  assert.equal(nextEntries[1].expectedText, "+=Bb");
  assert.equal(nextEntries[1].notes, "symbol sample");
  assert.ok(nextEntries[1].updatedAt);
});

/**
 * 作用：
 * 验证标注文件读写契约保持稳定。
 *
 * 为什么这样写：
 * 标注器的核心就是频繁读写 `labels.json`。
 * 这条测试保证它写出的内容仍然可以被自己读回来。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入再读取示例条目。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前使用 JSON 数组结构。
 * - 写盘内容需要保持缩进格式，但测试只验证数据一致性。
 */
test("writeLabelEntries and readLabelEntries round-trip label manifests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-labeler-roundtrip-"));
  const manifestPath = path.join(tempDir, "labels.json");
  const entries = [
    { id: "captcha-0001", expectedText: "A8Bd", imagePath: "/tmp/captcha-0001.png" },
  ];

  writeLabelEntries(manifestPath, entries);

  assert.deepEqual(readLabelEntries(manifestPath), entries);
});

/**
 * 作用：
 * 验证标注器参数解析支持数据集路径、端口和禁用自动打开浏览器。
 *
 * 为什么这样写：
 * 这三个参数就是标注器当前最重要的外部控制面。
 * 测试锁住解析结果后，命令行用法会更稳定。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 argv。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 未传参数时会走默认值。
 * - `--no-open` 只改变自动打开行为，不影响服务本身。
 */
test("parseLabelerArgs reads dataset, port, and open-browser flags", () => {
  const parsed = parseLabelerArgs([
    "node",
    "src/captcha-labeler.js",
    "--dataset",
    "/tmp/captcha-dataset",
    "--port",
    "4321",
    "--no-open",
  ]);

  assert.equal(parsed.datasetInput, "/tmp/captcha-dataset");
  assert.equal(parsed.port, 4321);
  assert.equal(parsed.openBrowser, false);
});

/**
 * 作用：
 * 验证标注器页面 HTML 包含核心交互元素。
 *
 * 为什么这样写：
 * 这个工具没有独立前端构建流程，所以最容易退化的是页面骨架本身。
 * 用一条轻量测试锁住关键按钮和字段，能减少无意删改。
 *
 * 输入：
 * @param {object} 无 - 直接生成 HTML 文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证关键元素是否存在。
 * - 不做浏览器级 UI 测试。
 */
test("buildLabelerHtml includes the core image and save controls", () => {
  const html = buildLabelerHtml();

  assert.match(html, /Captcha Labeler/);
  assert.match(html, /id="captcha-image"/);
  assert.match(html, /id="expected-text"/);
  assert.match(html, /id="save-next-button"/);
});
