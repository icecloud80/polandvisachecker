/**
 * 作用：
 * 生成注入到真实 Chrome 标签页中的共享运行时代码。
 *
 * 为什么这样写：
 * 页面端的 DOM 查找、文本匹配和验证码提取逻辑需要被多次复用，集中成一段运行时代码更便于维护。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 可注入页面执行的 JavaScript 源码。
 *
 * 注意：
 * - 这里返回的是源码字符串，不要在 Node 侧直接执行。
 * - 页面改版时，大多数调整都会发生在这个运行时代码里。
 */
function getPageRuntimeSource() {
  return `
    window.__POLAND_VISA_RUNTIME__ = window.__POLAND_VISA_RUNTIME__ || (() => {
      const CONFIG = {
        englishPattern: /^english|angielska$/i,
        registrationPattern: /schengen.*(registration|zarejestruj)/i,
        servicePattern: /schengen visa|wiza schengen/i,
        locationPattern: /los angeles/i,
        peoplePattern: /^1\\s*(people|osob.*)$/i,
        unavailablePattern: /chwilowo wszystkie udostępnione terminy zostały zarezerwowane,\\s*prosimy spróbować umówić wizytę w terminie późniejszym|all available dates have been reserved,\\s*please make an appointment at a later date\\.?/i,
        unavailableNormalizedPattern: /chwilowo wszystkie udostepnione terminy zostaly zarezerwowane, prosimy sprobowac umowic wizyte w terminie pozniejszym|all available dates have been reserved, please make an appointment at a later date\\.?/i,
        imageVerificationPattern: /characters from image|image verification|weryfikacja obrazkowa|znaki z obrazka/i,
        serviceFieldPattern: /rodzaj usługi|rodzaj uslugi|type of service|service/i,
        locationFieldPattern: /lokalizacja|location/i,
        peopleFieldPattern: /chcę zarezerwować termin dla|chce zarezerwowac termin dla|reserve a date for|people|osob/i,
        dateFieldPattern: /\\b(date|data|termin)\\b/i,
        refreshPattern: /^(refresh|odśwież|odswiez)$/i,
        submitPattern: /^(next|submit|register|confirm|search|dalej|zarejestruj)$/i
      };

      function normalizeText(value) {
        return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
      }

      /**
       * 作用：
       * 生成更宽松的文本匹配形态，兼容组合音标和无重音写法。
       *
       * 为什么这样写：
       * 真实页面里的波兰语按钮文本可能在 DOM 中以不同的 Unicode 形式出现。
       * 只做原样比较时，肉眼看起来相同的 “Odśwież” 仍可能匹配失败。
       *
       * 输入：
       * @param {string} value - 原始文本。
       *
       * 输出：
       * @returns {string} 适合做宽松匹配的归一化文本。
       *
       * 注意：
       * - 这里只服务于按钮文本匹配，不替代正常业务文本。
       * - 去掉重音后会更接近无重音备选正则，例如 “odswiez”。
       */
      function normalizeLooseText(value) {
        return String(value || "")
          .normalize("NFKD")
          .replace(/[\\u0300-\\u036f]/g, "")
          .replace(/\\s+/g, " ")
          .trim()
          .toLowerCase();
      }

      /**
       * 作用：
       * 折叠相邻重复词，减少框架拼接文本导致的“同词重复”噪声。
       *
       * 为什么这样写：
       * 诊断里已经看到某些按钮的搜索文本会变成 “odśwież odśwież” 或 “dalej dalej”。
       * 折叠这些重复词后，精确正则就不容易因为上下文拼接而失效。
       *
       * 输入：
       * @param {string} value - 已归一化的按钮文本。
       *
       * 输出：
       * @returns {string} 折叠后的文本。
       *
       * 注意：
       * - 这里只折叠相邻重复词，不会打乱原始顺序。
       * - 空文本会安全返回空串。
       */
      function collapseAdjacentDuplicateWords(value) {
        const words = String(value || "").split(" ").filter((word) => word !== "");
        const collapsedWords = words.filter((word, index) => index === 0 || word !== words[index - 1]);
        return collapsedWords.join(" ");
      }

      function toRegExp(pattern) {
        if (pattern instanceof RegExp) {
          return pattern;
        }

        return new RegExp(String(pattern), "i");
      }

      /**
       * 作用：
       * 判断某个元素是否属于当前运行时认可的可点击控件。
       *
       * 为什么这样写：
       * 刷新按钮在真实页面里可能是按钮本体，也可能是 Material 风格包装节点。
       * 把“可点击”的判断集中起来后，后续的候选枚举和祖先回溯可以共用同一套标准。
       *
       * 输入：
       * @param {Element} element - 当前待判断的 DOM 元素。
       *
       * 输出：
       * @returns {boolean} 该元素是否属于可点击控件。
       *
       * 注意：
       * - 这里只判断元素类型和属性，不判断是否可见。
       * - 若站点更换组件库，需要同步扩展这里的选择器。
       */
      function isActionableElement(element) {
        return Boolean(
          element &&
          element instanceof Element &&
          element.matches(
            [
              "button",
              "a",
              "input[type='button']",
              "input[type='submit']",
              "[role='button']",
              ".mat-mdc-button-base",
              ".mat-mdc-icon-button",
              ".mdc-button",
              ".mat-button",
              ".mat-mdc-unelevated-button",
              ".mat-mdc-outlined-button",
              ".mat-mdc-raised-button"
            ].join(", ")
          )
        );
      }

      function isVisible(element) {
        if (!element || !(element instanceof Element)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      function getContextText(element) {
        const textParts = [];

        textParts.push(element.getAttribute ? element.getAttribute("aria-label") || "" : "");
        textParts.push(element.getAttribute ? element.getAttribute("placeholder") || "" : "");
        textParts.push(element.getAttribute ? element.getAttribute("name") || "" : "");
        textParts.push(element.getAttribute ? element.getAttribute("id") || "" : "");

        if (element instanceof HTMLElement && element.labels) {
          textParts.push(...Array.from(element.labels, (label) => label.textContent || ""));
        }

        if (element.previousElementSibling) {
          textParts.push(element.previousElementSibling.textContent || "");
        }

        if (element.parentElement) {
          textParts.push(element.parentElement.textContent || "");
        }

        const container = element.closest("tr, td, li, div, section, article, form");

        if (container) {
          textParts.push(container.textContent || "");
        }

        return normalizeText(textParts.join(" "));
      }

      /**
       * 作用：
       * 读取元素在文本匹配时应当参与比较的多种文本来源。
       *
       * 为什么这样写：
       * “Odśwież” 在真实页面里可能出现在 textContent、aria-label、value、title
       * 或祖先容器文本中。把这些来源统一列出来后，可以显著降低“肉眼可见但脚本匹配不到”的概率。
       *
       * 输入：
       * @param {Element} element - 当前待分析的 DOM 元素。
       *
       * 输出：
       * @returns {Array<string>} 归一化后的候选文本列表。
       *
       * 注意：
       * - 返回值会去重并过滤空串。
       * - 这里不会裁剪长度，因为刷新诊断需要保留完整证据。
       */
      function getElementSearchTexts(element) {
        if (!(element instanceof Element)) {
          return [];
        }

        const values = [
          element.textContent || "",
          element instanceof HTMLElement ? element.innerText || "" : "",
          element.getAttribute ? element.getAttribute("value") || "" : "",
          element.getAttribute ? element.getAttribute("aria-label") || "" : "",
          element.getAttribute ? element.getAttribute("title") || "" : "",
          getContextText(element)
        ];
        const normalizedValues = values
          .map((value) => normalizeText(value))
          .filter((value, index, list) => value !== "" && list.indexOf(value) === index);

        return normalizedValues;
      }

      /**
       * 作用：
       * 判断元素是否命中了指定文本模式。
       *
       * 为什么这样写：
       * 旧逻辑只看单一文本来源，导致真实页面上能看到 “Odśwież”，
       * 但脚本仍可能因为命中源不同而找不到目标控件。
       *
       * 输入：
       * @param {Element} element - 当前待分析的 DOM 元素。
       * @param {RegExp|string} pattern - 目标文本模式。
       *
       * 输出：
       * @returns {boolean} 当前元素是否命中模式。
       *
       * 注意：
       * - 模式会统一转换成不区分大小写的正则。
       * - 这里只判断文本，不判断元素是否可点击。
       */
      function elementMatchesPattern(element, pattern) {
        const matcher = toRegExp(pattern);
        return getElementSearchTexts(element).some((text) => {
          const variants = [
            text,
            collapseAdjacentDuplicateWords(text),
            normalizeLooseText(text),
            collapseAdjacentDuplicateWords(normalizeLooseText(text))
          ].filter((value, index, list) => value !== "" && list.indexOf(value) === index);

          return variants.some((value) => matcher.test(value));
        });
      }

      function findClickable(pattern) {
        const candidates = Array.from(
          document.querySelectorAll(
            [
              "a",
              "button",
              "input[type='button']",
              "input[type='submit']",
              "[role='button']",
              ".mat-mdc-button-base",
              ".mat-mdc-icon-button",
              ".mdc-button",
              ".mat-button",
              ".mat-mdc-unelevated-button",
              ".mat-mdc-outlined-button",
              ".mat-mdc-raised-button"
            ].join(", ")
          )
        );
        const directMatch = candidates.find((element) => isVisible(element) && elementMatchesPattern(element, pattern));

        if (directMatch) {
          return directMatch;
        }

        const fallbackCandidates = collectPatternCandidates(pattern, 20);

        for (const candidate of fallbackCandidates) {
          const actionableElement = candidate.actionableElements.find(
            (element) => element instanceof HTMLElement && isVisible(element)
          );

          if (actionableElement) {
            return actionableElement;
          }
        }

        return null;
      }

      function getActionableElements(element) {
        const actionableElements = [];
        const directElement = element instanceof Element ? element : null;
        const closestActionable = directElement
          ? directElement.closest(
              [
                "button",
                "a",
                "input[type='button']",
                "input[type='submit']",
                "[role='button']",
                ".mat-mdc-button-base",
                ".mat-mdc-icon-button",
                ".mdc-button",
                ".mat-button",
                ".mat-mdc-unelevated-button",
                ".mat-mdc-outlined-button",
                ".mat-mdc-raised-button"
              ].join(", ")
            )
          : null;

        for (const candidate of [directElement, closestActionable]) {
          if (!candidate || !(candidate instanceof HTMLElement)) {
            continue;
          }

          if (actionableElements.indexOf(candidate) !== -1) {
            continue;
          }

          actionableElements.push(candidate);
        }

        return actionableElements;
      }

      /**
       * 作用：
       * 枚举所有命中某个文本模式的可见候选节点及其可点击祖先。
       *
       * 为什么这样写：
       * Phase A 的关键目标是看清“页面上哪些节点真的带着 “Odśwież” 文本，
       * 它们的可点击祖先是谁、坐标是多少”。把候选全量列出来后，
       * 诊断 JSON 就能直接揭示 selector 漏检还是交互层失效。
       *
       * 输入：
       * @param {RegExp|string} pattern - 目标文本模式。
       * @param {number} limit - 最多返回多少个候选。
       *
       * 输出：
       * @returns {Array<object>} 候选节点、匹配文本、可点击祖先和坐标信息列表。
       *
       * 注意：
       * - 为了保留证据，这里允许返回非按钮节点，但会同时附带可点击祖先。
       * - 结果数量会受到 limit 限制，避免诊断 JSON 膨胀过大。
       */
      function collectPatternCandidates(pattern, limit) {
        const matcher = toRegExp(pattern);
        const candidateList = [];
        const seenKeys = [];
        const maxCount = Math.max(1, Number(limit || 10));

        for (const element of Array.from(document.querySelectorAll("body *"))) {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            continue;
          }

          const matchedTexts = getElementSearchTexts(element).filter((text) => matcher.test(text));

          if (matchedTexts.length === 0) {
            continue;
          }

          const actionableElements = getActionableElements(element);
          const actionableDescriptions = actionableElements.map((candidate) => describeElement(candidate)).filter(Boolean);
          const clickPoint =
            actionableElements
              .map((candidate) => getScreenClickPointForElement(candidate))
              .find((point) => point) || getScreenClickPointForElement(element);
          const candidateKey = [
            element.tagName.toLowerCase(),
            element.getAttribute("id") || "",
            element.getAttribute("class") || "",
            matchedTexts.join("|")
          ].join("::");

          if (seenKeys.indexOf(candidateKey) !== -1) {
            continue;
          }

          seenKeys.push(candidateKey);
          candidateList.push({
            matchedElement: describeElement(element),
            matchedTexts,
            actionableElements,
            actionableDescriptions,
            clickPoint
          });

          if (candidateList.length >= maxCount) {
            break;
          }
        }

        return candidateList;
      }

      /**
       * 作用：
       * 收集当前页面里所有可见可点击控件的基础诊断信息。
       *
       * 为什么这样写：
       * 当 refreshPattern 连一个候选都匹配不到时，最有价值的证据不是继续猜，
       * 而是直接把页面认为“可点击”的控件文本、搜索文本和坐标全部导出来，
       * 这样就能快速判断是正则过严、文本带隐藏字符，还是控件类型压根不在当前扫描范围里。
       *
       * 输入：
       * @param {number} limit - 最多返回多少个可点击控件。
       *
       * 输出：
       * @returns {Array<object>} 页面可见可点击控件的精简诊断列表。
       *
       * 注意：
       * - 这里只收集可见控件，避免噪声节点过多。
       * - 返回值主要服务于 Phase A 诊断，不参与正常业务判断。
       */
      function collectVisibleActionableElements(limit) {
        const maxCount = Math.max(1, Number(limit || 20));
        const actionableElements = Array.from(document.querySelectorAll("body *"))
          .filter((element) => isActionableElement(element) && isVisible(element))
          .filter((element, index, list) => list.indexOf(element) === index)
          .slice(0, maxCount);

        return actionableElements.map((element) => ({
          element: describeElement(element),
          searchTexts: getElementSearchTexts(element),
          clickPoint: getScreenClickPointForElement(element)
        }));
      }

      function getScreenClickPointForElement(element) {
        const actionableElements = getActionableElements(element);
        const targetElement =
          actionableElements.find((candidate) => candidate instanceof HTMLElement && isVisible(candidate)) ||
          (element instanceof HTMLElement && isVisible(element) ? element : null);

        if (!targetElement) {
          return null;
        }

        const rect = targetElement.getBoundingClientRect();
        const viewportLeftInset = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
        const viewportTopInset = Math.max(0, window.outerHeight - window.innerHeight);
        const visualOffsetLeft = window.visualViewport ? Number(window.visualViewport.offsetLeft || 0) : 0;
        const visualOffsetTop = window.visualViewport ? Number(window.visualViewport.offsetTop || 0) : 0;

        return {
          x: Math.round(window.screenX + viewportLeftInset + visualOffsetLeft + rect.left + rect.width / 2),
          y: Math.round(window.screenY + viewportTopInset + visualOffsetTop + rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tagName: targetElement.tagName.toLowerCase()
        };
      }

      function describeElement(element) {
        if (!(element instanceof Element)) {
          return null;
        }

        return {
          tagName: element.tagName.toLowerCase(),
          id: element.getAttribute("id") || "",
          className: String(element.getAttribute("class") || ""),
          role: element.getAttribute("role") || "",
          type: element.getAttribute("type") || "",
          text: String(element.textContent || element.getAttribute("value") || element.getAttribute("aria-label") || "")
            .replace(/\\s+/g, " ")
            .trim(),
          ariaLabel: element.getAttribute("aria-label") || "",
          outerHTML: String(element.outerHTML || "").slice(0, 1500)
        };
      }

      function activateElement(element) {
        const actionableElements = getActionableElements(element);

        if (actionableElements.length === 0) {
          return false;
        }

        for (const candidate of actionableElements) {
          candidate.focus();

          for (const eventName of [
            "pointerdown",
            "mousedown",
            "pointerup",
            "mouseup",
            "click"
          ]) {
            try {
              candidate.dispatchEvent(
                new MouseEvent(eventName, {
                  bubbles: true,
                  cancelable: true,
                  composed: true
                })
              );
            } catch (error) {
              // ignore unsupported synthetic events and continue with the rest
            }
          }

          candidate.click();
        }

        return true;
      }

      function findBestSelect(fieldPattern, optionPattern) {
        const fieldMatcher = toRegExp(fieldPattern);
        const optionMatcher = optionPattern ? toRegExp(optionPattern) : null;
        const candidates = Array.from(document.querySelectorAll("select")).filter(isVisible);

        const scored = candidates
          .map((select) => {
            const contextText = getContextText(select);
            const optionTexts = Array.from(select.options, (option) => normalizeText(option.textContent || ""));
            let score = 0;

            if (fieldMatcher.test(contextText)) {
              score += 10;
            }

            if (optionMatcher && optionTexts.some((text) => optionMatcher.test(text))) {
              score += 6;
            }

            return { select, score };
          })
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score);

        return scored.length ? scored[0].select : null;
      }

      function findBestCustomSelect(fieldPattern) {
        const fieldMatcher = toRegExp(fieldPattern);
        const candidates = Array.from(
          document.querySelectorAll(
            [
              "[role='combobox']",
              "[aria-haspopup='listbox']",
              ".mat-mdc-select",
              ".mat-select",
              "mat-select",
              ".mdc-select",
              ".mat-mdc-form-field-infix",
              ".mat-form-field-infix"
            ].join(", ")
          )
        )
          .filter(isVisible)
          .map((element) => {
            const trigger =
              element.matches("[role='combobox'], [aria-haspopup='listbox'], .mat-mdc-select, .mat-select, mat-select, .mdc-select")
                ? element
                : element.querySelector(
                    "[role='combobox'], [aria-haspopup='listbox'], .mat-mdc-select, .mat-select, mat-select, .mdc-select"
                  );

            return trigger;
          })
          .filter((element, index, list) => element && list.indexOf(element) === index)
          .map((trigger) => {
            const contextText = getContextText(trigger);
            const score = fieldMatcher.test(contextText) ? 10 : 0;

            return {
              trigger,
              score
            };
          })
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score);

        if (candidates.length) {
          return candidates[0].trigger;
        }

        return findCustomSelectByFieldOrder(fieldPattern);
      }

      /**
       * 作用：
       * 获取当前页面里按视觉垂直顺序排列的自定义下拉触发器列表。
       *
       * 为什么这样写：
       * live 页面里的 mat-select 触发器本身几乎不带标签文本，
       * 所以仅靠上下文文本匹配无法区分 Rodzaj usługi / Lokalizacja / Chcę zarezerwować termin dla / Termin。
       * 这 4 个控件在页面中是稳定按垂直顺序排列的，因此顺序回退是当前页面最可靠的第二识别面。
       *
       * 输入：
       * 无
       *
       * 输出：
       * @returns {Array<HTMLElement>} 按视觉顺序排列的自定义下拉触发器。
       *
       * 注意：
       * - 这里只在文本匹配失败时作为回退路径使用。
       * - 排序同时考虑 top 和 left，避免并列布局时顺序抖动。
       */
      function getOrderedVisibleChoiceTriggers() {
        return Array.from(
          document.querySelectorAll(
            [
              "[role='combobox']",
              "[aria-haspopup='listbox']",
              ".mat-mdc-select",
              ".mat-select",
              "mat-select",
              ".mdc-select"
            ].join(", ")
          )
        )
          .filter((element) => element instanceof HTMLElement && isVisible(element))
          .filter((element, index, list) => list.indexOf(element) === index)
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();

            if (Math.abs(leftRect.top - rightRect.top) > 6) {
              return leftRect.top - rightRect.top;
            }

            return leftRect.left - rightRect.left;
          });
      }

      /**
       * 作用：
       * 把业务字段模式映射到当前固定预约页中的下拉顺序索引。
       *
       * 为什么这样写：
       * 当前页面结构固定为 4 个字段自上而下依次排列。
       * 当 DOM 不给标签上下文时，只能依赖这个稳定顺序把字段和控件重新对应起来。
       *
       * 输入：
       * @param {RegExp|string} fieldPattern - 字段匹配模式。
       *
       * 输出：
       * @returns {number} 对应顺序索引；无法识别时返回 -1。
       *
       * 注意：
       * - 这是当前 Los Angeles Schengen 页的定制回退规则。
       * - 如果字段顺序将来改版，这里必须同步更新。
       */
      function getChoiceFieldOrderIndex(fieldPattern) {
        const matcherSource =
          fieldPattern instanceof RegExp ? String(fieldPattern.source || "") : String(fieldPattern || "");

        if (/rodzaj|service|uslug/i.test(matcherSource)) {
          return 0;
        }

        if (/lokalizacja|location/i.test(matcherSource)) {
          return 1;
        }

        if (/rezerwowac|reserve|people|osob/i.test(matcherSource)) {
          return 2;
        }

        if (/date|data|termin/i.test(matcherSource)) {
          return 3;
        }

        return -1;
      }

      /**
       * 作用：
       * 在文本匹配失败时，按页面固定顺序回退选择自定义下拉触发器。
       *
       * 为什么这样写：
       * 当前 live 页面已经证明：4 个 mat-select 能被看到，但它们附近的上下文文本抓不到。
       * 继续只靠文本会永久 not_found，所以必须用“第 1 个是服务、第 2 个是地点、第 3 个是人数、第 4 个是日期”的回退映射。
       *
       * 输入：
       * @param {RegExp|string} fieldPattern - 字段匹配模式。
       *
       * 输出：
       * @returns {HTMLElement | null} 通过顺序回退命中的触发器。
       *
       * 注意：
       * - 只有在可见自定义下拉数量足够时才会命中。
       * - 这是字段文本回退失败后的保守路径，不应替代文本优先策略。
       */
      function findCustomSelectByFieldOrder(fieldPattern) {
        const orderedTriggers = getOrderedVisibleChoiceTriggers();
        const fieldIndex = getChoiceFieldOrderIndex(fieldPattern);

        if (fieldIndex < 0 || orderedTriggers.length <= fieldIndex) {
          return null;
        }

        return orderedTriggers[fieldIndex];
      }

      function getVisibleChoiceOptions() {
        return Array.from(
          document.querySelectorAll(
            [
              "[role='option']",
              "mat-option",
              ".mat-mdc-option",
              ".mat-option",
              ".mdc-list-item"
            ].join(", ")
          )
        ).filter((element) => isVisible(element) && normalizeText(element.textContent || "") !== "");
      }

      function openChoiceTrigger(trigger) {
        if (!trigger || !(trigger instanceof HTMLElement)) {
          return false;
        }

        return activateElement(trigger);
      }

      function closeChoiceOverlay() {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true
          })
        );
      }

      function selectOptionByText(select, optionPattern) {
        if (!(select instanceof HTMLSelectElement)) {
          return false;
        }

        const matcher = toRegExp(optionPattern);
        const option = Array.from(select.options).find((candidate) => matcher.test(normalizeText(candidate.textContent || "")));

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

      function selectCustomOptionByText(trigger, optionPattern) {
        if (!(trigger instanceof HTMLElement)) {
          return false;
        }

        const matcher = toRegExp(optionPattern);
        openChoiceTrigger(trigger);
        const option = getVisibleChoiceOptions().find((candidate) =>
          matcher.test(normalizeText(candidate.textContent || ""))
        );

        if (!option) {
          closeChoiceOverlay();
          return false;
        }

        option.click();
        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }

      function selectChoiceByText(fieldPattern, optionPattern) {
        const nativeSelect = findBestSelect(fieldPattern, optionPattern);

        if (selectOptionByText(nativeSelect, optionPattern)) {
          return {
            changed: true,
            controlType: "native_select"
          };
        }

        const customTrigger = findBestCustomSelect(fieldPattern);

        if (selectCustomOptionByText(customTrigger, optionPattern)) {
          return {
            changed: true,
            controlType: "custom_select"
          };
        }

        return {
          changed: false,
          controlType: "not_found"
        };
      }

      function getChoiceOptionTextsForField(fieldPattern) {
        const nativeSelect = findBestSelect(fieldPattern, null);

        if (nativeSelect instanceof HTMLSelectElement) {
          return Array.from(nativeSelect.options)
            .map((option) => ({
              value: String(option.value || "").trim(),
              text: normalizeText(option.textContent || "")
            }))
            .filter(
              (option) =>
                option.value !== "" &&
                option.text !== "" &&
                !/select|choose|wybierz/.test(option.text)
            )
            .map((option) => option.text);
        }

        const customTrigger = findBestCustomSelect(fieldPattern);

        if (!(customTrigger instanceof HTMLElement)) {
          return [];
        }

        openChoiceTrigger(customTrigger);
        const optionTexts = getVisibleChoiceOptions()
          .map((option) => normalizeText(option.textContent || ""))
          .filter((text) => text !== "" && !/select|choose|wybierz/.test(text));
        closeChoiceOverlay();
        return optionTexts;
      }

      /**
       * 作用：
       * 读取某个业务字段当前命中的控件、当前值和候选项诊断信息。
       *
       * 为什么这样写：
       * captcha 通过后最难排查的问题已经不再是“有没有页面”，
       * 而是“脚本到底有没有找到对应字段、当前控件是什么、可选项里有什么”。
       * 把这些字段诊断一起带回 Node 后，CLI 就能把 post-captcha 失败定位到具体下拉框。
       *
       * 输入：
       * @param {RegExp|string} fieldPattern - 字段文本匹配模式。
       * @param {boolean} includeOptions - 是否读取该字段的候选项文本。
       *
       * 输出：
       * @returns {object} 单个字段的诊断对象。
       *
       * 注意：
       * - 当前值仅用于诊断，不作为业务真值来源。
       * - includeOptions 对日期字段尤其重要，因为 Termin 的候选项就是可用性证据。
       */
      function inspectChoiceField(fieldPattern, includeOptions) {
        const nativeSelect = findBestSelect(fieldPattern, null);
        const customTrigger = findBestCustomSelect(fieldPattern);
        const activeControl =
          nativeSelect instanceof HTMLSelectElement
            ? nativeSelect
            : customTrigger instanceof HTMLElement
              ? customTrigger
              : null;
        const options = includeOptions ? getChoiceOptionTextsForField(fieldPattern) : [];
        let currentText = "";
        let controlType = "not_found";

        if (nativeSelect instanceof HTMLSelectElement) {
          controlType = "native_select";
          const selectedOption =
            nativeSelect.selectedOptions && nativeSelect.selectedOptions.length > 0
              ? nativeSelect.selectedOptions[0]
              : nativeSelect.options[nativeSelect.selectedIndex] || null;

          currentText = normalizeText(
            selectedOption ? selectedOption.textContent || "" : nativeSelect.value || ""
          );
        } else if (customTrigger instanceof HTMLElement) {
          controlType = "custom_select";
          currentText = normalizeText(customTrigger.textContent || customTrigger.getAttribute("aria-label") || "");
        }

        return {
          found: Boolean(activeControl),
          controlType,
          currentText,
          optionTexts: options,
          contextText: activeControl ? getContextText(activeControl) : "",
          element: activeControl ? describeElement(activeControl) : null
        };
      }

      function findInputByField(pattern) {
        const matcher = toRegExp(pattern);
        const candidates = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), textarea")).filter(isVisible);

        return candidates.find((input) => matcher.test(getContextText(input))) || null;
      }

      function findCaptchaVisual() {
        const image = Array.from(
          document.querySelectorAll(
            "img[src*='captcha'], img[src*='verification'], img[alt*='verification' i], img[alt*='weryfikacja' i]"
          )
        ).find(isVisible);

        if (image) {
          return image;
        }

        return Array.from(document.querySelectorAll("canvas")).find(isVisible) || null;
      }

      function getCaptchaDataUrl() {
        const visual = findCaptchaVisual();

        if (!visual) {
          return "";
        }

        if (visual instanceof HTMLCanvasElement) {
          try {
            return visual.toDataURL("image/png");
          } catch (error) {
            return "";
          }
        }

        if (visual instanceof HTMLImageElement) {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = visual.naturalWidth || visual.width;
            canvas.height = visual.naturalHeight || visual.height;
            const context = canvas.getContext("2d");

            if (!context) {
              return visual.currentSrc || visual.src || "";
            }

            context.drawImage(visual, 0, 0);
            return canvas.toDataURL("image/png");
          } catch (error) {
            return visual.currentSrc || visual.src || "";
          }
        }

        return "";
      }

      function getCaptchaDataVariants() {
        const visual = findCaptchaVisual();

        if (!visual) {
          return [];
        }

        const variants = [];

        function pushVariant(label, dataUrl) {
          const normalizedDataUrl = String(dataUrl || "");

          if (!normalizedDataUrl) {
            return;
          }

          if (variants.some((variant) => variant.dataUrl === normalizedDataUrl)) {
            return;
          }

          variants.push({
            label,
            dataUrl: normalizedDataUrl
          });
        }

        function drawVisualToCanvas(scaleMultiplier) {
          const canvas = document.createElement("canvas");
          const width = Math.max(
            1,
            Math.floor((visual.naturalWidth || visual.width || visual.clientWidth || 0) * scaleMultiplier)
          );
          const height = Math.max(
            1,
            Math.floor((visual.naturalHeight || visual.height || visual.clientHeight || 0) * scaleMultiplier)
          );
          const context = canvas.getContext("2d");

          canvas.width = width;
          canvas.height = height;

          if (!context) {
            return null;
          }

          context.imageSmoothingEnabled = false;
          context.drawImage(visual, 0, 0, width, height);
          return canvas;
        }

        if (visual instanceof HTMLCanvasElement) {
          try {
            pushVariant("raw-canvas", visual.toDataURL("image/png"));
          } catch (error) {
            // ignore and continue to copied/processed variants
          }
        }

        if (visual instanceof HTMLImageElement) {
          pushVariant("raw-image-src", visual.currentSrc || visual.src || "");
        }

        try {
          const copiedCanvas = drawVisualToCanvas(1);

          if (copiedCanvas) {
            pushVariant("copied-canvas", copiedCanvas.toDataURL("image/png"));
          }
        } catch (error) {
          // ignore and continue to processed variants
        }

        try {
          const processedCanvas = drawVisualToCanvas(4);
          const context = processedCanvas ? processedCanvas.getContext("2d") : null;

          if (processedCanvas && context) {
            const imageData = context.getImageData(0, 0, processedCanvas.width, processedCanvas.height);
            const pixels = imageData.data;

            for (let index = 0; index < pixels.length; index += 4) {
              const grayscaleValue = Math.round(
                pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114
              );
              const binaryValue = grayscaleValue >= 175 ? 255 : 0;

              pixels[index] = binaryValue;
              pixels[index + 1] = binaryValue;
              pixels[index + 2] = binaryValue;
              pixels[index + 3] = 255;
            }

            context.putImageData(imageData, 0, 0);
            pushVariant("processed-threshold", processedCanvas.toDataURL("image/png"));
          }
        } catch (error) {
          // ignore because raw variants are still usable
        }

        return variants;
      }

      /**
       * 作用：
       * 从页面正文里提取“当前没有预约号”的最终提示文案。
       *
       * 为什么这样写：
       * live 页面里的这句 Polish 文案可能被换行、非断空格或 Unicode 组合字符打断。
       * 仅靠原始字符串正则会漏掉肉眼已经清楚可见的最终状态。
       * 因此这里同时在原文、空白归一化文本、去重音归一化文本上做匹配，
       * 保证只要页面已经出现这句无号提示，CLI 就能稳定识别到。
       *
       * 输入：
       * @param {string} pageText - 当前页面原始全文本。
       *
       * 输出：
       * @returns {string} 命中的无号提示文案；未命中时返回空串。
       *
       * 注意：
       * - 返回值优先保留用户可见的原始文案，其次才是归一化文案。
       * - 这条逻辑是最终结果识别的关键，不要退回到只匹配原始字符串。
       */
      function getUnavailableMessage(pageText) {
        const rawText = String(pageText || "");
        const normalizedText = normalizeText(rawText);
        const looseText = normalizeLooseText(normalizedText);
        const rawMatch = rawText.match(CONFIG.unavailablePattern);
        const normalizedMatch = normalizedText.match(CONFIG.unavailablePattern);
        const looseMatch = looseText.match(CONFIG.unavailableNormalizedPattern);

        if (rawMatch) {
          return String(rawMatch[0] || "").trim();
        }

        if (normalizedMatch) {
          return String(normalizedMatch[0] || "").trim();
        }

        if (looseMatch) {
          return String(looseMatch[0] || "").trim();
        }

        return "";
      }

      function hasSelectionControls() {
        const fieldPatterns = [
          CONFIG.serviceFieldPattern,
          CONFIG.locationFieldPattern,
          CONFIG.peopleFieldPattern,
          CONFIG.dateFieldPattern
        ];

        return fieldPatterns.some((pattern) => {
          const nativeSelect = findBestSelect(pattern, null);
          const customSelect = findBestCustomSelect(pattern);

          return nativeSelect instanceof Element || customSelect instanceof Element;
        });
      }

      /**
       * 作用：
       * 提取“验证码之后的下拉页字段标签”是否已经出现在页面文本中。
       *
       * 为什么这样写：
       * 真实站点在 captcha 通过后的短时间内，字段标签往往先渲染出来，
       * 但自定义下拉控件本体可能还没完全挂载到当前选择器能命中的状态。
       * 仅靠控件探测会让 CLI 误以为还停留在 captcha 页，继续刷新验证码。
       *
       * 输入：
       * @param {string} pageText - 当前页面全文本。
       *
       * 输出：
       * @returns {object} 字段标签命中情况摘要。
       *
       * 注意：
       * - 这里的标签证据只用于“是否已经过页”的判断，不直接代表控件可操作。
       * - 核心字段至少包括 service、location、people，date 作为补充证据保留。
       */
      function getSelectionLabelEvidence(pageText) {
        const normalizedPageText = normalizeText(pageText);
        const fields = {
          service: CONFIG.serviceFieldPattern.test(normalizedPageText),
          location: CONFIG.locationFieldPattern.test(normalizedPageText),
          people: CONFIG.peopleFieldPattern.test(normalizedPageText),
          date: CONFIG.dateFieldPattern.test(normalizedPageText)
        };
        const matchedFieldCount = Object.values(fields).filter((value) => value === true).length;
        const coreFieldCount = [fields.service, fields.location, fields.people].filter((value) => value === true).length;

        return {
          fields,
          matchedFieldCount,
          coreFieldCount,
          hasStrongEvidence: coreFieldCount >= 3
        };
      }

      function readAvailability() {
        const iframeList = Array.from(document.querySelectorAll("iframe"));
        const hasIncapsulaIframe = iframeList.some((frame) => /_incapsula_resource/i.test(String(frame.getAttribute("src") || "")));
        const pageText = normalizeText(document.body ? document.body.innerText : "");
        const currentPath = String(window.location.pathname || "");
        const unavailableMessage = getUnavailableMessage(document.body ? document.body.innerText : "");
        const selectionControlsPresent = hasSelectionControls();
        const selectionLabelEvidence = getSelectionLabelEvidence(document.body ? document.body.innerText : "");
        const optionTexts = getChoiceOptionTextsForField(CONFIG.dateFieldPattern);

        if (hasIncapsulaIframe || /request unsuccessful|incapsula incident id|imperva/i.test(pageText)) {
          return {
            isAvailable: false,
            reason: "imperva_challenge",
            optionTexts: [],
            unavailabilityText: ""
          };
        }

        /**
         * 作用：
         * 优先把“已经进入下拉页”的证据识别成 selection/date 状态。
         *
         * 为什么这样写：
         * 真实站点在 captcha 通过后，URL 仍可能保留 weryfikacja-obrazkowa。
         * 如果先看路径或页面残余文案，就会把已经进入下一页的状态误判回 captcha_step，
         * 导致 CLI 继续等待或重复提交验证码。
         *
         * 输入：
         * 无
         *
         * 输出：
         * @returns {void} 无返回值。
         *
         * 注意：
         * - 日期选项和下拉控件证据优先级都高于 captcha 路径文本。
         * - 这条顺序是 post-captcha 稳定性的关键，不要随便改回去。
         */
        if (optionTexts.length > 0) {
          return {
            isAvailable: true,
            reason: "date_options_present",
            optionTexts,
            unavailabilityText: unavailableMessage
          };
        }

        if (unavailableMessage) {
          return {
            isAvailable: false,
            reason: "all_dates_reserved",
            optionTexts: [],
            unavailabilityText: unavailableMessage
          };
        }

        if (selectionControlsPresent || selectionLabelEvidence.hasStrongEvidence) {
          return {
            isAvailable: false,
            reason: "selection_step",
            optionTexts: [],
            unavailabilityText: ""
          };
        }

        if (/weryfikacja-obrazkowa/i.test(currentPath) || /characters from image|znaki z obrazka|weryfikacja obrazkowa/i.test(pageText)) {
          return {
            isAvailable: false,
            reason: "captcha_step",
            optionTexts: [],
            unavailabilityText: ""
          };
        }

        if (/\\/placowki\\/126\\/?$/i.test(currentPath) && /register the form|zarejestruj formularz/i.test(pageText)) {
          return {
            isAvailable: false,
            reason: "registration_home",
            optionTexts: [],
            unavailabilityText: ""
          };
        }

        return {
          isAvailable: false,
          reason: "unknown_or_waiting",
          optionTexts: [],
          unavailabilityText: ""
        };
      }

      function fillCaptcha(text) {
        const input = findInputByField(CONFIG.imageVerificationPattern);

        if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
          return false;
        }

        input.focus();
        input.value = String(text || "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      function submitCurrentStep() {
        const button = findClickable(CONFIG.submitPattern);

        if (button) {
          activateElement(button);
          return true;
        }

        const form = document.querySelector("form");

        if (form) {
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          return true;
        }

        return false;
      }

      return {
        activateElement,
        describeElement,
        getActionableElements,
        getScreenClickPointForElement,
        inspectChoiceField,
        normalizeText,
        collectPatternCandidates,
        collectVisibleActionableElements,
        findClickable,
        findBestSelect,
        findBestCustomSelect,
        getChoiceOptionTextsForField,
        getVisibleChoiceOptions,
        openChoiceTrigger,
        selectChoiceByText,
        selectOptionByText,
        selectCustomOptionByText,
        findInputByField,
        getCaptchaDataUrl,
        getCaptchaDataVariants,
        fillCaptcha,
        submitCurrentStep,
        readAvailability,
        getSelectionLabelEvidence,
        CONFIG
      };
    })();
  `;
}

