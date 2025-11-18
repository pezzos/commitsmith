"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const PORT = Number.parseInt(process.env.PORT ?? "5500", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const MEDIA_DIR = path.resolve(__dirname, "..", "media");
const VIEW_PROVIDER_PATH = path.resolve(
  __dirname,
  "..",
  "dist",
  "ui",
  "panel",
  "viewProvider.js",
);
const THEME_MOCK_PATH = path.join(MEDIA_DIR, "theme-mock.css");
const THEME_OVERRIDE_PATH = path.join(
  MEDIA_DIR,
  "theme-override.css",
);

const SSE_PATH = "/__dev/events";
const clients = new Set();
const watchers = [];

const vscodeStub = {
  window: {
    setStatusBarMessage(message) {
      console.log(`[DevServer] ${message}`);
      return { dispose() {} };
    },
    showWarningMessage(message) {
      console.warn(`[DevServer] ${message}`);
      return Promise.resolve();
    },
  },
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: path.resolve(__dirname, ".."),
        },
      },
    ],
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};

const noopDisposable = () => ({ dispose() {} });

const stubStateStore = {
  state: {
    collapsedSections: {},
    draftMessage: "",
    draftNote: "",
    manualNoteOptOut: false,
    pushAfterCommit: false,
    lastConfidence: null,
    offline: false,
    skippable: {},
    skipWarningsDismissed: false,
    repositoryAvailable: true,
    stepStatus: {},
    codexReview: null,
    journalEntries: [],
    journalHasMore: false,
    journalCursor: null,
  },
  onDidChange: () => noopDisposable(),
  get: () => undefined,
  update: async () => undefined,
};

const stubBridge = {
  attach: () => undefined,
  render: () => undefined,
  postMessage: () => undefined,
  onDidReceiveMessage: () => noopDisposable(),
  toResourceUri: (resourcePath) => {
    const normalized = String(resourcePath ?? "").replace(/^\/+/, "");
    return {
      toString: () => `/${normalized}`,
    };
  },
};

const stubGate = {
  onDidChange: () => noopDisposable(),
};

const stubRepositorySelector = {
  onDidChange: () => noopDisposable(),
  active: null,
};

