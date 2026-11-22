// Safe DOM helpers for the views: text APIs only, no HTML parsing of any kind.
(function () {
  "use strict";

  const PLAIN_ATTRS = ["class", "id", "role", "type", "title", "tabindex"];
  const TAG = "docmost-untrusted-content";
  const ENVELOPE = new RegExp("^<" + TAG + ' source="[^"]*">\\n([\\s\\S]*)\\n</' + TAG + ">$");
  const ESCAPED_CLOSE = new RegExp("&lt;/" + TAG, "g");
  const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  function text(value) {
    return document.createTextNode(String(value ?? ""));
  }

  function allowedAttr(key) {
    return (
      PLAIN_ATTRS.indexOf(key) >= 0 ||
      /^aria-[a-z][a-z-]*$/.test(key) ||
      /^data-[a-z][a-z0-9-]*$/.test(key)
    );
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (item) {
        append(parent, item);
      });
    } else if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(text(child));
    } else {
      parent.appendChild(child);
    }
  }

  function el(tag, attrs) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      const value = attrs[key];
      if (/^on[a-z]+$/.test(key)) {
        if (typeof value !== "function") throw new TypeError(key + " must be a function");
        node.addEventListener(key.slice(2), value);
      } else if (allowedAttr(key)) {
        if (value === null || value === undefined || value === false) return;
        node.setAttribute(key, value === true ? "" : String(value));
      } else {
        throw new Error("attribute not allowed: " + key);
      }
    });
    for (let index = 2; index < arguments.length; index++) append(node, arguments[index]);
    return node;
  }

  function unwrap(value) {
    const s = String(value ?? "");
    const match = ENVELOPE.exec(s);
    if (!match) return s;
    return match[1].replace(ESCAPED_CLOSE, "</" + TAG);
  }

  function safeHref(url) {
    if (typeof url !== "string" || url.trim() === "") return null;
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  }

  function parseUnifiedDiff(value) {
    const hunks = [];
    let hunk = null;
    let oldLeft = 0;
    let newLeft = 0;
    String(value ?? "")
      .split("\n")
      .forEach(function (line) {
        const inside = hunk !== null && (oldLeft > 0 || newLeft > 0);
        if (!inside) {
          const match = HUNK.exec(line);
          if (!match) return;
          hunk = {
            header: line,
            oldStart: Number(match[1]),
            oldLines: match[2] === undefined ? 1 : Number(match[2]),
            newStart: Number(match[3]),
            newLines: match[4] === undefined ? 1 : Number(match[4]),
            lines: [],
          };
          oldLeft = hunk.oldLines;
          newLeft = hunk.newLines;
          hunks.push(hunk);
          return;
        }
        const mark = line.charAt(0);
        const body = line.slice(1);
        if (mark === "+") {
          hunk.lines.push({ kind: "add", text: body });
          newLeft--;
        } else if (mark === "-") {
          hunk.lines.push({ kind: "del", text: body });
          oldLeft--;
        } else if (mark === " " || line === "") {
          hunk.lines.push({ kind: "context", text: body });
          oldLeft--;
          newLeft--;
        }
      });
    return hunks;
  }

  window.dom = Object.freeze({
    el: el,
    text: text,
    unwrap: unwrap,
    safeHref: safeHref,
    parseUnifiedDiff: parseUnifiedDiff,
  });
})();
