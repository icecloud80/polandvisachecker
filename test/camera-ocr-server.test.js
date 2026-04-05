const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getContentType,
  parseImageDataUrl,
  sanitizeOcrText,
} = require("../src/camera-ocr-server");

/**
 * 作用：
 * 验证摄像头 OCR 服务会沿用主流程的符号保留规则。
 *
 * 为什么这样写：
 * 真实验证码可能包含符号字符，摄像头入口如果继续删符号，就会和主流程出现行为分叉。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 OCR 文本。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里验证与主流程一致的保留符号策略。
 * - 仍然只删除空白和控制字符。
 */
test("sanitizeOcrText preserves visible captcha symbols", () => {
  assert.equal(sanitizeOcrText("  xw@C \n"), "xw@C");
  assert.equal(sanitizeOcrText(" \t+=Bb \r"), "+=Bb");
});

/**
 * 作用：
 * 验证浏览器上传的图片 data URL 能被正确解析。
 *
 * 为什么这样写：
 * 这是本地拍照页和 Node OCR 服务之间的核心数据交换格式，解析错误会直接导致整个工具不可用。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例 data URL。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只覆盖最常见的 PNG base64 输入。
 * - Buffer 内容只做最小断言。
 */
test("parseImageDataUrl decodes base64 image payload", () => {
  const result = parseImageDataUrl("data:image/png;base64,QUJD");

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.buffer.toString("utf8"), "ABC");
});

/**
 * 作用：
 * 验证静态资源内容类型映射。
 *
 * 为什么这样写：
 * 本地页面要能正常加载 HTML 和 JS，错误的 Content-Type 可能让浏览器拒绝执行脚本。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例文件路径。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前只覆盖本工具实际会用到的类型。
 * - 其他类型会回退到八位字节流。
 */
test("getContentType returns the expected mime type for static assets", () => {
  assert.equal(getContentType("/tmp/index.html"), "text/html; charset=utf-8");
  assert.equal(getContentType("/tmp/app.js"), "text/javascript; charset=utf-8");
  assert.equal(getContentType("/tmp/file.bin"), "application/octet-stream");
});