function buildPanelHtml() {
  let provider;
  try {
    delete require.cache[VIEW_PROVIDER_PATH];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { CommitSmithViewProvider } = require(VIEW_PROVIDER_PATH);
    provider = new CommitSmithViewProvider(
      { subscriptions: [], extensionPath: path.resolve(__dirname, "..") },
      {
        stateStore: stubStateStore,
        bridge: stubBridge,
        gate: stubGate,
        repositorySelector: stubRepositorySelector,
      },
    );
  } catch (error) {
    console.error("Failed to prepare panel template:", error);
    return `<html><body><h1>Unable to load CommitSmith panel template.</h1><pre>${escapeHtml(
      String(error?.message ?? error),
    )}</pre></body></html>`;
  }

  try {
    const { head, body } = provider.renderDocument(
      {},
      "commit-smith-dev",
    );
    provider.dispose();
    const themedHead = prependThemeLinks(head);
    const toolkitScript =
      '<script type="module" src="https://unpkg.com/@vscode/webview-ui-toolkit@1.4.0/dist/toolkit.min.js"></script>';
    let headMarkup = themedHead ?? "";
    if (!headMarkup.includes(toolkitScript)) {
      const firstScriptIndex = headMarkup.indexOf("<script");
      if (firstScriptIndex === -1) {
        headMarkup = [headMarkup, toolkitScript].filter(Boolean).join("\n");
      } else {
        headMarkup = [
          headMarkup.slice(0, firstScriptIndex),
          toolkitScript,
          headMarkup.slice(firstScriptIndex),
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
    const html = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
      headMarkup,
      "</head>",
      '<body class="vscode-mock">',
      body,
      mockScriptSnippet(),
      "</body>",
      "</html>",
    ].join("\n");
    return html;
  } catch (error) {
    provider.dispose();
    console.error("Failed to render panel template:", error);
    return `<html><body><h1>Unable to render CommitSmith panel.</h1><pre>${escapeHtml(
      String(error?.message ?? error),
    )}</pre></body></html>`;
  }
}

function mockScriptSnippet() {
  return `<script>
(function () {
  if (typeof window.acquireVsCodeApi !== "function") {
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) => console.log("Mock VSCode message:", msg),
      getState: () => ({}),
      setState: () => {}
    });
  }

  try {
    const source = new EventSource("${SSE_PATH}");
    source.addEventListener("message", (event) => {
      if (event.data === "reload") {
        console.log("[CommitSmith Dev Server] Reloading...");
        window.location.reload();
      }
    });
    source.addEventListener("error", () => {
      console.warn("[CommitSmith Dev Server] Live reload connection lost.");
    });
  } catch (error) {
    console.warn("[CommitSmith Dev Server] Live reload disabled:", error);
  }
})();
</script>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function prependThemeLinks(headContent) {
  const links = [];
  if (fs.existsSync(THEME_MOCK_PATH)) {
    links.push('<link rel="stylesheet" href="/media/theme-mock.css">');
  } else {
    console.warn(
      "[CommitSmith Dev Server] media/theme-mock.css is missing. Run `npm run export:theme` to refresh it.",
    );
  }
  if (fs.existsSync(THEME_OVERRIDE_PATH)) {
    links.push(
      '<link rel="stylesheet" href="/media/theme-override.css">',
    );
  }
  const prefix = links.join("\n");
  if (!prefix) {
    return headContent ?? "";
  }
  return [prefix, headContent ?? ""].filter(Boolean).join("\n");
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(res, staticPath) {
  try {
    const data = await fs.promises.readFile(staticPath);
    res.writeHead(200, {
      "Content-Type": getContentType(staticPath),
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } else {
      console.error("Static asset error:", error);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
}

function broadcastReload() {
  if (clients.size === 0) {
    return;
  }
  for (const res of clients) {
    res.write("data: reload\n\n");
  }
}

function setupWatcher(targetPath) {
  const onFsEvent = (_eventType, name) => {
    if (typeof name === "string" && name.startsWith(".")) {
      return;
    }
    broadcastReload();
  };

  try {
    const watcher = fs.watch(targetPath, { recursive: true }, onFsEvent);
    watchers.push(watcher);
  } catch (error) {
    console.warn(
      `[CommitSmith Dev Server] Recursive watch unavailable for ${targetPath}: ${error.message}`,
    );
    const watcher = fs.watch(targetPath, onFsEvent);
    watchers.push(watcher);
  }
}

setupWatcher(MEDIA_DIR);
setupWatcher(VIEW_PROVIDER_PATH);

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === SSE_PATH) {
    handleSse(req, res);
    return;
  }

  if (
    requestUrl.pathname === "/" ||
    requestUrl.pathname === "/panel.html" ||
    requestUrl.pathname === "/index.html"
  ) {
    const html = buildPanelHtml();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(html);
    return;
  }

  if (requestUrl.pathname.startsWith("/media/")) {
    const relative = requestUrl.pathname.replace("/media/", "");
    const target = path.resolve(MEDIA_DIR, relative);
    if (!target.startsWith(MEDIA_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    void serveStatic(res, target);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`🔧 CommitSmith Dev Server running at ${url}`);
  openBrowser(url);
});

function openBrowser(targetUrl) {
  const platform = process.platform;
  let command;
  let args;

  if (platform === "darwin") {
    command = "open";
    args = [targetUrl];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", '""', targetUrl];
  } else {
    command = "xdg-open";
    args = [targetUrl];
  }

  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (error) => {
      console.warn(
        `[CommitSmith Dev Server] Unable to open browser automatically: ${error.message}`,
      );
    });
    child.unref();
  } catch (error) {
    console.warn(
      `[CommitSmith Dev Server] Unable to open browser automatically: ${error.message}`,
    );
  }
}

function shutdown() {
  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
