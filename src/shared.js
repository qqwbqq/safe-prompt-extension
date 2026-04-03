export const DEFAULT_SETTINGS = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  preferredLanguage: "zh-CN",
  defaultPromptTarget: "frontend_ui",
  maxPageChars: 12000,
  maxVisibleTextChars: 3200,
  maxCodeChars: 20000,
  videoFrameCount: 4
};

export const INPUT_TYPES = {
  image: "image",
  page: "page",
  video: "video",
  code: "code"
};

export const PROMPT_TARGETS = [
  { value: "frontend_ui", label: "前端 + UI" },
  { value: "audio_video", label: "音频视频" },
  { value: "image_generation", label: "图像生成" },
  { value: "ui_rebuild", label: "UI 复刻" }
];

export const RESULT_SECTIONS = [
  { key: "frontendPrompt", label: "前端提示词" },
  { key: "uiPrompt", label: "UI 提示词" },
  { key: "audioVideoPrompt", label: "音频视频提示词" },
  { key: "imagePrompt", label: "图像提示词" },
  { key: "imageEditPrompt", label: "修图提示词" },
  { key: "negativePrompt", label: "限制词 / 反向提示词" }
];

export function clampText(value, limit) {
  if (!value) {
    return "";
  }

  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated]` : value;
}

export function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function getOriginPattern(url) {
  const parsed = new URL(normalizeApiBaseUrl(url));
  return `${parsed.origin}/*`;
}

export function normalizeApiBaseUrl(url) {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }

  return trimmed;
}

export function resolveChatCompletionsUrl(url) {
  const base = normalizeApiBaseUrl(url);
  if (!base) {
    return "";
  }

  return `${base}/chat/completions`;
}

export function aspectRatio(width, height) {
  if (!width || !height) {
    return "unknown";
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function greatestCommonDivisor(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);

  while (right) {
    const next = left % right;
    left = right;
    right = next;
  }

  return left || 1;
}
