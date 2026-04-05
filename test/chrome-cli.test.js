const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCaptchaCollectionRunName,
  buildCaptchaCollectionSamplePrefix,
  buildCaptchaSignatureDigest,
  buildRefreshDiagnosticAttemptPrefix,
  buildRefreshDiagnosticRunName,
  createCaptchaCollectionRunContext,
  createRefreshDiagnosticRunContext,
  getCaptchaSnapshotSignature,
  hasCaptchaImageEvidence,
  hasFreshCaptchaSnapshot,
  hasUsableRefreshClickPoint,
  isChromeTabNotFoundError,
  sanitizeFileNamePart,
  saveCaptchaCollectionSample,
  saveRefreshDiagnosticSnapshotImages,
  selectPreferredCaptchaLabelSource,
  selectBestCaptchaSolverResult,
  isConfidentLocalModelAttempt,
  promoteSnapshotToPostCaptchaSelection,
  shouldRecheckPostSubmitState,
  summarizeSnapshotForRefreshDiagnostic,
  writeChromeStatusArtifact,
  writeCaptchaCollectionSummary,
  writeRefreshDiagnosticRecord,
  writeRefreshDiagnosticSummary,
  writeCaptchaCollectionManifest,
  writeCaptchaImageFile,
} = require("../src/chrome-cli");

/**
 * 作用：
 * 验证采集任务目录名会带上固定前缀和时间戳。
 *
 * 为什么这样写：
 * 采集结果需要按批次隔离保存，目录名规则一旦漂移，后续标注和训练脚本就很难稳定定位数据集。
 *
 * 输入：
 * @param {object} 无 - 直接调用目录名生成函数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只验证结构，不绑定具体时间戳值。
 * - 若未来要改目录前缀，测试和文档应同步更新。
 */
test("buildCaptchaCollectionRunName prefixes collection runs consistently", () => {
  const runName = buildCaptchaCollectionRunName();

  assert.match(runName, /^captcha-collection-\d+$/);
});

/**
 * 作用：
 * 验证刷新诊断任务目录名会带上固定前缀和时间戳。
 *
 * 为什么这样写：
 * Phase A 诊断产物需要与普通样本采集目录严格区分。
 * 这条测试可以防止目录命名回退成混淆用途的通用前缀。
 *
 * 输入：
 * @param {object} 无 - 直接调用目录名生成函数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只验证结构，不绑定具体时间戳值。
 * - 若后续重命名目录前缀，测试和文档都需要同步更新。
 */
test("buildRefreshDiagnosticRunName prefixes refresh diagnostics consistently", () => {
  const runName = buildRefreshDiagnosticRunName();

  assert.match(runName, /^captcha-refresh-diagnostic-\d+$/);
});

/**
 * 作用：
 * 验证样本前缀会采用 4 位补零编号。
 *
 * 为什么这样写：
 * 人工标注通常按顺序浏览样本，统一长度编号能避免文件排序错乱。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例序号。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前格式固定为 `sample-0001` 风格。
 * - 输入异常时也应回退到合法前缀。
 */
test("buildCaptchaCollectionSamplePrefix uses a zero-padded numbering scheme", () => {
  assert.equal(buildCaptchaCollectionSamplePrefix(1), "sample-0001");
  assert.equal(buildCaptchaCollectionSamplePrefix(23), "sample-0023");
});

/**
 * 作用：
 * 验证刷新诊断尝试前缀也采用固定补零编号。
 *
 * 为什么这样写：
 * 诊断模式每次尝试都会生成多份 JSON 和图片。
 * 统一编号规则能保证这些文件在目录里天然按时间顺序分组。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例尝试序号。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前格式固定为 `attempt-0001` 风格。
 * - 输入异常时也应回退到合法前缀。
 */
test("buildRefreshDiagnosticAttemptPrefix uses a zero-padded numbering scheme", () => {
  assert.equal(buildRefreshDiagnosticAttemptPrefix(1), "attempt-0001");
  assert.equal(buildRefreshDiagnosticAttemptPrefix(12), "attempt-0012");
});

