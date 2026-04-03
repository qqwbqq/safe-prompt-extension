import { DEFAULT_SETTINGS, normalizeApiBaseUrl, PROMPT_TARGETS } from "./shared.js";

const fields = {
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  model: document.querySelector("#model"),
  apiKey: document.querySelector("#apiKey"),
  preferredLanguage: document.querySelector("#preferredLanguage"),
  defaultPromptTarget: document.querySelector("#defaultPromptTarget"),
  maxPageChars: document.querySelector("#maxPageChars"),
  maxVisibleTextChars: document.querySelector("#maxVisibleTextChars"),
  maxCodeChars: document.querySelector("#maxCodeChars"),
  videoFrameCount: document.querySelector("#videoFrameCount"),
  saveBtn: document.querySelector("#saveBtn"),
  saveStatus: document.querySelector("#saveStatus")
};

init().catch((error) => setStatus(error.message, true));

async function init() {
  fields.defaultPromptTarget.innerHTML = PROMPT_TARGETS.map(
    (target) => `<option value="${target.value}">${target.label}</option>`
  ).join("");

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  Object.entries(settings).forEach(([key, value]) => {
    if (fields[key]) {
      fields[key].value = value;
    }
  });

  fields.saveBtn.addEventListener("click", save);
}

async function save() {
  try {
    fields.saveBtn.disabled = true;
    setStatus("正在保存...");

    const payload = {
      apiBaseUrl: normalizeApiBaseUrl(fields.apiBaseUrl.value),
      model: fields.model.value.trim(),
      apiKey: fields.apiKey.value.trim(),
      preferredLanguage: fields.preferredLanguage.value,
      defaultPromptTarget: fields.defaultPromptTarget.value,
      maxPageChars: Number(fields.maxPageChars.value),
      maxVisibleTextChars: Number(fields.maxVisibleTextChars.value),
      maxCodeChars: Number(fields.maxCodeChars.value),
      videoFrameCount: Number(fields.videoFrameCount.value)
    };

    if (!payload.apiBaseUrl) {
      throw new Error("API 地址不能为空。");
    }

    await chrome.storage.sync.set(payload);
    fields.apiBaseUrl.value = payload.apiBaseUrl;
    setStatus("保存成功。现在可以直接使用这个网关。");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    fields.saveBtn.disabled = false;
  }
}

function setStatus(message, isError = false) {
  fields.saveStatus.textContent = message;
  fields.saveStatus.classList.toggle("error", Boolean(isError));
}
