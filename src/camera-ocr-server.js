const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const process = require("node:process");
const { createWorker } = require("tesseract.js");
const { sanitizeCaptchaText } = require("./chrome-utils");

const DEFAULT_PORT = Number(process.env.CAMERA_OCR_PORT || 4312);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

/**
 * 作用：
 * 将 OCR 原始文本归一化为更适合验证码场景的格式。
 *
 * 为什么这样写：
 * 项目里真实验证码已经证明会出现 `@`、`+`、`=` 等符号。
 * 这里直接复用主流程的清洗规则，避免不同 OCR 入口对同一张图给出不一致的结果。
 *
 * 输入：
 * @param {string} value - OCR 原始文本。
 *
 * 输出：
 * @returns {string} 保留可见验证码字符的归一化文本。
 *
 * 注意：
 * - 这里与 Chrome 主流程保持同一套规则。
 * - 如果未来主流程的字符集规则调整，这里会自动跟随。
 */
function sanitizeOcrText(value) {
  return sanitizeCaptchaText(value);
}

/**
 * 作用：
 * 解析浏览器上传的图片 data URL。
 *
 * 为什么这样写：
 * 前端通过 canvas 拍照后最方便传输的就是 data URL，服务端需要先把它还原成二进制再送入 OCR。
 *
 * 输入：
 * @param {string} dataUrl - 浏览器提交的 data URL。
 *
 * 输出：
 * @returns {object} 包含 mimeType 和 buffer 的图片对象。
 *
 * 注意：
 * - 仅支持 `data:image/...;base64,...` 形式。
 * - 非法数据应直接抛错，避免把错误数据送进 OCR。
 */
