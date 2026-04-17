const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMacOsNotificationJxaSource,
  buildMacOsSpeechText,
  buildMacOsSystemSoundCandidates,
  buildNotificationPayload,
  buildTerminalBellSequence,
} = require("../src/notifier");

/**
 * 作用：
 * 验证发现预约日期时的通知文案包含核心业务信息。
 *
 * 为什么这样写：
 * 通知是用户最后真正看到的结果，测试可以防止重构时把“发现名额”这种关键信号丢掉。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造检查结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 标题应该能让用户一眼判断是成功命中。
 * - 正文应保留地点和数量信息。
 */
test("buildNotificationPayload returns success copy for available dates", () => {
  const payload = buildNotificationPayload({
    status: {
      isAvailable: true,
      availableDateCount: 3,
      reason: "date_options_present",
    },
  });

  assert.equal(payload.title, "波兰签证有预约时间");
  assert.match(payload.body, /洛杉矶/);
  assert.match(payload.body, /3/);
  assert.match(payload.body, /可预约时间/);
});

/**
 * 作用：
 * 验证无可预约日期时的通知文案会回显失败原因。
 *
 * 为什么这样写：
 * 失败原因是定位问题和判断是否需要人工复查的重要线索，不能在通知层被吞掉。
 *
 * 输入：
 * @param {object} 无 - 测试用例直接构造检查结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前默认无号时不主动通知，但该文案仍用于日志和潜在扩展渠道。
 * - 如果后续接入“每轮都通知”的模式，这个测试仍然有效。
 */
test("buildNotificationPayload returns no-slot copy for unavailable dates", () => {
  const payload = buildNotificationPayload({
    status: {
      isAvailable: false,
      availableDateCount: 0,
      reason: "all_dates_reserved",
    },
  });

  assert.equal(payload.title, "波兰签证检查完成");
  assert.match(payload.body, /暂时没有预约时间/);
  assert.match(payload.body, /all_dates_reserved/);
});

/**
 * 作用：
 * 验证 macOS JXA 通知源码会包含标题和正文。
 *
 * 为什么这样写：
 * 这次把本机通知从 AppleScript 切到了 JXA。
 * 用纯函数测试锁住最终 JXA 内容，能防止以后重构时把标题或正文拼错。
 *
 * 输入：
 * @param {object} 无 - 直接构造示例标题和正文。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 这里测试的是脚本拼装结果，不直接依赖本机通知权限。
 * - 声音播放由独立的系统声音函数负责，不在这条 JXA 源码里内联。
 */
test("buildMacOsNotificationJxaSource includes title and body for positive-hit notifications", () => {
  const script = buildMacOsNotificationJxaSource('波兰签证有预约时间', '洛杉矶检测到 1 个可预约时间，请尽快查看。');

  assert.match(script, /displayNotification/);
  assert.match(script, /withTitle/);
  assert.match(script, /波兰签证有预约时间/);
  assert.match(script, /洛杉矶检测到 1 个可预约时间，请尽快查看。/);
  assert.doesNotMatch(script, /sound name/);
});

/**
 * 作用：
 * 验证正向命中时会生成简短的语音播报文本。
 *
 * 为什么这样写：
 * 语音播报是对横幅通知的可靠补充。
 * 这条测试锁住“只有 available 时才播报、并且播报包含地点和数量”的契约。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例结果。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前语音文案优先使用英文短句，避免系统默认中文语音在部分机器上发音不稳定。
 * - 不可用状态应返回空串，避免每轮无号都朗读打扰。
 */
test("buildMacOsSpeechText returns a concise speech message only for available results", () => {
  const speechText = buildMacOsSpeechText(
    {
      status: {
        isAvailable: true,
        availableDateCount: 2,
      },
    },
    {
      title: "波兰签证有预约时间",
      body: "洛杉矶检测到 2 个可预约时间，请尽快查看。",
    }
  );

  assert.match(speechText, /Poland visa appointment available/i);
  assert.match(speechText, /Los Angeles/);
  assert.match(speechText, /2 appointment options/);
  assert.equal(
    buildMacOsSpeechText(
      {
        status: {
          isAvailable: false,
          availableDateCount: 0,
        },
      },
      {
        title: "波兰签证检查完成",
        body: "暂时没有预约时间。",
      }
    ),
    ""
  );
});

/**
 * 作用：
 * 验证 terminal bell 序列会按配置次数重复输出。
 *
 * 为什么这样写：
 * 当前用户直接在 terminal 里跑循环脚本。
 * 这条测试锁住“命中时至少响铃一次，并且可重复几次加强提醒”的基础行为。
 *
 * 输入：
 * @param {object} 无 - 直接传入 bell 次数。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - ASCII bell 字符本身不可见，因此只比较字符串长度和内容。
 * - 次数异常时也应最少返回 1 个 bell。
 */
test("buildTerminalBellSequence repeats the terminal bell character", () => {
  assert.equal(buildTerminalBellSequence(3), "\u0007\u0007\u0007");
  assert.equal(buildTerminalBellSequence(0), "\u0007");
});

/**
 * 作用：
 * 验证系统声音候选路径会为给定声音名生成稳定的文件列表。
 *
 * 为什么这样写：
 * 通知声音现在独立通过系统音频文件播放。
 * 这条测试锁住候选路径生成规则，避免后续重构时把标准系统声音路径拼错。
 *
 * 输入：
 * @param {object} 无 - 直接传入示例声音名。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前优先级是 `.aiff` 再 `.caf`。
 * - 空声音名应返回空数组，表示调用方直接跳过声音播放。
 */
test("buildMacOsSystemSoundCandidates returns stable sound file candidates", () => {
  assert.deepEqual(buildMacOsSystemSoundCandidates("Glass"), [
    "/System/Library/Sounds/Glass.aiff",
    "/System/Library/Sounds/Glass.caf",
  ]);
  assert.deepEqual(buildMacOsSystemSoundCandidates(""), []);
});
