import {
  aspectRatio,
  clampText,
  DEFAULT_SETTINGS,
  INPUT_TYPES,
  PROMPT_TARGETS,
  RESULT_SECTIONS,
  toDataUrl
} from "./shared.js";

const state = {
  mode: INPUT_TYPES.image,
  pageContext: null,
  pageScreenshotDataUrl: "",
  imageDataUrls: [],
  videoFrames: [],
  videoMeta: null,
  result: null,
  displayLanguage: "zh",
  progress: 0,
  progressTimer: null
};

const els = {
  promptTarget: document.querySelector("#promptTarget"),
  goal: document.querySelector("#goal"),
  imageInput: document.querySelector("#imageInput"),
  imagePreview: document.querySelector("#imagePreview"),
  videoInput: document.querySelector("#videoInput"),
  videoFrames: document.querySelector("#videoFrames"),
  videoMeta: document.querySelector("#videoMeta"),
  codeInput: document.querySelector("#codeInput"),
  pagePreview: document.querySelector("#pagePreview"),
  pageShotPreview: document.querySelector("#pageShotPreview"),
  capturePageBtn: document.querySelector("#capturePageBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  copyJsonBtn: document.querySelector("#copyJsonBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  status: document.querySelector("#status"),
  progressFill: document.querySelector("#progressFill"),
  languageSwitcher: document.querySelector("#languageSwitcher"),
  modeSwitcher: document.querySelector("#modeSwitcher"),
  resultSummary: document.querySelector("#resultSummary"),
  resultTags: document.querySelector("#resultTags"),
  resultSections: document.querySelector("#resultSections"),
  resultInsights: document.querySelector("#resultInsights"),
  resultWarnings: document.querySelector("#resultWarnings")
};

init().catch((error) => setStatus(error.message, true));

async function init() {
  populatePromptTargets();
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  els.promptTarget.value = ensurePromptTarget(settings.defaultPromptTarget);
  bindEvents();
  switchMode(state.mode);
}

function populatePromptTargets() {
  els.promptTarget.innerHTML = PROMPT_TARGETS.map(
    (target) => `<option value="${target.value}">${target.label}</option>`
  ).join("");
}

function bindEvents() {
  els.modeSwitcher.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) {
      return;
    }

    switchMode(button.dataset.mode);
  });

  els.imageInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    state.imageDataUrls = await Promise.all(
      files.map(async (file) => optimizeDataUrl(await toDataUrl(file), 1600, "image/jpeg", 0.9))
    );
    state.result = null;
    clearResultView();
    renderImages(
      state.imageDataUrls.map((dataUrl) => ({ src: dataUrl, caption: "图片" })),
      els.imagePreview
    );
    setStatus(`已载入 ${state.imageDataUrls.length} 张图片。`);
  });

  els.videoInput.addEventListener("change", async (event) => {
    const [file] = Array.from(event.target.files || []);
    if (!file) {
      return;
    }

    try {
      setStatus("正在分析视频...");
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const { frames, meta } = await extractVideoInsights(file, settings.videoFrameCount);
      state.videoFrames = frames;
      state.videoMeta = meta;
      state.result = null;
      clearResultView();
      renderImages(
        frames.map((frame) => ({
          src: frame.dataUrl,
          caption: `${frame.second}s`
        })),
        els.videoFrames
      );
      renderVideoMeta(meta);
      setStatus(`已提取 ${frames.length} 张关键帧。`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  els.capturePageBtn.addEventListener("click", async () => {
    try {
      await capturePage();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  els.generateBtn.addEventListener("click", generatePrompt);
  els.copyBtn.addEventListener("click", copyEntireResult);
  els.copyJsonBtn.addEventListener("click", copyResultJson);
  els.resultSections.addEventListener("click", handleSectionCopy);
  els.resultSections.addEventListener("input", handleSectionEdit);
  els.settingsBtn?.addEventListener("click", openSettingsPage);
  els.languageSwitcher?.addEventListener("click", handleLanguageSwitch);
}

function switchMode(mode, syncTarget = true) {
  state.mode = mode;
  document.querySelectorAll("#modeSwitcher button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === mode);
  });

  if (syncTarget) {
    syncPromptTargetWithMode(mode);
  }
}

async function capturePage() {
  setStatus("正在采集页面信息...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("无法获取当前标签页。");
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"]
    });
  }

  const response = await chrome.runtime.sendMessage({
    type: "capture-page-context",
    tabId: tab.id
  });

  if (!response?.ok) {
    throw new Error(response?.error || "页面采集失败。");
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  state.pageContext = trimPageContext(response.result, settings);
  state.pageScreenshotDataUrl = await capturePageScreenshot(tab.windowId);
  state.result = null;
  clearResultView();
  els.pagePreview.textContent = JSON.stringify(state.pageContext, null, 2);
  els.pagePreview.classList.remove("empty");
  renderImages(
    state.pageScreenshotDataUrl
      ? [{ src: state.pageScreenshotDataUrl, caption: "页面截图" }]
      : [],
    els.pageShotPreview
  );
  setStatus("页面信息采集完成。");
}

function trimPageContext(pageContext, settings) {
  return {
    ...pageContext,
    html: clampText(pageContext.html, settings.maxPageChars),
    styleTags: clampText(pageContext.styleTags, Math.floor(settings.maxPageChars / 2)),
    visibleText: clampText(pageContext.visibleText, settings.maxVisibleTextChars)
  };
}

async function generatePrompt() {
  let completed = false;
  try {
    setStatus("正在生成提示词...");
    els.generateBtn.disabled = true;
    startProgress();
    const payload = await buildPayload();
    const response = await chrome.runtime.sendMessage({ type: "generate-prompt", payload });

    if (!response?.ok) {
      throw new Error(response?.error || "生成失败。");
    }

    state.result = response.result;
    renderResult(response.result);
    setStatus("提示词已生成。");
    completed = true;
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    stopProgress(completed);
    els.generateBtn.disabled = false;
  }
}

async function buildPayload() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const goal = els.goal.value.trim();
  const target = ensurePromptTarget(els.promptTarget.value, state.mode);
  const images = [];
  const summaryLines = [
    `当前素材模式: ${getModeLabel(state.mode)}`,
    `当前生成类型: ${getTargetFocusNote(target)}`,
    goal ? `补充要求: ${goal}` : "",
    getTargetTaskLine(target)
  ].filter(Boolean);

  if (state.mode === INPUT_TYPES.image) {
    if (!state.imageDataUrls.length) {
      throw new Error("请先上传图片。");
    }

    summaryLines.push(
      "仅围绕上传图片本身提取提示词，优先保留主体、动作、材质、纹理、表面处理、做旧痕迹、印刷感、字体与构图关系，不要扩展成网站或视频方案。"
    );
    state.imageDataUrls.slice(0, 3).forEach((dataUrl, index) => {
      images.push({ name: `image-${index + 1}.png`, dataUrl });
    });
  }

  if (state.mode === INPUT_TYPES.video) {
    if (!state.videoFrames.length || !state.videoMeta) {
      throw new Error("请先上传视频。");
    }

    summaryLines.push(buildVideoSummary(state.videoMeta, pickRepresentativeFrames(state.videoFrames)));
    pickRepresentativeFrames(state.videoFrames).forEach((frame, index) => {
      images.push({ name: `video-frame-${index + 1}.jpg`, dataUrl: frame.dataUrl });
    });
  }

  if (state.mode === INPUT_TYPES.page) {
    if (!state.pageContext) {
      throw new Error("请先采集页面。");
    }

    summaryLines.push(
      `页面摘要:\n${JSON.stringify(createPromptPageSummary(state.pageContext, target), null, 2)}`
    );
    if (state.pageScreenshotDataUrl) {
      images.push({ name: "page-screenshot.png", dataUrl: state.pageScreenshotDataUrl });
    }
  }

  if (state.mode === INPUT_TYPES.code) {
    const code = clampText(els.codeInput.value.trim(), settings.maxCodeChars);
    if (!code) {
      throw new Error("请先粘贴代码。");
    }

    summaryLines.push(
      "重建要求：优先保留原代码已经表达出的配色、导航位置、按钮风格、版心宽度、留白密度、分栏关系和模块顺序，不要擅自换成另一套网站风格。"
    );
    summaryLines.push(
      `代码结构线索:\n${JSON.stringify(summarizeCodeHints(code), null, 2)}`
    );
    summaryLines.push("以下是需要分析的前端代码片段，请结合代码结构输出对应提示词。");
    summaryLines.push(`前端代码片段:\n${code}`);
  }

  return {
    summaryText: summaryLines.join("\n\n"),
    images,
    mode: state.mode,
    target
  };
}

function buildVideoSummary(meta, frames) {
  const lines = [
    "",
    "这是一个本地视频的关键帧和媒体分析结果。",
    `文件名: ${meta.fileName}`,
    `时长: ${meta.durationText}`,
    `分辨率: ${meta.width}x${meta.height}`,
    `宽高比: ${meta.aspectRatio}`,
    `关键帧时间点: ${frames.map((frame) => `${frame.second}s`).join(", ")}`,
    `是否检测到音轨: ${meta.hasAudio ? "是" : "否"}`
  ];

  if (meta.audioAnalysis?.available) {
    lines.push(
      `音频声道: ${meta.audioAnalysis.channelCount}`,
      `采样率: ${meta.audioAnalysis.sampleRate} Hz`,
      `平均响度: ${meta.audioAnalysis.averageRms}`,
      `峰值幅度: ${meta.audioAnalysis.peakAmplitude}`,
      `静音占比: ${meta.audioAnalysis.silenceRatio}%`,
      `节奏密度: ${meta.audioAnalysis.onsetsPerMinute} 次/分钟`,
      `估计 BPM: ${meta.audioAnalysis.estimatedPulseBpm || "无"}`,
      `音频画像: ${meta.audioAnalysis.profile}`
    );
  } else if (meta.audioAnalysis?.error) {
    lines.push(`音频分析备注: ${meta.audioAnalysis.error}`);
  }

  if (meta.visualAnalysis) {
    lines.push(
      `平均帧差: ${meta.visualAnalysis.averageDelta}`,
      `峰值帧差: ${meta.visualAnalysis.peakDelta}`,
      `亮度范围: ${meta.visualAnalysis.minLuma} 到 ${meta.visualAnalysis.maxLuma}`,
      `画面节奏: ${meta.visualAnalysis.pacingProfile}`
    );
  }

  return `\n${lines.join("\n")}`;
}

function pickRepresentativeFrames(frames, maxCount = 4) {
  if (frames.length <= maxCount) {
    return frames;
  }

  const indexes = new Set();
  for (let index = 0; index < maxCount; index += 1) {
    const ratio = maxCount === 1 ? 0 : index / (maxCount - 1);
    indexes.add(Math.min(frames.length - 1, Math.round((frames.length - 1) * ratio)));
  }

  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => frames[index]);
}

function createPromptPageSummary(pageContext, target) {
  const headings = pageContext.semantics?.headings?.slice(0, 8) || [];
  const buttons = pageContext.semantics?.buttons?.slice(0, 8) || [];
  const navItems = pageContext.semantics?.navItems?.slice(0, 8) || [];
  const tokenEntries = Object.entries(pageContext.tokens?.cssVariables || {})
    .filter(([name]) => /color|font|radius|space|shadow|surface|bg/i.test(name))
    .slice(0, 18);

  return {
    title: pageContext.title,
    description: pageContext.description,
    lang: pageContext.lang,
    viewport: pageContext.viewport,
    targetFocus: getTargetFocusNote(target),
    headings,
    buttons,
    navItems,
    cards: pageContext.semantics?.cards || 0,
    forms: pageContext.semantics?.forms || 0,
    media: pageContext.semantics?.media || {},
    textDensity: pageContext.semantics?.textDensity || {},
    bodyStyle: pageContext.tokens?.body || {},
    designTokens: Object.fromEntries(tokenEntries),
    visibleTextSnippet: clampText(pageContext.visibleText, 1200)
  };
}

function summarizeCodeHints(code) {
  const hexColors = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
  const rgbColors = [...code.matchAll(/rgba?\([^)]+\)/g)].map((match) => match[0]);
  const gradientHints = [...code.matchAll(/linear-gradient\([^)]+\)|radial-gradient\([^)]+\)/g)].map((match) => match[0]);
  const cssVariables = [...code.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => ({
    name: match[1],
    value: match[2].trim()
  }));
  const framework =
    /className=/.test(code) ? "React / JSX" :
    /<template[\s>]/.test(code) ? "Vue" :
    /@Component|ngFor|ngIf/.test(code) ? "Angular" :
    /class=/.test(code) ? "HTML" :
    "未知";
  const utilityHints = [...code.matchAll(/\b(?:flex|grid|gap-\d+|p-\d+|px-\d+|py-\d+|rounded(?:-[\w/]+)?|shadow(?:-[\w/]+)?|text-[\w/-]+|bg-[\w/-]+)\b/g)]
    .map((match) => match[0])
    .slice(0, 20);
  const widthHints = [...code.matchAll(/\b(?:max-w-[\w/-]+|w-\[[^\]]+\]|w-full|min-h-\[[^\]]+\]|h-\[[^\]]+\]|container)\b/g)]
    .map((match) => match[0])
    .slice(0, 20);
  const borderHints = [...code.matchAll(/\b(?:border(?:-[\w/-]+)?|rounded(?:-[\w/-]+)?|ring(?:-[\w/-]+)?)\b/g)]
    .map((match) => match[0])
    .slice(0, 20);
  const navHints = [...code.matchAll(/\b(?:header|navbar|nav|menu|mega-menu|dropdown|breadcrumb)\b/gi)]
    .map((match) => match[0].toLowerCase())
    .slice(0, 16);
  const buttonVariants = [...code.matchAll(/\b(?:btn[\w-]*|button[\w-]*|primary|secondary|ghost|outline|solid)\b/gi)]
    .map((match) => match[0])
    .slice(0, 20);
  const classNames = [...code.matchAll(/class(?:Name)?=["'`]([^"'`]+)["'`]/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
  const semanticHints = [...code.matchAll(/\b(?:header|nav|aside|main|section|article|footer|dialog|button|card|hero|sidebar|modal|form)\b/gi)]
    .map((match) => match[0].toLowerCase())
    .slice(0, 20);
  const tagOrder = [...code.matchAll(/<(header|nav|main|section|article|footer|aside|form|button|h1|h2|h3)\b/gi)]
    .map((match) => match[1].toLowerCase())
    .slice(0, 24);
  const majorBlocks = [...code.matchAll(/<(header|nav|main|section|article|footer|aside|div)\b[^>]*class(?:Name)?=["'`]([^"'`]+)["'`]/gi)]
    .map((match) => ({
      tag: match[1].toLowerCase(),
      className: match[2].trim()
    }))
    .slice(0, 16);
  const colorPool = [...new Set([...hexColors, ...rgbColors, ...cssVariables.map((item) => item.value)])];

  return {
    framework,
    detectedColors: colorPool.slice(0, 16),
    cssVariables: cssVariables.slice(0, 16),
    gradients: [...new Set(gradientHints)].slice(0, 8),
    utilityHints: [...new Set(utilityHints)].slice(0, 20),
    widthHints: [...new Set(widthHints)].slice(0, 20),
    borderHints: [...new Set(borderHints)].slice(0, 20),
    navHints: [...new Set(navHints)].slice(0, 16),
    buttonVariants: [...new Set(buttonVariants)].slice(0, 20),
    notableClasses: [...new Set(classNames)].slice(0, 28),
    semanticHints: [...new Set(semanticHints)].slice(0, 20),
    tagOrder: [...new Set(tagOrder)].slice(0, 24),
    majorBlocks,
    reconstructionGuard:
      "优先沿用现有代码里能证明的颜色、边框、按钮、导航和容器结构，不要替换成另一套品牌风格。"
  };
}

function getModeLabel(mode) {
  const mapping = {
    [INPUT_TYPES.image]: "图片",
    [INPUT_TYPES.page]: "页面",
    [INPUT_TYPES.video]: "视频",
    [INPUT_TYPES.code]: "代码"
  };

  return mapping[mode] || mode;
}

function getTargetTaskLine(target) {
  const mapping = {
    frontend_ui:
      "只输出前端 / UI 相关结果，重点写清布局结构、组件层级、交互状态、视觉语言与实现约束。",
    audio_video:
      "只输出音频视频提示词，重点写清画面推进、镜头运动、节奏、转场、光线和声音方向。",
    image_generation:
      "输出图片生图提示词和修图提示词，重点写清主体、姿态、细节、纹理、材质、做旧痕迹、光影、颜色和画幅比例。",
    ui_rebuild:
      "只输出偏 UI 复刻的结果，重点写清视觉层级、组件样式、色彩、字体、圆角、阴影和还原细节。"
  };

  return mapping[target] || mapping.frontend_ui;
}

function ensurePromptTarget(target, mode = state.mode) {
  const allowedTargets = new Set(PROMPT_TARGETS.map((item) => item.value));
  if (allowedTargets.has(target) && target !== "bundle_all") {
    return target;
  }

  if (mode === INPUT_TYPES.image) {
    return "image_generation";
  }

  if (mode === INPUT_TYPES.video) {
    return "audio_video";
  }

  return "frontend_ui";
}

function syncPromptTargetWithMode(mode) {
  const nextTarget = ensurePromptTarget(els.promptTarget.value, mode);
  if (mode === INPUT_TYPES.image) {
    els.promptTarget.value = "image_generation";
    return;
  }

  if (mode === INPUT_TYPES.video) {
    els.promptTarget.value = "audio_video";
    return;
  }

  if (nextTarget === "image_generation" || nextTarget === "audio_video") {
    els.promptTarget.value = "frontend_ui";
  }
}

async function extractVideoInsights(file, frameCount) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.load();

  await waitForEvent(video, "loadedmetadata");

  const duration = video.duration || 1;
  const width = Math.max(1, video.videoWidth || 1280);
  const height = Math.max(1, video.videoHeight || 720);
  const frames = [];
  const frameSignals = [];
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1280 / width, 720 / height);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");

  for (let index = 0; index < frameCount; index += 1) {
    const targetTime = duration * ((index + 1) / (frameCount + 1));
    video.currentTime = targetTime;
    await waitForEvent(video, "seeked");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const signal = sampleFrameSignal(imageData);
    const previousSignal = frameSignals.at(-1);
    const delta = previousSignal ? compareFrameSignals(previousSignal, signal) : 0;
    frameSignals.push(signal);

    frames.push({
      second: Number(targetTime.toFixed(2)),
      dataUrl: canvas.toDataURL("image/jpeg", 0.88),
      averageLuma: Number(signal.averageLuma.toFixed(3)),
      delta: Number(delta.toFixed(3))
    });
  }

  const audioAnalysis = await analyzeAudioTrack(file);
  const visualAnalysis = analyzeFrameSequence(frames);
  const meta = {
    fileName: file.name,
    duration,
    durationText: formatDuration(duration),
    width,
    height,
    aspectRatio: aspectRatio(width, height),
    hasAudio:
      audioAnalysis.available ||
      Boolean(video.mozHasAudio) ||
      Number(video.webkitAudioDecodedByteCount) > 0 ||
      Boolean(video.audioTracks?.length),
    audioAnalysis,
    visualAnalysis
  };

  URL.revokeObjectURL(objectUrl);
  return { frames, meta };
}

async function analyzeAudioTrack(file) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return { available: false, error: "当前浏览器不支持 Web Audio API。" };
  }

  let audioContext;

  try {
    const arrayBuffer = await file.arrayBuffer();
    audioContext = new AudioContextCtor();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = mergeToMono(audioBuffer);
    const metrics = analyzeWaveform(mono, audioBuffer.sampleRate);

    return {
      available: true,
      channelCount: audioBuffer.numberOfChannels,
      sampleRate: audioBuffer.sampleRate,
      averageRms: metrics.averageRms.toFixed(3),
      peakAmplitude: metrics.peakAmplitude.toFixed(3),
      silenceRatio: Math.round(metrics.silenceRatio * 100),
      onsetsPerMinute: Math.round(metrics.onsetsPerMinute),
      estimatedPulseBpm: metrics.estimatedPulseBpm,
      profile: metrics.profile
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "音频轨道解码失败。"
    };
  } finally {
    if (audioContext) {
      await audioContext.close().catch(() => {});
    }
  }
}

