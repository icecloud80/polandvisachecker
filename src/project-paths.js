const path = require("node:path");
const process = require("node:process");

/**
 * 作用：
 * 返回当前项目根目录下的 artifacts 目录绝对路径。
 *
 * 为什么这样写：
 * `artifacts/` 现在只用于运行时产物，比如日志、临时采集批次和 live 调试快照。
 * 把路径集中管理后，运行态代码和测试都能共享同一套目录约定。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} artifacts 目录绝对路径。
 *
 * 注意：
 * - 允许通过 `ARTIFACTS_DIR` 覆盖默认位置。
 * - 这里只负责返回路径，不负责创建目录。
 */
function getArtifactsDir() {
  return path.resolve(process.cwd(), process.env.ARTIFACTS_DIR || "artifacts");
}

/**
 * 作用：
 * 返回当前项目根目录下的 data 目录绝对路径。
 *
 * 为什么这样写：
 * 用户要求把所有可提交的标注与训练数据从 `artifacts/` 中分离出来。
 * 统一走 `data/` 后，主数据集就不会再因为 `.gitignore` 被漏掉。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} data 目录绝对路径。
 *
 * 注意：
 * - 允许通过 `CAPTCHA_DATA_DIR` 覆盖默认位置。
 * - 当前总标签清单、总图片库和训练导出都应落在这里。
 */
function getDataDir() {
  return path.resolve(process.cwd(), process.env.CAPTCHA_DATA_DIR || "data");
}

/**
 * 作用：
 * 返回当前项目根目录下的 model 目录绝对路径。
 *
 * 为什么这样写：
 * 用户要求把模型产物与训练数据进一步分开。
 * 统一走 `model/` 后，模型文件可以被 git 正常跟踪，同时也更便于版本管理。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} model 目录绝对路径。
 *
 * 注意：
 * - 允许通过 `CAPTCHA_MODEL_DIR` 覆盖默认位置。
 * - 当前默认模型目录和分析目录都应基于这里推导。
 */
function getModelDir() {
  return path.resolve(process.cwd(), process.env.CAPTCHA_MODEL_DIR || "model");
}

/**
 * 作用：
 * 返回当前主图片库目录绝对路径。
 *
 * 为什么这样写：
 * 主图片库是人工标注和训练数据的共同入口，应该稳定地存放在 `data/` 下。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前主图片库目录绝对路径。
 *
 * 注意：
 * - 当前目录名固定为 `captcha-images-current`。
 * - 如果未来要切分版本目录，需要同步更新标注与训练默认入口。
 */
function getCurrentCaptchaImagesDir() {
  return path.join(getDataDir(), "captcha-images-current");
}

/**
 * 作用：
 * 返回当前主标签清单文件绝对路径。
 *
 * 为什么这样写：
 * 标注器、训练准备和建议命令都默认使用这一份总清单。
 * 抽成公共函数后，多个入口不会再各自硬编码不同路径。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前主标签清单绝对路径。
 *
 * 注意：
 * - 当前文件名固定为 `captcha-images-current-labels.json`。
 * - 这是默认入口，不代表不能通过命令行覆盖。
 */
function getCurrentCaptchaLabelsPath() {
  return path.join(getDataDir(), "captcha-images-current-labels.json");
}

/**
 * 作用：
 * 返回当前主图片库统计摘要文件绝对路径。
 *
 * 为什么这样写：
 * 当前主库图片数和来源统计会被多个脚本复用。
 * 集中封装后，后续调整目录结构时只需要改这里。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前主图片库摘要文件绝对路径。
 *
 * 注意：
 * - 当前文件名固定为 `captcha-images-current-summary.json`。
 * - 这里只负责路径约定，不负责内容格式。
 */
function getCurrentCaptchaSummaryPath() {
  return path.join(getDataDir(), "captcha-images-current-summary.json");
}

/**
 * 作用：
 * 返回当前训练导出目录绝对路径。
 *
 * 为什么这样写：
 * 用户要求训练集与主标注库都放在 `data/` 中，而不再落到被忽略的 `artifacts/`。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前训练导出目录绝对路径。
 *
 * 注意：
 * - 当前目录名固定为 `captcha-training-current`。
 * - 每次训练准备都会重建这个目录。
 */
function getCurrentTrainingDir() {
  return path.join(getDataDir(), "captcha-training-current");
}

/**
 * 作用：
 * 返回当前模型输出目录绝对路径。
 *
 * 为什么这样写：
 * 用户要求模型文件落在 `model/` 下，和训练数据分开保存。
 * 这样既方便提交到 git，也方便以后做多版本模型管理。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前模型输出目录绝对路径。
 *
 * 注意：
 * - 当前目录名固定为 `captcha-model-current`。
 * - 训练、分析和 live checker 默认都基于这份目录工作。
 */
function getCurrentCaptchaModelDir() {
  return path.join(getModelDir(), "captcha-model-current");
}

/**
 * 作用：
 * 返回当前默认模型文件绝对路径。
 *
 * 为什么这样写：
 * live checker 和 `captcha:suggest` 都默认消费同一份模型文件。
 * 单独提供文件级别的 helper 后，调用方不需要重复拼接 `model.json`。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 当前默认模型文件绝对路径。
 *
 * 注意：
 * - 当前文件名固定为 `model.json`。
 * - 如果未来支持多模型切换，优先扩展这里而不是在调用点硬编码。
 */
function getCurrentCaptchaModelPath() {
  return path.join(getCurrentCaptchaModelDir(), "model.json");
}

module.exports = {
  getArtifactsDir,
  getCurrentCaptchaImagesDir,
  getCurrentCaptchaLabelsPath,
  getCurrentCaptchaModelDir,
  getCurrentCaptchaModelPath,
  getCurrentCaptchaSummaryPath,
  getCurrentTrainingDir,
  getDataDir,
  getModelDir,
};
