// MCP Apps bridge: JSON-RPC 2.0 with the host over postMessage (spec 2026-01-26).
// Views use window.mcpBridge only; they never call postMessage themselves.
(function () {
  "use strict";

  const PROTOCOL_VERSION = "2026-01-26";
  const TIMEOUT_MS = 30000;
  const MAX_MESSAGE_CHARS = 8000;
  const MODES = ["inline", "fullscreen"];

  const pending = new Map();
  const listeners = { input: [], result: [], cancelled: [], context: [] };
  let nextId = 1;
  let context = {};
  let started = null;
  let lastSize = "";

  function post(message) {
    window.parent.postMessage(message, "*");
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }

  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function respond(id, result) {
    post({ jsonrpc: "2.0", id: id, result: result });
  }

  function respondError(id, code, message) {
    post({ jsonrpc: "2.0", id: id, error: { code: code, message: message } });
  }

  function emit(kind, value) {
    listeners[kind].forEach(function (fn) {
      try {
        fn(value);
      } catch (error) {
        console.error(error);
      }
    });
  }

  function subscribe(kind, fn) {
    if (typeof fn !== "function") throw new TypeError("listener must be a function");
    listeners[kind].push(fn);
  }

  function applyContext() {
    const root = document.documentElement;
    if (context.theme === "light" || context.theme === "dark") {
      root.dataset.theme = context.theme;
    }
    const variables = context.styles && context.styles.variables;
    if (variables && typeof variables === "object") {
      Object.keys(variables).forEach(function (name) {
        const value = variables[name];
        if (name.indexOf("--") === 0 && typeof value === "string") {
          root.style.setProperty(name, value);
        }
      });
    }
  }

  function mergeContext(partial) {
    if (!partial || typeof partial !== "object") return;
    const next = Object.assign({}, context, partial);
    if (partial.styles && context.styles) {
      next.styles = Object.assign({}, context.styles, partial.styles);
      if (partial.styles.variables && context.styles.variables) {
        next.styles.variables = Object.assign(
          {},
          context.styles.variables,
          partial.styles.variables,
        );
      }
    }
    context = next;
    applyContext();
    emit("context", context);
  }

  function reportSize() {
    const root = document.documentElement;
    const width = Math.ceil(root.scrollWidth);
    const height = Math.ceil(root.scrollHeight);
    const key = width + "x" + height;
    if (key === lastSize) return;
    lastSize = key;
    notify("ui/notifications/size-changed", { width: width, height: height });
  }

  function watchSize() {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(reportSize).observe(document.documentElement);
      if (document.body) new ResizeObserver(reportSize).observe(document.body);
    }
    reportSize();
  }

  function onResponse(message) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(String(message.error.message || "request failed"));
      error.code = message.error.code;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }

  function onRequest(message) {
    if (message.method === "ping" || message.method === "ui/resource-teardown") {
      respond(message.id, {});
    } else {
      respondError(message.id, -32601, "Method not found");
    }
  }

  function onNotification(message) {
    const params = message.params || {};
    switch (message.method) {
      case "ui/notifications/tool-input":
        emit("input", params.arguments || {});
        break;
      case "ui/notifications/tool-result":
        emit("result", params);
        break;
      case "ui/notifications/tool-cancelled":
        emit("cancelled", params.reason);
        break;
      case "ui/notifications/host-context-changed":
        mergeContext(params);
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (typeof message.method === "string") {
      if (hasId) onRequest(message);
      else onNotification(message);
    } else if (hasId) {
      onResponse(message);
    }
  });

  function start(appInfo) {
    if (started) return started;
    started = request("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: appInfo || { name: "docmost-view", version: "1" },
      appCapabilities: { availableDisplayModes: MODES.slice() },
    }).then(function (result) {
      mergeContext((result && result.hostContext) || {});
      notify("ui/notifications/initialized", {});
      watchSize();
      return context;
    });
    return started;
  }

  function structured(result) {
    if (!result || typeof result !== "object") return null;
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const first = Array.isArray(result.content) ? result.content[0] : null;
    if (first && first.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function sendMessage(text) {
    if (typeof text !== "string" || text.length === 0) {
      return Promise.reject(new TypeError("message text must be a non-empty string"));
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      return Promise.reject(new RangeError("message text is over 8000 characters"));
    }
    return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
  }

  function updateContext(structuredContent) {
    return request("ui/update-model-context", { structuredContent: structuredContent });
  }

  function openLink(url) {
    const safe = window.dom ? window.dom.safeHref(url) : null;
    if (!safe) return Promise.reject(new Error("link refused"));
    return request("ui/open-link", { url: safe });
  }

  function requestMode(mode) {
    if (MODES.indexOf(mode) < 0) return Promise.reject(new RangeError("unknown display mode"));
    return request("ui/request-display-mode", { mode: mode }).then(function (result) {
      return (result && result.mode) || context.displayMode || mode;
    });
  }

  window.mcpBridge = Object.freeze({
    start: start,
    onToolInput: function (fn) {
      subscribe("input", fn);
    },
    onToolResult: function (fn) {
      subscribe("result", fn);
    },
    onToolCancelled: function (fn) {
      subscribe("cancelled", fn);
    },
    onHostContext: function (fn) {
      subscribe("context", fn);
    },
    hostContext: function () {
      return context;
    },
    callTool: function (name, args) {
      return request("tools/call", { name: name, arguments: args || {} });
    },
    structured: structured,
    sendMessage: sendMessage,
    updateContext: updateContext,
    openLink: openLink,
    requestMode: requestMode,
  });
})();
