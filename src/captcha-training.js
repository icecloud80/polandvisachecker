const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const {
  readLabelEntries,
  resolveLabelManifestPath,
} = require("./captcha-labeler");
const { getArtifactsDir, getCurrentTrainingDir, getDataDir } = require("./project-paths");

/**
 * 作用：
 * 对人工标注文本做训练前归一化。
 *
 * 为什么这样写：
 * 训练集标签必须保持稳定格式，否则同一答案可能因为首尾空白被误判成不同类别。
 *
 * 输入：
 * @param {string} value - 原始人工标注文本。
 *
 * 输出：
 * @returns {string} 归一化后的标签文本。
 *
 * 注意：
 * - 当前只去掉首尾空白，不改变中间符号和大小写。
 * - 这里假设人工已经确认标签，因此不会套用 OCR 清洗规则。
 */
function normalizeTrainingLabel(value) {
  return String(value || "").trim();
}

/**
 * 作用：
 * 在同步代码路径里做一个很短的阻塞等待。
 *
 * 为什么这样写：
 * 训练目录重建时，macOS 偶发会在刚删除目录后仍短暂占用目录句柄。
 * 这里提供一个极短的同步等待，便于 `rmSync` 重试时给文件系统一点释放时间。
 *
 * 输入：
 * @param {number} milliseconds - 需要等待的毫秒数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只用于本地 CLI 的极短重试，不适合长时间阻塞。
 * - 毫秒数会被规范为非负整数。
 */
function sleepSync(milliseconds) {
  const duration = Math.max(0, Math.round(Number(milliseconds || 0)));

  if (duration <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

/**
 * 作用：
 * 判断目录删除失败是否属于可重试的临时文件系统错误。
 *
 * 为什么这样写：
 * 训练目录重建在 macOS 上真实遇到过 `ENOTEMPTY`。
 * 把可重试判断独立出来后，重试逻辑和测试都更清晰，也便于以后补充 `EBUSY`、`EPERM` 一类问题。
 *
 * 输入：
 * @param {Error} error - 目录删除失败时抛出的错误对象。
 *
 * 输出：
 * @returns {boolean} 是否值得短暂等待后重试。
 *
 * 注意：
 * - 当前只对已知的临时目录状态错误开放重试。
 * - 未知错误会立即向上抛出，避免吞掉真正的问题。
 */
function isRetryableDirectoryRemovalError(error) {
  const code = String((error && error.code) || "");

  return code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
}

/**
 * 作用：
 * 稳健地清空训练输出目录，并在需要时做短暂重试。
 *
 * 为什么这样写：
 * `captcha:prepare-train` 和 `captcha:train-local` 都会重建 `data/captcha-training-current`。
 * 真实运行里目录删除偶发会碰到 `ENOTEMPTY`，这里集中处理后，训练流程就不会因为瞬时文件系统状态而失败。
 *
 * 输入：
 * @param {string} directoryPath - 需要清空的目录路径。
 * @param {object} options - 重试配置。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前默认重试 5 次、每次等待 30ms。
 * - 最后一次仍失败时，会把原始错误直接抛出。
 */
function removeDirectoryWithRetries(directoryPath, options = {}) {
  const retries = Math.max(1, Math.round(Number(options.retries || 5)));
  const retryDelayMs = Math.max(0, Math.round(Number(options.retryDelayMs || 30)));
  const resolvedDirectoryPath = path.resolve(directoryPath);

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      fs.rmSync(resolvedDirectoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableDirectoryRemovalError(error) || attempt === retries - 1) {
        throw error;
      }

      sleepSync(retryDelayMs);
    }
  }
}

/**
 * 作用：
 * 检查当前标注清单是否满足训练数据的最低要求。
 *
 * 为什么这样写：
 * 训练前如果不先把空标签、非 4 位标签和缺图问题挡住，后面的导出结果会夹杂脏数据。
 *
 * 输入：
 * @param {Array<object>} entries - 标注条目数组。
 *
 * 输出：
 * @returns {Array<object>} 无效条目问题列表。
 *
 * 注意：
 * - 当前把“非空且长度为 4”作为最基本训练约束。
 * - 如果未来支持不同长度验证码，需要同步修改这里和测试。
 */
function validateTrainingEntries(entries) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const issues = [];

  for (const entry of normalizedEntries) {
    const entryId = String((entry && entry.id) || "");
    const labelText = normalizeTrainingLabel(entry && entry.expectedText);
    const imagePath = String((entry && entry.imagePath) || "");

    if (!labelText) {
      issues.push({
        id: entryId,
        problem: "missing_label",
      });
    } else if (labelText.length !== 4) {
      issues.push({
        id: entryId,
        problem: "label_length_not_4",
        labelText,
      });
    }

    if (!imagePath || !fs.existsSync(imagePath)) {
      issues.push({
        id: entryId,
        problem: "missing_image",
        imagePath,
      });
    }
  }

  return issues;
}

