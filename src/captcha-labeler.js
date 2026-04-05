const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const process = require("node:process");
const { spawn } = require("node:child_process");
const { getArtifactsDir, getCurrentCaptchaLabelsPath, getDataDir } = require("./project-paths");

/**
 * 作用：
 * 从目录名里提取按时间排序用的时间戳后缀。
 *
 * 为什么这样写：
 * 当前数据集目录都采用 `captcha-dataset-时间戳` 或 `captcha-collection-时间戳` 这样的命名规则。
 * 先把时间戳抽出来，后续才能稳定找到“最新一批可标注数据”。
 *
 * 输入：
 * @param {string} directoryName - 数据集目录名。
 *
 * 输出：
 * @returns {number} 可排序的时间戳；无法提取时返回 0。
 *
 * 注意：
 * - 这里只依赖当前项目自己的目录命名约定。
 * - 如果未来目录命名规则变化，需要同步更新测试和文档。
 */
function extractDatasetTimestamp(directoryName) {
  const match = String(directoryName || "").match(/-(\d+)$/);

  if (!match) {
    return 0;
  }

  return Number(match[1] || 0);
}

/**
 * 作用：
 * 在指定根目录中找到最新的一批可标注数据目录。
 *
 * 为什么这样写：
 * 用户大多数时候只想“继续标最新的一批”，不想每次手动复制完整路径。
 * 优先选择去重后的 `captcha-dataset-*` 目录，再回退到原始 `captcha-collection-*` 目录，能减少手工选择成本。
 *
 * 输入：
 * @param {string} rootDirectory - 候选数据根目录。
 *
 * 输出：
 * @returns {string} 最新数据集目录的绝对路径；找不到时返回空字符串。
 *
 * 注意：
 * - 当前优先 `captcha-dataset-*`，因为它已经完成去重整理。
 * - 找不到任何候选目录时，调用方应给出明确报错。
 */
function findLatestDatasetDirectory(rootDirectory) {
  const rootDir = path.resolve(rootDirectory);

  if (!fs.existsSync(rootDir)) {
    return "";
  }

  const directoryEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directoryName = String(entry.name || "");
    let priority = 0;

    if (directoryName.startsWith("captcha-dataset-")) {
      priority = 2;
    } else if (directoryName.startsWith("captcha-collection-")) {
      priority = 1;
    } else {
      continue;
    }

    candidates.push({
      directoryPath: path.join(rootDir, directoryName),
      priority,
      timestamp: extractDatasetTimestamp(directoryName),
    });
  }

  candidates.sort(
    (left, right) => right.priority - left.priority || right.timestamp - left.timestamp
  );

  return candidates[0] ? candidates[0].directoryPath : "";
}

/**
 * 作用：
 * 解析“默认应该打开哪份标注文件”。
 *
 * 为什么这样写：
 * 现在用户已经把所有当前图片整理到了 `captcha-images-current` 总目录里，
 * 所以无参数启动标注器时，最自然的预期就是优先打开这份总清单，而不是旧的数据集目录。
 *
 * 输入：
 * @param {string} dataDir - data 根目录。
 *
 * 输出：
 * @returns {string} 默认应使用的 `labels.json` 绝对路径；找不到时返回空字符串。
 *
 * 注意：
 * - 当前固定优先 `data/captcha-images-current-labels.json`。
 * - 若当前总清单不存在，才回退到 data 目录中的最新数据集清单。
 */
function resolveDefaultLabelManifestPath(dataDir) {
  const rootDir = path.resolve(dataDir);
  const currentManifestPath = path.join(rootDir, path.basename(getCurrentCaptchaLabelsPath()));

  if (fs.existsSync(currentManifestPath)) {
    return currentManifestPath;
  }

  const latestDatasetDirectory = findLatestDatasetDirectory(rootDir);

  if (!latestDatasetDirectory) {
    return "";
  }

  const manifestPath = path.join(latestDatasetDirectory, "labels.json");

  return fs.existsSync(manifestPath) ? manifestPath : "";
}