/**
 * 作用：
 * 生成页面动作执行表达式，并把返回值序列化为 JSON 字符串。
 *
 * 为什么这样写：
 * Apple Events 执行 JavaScript 时最稳定的返回格式是字符串，统一序列化后 Node 端更容易解析。
 *
 * 输入：
 * @param {string} actionSource - 具体动作的源码片段。
 *
 * 输出：
 * @returns {string} 可直接在页面执行的表达式源码。
 *
 * 注意：
 * - actionSource 必须是同步代码并返回普通对象。
 * - 发生异常时会在页面内捕获并序列化错误信息。
 */
function buildPageExpression(actionSource) {
  return `
    (() => {
      try {
        ${getPageRuntimeSource()}
        const result = (() => {
          const runtime = window.__POLAND_VISA_RUNTIME__;
          ${actionSource}
        })();
        return JSON.stringify({ ok: true, result });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            message: error && error.message ? error.message : String(error)
          }
        });
      }
    })();
  `;
}

/**
 * 作用：
 * 构造切换到英文界面的页面动作。
 *
 * 为什么这样写：
 * 用户路径基于英文界面，先统一语言能减少后续字段匹配歧义。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 如果页面当前已是英文，应当安全跳过。
 * - 页面改版后，这一步的按钮匹配可能需要微调。
 */