/**
 * 作用：
 * 验证文件名清洗规则会移除非法字符并保留可读性。
 *
 * 为什么这样写：
 * 采集样本会把来源标签拼进文件名，若不先清洗，某些字符可能导致路径不稳定或难以读取。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例标签。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只验证 ASCII 文件名片段。
 * - 空结果必须回退到 `item`。
 */
test("sanitizeFileNamePart converts labels into safe file name fragments", () => {
  assert.equal(sanitizeFileNamePart("processed-threshold"), "processed-threshold");
  assert.equal(sanitizeFileNamePart("Raw Image Src"), "raw-image-src");
  assert.equal(sanitizeFileNamePart("###"), "item");
});

/**
 * 作用：
 * 验证标注底图优先选择原始验证码图像。
 *
 * 为什么这样写：
 * 人工标注应尽量对应用户真实看到的验证码，而不是仅基于处理后的阈值化版本。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例来源列表。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前优先级是 `raw-image-src` 高于其他来源。
 * - 无来源时应返回 null。
 */
test("selectPreferredCaptchaLabelSource prefers the raw captcha image", () => {
  assert.deepEqual(
    selectPreferredCaptchaLabelSource([
      { label: "processed-threshold", dataUrl: "data:image/png;base64,BBBB" },
      { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" },
    ]),
    { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" }
  );
  assert.equal(selectPreferredCaptchaLabelSource([]), null);
});

/**
 * 作用：
 * 验证验证码签名优先基于原始标注底图来源生成。
 *
 * 为什么这样写：
 * 去重逻辑依赖签名比较，如果签名来源选错，就可能把同一张图误判成新样本，或者把新样本误判成重复图。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例页面快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前优先选择 `raw-image-src`。
 * - 无可用来源时应返回空字符串。
 */
test("getCaptchaSnapshotSignature prefers the raw captcha source for deduplication", () => {
  assert.equal(
    getCaptchaSnapshotSignature({
      captchaDataUrl: "data:image/png;base64,LEGACY",
      captchaDataVariants: [
        { label: "processed-threshold", dataUrl: "data:image/png;base64,BBBB" },
        { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" },
      ],
    }),
    "data:image/png;base64,AAAA"
  );
  assert.equal(getCaptchaSnapshotSignature({}), "");
});

/**
 * 作用：
 * 验证验证码签名摘要会稳定压缩为固定长度哈希。
 *
 * 为什么这样写：
 * 采集 manifest 现在要记录去重证据，但不能把整段 data URL 原样塞进去。
 * 这条测试锁住“相同签名得到相同摘要、空签名得到空值”的批次追踪契约。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例验证码签名。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前摘要算法为 SHA-1。
 * - 如果未来切换算法，测试和文档必须同步更新。
 */
test("buildCaptchaSignatureDigest compresses captcha signatures into stable hashes", () => {
  const digest = buildCaptchaSignatureDigest("data:image/png;base64,AAAA");

  assert.match(digest, /^[a-f0-9]{40}$/);
  assert.equal(digest, buildCaptchaSignatureDigest("data:image/png;base64,AAAA"));
  assert.equal(buildCaptchaSignatureDigest(""), "");
});

/**
 * 作用：
 * 验证采集循环只会把真正换过图的 captcha 视为新样本。
 *
 * 为什么这样写：
 * 刚才 live 采集暴露出一个关键问题：即便刷新后图片没变，旧逻辑下一轮仍可能继续保存重复样本。
 * 这条测试要锁住“签名未变化就不允许保存”的规则。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例签名和快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 首张样本没有上一张签名时应允许保存。
 * - 当前签名为空时必须保守返回 false。
 */
test("hasFreshCaptchaSnapshot rejects duplicate captcha signatures", () => {
  assert.equal(
    hasFreshCaptchaSnapshot("", {
      captchaDataVariants: [
        { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" },
      ],
    }),
    true
  );
  assert.equal(
    hasFreshCaptchaSnapshot("data:image/png;base64,AAAA", {
      captchaDataVariants: [
        { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" },
      ],
    }),
    false
  );
  assert.equal(
    hasFreshCaptchaSnapshot("data:image/png;base64,AAAA", {
      captchaDataVariants: [
        { label: "raw-image-src", dataUrl: "data:image/png;base64,BBBB" },
      ],
    }),
    true
  );
  assert.equal(hasFreshCaptchaSnapshot("data:image/png;base64,AAAA", {}), false);
});

/**
 * 作用：
 * 验证真实刷新 fallback 只会接受完整的屏幕点击坐标。
 *
 * 为什么这样写：
 * 真实鼠标点击会直接发到系统层，测试需要锁住“没有合法 x/y 就不能点”的规则，
 * 避免把空坐标交给 Accessibility 点击链路。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例刷新目标。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只校验 clickPoint.x 和 clickPoint.y。
 * - 其他调试字段不会影响结果。
 */
test("hasUsableRefreshClickPoint only accepts refresh targets with numeric coordinates", () => {
  assert.equal(
    hasUsableRefreshClickPoint({
      clickPoint: { x: 120, y: 240 },
    }),
    true
  );
  assert.equal(
    hasUsableRefreshClickPoint({
      clickPoint: { x: "120", y: 240.5 },
    }),
    true
  );
  assert.equal(hasUsableRefreshClickPoint({ clickPoint: { x: null, y: 240 } }), false);
  assert.equal(hasUsableRefreshClickPoint({}), false);
});

/**
 * 作用：
 * 验证验证码图像证据判断会同时识别主图和变体图。
 *
 * 为什么这样写：
 * 提交后的保护逻辑要先判断“当前还有没有 captcha 可解”。
 * 只有图像和输入框都消失时，CLI 才应该优先重看是否已经过页。
 *
 * 输入：
 * @param {object} 无 - 直接传入不同形态的页面快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 主图和变体任一存在都应返回 true。
 * - 二者都为空时才应返回 false。
 */
test("hasCaptchaImageEvidence accepts both primary and variant captcha sources", () => {
  assert.equal(hasCaptchaImageEvidence({ captchaDataUrl: "data:image/png;base64,AAAA" }), true);
  assert.equal(
    hasCaptchaImageEvidence({
      captchaDataVariants: [{ label: "processed-threshold", dataUrl: "data:image/png;base64,BBBB" }],
    }),
    true
  );
  assert.equal(hasCaptchaImageEvidence({ captchaDataUrl: "", captchaDataVariants: [] }), false);
});

/**
 * 作用：
 * 验证提交后的过页保护会拦住“captcha UI 已消失但 reason 还没更新”的状态。
 *
 * 为什么这样写：
 * 用户已经在 live 页面上看到下一页时，CLI 仍可能短暂拿到旧的 `captcha_step`。
 * 这条测试锁住新的保护条件，避免此时继续刷新验证码打断已经成功的过页。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例页面快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 只有在 `captcha_step` 且无输入框、无图像证据时才应返回 true。
 * - 仍有 captcha 输入框或图像时不能误判成过页保护状态。
 */
test("shouldRecheckPostSubmitState detects captcha-step snapshots with no remaining captcha UI", () => {
  assert.equal(
    shouldRecheckPostSubmitState({
      isCaptchaStep: true,
      captchaPresent: false,
      captchaDataUrl: "",
      captchaDataVariants: [],
    }),
    true
  );
  assert.equal(
    shouldRecheckPostSubmitState({
      isCaptchaStep: true,
      captchaPresent: true,
      captchaDataUrl: "",
      captchaDataVariants: [],
    }),
    false
  );
  assert.equal(
    shouldRecheckPostSubmitState({
      isCaptchaStep: true,
      captchaPresent: false,
      captchaDataUrl: "data:image/png;base64,AAAA",
      captchaDataVariants: [],
    }),
    false
  );
});

/**
 * 作用：
 * 验证“captcha UI 已消失”的过渡状态会被强制提升为选择页。
 *
 * 为什么这样写：
 * 这是用户刚刚明确要求锁死的新规则。
 * 一旦 CLI 进入这条分支，就不能再继续刷新 captcha，而要直接进入 post-captcha 逻辑。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 captcha 过渡快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只提升到 `selection_step`，不伪造最终可用性结果。
 * - captcha 图像和输入框状态应一并清空，防止主流程重新回到 captcha 分支。
 */
test("promoteSnapshotToPostCaptchaSelection converts the captcha transition state into selection_step", () => {
  const promoted = promoteSnapshotToPostCaptchaSelection(
    {
      reason: "captcha_step",
      isCaptchaStep: true,
      captchaPresent: false,
      captchaFilled: false,
      captchaDataUrl: "",
      captchaDataVariants: [],
      pageUrl: "https://secure.e-konsulat.gov.pl/example",
    },
    "empty-candidate-recheck"
  );

  assert.equal(promoted.reason, "selection_step");
  assert.equal(promoted.isCaptchaStep, false);
  assert.equal(promoted.captchaPresent, false);
  assert.equal(promoted.captchaDataUrl, "");
  assert.deepEqual(promoted.captchaDataVariants, []);
  assert.equal(promoted.postCaptchaTransitionSource, "empty-candidate-recheck");
});

/**
 * 作用：
 * 验证本地模型平均距离门槛会筛出更可信的 live captcha 结果。
 *
 * 为什么这样写：
 * 本地原型模型总能输出 4 位文本。
 * 如果不加门槛，checker 会把明显不靠谱的预测也直接提交出去。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例本地模型结果和配置。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前默认阈值来自现有验证集距离分布。
 * - 后续若调阈值，需要同步更新这条测试。
 */
test("isConfidentLocalModelAttempt accepts only low-distance local model guesses", () => {
  assert.equal(
    isConfidentLocalModelAttempt(
      {
        candidate: "A8Bd",
        averageDistance: 31.5,
      },
      {
        localCaptchaModelMaxAverageDistance: 50,
      }
    ),
    true
  );
  assert.equal(
    isConfidentLocalModelAttempt(
      {
        candidate: "A8Bd",
        averageDistance: 54.2,
      },
      {
        localCaptchaModelMaxAverageDistance: 50,
      }
    ),
    false
  );
});

/**
 * 作用：
 * 验证验证码选择器会优先采用高置信本地模型结果。
 *
 * 为什么这样写：
 * 这次改动的目标就是先把新训练出来的模型接到 checker 上。
 * 测试需要锁住“模型足够稳时由它优先提交”的策略。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例本地模型尝试结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前优先级是“高置信本地模型”高于其他本地模型结果。
 * - 返回值里的 attempts 现在只包含本地模型尝试。
 */
test("selectBestCaptchaSolverResult prefers a confident local model attempt", () => {
  const result = selectBestCaptchaSolverResult(
    [
      {
        engine: "local-model",
        candidate: "A8Bd",
        averageDistance: 29.1,
        isConfident: true,
      },
    ],
    {
      localCaptchaModelMaxAverageDistance: 50,
    }
  );

  assert.equal(result.captchaText, "A8Bd");
  assert.equal(result.winningAttempt.engine, "local-model");
  assert.equal(result.attempts.length, 1);
});

/**
 * 作用：
 * 验证当没有高置信本地模型结果时，会退回到距离最低的本地模型猜测。
 *
 * 为什么这样写：
 * 用户已经要求移除 Tesseract。
 * 这条测试锁住新的 live checker 策略，避免后续又悄悄把 OCR 回退带回来。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例本地模型尝试结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前即使都不达标，也会提交距离最低的本地模型结果。
 * - 该策略依赖多轮重试来弥补单轮错误。
 */
test("selectBestCaptchaSolverResult falls back to the lowest-distance local model attempt", () => {
  const result = selectBestCaptchaSolverResult(
    [
      {
        engine: "local-model",
        candidate: "A8Bd",
        averageDistance: 46.2,
        isConfident: false,
      },
      {
        engine: "local-model",
        candidate: "Qm9=",
        averageDistance: 52.4,
        isConfident: false,
      },
    ],
    {
      localCaptchaModelMaxAverageDistance: 50,
    }
  );

  assert.equal(result.captchaText, "A8Bd");
  assert.equal(result.winningAttempt.engine, "local-model");
});

/**
 * 作用：
 * 验证 Chrome 标签页丢失错误会被识别为可恢复异常。
 *
 * 为什么这样写：
 * 真实采集时标签页偶发丢失会导致整批任务中断，测试需要锁住这类错误的识别逻辑，
 * 这样采集流程才能自动重开页面继续跑。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例错误对象。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只识别已知错误文案。
 * - 其他错误不应被误判成可恢复。
 */
test("isChromeTabNotFoundError matches the recoverable missing-tab failure", () => {
  assert.equal(
    isChromeTabNotFoundError(new Error("Poland visa Chrome tab not found.")),
    true
  );
  assert.equal(
    isChromeTabNotFoundError(new Error("Permission denied")),
    false
  );
});

/**
 * 作用：
 * 验证采集任务目录上下文会创建实际目录并给出 manifest 路径。
 *
 * 为什么这样写：
 * 采集模式依赖目录和 manifest 协同工作，这个测试能锁住目录创建行为，避免运行时才发现路径没建好。
 *
 * 输入：
 * @param {object} 无 - 直接在临时目录下创建采集上下文。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 测试使用系统临时目录，避免污染仓库。
 * - 这里只验证路径结构，不验证 manifest 内容。
 */
test("createCaptchaCollectionRunContext creates an isolated run directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-captcha-run-"));
  const context = createCaptchaCollectionRunContext(tempDir);

  assert.match(context.runName, /^captcha-collection-\d+$/);
  assert.equal(fs.existsSync(context.runDir), true);
  assert.equal(path.dirname(context.manifestPath), context.runDir);
  assert.equal(path.dirname(context.summaryPath), context.runDir);
});

/**
 * 作用：
 * 验证刷新诊断上下文会创建实际目录并给出 summary 路径。
 *
 * 为什么这样写：
 * 诊断模式的关键产物是 per-attempt JSON 和总览 summary。
 * 如果目录或 summary 路径契约漂移，后续分析脚本就无法稳定消费。
 *
 * 输入：
 * @param {object} 无 - 直接在临时目录下创建诊断上下文。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 测试使用系统临时目录，避免污染仓库。
 * - 这里只验证路径结构，不验证实际摘要内容。
 */
test("createRefreshDiagnosticRunContext creates an isolated diagnostic directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-refresh-diagnostic-"));
  const context = createRefreshDiagnosticRunContext(tempDir);

  assert.match(context.runName, /^captcha-refresh-diagnostic-\d+$/);
  assert.equal(fs.existsSync(context.runDir), true);
  assert.equal(path.dirname(context.summaryPath), context.runDir);
});