function mergeToMono(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / channelCount;
    }
  }

  return mono;
}

function analyzeWaveform(data, sampleRate) {
  const windowSize = 2048;
  const rmsValues = [];
  let peakAmplitude = 0;

  for (let offset = 0; offset < data.length; offset += windowSize) {
    let sumSquares = 0;
    const end = Math.min(offset + windowSize, data.length);
    for (let index = offset; index < end; index += 1) {
      const value = data[index];
      peakAmplitude = Math.max(peakAmplitude, Math.abs(value));
      sumSquares += value * value;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, end - offset));
    rmsValues.push(rms);
  }

  const averageRms = average(rmsValues);
  const silenceThreshold = Math.max(0.012, averageRms * 0.28);
  const silenceRatio =
    rmsValues.filter((value) => value < silenceThreshold).length / Math.max(1, rmsValues.length);
  const fluxValues = rmsValues.slice(1).map((value, index) => Math.max(0, value - rmsValues[index]));
  const fluxAverage = average(fluxValues);
  const fluxDeviation = standardDeviation(fluxValues, fluxAverage);
  const onsetThreshold = fluxAverage + fluxDeviation * 1.15;
  const onsetStepSeconds = windowSize / sampleRate;

  let onsets = 0;
  let lastOnsetTime = -Infinity;
  fluxValues.forEach((value, index) => {
    const time = index * onsetStepSeconds;
    if (value > onsetThreshold && time - lastOnsetTime > 0.12) {
      onsets += 1;
      lastOnsetTime = time;
    }
  });

  const durationSeconds = data.length / sampleRate;
  const onsetsPerMinute = durationSeconds ? (onsets / durationSeconds) * 60 : 0;
  const estimatedPulseBpm =
    onsetsPerMinute >= 45 && onsetsPerMinute <= 220 ? Math.round(onsetsPerMinute) : null;

  return {
    averageRms,
    peakAmplitude,
    silenceRatio,
    onsetsPerMinute,
    estimatedPulseBpm,
    profile: classifyAudioProfile({
      averageRms,
      silenceRatio,
      onsetsPerMinute,
      peakAmplitude
    })
  };
}

