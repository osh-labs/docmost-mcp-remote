// Wiki browser view (shell). The full view replaces this script.
(function () {
  "use strict";
  const app = document.getElementById("app");
  app.appendChild(window.dom.el("p", { class: "muted" }, "Loading"));
  window.mcpBridge.start({ name: "docmost-browser", version: "1" }).catch(function () {
    app.replaceChildren(window.dom.el("p", { class: "error" }, "Could not connect to the host."));
  });
})();
