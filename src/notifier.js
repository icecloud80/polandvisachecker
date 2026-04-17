const os = require("node:os");
const { execFile } = require("node:child_process");
const process = require("node:process");
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
 * 将普通文本转成可安全嵌入 AppleScript 双引号字符串的文本。
 *
 * 为什么这样写：
 * macOS 通知和语音播报都依赖 `osascript`。
 * 如果标题或正文里包含反斜杠、双引号等字符但没有先转义，AppleScript 语句可能被截断或执行失败。
 *
 * 输入：
 * @param {string} value - 原始文本。
 *
 * 输出：
 * @returns {string} 可安全放入 AppleScript 双引号字符串中的文本。
 *
 * 注意：
 * - 这里只处理当前通知文案会遇到的常见转义字符。
 * - 若后续文案引入多行文本，也应继续走这层统一转义。
 */
function escapeAppleScriptString(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * 作用：
 * 构造 macOS 原生通知对应的 AppleScript 命令文本。
 *
 * 为什么这样写：
 * 把脚本拼装逻辑抽成纯函数后，可以稳定测试“标题、正文、声音名”是否都进入了最终命令，
 * 避免以后改通知实现时又退回到静默、无声或转义错误的状态。
 *
 * 输入：
 * @param {string} title - 通知标题。
 * @param {string} body - 通知正文。
 * @param {string} soundName - 可选通知声音名称。
 *
 * 输出：
 * @returns {string} 可直接传给 `osascript -e` 的 AppleScript 单行命令。
 *
 * 注意：
 * - 声音名为空时会退回无声通知命令。
 * - 当前默认声音通常由运行配置提供，例如 `Glass`。
 */
function buildMacOsNotificationAppleScript(title, body, soundName) {
  const escapedTitle = escapeAppleScriptString(title);
  const escapedBody = escapeAppleScriptString(body);
  const normalizedSoundName = String(soundName || "").trim();

  if (normalizedSoundName) {
    return `display notification "${escapedBody}" with title "${escapedTitle}" sound name "${escapeAppleScriptString(
      normalizedSoundName
    )}"`;
  }

  return `display notification "${escapedBody}" with title "${escapedTitle}"`;
}

/**
 * 作用：
 * 为命中预约时间的场景生成更不容易错过的语音播报文本。
 *
 * 为什么这样写：
 * 原生横幅通知有时会被专注模式、角落堆叠或用户视线遗漏。
 * 增加一条简短的语音播报后，即使用户没盯着屏幕，也更容易立刻知道“有号了”。
 *
 * 输入：
 * @param {object} result - 一次检查的结果对象。
 * @param {object} payload - 已生成的统一通知载荷。
 *
 * 输出：
 * @returns {string} 适合 `say` 命令的简短播报文本；无需播报时返回空串。
 *
 * 注意：
 * - 当前只对 `isAvailable=true` 生成播报文本。
 * - 这里优先使用英文短句，避免系统默认中文语音在部分机器上发音不稳定。
 */
function buildMacOsSpeechText(result, payload) {
  if (!result || !result.status || result.status.isAvailable !== true) {
    return "";
  }

  const availableDateCount = Number(result.status.availableDateCount || 0);
  const countFragment =
    availableDateCount > 0 ? `${availableDateCount} appointment option${availableDateCount === 1 ? "" : "s"}` : "appointments";

  return `Poland visa appointment available in Los Angeles. ${countFragment} found. Check now.`;
}

/**
 * 作用：
 * 生成 terminal bell 字符串，让当前前台终端也能发出本地提示音。
 *
 * 为什么这样写：
 * 用户当前直接在 terminal 里跑循环检查。
 * 即使系统横幅没有弹出，终端蜂鸣也能提供一个和当前会话强绑定的本地提醒。
 *
 * 输入：
 * @param {number} repeatCount - bell 重复次数。
 *
 * 输出：
 * @returns {string} 可直接写入 stdout/stderr 的 bell 字符串。
 *
 * 注意：
 * - 重复次数最少为 1，避免被错误配置成空提醒。
 * - 是否真的发声取决于终端本身是否开启 bell。
 */
function buildTerminalBellSequence(repeatCount) {
  const normalizedRepeatCount = Math.max(1, Number.isFinite(Number(repeatCount)) ? Number(repeatCount) : 1);
  return "\u0007".repeat(normalizedRepeatCount);
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
 * @param {string} soundName - 可选通知声音名称。
 *
 * 输出：
 * @returns {Promise<void>} 通知完成后的 Promise。
 *
 * 注意：
 * - 仅在 darwin 平台调用。
 * - 默认建议配合系统声音一起发送，避免正好错过静默横幅。
 */
async function sendMacOsNotification(title, body, soundName) {
  if (os.platform() !== "darwin") {
    return;
  }

  await execFileAsync("osascript", [
    "-e",
    buildMacOsNotificationAppleScript(title, body, soundName),
  ]);
}

/**
 * 作用：
 * 通过 macOS `say` 命令播报一条简短语音提醒。
 *
 * 为什么这样写：
 * 当系统横幅被忽略、折叠或专注模式影响时，语音播报仍然能给操作者一个更明显的“有号了”信号。
 *
 * 输入：
 * @param {string} text - 需要播报的文本。
 *
 * 输出：
 * @returns {Promise<void>} 播报完成后的 Promise。
 *
 * 注意：
 * - 仅在 darwin 平台调用。
 * - 文本为空时直接跳过，不应调用 `say`。
 */
async function sendMacOsSpeech(text) {
  if (os.platform() !== "darwin") {
    return;
  }

  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    return;
  }

  await execFileAsync("say", [normalizedText]);
}

/**
 * 作用：
 * 向当前终端写入 bell 字符，作为桌面通知之外的本地提醒补充。
 *
 * 为什么这样写：
 * 用户正在前台 terminal 里运行循环脚本。
 * 即使桌面通知权限、专注模式或系统横幅有问题，terminal bell 仍然可能是最快可见的提醒方式。
 *
 * 输入：
 * @param {number} repeatCount - bell 重复次数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里只写标准输出，不抛异常打断主流程。
 * - 终端若禁用了 bell，用户至少还能看到后续 JSON 和中文结论。
 */
function ringTerminalBell(repeatCount) {
  process.stdout.write(buildTerminalBellSequence(repeatCount));
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
  const warningMessages = [];

  if (config.notifyMacOs) {
    try {
      await sendMacOsNotification(
        payload.title,
        payload.body,
        config.notifyMacOsSoundName || "Glass"
      );
    } catch (error) {
      warningMessages.push(`macOS notification failed: ${String(error.message || error)}`);
    }
  }

  if (config.notifyTerminalBell !== false) {
    ringTerminalBell(config.notifyTerminalBellRepeatCount || 3);
  }

  if (config.notifyMacOsSpeak !== false) {
    try {
      await sendMacOsSpeech(buildMacOsSpeechText(result, payload));
    } catch (error) {
      warningMessages.push(`macOS speech failed: ${String(error.message || error)}`);
    }
  }

  if (config.notifyWebhookUrl) {
    try {
      await sendWebhookNotification(
        config.notifyWebhookUrl,
        payload,
        config.webhookAuthHeader,
        config.webhookAuthToken
      );
    } catch (error) {
      warningMessages.push(`webhook notification failed: ${String(error.message || error)}`);
    }
  }

  if (warningMessages.length > 0) {
    console.error(`[notifier] ${warningMessages.join(" | ")}`);
  }

  return payload;
}

module.exports = {
  buildMacOsNotificationAppleScript,
  buildMacOsSpeechText,
  buildNotificationPayload,
  buildTerminalBellSequence,
  escapeAppleScriptString,
  notifyIfNeeded,
  ringTerminalBell,
  sendMacOsNotification,
  sendMacOsSpeech,
  sendWebhookNotification,
};
