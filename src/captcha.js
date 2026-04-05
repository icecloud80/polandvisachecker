const path = require("node:path");
const readline = require("node:readline/promises");
const { createWorker } = require("tesseract.js");
const {
  sanitizeCaptchaText,
  shouldAutoSubmitOcrCaptcha,
} = require("./chrome-utils");

/**
 * 作用：
 * 从命令行读取人工输入的验证码文本。
 *
 * 为什么这样写：
 * 站点的图形验证码可能随时改版，保留人工输入模式能保证在 OCR 失效时工具仍可继续使用。
 *
 * 输入：
 * @param {string} imagePath - 已保存的验证码截图路径。
 *
 * 输出：
 * @returns {Promise<string>} 用户输入的验证码文本。
 *
 * 注意：
 * - 调用前应先把验证码截图写到磁盘，方便用户打开核对。
 * - 用户输入需要在外层再次 trim。
 */
async function promptForCaptcha(imagePath) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Enter captcha from ${imagePath}: `
    );

    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * 作用：
 * 使用本地 OCR 尝试识别验证码文本。
 *
 * 为什么这样写：
 * OCR 作为可选增强，可以在验证码比较规整时减少人工输入频率，但不把整个工具成功率压在 OCR 上。
 * 这里复用主流程的验证码清洗规则，避免旧入口把真实符号字符删掉。
 *
 * 输入：
 * @param {string} imagePath - 验证码图片路径。
 *
 * 输出：
 * @returns {Promise<string>} OCR 识别出的验证码文本。
 *
 * 注意：
 * - 这里只做基础英文数字识别，复杂验证码仍可能失败。
 * - 识别结果会保留可见符号，只移除空白和控制字符。
 */
async function solveCaptchaWithOcr(imagePath) {
  const worker = await createWorker("eng");

  try {
    const {
      data: { text },
    } = await worker.recognize(imagePath);

    return sanitizeCaptchaText(text);
  } finally {
    await worker.terminate();
  }
}

/**
 * 作用：
 * 根据配置选择验证码处理方式，并在需要时回退到人工输入。
 *
 * 为什么这样写：
 * 验证码处理是高失败率环节，统一封装后可以明确记录 OCR 与人工模式的切换逻辑。
 *
 * 输入：
 * @param {string} mode - captcha 模式，可选 prompt、ocr、ocr-then-prompt。
 * @param {string} imagePath - 验证码图片路径。
 *
 * 输出：
 * @returns {Promise<string>} 最终用于提交的验证码文本。
 *
 * 注意：
 * - OCR 结果不是正好 4 个可见字符时会自动回退，避免盲目提交。
 * - 不要在这里直接做表单提交，职责保持单一。
 */
async function resolveCaptchaText(mode, imagePath) {
  if (mode === "prompt") {
    return promptForCaptcha(imagePath);
  }

  if (mode === "ocr") {
    return solveCaptchaWithOcr(imagePath);
  }

  if (mode === "ocr-then-prompt") {
    const candidate = await solveCaptchaWithOcr(imagePath);

    if (shouldAutoSubmitOcrCaptcha(candidate)) {
      return candidate;
    }

    return promptForCaptcha(imagePath);
  }

  throw new Error(
    `Unsupported CAPTCHA_MODE "${mode}". Use prompt, ocr, or ocr-then-prompt.`
  );
}

/**
 * 作用：
 * 生成验证码截图的目标路径。
 *
 * 为什么这样写：
 * 单独抽出命名逻辑，便于测试和后续统一调整归档策略。
 *
 * 输入：
 * @param {string} artifactsDir - 产物目录。
 *
 * 输出：
 * @returns {string} 验证码截图路径。
 *
 * 注意：
 * - 文件名保留时间戳，避免多次运行互相覆盖。
 * - 上层应保证目录已存在。
 */
function buildCaptchaImagePath(artifactsDir) {
  return path.join(artifactsDir, `captcha-${Date.now()}.png`);
}

module.exports = {
  buildCaptchaImagePath,
  promptForCaptcha,
  resolveCaptchaText,
  solveCaptchaWithOcr,
};