function buildSwitchEnglishAction() {
  return `
    const button = runtime.findClickable(runtime.CONFIG.englishPattern);

    if (button) {
      return {
        changed: true,
        step: "switchEnglish",
        href: button instanceof HTMLAnchorElement ? button.href : ""
      };
    }

    return { changed: false, step: "switchEnglish", href: "" };
  `;
}

/**
 * 作用：
 * 构造按字段和选项文本选择值的页面动作。
 *
 * 为什么这样写：
 * Chrome CLI 需要同时兼容原生 `select` 和页面里的自定义下拉，参数化生成可以避免复制代码。
 *
 * 输入：
 * @param {string} fieldPatternSource - 字段匹配正则源码。
 * @param {string} optionPatternSource - 选项匹配正则源码。
 * @param {string} stepName - 结果中回显的步骤名。
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 参数既可以是正则源码字符串，也可以是运行时表达式，例如 `runtime.CONFIG.locationFieldPattern`。
 * - 如果页面未找到对应字段，本动作会返回 ok:false 风格的业务结果，而不是抛异常。
 */
function buildSelectAction(fieldPatternSource, optionPatternSource, stepName) {
  return `
    const selection = runtime.selectChoiceByText(${fieldPatternSource}, ${optionPatternSource});
    return { changed: selection.changed, controlType: selection.controlType, step: ${JSON.stringify(stepName)} };
  `;
}