function classifyAudioProfile({ averageRms, silenceRatio, onsetsPerMinute, peakAmplitude }) {
  const loudness = averageRms > 0.12 ? "响度强" : averageRms > 0.045 ? "响度中等" : "响度柔和";
  const pacing = onsetsPerMinute > 130 ? "节奏快" : onsetsPerMinute > 70 ? "节奏稳定" : "节奏稀疏";
  const space = silenceRatio > 0.45 ? "留白多" : silenceRatio > 0.25 ? "留白适中" : "内容密集";
  const punch = peakAmplitude > 0.85 ? "冲击强" : peakAmplitude > 0.55 ? "控制适中" : "过渡平滑";

  return `${loudness}，${pacing}，${space}，${punch}`;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, mean = average(values)) {
  if (!values.length) {
    return 0;
  }

  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance);
}

function sampleFrameSignal(imageData) {
  const { data, width, height } = imageData;
  const samples = [];
  let lumaTotal = 0;
  const stepX = Math.max(1, Math.floor(width / 24));
  const stepY = Math.max(1, Math.floor(height / 24));

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumaTotal += luma;
      samples.push(luma);
    }
  }

  return {
    samples,
    averageLuma: lumaTotal / Math.max(1, samples.length)
  };
}

function compareFrameSignals(previousSignal, nextSignal) {
  const count = Math.min(previousSignal.samples.length, nextSignal.samples.length);
  let delta = 0;

  for (let index = 0; index < count; index += 1) {
    delta += Math.abs(previousSignal.samples[index] - nextSignal.samples[index]);
  }

  return delta / Math.max(1, count);
}

