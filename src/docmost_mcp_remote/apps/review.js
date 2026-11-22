// Change-review view: diff review for dry runs and diff_page, a saved card for real
// writes, and a version list for open_page_history. It calls only the read tools
// list_page_history and diff_page. Buttons send fixed English templates with ids only;
// wiki text is never put into a message to the model.
(function () {
  "use strict";

  const dom = window.dom;
  const bridge = window.mcpBridge;
  const el = dom.el;
  const app = document.getElementById("app");
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const HISTORY_PAGE_SIZE = 20;

  function safeId(value) {
    return typeof value === "string" && ID.test(value) ? value : null;
  }

  function show() {
    const box = el.apply(null, ["div", null].concat(Array.prototype.slice.call(arguments)));
    app.replaceChildren.apply(app, Array.prototype.slice.call(box.childNodes));
  }

  function plain(value, fallback) {
    const s = dom.unwrap(typeof value === "string" ? value : "").trim();
    return s === "" ? fallback || "" : s;
  }

  function setMode(mode) {
    if (mode === "inline" || mode === "fullscreen") {
      document.documentElement.dataset.mode = mode;
    }
  }

  function canFullscreen() {
    const context = bridge.hostContext() || {};
    const modes = context.availableDisplayModes;
    return Array.isArray(modes) && modes.indexOf("fullscreen") >= 0;
  }

  function expandButton() {
    if (!canFullscreen()) return null;
    const button = el("button", {
      type: "button",
      class: "link",
      onclick: function () {
        const current = (bridge.hostContext() || {}).displayMode;
        const next = current === "fullscreen" ? "inline" : "fullscreen";
        bridge.requestMode(next).then(setMode, function () {});
      },
    });
    function label() {
      const current = (bridge.hostContext() || {}).displayMode;
      button.textContent = current === "fullscreen" ? "Exit full screen" : "Full screen";
    }
    label();
    bridge.onHostContext(label);
    return button;
  }

  function openLinkButton(url) {
    const href = dom.safeHref(url);
    if (!href) return null;
    return el(
      "button",
      {
        type: "button",
        class: "link",
        onclick: function () {
          bridge.openLink(href).catch(function () {});
        },
      },
      "Open in Docmost",
    );
  }

  function header(title, url) {
    return el(
      "div",
      { class: "head" },
      el("h1", null, title),
      el("span", { class: "actions" }, openLinkButton(url), expandButton()),
    );
  }

  function notice(kind, text, items) {
    return el(
      "div",
      { class: kind === "error" ? "notice error" : "notice muted", role: "note" },
      text,
      items && items.length
        ? el(
            "ul",
            null,
            items.map(function (item) {
              return el("li", null, String(item));
            }),
          )
        : null,
    );
  }

  // Message buttons: each sends one fixed template, then all are disabled.
  function actions(specs) {
    const status = el("p", { class: "muted", role: "status" });
    const buttons = specs.map(function (spec, index) {
      return el(
        "button",
        {
          type: "button",
          class: index === 0 ? "primary" : null,
          onclick: function () {
            buttons.forEach(function (b) {
              b.disabled = true;
            });
            bridge.sendMessage(spec.message).then(
              function () {
                status.textContent = "Sent to Claude.";
              },
              function () {
                status.textContent = "Could not send the message.";
                buttons.forEach(function (b) {
                  b.disabled = false;
                });
              },
            );
          },
        },
        spec.label,
      );
    });
    if (buttons.length === 0) return null;
    return el("div", null, el("div", { class: "actions" }, buttons), status);
  }

  function renderDiff(diffText) {
    const hunks = dom.parseUnifiedDiff(dom.unwrap(diffText || ""));
    if (hunks.length === 0) return el("p", { class: "muted" }, "No differences.");
    return el(
      "div",
      { class: "diff", role: "region", "aria-label": "Changes" },
      hunks.map(function (hunk) {
        return el(
          "div",
          { class: "hunk" },
          el("div", { class: "hunk-head mono" }, hunk.header),
          hunk.lines.map(function (line) {
            const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
            const label =
              line.kind === "add" ? "Added" : line.kind === "del" ? "Removed" : "Unchanged";
            return el(
              "div",
              { class: "line " + line.kind },
              el("span", { class: "mark", "aria-label": label }, mark),
              el("span", { class: "body" }, line.text),
            );
          }),
        );
      }),
    );
  }

  function diffNotices(data) {
    const out = [];
    const problems = Array.isArray(data.problems) ? data.problems : [];
    if (problems.length) {
      out.push(notice("error", "The document has problems and cannot be written:", problems));
    }
    const removed = Array.isArray(data.formatting_removed) ? data.formatting_removed : [];
    if (removed.length) {
      out.push(notice("error", "This change would remove formatting:", removed));
    }
    if (data.diff_truncated) {
      out.push(notice("info", "The diff is cut short. Ask Claude for the full change."));
    }
    if (data.changed === false && !problems.length) {
      out.push(notice("info", "No change: the result is the same as the current page."));
    }
    return out;
  }

  // A dry run of update_page, replace_section or replace_page_json.
  function renderPreview(data) {
    const pageId = safeId(data.id);
    const problems = Array.isArray(data.problems) ? data.problems : [];
    const specs = [];
    if (pageId && data.changed !== false && !problems.length) {
      specs.push({
        label: "Apply this change",
        message:
          "Apply the change you previewed for page " +
          pageId +
          ": repeat the same call with dry_run=false.",
      });
    }
    if (pageId) {
      specs.push({
        label: "Discard",
        message: "Discard the change you previewed for page " + pageId + ". Do not write it.",
      });
    }
    show(
      header("Preview: " + plain(data.title, "(untitled)"), data.url),
      el("p", { class: "muted" }, "Nothing has been written yet."),
      diffNotices(data),
      data.diff ? renderDiff(data.diff) : null,
      actions(specs),
    );
  }

  // A real write: compact saved card.
  function renderSaved(data) {
    const snapshot = safeId(data.snapshot_id);
    show(
      el(
        "section",
        { class: "card" },
        header(data.changed === false ? "No change" : "Saved", data.url),
        el(
          "dl",
          null,
          el("dt", null, "Page"),
          el("dd", null, plain(data.title, "(untitled)")),
          snapshot ? el("dt", null, "Snapshot") : null,
          snapshot ? el("dd", { class: "mono" }, snapshot) : null,
        ),
        snapshot
          ? el("p", { class: "muted" }, "The earlier body is kept in this snapshot.")
          : null,
      ),
    );
  }

  function restoreSpecs(pageId, version) {
    if (!pageId || !version || version === "current") return [];
    return [
      {
        label: "Restore this version",
        message:
          "Restore page " +
          pageId +
          " to " +
          version +
          " (restore_page_version for a version id, restore_snapshot for a snapshot id).",
      },
    ];
  }

  function diffBody(data) {
    return [
      diffNotices(data),
      renderDiff(data.diff),
      actions(restoreSpecs(safeId(data.page_id), safeId(data.from_version))),
    ];
  }

  // A diff_page result shown on its own.
  function renderPageDiff(data) {
    const from = safeId(data.from_version) || "?";
    const to = safeId(data.to_version) || "?";
    show(
      header("Changes", null),
      el("p", { class: "muted mono" }, from + " → " + to),
      diffBody(data),
    );
  }

  function versionMeta(version) {
    const parts = [];
    if (typeof version.created_at === "string") {
      const date = new Date(version.created_at);
      parts.push(isNaN(date.getTime()) ? version.created_at : date.toLocaleString());
    }
    if (typeof version.last_updated_by === "string" && version.last_updated_by) {
      parts.push(version.last_updated_by);
    }
    return parts.join(" · ");
  }

  // open_page_history: version list, Load more, and a diff for the selected version.
  function renderHistory(data) {
    const page = data.page && typeof data.page === "object" ? data.page : {};
    const history = data.history && typeof data.history === "object" ? data.history : {};
    const pageId = safeId(page.id) || safeId(history.page_id);
    let cursor = typeof history.next_cursor === "string" ? history.next_cursor : null;
    let selected = null;

    const list = el("ul", { class: "versions", "aria-label": "Versions" });
    const detail = el("div", { "aria-live": "polite" });
    const more = el("button", { type: "button", onclick: loadMore }, "Load more");
    const moreStatus = el("p", { class: "muted", role: "status" });

    function addVersions(versions) {
      (Array.isArray(versions) ? versions : []).forEach(function (version) {
        const id = safeId(version && version.id);
        if (!id) return;
        const button = el(
          "button",
          {
            type: "button",
            "aria-current": "false",
            onclick: function () {
              select(id, button);
            },
          },
          plain(version.title, "(untitled)"),
          el("span", { class: "meta" }, versionMeta(version)),
        );
        list.appendChild(el("li", null, button));
      });
      if (!list.firstChild) list.appendChild(el("li", { class: "muted" }, "No versions yet."));
      more.hidden = !cursor || !pageId;
    }

    function loadMore() {
      if (!cursor || !pageId) return;
      more.disabled = true;
      moreStatus.textContent = "Loading";
      bridge
        .callTool("list_page_history", { page: pageId, cursor: cursor, limit: HISTORY_PAGE_SIZE })
        .then(function (result) {
          const next = bridge.structured(result);
          if (!next || result.isError) throw new Error("failed");
          cursor = typeof next.next_cursor === "string" ? next.next_cursor : null;
          addVersions(next.versions);
          moreStatus.textContent = "";
        })
        .catch(function () {
          moreStatus.textContent = "Could not load more versions.";
        })
        .then(function () {
          more.disabled = false;
        });
    }

    function select(versionId, button) {
      if (!pageId) return;
      if (selected) selected.setAttribute("aria-current", "false");
      selected = button;
      button.setAttribute("aria-current", "true");
      detail.replaceChildren(el("p", { class: "muted" }, "Loading the changes"));
      bridge
        .callTool("diff_page", { page: pageId, from_version: versionId })
        .then(function (result) {
          if (selected !== button) return;
          const diff = bridge.structured(result);
          if (!diff || result.isError) throw new Error("failed");
          detail.replaceChildren(
            el("h2", null, "Changes since this version"),
            el("div", null, diffBody(diff)),
          );
        })
        .catch(function () {
          if (selected !== button) return;
          detail.replaceChildren(el("p", { class: "error" }, "Could not load the changes."));
        });
    }

    addVersions(history.versions);
    show(
      header("History: " + plain(page.title, "(untitled)"), page.url),
      el("p", { class: "muted" }, "Choose a version to see what changed since then."),
      list,
      el("div", { class: "actions" }, more),
      moreStatus,
      detail,
    );
  }

  function errorText(result) {
    const first = result && Array.isArray(result.content) ? result.content[0] : null;
    return first && first.type === "text" && typeof first.text === "string" ? first.text : "";
  }

  function render(result) {
    if (result && result.isError) {
      show(
        el("p", { class: "error" }, "The tool reported an error."),
        el("p", { class: "muted" }, errorText(result).slice(0, 2000)),
      );
      return;
    }
    const data = bridge.structured(result);
    if (!data || typeof data !== "object") {
      show(el("p", { class: "muted" }, "Nothing to show."));
    } else if ("history" in data) {
      renderHistory(data);
    } else if ("from_version" in data) {
      renderPageDiff(data);
    } else if (data.dry_run) {
      renderPreview(data);
    } else {
      renderSaved(data);
    }
  }

  bridge.onToolInput(function () {
    show(el("p", { class: "muted" }, "Waiting for the result"));
  });
  bridge.onToolResult(render);
  bridge.onToolCancelled(function () {
    show(el("p", { class: "muted" }, "The call was cancelled."));
  });
  bridge.onHostContext(function (context) {
    setMode(context && context.displayMode);
  });

  show(el("p", { class: "muted" }, "Loading"));
  bridge.start({ name: "docmost-review", version: "1" }).then(
    function (context) {
      setMode(context && context.displayMode);
    },
    function () {
      show(el("p", { class: "error" }, "Could not connect to the host."));
    },
  );
})();