/**
 * 作用：
 * 构造点击注册链接的页面动作。
 *
 * 为什么这样写：
 * 注册流程入口通常是链接而不是下拉框，需要单独处理。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 页面若已进入 registration 步骤，未找到链接是允许的。
 * - 匹配文案仍基于英文界面。
 */
function buildOpenRegistrationAction() {
  return `
    const link = runtime.findClickable(runtime.CONFIG.registrationPattern);

    if (link) {
      return {
        changed: true,
        step: "openRegistration",
        href: link instanceof HTMLAnchorElement ? link.href : ""
      };
    }

    return { changed: false, step: "openRegistration", href: "" };
  `;
}

/**
 * 作用：
 * 构造抓取当前页面状态和验证码图像的页面动作。
 *
 * 为什么这样写：
 * CLI 需要把页面状态带回 Node 侧做 OCR、日志和通知，因此要统一采样。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - captchaDataUrl 可能为空字符串，调用方需要做降级处理。
 * - 返回结果应保持为纯 JSON 可序列化对象。
 */
function buildSnapshotAction() {
  return `
    const availability = runtime.readAvailability();
    const captchaInput = runtime.findInputByField(runtime.CONFIG.imageVerificationPattern);
    const selectionDiagnostics = {
      service: runtime.inspectChoiceField(runtime.CONFIG.serviceFieldPattern, true),
      location: runtime.inspectChoiceField(runtime.CONFIG.locationFieldPattern, true),
      people: runtime.inspectChoiceField(runtime.CONFIG.peopleFieldPattern, true),
      date: runtime.inspectChoiceField(runtime.CONFIG.dateFieldPattern, true)
    };
    const pageText = String(document.body ? document.body.innerText : "");
    const selectionLabelEvidence = runtime.getSelectionLabelEvidence(pageText);
    const visibleInputs = Array.from(document.querySelectorAll("input, textarea"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .slice(0, 10)
      .map((element) => ({
        type: element.getAttribute("type") || element.tagName.toLowerCase(),
        name: element.getAttribute("name") || "",
        id: element.getAttribute("id") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || ""
      }));
    const visibleButtons = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .slice(0, 20)
      .map((element) => String(element.textContent || element.getAttribute("value") || "").trim())
      .filter((text) => text !== "");
      return {
        ...availability,
        captchaPresent: Boolean(captchaInput),
      captchaFilled: Boolean(captchaInput && String(captchaInput.value || "").trim().length >= 4),
      captchaDataUrl: runtime.getCaptchaDataUrl(),
      captchaDataVariants: runtime.getCaptchaDataVariants(),
      unavailabilityText: availability.unavailabilityText || "",
      pageUrl: window.location.href,
      title: document.title || "",
      bodyTextSample: pageText.slice(0, 1200),
      bodyTextTailSample: pageText.slice(-1200),
      selectCount: document.querySelectorAll("select").length,
      customSelectCount: document.querySelectorAll("[role='combobox'], [aria-haspopup='listbox'], .mat-mdc-select, .mat-select, mat-select, .mdc-select").length,
      linkCount: document.querySelectorAll("a").length,
      iframeCount: document.querySelectorAll("iframe").length,
      blockedByChallenge: availability.reason === "imperva_challenge",
      inputCount: visibleInputs.length,
      inputHints: visibleInputs,
      buttonTexts: visibleButtons,
      likelyCaptchaError: /bledne|błędne|niepoprawne|incorrect|invalid/i.test(pageText),
      selectionDiagnostics,
      selectionLabelEvidence
    };
  `;
}