function analyzeFrameSequence(frames) {
  if (!frames.length) {
    return null;
  }

  const deltas = frames.map((frame) => frame.delta || 0).slice(1);
  const lumas = frames.map((frame) => frame.averageLuma || 0);
  const averageDelta = deltas.length ? average(deltas) : 0;
  const peakDelta = deltas.length ? Math.max(...deltas) : 0;
  const minLuma = Math.min(...lumas);
  const maxLuma = Math.max(...lumas);

  return {
    averageDelta: averageDelta.toFixed(3),
    peakDelta: peakDelta.toFixed(3),
    minLuma: minLuma.toFixed(3),
    maxLuma: maxLuma.toFixed(3),
    pacingProfile:
      peakDelta > 0.16 ? "变化强" : averageDelta > 0.08 ? "变化中等" : "变化较小"
  };
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`媒体处理失败: ${eventName}`));
    };

    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function renderImages(items, container) {
  container.innerHTML = items
    .map(
      ({ src, caption }, index) => `
        <figure class="preview-card-item">
          <img src="${src}" alt="preview-${index + 1}">
          <figcaption>${caption || `素材 ${index + 1}`}</figcaption>
        </figure>
      `
    )
    .join("");
}

function renderVideoMeta(meta) {
  const parts = [
    `时长 ${meta.durationText}`,
    `${meta.width}x${meta.height}`,
    meta.aspectRatio,
    `音轨 ${meta.hasAudio ? "有" : "无"}`
  ];

  if (meta.audioAnalysis?.available) {
    parts.push(`音频 ${meta.audioAnalysis.profile}`);
  }

  if (meta.visualAnalysis) {
    parts.push(`画面 ${meta.visualAnalysis.pacingProfile}`);
  }

  els.videoMeta.textContent = parts.join(" | ");
  els.videoMeta.classList.remove("empty");
}