function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);

  if (!match) {
    throw new Error("Invalid image data URL.");
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

/**
 * 作用：
 * 将 Node 侧 buffer 交给 Tesseract 执行 OCR。
 *
 * 为什么这样写：
 * OCR 统一放到服务端执行，前端只负责拍照和展示结果，可以降低浏览器端兼容性复杂度。
 *
 * 输入：
 * @param {Buffer} imageBuffer - 待识别的图片二进制。
 *
 * 输出：
 * @returns {Promise<object>} 包含原始文本和清洗后文本的 OCR 结果。
 *
 * 注意：
 * - 当前只使用英文模型。
 * - 每次请求独立创建 worker，逻辑简单但吞吐不是最优。
 */
async function recognizeCaptchaFromBuffer(imageBuffer) {
  const worker = await createWorker("eng");

  try {
    const {
      data: { text, confidence },
    } = await worker.recognize(imageBuffer);

    return {
      rawText: String(text || "").trim(),
      normalizedText: sanitizeOcrText(text),
      confidence: Number(confidence || 0),
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * 作用：
 * 读取并返回静态文件内容。
 *
 * 为什么这样写：
 * 本地网页工具只需要少量静态资源，用原生 `http` + 文件读取足够简单直接。
 *
 * 输入：
 * @param {string} filePath - 绝对文件路径。
 *
 * 输出：
 * @returns {Buffer} 静态文件内容。
 *
 * 注意：
 * - 调用方需要自行保证路径位于 public 目录。
 * - 文件不存在时会抛出系统错误。
 */
function readStaticFile(filePath) {
  return fs.readFileSync(filePath);
}

/**
 * 作用：
 * 根据文件扩展名返回合适的响应类型。
 *
 * 为什么这样写：
 * 浏览器加载本地工具页时需要正确的 Content-Type，否则脚本和页面可能无法执行。
 *
 * 输入：
 * @param {string} filePath - 静态文件路径。
 *
 * 输出：
 * @returns {string} HTTP Content-Type。
 *
 * 注意：
 * - 当前只覆盖本工具实际会用到的类型。
 * - 其他扩展名统一回退到八位字节流。
 */
function getContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  return "application/octet-stream";
}

/**
 * 作用：
 * 将对象响应为 JSON。
 *
 * 为什么这样写：
 * OCR 接口和错误处理都需要稳定返回 JSON，集中封装后更容易保持一致。
 *
 * 输入：
 * @param {import('node:http').ServerResponse} response - HTTP 响应对象。
 * @param {number} statusCode - 状态码。
 * @param {object} payload - JSON 负载。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里会统一写入 UTF-8 JSON Content-Type。
 * - payload 必须可被 JSON 序列化。
 */
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/**
 * 作用：
 * 读取 POST 请求体文本。
 *
 * 为什么这样写：
 * 相比引入额外框架，原生读取请求体更轻量，足够支撑当前单接口场景。
 *
 * 输入：
 * @param {import('node:http').IncomingMessage} request - HTTP 请求对象。
 *
 * 输出：
 * @returns {Promise<string>} 请求体文本。
 *
 * 注意：
 * - 当前未做超大请求体优化，因为验证码图片体积通常较小。
 * - 上层应在 JSON.parse 前捕获格式错误。
 */
function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

/**
 * 作用：
 * 处理浏览器发来的 OCR 请求。
 *
 * 为什么这样写：
 * 将接口逻辑和静态资源分开后，主路由更清晰，未来也更容易扩展预处理步骤。
 *
 * 输入：
 * @param {import('node:http').IncomingMessage} request - HTTP 请求对象。
 * @param {import('node:http').ServerResponse} response - HTTP 响应对象。
 *
 * 输出：
 * @returns {Promise<void>} 请求处理完成后的 Promise。
 *
 * 注意：
 * - 错误时返回结构化 JSON，便于前端展示。
 * - 当前只接受 `dataUrl` 字段。
 */
async function handleOcrRequest(request, response) {
  try {
    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    const image = parseImageDataUrl(payload.dataUrl);
    const result = await recognizeCaptchaFromBuffer(image.buffer);

    sendJson(response, 200, {
      ok: true,
      mimeType: image.mimeType,
      ...result,
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message || String(error),
    });
  }
}

/**
 * 作用：
 * 创建并启动本地摄像头 OCR 服务。
 *
 * 为什么这样写：
 * 将服务创建逻辑封装成函数后，CLI 启动和测试都可以复用同一入口。
 *
 * 输入：
 * @param {number} port - 启动端口。
 *
 * 输出：
 * @returns {import('node:http').Server} 已启动的 HTTP 服务实例。
 *
 * 注意：
 * - 仅监听本机 `127.0.0.1`，避免无意暴露到局域网。
 * - 路由很少，优先保持实现简单。
 */
function startCameraOcrServer(port) {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ocr") {
      await handleOcrRequest(request, response);
      return;
    }

    const relativePath = requestUrl.pathname === "/" ? "/captcha-camera.html" : requestUrl.pathname;
    const filePath = path.join(PUBLIC_DIR, relativePath.replace(/^\/+/, ""));

    if (!filePath.startsWith(PUBLIC_DIR)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const fileContent = readStaticFile(filePath);
      response.writeHead(200, {
        "content-type": getContentType(filePath),
      });
      response.end(fileContent);
    } catch (error) {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Camera OCR server is running at http://127.0.0.1:${port}`);
    console.log("Open the page in Chrome, allow camera access, capture the captcha, and review the OCR result.");
  });

  return server;
}

/**
 * 作用：
 * 作为命令行入口启动本地摄像头 OCR 服务。
 *
 * 为什么这样写：
 * 用户只需要一个简单命令就能启动本地网页工具，不需要关心内部模块拆分。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 服务会持续运行，直到用户主动停止。
 * - 如端口冲突，可通过 `CAMERA_OCR_PORT` 覆盖默认值。
 */
function main() {
  startCameraOcrServer(DEFAULT_PORT);
}

if (require.main === module) {
  main();
}

module.exports = {
  getContentType,
  parseImageDataUrl,
  sanitizeOcrText,
  startCameraOcrServer,
};