/**
 * 作用：
 * 构造填写验证码并提交表单的页面动作。
 *
 * 为什么这样写：
 * 把验证码回填和提交合并成一步，可以减少 CLI 与页面之间的往返次数。
 *
 * 输入：
 * @param {string} captchaText - 已清洗的验证码文本。
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 调用前应先确保 captchaText 已经过滤非法字符。
 * - 页面若不存在验证码输入框，本动作会返回 filled:false。
 */
function buildSubmitWithCaptchaAction(captchaText) {
  return `
    const filled = runtime.fillCaptcha(${JSON.stringify(captchaText)});
    const submitted = filled ? runtime.submitCurrentStep() : false;
    return { filled, submitted, step: "submitWithCaptcha" };
  `;
}

/**
 * 作用：
 * 构造只提交当前步骤的页面动作。
 *
 * 为什么这样写：
 * 当用户已经在 Chrome 页面里手动填好验证码时，CLI 仍需要继续点击 `Dalej`，
 * 但不能再次覆盖已有输入值。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 该动作不会尝试回填任何字段。
 * - 如果当前页面没有可提交按钮，会返回 submitted:false。
 */
function buildSubmitCurrentStepAction() {
  return `
    const submitted = runtime.submitCurrentStep();
    return { submitted, step: "submitCurrentStep" };
  `;
}