/**
 * 作用：
 * 为单条验证码样本分配稳定的数据集 split。
 *
 * 为什么这样写：
 * 训练、验证、测试集需要在多次重建时保持一致。
 * 用样本 ID 的哈希做确定性切分后，后续补文档或重导出都不会打乱划分。
 *
 * 输入：
 * @param {string} stableId - 样本稳定标识，一般使用 captcha ID。
 *
 * 输出：
 * @returns {string} `train`、`val` 或 `test`。
 *
 * 注意：
 * - 当前比例固定为 80% / 10% / 10%。
 * - 如果后续要改比例，需要同步更新测试和 summary 说明。
 */
function assignTrainingSplit(stableId) {
  const digest = crypto
    .createHash("sha1")
    .update(String(stableId || ""))
    .digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;

  if (bucket < 80) {
    return "train";
  }

  if (bucket < 90) {
    return "val";
  }

  return "test";
}

/**
 * 作用：
 * 统计训练标签中的字符频次。
 *
 * 为什么这样写：
 * 这批验证码包含符号字符，训练前先看字符覆盖情况可以帮助判断样本分布是否偏斜。
 *
 * 输入：
 * @param {Array<object>} entries - 标注条目数组。
 *
 * 输出：
 * @returns {object} 字符到出现次数的映射。
 *
 * 注意：
 * - 统计的是人工确认后的 `expectedText`。
 * - 返回对象按字符排序后再写盘，方便人工查看。
 */
function countCharacterFrequency(entries) {
  const frequencies = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const labelText = normalizeTrainingLabel(entry && entry.expectedText);

    for (const character of labelText) {
      frequencies.set(character, (frequencies.get(character) || 0) + 1);
    }
  }

  return Object.fromEntries(
    Array.from(frequencies.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}

/**
 * 作用：
 * 统计已有 OCR 建议相对于人工标签的基线表现。
 *
 * 为什么这样写：
 * 这批数据已经完成人工标注，顺手做一份 OCR 建议基线可以帮助判断后续小模型是否值得投入。
 *
 * 输入：
 * @param {Array<object>} entries - 标注条目数组。
 *
 * 输出：
 * @returns {object} OCR 建议覆盖率和精度摘要。
 *
 * 注意：
 * - 当前只评估 manifest 中已经存在的 `ocrText`，不会重新跑 OCR。
 * - `exactMatchRate` 只在有 OCR 建议的子集上计算。
 */
function summarizeOcrBaseline(entries) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const suggestedEntries = normalizedEntries.filter((entry) =>
    normalizeTrainingLabel(entry && entry.ocrText)
  );
  const exactMatchCount = suggestedEntries.filter(
    (entry) => normalizeTrainingLabel(entry.ocrText) === normalizeTrainingLabel(entry.expectedText)
  ).length;

  return {
    totalCount: normalizedEntries.length,
    suggestedCount: suggestedEntries.length,
    missingSuggestionCount: normalizedEntries.length - suggestedEntries.length,
    exactMatchCount,
    exactMatchRate:
      suggestedEntries.length > 0
        ? Number((exactMatchCount / suggestedEntries.length).toFixed(4))
        : 0,
    coverageRate:
      normalizedEntries.length > 0
        ? Number((suggestedEntries.length / normalizedEntries.length).toFixed(4))
        : 0,
  };
}

/**
 * 作用：
 * 为训练导出构造单条标准记录。
 *
 * 为什么这样写：
 * 训练导出文件只需要稳定的相对图片路径、标签和 split，不需要带上全部标注页元数据。
 *
 * 输入：
 * @param {object} entry - 原始标注条目。
 * @param {string} relativeImagePath - 导出目录内的相对图片路径。
 *
 * 输出：
 * @returns {object} 训练记录对象。
 *
 * 注意：
 * - `text` 使用人工确认标签。
 * - `split` 由稳定哈希决定，避免重复导出时漂移。
 */
function buildTrainingRecord(entry, relativeImagePath) {
  return {
    id: String((entry && entry.id) || ""),
    text: normalizeTrainingLabel(entry && entry.expectedText),
    image: String(relativeImagePath || ""),
    split: assignTrainingSplit((entry && entry.id) || ""),
    sha1: String((entry && entry.sha1) || ""),
  };
}

/**
 * 作用：
 * 以 JSON Lines 形式写出训练记录。
 *
 * 为什么这样写：
 * JSONL 适合后续被 Node、Python 或训练脚本逐行读取，也比单一巨大 JSON 更适合流式处理。
 *
 * 输入：
 * @param {string} outputPath - 目标文件路径。
 * @param {Array<object>} records - 训练记录数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 会覆盖已有文件。
 * - 每条记录单独占一行，便于后续快速过滤。
 */