function renderResult(result) {
  renderLanguageSwitcher();
  const localized = getLocalizedResult(result);
  els.resultSummary.textContent = localized.summary || "没有摘要。";
  els.resultSummary.classList.toggle("empty", !localized.summary);

  const chips = [...(localized.tags || [])];
  if (typeof result.confidence === "number") {
    chips.unshift(`置信度 ${(result.confidence * 100).toFixed(0)}%`);
  }

  els.resultTags.innerHTML = chips
    .map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`)
    .join("");

  const visibleKeys = Array.isArray(result.displayKeys) && result.displayKeys.length
    ? result.displayKeys
    : RESULT_SECTIONS.map(({ key }) => key);

  els.resultSections.innerHTML = RESULT_SECTIONS.filter(({ key }) => visibleKeys.includes(key)).map(({ key, label }) => {
    const value = localized.prompts?.[key] || "";
    if (!value) {
      return "";
    }

    return `
      <article class="result-card">
        <div class="result-card-head">
          <h3>${label}</h3>
          <button type="button" class="mini-button" data-copy-section="${key}">复制</button>
        </div>
        <textarea data-edit-section="${key}" spellcheck="false">${escapeHtml(value)}</textarea>
      </article>
    `;
  }).join("");

  const insightEntries = [
    ["布局", localized.insights?.layout],
    ["视觉", localized.insights?.visualStyle],
    ["交互", localized.insights?.interaction],
    ["镜头", localized.insights?.camera],
    ["声音", localized.insights?.sound],
    ["实现", localized.insights?.implementation]
  ].filter(([, value]) => value);

  els.resultInsights.innerHTML = insightEntries
    .map(
      ([label, value]) => `
        <article class="insight-card">
          <h3>${escapeHtml(label)}</h3>
          <p>${escapeHtml(value)}</p>
        </article>
      `
    )
    .join("");

  els.resultWarnings.innerHTML = (localized.warnings || [])
    .map((warning) => `<p>${escapeHtml(warning)}</p>`)
    .join("");
}

async function handleSectionCopy(event) {
  const button = event.target.closest("[data-copy-section]");
  if (!button || !state.result) {
    return;
  }

  const key = button.dataset.copySection;
  const localized = getLocalizedResult(state.result);
  const value = localized.prompts?.[key];
  if (!value) {
    return;
  }

  await navigator.clipboard.writeText(value);
  setStatus("已复制当前段落。");
}

async function copyEntireResult() {
  if (!state.result) {
    return;
  }

  const localized = getLocalizedResult(state.result);
  const lines = [localized.summary, ""];
  RESULT_SECTIONS.forEach(({ key, label }) => {
    const value = localized.prompts?.[key];
    if (value) {
      lines.push(`## ${label}`);
      lines.push(value);
      lines.push("");
    }
  });

  if (localized.tags?.length) {
    lines.push(`标签: ${localized.tags.join(" / ")}`);
  }

  await navigator.clipboard.writeText(lines.join("\n").trim());
  setStatus("已复制全部结果。");
}