/**
 * 作用：
 * 构造刷新验证码图片的页面动作。
 *
 * 为什么这样写：
 * 当 OCR 在当前验证码上始终拿不到 4 位候选值时，继续提交空值没有意义。
 * 单独提供刷新动作后，CLI 可以自动换一张验证码再重试，而不需要人工介入。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 该动作只负责点刷新，不负责提交。
 * - 如果页面未找到刷新按钮，会返回 changed:false。
 */
function buildRefreshCaptchaAction() {
  return `
    const button = runtime.findClickable(runtime.CONFIG.refreshPattern);

    if (button) {
      const changed = runtime.openChoiceTrigger(button);
      return { changed, step: "refreshCaptcha" };
    }

    return { changed: false, step: "refreshCaptcha" };
  `;
}

/**
 * 作用：
 * 构造读取验证码刷新按钮屏幕坐标的页面动作。
 *
 * 为什么这样写：
 * 当页面内 synthetic click 依然不能触发刷新时，CLI 需要退回到真实鼠标点击。
 * 页面侧最清楚按钮在当前窗口中的位置，因此这里直接返回可用于系统点击的中心点。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 页面动作源码。
 *
 * 注意：
 * - 返回的是全局屏幕坐标，不是 DOM 内部坐标。
 * - 找不到刷新按钮时会返回 found:false。
 */
function buildRefreshCaptchaClickPointAction() {
  return `
    const candidates = runtime.collectPatternCandidates(runtime.CONFIG.refreshPattern, 12);
    const button = runtime.findClickable(runtime.CONFIG.refreshPattern);
    const clickPoint = button ? runtime.getScreenClickPointForElement(button) : (candidates[0] ? candidates[0].clickPoint : null);
    const actionableElements = button
      ? runtime.getActionableElements(button).map((element) => runtime.describeElement(element)).filter(Boolean)
      : (candidates[0] ? candidates[0].actionableDescriptions : []);

    return {
      found: Boolean(button && clickPoint),
      clickPoint,
      button: button ? runtime.describeElement(button) : null,
      actionableElements,
      candidates,
      visibleActionableElements: runtime.collectVisibleActionableElements(20),
      step: "refreshCaptchaClickPoint"
    };
  `;
}

module.exports = {
  buildOpenRegistrationAction,
  buildPageExpression,
  buildRefreshCaptchaClickPointAction,
  buildRefreshCaptchaAction,
  buildSelectAction,
  buildSnapshotAction,
  buildSubmitCurrentStepAction,
  buildSubmitWithCaptchaAction,
  buildSwitchEnglishAction,
  getPageRuntimeSource,
};
