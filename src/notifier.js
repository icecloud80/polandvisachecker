const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * 作用：
 * 构造统一的通知标题和正文，供不同通知渠道复用。
 *
 * 为什么这样写：
 * 先统一通知文案，再分发到桌面通知和 webhook，可以保证不同渠道的用户看到同样的核心信息。
 *
 * 输入：
 * @param {object} result - 一次检查的结果对象。
 *
 * 输出：
 * @returns {object} 包含 title 和 body 的通知载荷。
 *
 * 注意：
 * - 这里不要拼接过长日志，避免桌面通知被截断。
 * - body 需要能在 webhook 和本机通知两个渠道上都可读。
 */
function buildNotificationPayload(result) {
  if (result.status.isAvailable) {
    return {
      title: "波兰签证有预约时间",
      body: `洛杉矶检测到 ${result.status.availableDateCount} 个可预约时间，请尽快查看。`,
    };
  }

  return {
    title: "波兰签证检查完成",
    body: `暂时没有预约时间。原因：${result.status.reason}。`,
  };
}

/**
 * 作用：
 * 发送 macOS 原生通知。
 *
 * 为什么这样写：
 * 用户当前在 macOS 环境中工作，直接走 osascript 不需要额外安装本地通知依赖。
 *
 * 输入：
 * @param {string} title - 通知标题。
 * @param {string} body - 通知正文。
 *
 * 输出：
 * @returns {Promise<void>} 通知完成后的 Promise。
 *
 * 注意：
 * - 仅在 darwin 平台调用。
 * - 文案中不要包含未转义的双引号。
 */
async function sendMacOsNotification(title, body) {
  if (os.platform() !== "darwin") {
    return;
  }

  const escapedTitle = title.replaceAll('"', '\\"');
  const escapedBody = body.replaceAll('"', '\\"');

  await execFileAsync("osascript", [
    "-e",
    `display notification "${escapedBody}" with title "${escapedTitle}"`,
  ]);
}

/**
 * 作用：
 * 通过通用 webhook 推送检查结果。
 *
 * 为什么这样写：
 * webhook 兼容 Slack、Discord、ntfy 代理或用户自建服务，扩展性比写死单一通知平台更好。
 *
 * 输入：
 * @param {string} url - webhook 地址。
 * @param {object} payload - 统一通知载荷。
 * @param {string} authHeader - 可选鉴权请求头名称。
 * @param {string} authToken - 可选鉴权令牌。
 *
 * 输出：
 * @returns {Promise<void>} 推送完成后的 Promise。
 *
 * 注意：
 * - 服务端对字段格式有定制要求时，建议在中间层转换，而不是在这里堆平台分支。
 * - URL 为空时不应调用本函数。
 */
async function sendWebhookNotification(url, payload, authHeader, authToken) {
  const headers = {
    "content-type": "application/json",
  };

  if (authHeader && authToken) {
    headers[authHeader] = authToken;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook notification failed with status ${response.status}.`);
  }
}

/**
 * 作用：
 * 根据配置把检查结果发送到所有启用的通知渠道。
 *
 * 为什么这样写：
 * 将渠道选择收敛到一个入口，主流程只关心“要不要通知”，不用关心具体发到哪里。
 *
 * 输入：
 * @param {object} config - 运行期通知配置。
 * @param {object} result - 一次检查的结果对象。
 *
 * 输出：
 * @returns {Promise<object>} 返回统一通知载荷，便于日志输出和测试断言。
 *
 * 注意：
 * - 默认只在发现可预约日期时通知，避免频繁打扰。
 * - 如果后续要加邮件渠道，优先在这里集中编排。
 */
async function notifyIfNeeded(config, result) {
  if (!result.status.isAvailable) {
    return buildNotificationPayload(result);
  }

  const payload = buildNotificationPayload(result);

  if (config.notifyMacOs) {
    await sendMacOsNotification(payload.title, payload.body);
  }

  if (config.notifyWebhookUrl) {
    await sendWebhookNotification(
      config.notifyWebhookUrl,
      payload,
      config.webhookAuthHeader,
      config.webhookAuthToken
    );
  }

  return payload;
}

module.exports = {
  buildNotificationPayload,
  notifyIfNeeded,
  sendWebhookNotification,
};