async function copyResultJson() {
  if (!state.result) {
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2));
  setStatus("已复制 JSON。");
}

function handleSectionEdit(event) {
  const textarea = event.target.closest("[data-edit-section]");
  if (!textarea || !state.result) {
    return;
  }

  const key = textarea.dataset.editSection;
  if (state.result.promptVariants?.[state.displayLanguage]) {
    state.result.promptVariants[state.displayLanguage][key] = textarea.value;
  }
  state.result.prompts[key] = textarea.value;
}

function formatDuration(seconds) {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const mins = Math.floor(wholeSeconds / 60);
  const secs = wholeSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function getTargetFocusNote(target) {
  const mapping = {
    frontend_ui: "优先前端结构和 UI 视觉",
    audio_video: "优先镜头节奏和声音设计",
    image_generation: "优先图像生成质量和风格细节",
    ui_rebuild: "优先 UI 复刻和设计细节"
  };

  return mapping[target] || mapping.frontend_ui;
}

function clearResultView() {
  els.resultSummary.textContent = "生成结果会显示在这里。";
  els.resultSummary.classList.add("empty");
  els.resultTags.innerHTML = "";
  els.resultSections.innerHTML = "";
  els.resultInsights.innerHTML = "";
  els.resultWarnings.innerHTML = "";
  renderLanguageSwitcher();
}

async function capturePageScreenshot(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return optimizeDataUrl(dataUrl, 1440, "image/png");
  } catch {
    return "";
  }
}

