/* AI 接口契约：统一地址、取消、超时与响应解析。 */
window.QuizAIClient = (() => {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 120000;
  const MODELS_TIMEOUT_MS = 30000;
  const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
  const SETTINGS_KEYS = { config: "quizhub:ai:v1:config", secret: "quizhub:ai:v1:api-key", systemPrompt: "quizhub:ai:v1:system-prompt" };

  function namedError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function normalizeBaseUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) throw new Error("请先填服务商地址。");
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch (_) {
      throw new Error("服务商地址格式不对，应该像 https://api.deepseek.com/v1。");
    }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("服务商地址只支持 HTTP 或 HTTPS。");
    if (url.username || url.password) throw new Error("服务商地址不能带用户名或密码。");
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
    if (url.protocol === "http:" && !loopback) throw new Error("远程接口必须用 HTTPS；HTTP 只允许本机地址。");
    if (url.search || url.hash) throw new Error("服务商地址不能包含查询参数或片段，请填写 API 基地址。");
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/, "");
    return url.toString().replace(/\/+$/, "");
  }

  function normalizeEndpoint(raw) {
    return `${normalizeBaseUrl(raw)}/chat/completions`;
  }

  function abortReason(signal) {
    if (signal.reason instanceof Error) return signal.reason;
    return namedError("AbortError", "已停止请求。");
  }

  function abortable(promise, signal) {
    if (signal.aborted) return Promise.race([promise, Promise.reject(abortReason(signal))]);
    return new Promise((resolve, reject) => {
      const aborted = () => reject(abortReason(signal));
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  async function withSignal(options, defaultTimeout, run) {
    const timeoutMs = options.timeoutMs === undefined ? defaultTimeout : Number(options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("请求超时必须为非负毫秒数；0 表示关闭超时。");
    const controller = new AbortController();
    const external = options.signal;
    const abort = () => controller.abort(external.reason || namedError("AbortError", "已停止请求。"));
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(namedError("TimeoutError", `请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止。可重试或在接口配置中调整超时。`)), timeoutMs) : null;
    try {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    }
  }

  async function fetchResponse(url, init, signal) {
    try {
      return await abortable(fetch(url, { ...init, signal }), signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error.name !== "TypeError") throw error;
      throw new Error("无法连接 AI 接口。请检查服务商地址、网络和浏览器跨域许可；浏览器未提供更具体的失败原因。", { cause: error });
    }
  }

  function apiError(payload, prefix = "接口返回错误") {
    const value = payload?.error;
    const message = typeof value === "string" ? value : value?.message || payload?.message;
    return new Error(message ? `${prefix}：${message}` : prefix);
  }

  async function httpError(response, signal) {
    const raw = await abortable(response.text(), signal);
    let detail = raw.trim().slice(0, 600);
    if (detail) {
      try {
        const payload = JSON.parse(raw);
        detail = (typeof payload.error === "string" ? payload.error : payload.error?.message) || payload.message || detail;
      } catch (_) {
        // 非 JSON 的 HTTP 错误正文保留为可见诊断。
      }
    }
    return new Error(`接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
  }

  function extractContent(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.map(part => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("");
  }

  async function readEventStream(response, signal, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let complete = false;

    const consume = event => {
      const lines = event.split(/\r\n|\n|\r/);
      const payloadText = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
      if (!payloadText) return;
      if (payloadText === "[DONE]") { complete = true; return; }
      let payload;
      try { payload = JSON.parse(payloadText); }
      catch (cause) { throw new Error("AI 响应流包含无效 JSON，回答未完成。", { cause }); }
      if (!payload || typeof payload !== "object") throw new Error("AI 响应流格式错误，回答未完成。");
      if (payload.error || lines.some(line => /^event:\s*error\s*$/.test(line))) throw apiError(payload, "AI 回答中断");
      const choice = payload.choices?.[0];
      const piece = extractContent(choice?.delta?.content) || extractContent(choice?.message?.content);
      if (piece) {
        answer += piece;
        onDelta?.(answer);
      }
      if (choice?.finish_reason === "length") throw new Error("回答达到模型长度限制，内容未完成。请要求继续或调整模型参数。");
      if (choice?.finish_reason === "content_filter") throw new Error("服务商终止了回答，内容未完成。");
      if (choice?.finish_reason) complete = true;
    };

    try {
      while (!complete) {
        const { value, done } = await abortable(reader.read(), signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          consume(chunk);
          if (complete) break;
        }
      }
      if (!complete) {
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      }
      if (!complete) throw new Error("AI 连接在完成标记前结束，回答未完成。");
      if (!answer) throw new Error("接口已结束回答，但没有可显示的内容。");
      return answer;
    } catch (error) {
      error.partialAnswer = answer;
      throw error;
    } finally {
      try { await abortable(reader.cancel(), signal); }
      catch (error) {
        if (!signal.aborted) console.error("AI 响应流释放失败", error);
      }
      reader.releaseLock();
    }
  }

  async function delay(ms, signal) {
    let timer;
    try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
    finally { clearTimeout(timer); }
  }

  async function requestCompletion(config, messages, options = {}) {
    const endpoint = normalizeEndpoint(config.baseUrl);
    if (!String(config.model || "").trim()) throw new Error("请先填写模型名称。");
    const attempts = options.maxAttempts === undefined ? 3 : Number(options.maxAttempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new TypeError("请求次数必须为 1—5 之间的整数。");
    return withSignal(options, DEFAULT_TIMEOUT_MS, async signal => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = await fetchResponse(endpoint, {
          method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: options.stream === false ? "application/json" : "text/event-stream", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify({ model: config.model, messages, stream: options.stream !== false }),
        }, signal);
        if (!response.ok) {
          const error = await httpError(response, signal);
          if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) throw error;
          options.onStatus?.(`上游繁忙（HTTP ${response.status}），第 ${attempt + 1}/${attempts} 次重试…`);
          await delay(900 * attempt, signal);
          continue;
        }
        if (options.stream !== false && response.body && (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) return readEventStream(response, signal, options.onDelta);
        let payload;
        try { payload = await abortable(response.json(), signal); }
        catch (cause) {
          if (signal.aborted) throw abortReason(signal);
          throw new Error("AI 接口返回的内容不是有效 JSON。", { cause });
        }
        if (payload?.error) throw apiError(payload);
        const choice = payload?.choices?.[0];
        const answer = extractContent(choice?.message?.content) || extractContent(choice?.delta?.content);
        if (!answer) throw new Error("接口返回成功，但没有可显示的回答。");
        if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
          const error = new Error("服务商提前结束了回答，内容未完成。");
          error.partialAnswer = answer;
          throw error;
        }
        options.onDelta?.(answer);
        return answer;
      }
      throw new Error("AI 请求没有得到响应。");
    });
  }

  function modelIds(payload) {
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return [...new Set(rows.map(row => typeof row === "string" ? row : row?.id || row?.name || row?.model).filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))].sort((a, b) => a.localeCompare(b));
  }

  async function discoverModels(rawBaseUrl, apiKey, options = {}) {
    const base = normalizeBaseUrl(rawBaseUrl);
    const candidates = [base];
    // 仅 API 路径缺失且服务器明确返回 404 时，允许探测标准 /v1。
    if (new URL(base).pathname === "/") candidates.push(`${base}/v1`);
    return withSignal(options, MODELS_TIMEOUT_MS, async signal => {
      for (const candidate of candidates) {
        const response = await fetchResponse(`${candidate}/models`, {
          method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        }, signal);
        if (!response.ok) {
          if (response.status === 404 && candidate !== candidates.at(-1)) continue;
          throw await httpError(response, signal);
        }
        let payload;
        try { payload = await abortable(response.json(), signal); }
        catch (cause) {
          if (signal.aborted) throw abortReason(signal);
          throw new Error("模型接口返回的不是有效 JSON，请确认 API 地址。", { cause });
        }
        if (payload?.error) throw apiError(payload);
        const models = modelIds(payload);
        if (!models.length) throw new Error("接口没有返回可用模型，可手动填写服务商提供的模型名称。");
        return { baseUrl: candidate, models };
      }
      throw new Error("模型接口不存在，请确认 API 地址。");
    });
  }

  function settingsSnapshot() {
    return [
      { key: SETTINGS_KEYS.config, store: localStorage, expectedRaw: localStorage.getItem(SETTINGS_KEYS.config) },
      { key: SETTINGS_KEYS.systemPrompt, store: localStorage, expectedRaw: localStorage.getItem(SETTINGS_KEYS.systemPrompt) },
      { key: SETTINGS_KEYS.secret, store: localStorage, expectedRaw: localStorage.getItem(SETTINGS_KEYS.secret) },
      { key: SETTINGS_KEYS.secret, store: sessionStorage, expectedRaw: sessionStorage.getItem(SETTINGS_KEYS.secret) },
    ];
  }

  function readSettings() {
    const raw = localStorage.getItem(SETTINGS_KEYS.config);
    let saved = {};
    if (raw !== null) {
      try { saved = JSON.parse(raw); }
      catch (cause) { throw new Error("AI 设置无法读取，已保留原记录。请在 AI 设置中导出损坏设置原文后重新配置。", { cause }); }
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("AI 设置格式错误，已保留原记录。");
    }
    for (const field of ["baseUrl", "model"]) {
      if (saved[field] !== undefined && typeof saved[field] !== "string") throw new Error(`AI 设置中的 ${field} 格式错误，已保留原记录。`);
    }
    if (saved.rememberKey !== undefined && typeof saved.rememberKey !== "boolean") throw new Error("AI 设置的密钥保存选项格式错误，已保留原记录。");
    const rememberKey = saved.rememberKey !== false;
    const timeoutMs = saved.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(saved.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("AI 设置的超时配置错误，已保留原记录。");
    return {
      baseUrl: saved.baseUrl || "", model: saved.model || "", rememberKey, timeoutMs,
      systemPrompt: localStorage.getItem(SETTINGS_KEYS.systemPrompt) || "",
      apiKey: (rememberKey ? localStorage.getItem(SETTINGS_KEYS.secret) || sessionStorage.getItem(SETTINGS_KEYS.secret) : sessionStorage.getItem(SETTINGS_KEYS.secret)) || "",
    };
  }

  async function saveSettings(next, snapshot = settingsSnapshot()) {
    readSettings();
    const timeoutMs = next.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(next.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("请求超时必须为非负毫秒数；0 表示关闭超时。");
    const settings = {
      baseUrl: next.baseUrl ? normalizeBaseUrl(next.baseUrl) : "", model: String(next.model || "").trim(),
      rememberKey: !!next.rememberKey, timeoutMs, presetVersion: 2,
    };
    const values = [
      { value: settings },
      { raw: String(next.systemPrompt || "") || null },
      { raw: next.rememberKey && next.apiKey ? String(next.apiKey) : null },
      { raw: !next.rememberKey && next.apiKey ? String(next.apiKey) : null },
    ];
    await window.QuizStorage.transaction(snapshot.map((entry, index) => ({ ...entry, ...values[index] })));
    window.dispatchEvent(new CustomEvent("quiz-ai-settings-changed"));
    return { ...settings, apiKey: String(next.apiKey || ""), systemPrompt: String(next.systemPrompt || "") };
  }

  function exportDamagedSettings() {
    return {
      app: 'quiz-hub-ai-private-recovery', version: 1, exportedAt: new Date().toISOString(),
      configRaw: localStorage.getItem(SETTINGS_KEYS.config),
      systemPromptRaw: localStorage.getItem(SETTINGS_KEYS.systemPrompt),
    };
  }

  async function resetDamagedSettings(snapshot) {
    if (!Array.isArray(snapshot)) throw new Error('请先读取要恢复的设置。');
    let damaged = false;
    try { readSettings(); }
    catch (_) { damaged = true; }
    if (!damaged) throw new Error('当前 AI 设置有效，无需重新配置。');
    const config = snapshot.find(entry => entry.key === SETTINGS_KEYS.config && entry.store === localStorage);
    if (!config) throw new Error('缺少设置原文快照。');
    await window.QuizStorage.transaction([{ ...config, value: { baseUrl: '', model: '', rememberKey: true, timeoutMs: DEFAULT_TIMEOUT_MS, presetVersion: 2 } }], { allowCorrupt: true });
    window.dispatchEvent(new CustomEvent('quiz-ai-settings-changed'));
    return readSettings();
  }

  const settings = {
    keys: SETTINGS_KEYS, read: readSettings, save: saveSettings, snapshot: settingsSnapshot,
    recovery: { export: exportDamagedSettings, reset: resetDamagedSettings },
  };
  return { normalizeBaseUrl, normalizeEndpoint, requestCompletion, discoverModels, DEFAULT_TIMEOUT_MS, MODELS_TIMEOUT_MS, settings };
})();
