const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCurrentCaptchaLabelsPath,
  getCurrentCaptchaModelDir,
  getCurrentCaptchaModelPath,
  getCurrentTrainingDir,
  getDataDir,
  getModelDir,
} = require("../src/project-paths");

/**
 * 作用：
 * 验证项目路径约定已经切换到 `data/` 与 `model/`。
 *
 * 为什么这样写：
 * 这次目录整理的核心目标就是把可提交的数据和模型从被忽略的 `artifacts/` 中移出来。
 * 单独锁住这些默认路径后，后续任何脚本回退到旧目录都会立刻被测试发现。
 *
 * 输入：
 * @param {object} 无 - 直接读取默认路径 helper。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只断言尾部路径，避免和本机绝对路径耦合。
 * - 如果未来目录再调整，需要同步更新源码、文档和这条测试。
 */
test("project path helpers point tracked data and model assets outside artifacts", () => {
  assert.match(getDataDir(), /[\\/]data$/u);
  assert.match(getCurrentCaptchaLabelsPath(), /data[\\/]captcha-images-current-labels\.json$/u);
  assert.match(getCurrentTrainingDir(), /data[\\/]captcha-training-current$/u);
  assert.match(getModelDir(), /[\\/]model$/u);
  assert.match(getCurrentCaptchaModelDir(), /model[\\/]captcha-model-current$/u);
  assert.match(getCurrentCaptchaModelPath(), /model[\\/]captcha-model-current[\\/]model\.json$/u);
});
