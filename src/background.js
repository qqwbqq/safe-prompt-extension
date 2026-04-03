import { DEFAULT_SETTINGS, getOriginPattern, resolveChatCompletionsUrl } from "./shared.js";

const QUICK_MENU_ID = "safe-prompt-generate";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== QUICK_MENU_ID || !tab?.id) {
    return;
  }

  openQuickPromptPanel(tab.id, info);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "generate-prompt") {
    handleGeneratePrompt(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "capture-visible-tab") {
    captureVisibleTab(sender.tab?.windowId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ensure-origin-permission") {
    ensureOriginPermission(message.url)
      .then((granted) => sendResponse({ ok: true, granted }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "capture-page-context") {
    capturePageContext(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: QUICK_MENU_ID,
      title: "Use Safe Prompt",
      contexts: ["image", "video", "selection", "page"]
    });
  });
}

async function openQuickPromptPanel(tabId, info) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
  }

  await chrome.tabs.sendMessage(tabId, {
    type: "open-quick-prompt-panel",
    contextInfo: {
      mediaType: info.mediaType || "",
      srcUrl: info.srcUrl || "",
      pageUrl: info.pageUrl || "",
      selectionText: info.selectionText || ""
    }
  });
}

async function captureVisibleTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function handleGeneratePrompt(payload) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置里填写 API Key。");
  }

  if (!settings.apiBaseUrl?.trim()) {
    throw new Error("请先在设置里填写 API 地址。");
  }

  const requestPlan = createRequestPlan(payload, settings.preferredLanguage);
  const response = await fetch(resolveChatCompletionsUrl(settings.apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(buildChatRequest(settings, payload, requestPlan))
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 请求失败: ${response.status} ${body}`);
  }

  const json = await response.json();
  const content = extractResponseContent(json);
  if (!content) {
    throw new Error("AI 没有返回可用内容。");
  }

  return requestPlan.normalize(content);
}

function createRequestPlan(payload, language) {
  const mode = payload?.mode || "page";
  const target = payload?.target || "frontend_ui";
  const quickOnly = Boolean(payload?.quickOnly);

  if (quickOnly && mode === "image") {
    return {
      systemPrompt: createImageOnlySystemPrompt(language),
      normalize: normalizeImageOnlyResult,
      maxTokens: 1000
    };
  }

  if (quickOnly && mode === "video") {
    return {
      systemPrompt: createVideoOnlySystemPrompt(language),
      normalize: normalizeVideoOnlyResult,
      maxTokens: 1200
    };
  }

  if (target === "image_generation" || mode === "image") {
    return {
      systemPrompt: createImageOnlySystemPrompt(language),
      normalize: normalizeImageOnlyResult,
      maxTokens: 1000
    };
  }

  if (target === "audio_video" || mode === "video") {
    return {
      systemPrompt: createVideoOnlySystemPrompt(language),
      normalize: normalizeVideoOnlyResult,
      maxTokens: 1200
    };
  }

  return {
    systemPrompt: createFrontendUiSystemPrompt(language),
    normalize: normalizeFrontendUiResult,
    maxTokens: 1450
  };
}

function buildChatRequest(settings, payload, requestPlan) {
  const userContent = [];

  if (payload.summaryText) {
    userContent.push({ type: "text", text: payload.summaryText });
  }

  for (const image of payload.images || []) {
    if (image.remoteUrl) {
      userContent.push({
        type: "image_url",
        image_url: { url: image.remoteUrl }
      });
      continue;
    }

    if (image.dataUrl) {
      userContent.push({
        type: "image_url",
        image_url: { url: image.dataUrl }
      });
    }
  }

  return {
    model: settings.model,
    temperature: 0.12,
    max_tokens: requestPlan.maxTokens || 1600,
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: requestPlan.systemPrompt }]
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };
}

function createImageOnlySystemPrompt(language) {
  return [
    `You are a meticulous visual prompt engineer. Return the final answer in ${language}.`,
    "Analyze the provided image and return valid JSON only.",
    "The JSON schema:",
    "{",
    '  "zh": {',
    '    "prompt": "A production-ready Chinese image generation prompt, ordered exactly as: Subject, Action/Pose, Details/Appearance, Environment/Background, Lighting/Atmosphere, Style/Camera, Colors, Materials, Aspect Ratio.",',
    '    "edit_prompt": "A Chinese image-editing prompt for Doubao or similar AI retouch tools. It must preserve the original composition, subject identity, pose, framing and key visual relationships while describing editable texture, light, color and finish cues.",',
    '    "analysis": "A short Chinese explanation covering the same fields, with extra attention on texture, material, surface finish, typography relation and style/camera cues."',
    "  },",
    '  "en": {',
    '    "prompt": "A production-ready English image generation prompt, ordered exactly as: Subject, Action/Pose, Details/Appearance, Environment/Background, Lighting/Atmosphere, Style/Camera, Colors, Materials, Aspect Ratio.",',
    '    "edit_prompt": "An English image-editing prompt for Doubao or similar AI retouch tools. It must preserve the original composition, subject identity, pose, framing and key visual relationships while describing editable texture, light, color and finish cues.",',
    '    "analysis": "A short English explanation covering the same fields, with extra attention on texture, material, surface finish, typography relation and style/camera cues."',
    "  },",
    '  "zh_style_tags": ["中文标签1", "中文标签2"],',
    '  "en_style_tags": ["english tag 1", "english tag 2"],',
    '  "json_prompt": {',
    '    "subject": "Main subject.",',
    '    "action_pose": "Action or pose.",',
    '    "details_appearance": "Details, clothing, appearance, accessories or visible design details.",',
    '    "environment_background": "Environment or background.",',
    '    "lighting_atmosphere": "Lighting direction, highlight placement, shadow pattern, contrast and atmosphere.",',
    '    "style_camera": "Art style, design language, camera or lens feeling, and technical visual cues.",',
    '    "colors": ["primary color"],',
    '    "materials": ["material 1"],',
    '    "aspect_ratio": "4:5"',
    "  },",
    '  "negative_prompt_zh": "Short Chinese negative prompt terms.",',
    '  "negative_prompt_en": "Short English negative prompt terms.",',
    '  "confidence": 0.0',
    "}",
    "Rules:",
    "- Return JSON only. No markdown fences.",
    "- Keep prompts directly usable for Midjourney, Flux, SDXL or similar image generation tools.",
    "- Be faithful to visually verifiable facts. Do not invent unseen objects, brands, text content, camera specs, art movements or lighting setups.",
    "- If something is uncertain, use broader wording instead of hallucinating specifics.",
    "- Both zh.prompt and en.prompt must follow this exact order: Subject, Action/Pose, Details/Appearance, Environment/Background, Lighting/Atmosphere, Style/Camera, Colors, Materials, Aspect Ratio.",
    "- Details/Appearance must explicitly preserve visually important micro-details when present: texture, fabric fibers, paper grain, canvas weave, brush trace, halftone dots, distressed edges, scratches, embossing, gloss or matte finish, weathering, print wear, wrinkles, cracks, smoke edges, feather edges, skin texture, metal wear, ceramic glaze, stone roughness, wood grain, and other visible surface clues.",
    "- Lighting/Atmosphere must be specific when the source supports it: identify key light direction, highlight placement, shadow edge hardness or softness, cut-light patterns, rim light, fill ratio, occlusion darkness, specular behavior on skin or metal, exposure roll-off, glow haze and overall contrast mood.",
    "- If the image uses narrow slits of light, blinds, projector-like shapes, side cuts, top-down pools, bounced fill or strong backlight, mention those patterns explicitly instead of saying only dramatic lighting.",
    "- If the image looks like a poster, print, editorial page, album cover, packaging, signage or graphic composition, explain how typography, title blocks, borders, logos or graphic shapes relate to the subject and composition. Do not ignore visible text layout just because the main subject is obvious.",
    "- If the image has aged, vintage, worn, dusty, stained, faded, overprinted or analog characteristics, preserve them. Do not rewrite it into a clean modern CGI render.",
    "- The style/camera part must be richer than generic prompt filler. Mention design language, medium, finish, era cues, framing logic, depth feel, lens feeling, camera distance, crop logic and aesthetic signals only when visually supported.",
    "- zh.edit_prompt and en.edit_prompt must be suitable for image editing or retouch models like Doubao. They must tell the model to preserve the existing image's subject identity, composition, camera crop, pose and major object placement while reproducing the same light pattern, material feel, texture, color mood and local details.",
    "- negative_prompt_zh and negative_prompt_en must actively block the most damaging drift, such as over-clean rendering, wrong light direction, flat light, missing cut-light pattern, plastic skin, generic fantasy treatment, missing print grain, missing distress marks, wrong material feel or wrong typography treatment.",
    "- Return 5 to 8 concise style tags in both Chinese and English.",
    "- Confidence must be a number between 0 and 1."
  ].join("\n");
}

function createFrontendUiSystemPrompt(language) {
  return [
    `You are a senior frontend prompt architect. Return the final answer in ${language}.`,
    "Output strict JSON only.",
    "Schema:",
    "{",
    '  "summary": {',
    '    "zh": "One concise Chinese summary.",',
    '    "en": "One concise English summary."',
    "  },",
    '  "prompts": {',
    '    "zh": {',
    '      "frontendPrompt": "Chinese frontend rebuild prompt.",',
    '      "uiPrompt": "Chinese UI style prompt.",',
    '      "negativePrompt": "Chinese negative prompt."',
    '    },',
    '    "en": {',
    '      "frontendPrompt": "English frontend rebuild prompt.",',
    '      "uiPrompt": "English UI style prompt.",',
    '      "negativePrompt": "English negative prompt."',
    '    }',
    "  },",
    '  "insights": {',
    '    "zh": {',
    '      "layout": "Short Chinese note.",',
    '      "visualStyle": "Short Chinese note.",',
    '      "interaction": "Short Chinese note.",',
    '      "implementation": "Short Chinese note."',
    '    },',
    '    "en": {',
    '      "layout": "Short English note.",',
    '      "visualStyle": "Short English note.",',
    '      "interaction": "Short English note.",',
    '      "implementation": "Short English note."',
    '    }',
    '  },',
    '  "tags": {',
    '    "zh": ["中文标签"],',
    '    "en": ["english tag"]',
    '  },',
    '  "warnings": {',
    '    "zh": ["中文 warning"],',
    '    "en": ["english warning"]',
    '  },',
    '  "confidence": 0.0',
    "}",
    "Rules:",
    "- frontendPrompt must read like a build brief for implementation, not abstract commentary.",
    "- frontendPrompt must explicitly cover: page goal, section order, container width logic, exact layout nesting, grid rhythm, component hierarchy, repeated modules, CTA hierarchy, empty/loading/hover/focus states, responsive behavior, likely data shape, and implementation hints grounded in the source.",
    "- frontendPrompt must preserve visible structure and placement with high fidelity. Do not reinterpret the layout into a different page archetype.",
    "- frontendPrompt must explicitly preserve the visible color system, button style, navbar placement, hero hierarchy, border usage, spacing density and section ordering. If the source shows black CTA buttons, pale gray backgrounds and minimal borders, do not rewrite them into green CTA buttons or a different visual family.",
    "- uiPrompt must be specific about style and task details: exact visible palette direction, contrast level, typography feeling, spacing density, corner radius, border treatment, surface material, card style, shadow depth, icon language, motion tone and hierarchy.",
    "- If color values, CSS variables, tokens, utility classes or obvious palette hints are visible in the source, keep them aligned instead of inventing a new palette.",
    "- If the source clearly uses asymmetry, dense spacing, thin borders, muted backgrounds, monochrome cards, colored accents or specific container widths, keep those choices. Do not simplify them into generic SaaS styling.",
    "- When code is provided, reconstruct according to the code's own visual clues first: color literals, CSS variables, utility classes, spacing utilities, width classes, border classes, sticky headers, button variants and section wrappers. Prioritize these clues over generic assumptions.",
    "- When the source is a screenshot or page, infer task flow, interaction priority and content density conservatively from what is visible.",
    "- Prefer precise structure and concrete nouns over generic praise.",
    "- If code is provided, align implementation notes with the visible stack or syntax patterns instead of rewriting the stack from scratch.",
    "- Chinese and English prompts must express the same structure and same visual decisions, not two different interpretations.",
    "- warnings should only include real risks or ambiguities.",
    "- Confidence must be 0 to 1."
  ].join("\n");
}

function createVideoOnlySystemPrompt(language) {
  return [
    `You are a senior video prompt director. Return the final answer in ${language}.`,
    "Output strict JSON only.",
    "Schema:",
    "{",
    '  "summary": {',
    '    "zh": "One concise Chinese video direction summary.",',
    '    "en": "One concise English video direction summary."',
    '  },',
    '  "prompts": {',
    '    "zh": {',
    '      "audioVideoPrompt": "Chinese video prompt.",',
    '      "negativePrompt": "Chinese negative prompt."',
    '    },',
    '    "en": {',
    '      "audioVideoPrompt": "English video prompt.",',
    '      "negativePrompt": "English negative prompt."',
    '    }',
    "  },",
    '  "insights": {',
    '    "zh": {',
    '      "camera": "Short Chinese note.",',
    '      "sound": "Short Chinese note.",',
    '      "visualStyle": "Short Chinese note."',
    '    },',
    '    "en": {',
    '      "camera": "Short English note.",',
    '      "sound": "Short English note.",',
    '      "visualStyle": "Short English note."',
    '    }',
    "  },",
    '  "tags": {',
    '    "zh": ["中文标签"],',
    '    "en": ["english tag"]',
    '  },',
    '  "warnings": {',
    '    "zh": ["中文 warning"],',
    '    "en": ["english warning"]',
    '  },',
    '  "confidence": 0.0',
    "}",
    "Rules:",
    "- The prompt must be production-usable, not generic prose.",
    "- Describe the sequence as beats or shot progression, not as one vague sentence.",
    "- Be concrete about pacing, shot size changes, camera movement, edit rhythm, transition logic, light quality, atmosphere, sound strategy and music direction.",
    "- Use any provided audio metrics, frame deltas or scene continuity clues.",
    "- If the source looks like motion graphics, UI animation, product ad, slideshow or a static poster being animated, say so clearly instead of pretending it is cinematic live action.",
    "- negativePrompt should block obvious failure modes such as random camera shake, wrong motion energy, irrelevant characters, excessive cinematic grading or mismatched sound design.",
    "- Chinese and English prompts must express the same sequence and same production intent.",
    "- Confidence must be 0 to 1."
  ].join("\n");
}

function extractResponseContent(json) {
  const directMessage = json?.choices?.[0]?.message?.content;
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage.trim();
  }

  if (Array.isArray(directMessage)) {
    return directMessage
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n")
      .trim();
  }

  const outputText = json?.output?.[0]?.content?.[0]?.text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  return "";
}

function normalizeImageOnlyResult(content) {
  const parsed = parseJsonContent(content);
  if (!parsed?.zh?.prompt) {
    throw new Error("图片提示词结果格式不正确。");
  }

  const tags = Array.isArray(parsed.zh_style_tags) ? parsed.zh_style_tags.map(cleanText).filter(Boolean) : [];
  const zhNegativePrompt = cleanText(parsed.negative_prompt_zh || parsed.negative_prompt);
  const enNegativePrompt = cleanText(parsed.negative_prompt_en || parsed.negative_prompt);
  const warnings = zhNegativePrompt ? [zhNegativePrompt] : [];
  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : null;

  return {
    summary: cleanText(parsed.zh.analysis),
    summaryVariants: {
      zh: cleanText(parsed.zh.analysis),
      en: cleanText(parsed.en?.analysis)
    },
    prompts: {
      imagePrompt: cleanText(parsed.zh.prompt),
      imageEditPrompt: cleanText(parsed.zh.edit_prompt),
      negativePrompt: zhNegativePrompt
    },
    promptVariants: {
      zh: {
        imagePrompt: cleanText(parsed.zh.prompt),
        imageEditPrompt: cleanText(parsed.zh.edit_prompt),
        negativePrompt: zhNegativePrompt
      },
      en: {
        imagePrompt: cleanText(parsed.en?.prompt),
        imageEditPrompt: cleanText(parsed.en?.edit_prompt),
        negativePrompt: enNegativePrompt
      }
    },
    insights: {
      visualStyle: cleanText(parsed.zh.analysis)
    },
    insightVariants: {
      zh: {
        visualStyle: cleanText(parsed.zh.analysis)
      },
      en: {
        visualStyle: cleanText(parsed.en?.analysis)
      }
    },
    tags: tags.slice(0, 8),
    tagVariants: {
      zh: tags.slice(0, 8),
      en: toStringArray(parsed.en_style_tags, 8)
    },
    warnings: warnings.filter(Boolean),
    warningVariants: {
      zh: warnings.filter(Boolean),
      en: enNegativePrompt ? [enNegativePrompt] : []
    },
    confidence,
    displayKeys: [
      "imagePrompt",
      ...(parsed.zh?.edit_prompt || parsed.en?.edit_prompt ? ["imageEditPrompt"] : []),
      ...(zhNegativePrompt || enNegativePrompt ? ["negativePrompt"] : [])
    ]
  };
}

function normalizeFrontendUiResult(content) {
  const parsed = parseJsonContent(content);
  if (!parsed?.prompts?.zh?.frontendPrompt && !parsed?.prompts?.zh?.uiPrompt) {
    throw new Error("前端 / UI 提示词结果格式不正确。");
  }

  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : null;
  const promptVariants = normalizePromptVariants(parsed.prompts, ["frontendPrompt", "uiPrompt", "negativePrompt"]);

  return {
    summary: cleanText(parsed.summary?.zh || parsed.summary),
    summaryVariants: normalizeLocalizedStrings(parsed.summary),
    prompts: {
      frontendPrompt: cleanText(promptVariants.zh.frontendPrompt),
      uiPrompt: cleanText(promptVariants.zh.uiPrompt),
      negativePrompt: cleanText(promptVariants.zh.negativePrompt)
    },
    promptVariants,
    insights: {
      layout: cleanText(parsed.insights?.zh?.layout),
      visualStyle: cleanText(parsed.insights?.zh?.visualStyle),
      interaction: cleanText(parsed.insights?.zh?.interaction),
      implementation: cleanText(parsed.insights?.zh?.implementation)
    },
    insightVariants: normalizeInsightVariants(parsed.insights, ["layout", "visualStyle", "interaction", "implementation"]),
    tags: toStringArray(parsed.tags?.zh || parsed.tags, 10),
    tagVariants: normalizeTagVariants(parsed.tags),
    warnings: toStringArray(parsed.warnings?.zh || parsed.warnings, 6),
    warningVariants: normalizeWarningVariants(parsed.warnings),
    confidence,
    displayKeys: [
      ...(promptVariants.zh.frontendPrompt || promptVariants.en.frontendPrompt ? ["frontendPrompt"] : []),
      ...(promptVariants.zh.uiPrompt || promptVariants.en.uiPrompt ? ["uiPrompt"] : []),
      ...(promptVariants.zh.negativePrompt || promptVariants.en.negativePrompt ? ["negativePrompt"] : [])
    ]
  };
}

function normalizeVideoOnlyResult(content) {
  const parsed = parseJsonContent(content);
  if (!parsed?.prompts?.zh?.audioVideoPrompt) {
    throw new Error("视频提示词结果格式不正确。");
  }

  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : null;
  const promptVariants = normalizePromptVariants(parsed.prompts, ["audioVideoPrompt", "negativePrompt"]);

  return {
    summary: cleanText(parsed.summary?.zh || parsed.summary),
    summaryVariants: normalizeLocalizedStrings(parsed.summary),
    prompts: {
      audioVideoPrompt: cleanText(promptVariants.zh.audioVideoPrompt),
      negativePrompt: cleanText(promptVariants.zh.negativePrompt)
    },
    promptVariants,
    insights: {
      camera: cleanText(parsed.insights?.zh?.camera),
      sound: cleanText(parsed.insights?.zh?.sound),
      visualStyle: cleanText(parsed.insights?.zh?.visualStyle)
    },
    insightVariants: normalizeInsightVariants(parsed.insights, ["camera", "sound", "visualStyle"]),
    tags: toStringArray(parsed.tags?.zh || parsed.tags, 10),
    tagVariants: normalizeTagVariants(parsed.tags),
    warnings: toStringArray(parsed.warnings?.zh || parsed.warnings, 6),
    warningVariants: normalizeWarningVariants(parsed.warnings),
    confidence,
    displayKeys: [
      ...(promptVariants.zh.audioVideoPrompt || promptVariants.en.audioVideoPrompt ? ["audioVideoPrompt"] : []),
      ...(promptVariants.zh.negativePrompt || promptVariants.en.negativePrompt ? ["negativePrompt"] : [])
    ]
  };
}

function parseJsonContent(content) {
  const candidate = extractJsonCandidate(content);
  if (!candidate) {
    throw new Error("AI 返回的不是可解析 JSON。");
  }

  return JSON.parse(candidate);
}

function extractJsonCandidate(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }

  return trimmed.slice(start, end + 1);
}

function toStringArray(value, limit) {
  return Array.isArray(value)
    ? value.map(cleanText).filter(Boolean).slice(0, limit)
    : [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLocalizedStrings(value) {
  return {
    zh: cleanText(value?.zh || value),
    en: cleanText(value?.en)
  };
}

function normalizePromptVariants(value, keys) {
  const zhSource = value?.zh || {};
  const enSource = value?.en || {};
  const zh = {};
  const en = {};

  keys.forEach((key) => {
    zh[key] = cleanText(zhSource?.[key]);
    en[key] = cleanText(enSource?.[key]);
  });

  return { zh, en };
}

function normalizeInsightVariants(value, keys) {
  const zhSource = value?.zh || {};
  const enSource = value?.en || {};
  const zh = {};
  const en = {};

  keys.forEach((key) => {
    zh[key] = cleanText(zhSource?.[key]);
    en[key] = cleanText(enSource?.[key]);
  });

  return { zh, en };
}

function normalizeTagVariants(value) {
  return {
    zh: toStringArray(value?.zh || value, 10),
    en: toStringArray(value?.en, 10)
  };
}

function normalizeWarningVariants(value) {
  return {
    zh: toStringArray(value?.zh || value, 6),
    en: toStringArray(value?.en, 6)
  };
}

async function ensureOriginPermission(url) {
  const pattern = getOriginPattern(url);
  const existing = await chrome.permissions.contains({ origins: [pattern] });
  if (existing) {
    return true;
  }

  return chrome.permissions.request({ origins: [pattern] });
}

async function capturePageContext(tabId) {
  if (!tabId) {
    throw new Error("没有找到当前标签页。");
  }

  const result = await chrome.tabs.sendMessage(tabId, { type: "collect-page-context" });
  if (!result?.ok) {
    throw new Error(result?.error || "页面上下文采集失败。");
  }

  return result.data;
}