/**
 * 作用：
 * 验证采集样本保存后会生成可标注的 manifest 条目。
 *
 * 为什么这样写：
 * 这是采集模式的核心数据契约；如果条目结构不稳定，后续标注和训练流程都会被卡住。
 *
 * 输入：
 * @param {object} 无 - 使用示例 data URL 和页面快照构造样本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 需要同时验证 labelImagePath 和 variantImages。
 * - 当前优先把 `raw-image-src` 作为标注底图。
 */
test("saveCaptchaCollectionSample writes variant files and returns a labeling entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-captcha-sample-"));
  const entry = saveCaptchaCollectionSample(tempDir, 3, {
    pageUrl: "https://secure.e-konsulat.gov.pl/example",
    captchaDataUrl: "data:image/png;base64,QUJD",
    captchaDataVariants: [
      { label: "raw-image-src", dataUrl: "data:image/png;base64,QUJD" },
      { label: "processed-threshold", dataUrl: "data:image/png;base64,REVG" },
    ],
  }, {
    refreshMethod: "dom_refresh",
    refreshRecordPath: "/tmp/example-refresh.json",
    refreshContext: "post_save_refresh",
  });

  assert.equal(entry.id, "sample-0003");
  assert.equal(entry.expectedText, "");
  assert.equal(entry.signatureHash, buildCaptchaSignatureDigest("data:image/png;base64,QUJD"));
  assert.equal(entry.labelImageLabel, "raw-image-src");
  assert.equal(entry.refreshMethod, "dom_refresh");
  assert.equal(entry.refreshRecordPath, "/tmp/example-refresh.json");
  assert.equal(entry.refreshContext, "post_save_refresh");
  assert.equal(entry.variantCount, 2);
  assert.deepEqual(entry.variantLabels, ["raw-image-src", "processed-threshold"]);
  assert.equal(entry.variantImages.length, 2);
  assert.match(entry.labelImagePath, /sample-0003-raw-image-src\.png$/);
  assert.equal(fs.existsSync(entry.labelImagePath), true);
});

