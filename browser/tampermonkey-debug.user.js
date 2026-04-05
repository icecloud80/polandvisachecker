// ==UserScript==
// @name         Tampermonkey Debug For e-Konsulat
// @namespace    https://secure.e-konsulat.gov.pl/
// @version      0.1.0
// @description  Show a visible badge to confirm Tampermonkey is injecting on the Poland visa site.
// @match        https://secure.e-konsulat.gov.pl/*
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /**
   * 作用：
   * 在页面右上角显示一个小徽标，证明用户脚本已经成功注入。
   *
   * 为什么这样写：
   * 当用户反馈 “Tampermonkey 不工作” 时，首先要区分是扩展没注入，还是注入后业务脚本没跑通。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 这个脚本只做注入验证，不做任何业务自动化。
   * - 如果看不到徽标，问题大概率在扩展权限或安装流程，而不是主脚本逻辑。
   */
  function mountBadge() {
    const badge = document.createElement("div");
    badge.textContent = `TM OK: ${window.location.pathname}`;
    badge.style.position = "fixed";
    badge.style.top = "16px";
    badge.style.right = "16px";
    badge.style.zIndex = "999999";
    badge.style.padding = "10px 12px";
    badge.style.borderRadius = "999px";
    badge.style.background = "#166534";
    badge.style.color = "#f0fdf4";
    badge.style.font = "12px/1 -apple-system, BlinkMacSystemFont, sans-serif";
    badge.style.boxShadow = "0 10px 25px rgba(0, 0, 0, 0.18)";
    document.body.appendChild(badge);
    console.log("[tampermonkey-debug] injected on", window.location.href);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBadge, { once: true });
    return;
  }

  mountBadge();
})();