/**
 * 作用：
 * 把用户提供的数据集输入解析成实际可写的 `labels.json` 路径。
 *
 * 为什么这样写：
 * 标注入口既要支持“直接传 labels.json”，也要支持“传目录”或“什么都不传就用最新数据集”。
 * 统一在这里解析后，服务端逻辑就不用重复处理多种输入形态。
 *
 * 输入：
 * @param {string} datasetInput - 命令行传入的数据集路径或文件路径。
 * @param {string} rootDir - 默认数据根目录。
 *
 * 输出：
 * @returns {string} `labels.json` 的绝对路径。
 *
 * 注意：
 * - 如果传入目录，则默认寻找其中的 `labels.json`。
 * - 如果最终没有找到 manifest，调用方应立即报错而不是延迟到浏览器交互阶段。
 */
function resolveLabelManifestPath(datasetInput, rootDir) {
  const normalizedInput = String(datasetInput || "").trim();
  let candidatePath = "";

  if (normalizedInput) {
    candidatePath = path.resolve(process.cwd(), normalizedInput);
  } else {
    candidatePath = resolveDefaultLabelManifestPath(rootDir);
  }

  if (!candidatePath) {
    return "";
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
    const manifestPath = path.join(candidatePath, "labels.json");
    return fs.existsSync(manifestPath) ? manifestPath : "";
  }

  return fs.existsSync(candidatePath) ? candidatePath : "";
}

/**
 * 作用：
 * 读取标注清单并做最小结构校验。
 *
 * 为什么这样写：
 * 标注页需要稳定地读取 `labels.json`，如果文件结构异常，最好在服务启动时就报清楚。
 *
 * 输入：
 * @param {string} manifestPath - `labels.json` 文件路径。
 *
 * 输出：
 * @returns {Array<object>} 标注条目数组。
 *
 * 注意：
 * - 当前要求根结构必须是 JSON 数组。
 * - 这里只做轻量校验，不自动修复坏数据。
 */
function readLabelEntries(manifestPath) {
  const fileContent = fs.readFileSync(manifestPath, "utf8");
  const parsedContent = JSON.parse(fileContent);

  if (!Array.isArray(parsedContent)) {
    throw new Error("The label manifest must be a JSON array.");
  }

  return parsedContent;
}

/**
 * 作用：
 * 把标注条目数组回写到 `labels.json`。
 *
 * 为什么这样写：
 * 标注页会频繁保存，单独封装写盘逻辑后更容易复用，也方便测试锁住写盘契约。
 *
 * 输入：
 * @param {string} manifestPath - `labels.json` 文件路径。
 * @param {Array<object>} entries - 当前完整标注条目数组。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 每次保存都覆盖整个文件，保持实现简单可靠。
 * - 当前写出带缩进的 JSON，便于人工偶尔检查。
 */
function writeLabelEntries(manifestPath, entries) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * 作用：
 * 规范化人工标注输入的验证码文本。
 *
 * 为什么这样写：
 * 标注是人工输入，不应像 OCR 一样删掉符号，但仍要去掉用户无意带上的首尾空白。
 *
 * 输入：
 * @param {string} value - 人工输入的验证码文本。
 *
 * 输出：
 * @returns {string} 规范化后的标注文本。
 *
 * 注意：
 * - 不会删除中间的符号字符。
 * - 空字符串是合法状态，表示当前条目尚未标注。
 */
function normalizeLabelText(value) {
  return String(value || "").trim();
}

/**
 * 作用：
 * 统计当前标注进度和推荐起始位置。
 *
 * 为什么这样写：
 * 标注页需要在顶部展示进度，也需要在初次打开时自动跳到第一条未标注记录。
 * 把统计逻辑独立出来后，服务端和测试都能复用同一套规则。
 *
 * 输入：
 * @param {Array<object>} entries - 当前完整标注条目数组。
 *
 * 输出：
 * @returns {object} 包含总数、已标注数、未标注数和下一条未标注索引的摘要对象。
 *
 * 注意：
 * - 判定“已标注”只看 `expectedText` 是否为非空字符串。
 * - 所有条目都已标注时，`nextUnlabeledIndex` 会回退到最后一条。
 */