/**
 * 作用：
 * 验证刷新诊断快照会保存所有可用的验证码图片版本。
 *
 * 为什么这样写：
 * Phase A 分析的重点是比对刷新前后到底换了哪一张图。
 * 这条测试能锁住诊断模式的图片落盘规则，避免后续只保存 JSON 而丢失核心视觉证据。
 *
 * 输入：
 * @param {object} 无 - 使用示例 data URL 和页面快照构造诊断图片集。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前应至少保存原始图和处理图。
 * - 文件名要带上传入的诊断前缀。
 */
test("saveRefreshDiagnosticSnapshotImages writes variant files for diagnostic comparison", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-refresh-images-"));
  const images = saveRefreshDiagnosticSnapshotImages(tempDir, "attempt-0001-before", {
    captchaDataUrl: "data:image/png;base64,QUJD",
    captchaDataVariants: [
      { label: "raw-image-src", dataUrl: "data:image/png;base64,QUJD" },
      { label: "processed-threshold", dataUrl: "data:image/png;base64,REVG" },
    ],
  });

  assert.equal(images.length, 2);
  assert.match(images[0].path, /attempt-0001-before-/);
  assert.equal(fs.existsSync(images[0].path), true);
});

/**
 * 作用：
 * 验证采集 manifest 会被完整写成 JSON 文件。
 *
 * 为什么这样写：
 * 采集任务中途也会不断刷新 manifest，写盘格式必须稳定，后续标注脚本才能直接读取。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入示例 manifest。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前 manifest 使用 JSON 数组结构。
 * - 文件内容应可被 JSON.parse 正常读取。
 */