function openSettingsPage() {
  chrome.runtime.openOptionsPage();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", Boolean(isError));
}

function handleLanguageSwitch(event) {
  const button = event.target.closest("button[data-lang]");
  if (!button) {
    return;
  }

  state.displayLanguage = button.dataset.lang;
  renderLanguageSwitcher();
  if (state.result) {
    renderResult(state.result);
  }
}

function renderLanguageSwitcher() {
  els.languageSwitcher?.querySelectorAll("button[data-lang]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === state.displayLanguage);
  });
}

function getLocalizedResult(result) {
  const lang = state.displayLanguage;
  return {
    summary: result.summaryVariants?.[lang] || result.summaryVariants?.zh || result.summary || "",
    prompts: result.promptVariants?.[lang] || result.promptVariants?.zh || result.prompts || {},
    insights: result.insightVariants?.[lang] || result.insightVariants?.zh || result.insights || {},
    tags: result.tagVariants?.[lang]?.length ? result.tagVariants[lang] : result.tags || [],
    warnings:
      result.warningVariants?.[lang]?.length ? result.warningVariants[lang] : result.warnings || []
  };
}

function startProgress() {
  stopProgress(false);
  state.progress = 8;
  renderProgress();
  state.progressTimer = window.setInterval(() => {
    state.progress = Math.min(92, state.progress + (state.progress < 56 ? 10 : 4));
    renderProgress();
  }, 220);
}

function stopProgress(complete) {
  if (state.progressTimer) {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }

  state.progress = complete ? 100 : 0;
  renderProgress();
}

function renderProgress() {
  if (els.progressFill) {
    els.progressFill.style.width = `${state.progress}%`;
  }
}

async function optimizeDataUrl(dataUrl, maxEdge, mimeType, quality = 0.92) {
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
    image.onerror = () => reject(new Error("图片加载失败，无法压缩素材。"));
    image.src = src;
  });
}
