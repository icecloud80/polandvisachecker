// ==UserScript==
// @name         Poland Visa Slot Watcher
// @namespace    https://secure.e-konsulat.gov.pl/
// @version      0.2.0
// @description  Monitor the Poland e-Konsulat visa page in a real browser and notify when appointment dates appear.
// @match        https://secure.e-konsulat.gov.pl/*
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEYS = {
    enabled: "polandVisaWatcher.enabled",
    nextRunAt: "polandVisaWatcher.nextRunAt",
    lastStatus: "polandVisaWatcher.lastStatus",
  };

  const CONFIG = {
    basePathPattern: /\/placowki\/126(?:\/)?$/i,
    intervalMs: 15 * 60 * 1000,
    autoStart: true,
    captchaMode: "manual",
    countryPattern: /united states|stany zjednoczone/i,
    officePattern:
      /consulate general of the republic of poland in los angeles|konsulat generalny rp w los angeles/i,
    registrationPattern: /schengen.*(registration|zarejestruj)/i,
    servicePattern: /schengen visa|wiza schengen/i,
    locationPattern: /los angeles/i,
    peoplePattern: /^1\s*(people|osob.*)$/i,
    dateFieldPattern: /\b(date|data|termin)\b/i,
    unavailablePattern:
      /all available dates have been reserved,\s*please make an appointment at a later date\./i,
    englishPattern: /^english|angielska$/i,
    imageVerificationPattern: /image verification|weryfikacja obrazkowa|znaki z obrazka/i,
    submitPattern: /^(next|submit|register|confirm|search|dalej|zarejestruj)$/i,
    webhookUrl: "",
    webhookHeaders: {},
    panelTitle: "Poland Visa Watcher",
  };

  const state = {
    enabled: false,
    inFlight: false,
    lastMessage: "",
    panel: null,
    statusNode: null,
    logNode: null,
    nextRunNode: null,
    startButton: null,
    stopButton: null,
    manualCaptchaBound: false,
  };

  /**
   * 作用：
   * 读取持久化配置值，优先使用 Tampermonkey 存储，失败时退回 localStorage。
   *
   * 为什么这样写：
   * 有些浏览器或扩展权限配置下，GM API 可能暂时不可用；保留 localStorage 兜底后脚本仍能工作。
   *
   * 输入：
   * @param {string} key - 持久化键名。
   * @param {unknown} fallback - 未命中时的默认值。
   *
   * 输出：
   * @returns {unknown} 读取到的值或默认值。
   *
   * 注意：
   * - localStorage 里保存的是字符串，布尔值会在调用方自行归一化。
   * - 这里只做最小兜底，不承担复杂迁移逻辑。
   */
  function getStoredValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallback);
      }
    } catch (error) {
      console.warn("[poland-visa-monitor] GM_getValue unavailable", error);
    }

    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      console.warn("[poland-visa-monitor] localStorage read unavailable", error);
      return fallback;
    }
  }

  /**
   * 作用：
   * 写入持久化配置值，优先使用 Tampermonkey 存储，失败时退回 localStorage。
   *
   * 为什么这样写：
   * 监控开关和下一轮时间需要跨页面刷新保留，双通道写入能提高兼容性。
   *
   * 输入：
   * @param {string} key - 持久化键名。
   * @param {unknown} value - 待写入的值。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - localStorage 中统一转成字符串。
   * - Tampermonkey 写入失败时不应直接中断主流程。
   */
  function setStoredValue(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (error) {
      console.warn("[poland-visa-monitor] GM_setValue unavailable", error);
    }

    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      console.warn("[poland-visa-monitor] localStorage write unavailable", error);
    }
  }

  /**
   * 作用：
   * 在控制台和页面面板中记录最近状态。
   *
   * 为什么这样写：
   * 页面自动化在真实站点上容易遇到动态改版，保留轻量日志能让用户更快知道脚本卡在什么步骤。
   *
   * 输入：
   * @param {string} message - 需要展示的日志文本。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 这里只保留单条最新状态，不承担长期审计职责。
   * - message 应尽量短，避免面板过长。
   */
  function logMessage(message) {
    state.lastMessage = `${new Date().toLocaleTimeString()} ${message}`;
    console.log(`[poland-visa-monitor] ${message}`);

    if (state.logNode) {
      state.logNode.textContent = state.lastMessage;
    }
  }

  /**
   * 作用：
   * 归一化文本，便于做模糊匹配。
   *
   * 为什么这样写：
   * 页面文案可能带换行、多个空格或大小写差异，统一归一化后匹配规则更稳定。
   *
   * 输入：
   * @param {string | null | undefined} value - 原始文本。
   *
   * 输出：
   * @returns {string} 归一化后的文本。
   *
   * 注意：
   * - 空值会返回空字符串。
   * - 这里只做轻量归一化，不做语言翻译。
   */
  function normalizeText(value) {
    return String(value || "")
      .replaceAll(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * 作用：
   * 将字符串或正则模式统一成 RegExp。
   *
   * 为什么这样写：
   * 配置里有的匹配项天然是正则，有的以后可能改成字符串，统一转换后调用方更简单。
   *
   * 输入：
   * @param {RegExp | string} pattern - 文本匹配模式。
   *
   * 输出：
   * @returns {RegExp} 可直接使用的正则对象。
   *
   * 注意：
   * - 字符串模式会按字面量转义。
   * - 不要把复杂业务逻辑塞进这个转换函数。
   */
  function toRegExp(pattern) {
    if (pattern instanceof RegExp) {
      return pattern;
    }

    return new RegExp(
      String(pattern).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );
  }

  /**
   * 作用：
   * 判断元素当前是否对用户可见。
   *
   * 为什么这样写：
   * 站点上经常同时保留多个隐藏模板节点，只操作可见元素可以明显降低误点概率。
   *
   * 输入：
   * @param {Element | null} element - 待判断的 DOM 元素。
   *
   * 输出：
   * @returns {boolean} 是否可见。
   *
   * 注意：
   * - display:none、visibility:hidden 和零尺寸都视为不可见。
   * - 这里只做近似判断，不处理被遮罩覆盖等高级情况。
   */
  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  /**
   * 作用：
   * 暂停指定毫秒数。
   *
   * 为什么这样写：
   * 站点包含多次局部刷新，短暂停顿能让后续字段在实际浏览器里稳定出现。
   *
   * 输入：
   * @param {number} ms - 需要等待的毫秒数。
   *
   * 输出：
   * @returns {Promise<void>} 等待完成后的 Promise。
   *
   * 注意：
   * - 不要把等待时间设得过长，否则会拖慢轮询节奏。
   * - 等待不是同步原语，只用于对抗页面异步更新。
   */
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * 作用：
   * 读取元素附近的上下文字段文本。
   *
   * 为什么这样写：
   * 页面标签和控件未必通过标准 label-for 关联，拼合周边文本可以更稳地找到目标字段。
   *
   * 输入：
   * @param {Element} element - 目标表单元素。
   *
   * 输出：
   * @returns {string} 归一化后的上下文文本。
   *
   * 注意：
   * - 这里会读取父节点和祖先节点的一部分文本，属于启发式策略。
   * - 如果页面结构大改，这个函数的效果会直接影响字段定位准确率。
   */
  function getContextText(element) {
    const textParts = [];

    if (element instanceof HTMLElement && element.labels) {
      textParts.push(...Array.from(element.labels, (label) => label.textContent || ""));
    }

    if (element.previousElementSibling) {
      textParts.push(element.previousElementSibling.textContent || "");
    }

    if (element.parentElement) {
      textParts.push(element.parentElement.textContent || "");
    }

    if (element.closest("tr, td, li, div, section, article")) {
      textParts.push(
        element.closest("tr, td, li, div, section, article").textContent || ""
      );
    }

    return normalizeText(textParts.join(" "));
  }

  /**
   * 作用：
   * 从页面中查找文本匹配的可点击元素。
   *
   * 为什么这样写：
   * 真实站点里相同动作可能是链接、按钮或伪按钮，统一扫描多种可点击标签更抗改版。
   *
   * 输入：
   * @param {RegExp | string} pattern - 目标文本模式。
   *
   * 输出：
   * @returns {HTMLElement | null} 匹配到的可点击元素。
   *
   * 注意：
   * - 只返回第一个可见匹配项。
   * - 如果同名按钮很多，调用方应尽量用更精确的模式。
   */
  function findClickable(pattern) {
    const matcher = toRegExp(pattern);
    const candidates = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit']")
    );

    return (
      candidates.find((element) => {
        const text =
          element.textContent ||
          element.getAttribute("value") ||
          element.getAttribute("aria-label") ||
          "";

        return isVisible(element) && matcher.test(normalizeText(text));
      }) || null
    );
  }

  /**
   * 作用：
   * 选择与指定字段和目标选项最接近的下拉框。
   *
   * 为什么这样写：
   * 页面控件没有稳定 id 时，只能用“字段上下文 + 选项候选”联合打分来选中最可能的 select。
   *
   * 输入：
   * @param {RegExp | string} fieldPattern - 字段标签的文本模式。
   * @param {RegExp | string | null} optionPattern - 目标选项文本模式。
   *
   * 输出：
   * @returns {HTMLSelectElement | null} 匹配到的下拉框。
   *
   * 注意：
   * - optionPattern 为空时只按字段上下文匹配。
   * - 如果页面上存在多个同类字段，分数可能仍然接近，需要结合真实页面微调。
   */
  function findBestSelect(fieldPattern, optionPattern) {
    const fieldMatcher = toRegExp(fieldPattern);
    const optionMatcher = optionPattern ? toRegExp(optionPattern) : null;
    const candidates = Array.from(document.querySelectorAll("select")).filter(isVisible);

    const scored = candidates
      .map((select) => {
        const contextText = getContextText(select);
        const optionTexts = Array.from(select.options, (option) =>
          normalizeText(option.textContent || "")
        );
        let score = 0;

        if (fieldMatcher.test(contextText)) {
          score += 10;
        }

        if (optionMatcher && optionTexts.some((text) => optionMatcher.test(text))) {
          score += 6;
        }

        return {
          select,
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    return scored.length ? scored[0].select : null;
  }

  /**
   * 作用：
   * 按可见文本为下拉框选择指定选项。
   *
   * 为什么这样写：
   * 目标站点的 option value 未必稳定，直接用可见文本匹配更贴合你的实际操作步骤。
   *
   * 输入：
   * @param {HTMLSelectElement | null} select - 目标下拉框。
   * @param {RegExp | string} optionPattern - 目标选项文本模式。
   *
   * 输出：
   * @returns {boolean} 是否成功选择。
   *
   * 注意：
   * - 成功后会主动派发 input 和 change 事件，触发站点联动逻辑。
   * - 如果目标选项尚未加载，本函数会返回 false。
   */
  function selectOptionByText(select, optionPattern) {
    if (!(select instanceof HTMLSelectElement)) {
      return false;
    }

    const matcher = toRegExp(optionPattern);
    const option = Array.from(select.options).find((candidate) =>
      matcher.test(normalizeText(candidate.textContent || ""))
    );

    if (!option) {
      return false;
    }

    if (select.value === option.value) {
      return true;
    }

    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * 作用：
   * 根据字段标签查找对应输入框。
   *
   * 为什么这样写：
   * 图形验证码输入框的 id 很可能不稳定，用上下文标签文本做启发式匹配更容易适配改版。
   *
   * 输入：
   * @param {RegExp | string} pattern - 字段标签文本模式。
   *
   * 输出：
   * @returns {HTMLInputElement | null} 匹配到的输入框。
   *
   * 注意：
   * - 仅匹配可见的文本输入框。
   * - 若页面同时存在多个相似输入框，可能需要继续收紧模式。
   */
  function findInputByField(pattern) {
    const matcher = toRegExp(pattern);
    const candidates = Array.from(
      document.querySelectorAll("input[type='text'], input:not([type]), textarea")
    ).filter(isVisible);

    return (
      candidates.find((input) => matcher.test(getContextText(input))) || null
    );
  }

  /**
   * 作用：
   * 查找验证码图片或画布元素。
   *
   * 为什么这样写：
   * 当前站点可能用 img，也可能改为 canvas，统一返回两者之一能减少后续兼容工作。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {HTMLImageElement | HTMLCanvasElement | null} 验证码图像元素。
   *
   * 注意：
   * - 本函数只找可见元素。
   * - 如果站点把验证码放进背景图，需要重新实现此逻辑。
   */
  function findCaptchaVisual() {
    const imageCandidates = Array.from(
      document.querySelectorAll(
        "img[src*='captcha'], img[src*='verification'], img[alt*='verification' i]"
      )
    ).filter(isVisible);

    if (imageCandidates.length) {
      return imageCandidates[0];
    }

    const canvasCandidates = Array.from(document.querySelectorAll("canvas")).filter(
      isVisible
    );

    return canvasCandidates[0] || null;
  }

  /**
   * 作用：
   * 将验证码视觉元素转换成 OCR 可识别的数据源。
   *
   * 为什么这样写：
   * OCR 库支持图片地址和 data URL，统一转换后无论站点用 img 还是 canvas 都能走同一条识别路径。
   *
   * 输入：
   * @param {HTMLImageElement | HTMLCanvasElement} visual - 验证码视觉元素。
   *
   * 输出：
   * @returns {string | null} OCR 可用的图片地址或 data URL。
   *
   * 注意：
   * - 如果是跨域图片但浏览器允许直接读取 src，就优先返回 src。
   * - canvas 转换失败时会返回 null。
   */
  function getCaptchaSource(visual) {
    if (visual instanceof HTMLImageElement) {
      return visual.currentSrc || visual.src || null;
    }

    if (visual instanceof HTMLCanvasElement) {
      try {
        return visual.toDataURL("image/png");
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  /**
   * 作用：
   * 使用 Tesseract 在浏览器内尝试识别验证码。
   *
   * 为什么这样写：
   * 验证码是阻碍无人值守轮询的关键点，把 OCR 作为可选增强能显著减少手工输入频率。
   *
   * 输入：
   * @param {string} captchaSource - 验证码图片数据源。
   *
   * 输出：
   * @returns {Promise<string>} OCR 识别得到的文本。
   *
   * 注意：
   * - 结果会做字母数字清洗，不保证一定正确。
   * - 页面如果禁止外部脚本或 OCR CDN 不可达，此步骤会失败并回退。
   */
  async function solveCaptchaWithOcr(captchaSource) {
    if (!window.Tesseract) {
      await loadTesseractRuntime();
    }

    const result = await window.Tesseract.recognize(captchaSource, "eng");
    return String(result.data.text || "").replaceAll(/[^a-z0-9]/gi, "").trim();
  }

  /**
   * 作用：
   * 按需加载 Tesseract OCR 运行时。
   *
   * 为什么这样写：
   * 默认手工验证码模式不需要外部 OCR 依赖，延迟加载可以减少 Tampermonkey 在站点启动阶段的失败点。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 运行时加载完成后的 Promise。
   *
   * 注意：
   * - 只在 OCR 模式下调用。
   * - CDN 不可用时会抛错并由上层回退到人工输入。
   */
  async function loadTesseractRuntime() {
    if (window.Tesseract) {
      return;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Tesseract runtime."));
      document.documentElement.appendChild(script);
    });
  }

  /**
   * 作用：
   * 在需要人工输入验证码时绑定一次性的辅助监听。
   *
   * 为什么这样写：
   * 人工模式下，用户填完验证码后希望脚本继续接手提交和检测，不必再手动点下一步。
   *
   * 输入：
   * @param {HTMLInputElement} input - 验证码输入框。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 监听只需绑定一次，避免重复触发提交。
   * - 自动提交前会做最短长度保护。
   */
  function bindManualCaptchaListener(input) {
    if (!(input instanceof HTMLInputElement) || state.manualCaptchaBound) {
      return;
    }

    const handler = async () => {
      const value = String(input.value || "").trim();

      if (value.length < 4 || state.inFlight === true) {
        return;
      }

      logMessage("Manual captcha entered. Submitting form.");
      await submitCurrentStep();
      await sleep(2000);
      void runCheckCycle();
    };

    input.addEventListener("change", handler);
    input.addEventListener("blur", handler);
    state.manualCaptchaBound = true;
  }

  /**
   * 作用：
   * 触发当前步骤的提交动作。
   *
   * 为什么这样写：
   * 不同页面版本的提交控件可能是按钮或表单提交，统一在这里做兼容会更稳。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<boolean>} 是否成功触发提交。
   *
   * 注意：
   * - 点击后仍需等待页面自己刷新或回显结果。
   * - 如果站点把提交动作绑在特殊脚本里，可能需要补更多触发方式。
   */
  async function submitCurrentStep() {
    const submitButton = findClickable(CONFIG.submitPattern);

    if (submitButton) {
      submitButton.click();
      return true;
    }

    const form = document.querySelector("form");

    if (form) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    }

    return false;
  }

  /**
   * 作用：
   * 尝试把页面推进到目标查询状态。
   *
   * 为什么这样写：
   * 将语言切换、国家选择、领馆选择和签证类型选择集中处理，可以在每轮刷新后自动恢复到同一路径。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 页面推进完成后的 Promise。
   *
   * 注意：
   * - 这是启发式流程，任何一步失败都不应直接抛异常中断整轮检查。
   * - 每次下拉选择后会短暂等待站点联动加载。
   */
  async function ensureTargetFlow() {
    const englishButton = findClickable(CONFIG.englishPattern);

    if (englishButton && !CONFIG.basePathPattern.test(window.location.pathname)) {
      englishButton.click();
      logMessage("Switching interface to English.");
      await sleep(1500);
    }

    const registrationLink = findClickable(CONFIG.registrationPattern);

    if (registrationLink) {
      registrationLink.click();
      logMessage("Opened Schengen visa registration.");
      await sleep(2200);
    }

    const countrySelect = findBestSelect(/country|kraj/i, CONFIG.countryPattern);

    if (selectOptionByText(countrySelect, CONFIG.countryPattern)) {
      logMessage("Country set to United States.");
      await sleep(1500);
    }

    const officeSelect = findBestSelect(/office|consulate|placowka|urzad/i, CONFIG.officePattern);

    if (selectOptionByText(officeSelect, CONFIG.officePattern)) {
      logMessage("Office set to Los Angeles.");
      await sleep(1500);
    }

    const serviceSelect = findBestSelect(/type of service|service|rodzaj uslugi|rodzaj usługi/i, CONFIG.servicePattern);

    if (selectOptionByText(serviceSelect, CONFIG.servicePattern)) {
      logMessage("Service type selected.");
      await sleep(900);
    }

    const locationSelect = findBestSelect(/location/i, CONFIG.locationPattern);

    if (selectOptionByText(locationSelect, CONFIG.locationPattern)) {
      logMessage("Location selected.");
      await sleep(900);
    }

    const peopleSelect = findBestSelect(/reserve a date for|people|liczba osob|liczba osób/i, CONFIG.peoplePattern);

    if (selectOptionByText(peopleSelect, CONFIG.peoplePattern)) {
      logMessage("People count selected.");
      await sleep(900);
    }
  }

  /**
   * 作用：
   * 读取页面上的预约状态信号。
   *
   * 为什么这样写：
   * 把 DOM 检测结果标准化后，通知、面板和后续 webhook 都能消费同一份结果。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {object} 预约状态对象。
   *
   * 注意：
   * - 这里先看日期下拉框，再看“已订满”提示，遵循更强证据优先原则。
   * - 只统计真实选项，不包含占位提示项。
   */
  function readAvailability() {
    const dateSelect = findBestSelect(CONFIG.dateFieldPattern, null);
    const dateOptions =
      dateSelect instanceof HTMLSelectElement
        ? Array.from(dateSelect.options)
            .map((option) => ({
              value: option.value || "",
              text: normalizeText(option.textContent || ""),
            }))
            .filter(
              (option) =>
                option.value.trim() !== "" &&
                option.text.trim() !== "" &&
                !/select|choose/.test(option.text)
            )
        : [];

    if (dateOptions.length > 0) {
      return {
        isAvailable: true,
        reason: "date_options_present",
        optionTexts: dateOptions.map((option) => option.text),
      };
    }

    const pageText = normalizeText(document.body.innerText);

    if (CONFIG.unavailablePattern.test(pageText)) {
      return {
        isAvailable: false,
        reason: "all_dates_reserved",
        optionTexts: [],
      };
    }

    return {
      isAvailable: false,
      reason: "unknown_or_waiting",
      optionTexts: [],
    };
  }

  /**
   * 作用：
   * 触发页面通知、声音和可选 webhook。
   *
   * 为什么这样写：
   * 用户真正关心的是“现在有没有号”，把所有通知动作收口到一个函数更容易维护和扩展。
   *
   * 输入：
   * @param {object} status - 标准化预约状态对象。
   *
   * 输出：
   * @returns {Promise<void>} 通知发送完成后的 Promise。
   *
   * 注意：
   * - 当前只在有号时发送强提醒。
   * - webhook 失败不应阻断本地提醒。
   */
  async function notifyAvailability(status) {
    const body = `Dates are available in Los Angeles. Options: ${status.optionTexts.join(", ") || "detected"}`;

    if (typeof GM_notification === "function") {
      GM_notification({
        title: "Poland visa slot found",
        text: body,
        timeout: 15000,
      });
    }

    if ("Notification" in window) {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }

      if (Notification.permission === "granted") {
        new Notification("Poland visa slot found", { body });
      }
    }

    try {
      const audioContext = new window.AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.value = 0.03;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      window.setTimeout(() => {
        oscillator.stop();
        void audioContext.close();
      }, 900);
    } catch (error) {
      console.warn("[poland-visa-monitor] audio notification failed", error);
    }

    if (CONFIG.webhookUrl && typeof GM_xmlhttpRequest === "function") {
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: CONFIG.webhookUrl,
          headers: {
            "Content-Type": "application/json",
            ...CONFIG.webhookHeaders,
          },
          data: JSON.stringify({
            title: "Poland visa slot found",
            body,
            optionTexts: status.optionTexts,
            url: window.location.href,
            checkedAt: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.warn("[poland-visa-monitor] webhook failed", error);
      }
    }
  }

  /**
   * 作用：
   * 安排下一轮刷新时间。
   *
   * 为什么这样写：
   * 用户脚本运行在真实页面里，最简单稳定的轮询方式就是等待一段时间后刷新并重新走同一流程。
   *
   * 输入：
   * @param {string} reason - 这次安排下一轮的原因说明。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 脚本关闭后不应继续安排刷新。
   * - 下一轮时间会写进持久化存储，用于面板展示。
   */
  function scheduleReload(reason) {
    if (!state.enabled) {
      return;
    }

    const nextRunAt = Date.now() + CONFIG.intervalMs;
    setStoredValue(STORAGE_KEYS.nextRunAt, nextRunAt);
    updatePanelStatus(`Waiting for next run: ${reason}`);
    updateNextRunLabel(nextRunAt);
    logMessage(`Next refresh scheduled in ${Math.round(CONFIG.intervalMs / 60000)} minute(s).`);

    window.setTimeout(() => {
      window.location.reload();
    }, CONFIG.intervalMs);
  }

  /**
   * 作用：
   * 更新面板状态文案。
   *
   * 为什么这样写：
   * 将面板更新封装起来后，主流程里只需要关心业务状态，不用操作 DOM 细节。
   *
   * 输入：
   * @param {string} text - 需要显示的状态文本。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 面板还没创建时允许静默跳过。
   * - 状态文案应该和最近日志互补，而不是重复整段日志。
   */
  function updatePanelStatus(text) {
    if (state.statusNode) {
      state.statusNode.textContent = text;
    }
  }

  /**
   * 作用：
   * 更新下一轮执行时间显示。
   *
   * 为什么这样写：
   * 用户最常见的问题是“脚本到底还在不在跑”，明确展示下次运行时间能减少不确定感。
   *
   * 输入：
   * @param {number | null} nextRunAt - 下一轮时间戳。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - nextRunAt 为空时要显示暂停状态。
   * - 这里只负责渲染，不负责调度逻辑。
   */
  function updateNextRunLabel(nextRunAt) {
    if (!state.nextRunNode) {
      return;
    }

    if (!nextRunAt) {
      state.nextRunNode.textContent = "Next run: paused";
      return;
    }

    state.nextRunNode.textContent = `Next run: ${new Date(nextRunAt).toLocaleTimeString()}`;
  }

  /**
   * 作用：
   * 创建页面右下角的控制面板。
   *
   * 为什么这样写：
   * 用户脚本在真实站点里运行时，需要一个最小可见入口来确认状态、启动和停止轮询。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 面板样式要尽量轻量，避免挡住主业务表单。
   * - 重复创建前会先检查是否已经存在。
   */
  function createPanel() {
    if (state.panel) {
      return;
    }

    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "16px";
    panel.style.zIndex = "999999";
    panel.style.width = "320px";
    panel.style.padding = "12px";
    panel.style.borderRadius = "14px";
    panel.style.background = "rgba(17, 24, 39, 0.92)";
    panel.style.color = "#f9fafb";
    panel.style.boxShadow = "0 20px 50px rgba(15, 23, 42, 0.35)";
    panel.style.font = "13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif";

    const title = document.createElement("div");
    title.textContent = CONFIG.panelTitle;
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";

    const status = document.createElement("div");
    status.textContent = "Status: idle";
    status.style.marginBottom = "6px";

    const nextRun = document.createElement("div");
    nextRun.textContent = "Next run: paused";
    nextRun.style.marginBottom = "8px";
    nextRun.style.opacity = "0.85";

    const log = document.createElement("div");
    log.textContent = "Ready.";
    log.style.minHeight = "38px";
    log.style.marginBottom = "10px";
    log.style.opacity = "0.9";

    const buttonRow = document.createElement("div");
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";

    const startButton = document.createElement("button");
    startButton.textContent = "Start";
    startButton.style.flex = "1";
    startButton.style.padding = "8px 10px";
    startButton.style.border = "0";
    startButton.style.borderRadius = "10px";
    startButton.style.background = "#10b981";
    startButton.style.color = "#052e16";
    startButton.style.fontWeight = "700";
    startButton.style.cursor = "pointer";

    const stopButton = document.createElement("button");
    stopButton.textContent = "Stop";
    stopButton.style.flex = "1";
    stopButton.style.padding = "8px 10px";
    stopButton.style.border = "0";
    stopButton.style.borderRadius = "10px";
    stopButton.style.background = "#f59e0b";
    stopButton.style.color = "#451a03";
    stopButton.style.fontWeight = "700";
    stopButton.style.cursor = "pointer";

    startButton.addEventListener("click", () => {
      startWatcher();
    });

    stopButton.addEventListener("click", () => {
      stopWatcher();
    });

    buttonRow.append(startButton, stopButton);
    panel.append(title, status, nextRun, log, buttonRow);
    document.body.appendChild(panel);

    state.panel = panel;
    state.statusNode = status;
    state.logNode = log;
    state.nextRunNode = nextRun;
    state.startButton = startButton;
    state.stopButton = stopButton;
  }

  /**
   * 作用：
   * 启动监控循环。
   *
   * 为什么这样写：
   * 启停状态需要持久化到 Tampermonkey 存储，这样页面刷新后脚本还能自动恢复轮询。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 启动流程完成后的 Promise。
   *
   * 注意：
   * - 如果已经启动则直接跳过。
   * - 启动后会立即执行一轮检查，而不是等到下个周期。
   */
  async function startWatcher() {
    if (state.enabled) {
      return;
    }

    state.enabled = true;
    setStoredValue(STORAGE_KEYS.enabled, true);
    updatePanelStatus("Running");
    updateNextRunLabel(null);
    logMessage("Watcher started.");
    await runCheckCycle();
  }

  /**
   * 作用：
   * 停止监控循环。
   *
   * 为什么这样写：
   * 用户在排查页面或手动预约时需要一个明确的暂停入口，避免脚本继续自动刷新打断操作。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 停止只影响后续轮询，不会中断已经提交中的网络请求。
   * - 需要同步清空下一轮时间展示。
   */
  function stopWatcher() {
    state.enabled = false;
    setStoredValue(STORAGE_KEYS.enabled, false);
    setStoredValue(STORAGE_KEYS.nextRunAt, 0);
    updatePanelStatus("Stopped");
    updateNextRunLabel(null);
    logMessage("Watcher stopped.");
  }

  /**
   * 作用：
   * 执行一轮完整的页面检查。
   *
   * 为什么这样写：
   * 这是脚本的主状态机，统一串起页面推进、验证码处理、结果判断和通知动作。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 本轮检查完成后的 Promise。
   *
   * 注意：
   * - 任一轮运行中不允许重入。
   * - 人工验证码模式会在等待用户输入后提前返回，等用户补全再继续。
   */
  async function runCheckCycle() {
    if (!state.enabled || state.inFlight) {
      return;
    }

    state.inFlight = true;
    state.manualCaptchaBound = false;

    try {
      updatePanelStatus("Working");
      await ensureTargetFlow();

      const status = readAvailability();

      if (status.isAvailable) {
        updatePanelStatus("Available");
        setStoredValue(STORAGE_KEYS.lastStatus, JSON.stringify(status));
        logMessage("Appointment dates detected.");
        await notifyAvailability(status);
        return;
      }

      const captchaInput = findInputByField(CONFIG.imageVerificationPattern);
      const captchaVisual = findCaptchaVisual();

      if (
        captchaInput instanceof HTMLInputElement &&
        String(captchaInput.value || "").trim().length < 4
      ) {
        if (CONFIG.captchaMode === "manual") {
          updatePanelStatus("Waiting for captcha");
          logMessage("Please type the captcha. The script will submit automatically after you finish.");
          bindManualCaptchaListener(captchaInput);
          return;
        }

        const captchaSource = captchaVisual ? getCaptchaSource(captchaVisual) : null;

        if (captchaSource) {
          updatePanelStatus("Solving captcha");
          logMessage("Trying OCR for captcha.");
          const captchaText = await solveCaptchaWithOcr(captchaSource);

          if (captchaText.length >= 4) {
            captchaInput.value = captchaText;
            captchaInput.dispatchEvent(new Event("input", { bubbles: true }));
            captchaInput.dispatchEvent(new Event("change", { bubbles: true }));
            logMessage(`OCR filled captcha as "${captchaText}".`);
            await submitCurrentStep();
            await sleep(2500);
            const postSubmitStatus = readAvailability();

            if (postSubmitStatus.isAvailable) {
              updatePanelStatus("Available");
              setStoredValue(STORAGE_KEYS.lastStatus, JSON.stringify(postSubmitStatus));
              logMessage("Appointment dates detected after OCR submit.");
              await notifyAvailability(postSubmitStatus);
              return;
            }
          } else {
            logMessage("OCR result was too weak. Waiting for manual captcha.");
          }
        }

        updatePanelStatus("Waiting for captcha");
        bindManualCaptchaListener(captchaInput);
        return;
      }

      if (status.reason === "all_dates_reserved") {
        updatePanelStatus("No slots");
        logMessage("No slots found on this run.");
        scheduleReload("all dates reserved");
        return;
      }

      if (await submitCurrentStep()) {
        logMessage("Submitted current step and waiting for result.");
        await sleep(2500);
      }

      const finalStatus = readAvailability();

      if (finalStatus.isAvailable) {
        updatePanelStatus("Available");
        setStoredValue(STORAGE_KEYS.lastStatus, JSON.stringify(finalStatus));
        logMessage("Appointment dates detected.");
        await notifyAvailability(finalStatus);
        return;
      }

      updatePanelStatus("No slots");
      logMessage(`No appointment dates found. Reason: ${finalStatus.reason}.`);
      scheduleReload(finalStatus.reason);
    } catch (error) {
      updatePanelStatus("Error");
      logMessage(`Error: ${error.message}`);
      scheduleReload("error recovery");
    } finally {
      state.inFlight = false;
    }
  }

  /**
   * 作用：
   * 初始化脚本界面和菜单命令。
   *
   * 为什么这样写：
   * 把初始化入口保持集中，页面刷新后只需执行一次就能恢复整个监控体验。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 面板必须等 document.body 可用后再插入。
   * - 自动启动逻辑读取持久化开关和默认配置。
   */
  function bootstrap() {
    createPanel();
    updateNextRunLabel(Number(getStoredValue(STORAGE_KEYS.nextRunAt, 0)) || null);
    updatePanelStatus("Idle");
    logMessage("Script loaded.");

    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("Start Poland Visa Watcher", () => {
        void startWatcher();
      });
      GM_registerMenuCommand("Stop Poland Visa Watcher", () => {
        stopWatcher();
      });
    }

    const persistedEnabledRaw = getStoredValue(
      STORAGE_KEYS.enabled,
      CONFIG.autoStart ? "true" : "false"
    );
    const persistedEnabled =
      persistedEnabledRaw === true || String(persistedEnabledRaw).toLowerCase() === "true";

    if (persistedEnabled) {
      void startWatcher();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