test("writeCaptchaCollectionManifest persists labeling entries as JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-captcha-manifest-"));
  const manifestPath = path.join(tempDir, "labels.json");
  const entries = [
    {
      id: "sample-0001",
      expectedText: "",
    },
  ];

  writeCaptchaCollectionManifest(manifestPath, entries);

  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), entries);
});

/**
 * 作用：
 * 验证采集批次摘要会写成稳定 JSON 文件。
 *
 * 为什么这样写：
 * Phase A 现在不仅要采图，还要快速判断这批数据是否值得标注。
 * 这条测试锁住批次 summary 的写盘契约，方便后续脚本直接读取整体质量指标。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入示例采集摘要。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前摘要使用 JSON 对象结构。
 * - 文件内容应可被 JSON.parse 正常读取。
 */
test("writeCaptchaCollectionSummary persists batch-level collection stats as JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-captcha-summary-"));
  const summaryPath = path.join(tempDir, "summary.json");
  const summary = {
    runName: "captcha-collection-1",
    savedCount: 3,
    uniqueSignatureCount: 3,
  };

  writeCaptchaCollectionSummary(summaryPath, summary);

  assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, "utf8")), summary);
});

/**
 * 作用：
 * 验证 post-captcha 页面证据会被写成独立 JSON 文件。
 *
 * 为什么这样写：
 * 现在最大的排障点是验证码之后的下拉页。
 * 这条测试锁住 artifact 写盘契约，避免后续排查时丢失关键快照和选择动作结果。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入示例状态快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 文件名应带上阶段标签。
 * - 内容必须保留 snapshot 和 extra 两层。
 */