function summarizeLabelEntries(entries) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const labeledCount = normalizedEntries.filter((entry) => normalizeLabelText(entry.expectedText)).length;
  const unlabeledCount = normalizedEntries.length - labeledCount;
  const nextUnlabeledIndex = normalizedEntries.findIndex(
    (entry) => !normalizeLabelText(entry.expectedText)
  );

  return {
    totalCount: normalizedEntries.length,
    labeledCount,
    unlabeledCount,
    nextUnlabeledIndex:
      nextUnlabeledIndex >= 0
        ? nextUnlabeledIndex
        : Math.max(0, normalizedEntries.length - 1),
  };
}

/**
 * 作用：
 * 把单条标注记录转换成前端可直接消费的安全结构。
 *
 * 为什么这样写：
 * 浏览器只需要有限字段，不需要把整个原始条目对象原样暴露出去。
 * 统一序列化后，前后端契约会更清晰，也便于未来扩展。
 *
 * 输入：
 * @param {object} entry - 单条原始标注记录。
 * @param {number} index - 当前条目在数组中的顺序。
 *
 * 输出：
 * @returns {object} 面向前端的轻量条目对象。
 *
 * 注意：
 * - `imageUrl` 通过 API 路由间接暴露，避免前端直接处理绝对文件系统路径。
 * - 如果原始条目缺少某些字段，这里会给出保守默认值。
 */
function serializeLabelEntry(entry, index) {
  return {
    id: String((entry && entry.id) || `entry-${index + 1}`),
    index,
    expectedText: normalizeLabelText(entry && entry.expectedText),
    ocrText: normalizeLabelText(entry && entry.ocrText),
    ocrConfidence: Number((entry && entry.ocrConfidence) || 0),
    ocrPassLabel: String((entry && entry.ocrPassLabel) || ""),
    ocrIsLikely: Boolean(entry && entry.ocrIsLikely),
    notes: String((entry && entry.notes) || ""),
    imageUrl: `/api/images/${encodeURIComponent(String((entry && entry.id) || `entry-${index + 1}`))}`,
    imagePath: String((entry && entry.imagePath) || (entry && entry.labelImagePath) || ""),
    preferredSourceKind: String((entry && entry.preferredSourceKind) || (entry && entry.refreshMethod) || ""),
    sourceCount: Number((entry && entry.sourceCount) || (entry && entry.variantCount) || 1),
    updatedAt: String((entry && entry.updatedAt) || ""),
  };
}

/**
 * 作用：
 * 更新指定条目的标注内容，并返回新的条目数组。
 *
 * 为什么这样写：
 * 标注页每次只会修改一条记录，单独封装更新逻辑后，保存接口和测试都能共享这套行为。
 *
 * 输入：
 * @param {Array<object>} entries - 原始标注条目数组。
 * @param {string} entryId - 目标条目 ID。
 * @param {object} payload - 需要更新的字段。
 *
 * 输出：
 * @returns {Array<object>} 更新后的新条目数组。
 *
 * 注意：
 * - 只更新 `expectedText`、`notes` 和 `updatedAt`。
 * - 找不到对应条目时会抛错，避免静默写坏数据。
 */
function updateLabelEntries(entries, entryId, payload) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  let found = false;

  const nextEntries = normalizedEntries.map((entry) => {
    if (String((entry && entry.id) || "") !== String(entryId || "")) {
      return entry;
    }

    found = true;

    return {
      ...entry,
      expectedText: normalizeLabelText(payload && payload.expectedText),
      notes: String((payload && payload.notes) || ""),
      updatedAt: new Date().toISOString(),
    };
  });

  if (!found) {
    throw new Error(`Unknown label entry "${entryId}".`);
  }

  return nextEntries;
}

