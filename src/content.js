const quickState = {
  lastContext: null,
  currentContext: null,
  panelOpen: false,
  bundle: null,
  activeKey: "imagePrompt",
  displayLanguage: "zh",
  shadowRoot: null,
  host: null,
  status: "",
  loading: false,
  progress: 0,
  progressTimer: null
};

const SECTION_LABELS = {
  frontendPrompt: "前端",
  uiPrompt: "UI",
  audioVideoPrompt: "音视频",
  imagePrompt: "图片",
  imageEditPrompt: "修图",
  negativePrompt: "限制词"
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "collect-page-context") {
    try {
      sendResponse({ ok: true, data: collectPageContext() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message?.type === "open-quick-prompt-panel") {
    openQuickPromptPanel(message.contextInfo)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

document.addEventListener(
  "contextmenu",
  (event) => {
    quickState.lastContext = extractContextSnapshot(event);
  },
  true
);

async function openQuickPromptPanel(contextInfo) {
  ensurePanel();
  quickState.currentContext = buildQuickContext(contextInfo);
  quickState.panelOpen = true;
  quickState.bundle = null;
  quickState.loading = false;
  quickState.activeKey = pickDefaultSection(quickState.currentContext);
  quickState.status = getIdleStatus(quickState.currentContext, quickState.activeKey);
  stopProgress(false);
  renderPanel();
}

function buildQuickContext(contextInfo) {
  const last = quickState.lastContext || {};
  const kind =
    contextInfo.selectionText?.trim()
      ? "selection"
      : contextInfo.mediaType === "video"
        ? "video"
        : contextInfo.mediaType === "image" || contextInfo.srcUrl
          ? "image"
          : "page";

  return {
    kind,
    pageTitle: document.title,
    pageUrl: location.href,
    selectionText: contextInfo.selectionText?.trim() || last.selectionText || "",
    srcUrl: contextInfo.srcUrl || last.srcUrl || "",
    alt: last.alt || "",
    targetRect: last.targetRect || null,
    targetText: last.targetText || "",
    videoMeta: last.videoMeta || null
  };
}

async function generateQuickPrompt() {
  if (!quickState.currentContext) {
    return;
  }

  quickState.loading = true;
  quickState.status = "正在生成提示词...";
  startProgress();
  renderPanel();

  try {
    const payload = await buildQuickPayload(quickState.currentContext);
    const response = await chrome.runtime.sendMessage({ type: "generate-prompt", payload });

    if (!response?.ok) {
      throw new Error(response?.error || "生成失败。");
    }

    quickState.bundle = response.result;
    quickState.activeKey = pickActiveSection(response.result, quickState.activeKey);
    quickState.status = "生成完成，可直接修改当前提示词。";
    stopProgress(true);
  } catch (error) {
    quickState.status = error.message || "生成失败。";
    stopProgress(false);
  } finally {
    quickState.loading = false;
    renderPanel();
  }
}

async function buildQuickPayload(context) {
  const target = getQuickTargetForSection(context, quickState.activeKey);
  const images = [];
  const summaryLines = [
    `当前对象: ${getContextLabel(context.kind)}`,
    `当前生成类型: ${SECTION_LABELS[quickState.activeKey] || "提示词"}`,
    context.selectionText ? `选中文本: ${context.selectionText}` : "",
    context.targetText ? `附近文本: ${context.targetText}` : "",
    context.alt ? `图片 alt: ${context.alt}` : ""
  ].filter(Boolean);

  if (context.kind === "image") {
    summaryLines.push(
      "只提取当前图片的图像生成提示词，不要扩展成前端、UI 或视频方案。重点保留主体、姿态、材质、纹理、表面处理、做旧痕迹、印刷感、字体与构图关系。"
    );

    if (canUseRemoteUrl(context.srcUrl)) {
      images.push({ name: "target-image", remoteUrl: context.srcUrl });
    } else {
      const screenshotDataUrl = await captureQuickScreenshot();
      const croppedDataUrl =
        screenshotDataUrl && context.targetRect
          ? await cropScreenshotToRect(screenshotDataUrl, context.targetRect)
          : screenshotDataUrl;
      if (croppedDataUrl) {
        images.push({
          name: "target-image.png",
          dataUrl: await optimizeQuickDataUrl(croppedDataUrl, 1280, "image/png")
        });
      }
    }

    return {
      summaryText: summaryLines.join("\n\n"),
      images,
      mode: "image",
      target: "image_generation",
      quickOnly: true
    };
  }

  if (context.kind === "video") {
    summaryLines.push(
      "只提取当前视频区域的音视频提示词，重点关注镜头感、节奏、运动趋势、转场和声音方向。"
    );
    if (context.videoMeta?.currentTime != null) {
      summaryLines.push(`当前时间: ${context.videoMeta.currentTime.toFixed(2)}s`);
    }
    if (context.videoMeta?.duration) {
      summaryLines.push(`总时长: ${context.videoMeta.duration.toFixed(2)}s`);
    }

    const screenshotDataUrl = await captureQuickScreenshot();
    const croppedDataUrl =
      screenshotDataUrl && context.targetRect
        ? await cropScreenshotToRect(screenshotDataUrl, context.targetRect)
        : screenshotDataUrl;
    if (croppedDataUrl) {
      images.push({
        name: "target-video-frame.png",
        dataUrl: await optimizeQuickDataUrl(croppedDataUrl, 1280, "image/png")
      });
    }

    return {
      summaryText: summaryLines.join("\n\n"),
      images,
      mode: "video",
      target: "audio_video",
      quickOnly: true
    };
  }

  const pageContext = createQuickPageSummary(collectPageContext(), context);
  summaryLines.push(
    context.kind === "selection"
      ? "围绕当前选中文本和所在页面结构生成对应提示词。"
      : "围绕当前页面整体结构和视觉风格生成对应提示词。"
  );
  summaryLines.push(`页面摘要:\n${JSON.stringify(pageContext, null, 2)}`);

  const screenshotDataUrl = await captureQuickScreenshot();
  if (screenshotDataUrl) {
    images.push({
      name: "page-view.png",
      dataUrl: await optimizeQuickDataUrl(screenshotDataUrl, 1440, "image/png")
    });
  }

  return {
    summaryText: summaryLines.join("\n\n"),
    images,
    mode: context.kind === "selection" ? "code" : "page",
    target,
    quickOnly: true
  };
}

function pickDefaultSection(context) {
  if (context.kind === "video") {
    return "audioVideoPrompt";
  }

  if (context.kind === "image") {
    return "imagePrompt";
  }

  return "frontendPrompt";
}

function pickActiveSection(bundle, fallbackKey) {
  const keys = getRenderableKeys(bundle, quickState.currentContext);
  return keys.includes(fallbackKey) ? fallbackKey : keys[0] || fallbackKey;
}

function getRenderableKeys(bundle, context) {
  if (Array.isArray(bundle?.displayKeys) && bundle.displayKeys.length) {
    return bundle.displayKeys;
  }

  if (!context) {
    return [];
  }

  if (context.kind === "image") {
    return ["imagePrompt"];
  }

  if (context.kind === "video") {
    return ["audioVideoPrompt"];
  }

  return ["frontendPrompt", "uiPrompt"];
}

function getQuickTargetForSection(context, key) {
  if (context.kind === "image") {
    return "image_generation";
  }

  if (context.kind === "video") {
    return "audio_video";
  }

  return key === "uiPrompt" ? "ui_rebuild" : "frontend_ui";
}

function getIdleStatus(context, key) {
  if (context.kind === "image") {
    return "已锁定当前图片，点击“生成提示词”后只输出图片提示词。";
  }

  if (context.kind === "video") {
    return "已锁定当前视频区域，点击“生成提示词”后只输出音视频提示词。";
  }

  if (key === "uiPrompt") {
    return "已选中 UI 模式，点击“生成提示词”后输出 UI 复刻方向提示词。";
  }

  return "已选中前端模式，点击“生成提示词”后输出前端 / UI 提示词。";
}

function getEditorPlaceholder() {
  if (quickState.loading) {
    return "正在生成提示词...";
  }

  return "先确认上方类型，再点击“生成提示词”。";
}

function getLocalizedBundle(bundle) {
  if (!bundle) {
    return { prompts: {} };
  }

  return {
    prompts:
      bundle.promptVariants?.[quickState.displayLanguage] ||
      bundle.promptVariants?.zh ||
      bundle.prompts ||
      {}
  };
}

function getContextLabel(kind) {
  const mapping = {
    image: "图片",
    video: "视频",
    selection: "选中文本",
    page: "页面"
  };

  return mapping[kind] || kind;
}

function createQuickPageSummary(pageContext, context) {
  const tokenEntries = Object.entries(pageContext.tokens?.cssVariables || {})
    .filter(([name]) => /color|font|radius|space|shadow|surface|bg/i.test(name))
    .slice(0, 16);

  return {
    title: pageContext.title,
    description: pageContext.description,
    url: pageContext.url,
    lang: pageContext.lang,
    viewport: pageContext.viewport,
    headings: pageContext.semantics?.headings?.slice(0, 8) || [],
    buttons: pageContext.semantics?.buttons?.slice(0, 8) || [],
    navItems: pageContext.semantics?.navItems?.slice(0, 8) || [],
    cards: pageContext.semantics?.cards || 0,
    forms: pageContext.semantics?.forms || 0,
    media: pageContext.semantics?.media || {},
    textDensity: pageContext.semantics?.textDensity || {},
    bodyStyle: pageContext.tokens?.body || {},
    designTokens: Object.fromEntries(tokenEntries),
    selectionText: context.selectionText || "",
    visibleTextSnippet: pageContext.visibleText.slice(0, 1200)
  };
}

async function captureQuickScreenshot() {
  const response = await chrome.runtime.sendMessage({ type: "capture-visible-tab" });
  if (!response?.ok || !response.dataUrl) {
    return "";
  }

  return response.dataUrl;
}

function canUseRemoteUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function ensurePanel() {
  if (quickState.host) {
    return;
  }

  const host = document.createElement("div");
  host.id = "safe-prompt-root";
  document.documentElement.appendChild(host);
  quickState.host = host;
  quickState.shadowRoot = host.attachShadow({ mode: "open" });
}

function renderPanel() {
  if (!quickState.shadowRoot) {
    return;
  }

  if (!quickState.panelOpen) {
    quickState.shadowRoot.innerHTML = "";
    return;
  }

  const visibleKeys = getRenderableKeys(quickState.bundle, quickState.currentContext);
  if (!visibleKeys.includes(quickState.activeKey)) {
    quickState.activeKey = visibleKeys[0] || quickState.activeKey;
  }

  const localized = getLocalizedBundle(quickState.bundle);
  const activeValue = localized.prompts?.[quickState.activeKey] || "";
  const sectionTabs = visibleKeys
    .map((key) => {
      const label = SECTION_LABELS[key];
      return `<button class="sp-tab${quickState.activeKey === key ? " is-active" : ""}" data-action="tab" data-key="${key}">${label}</button>`;
    })
    .join("");

  quickState.shadowRoot.innerHTML = `
    <style>${panelStyles()}</style>
    <div class="sp-backdrop"></div>
    <aside class="sp-panel">
      <div class="sp-head">
        <div class="sp-brand">
          <div class="sp-logo">S</div>
          <strong>Safe Prompt</strong>
        </div>
        <button class="sp-icon" data-action="close" aria-label="关闭">×</button>
      </div>
      <p class="sp-status">${escapeHtml(quickState.status || "")}</p>
      <div class="sp-progress"><span style="width:${quickState.progress}%"></span></div>
      <div class="sp-tabs">${sectionTabs}</div>
      <textarea class="sp-editor" data-action="edit" spellcheck="false" placeholder="${escapeHtml(getEditorPlaceholder())}">${escapeHtml(activeValue)}</textarea>
      <div class="sp-footer">
        <div class="sp-lang">
          <button class="sp-lang-btn${quickState.displayLanguage === "en" ? " is-active" : ""}" data-action="lang" data-lang="en">EN</button>
          <button class="sp-lang-btn${quickState.displayLanguage === "zh" ? " is-active" : ""}" data-action="lang" data-lang="zh">中</button>
        </div>
        <div class="sp-actions">
          <button class="sp-primary" data-action="generate" ${quickState.loading ? "disabled" : ""}>${quickState.bundle ? "重新生成" : "生成提示词"}</button>
          <button class="sp-secondary" data-action="copy" ${activeValue ? "" : "disabled"}>复制</button>
          <button class="sp-secondary" data-action="copy-json" ${quickState.bundle ? "" : "disabled"}>JSON</button>
        </div>
      </div>
    </aside>
  `;

  bindPanelEvents();
}

function bindPanelEvents() {
  const root = quickState.shadowRoot;
  root.querySelectorAll("[data-action='tab']").forEach((button) => {
    button.addEventListener("click", () => {
      quickState.activeKey = button.dataset.key;
      if (!quickState.bundle) {
        quickState.status = getIdleStatus(quickState.currentContext, quickState.activeKey);
      }
      renderPanel();
    });
  });

  root.querySelectorAll("[data-action='lang']").forEach((button) => {
    button.addEventListener("click", () => {
      quickState.displayLanguage = button.dataset.lang;
      renderPanel();
    });
  });

  root.querySelector("[data-action='close']")?.addEventListener("click", () => {
    quickState.panelOpen = false;
    stopProgress(false);
    renderPanel();
  });

  root.querySelector("[data-action='generate']")?.addEventListener("click", generateQuickPrompt);

  root.querySelector("[data-action='copy']")?.addEventListener("click", async () => {
    const value = getLocalizedBundle(quickState.bundle).prompts?.[quickState.activeKey] || "";
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    quickState.status = "已复制当前提示词。";
    renderPanel();
  });

  root.querySelector("[data-action='copy-json']")?.addEventListener("click", async () => {
    if (!quickState.bundle) {
      return;
    }

    await navigator.clipboard.writeText(JSON.stringify(quickState.bundle, null, 2));
    quickState.status = "JSON 已复制。";
    renderPanel();
  });

  root.querySelector("[data-action='edit']")?.addEventListener("input", (event) => {
    if (!quickState.bundle) {
      return;
    }

    if (quickState.bundle.promptVariants?.[quickState.displayLanguage]) {
      quickState.bundle.promptVariants[quickState.displayLanguage][quickState.activeKey] = event.target.value;
    }
    quickState.bundle.prompts[quickState.activeKey] = event.target.value;
  });
}

function extractContextSnapshot(event) {
  const target = event.target instanceof Element ? event.target : null;
  const image = target?.closest("img");
  const video = target?.closest("video");
  const rectSource = image || video || target;
  const rect = rectSource?.getBoundingClientRect();

  return {
    kind: image ? "image" : video ? "video" : window.getSelection()?.toString().trim() ? "selection" : "page",
    srcUrl: image?.currentSrc || image?.src || video?.currentSrc || video?.poster || "",
    alt: image?.alt || "",
    selectionText: window.getSelection()?.toString().trim() || "",
    targetText: target?.textContent?.trim().slice(0, 200) || "",
    targetRect: rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 }
      : null,
    videoMeta: video
      ? {
          currentTime: video.currentTime || 0,
          duration: Number.isFinite(video.duration) ? video.duration : 0
        }
      : null
  };
}

async function cropScreenshotToRect(dataUrl, rect) {
  if (!rect?.width || !rect?.height) {
    return "";
  }

  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const scale = rect.dpr || 1;
  const sourceX = Math.max(0, rect.x * scale);
  const sourceY = Math.max(0, rect.y * scale);
  const sourceWidth = Math.max(1, Math.min(image.width - sourceX, rect.width * scale));
  const sourceHeight = Math.max(1, Math.min(image.height - sourceY, rect.height * scale));
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return canvas.toDataURL("image/png");
}

async function optimizeQuickDataUrl(dataUrl, maxEdge, mimeType, quality = 0.92) {
  if (!dataUrl) {
    return "";
  }

  const image = await loadImage(dataUrl);
  const longestEdge = Math.max(image.width, image.height);
  if (longestEdge <= maxEdge && dataUrl.startsWith(`data:${mimeType}`)) {
    return dataUrl;
  }

  const scale = Math.min(1, maxEdge / Math.max(1, longestEdge));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType, quality);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("截图载入失败。"));
    image.src = src;
  });
}