test("writeChromeStatusArtifact persists a post-captcha debug snapshot", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-status-artifact-"));
  const outputPath = writeChromeStatusArtifact(
    tempDir,
    "post-captcha-after-selection",
    {
      reason: "selection_step",
      pageUrl: "https://secure.e-konsulat.gov.pl/example",
      selectionDiagnostics: {
        service: {
          found: true,
          controlType: "custom_select",
        },
      },
    },
    {
      selectionResults: {
        service: {
          changed: true,
        },
      },
    }
  );

  const payload = JSON.parse(fs.readFileSync(outputPath, "utf8"));

  assert.match(path.basename(outputPath), /post-captcha-after-selection/);
  assert.equal(payload.snapshot.reason, "selection_step");
  assert.equal(payload.extra.selectionResults.service.changed, true);
});

/**
 * 作用：
 * 验证刷新诊断快照摘要会提取关键页面状态而不是整份 base64 数据。
 *
 * 为什么这样写：
 * 诊断 JSON 需要足够轻，才能快速比对每次尝试的差异。
 * 这条测试锁住“保留签名和按钮文本，丢弃大体积图片内容”的摘要策略。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例页面快照。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前摘要应包含签名和按钮文本。
 * - 不应把原始 captchaDataUrl 原样放进摘要对象。
 */