/**
 * 作用：
 * 生成标注页的 HTML 外壳。
 *
 * 为什么这样写：
 * 这个工具只需要一个非常轻量的单页界面，直接内嵌 HTML 能减少额外构建和依赖。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {string} 完整 HTML 文本。
 *
 * 注意：
 * - 页面逻辑集中在内嵌脚本里，不依赖外部打包工具。
 * - UI 文案保持简洁，核心任务是高频标注而不是复杂管理。
 */
function buildLabelerHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Captcha Labeler</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f6fb;
        --panel: #ffffff;
        --text: #172033;
        --muted: #5d6a85;
        --line: #d7dceb;
        --accent: #1d5ef5;
        --accent-soft: #e8efff;
        --success: #1d7a43;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: linear-gradient(180deg, #eef2ff 0%, var(--bg) 100%);
      }
      .shell {
        max-width: 1080px;
        margin: 0 auto;
        padding: 24px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 20px;
      }
      .title h1 {
        margin: 0 0 6px;
        font-size: 28px;
      }
      .title p {
        margin: 0;
        color: var(--muted);
      }
      .stats {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .chip {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 14px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(320px, 1fr) minmax(320px, 360px);
        gap: 20px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 20px;
        box-shadow: 0 20px 45px rgba(23, 32, 51, 0.08);
      }
      .image-wrap {
        min-height: 360px;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top left, #f9fbff 0%, #edf2ff 100%);
        border: 1px dashed var(--line);
        border-radius: 16px;
        padding: 18px;
      }
      .image-wrap img {
        max-width: 100%;
        max-height: 320px;
        image-rendering: pixelated;
        border-radius: 10px;
        box-shadow: 0 14px 32px rgba(23, 32, 51, 0.15);
        background: white;
      }
      .meta {
        margin-top: 14px;
        color: var(--muted);
        font-size: 14px;
        display: grid;
        gap: 6px;
      }
      .field {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      label {
        font-weight: 600;
      }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px 14px;
        font: inherit;
        color: var(--text);
        background: #fff;
      }
      input {
        font-size: 28px;
        letter-spacing: 0.08em;
        text-transform: none;
      }
      textarea {
        min-height: 110px;
        resize: vertical;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }
      button {
        border: 0;
        border-radius: 14px;
        padding: 12px 16px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .primary {
        background: var(--accent);
        color: white;
      }
      .secondary {
        background: var(--accent-soft);
        color: var(--accent);
      }
      .ghost {
        background: #eef2f9;
        color: var(--text);
      }
      .status {
        margin-top: 14px;
        min-height: 24px;
        color: var(--success);
        font-size: 14px;
      }
      .hint {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="header">
        <div class="title">
          <h1>Captcha Labeler</h1>
          <p>Type the captcha, save it, and move to the next image.</p>
        </div>
        <div class="stats" id="stats"></div>
      </div>
      <div class="layout">
        <section class="panel">
          <div class="image-wrap">
            <img id="captcha-image" alt="Current captcha sample" />
          </div>
          <div class="meta" id="meta"></div>
        </section>
        <section class="panel">
          <div class="field">
            <label for="expected-text">Captcha Text</label>
            <input id="expected-text" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label for="notes">Notes</label>
            <textarea id="notes" placeholder="Optional notes"></textarea>
          </div>
          <div class="actions">
            <button class="ghost" id="prev-button" type="button">Previous</button>
            <button class="ghost" id="next-button" type="button">Next</button>
            <button class="secondary" id="save-button" type="button">Save</button>
            <button class="primary" id="save-next-button" type="button">Save & Next</button>
          </div>
          <div class="status" id="status"></div>
          <div class="hint">Shortcut: press Enter inside the text field to save and jump to the next image.</div>
        </section>
      </div>
    </div>
    <script>
      const state = {
        manifestPath: "",
        datasetDir: "",
        entries: [],
        summary: null,
        currentIndex: 0,
      };

      const elements = {
        stats: document.getElementById("stats"),
        meta: document.getElementById("meta"),
        image: document.getElementById("captcha-image"),
        expectedText: document.getElementById("expected-text"),
        notes: document.getElementById("notes"),
        prevButton: document.getElementById("prev-button"),
        nextButton: document.getElementById("next-button"),
        saveButton: document.getElementById("save-button"),
        saveNextButton: document.getElementById("save-next-button"),
        status: document.getElementById("status"),
      };

      function getCurrentEntry() {
        return state.entries[state.currentIndex] || null;
      }

      function setStatus(message, isError = false) {
        elements.status.textContent = message || "";
        elements.status.style.color = isError ? "#b42318" : "#1d7a43";
      }

      function renderStats() {
        const summary = state.summary || { totalCount: 0, labeledCount: 0, unlabeledCount: 0 };
        const chips = [
          "Total: " + summary.totalCount,
          "Labeled: " + summary.labeledCount,
          "Remaining: " + summary.unlabeledCount,
          "Manifest: " + state.manifestPath,
        ];

        elements.stats.innerHTML = chips.map((text) => '<div class="chip">' + text + "</div>").join("");
      }

      function renderEntry() {
        const entry = getCurrentEntry();

        if (!entry) {
          elements.meta.innerHTML = "<div>No entries found.</div>";
          elements.image.removeAttribute("src");
          elements.expectedText.value = "";
          elements.notes.value = "";
          return;
        }

        elements.image.src = entry.imageUrl + "?t=" + encodeURIComponent(entry.updatedAt || Date.now());
        elements.expectedText.value = entry.expectedText || entry.ocrText || "";
        elements.notes.value = entry.notes || "";
        elements.meta.innerHTML = [
          "Entry: " + entry.id + " (" + (entry.index + 1) + " / " + state.entries.length + ")",
          "Source kind: " + (entry.preferredSourceKind || "unknown"),
          "Source count: " + entry.sourceCount,
          "OCR suggestion: " + (entry.ocrText ? entry.ocrText + " (" + Math.round(entry.ocrConfidence || 0) + ")" : "none"),
          "Image path: " + entry.imagePath,
        ].map((line) => "<div>" + line + "</div>").join("");

        elements.prevButton.disabled = state.currentIndex <= 0;
        elements.nextButton.disabled = state.currentIndex >= state.entries.length - 1;
        window.requestAnimationFrame(() => elements.expectedText.focus());
      }

      async function loadState() {
        const response = await fetch("/api/state");
        const payload = await response.json();
        state.manifestPath = payload.manifestPath;
        state.datasetDir = payload.datasetDir;
        state.entries = payload.entries;
        state.summary = payload.summary;
        state.currentIndex = Math.max(0, payload.summary.nextUnlabeledIndex || 0);
        renderStats();
        renderEntry();
      }

      async function saveCurrentEntry(moveNext) {
        const entry = getCurrentEntry();

        if (!entry) {
          return;
        }

        const response = await fetch("/api/entries/" + encodeURIComponent(entry.id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedText: elements.expectedText.value,
            notes: elements.notes.value,
          }),
        });

        const payload = await response.json();

        if (!response.ok) {
          setStatus(payload.error || "Failed to save label.", true);
          return;
        }

        state.entries = payload.entries;
        state.summary = payload.summary;
        const savedIndex = state.entries.findIndex((item) => item.id === entry.id);
        state.currentIndex = savedIndex >= 0 ? savedIndex : state.currentIndex;

        if (moveNext && state.currentIndex < state.entries.length - 1) {
          state.currentIndex += 1;
        }

        renderStats();
        renderEntry();
        setStatus("Saved " + entry.id + ".");
      }

      elements.prevButton.addEventListener("click", () => {
        if (state.currentIndex > 0) {
          state.currentIndex -= 1;
          renderEntry();
          setStatus("");
        }
      });

      elements.nextButton.addEventListener("click", () => {
        if (state.currentIndex < state.entries.length - 1) {
          state.currentIndex += 1;
          renderEntry();
          setStatus("");
        }
      });

      elements.saveButton.addEventListener("click", () => saveCurrentEntry(false));
      elements.saveNextButton.addEventListener("click", () => saveCurrentEntry(true));
      elements.expectedText.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void saveCurrentEntry(true);
        }
      });

      void loadState().catch((error) => {
        setStatus(error.message || String(error), true);
      });
    </script>
  </body>
