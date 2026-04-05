const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const { buildCaptchaImagePath, resolveCaptchaText } = require("./captcha");
const { inferAvailability } = require("./status");

/**
 * 作用：
 * 生成一次检查对应的时间戳标签。
 *
 * 为什么这样写：
 * 统一时间戳格式后，日志文件、截图文件和调试输出可以相互对应，排障更直接。
 *
 * 输入：
 * @param {Date} now - 当前时间对象。
 *
 * 输出：
 * @returns {string} 文件名友好的时间戳。
 *
 * 注意：
 * - 使用 ISO 风格但替换冒号，避免跨平台文件名问题。
 * - 这里只负责命名，不承担展示格式职责。
 */
function buildRunId(now) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * 作用：
 * 把一次检查结果写入 JSON 归档文件。
 *
 * 为什么这样写：
 * 持久化原始结果后，即使通知失败或站点改版，我们仍能回看每次运行的状态和截图路径。
 *
 * 输入：
 * @param {string} artifactsDir - 产物目录。
 * @param {string} runId - 本次运行标识。
 * @param {object} result - 结果对象。
 *
 * 输出：
 * @returns {string} 写出的结果文件路径。
 *
 * 注意：
 * - 文件内容保留 2 空格缩进，方便人工查看。
 * - 调用前请确保 result 可序列化。
 */