test("summarizeSnapshotForRefreshDiagnostic keeps refresh evidence compact", () => {
  const summary = summarizeSnapshotForRefreshDiagnostic({
    reason: "captcha_step",
    pageUrl: "https://secure.e-konsulat.gov.pl/example",
    title: "Example",
    isCaptchaStep: true,
    captchaPresent: true,
    captchaFilled: false,
    likelyCaptchaError: false,
    buttonTexts: ["Odśwież", "Dalej"],
    inputHints: [{ ariaLabel: "Znaki z obrazka" }],
    captchaDataVariants: [
      { label: "raw-image-src", dataUrl: "data:image/png;base64,AAAA" },
    ],
  });

  assert.equal(summary.reason, "captcha_step");
  assert.equal(summary.signature, "data:image/png;base64,AAAA");
  assert.deepEqual(summary.buttonTexts, ["Odśwież", "Dalej"]);
  assert.equal(Object.hasOwn(summary, "captchaDataUrl"), false);
});

/**
 * 作用：
 * 验证刷新诊断单次记录会被完整写成 JSON 文件。
 *
 * 为什么这样写：
 * Phase A 后续要靠这些 per-attempt 记录回放刷新行为。
 * 如果写盘格式不稳定，诊断模式就无法形成可分析证据链。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入示例诊断记录。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前文件名应跟尝试序号绑定。
 * - 文件内容应可被 JSON.parse 正常读取。
 */
test("writeRefreshDiagnosticRecord persists one refresh attempt as JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-refresh-record-"));
  const record = {
    attemptIndex: 2,
    method: "dom_refresh",
  };
  const outputPath = writeRefreshDiagnosticRecord(tempDir, 2, record);

  assert.match(outputPath, /attempt-0002\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), record);
});

/**
 * 作用：
 * 验证刷新诊断批次摘要会被写成稳定 JSON。
 *
 * 为什么这样写：
 * 用户查看 Phase A 结果时最先接触的是 summary 文件。
 * 测试锁住写盘契约后，CLI 和后续分析脚本都能稳定读取同一份摘要。
 *
 * 输入：
 * @param {object} 无 - 在临时目录写入示例摘要。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前摘要使用 JSON 对象结构。
 * - 文件内容应可被 JSON.parse 正常读取。
 */
test("writeRefreshDiagnosticSummary persists the batch summary as JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poland-refresh-summary-"));
  const summaryPath = path.join(tempDir, "summary.json");
  const summary = {
    runName: "captcha-refresh-diagnostic-1",
    changedCount: 1,
  };

  writeRefreshDiagnosticSummary(summaryPath, summary);

  assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, "utf8")), summary);
});
