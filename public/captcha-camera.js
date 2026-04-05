/**
 * 作用：
 * 在本地网页里驱动摄像头取景、拍照、上传 OCR 和结果展示。
 *
 * 为什么这样写：
 * 用户需要一个随开即用的浏览器工具来拍摄验证码并识别，而不是手动拼接多个命令。
 *
 * 输入：
 * 无
 *
 * 输出：
 * @returns {void} 无返回值。
 *
 * 注意：
 * - 该脚本运行在本地页面中，依赖浏览器摄像头权限。
 * - 页面只把拍摄结果发送给本地 `127.0.0.1` 服务。
 */
(function () {
  const state = {
    stream: null,
    latestDataUrl: "",
    latestNormalizedText: "",
  };

  const elements = {
    cameraPreview: document.getElementById("cameraPreview"),
    snapshotCanvas: document.getElementById("snapshotCanvas"),
    startCameraBtn: document.getElementById("startCameraBtn"),
    captureBtn: document.getElementById("captureBtn"),
    recognizeBtn: document.getElementById("recognizeBtn"),
    copyBtn: document.getElementById("copyBtn"),
    statusText: document.getElementById("statusText"),
    normalizedText: document.getElementById("normalizedText"),
    rawText: document.getElementById("rawText"),
    confidenceText: document.getElementById("confidenceText"),
  };

  /**
   * 作用：
   * 更新页面上的状态提示。
   *
   * 为什么这样写：
   * 摄像头和 OCR 都是异步流程，清晰的状态文本能减少用户不知道当前进度的焦虑。
   *
   * 输入：
   * @param {string} text - 需要展示的状态文本。
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 状态文本应保持简短。
   * - 错误信息也通过这里显示。
   */
  function setStatus(text) {
    elements.statusText.textContent = text;
  }

  /**
   * 作用：
   * 根据当前状态切换按钮可用性。
   *
   * 为什么这样写：
   * 摄像头、拍照和复制之间有明确前后关系，按钮状态跟着流程变化可以避免无效操作。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 只根据本地状态判断，不依赖服务端返回。
   * - 最新 OCR 结果为空时不允许复制。
   */
  function syncButtons() {
    elements.captureBtn.disabled = !state.stream;
    elements.recognizeBtn.disabled = !state.latestDataUrl;
    elements.copyBtn.disabled = !state.latestNormalizedText;
  }

  /**
   * 作用：
   * 启动浏览器摄像头并绑定到视频预览。
   *
   * 为什么这样写：
   * 浏览器内置的 `getUserMedia` 是当前环境下最通用的拍照入口。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 摄像头启动完成后的 Promise。
   *
   * 注意：
   * - 浏览器会弹权限请求。
   * - 当前优先请求后置环境摄像头，如不可用则由浏览器自行回退。
   */
  async function startCamera() {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
      },
      audio: false,
    });

    elements.cameraPreview.srcObject = state.stream;
    await elements.cameraPreview.play();
    setStatus("Camera is live. Frame the captcha and capture when ready.");
    syncButtons();
  }

  /**
   * 作用：
   * 从视频预览中截取当前帧并保存为 data URL。
   *
   * 为什么这样写：
   * OCR 服务端接口接受 data URL，这种格式对本地页面和 Node 服务都最直接。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 若视频尺寸尚未就绪，应禁止调用。
   * - 截图后不会自动发起 OCR，保留一步人工确认空间。
   */
  function captureFrame() {
    const width = elements.cameraPreview.videoWidth;
    const height = elements.cameraPreview.videoHeight;

    if (!width || !height) {
      throw new Error("Camera frame is not ready yet.");
    }

    elements.snapshotCanvas.width = width;
    elements.snapshotCanvas.height = height;

    const context = elements.snapshotCanvas.getContext("2d");
    context.drawImage(elements.cameraPreview, 0, 0, width, height);
    state.latestDataUrl = elements.snapshotCanvas.toDataURL("image/png");
    setStatus("Frame captured. Run OCR when you are ready.");
    syncButtons();
  }

  /**
   * 作用：
   * 将当前截图发送到本地 OCR 服务并展示结果。
   *
   * 为什么这样写：
   * 将 OCR 放到本地 Node 服务执行，可以复用项目已有的 Tesseract 依赖并减少前端复杂度。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} OCR 请求完成后的 Promise。
   *
   * 注意：
   * - 只有在已有截图时才允许调用。
   * - 请求失败时会抛出结构化错误并在界面显示。
   */
  async function recognizeSnapshot() {
    if (!state.latestDataUrl) {
      throw new Error("Capture a frame before running OCR.");
    }

    setStatus("Recognizing captcha locally...");

    const response = await fetch("/api/ocr", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dataUrl: state.latestDataUrl,
      }),
    });

    const payload = await response.json();

    if (!payload.ok) {
      throw new Error(payload.error || "OCR request failed.");
    }

    state.latestNormalizedText = payload.normalizedText || "";
    elements.normalizedText.textContent = state.latestNormalizedText || "-";
    elements.rawText.textContent = payload.rawText || "-";
    elements.confidenceText.textContent = Number(payload.confidence || 0).toFixed(1);
    setStatus("OCR completed. Review the guess before using it.");
    syncButtons();
  }

  /**
   * 作用：
   * 将最新 OCR 结果复制到系统剪贴板。
   *
   * 为什么这样写：
   * 用户识别完验证码后通常要立刻粘贴到别处，复制按钮能减少来回切换的阻力。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {Promise<void>} 复制完成后的 Promise。
   *
   * 注意：
   * - 剪贴板 API 需要页面处于安全上下文且浏览器允许。
   * - 没有 OCR 结果时不应调用。
   */
  async function copyResult() {
    await navigator.clipboard.writeText(state.latestNormalizedText);
    setStatus("OCR guess copied to clipboard.");
  }

  /**
   * 作用：
   * 绑定页面按钮事件。
   *
   * 为什么这样写：
   * 将事件绑定集中在初始化阶段，便于整体阅读和后续维护。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 事件处理器内部会各自处理异常。
   * - 页面初始化后只需绑定一次。
   */
  function bindEvents() {
    elements.startCameraBtn.addEventListener("click", async () => {
      try {
        await startCamera();
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });

    elements.captureBtn.addEventListener("click", () => {
      try {
        captureFrame();
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });

    elements.recognizeBtn.addEventListener("click", async () => {
      try {
        await recognizeSnapshot();
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });

    elements.copyBtn.addEventListener("click", async () => {
      try {
        await copyResult();
      } catch (error) {
        setStatus(error.message || String(error));
      }
    });
  }

  /**
   * 作用：
   * 初始化页面交互。
   *
   * 为什么这样写：
   * 页面载入时统一设置按钮状态并绑定事件，确保工具一打开就是可交互的。
   *
   * 输入：
   * 无
   *
   * 输出：
   * @returns {void} 无返回值。
   *
   * 注意：
   * - 当前页面不自动打开摄像头，保留用户主动授权动作。
   * - 初始化失败概率很低，因此这里只做同步操作。
   */
  function bootstrap() {
    bindEvents();
    syncButtons();
  }

  bootstrap();
})();
