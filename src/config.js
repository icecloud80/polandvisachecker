const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config();

/**
 * 作用：
 * 将字符串环境变量解析为布尔值。
 *
 * 为什么这样写：
 * 环境变量天然是字符串，集中转换可以避免不同模块对 true/false 的判断口径不一致。
 *
 * 输入：
 * @param {string | undefined} value - 原始环境变量字符串。
 * @param {boolean} fallback - 未提供时的默认值。
 *
 * 输出：
 * @returns {boolean} 解析后的布尔值。
 *
 * 注意：
 * - 仅把字符串 true 视为真，其他值全部回退到假或默认值。
 * - 调用方应自行决定 fallback。
 */
function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

/**
 * 作用：
 * 读取并归一化运行配置。
 *
 * 为什么这样写：
 * 通过单一配置入口固定默认值和目录结构，CLI 与测试都能复用同一套配置规则。
 *
 * 输入：
 * @param {string} cwd - 当前工作目录。
 *
 * 输出：
 * @returns {object} 规范化后的配置对象。
 *
 * 注意：
 * - artifacts 目录会在这里确保存在，避免业务流程里散落 mkdir 逻辑。
 * - 如果后续新增通知渠道，优先扩展这里而不是在调用方拼环境变量。
 */
function loadConfig(cwd) {
  const artifactsDir = path.resolve(
    cwd,
    process.env.ARTIFACTS_DIR || "artifacts"
  );

  fs.mkdirSync(artifactsDir, { recursive: true });

  return {
    baseUrl: "https://secure.e-konsulat.gov.pl/placowki/126",
    artifactsDir,
    checkIntervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 15),
    headless: parseBoolean(process.env.HEADLESS, false),
    captchaMode: process.env.CAPTCHA_MODE || "prompt",
    notifyMacOs: parseBoolean(process.env.NOTIFY_MACOS, true),
    notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || "",
    webhookAuthHeader: process.env.WEBHOOK_AUTH_HEADER || "",
    webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || "",
    playwrightStorageStatePath: path.join(artifactsDir, "storage-state.json"),
  };
}

module.exports = {
  loadConfig,
  parseBoolean,
};
