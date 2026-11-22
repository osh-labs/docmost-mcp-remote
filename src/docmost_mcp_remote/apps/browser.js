// Wiki browser view: read-only search, lazy page tree and page preview.
// It talks to the host only through window.mcpBridge and builds DOM only through window.dom.
// Wiki text is untrusted: it is shown with text nodes only and never sent to the model.
(function () {
  "use strict";

  const dom = window.dom;
  const bridge = window.mcpBridge;
  const el = dom.el;

  // --- renderer:begin ---
  // Renders ProseMirror JSON with a node-type allowlist. Self-contained so tests can run it.
  function createRenderer(dom, openLink) {
    const el = dom.el;
    const MAX_DEPTH = 40;
    const MAX_NODES = 20000;
    const BLOCKS = {
      paragraph: "p",
      bulletList: "ul",
      orderedList: "ol",
      listItem: "li",
      taskList: "ul",
      tableRow: "tr",
      tableCell: "td",
      tableHeader: "th",
      blockquote: "blockquote",
    };
    const MEDIA = {
      image: "Image",
      video: "Video",
      audio: "Audio",
      attachment: "File",
      pdf: "PDF",
      drawio: "Diagram",
      excalidraw: "Drawing",
    };
    const MARKS = { bold: "strong", italic: "em", code: "code", strike: "s" };

    function isObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function kids(node) {
      return Array.isArray(node.content) ? node.content : [];
    }

    function attrsOf(node) {
      return isObject(node.attrs) ? node.attrs : {};
    }

    function plainText(node, depth) {
      const level = depth || 0;
      if (!isObject(node) || level > MAX_DEPTH) return "";
      if (node.type === "text") return typeof node.text === "string" ? node.text : "";
      if (node.type === "hardBreak") return "\n";
      const parts = kids(node);
      const inline = parts.every(function (part) {
        return isObject(part) && (part.type === "text" || part.type === "hardBreak");
      });
      return parts
        .map(function (part) {
          return plainText(part, level + 1);
        })
        .filter(function (part) {
          return part !== "";
        })
        .join(inline ? "" : " ");
    }

    function fileName(attrs) {
      const keys = ["title", "alt", "name", "fileName"];
      for (let index = 0; index < keys.length; index++) {
        const value = attrs[keys[index]];
        if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 120);
      }
      if (typeof attrs.src === "string") {
        let last = attrs.src.split(/[?#]/)[0].split("/").pop() || "";
        try {
          last = decodeURIComponent(last);
        } catch (error) {
          // Keep the raw segment.
        }
        if (last.trim() !== "") return last.trim().slice(0, 120);
      }
      return "unnamed";
    }

    function linkFor(href, child) {
      const safe = dom.safeHref(href);
      if (safe === null) return child;
      function follow(event) {
        event.preventDefault();
        openLink(safe);
      }
      return el(
        "a",
        {
          class: "link",
          role: "link",
          tabindex: "0",
          title: safe,
          onclick: follow,
          onkeydown: function (event) {
            if (event.key === "Enter") follow(event);
          },
        },
        child,
      );
    }

    function renderText(node) {
      let out = dom.text(typeof node.text === "string" ? node.text : "");
      const marks = Array.isArray(node.marks) ? node.marks : [];
      marks.forEach(function (mark) {
        if (!isObject(mark)) return;
        if (mark.type === "link") {
          out = linkFor(attrsOf(mark).href, out);
        } else if (Object.prototype.hasOwnProperty.call(MARKS, mark.type)) {
          out = el(MARKS[mark.type], {}, out);
        }
      });
      return out;
    }

    function renderNode(node, depth, budget) {
      if (!isObject(node)) return null;
      budget.left--;
      if (budget.left < 0) return null;
      if (depth > MAX_DEPTH) return dom.text(plainText(node));
      const type = node.type;
      const attrs = attrsOf(node);
      function inner() {
        return kids(node).map(function (child) {
          return renderNode(child, depth + 1, budget);
        });
      }
      if (type === "text") return renderText(node);
      if (type === "hardBreak") return el("br", {});
      if (type === "horizontalRule") return el("hr", {});
      if (type === "heading") {
        const level = Math.min(5, Math.max(1, Math.floor(Number(attrs.level)) || 1));
        return el("h" + (level + 1), {}, inner());
      }
      if (type === "codeBlock") return el("pre", { class: "code" }, el("code", {}, plainText(node)));
      if (type === "callout") return el("div", { class: "callout", role: "note" }, inner());
      if (type === "table") return el("div", { class: "table-wrap" }, el("table", {}, inner()));
      if (type === "taskItem") {
        const done = attrs.checked === true;
        return el(
          "li",
          { class: "task", "data-checked": done ? "true" : "false" },
          el("span", { class: "task-mark" }, done ? "☑ " : "☐ "),
          inner(),
        );
      }
      if (Object.prototype.hasOwnProperty.call(BLOCKS, type)) return el(BLOCKS[type], {}, inner());
      if (Object.prototype.hasOwnProperty.call(MEDIA, type)) {
        return el("span", { class: "media" }, "[" + MEDIA[type] + ": " + fileName(attrs) + "]");
      }
      // Unknown node: the plain text of its children.
      return dom.text(plainText(node));
    }

    function renderDoc(doc) {
      if (!isObject(doc) || kids(doc).length === 0) {
        return el("p", { class: "muted" }, "This page is empty.");
      }
      const budget = { left: MAX_NODES };
      const out = el(
        "div",
        { class: "doc" },
        kids(doc).map(function (child) {
          return renderNode(child, 1, budget);
        }),
      );
      if (budget.left < 0) out.appendChild(el("p", { class: "muted" }, "The preview is cut short."));
      return out;
    }

    function parseContent(content) {
      if (typeof content !== "string") return null;
      try {
        const value = JSON.parse(dom.unwrap(content));
        return isObject(value) ? value : null;
      } catch (error) {
        return null;
      }
    }

    return { renderDoc: renderDoc, parseContent: parseContent, plainText: plainText };
  }
  // --- renderer:end ---

  const ID = /^[A-Za-z0-9_-]{1,100}$/;
  const ASK_PREFIX = "Please read the Docmost page with id ";
  const ASK_SUFFIX = " (use get_page) and help me with it.";
  const SUGGEST_DELAY_MS = 250;

  const renderer = createRenderer(dom, function (href) {
    bridge.openLink(href).catch(function (error) {
      setStatus("Could not open the link: " + messageOf(error), true);
    });
  });

  const state = {
    mode: "inline",
    wide: false,
    canFullscreen: true,
    initialized: false,
    spaces: [],
    spacesCursor: null,
    spacesLoading: false,
    spacesError: null,
    expanded: new Set(),
    children: new Map(),
    query: "",
    searchSpace: "",
    results: null,
    selected: null,
    page: null,
    pageLoading: false,
    pageError: null,
    pages: new Map(),
  };
  let searchSeq = 0;
  let suggestTimer = null;
  let treeInfo = new Map();

  function isId(value) {
    return typeof value === "string" && ID.test(value);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function noop() {}

  function messageOf(error) {
    const text = error && error.message ? String(error.message) : String(error || "");
    return (text || "unknown error").slice(0, 500);
  }

  function errorText(result) {
    const items = Array.isArray(result.content) ? result.content : [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item && item.type === "text" && typeof item.text === "string" && item.text) {
        return item.text.slice(0, 500);
      }
    }
    return "The tool reported an error.";
  }

  function call(name, args) {
    return bridge.callTool(name, args).then(function (result) {
      if (!result || result.isError) throw new Error(result ? errorText(result) : "No result.");
      const data = bridge.structured(result);
      if (!isObject(data)) throw new Error("The server returned no data.");
      return data;
    });
  }

  function cursorOf(data) {
    return typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null;
  }

  function spaceIdOf(item) {
    if (isId(item.space_id)) return item.space_id;
    if (isObject(item.space) && isId(item.space.id)) return item.space.id;
    return null;
  }

  function spaceName(id) {
    for (let index = 0; index < state.spaces.length; index++) {
      if (state.spaces[index].id === id) return dom.unwrap(state.spaces[index].name || "");
    }
    return "";
  }

  // ---- Layout -----------------------------------------------------------------------------

  const app = document.getElementById("app");
  const status = el("p", { class: "status", role: "status", "aria-live": "polite" });
  const panelButton = el("button", { type: "button", onclick: togglePanel }, "Open in panel");
  const input = el("input", {
    type: "search",
    "aria-label": "Search the wiki",
    oninput: onQueryInput,
    onkeydown: onQueryKey,
  });
  input.placeholder = "Search the wiki";
  input.maxLength = 500;
  const spaceSelect = el("select", { "aria-label": "Space to search", onchange: onSpaceChange });
  const searchButton = el("button", { type: "submit" }, "Search");
  const form = el(
    "form",
    {
      class: "search",
      role: "search",
      onsubmit: function (event) {
        event.preventDefault();
        runSearch("search");
      },
    },
    input,
    spaceSelect,
    searchButton,
  );
  const resultsRegion = el("div", { class: "results" });
  const treeRegion = el("div", { class: "tree-region" });
  const selectionRegion = el("div", { class: "selection" });
  const previewRegion = el("div", { class: "preview-body" });
  const side = el("section", { class: "side", "aria-label": "Search and pages" }, form, resultsRegion, treeRegion);
  const preview = el("section", { class: "preview", "aria-label": "Page preview" }, previewRegion);
  app.replaceChildren(
    el("div", { class: "bar" }, el("h1", {}, "Docmost wiki"), panelButton),
    status,
    el("div", { class: "layout" }, side, preview),
    selectionRegion,
  );

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.dataset.kind = isError ? "error" : "info";
  }

  function applyLayout(context) {
    const ctx = isObject(context) ? context : {};
    state.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
    const dims = isObject(ctx.containerDimensions) ? ctx.containerDimensions : {};
    const width =
      typeof dims.width === "number"
        ? dims.width
        : typeof dims.maxWidth === "number"
          ? dims.maxWidth
          : window.innerWidth || 0;
    state.wide = state.mode === "fullscreen" && width >= 720;
    const modes = ctx.availableDisplayModes;
    state.canFullscreen = !Array.isArray(modes) || modes.indexOf("fullscreen") >= 0;
    app.dataset.mode = state.mode;
    app.dataset.wide = state.wide ? "true" : "false";
    const full = state.mode === "fullscreen";
    treeRegion.hidden = !full;
    preview.hidden = !full;
    selectionRegion.hidden = full;
    panelButton.textContent = full ? "Back to chat" : "Open in panel";
    panelButton.hidden = !full && !state.canFullscreen;
    if (full && state.selected && !state.page && !state.pageLoading) loadPage(state.selected.id);
    renderAll();
  }

  function togglePanel() {
    // Called directly in the click handler: hosts may require a user gesture.
    const target = state.mode === "fullscreen" ? "inline" : "fullscreen";
    bridge.requestMode(target).then(
      function (mode) {
        applyLayout(Object.assign({}, bridge.hostContext(), { displayMode: mode }));
      },
      function (error) {
        setStatus("Could not change the view: " + messageOf(error), true);
      },
    );
  }

  // Re-renders a region and puts focus back on the element with the same data-key.
  function refresh(region, nodes) {
    const active = document.activeElement;
    const key = active && region.contains(active) && active.dataset ? active.dataset.key : null;
    region.replaceChildren.apply(region, nodes.filter(Boolean));
    if (!key) return;
    const items = region.querySelectorAll("[data-key]");
    for (let index = 0; index < items.length; index++) {
      if (items[index].dataset.key === key) {
        items[index].focus();
        return;
      }
    }
  }

  function renderAll() {
    renderSpaceSelect();
    renderResults();
    if (state.mode === "fullscreen") {
      renderTree();
      renderPreview();
    } else {
      renderSelection();
    }
  }

  // ---- Keyboard navigation ----------------------------------------------------------------

  function navItems(container) {
    return Array.prototype.slice.call(container.querySelectorAll("[data-nav]"));
  }

  function moveFocus(container, current, key) {
    const items = navItems(container);
    if (items.length === 0) return false;
    let index = items.indexOf(current);
    if (key === "ArrowDown") index = Math.min(items.length - 1, index + 1);
    else if (key === "ArrowUp") index = Math.max(0, index - 1);
    else if (key === "Home") index = 0;
    else if (key === "End") index = items.length - 1;
    else return false;
    focusItem(container, items[index]);
    return true;
  }

  function focusItem(container, item) {
    navItems(container).forEach(function (other) {
      other.tabIndex = other === item ? 0 : -1;
    });
    item.focus();
  }

  function rovingStart(container, preferred) {
    const items = navItems(container);
    if (items.length === 0) return;
    let chosen = null;
    items.forEach(function (item) {
      if (item === document.activeElement) chosen = item;
    });
    if (!chosen) chosen = preferred || items[0];
    items.forEach(function (item) {
      item.tabIndex = item === chosen ? 0 : -1;
    });
  }

  // ---- Search -----------------------------------------------------------------------------

  function onQueryInput() {
    state.query = input.value;
    clearTimeout(suggestTimer);
    if (state.query.trim().length < 2) {
      if (state.query.trim() === "") {
        searchSeq++;
        state.results = null;
        renderResults();
      }
      return;
    }
    suggestTimer = setTimeout(function () {
      runSearch("suggest");
    }, SUGGEST_DELAY_MS);
  }

  function onQueryKey(event) {
    if (event.key === "ArrowDown") {
      const items = navItems(resultsRegion);
      if (items.length) {
        event.preventDefault();
        focusItem(resultsRegion, items[0]);
      }
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      input.value = "";
      onQueryInput();
    }
  }

  function onSpaceChange() {
    state.searchSpace = isId(spaceSelect.value) ? spaceSelect.value : "";
    if (state.query.trim()) runSearch(state.results ? state.results.kind : "search");
  }

  function runSearch(kind) {
    clearTimeout(suggestTimer);
    state.query = input.value;
    const query = state.query.trim();
    if (!query) {
      searchSeq++;
      state.results = null;
      renderResults();
      return;
    }
    const seq = ++searchSeq;
    const args =
      kind === "search" ? { query: query.slice(0, 500), limit: 20 } : { query: query.slice(0, 100), limit: 10 };
    if (state.searchSpace) args.space_id = state.searchSpace;
    state.results = { kind: kind, items: [], loading: true, error: null, truncated: false };
    renderResults();
    call(kind, args).then(
      function (data) {
        if (seq !== searchSeq) return;
        const items = kind === "search" ? data.results : data.pages;
        state.results = {
          kind: kind,
          items: Array.isArray(items)
            ? items.filter(function (item) {
                return isObject(item) && isId(item.id);
              })
            : [],
          loading: false,
          error: null,
          truncated: data.truncated === true,
        };
        renderResults();
      },
      function (error) {
        if (seq !== searchSeq) return;
        state.results = { kind: kind, items: [], loading: false, error: messageOf(error), truncated: false };
        renderResults();
      },
    );
  }

  function renderSpaceSelect() {
    const current = state.searchSpace;
    const options = [el("option", {}, "All spaces")];
    options[0].value = "";
    state.spaces.forEach(function (space) {
      const option = el("option", {}, dom.unwrap(space.name || space.slug || space.id));
      option.value = space.id;
      options.push(option);
    });
    spaceSelect.replaceChildren.apply(spaceSelect, options);
    spaceSelect.value = current;
    spaceSelect.hidden = state.spaces.length < 2;
  }

  function onResultsKey(event) {
    const target = event.target;
    if (moveFocus(resultsRegion, target, event.key)) {
      event.preventDefault();
    } else if (event.key === "Enter" || event.key === " ") {
      const id = target.dataset ? target.dataset.id : null;
      const item = (state.results ? state.results.items : []).find(function (one) {
        return one.id === id;
      });
      if (item) {
        event.preventDefault();
        selectPage(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.focus();
    }
  }

  function renderResults() {
    const results = state.results;
    if (!results) {
      refresh(resultsRegion, [
        state.mode === "fullscreen" ? null : el("p", { class: "muted" }, "Search page titles and text."),
      ]);
      return;
    }
    const heading = el(
      "h2",
      { class: "section-title" },
      results.kind === "search" ? "Search results" : "Title matches",
    );
    if (results.loading) {
      refresh(resultsRegion, [heading, el("p", { class: "muted" }, "Searching")]);
      return;
    }
    if (results.error) {
      refresh(resultsRegion, [heading, el("p", { class: "error" }, results.error)]);
      return;
    }
    if (results.items.length === 0) {
      refresh(resultsRegion, [
        heading,
        el(
          "p",
          { class: "muted" },
          results.kind === "suggest" ? "No title matches. Press Enter to search the text." : "No pages found.",
        ),
      ]);
      return;
    }
    let preferred = null;
    const list = el(
      "div",
      { class: "list", role: "listbox", "aria-label": "Results", onkeydown: onResultsKey },
      results.items.map(function (item) {
        const chosen = state.selected !== null && state.selected.id === item.id;
        const spaceId = spaceIdOf(item);
        const where = isObject(item.space) && item.space.name ? dom.unwrap(item.space.name) : spaceName(spaceId);
        const option = el(
          "div",
          {
            class: "item",
            role: "option",
            tabindex: "-1",
            "aria-selected": chosen ? "true" : "false",
            "data-nav": "result",
            "data-key": "r:" + item.id,
            "data-id": item.id,
            onclick: function () {
              selectPage(item);
            },
          },
          el("span", { class: "item-title" }, dom.unwrap(item.title || "(untitled)")),
          where ? el("span", { class: "item-meta" }, where) : null,
          typeof item.snippet === "string" && dom.unwrap(item.snippet).trim()
            ? el("span", { class: "snippet" }, dom.unwrap(item.snippet))
            : null,
        );
        if (chosen) preferred = option;
        return option;
      }),
    );
    refresh(resultsRegion, [
      heading,
      list,
      results.truncated ? el("p", { class: "muted" }, "More results exist; refine the search.") : null,
    ]);
    rovingStart(list, preferred);
  }

  // ---- Tree -------------------------------------------------------------------------------

  function loadSpaces(cursor) {
    state.spacesLoading = true;
    state.spacesError = null;
    renderTree();
    const args = { limit: 50 };
    if (cursor) args.cursor = cursor;
    call("list_spaces", args).then(
      function (data) {
        const found = Array.isArray(data.spaces)
          ? data.spaces.filter(function (space) {
              return isObject(space) && isId(space.id);
            })
          : [];
        state.spaces = cursor ? state.spaces.concat(found) : found;
        state.spacesCursor = cursorOf(data);
        state.spacesLoading = false;
        renderAll();
      },
      function (error) {
        state.spacesLoading = false;
        state.spacesError = messageOf(error);
        renderTree();
      },
    );
  }

  function childKey(spaceId, parentId) {
    return parentId ? "p:" + parentId : "s:" + spaceId;
  }

  function loadChildren(spaceId, parentId, cursor) {
    const key = childKey(spaceId, parentId);
    const before = state.children.get(key);
    const entry = {
      items: cursor && before ? before.items : [],
      cursor: null,
      loading: true,
      error: null,
      spaceId: spaceId,
      parentId: parentId,
    };
    state.children.set(key, entry);
    renderTree();
    const args = { space_id: spaceId, limit: 50 };
    if (parentId) args.parent_page_id = parentId;
    if (cursor) args.cursor = cursor;
    call("list_pages", args).then(
      function (data) {
        const found = Array.isArray(data.pages)
          ? data.pages.filter(function (page) {
              return isObject(page) && isId(page.id);
            })
          : [];
        entry.items = entry.items.concat(found);
        entry.cursor = cursorOf(data);
        entry.loading = false;
        renderTree();
      },
      function (error) {
        entry.loading = false;
        entry.error = messageOf(error);
        renderTree();
      },
    );
  }

  function toggle(key, spaceId, parentId) {
    if (state.expanded.has(key)) {
      state.expanded.delete(key);
    } else {
      state.expanded.add(key);
      if (!state.children.has(key)) loadChildren(spaceId, parentId, null);
    }
    renderTree();
  }

  function onTreeKey(event) {
    const target = event.target;
    if (moveFocus(treeRegion, target, event.key)) {
      event.preventDefault();
      return;
    }
    if (target.tagName === "BUTTON") return;
    const info = treeInfo.get(target.dataset ? target.dataset.key : "");
    if (!info) return;
    const open = state.expanded.has(info.key);
    if (event.key === "ArrowRight" && info.expandable) {
      event.preventDefault();
      if (!open) toggle(info.key, info.spaceId, info.parentId);
      else moveFocus(treeRegion, target, "ArrowDown");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (open && info.expandable) {
        toggle(info.key, info.spaceId, info.parentId);
      } else if (info.parentKey) {
        const parent = navItems(treeRegion).find(function (item) {
          return item.dataset.key === info.parentKey;
        });
        if (parent) focusItem(treeRegion, parent);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(info);
    }
  }

  function activate(info) {
    if (info.page) selectPage(info.page);
    else toggle(info.key, info.spaceId, info.parentId);
  }

  function treeRow(info, level, label) {
    const open = state.expanded.has(info.key);
    const chosen = info.page !== null && state.selected !== null && state.selected.id === info.page.id;
    treeInfo.set(info.key, info);
    const twisty = el(
      "span",
      {
        class: "twisty",
        "aria-hidden": "true",
        onclick: function (event) {
          if (!info.expandable) return;
          event.stopPropagation();
          toggle(info.key, info.spaceId, info.parentId);
        },
      },
      info.expandable ? (open ? "▾" : "▸") : "·",
    );
    const row = el(
      "div",
      {
        class: "row",
        role: "treeitem",
        tabindex: "-1",
        "aria-level": String(level),
        "aria-expanded": info.expandable ? (open ? "true" : "false") : null,
        "aria-selected": chosen ? "true" : "false",
        "data-nav": "tree",
        "data-key": info.key,
        onclick: function () {
          activate(info);
        },
      },
      twisty,
      el("span", { class: "row-label" }, label),
    );
    row.style.paddingLeft = 8 + (level - 1) * 14 + "px";
    return row;
  }

  function moreButton(key, onclick) {
    return el("button", { type: "button", class: "more", "data-nav": "tree", "data-key": key, onclick: onclick }, "Load more");
  }

  function noteRow(text, isError, level) {
    const note = el("div", { class: isError ? "error" : "muted", role: "none" }, text);
    note.style.paddingLeft = 8 + level * 14 + "px";
    return note;
  }

  function pageRows(spaceId, parentId, parentKey, level, out, preferred) {
    const key = childKey(spaceId, parentId);
    const entry = state.children.get(key);
    if (!entry) return;
    entry.items.forEach(function (page) {
      const info = {
        key: "p:" + page.id,
        parentKey: parentKey,
        spaceId: spaceId,
        parentId: page.id,
        expandable: page.has_children === true,
        page: page,
      };
      const row = treeRow(info, level, dom.unwrap(page.title || "(untitled)"));
      if (state.selected && state.selected.id === page.id) preferred.row = row;
      out.push(row);
      if (info.expandable && state.expanded.has(info.key)) {
        pageRows(spaceId, page.id, info.key, level + 1, out, preferred);
      }
    });
    if (entry.loading) out.push(noteRow("Loading", false, level));
    if (entry.error) out.push(noteRow(entry.error, true, level));
    if (!entry.loading && !entry.error && entry.items.length === 0) out.push(noteRow("No pages", false, level));
    if (entry.cursor && !entry.loading) {
      out.push(
        moreButton(key + ":more", function () {
          loadChildren(spaceId, parentId, entry.cursor);
        }),
      );
    }
  }

  function renderTree() {
    if (state.mode !== "fullscreen") return;
    treeInfo = new Map();
    const heading = el("h2", { class: "section-title" }, "Pages");
    const rows = [];
    const preferred = { row: null };
    state.spaces.forEach(function (space) {
      const info = {
        key: "s:" + space.id,
        parentKey: null,
        spaceId: space.id,
        parentId: null,
        expandable: true,
        page: null,
      };
      rows.push(treeRow(info, 1, dom.unwrap(space.name || space.slug || space.id)));
      if (state.expanded.has(info.key)) pageRows(space.id, null, info.key, 2, rows, preferred);
    });
    if (state.spacesLoading) rows.push(noteRow("Loading spaces", false, 0));
    if (state.spacesError) rows.push(noteRow(state.spacesError, true, 0));
    if (!state.spacesLoading && !state.spacesError && state.initialized && state.spaces.length === 0) {
      rows.push(noteRow("No spaces you can read.", false, 0));
    }
    if (state.spacesCursor && !state.spacesLoading) {
      rows.push(
        moreButton("spaces:more", function () {
          loadSpaces(state.spacesCursor);
        }),
      );
    }
    const tree = el("div", { class: "list", role: "tree", "aria-label": "Pages", onkeydown: onTreeKey }, rows);
    refresh(treeRegion, [heading, tree]);
    rovingStart(treeRegion, preferred.row);
  }

  // ---- Selection and preview --------------------------------------------------------------

  function announce(selected) {
    // Only server-generated ids go to the model, never wiki text.
    const pageId = selected.id;
    const spaceId = selected.space_id;
    bridge.updateContext({ page_id: pageId, space_id: spaceId }).catch(noop);
  }

  function selectPage(item) {
    if (!isObject(item) || !isId(item.id)) return;
    const spaceId = spaceIdOf(item);
    const same = state.selected !== null && state.selected.id === item.id;
    state.selected = {
      id: item.id,
      space_id: spaceId,
      title: dom.unwrap(item.title || "(untitled)"),
      url: dom.safeHref(item.url),
    };
    if (!same) {
      announce(state.selected);
      state.page = state.pages.get(item.id) || null;
      state.pageLoading = false;
      state.pageError = null;
      setStatus("", false);
    }
    if (!state.page && !state.pageLoading) loadPage(item.id);
    renderAll();
  }

  function loadPage(id) {
    state.pageLoading = true;
    state.pageError = null;
    call("get_page", { page: id, format: "json" }).then(
      function (data) {
        state.pages.set(id, data);
        if (!state.selected || state.selected.id !== id) return;
        state.pageLoading = false;
        state.page = data;
        const spaceId = isObject(data.space) && isId(data.space.id) ? data.space.id : null;
        if (spaceId && state.selected.space_id !== spaceId) {
          state.selected.space_id = spaceId;
          announce(state.selected);
        }
        const url = dom.safeHref(data.url);
        if (url) state.selected.url = url;
        renderAll();
      },
      function (error) {
        if (!state.selected || state.selected.id !== id) return;
        state.pageLoading = false;
        state.pageError = messageOf(error);
        renderAll();
      },
    );
    renderAll();
  }

  function pageActions() {
    const selected = state.selected;
    const href = selected.url;
    const open = el(
      "button",
      {
        type: "button",
        onclick: function () {
          if (!href) return;
          bridge.openLink(href).catch(function (error) {
            setStatus("Could not open Docmost: " + messageOf(error), true);
          });
        },
      },
      "Open in Docmost",
    );
    open.disabled = !href;
    return el(
      "div",
      { class: "actions" },
      open,
      el(
        "button",
        {
          type: "button",
          onclick: function () {
            askAbout(selected.id);
          },
        },
        "Ask Claude about this page",
      ),
    );
  }

  function askAbout(pageId) {
    if (!isId(pageId)) return;
    // A fixed template plus the page id; no wiki text.
    bridge.sendMessage(ASK_PREFIX + pageId + ASK_SUFFIX).then(
      function () {
        setStatus("Sent to the chat.", false);
      },
      function (error) {
        setStatus("Could not send the message: " + messageOf(error), true);
      },
    );
  }

  function renderSelection() {
    if (!state.selected) {
      refresh(selectionRegion, []);
      return;
    }
    refresh(selectionRegion, [
      el(
        "div",
        { class: "card" },
        el("span", { class: "item-title" }, state.selected.title),
        state.pageError ? el("p", { class: "error" }, state.pageError) : null,
        pageActions(),
      ),
    ]);
  }

  function renderPreview() {
    if (state.mode !== "fullscreen") return;
    if (!state.selected) {
      refresh(previewRegion, [el("p", { class: "muted" }, "Choose a page in the tree or the search results.")]);
      return;
    }
    const page = state.page;
    const parts = [];
    const title = page ? dom.unwrap(page.title || "(untitled)") : state.selected.title;
    parts.push(el("h1", { class: "page-title" }, title));
    if (page) {
      const trail = Array.isArray(page.path)
        ? page.path
            .filter(function (part) {
              return typeof part === "string";
            })
            .map(function (part) {
              return dom.unwrap(part);
            })
        : [];
      const where = isObject(page.space) && page.space.name ? dom.unwrap(page.space.name) : "";
      const crumbs = [where].concat(trail).filter(Boolean).join(" / ");
      if (crumbs) parts.push(el("p", { class: "muted" }, crumbs));
    }
    parts.push(pageActions());
    if (state.pageError) {
      parts.push(el("p", { class: "error" }, state.pageError));
    } else if (!page) {
      parts.push(el("p", { class: "muted" }, "Loading page"));
    } else {
      if (page.in_trash === true) parts.push(el("p", { class: "notice" }, "This page is in the trash."));
      if (page.truncated === true) {
        parts.push(el("p", { class: "notice" }, "This page is long; the preview shows only its start."));
      }
      const doc = renderer.parseContent(page.content);
      parts.push(doc === null ? el("p", { class: "error" }, "Could not read this page's content.") : renderer.renderDoc(doc));
    }
    refresh(previewRegion, parts);
  }

  // ---- Start ------------------------------------------------------------------------------

  // Set once the open_wiki result (or its error) has been applied; it is applied only once.
  let resultApplied = false;

  function loadSpacesOnce() {
    if (state.spaces.length === 0 && !state.spacesLoading) loadSpaces(null);
  }

  // No tool result yet (or it was cancelled): list the spaces so the browser is usable.
  // A tool result that arrives later is still applied by initFrom.
  function fallback() {
    state.initialized = true;
    if (resultApplied) return;
    loadSpacesOnce();
    renderAll();
  }

  function initFrom(data) {
    if (resultApplied) return;
    resultApplied = true;
    state.initialized = true;
    const spaces = Array.isArray(data.spaces)
      ? data.spaces.filter(function (space) {
          return isObject(space) && isId(space.id);
        })
      : [];
    if (spaces.length) {
      state.spaces = spaces;
      state.spacesCursor = cursorOf(data);
    } else {
      loadSpacesOnce();
    }
    const selected = isObject(data.selected) ? data.selected : {};
    const spaceId = isId(selected.space_id) ? selected.space_id : null;
    if (spaceId) {
      state.searchSpace = spaceId;
      state.expanded.add("s:" + spaceId);
      loadChildren(spaceId, null, null);
    }
    const page = isObject(selected.page) ? selected.page : isId(selected.id) ? selected : null;
    if (page) selectPage(page);
    if (typeof selected.query === "string" && selected.query.trim()) {
      input.value = selected.query.slice(0, 500);
      runSearch("search");
    }
    renderAll();
  }

  bridge.onToolResult(function (result) {
    if (result && result.isError) {
      if (resultApplied) return;
      resultApplied = true;
      state.initialized = true;
      setStatus(errorText(result), true);
      loadSpacesOnce();
      renderAll();
      return;
    }
    initFrom(bridge.structured(result) || {});
  });
  bridge.onToolCancelled(function () {
    setStatus("The request was cancelled.", false);
    fallback();
  });
  bridge.onHostContext(applyLayout);

  applyLayout({});
  setStatus("Loading", false);
  bridge.start({ name: "docmost-browser", version: "1" }).then(
    function (context) {
      if (status.textContent === "Loading") setStatus("", false);
      applyLayout(context || bridge.hostContext());
      // A host that sends no tool result still gets a usable browser.
      setTimeout(fallback, 1500);
    },
    function () {
      setStatus("Could not connect to the host.", true);
    },
  );
})();
