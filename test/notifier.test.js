const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNotificationPayload } = require("../src/notifier");

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

  assert.match(payload.title, /slot found/i);
  assert.match(payload.body, /los angeles/i);
  assert.match(payload.body, /3 option/);
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

  assert.match(payload.title, /check completed/i);
  assert.match(payload.body, /all_dates_reserved/);
});