function collectPageContext() {
  const styleTags = Array.from(document.querySelectorAll("style"))
    .map((node) => node.textContent || "")
    .join("\n");

  const visibleNodes = Array.from(document.querySelectorAll("body *")).filter(isVisibleNode);
  const visibleText = visibleNodes
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .slice(0, 500)
    .join("\n");

  return {
    title: document.title,
    url: location.href,
    description: document.querySelector('meta[name="description"]')?.content || "",
    lang: document.documentElement.lang || "",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    tokens: extractDesignTokens(),
    semantics: extractSemantics(visibleNodes),
    html: document.documentElement.outerHTML,
    styleTags,
    visibleText
  };
}

function isVisibleNode(node) {
  const text = node.textContent?.trim();
  if (!text) {
    return false;
  }

  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function extractDesignTokens() {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokenNames = Array.from(computed)
    .filter((name) => name.startsWith("--"))
    .slice(0, 120);

  const cssVariables = tokenNames.reduce((acc, name) => {
    acc[name] = computed.getPropertyValue(name).trim();
    return acc;
  }, {});

  const bodyStyle = getComputedStyle(document.body);

  return {
    cssVariables,
    body: {
      background: bodyStyle.background,
      color: bodyStyle.color,
      fontFamily: bodyStyle.fontFamily,
      fontSize: bodyStyle.fontSize,
      lineHeight: bodyStyle.lineHeight
    }
  };
}

function extractSemantics(visibleNodes) {
  return {
    headings: collectTexts("h1, h2, h3", 12),
    buttons: collectTexts("button, [role='button'], input[type='button'], input[type='submit']", 12),
    navItems: collectTexts("nav a, header a", 16),
    cards: Math.min(
      document.querySelectorAll("section, article, .card, [class*='card'], [class*='panel']").length,
      60
    ),
    forms: document.forms.length,
    media: {
      images: document.images.length,
      videos: document.querySelectorAll("video").length
    },
    textDensity: summarizeTextDensity(visibleNodes)
  };
}

function collectTexts(selector, limit) {
  return Array.from(document.querySelectorAll(selector))
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean)
    .slice(0, limit);
}