</html>`;
}

/**
 * 作用：
 * 从请求体中读取 JSON 负载。
 *
 * 为什么这样写：
 * 标注保存接口只需要一个很小的 JSON 请求体，自己读取可以避免为了单页工具引入额外框架。
 *
 * 输入：
 * @param {import("node:http").IncomingMessage} request - HTTP 请求对象。
 *
 * 输出：
 * @returns {Promise<object>} 解析后的 JSON 对象。
 *
 * 注意：
 * - 空请求体会返回空对象。
 * - 如果 JSON 非法，会抛出错误，由上层统一转换成 400 响应。
 */
async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 作用：
 * 把 JSON 数据写回 HTTP 响应。
 *
 * 为什么这样写：
 * 这个服务的所有 API 都返回 JSON，统一输出函数可以减少重复响应头和序列化逻辑。
 *
 * 输入：
 * @param {import("node:http").ServerResponse} response - HTTP 响应对象。
 * @param {number} statusCode - HTTP 状态码。
 * @param {object} payload - 需要返回的 JSON 数据。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前所有响应都使用 UTF-8 JSON。
 * - 这里只负责输出，不处理异常。
 */
function writeJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * 作用：
 * 尝试在本机默认浏览器中打开标注页地址。
 *
 * 为什么这样写：
 * 用户的目标是高频标注，自动打开页面能少一步复制链接的摩擦。
 * 同时把失败吞掉，可以避免在无图形环境里影响服务本身。
 *
 * 输入：
 * @param {string} url - 需要打开的本地标注页地址。
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 当前仅在 macOS 上尝试调用 `open`。
 * - 打开浏览器失败不应导致服务退出。
 */
function tryOpenBrowser(url) {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const child = spawn("open", [url], {
      stdio: "ignore",
      detached: true,
    });

    child.unref();
  } catch (error) {
    void error;
  }
}

/**
 * 作用：
 * 启动本地 captcha 标注服务。
 *
 * 为什么这样写：
 * 这个工具的核心价值是让用户“看图、输入、下一张”形成连续流。
 * 用一个极简本地 HTTP 服务就能提供这套交互，同时继续复用现有 `labels.json` 数据集。
 *
 * 输入：
 * @param {object} options - 服务启动选项。
 * @param {string} options.manifestPath - 标注文件路径。
 * @param {string} options.host - 监听地址。
 * @param {number} options.port - 监听端口，传 0 表示随机端口。
 * @param {boolean} options.openBrowser - 是否自动打开浏览器。
 *
 * 输出：
 * @returns {Promise<object>} 服务对象和访问地址。
 *
 * 注意：
 * - 服务运行期间会频繁写回 `labels.json`。
 * - 该函数不会自己退出，调用方通常需要保持进程前台运行。
 */
async function startCaptchaLabelerServer(options) {
  const manifestPath = path.resolve(String(options.manifestPath || ""));
  const datasetDir = path.dirname(manifestPath);
  const host = String(options.host || "127.0.0.1");
  const port = Number(options.port || 0);
  const html = buildLabelerHtml();

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${host}`);

    try {
      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(html);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        const entries = readLabelEntries(manifestPath);
        const serializedEntries = entries.map((entry, index) => serializeLabelEntry(entry, index));
        const summary = summarizeLabelEntries(entries);

        writeJson(response, 200, {
          manifestPath,
          datasetDir,
          summary,
          entries: serializedEntries,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/images/")) {
        const entryId = decodeURIComponent(requestUrl.pathname.slice("/api/images/".length));
        const entries = readLabelEntries(manifestPath);
        const targetEntry = entries.find((entry) => String((entry && entry.id) || "") === entryId);

        if (!targetEntry) {
          writeJson(response, 404, { error: `Unknown label entry "${entryId}".` });
          return;
        }

        const imagePath = String((targetEntry && targetEntry.imagePath) || (targetEntry && targetEntry.labelImagePath) || "");

        if (!imagePath || !fs.existsSync(imagePath)) {
          writeJson(response, 404, { error: `Image file is missing for "${entryId}".` });
          return;
        }

        response.statusCode = 200;
        response.setHeader("content-type", "image/png");
        fs.createReadStream(imagePath).pipe(response);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname.startsWith("/api/entries/")) {
        const entryId = decodeURIComponent(requestUrl.pathname.slice("/api/entries/".length));
        const payload = await readJsonBody(request);
        const entries = readLabelEntries(manifestPath);
        const nextEntries = updateLabelEntries(entries, entryId, payload);

        writeLabelEntries(manifestPath, nextEntries);

        writeJson(response, 200, {
          ok: true,
          summary: summarizeLabelEntries(nextEntries),
          entries: nextEntries.map((entry, index) => serializeLabelEntry(entry, index)),
        });
        return;
      }

      writeJson(response, 404, { error: "Not found." });
    } catch (error) {
      writeJson(response, 500, {
        error: error && error.message ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const resolvedPort = address && typeof address === "object" ? address.port : port;
  const url = `http://${host}:${resolvedPort}`;

  if (options.openBrowser !== false) {
    tryOpenBrowser(url);
  }

  return {
    server,
    manifestPath,
    datasetDir,
    url,
  };
}

/**
 * 作用：
 * 解析标注器命令行参数。
 *
 * 为什么这样写：
 * 标注器只需要极少量参数，手写解析足够清晰，也避免引入额外 CLI 依赖。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数数组。
 *
 * 输出：
 * @returns {object} 解析后的选项对象。
 *
 * 注意：
 * - 支持 `--dataset`、`--port` 和 `--no-open`。
 * - 未传 `--dataset` 时会自动寻找最新数据集。
 */
function parseLabelerArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const options = {
    datasetInput: "",
    port: 0,
    openBrowser: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");

    if (arg === "--dataset") {
      options.datasetInput = String(args[index + 1] || "");
      index += 1;
      continue;
    }

    if (arg === "--port") {
      options.port = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }

    if (arg === "--no-open") {
      options.openBrowser = false;
    }
  }

  return options;
}

/**
 * 作用：
 * 运行 captcha 标注器主入口。
 *
 * 为什么这样写：
 * 这个入口负责挑选最新数据集、启动本地服务，并把访问地址清晰打印给用户。
 *
 * 输入：
 * @param {string[]} argv - 命令行参数。
 *
 * 输出：
 * @returns {Promise<void>} 服务启动完成后的 Promise。
 *
 * 注意：
 * - 该命令会保持前台运行，直到用户手动结束。
 * - 如果找不到任何数据集，会直接抛错，避免打开空页面。
 */
async function main(argv) {
  const options = parseLabelerArgs(argv);
  const dataDir = getDataDir();
  const artifactsDir = getArtifactsDir();
  const manifestPath =
    resolveLabelManifestPath(options.datasetInput, dataDir) ||
    resolveLabelManifestPath(options.datasetInput, artifactsDir);

  if (!manifestPath) {
    throw new Error("No label manifest was found. Pass --dataset or generate a dataset first.");
  }

  const runtime = await startCaptchaLabelerServer({
    manifestPath,
    host: "127.0.0.1",
    port: options.port,
    openBrowser: options.openBrowser,
  });

  console.log(JSON.stringify({
    ok: true,
    url: runtime.url,
    manifestPath: runtime.manifestPath,
    datasetDir: runtime.datasetDir,
    help: "Keep this process running while you label captchas. Press Ctrl+C to stop the local labeler.",
  }, null, 2));
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildLabelerHtml,
  extractDatasetTimestamp,
  findLatestDatasetDirectory,
  normalizeLabelText,
  parseLabelerArgs,
  readLabelEntries,
  resolveDefaultLabelManifestPath,
  resolveLabelManifestPath,
  startCaptchaLabelerServer,
  summarizeLabelEntries,
  updateLabelEntries,
  writeLabelEntries,
};