function writeJsonLines(outputPath, records) {
  const lines = (Array.isArray(records) ? records : []).map((record) => JSON.stringify(record));
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
}

/**
 * 作用：
 * 创建并写出当前训练就绪数据集目录。
 *
 * 为什么这样写：
 * 标注完成后最需要的是一个可直接被训练脚本消费的标准目录，而不是继续从标注格式里临时转换。
 *
 * 输入：
 * @param {string} manifestPath - 完整标注文件路径。
 * @param {string} outputDir - 训练导出目录。
 *
 * 输出：
 * @returns {object} 导出摘要对象。
 *
 * 注意：
 * - 当前会复制图片到训练目录，避免后续训练依赖原始标注目录结构。
 * - 如果存在脏数据，会直接抛错，不生成半成品训练集。
 */
function prepareTrainingDataset(manifestPath, outputDir) {
  const entries = readLabelEntries(manifestPath);
  const issues = validateTrainingEntries(entries);

  if (issues.length > 0) {
    const preview = issues.slice(0, 10);
    throw new Error(`Training manifest validation failed: ${JSON.stringify(preview)}`);
  }

  const resolvedOutputDir = path.resolve(outputDir);
  const imagesDir = path.join(resolvedOutputDir, "images");

  removeDirectoryWithRetries(resolvedOutputDir);
  fs.mkdirSync(imagesDir, { recursive: true });

  const records = [];

  for (const entry of entries) {
    const sourceImagePath = String((entry && entry.imagePath) || "");
    const fileName = path.basename(sourceImagePath);
    const destinationPath = path.join(imagesDir, fileName);
    const relativeImagePath = path.posix.join("images", fileName);

    fs.copyFileSync(sourceImagePath, destinationPath);
    records.push(buildTrainingRecord(entry, relativeImagePath));
  }

  const splitGroups = {
    train: records.filter((record) => record.split === "train"),
    val: records.filter((record) => record.split === "val"),
    test: records.filter((record) => record.split === "test"),
  };

  writeJsonLines(path.join(resolvedOutputDir, "all.jsonl"), records);
  writeJsonLines(path.join(resolvedOutputDir, "train.jsonl"), splitGroups.train);
  writeJsonLines(path.join(resolvedOutputDir, "val.jsonl"), splitGroups.val);
  writeJsonLines(path.join(resolvedOutputDir, "test.jsonl"), splitGroups.test);

  const summary = {
    manifestPath: path.resolve(manifestPath),
    outputDir: resolvedOutputDir,
    imageCount: records.length,
    splitCounts: {
      train: splitGroups.train.length,
      val: splitGroups.val.length,
      test: splitGroups.test.length,
    },
    characterFrequency: countCharacterFrequency(entries),
    ocrBaseline: summarizeOcrBaseline(entries),
  };

  fs.writeFileSync(
    path.join(resolvedOutputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );

  return summary;
}

/**
 * 作用：
 * 解析训练导出命令的参数。
 *
 * 为什么这样写：
 * 训练导出目前只需要支持目标数据集路径，保持参数面简单更方便高频重复执行。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数数组。
 *
 * 输出：
 * @returns {object} 解析后的参数对象。
 *
 * 注意：
 * - 当前支持 `--dataset`。
 * - 未传时会沿用标注器的默认 manifest 选择逻辑。
 */
function parseTrainingArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--dataset") {
      options.datasetInput = String(args[index + 1] || "");
      index += 1;
    }
  }

  return options;
}

/**
 * 作用：
 * 运行训练导出命令主入口。
 *
 * 为什么这样写：
 * 这是“人工标注完成之后”的第一步自动化，把现有标注整理成稳定训练目录并输出摘要。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 默认导出到 `data/captcha-training-current`。
 * - 该命令会清空并重建目标目录。
 */
function main(argv) {
  const options = parseTrainingArgs(argv);
  const dataDir = getDataDir();
  const artifactsDir = getArtifactsDir();
  const manifestPath =
    resolveLabelManifestPath(options.datasetInput, dataDir) ||
    resolveLabelManifestPath(options.datasetInput, artifactsDir);

  if (!manifestPath) {
    throw new Error("No label manifest was found. Pass --dataset or prepare a labeled captcha set first.");
  }

  const summary = prepareTrainingDataset(
    manifestPath,
    getCurrentTrainingDir()
  );

  console.log(JSON.stringify(summary, null, 2));
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
  assignTrainingSplit,
  buildTrainingRecord,
  countCharacterFrequency,
  isRetryableDirectoryRemovalError,
  normalizeTrainingLabel,
  parseTrainingArgs,
  prepareTrainingDataset,
  removeDirectoryWithRetries,
  sleepSync,
  summarizeOcrBaseline,
  validateTrainingEntries,
  writeJsonLines,
};