function summarizeTextDensity(visibleNodes) {
  const textLengths = visibleNodes
    .map((node) => (node.textContent?.trim().length ? node.textContent.trim().length : 0))
    .filter(Boolean);

  if (!textLengths.length) {
    return { averageLength: 0, longBlocks: 0 };
  }

  const total = textLengths.reduce((sum, value) => sum + value, 0);
  const longBlocks = textLengths.filter((length) => length > 140).length;
  return {
    averageLength: Math.round(total / textLengths.length),
    longBlocks
  };
}

function panelStyles() {
  return `
    :host { all: initial; }
    .sp-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.12);
      z-index: 2147483645;
    }
    .sp-panel {
      position: fixed;
      top: 24px;
      right: 24px;
      width: min(420px, calc(100vw - 32px));
      border-radius: 24px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
      padding: 16px;
      font-family: "Segoe UI Variable", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #102033;
      z-index: 2147483646;
      backdrop-filter: blur(16px);
    }
    .sp-head, .sp-actions, .sp-tabs, .sp-footer {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sp-head {
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .sp-brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sp-brand strong {
      font-size: 15px;
      letter-spacing: 0.02em;
    }
    .sp-logo {
      width: 34px;
      height: 34px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #5eead4, #60a5fa);
      color: #fff;
      font-weight: 700;
    }
    .sp-icon, .sp-tab, .sp-primary, .sp-secondary {
      border: 0;
      cursor: pointer;
      font: inherit;
    }
    .sp-icon {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      background: #eef2ff;
      color: #1e293b;
      font-size: 18px;
    }
    .sp-status {
      margin: 0 0 12px;
      color: #64748b;
      font-size: 13px;
      line-height: 1.5;
    }
    .sp-progress {
      height: 8px;
      border-radius: 999px;
      background: #e9eef6;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .sp-progress span {
      display: block;
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, #34d399, #60a5fa, #a78bfa);
      transition: width 180ms ease;
    }
    .sp-footer {
      justify-content: space-between;
      margin-top: 12px;
      gap: 12px;
    }
    .sp-lang {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(148, 163, 184, 0.28);
      backdrop-filter: blur(10px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.55),
        0 4px 12px rgba(148, 163, 184, 0.12);
    }
    .sp-lang-btn {
      border: 0;
      cursor: pointer;
      border-radius: 999px;
      padding: 8px 12px;
      min-width: 44px;
      background: transparent;
      color: #52627a;
      font: 700 12px/1 inherit;
      letter-spacing: 0.04em;
      transition:
        box-shadow 180ms ease,
        transform 180ms ease,
        background 180ms ease,
        color 180ms ease;
    }
    .sp-lang-btn.is-active {
      background: rgba(255, 255, 255, 0.78);
      color: #203047;
      box-shadow:
        0 6px 16px rgba(96, 120, 160, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.72);
    }
    .sp-lang-btn:hover {
      transform: translateY(-1px);
    }
    .sp-lang-btn:active {
      box-shadow:
        0 10px 20px rgba(96, 120, 160, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.72);
    }
    .sp-tabs {
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .sp-tab {
      padding: 8px 12px;
      border-radius: 999px;
      background: #edf4ff;
      color: #47617d;
    }
    .sp-tab.is-active {
      background: linear-gradient(135deg, #def5ff, #dbe8ff);
      color: #0f172a;
      font-weight: 600;
    }
    .sp-editor {
      width: 100%;
      min-height: 220px;
      resize: vertical;
      border-radius: 18px;
      border: 1px solid #dbe4f0;
      background: #f8fafc;
      color: #0f172a;
      padding: 14px;
      font: 13px/1.7 "IBM Plex Mono", Consolas, monospace;
      box-sizing: border-box;
      outline: none;
    }
    .sp-editor:focus {
      border-color: #93c5fd;
      box-shadow: 0 0 0 3px rgba(147, 197, 253, 0.22);
    }
    .sp-actions {
      justify-content: flex-end;
      margin-top: 0;
      flex-wrap: wrap;
    }
    .sp-primary, .sp-secondary {
      padding: 10px 14px;
      border-radius: 999px;
    }
    .sp-primary {
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      color: white;
    }
    .sp-secondary {
      background: #eef2ff;
      color: #334155;
    }
    .sp-primary:disabled, .sp-secondary:disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }
  `;
}

function startProgress() {
  stopProgress(false);
  quickState.progress = 8;
  quickState.progressTimer = window.setInterval(() => {
    if (!quickState.loading) {
      return;
    }

    quickState.progress = Math.min(92, quickState.progress + (quickState.progress < 60 ? 12 : 4));
    renderPanel();
  }, 280);
}

function stopProgress(complete) {
  if (quickState.progressTimer) {
    window.clearInterval(quickState.progressTimer);
    quickState.progressTimer = null;
  }

  quickState.progress = complete ? 100 : 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