function writeResultFile(artifactsDir, runId, result) {
  const outputPath = path.join(artifactsDir, `result-${runId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  return outputPath;
}

/**
 * 作用：
 * 在页面中根据可见文本选择下拉选项。
 *
 * 为什么这样写：
 * e-Konsulat 页面存在多语言和动态刷新行为，用文本选择比写死 option value 更稳健。
 *
 * 输入：
 * @param {import('playwright').Page} page - Playwright 页面对象。
 * @param {string} labelText - 字段标签或上下文文本。
 * @param {string} targetText - 目标选项文本。
 *
 * 输出：
 * @returns {Promise<void>} 选择完成后的 Promise。
 *
 * 注意：
 * - 如果同屏存在多个 select，需要结合 labelText 就近定位。
 * - 页面结构改版后，这里通常是最先需要调整的地方。
 */
async function selectByLabelText(page, labelText, targetText) {
  const selectHandle = page.locator("label", { hasText: labelText }).locator("..").locator("select").first();

  await selectHandle.selectOption({ label: targetText });
}

/**
 * 作用：
 * 在页面加载完成后将界面切换到英文。
 *
 * 为什么这样写：
 * 用户给出的操作路径基于英文界面，先统一语言可以减少后续选择器分支和文本匹配歧义。
 *
 * 输入：
 * @param {import('playwright').Page} page - Playwright 页面对象。
 *
 * 输出：
 * @returns {Promise<void>} 语言切换完成后的 Promise。
 *
 * 注意：
 * - 如果页面默认已是英文，应允许本函数安全跳过。
 * - 站点 DOM 改版时，这里的定位器可能需要更新。
 */
async function switchToEnglish(page) {
  const englishTrigger = page.getByRole("link", { name: /english/i }).first();

  if (await englishTrigger.count()) {
    await englishTrigger.click();
    await page.waitForLoadState("networkidle");
  }
}

/**
 * 作用：
 * 按照业务路径填写国家、领馆和服务类型等固定选项。
 *
 * 为什么这样写：
 * 将稳定的业务路径封装成独立步骤后，后续如果只改签证类别或人数，不需要改动整个检查流程。
 *
 * 输入：
 * @param {import('playwright').Page} page - Playwright 页面对象。
 *
 * 输出：
 * @returns {Promise<void>} 表单填写完成后的 Promise。
 *
 * 注意：
 * - 页面局部刷新较多，选择后要等待目标字段出现。
 * - 文案以用户提供的英文路径为准。
 */
async function fillStaticSelections(page) {
  await selectByLabelText(page, "Country", "United States");
  await page.waitForLoadState("networkidle");
  await selectByLabelText(
    page,
    "Office",
    "Consulate General of the Republic of Poland in Los Angeles"
  );
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /schengen visa - registration/i }).click();
  await page.waitForLoadState("networkidle");
  await selectByLabelText(page, "Type of service", "Schengen visa");
  await selectByLabelText(page, "Location", "Los Angeles");
  await selectByLabelText(page, "I want to reserve a date for", "1 people");
}

/**
 * 作用：
 * 识别并填写页面上的图形验证码。
 *
 * 为什么这样写：
 * 验证码是整个流程里最不稳定的环节，单独隔离后既方便调试，也能灵活切换 OCR 和人工模式。
 *
 * 输入：
 * @param {import('playwright').Page} page - Playwright 页面对象。
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 返回验证码文本和图片路径。
 *
 * 注意：
 * - 当前实现依赖 img 元素定位验证码，若站点改成 canvas 需要调整截图方式。
 * - 识别出的文本不要写入长期日志，避免误泄露会话上下文。
 */
async function fillCaptcha(page, config) {
  const captchaImagePath = buildCaptchaImagePath(config.artifactsDir);
  const activeImage = page
    .locator(
      "img[src*='captcha'], img[src*='verification'], img[alt*='verification' i], canvas"
    )
    .first();

  await activeImage.screenshot({ path: captchaImagePath });

  const captchaText = await resolveCaptchaText(
    config.captchaMode,
    captchaImagePath
  );

  let captchaInput = page.getByLabel(/image verification/i).first();

  if ((await captchaInput.count()) === 0) {
    captchaInput = page.getByPlaceholder(/image verification/i).first();
  }

  if ((await captchaInput.count()) === 0) {
    captchaInput = page.locator("input[type='text'], input:not([type])").last();
  }

  await captchaInput.fill(captchaText);

  return {
    captchaText,
    captchaImagePath,
  };
}

/**
 * 作用：
 * 从页面提取与“是否有可预约日期”相关的业务信号。
 *
 * 为什么这样写：
 * 页面结构和业务判断分开后，只要能重新拿到信号对象，就能复用统一状态推导和测试。
 *
 * 输入：
 * @param {import('playwright').Page} page - Playwright 页面对象。
 *
 * 输出：
 * @returns {Promise<object>} 供业务判断使用的页面信号。
 *
 * 注意：
 * - 这里不直接返回 availability，避免把解析规则散落在页面层。
 * - Date dropdown 的占位项要在数量统计时剔除。
 */
async function collectAvailabilitySignals(page) {
  const unavailableTextLocator = page.getByText(
    /all available dates have been reserved, please make an appointment at a later date/i
  );
  const unavailableText = (await unavailableTextLocator.count())
    ? await unavailableTextLocator.first().textContent()
    : "";
  const dateSelect = page.locator("select").filter({ has: page.locator("option") }).last();
  const options = await dateSelect.locator("option").evaluateAll((nodes) =>
    nodes
      .map((node) => ({
        value: node.getAttribute("value") || "",
        text: node.textContent || "",
      }))
      .filter(
        (item) =>
          item.value.trim() !== "" &&
          item.text.trim() !== "" &&
          !/select/i.test(item.text)
      )
  );

  return {
    dropdownOptions: options.length,
    unavailabilityText: unavailableText || "",
    optionTexts: options.map((item) => item.text.trim()),
  };
}

/**
 * 作用：
 * 执行一次完整的预约检查流程。
 *
 * 为什么这样写：
 * 将浏览器生命周期、页面操作、状态判断和产物写盘统一到一个入口，CLI 和后续定时任务都能复用。
 *
 * 输入：
 * @param {object} config - 运行配置。
 *
 * 输出：
 * @returns {Promise<object>} 一次检查的完整结果对象。
 *
 * 注意：
 * - 如果站点反爬策略升级，最可能在浏览器启动或页面导航阶段失败。
 * - headless 模式被风控拦截时，优先改为有头模式复测。
 */
async function runAppointmentCheck(config) {
  const runId = buildRunId(new Date());
  const browser = await chromium.launch({
    headless: config.headless,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const screenshotPath = path.join(config.artifactsDir, `page-${runId}.png`);

  try {
    await page.goto(config.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForLoadState("networkidle");
    await switchToEnglish(page);
    await fillStaticSelections(page);
    const captcha = await fillCaptcha(page, config);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForLoadState("networkidle");

    const signals = await collectAvailabilitySignals(page);
    const status = inferAvailability(signals);

    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    const result = {
      runId,
      checkedAt: new Date().toISOString(),
      status,
      signals,
      captchaImagePath: captcha.captchaImagePath,
      screenshotPath,
      url: page.url(),
    };

    result.resultPath = writeResultFile(config.artifactsDir, runId, result);

    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = {
  buildRunId,
  collectAvailabilitySignals,
  runAppointmentCheck,
  writeResultFile,
};
