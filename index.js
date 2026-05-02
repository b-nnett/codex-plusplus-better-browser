/**
 * Better Browser
 *
 * Main-only Codex++ tweak. Main hooks apply immediately; renderer bundle
 * patches apply to the next app-shell load, so enabling the tweak during a
 * running session reloads existing Codex windows instead of requiring an app
 * restart.
 */

const GLOBAL_STATE_KEY = "__codexpp_better_browser_state__";
const PATCH_RENDERER_ASSET_KEY = "__codexpp_better_browser_patch_renderer_asset__";
const RELOAD_TOKEN_KEY = "__codexpp_better_browser_reload_token__";
const SERVICES_KEY = "__codexpp_window_services__";
const MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
const MESSAGE_FOR_VIEW = "codex_desktop:message-for-view";
const DEVTOOLS_CONTROL_IPC = "codexpp:better-browser-devtools-control";
const MAX_BROWSER_TABS = 25;
const BROWSER_THEMES = new Set(["dark", "light"]);
const INLINE_DEVTOOLS_DEFAULT_DOCK = "bottom";
const INLINE_DEVTOOLS_DOCKS = new Set(["left", "bottom", "right"]);
const INLINE_DEVTOOLS_HANDLE_SIZE = 7;
const INLINE_DEVTOOLS_MIN_WIDTH = 360;
const INLINE_DEVTOOLS_MAX_WIDTH = 760;
const INLINE_DEVTOOLS_WIDTH_RATIO = 0.46;
const INLINE_DEVTOOLS_MIN_HEIGHT = 260;
const INLINE_DEVTOOLS_MAX_HEIGHT = 720;
const INLINE_DEVTOOLS_HEIGHT_RATIO = 0.42;
const INLINE_DEVTOOLS_BOUNDS_POLL_MS = 16;
const DIRECT_COMMENT_ALIAS_TTL_MS = 5 * 60 * 1000;
const PATCHED_IPC_HANDLER = Symbol.for("codexpp.better-browser.ipcHandler");
const PATCHED_WEB_CONTENTS = Symbol.for("codexpp.better-browser.webContents");

/** @type {import("@codex-plusplus/sdk").Tweak} */
const tweak = {
  start(api) {
    if (api.process !== "main") return;

    const previous = globalThis[GLOBAL_STATE_KEY];
    if (previous && typeof previous.dispose === "function") {
      try {
        previous.dispose();
      } catch (error) {
        api.log.warn("failed to dispose previous instance", stringifyError(error));
      }
    }

    const state = {
      api,
      browserThemeByOwnerWebContentsId: new Map(),
      devToolsControlOwners: new Map(),
      directCommentAliases: new Map(),
      disposers: [],
      patchedAssets: new Set(),
      shortcutStateByWebContentsId: new Map(),
      webContentsEntries: new Map(),
    };

    state.dispose = () => stopMain(state);
    globalThis[GLOBAL_STATE_KEY] = state;
    globalThis[PATCH_RENDERER_ASSET_KEY] = patchRendererAsset;
    this._state = state;

    installProtocolPatch(api, state);
    installIpcPatch(state);
    installDevToolsControlIpc(api, state);
    installWebContentsPatch(api, state);
    installGlobalTabShortcuts(api, state);
    reloadExistingAppWindowsIfHotEnabled(api);
  },

  stop() {
    const state = this._state;
    if (state) stopMain(state);
  },
};

module.exports = tweak;

if (typeof process !== "undefined" && process.env?.BETTER_BROWSER_TEST === "1") {
  module.exports.__test = {
    assetPatchKind,
    patchRendererAsset,
    patchUseModelSettings,
    patchReviewRuntimeBridge,
    patchAppShell,
  };
}

function stopMain(state) {
  if (globalThis[GLOBAL_STATE_KEY] === state) {
    delete globalThis[GLOBAL_STATE_KEY];
  }
  if (globalThis[PATCH_RENDERER_ASSET_KEY] === patchRendererAsset) {
    delete globalThis[PATCH_RENDERER_ASSET_KEY];
  }

  for (const entry of state.webContentsEntries.values()) {
    restoreWebContents(entry);
  }
  state.webContentsEntries.clear();
  state.browserThemeByOwnerWebContentsId?.clear?.();
  state.devToolsControlOwners.clear();
  state.shortcutStateByWebContentsId.clear();

  for (const dispose of state.disposers.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      state.api.log.warn("dispose failed", stringifyError(error));
    }
  }
}

function installProtocolPatch(api, state) {
  const { protocol } = require("electron");
  const originalHandle = protocol.handle;

  protocol.handle = function betterBrowserProtocolHandle(scheme, handler) {
    if (scheme !== "app" || typeof handler !== "function") {
      return originalHandle.apply(this, arguments);
    }

    const wrappedHandler = async (request) => {
      const response = await handler(request);
      if (!shouldPatchRendererAsset(request?.url)) return response;

      let originalText = null;
      try {
        originalText = await response.text();
        const patcher = globalThis[PATCH_RENDERER_ASSET_KEY] ?? patchRendererAsset;
        const patchedText = patcher(request.url, originalText);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.set("content-type", "text/javascript; charset=utf-8");

        const assetName = assetPatchKind(request.url);
        if (patchedText !== originalText && !state.patchedAssets.has(assetName)) {
          state.patchedAssets.add(assetName);
          logInfo(api, `patched renderer asset: ${assetName}`);
        }

        return new Response(patchedText, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        api.log.warn("failed to patch renderer asset; serving original", {
          url: request?.url,
          error: stringifyError(error),
        });
        if (originalText != null) {
          return new Response(originalText, responseInitFrom(response));
        }
        return response;
      }
    };

    return originalHandle.call(this, scheme, wrappedHandler);
  };

  state.disposers.push(() => {
    protocol.handle = originalHandle;
  });
}

function installIpcPatch(state) {
  const { ipcMain } = require("electron");
  const originalHandle = ipcMain.handle;
  const handlerDisposers = [];

  const wrapMessageFromViewListener = (listener) => {
    if (listener?.[PATCHED_IPC_HANDLER]) return listener;

    const wrapped = async function betterBrowserMessageFromView(event, message, ...args) {
      const routedMessage = routeBrowserDirectCommentAlias(state, event, message);
      observeRendererMessage(state, event, routedMessage);
      return listener.call(this, event, routedMessage, ...args);
    };

    Object.defineProperty(wrapped, PATCHED_IPC_HANDLER, {
      configurable: true,
      value: {
        original: listener,
      },
    });

    return wrapped;
  };

  ipcMain.handle = function betterBrowserIpcHandle(channel, listener) {
    if (channel !== MESSAGE_FROM_VIEW || typeof listener !== "function") {
      return originalHandle.apply(this, arguments);
    }

    return originalHandle.call(this, channel, wrapMessageFromViewListener(listener));
  };

  wrapExistingInvokeHandler(ipcMain, MESSAGE_FROM_VIEW, wrapMessageFromViewListener, handlerDisposers);

  state.disposers.push(() => {
    ipcMain.handle = originalHandle;
    for (const dispose of handlerDisposers.splice(0).reverse()) {
      dispose();
    }
  });
}

function wrapExistingInvokeHandler(ipcMain, channel, wrapListener, disposers) {
  const handlers = ipcMain?._invokeHandlers;
  if (!handlers || typeof handlers.get !== "function" || typeof handlers.set !== "function") return false;

  const existing = handlers.get(channel);
  if (typeof existing !== "function" || existing[PATCHED_IPC_HANDLER]) return false;

  const wrapped = wrapListener(existing);
  handlers.set(channel, wrapped);

  disposers.push(() => {
    if (handlers.get(channel) === wrapped) {
      handlers.set(channel, existing);
    }
  });

  return true;
}

function installDevToolsControlIpc(api, state) {
  const { ipcMain } = require("electron");
  const listener = (event, message) => {
    const entry = state.devToolsControlOwners.get(event.sender.id);
    if (!entry || !message || typeof message !== "object") return;
    handleInlineDevToolsControlMessage(api, state, entry, message);
  };

  ipcMain.on(DEVTOOLS_CONTROL_IPC, listener);
  state.disposers.push(() => ipcMain.off(DEVTOOLS_CONTROL_IPC, listener));
}

function installWebContentsPatch(api, state) {
  const { app, webContents } = require("electron");

  const patchOne = (_event, wc) => patchWebContents(api, state, wc);
  app.on("web-contents-created", patchOne);
  state.disposers.push(() => app.off("web-contents-created", patchOne));

  for (const wc of webContents.getAllWebContents()) {
    patchWebContents(api, state, wc);
  }
}

function installGlobalTabShortcuts(api, state) {
  const { app, BrowserWindow, globalShortcut } = require("electron");
  const registered = new Set();
  const warned = new Set();

  const register = () => {
    if (registered.size > 0) return;
    for (let ordinal = 1; ordinal <= 9; ordinal += 1) {
      const accelerator = `Control+${ordinal}`;
      try {
        const ok = globalShortcut.register(accelerator, () => {
          activateRightPanelTabFromFocusedContext(state, ordinal);
        });
        if (ok) {
          registered.add(accelerator);
        } else if (!warned.has(accelerator)) {
          warned.add(accelerator);
          api.log.warn("failed to register right-panel tab shortcut", { accelerator });
        }
      } catch (error) {
        if (!warned.has(accelerator)) {
          warned.add(accelerator);
          api.log.warn("failed to register right-panel tab shortcut", {
            accelerator,
            error: stringifyError(error),
          });
        }
      }
    }
  };

  const unregister = () => {
    for (const accelerator of registered) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* non-critical */
      }
    }
    registered.clear();
  };

  const hasFocusedCodexWindow = () => {
    return BrowserWindow.getAllWindows().some((window) => {
      if (window.isDestroyed() || !window.isFocused()) return false;
      return isAppShellContent(window.webContents);
    });
  };

  const registerIfFocused = () => {
    if (hasFocusedCodexWindow()) register();
  };

  const unregisterIfBlurred = () => {
    setTimeout(() => {
      if (!hasFocusedCodexWindow()) unregister();
    }, 50);
  };

  const attach = () => {
    registerIfFocused();
    app.on("browser-window-focus", registerIfFocused);
    app.on("browser-window-blur", unregisterIfBlurred);
  };

  if (app.isReady()) {
    attach();
  } else {
    app.once("ready", attach);
    state.disposers.push(() => app.off("ready", attach));
  }

  state.disposers.push(() => {
    app.off("browser-window-focus", registerIfFocused);
    app.off("browser-window-blur", unregisterIfBlurred);
    unregister();
  });
}

function activateRightPanelTabFromFocusedContext(state, ordinal) {
  const { BrowserWindow, webContents } = require("electron");
  const focusedContents = webContents.getFocusedWebContents?.();

  if (focusedContents && isLikelyBrowserContent(focusedContents)) {
    return switchRightPanelBrowserTabByOrdinal(focusedContents, ordinal);
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed() || !focusedWindow.isFocused()) return false;

  const ownerWebContents = focusedWindow.webContents;
  if (!ownerWebContents || ownerWebContents.isDestroyed?.() || !isAppShellContent(ownerWebContents)) {
    return false;
  }

  return switchFocusedRightPanelTabByOrdinal(state, ownerWebContents, ordinal);
}

function patchWebContents(api, state, wc) {
  if (!wc || wc.isDestroyed?.() || wc[PATCHED_WEB_CONTENTS]) return;

  const entry = {
    wc,
    browserTheme: null,
    browserThemeCssKey: null,
    browserThemeCssToken: null,
    browserThemeDebuggerAttached: false,
    browserThemeDebuggerDetachListener: null,
    browserThemeWarned: false,
    devToolsLayout: {
      dock: INLINE_DEVTOOLS_DEFAULT_DOCK,
      open: false,
      sizes: Object.create(null),
    },
    hadBrowserPageState: false,
    inlineDevTools: null,
    originalCloseDevTools: wc.closeDevTools,
    originalInspectElement: wc.inspectElement,
    originalOpenDevTools: wc.openDevTools,
    originalSend: wc.send,
    listeners: [],
  };

  Object.defineProperty(wc, PATCHED_WEB_CONTENTS, {
    configurable: true,
    value: entry,
  });
  state.webContentsEntries.set(wc.id, entry);

  wc.openDevTools = function betterBrowserOpenDevTools(options = {}) {
    if (isLikelyBrowserContent(wc)) {
      if (openInlineDevTools(api, state, entry, options)) return undefined;
      return openFallbackDevTools(api, entry, options);
    }
    return entry.originalOpenDevTools.apply(this, arguments);
  };

  wc.closeDevTools = function betterBrowserCloseDevTools(...args) {
    if (isLikelyBrowserContent(wc)) {
      try {
        entry.devToolsLayout.open = false;
        return entry.originalCloseDevTools.apply(this, args);
      } finally {
        disposeInlineDevTools(entry, { closeDevTools: false });
      }
    }
    return entry.originalCloseDevTools.apply(this, args);
  };

  wc.inspectElement = function betterBrowserInspectElement(...args) {
    if (!isLikelyBrowserContent(wc)) {
      return entry.originalInspectElement.apply(this, args);
    }

    const openedInline = openInlineDevTools(api, state, entry, { activate: true });
    if (!openedInline) openFallbackDevTools(api, entry, { activate: true });

    const inspect = () => {
      if (wc.isDestroyed?.()) return;
      try {
        entry.originalInspectElement.apply(wc, args);
        revealDevTools(wc, 0);
        revealDevTools(wc, 250);
      } catch (error) {
        api.log.warn("failed to inspect browser element", stringifyError(error));
      }
    };

    setTimeout(inspect, wc.isDevToolsOpened?.() ? 0 : 100);
    return undefined;
  };

  wc.send = function betterBrowserSend(channel, message) {
    if (channel === MESSAGE_FOR_VIEW && message?.type === "browser-sidebar-direct-comment") {
      const baseConversationId = getBaseConversationIdForBrowserTab(message.conversationId);
      if (baseConversationId) {
        rememberBrowserDirectCommentAlias(
          state,
          wc.id,
          baseConversationId,
          message.conversationId,
          message.sessionId,
        );
        entry.originalSend.call(this, channel, message);
        entry.originalSend.call(this, channel, {
          ...message,
          conversationId: baseConversationId,
        });
        return undefined;
      }
    }

    if (
      channel === MESSAGE_FOR_VIEW &&
      message &&
      (message.type === "navigate-back" || message.type === "navigate-forward") &&
      goBrowserHistory(state, wc, message.type === "navigate-back" ? "back" : "forward")
    ) {
      return undefined;
    }
    return entry.originalSend.apply(this, arguments);
  };

  const beforeInput = (event, input) => {
    const tabOrdinal = getRightPanelTabShortcutOrdinal(input);
    if (
      tabOrdinal != null &&
      isLikelyBrowserContent(wc) &&
      switchRightPanelBrowserTabByOrdinal(wc, tabOrdinal)
    ) {
      event.preventDefault();
      return;
    }

    if (
      tabOrdinal != null &&
      isAppShellContent(wc) &&
      switchFocusedRightPanelTabByOrdinal(state, wc, tabOrdinal)
    ) {
      event.preventDefault();
      return;
    }

    if (isDevToolsShortcut(input)) {
      if (isLikelyBrowserContent(wc)) {
        event.preventDefault();
        toggleInlineDevToolsForEntry(state, entry);
        return;
      }

      if (isAppShellContent(wc) && toggleInlineDevToolsForOwnerWebContents(state, wc)) {
        event.preventDefault();
        return;
      }
    }

    if (!isBrowserHistoryShortcut(input)) return;

    if (isLikelyBrowserContent(wc)) {
      event.preventDefault();
      if (isBackInput(input)) {
        if (wc.canGoBack()) wc.goBack();
      } else if (wc.canGoForward()) {
        wc.goForward();
      }
      return;
    }

    if (
      isAppShellContent(wc) &&
      goBrowserHistoryForFocusedRightPanel(state, wc, isBackInput(input) ? "back" : "forward")
    ) {
      event.preventDefault();
    }
  };

  const injectGestures = () => {
    if (!isLikelyBrowserContent(wc) || !isInjectablePageUrl(wc.getURL())) return;
    wc.executeJavaScript(browserGestureInjectionScript(wc), true).catch((error) => {
      api.log.warn("failed to inject browser swipe gestures", stringifyError(error));
    });
  };

  const applyBrowserTheme = () => {
    applyBrowserThemeForEntry(api, entry);
  };

  const injectAppShellShortcuts = () => {
    if (!isAppShellContent(wc)) return;
    wc.executeJavaScript(APP_SHELL_RIGHT_TAB_SHORTCUT_SCRIPT, true).catch((error) => {
      api.log.warn("failed to inject right-panel tab shortcuts", stringifyError(error));
    });
    wc.executeJavaScript(APP_SHELL_DEVTOOLS_DOCK_MENU_SCRIPT, true).catch((error) => {
      api.log.warn("failed to inject DevTools dock menu", stringifyError(error));
    });
  };

  const destroyed = () => {
    restoreWebContents(entry);
    state.webContentsEntries.delete(wc.id);
    state.browserThemeByOwnerWebContentsId.delete(wc.id);
    state.shortcutStateByWebContentsId.delete(wc.id);
  };

  wc.on("before-input-event", beforeInput);
  wc.on("dom-ready", injectAppShellShortcuts);
  wc.on("did-finish-load", injectAppShellShortcuts);
  wc.on("dom-ready", injectGestures);
  wc.on("did-navigate", injectGestures);
  wc.on("did-navigate-in-page", injectGestures);
  wc.on("did-finish-load", injectGestures);
  wc.on("did-stop-loading", injectGestures);
  wc.on("dom-ready", applyBrowserTheme);
  wc.on("did-navigate", applyBrowserTheme);
  wc.on("did-navigate-in-page", applyBrowserTheme);
  wc.on("did-finish-load", applyBrowserTheme);
  wc.on("did-stop-loading", applyBrowserTheme);
  wc.once("destroyed", destroyed);

  entry.listeners.push(["before-input-event", beforeInput]);
  entry.listeners.push(["dom-ready", injectAppShellShortcuts]);
  entry.listeners.push(["did-finish-load", injectAppShellShortcuts]);
  entry.listeners.push(["dom-ready", injectGestures]);
  entry.listeners.push(["did-navigate", injectGestures]);
  entry.listeners.push(["did-navigate-in-page", injectGestures]);
  entry.listeners.push(["did-finish-load", injectGestures]);
  entry.listeners.push(["did-stop-loading", injectGestures]);
  entry.listeners.push(["dom-ready", applyBrowserTheme]);
  entry.listeners.push(["did-navigate", applyBrowserTheme]);
  entry.listeners.push(["did-navigate-in-page", applyBrowserTheme]);
  entry.listeners.push(["did-finish-load", applyBrowserTheme]);
  entry.listeners.push(["did-stop-loading", applyBrowserTheme]);
  entry.listeners.push(["destroyed", destroyed]);

  injectAppShellShortcuts();
  injectGestures();
  applyBrowserTheme();
}

function revealDevTools(wc, delayMs = 50) {
  const reveal = () => {
    if (!wc || wc.isDestroyed?.()) return;
    const devToolsWebContents = wc.devToolsWebContents;
    if (!devToolsWebContents || devToolsWebContents.isDestroyed?.()) return;

    try {
      devToolsWebContents.focus?.();
    } catch {
      /* non-critical */
    }

    try {
      const { BrowserWindow } = require("electron");
      const devToolsWindow = BrowserWindow.fromWebContents(devToolsWebContents);
      if (devToolsWindow && !devToolsWindow.isDestroyed()) {
        devToolsWindow.show();
        devToolsWindow.focus();
      }
    } catch {
      /* non-critical */
    }
  };

  if (delayMs > 0) {
    setTimeout(reveal, delayMs);
  } else {
    reveal();
  }
}

function openInlineDevTools(api, state, entry, options = {}) {
  const wc = entry.wc;
  if (!wc || wc.isDestroyed?.() || typeof wc.setDevToolsWebContents !== "function") return false;

  const ownerWindow = getBrowserOwnerWindow(wc);
  if (!ownerWindow || ownerWindow.isDestroyed()) return false;

  try {
    const { BrowserView } = require("electron");
    if (typeof BrowserView !== "function" || typeof ownerWindow.addBrowserView !== "function") {
      return false;
    }

    let inline = entry.inlineDevTools;
    if (
      !inline ||
      inline.disposed ||
      !inline.view ||
      inline.view.webContents?.isDestroyed?.() ||
      inline.ownerWindow !== ownerWindow
    ) {
      disposeInlineDevTools(entry, { closeDevTools: false, preserveOpenState: true });
      if (wc.isDevToolsOpened?.()) {
        try {
          entry.originalCloseDevTools.call(wc);
        } catch {
          /* non-critical */
        }
      }

      const devToolsView = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const handleView = createInlineDevToolsControlView(BrowserView);
      ownerWindow.addBrowserView(devToolsView);
      ownerWindow.addBrowserView(handleView);
      devToolsView.setAutoResize?.({ width: false, height: false });
      handleView.setAutoResize?.({ width: false, height: false });
      state.devToolsControlOwners.set(handleView.webContents.id, entry);

      inline = {
        controlWebContentsIds: [handleView.webContents.id],
        disposed: false,
        handleView,
        ignoreNextDevToolsClosed: false,
        listeners: [],
        ownerWindow,
        view: devToolsView,
      };
      entry.inlineDevTools = inline;
      loadInlineDevToolsControlViews(entry);

      const updateBounds = () => {
        positionInlineDevToolsViews(entry);
      };
      inline.boundsInterval = setInterval(updateBounds, INLINE_DEVTOOLS_BOUNDS_POLL_MS);
      inline.boundsInterval.unref?.();
      const devToolsClosed = () => {
        if (inline.ignoreNextDevToolsClosed) {
          inline.ignoreNextDevToolsClosed = false;
          return;
        }
        entry.devToolsLayout.open = false;
        disposeInlineDevTools(entry, { closeDevTools: false });
      };
      const viewDestroyed = () => {
        disposeInlineDevTools(entry, { closeDevTools: true });
      };
      const handleWebContentsId = handleView.webContents.id;
      const controlDestroyed = (controlWebContentsId) => {
        state.devToolsControlOwners.delete(controlWebContentsId);
      };
      const handleDestroyed = () => controlDestroyed(handleWebContentsId);
      const devToolsBeforeInput = (event, input) => {
        if (!isDevToolsShortcut(input)) return;
        event.preventDefault();
        toggleInlineDevToolsForEntry(state, entry);
      };

      ownerWindow.on("move", updateBounds);
      ownerWindow.on("resize", updateBounds);
      ownerWindow.on("enter-full-screen", updateBounds);
      ownerWindow.on("leave-full-screen", updateBounds);
      wc.on("devtools-closed", devToolsClosed);
      devToolsView.webContents.on("before-input-event", devToolsBeforeInput);
      devToolsView.webContents.once("destroyed", viewDestroyed);
      handleView.webContents.once("destroyed", handleDestroyed);

      inline.listeners.push([ownerWindow, "move", updateBounds]);
      inline.listeners.push([ownerWindow, "resize", updateBounds]);
      inline.listeners.push([ownerWindow, "enter-full-screen", updateBounds]);
      inline.listeners.push([ownerWindow, "leave-full-screen", updateBounds]);
      inline.listeners.push([wc, "devtools-closed", devToolsClosed]);
      inline.listeners.push([devToolsView.webContents, "before-input-event", devToolsBeforeInput]);
      inline.listeners.push([devToolsView.webContents, "destroyed", viewDestroyed]);
      inline.listeners.push([handleView.webContents, "destroyed", handleDestroyed]);
    }

    entry.devToolsLayout.open = true;
    positionInlineDevToolsViews(entry);

    if (wc.devToolsWebContents !== inline.view.webContents) {
      if (wc.isDevToolsOpened?.()) {
        try {
          inline.ignoreNextDevToolsClosed = true;
          entry.originalCloseDevTools.call(wc);
        } catch {
          /* non-critical */
        } finally {
          setTimeout(() => {
            if (entry.inlineDevTools === inline) inline.ignoreNextDevToolsClosed = false;
          }, 100);
        }
      }
      wc.setDevToolsWebContents(inline.view.webContents);
    }

    entry.originalOpenDevTools.call(wc, {
      ...options,
      mode: "detach",
      activate: options?.activate ?? true,
    });

    positionInlineDevToolsViews(entry);
    if (options?.activate !== false) {
      inline.view.webContents.focus?.();
    }
    revealDevTools(wc, 50);
    return true;
  } catch (error) {
    api.log.warn("failed to open managed inline devtools", stringifyError(error));
    disposeInlineDevTools(entry, { closeDevTools: true });
    return false;
  }
}

function openFallbackDevTools(api, entry, options = {}) {
  const wc = entry.wc;
  try {
    const result = entry.originalOpenDevTools.call(wc, {
      ...options,
      mode: options?.mode && options.mode !== "detach" ? options.mode : "right",
      activate: options?.activate ?? true,
    });
    revealDevTools(wc);
    return result;
  } catch (error) {
    api.log.warn("failed to open browser devtools", stringifyError(error));
    return undefined;
  }
}

function createInlineDevToolsControlView(BrowserView) {
  return new BrowserView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });
}

function loadInlineDevToolsControlViews(entry) {
  const inline = entry.inlineDevTools;
  if (!inline || inline.disposed) return;
  loadInlineDevToolsControlView(entry, inline.handleView);
}

function loadInlineDevToolsControlView(entry, view) {
  if (!view?.webContents || view.webContents.isDestroyed?.()) return;
  const dock = getInlineDevToolsDock(entry);
  const html = inlineDevToolsHandleHtml(dock);
  view.webContents.loadURL(dataHtmlUrl(html)).catch(() => {
    /* non-critical */
  });
}

function dataHtmlUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function inlineDevToolsHandleHtml(dock) {
  const isBottom = dock === "bottom";
  const cursor = isBottom ? "row-resize" : "col-resize";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#a6abb2;cursor:${cursor};user-select:none}
body:hover{background:#b2b6bc}
body:active{background:#989ea6}
#knob{position:absolute;left:50%;top:50%;width:5px;height:5px;box-sizing:border-box;transform:translate(-50%,-50%);border-radius:999px;background:#59606a}
@media (prefers-color-scheme: dark){
html,body{background:#3f454d}
body:hover{background:#4b525b}
body:active{background:#343a42}
#knob{background:#20242a}
}
</style>
</head>
<body><div id="knob"></div>
<script>
const { ipcRenderer } = require("electron");
const channel = ${JSON.stringify(DEVTOOLS_CONTROL_IPC)};
let dragging = false;
window.addEventListener("pointerdown", event => {
  dragging = true;
  document.body.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
window.addEventListener("pointermove", event => {
  if (!dragging) return;
  ipcRenderer.send(channel, {
    type: "resize",
    deltaX: Number(event.movementX) || 0,
    deltaY: Number(event.movementY) || 0,
  });
  event.preventDefault();
});
window.addEventListener("pointerup", event => {
  dragging = false;
  document.body.releasePointerCapture?.(event.pointerId);
  event.preventDefault();
});
window.addEventListener("pointercancel", () => { dragging = false; });
</script>
</body>
</html>`;
}

function handleInlineDevToolsControlMessage(api, state, entry, message) {
  if (!entry.inlineDevTools || entry.inlineDevTools.disposed) return;

  if (message.type === "resize") {
    const deltaX = Number(message.deltaX) || 0;
    const deltaY = Number(message.deltaY) || 0;
    resizeInlineDevTools(entry, deltaX, deltaY);
  }
}

function disposeInlineDevTools(entry, options = {}) {
  const inline = entry.inlineDevTools;
  if (!inline || inline.disposed) return;
  inline.disposed = true;
  entry.inlineDevTools = null;
  if (!options.preserveOpenState) {
    entry.devToolsLayout.open = false;
  }

  const state = globalThis[GLOBAL_STATE_KEY];
  if (state?.devToolsControlOwners && Array.isArray(inline.controlWebContentsIds)) {
    for (const id of inline.controlWebContentsIds) {
      state.devToolsControlOwners.delete(id);
    }
  }

  for (const [target, eventName, listener] of inline.listeners) {
    try {
      target.off(eventName, listener);
    } catch {
      /* non-critical */
    }
  }
  inline.listeners.length = 0;
  if (inline.boundsInterval != null) {
    clearInterval(inline.boundsInterval);
    inline.boundsInterval = null;
  }

  const wc = entry.wc;
  if (options.closeDevTools && wc && !wc.isDestroyed?.()) {
    try {
      entry.originalCloseDevTools.call(wc);
    } catch {
      /* non-critical */
    }
  }

  for (const view of [inline.handleView, inline.view]) {
    if (!view) continue;
    if (inline.ownerWindow && !inline.ownerWindow.isDestroyed?.()) {
      try {
        inline.ownerWindow.removeBrowserView?.(view);
      } catch {
        /* non-critical */
      }
    }
    if (view.webContents && !view.webContents.isDestroyed?.()) {
      try {
        view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        /* non-critical */
      }
    }
  }
}

function resizeInlineDevTools(entry, deltaX, deltaY) {
  const inline = entry.inlineDevTools;
  if (!inline || inline.disposed || !inline.ownerWindow || inline.ownerWindow.isDestroyed()) {
    return;
  }

  const { container, visible } = getInlineDevToolsLayoutContainer(entry.wc, inline.ownerWindow);
  if (!visible) return;
  const dock = getInlineDevToolsDock(entry);
  const currentSize = getInlineDevToolsSize(entry, dock, container);
  let nextSize = currentSize;

  if (dock === "left") {
    nextSize += deltaX;
  } else if (dock === "right") {
    nextSize -= deltaX;
  } else {
    nextSize -= deltaY;
  }

  entry.devToolsLayout.sizes[dock] = clampInlineDevToolsSize(dock, nextSize, container);
  positionInlineDevToolsViews(entry);
}

function positionInlineDevToolsViews(entry) {
  const inline = entry.inlineDevTools;
  if (
    !inline ||
    inline.disposed ||
    !inline.view ||
    inline.view.webContents?.isDestroyed?.() ||
    !inline.ownerWindow ||
    inline.ownerWindow.isDestroyed()
  ) {
    return;
  }

  if (entry.hadBrowserPageState && findBrowserPageForWebContentsId(entry.wc.id) == null) {
    entry.devToolsLayout.open = false;
    disposeInlineDevTools(entry, { closeDevTools: true });
    return;
  }

  const bounds = getInlineDevToolsViewBounds(entry, inline.ownerWindow);

  try {
    if (!bounds || entry.devToolsLayout.open !== true || !isInlineDevToolsActiveForOwner(entry)) {
      hideInlineDevToolsViews(inline);
      return;
    }

    const nextBoundsKey = inlineDevToolsBoundsKey(bounds);
    if (inline.lastBoundsKey !== nextBoundsKey) {
      inline.view.setBounds(bounds.devTools);
      inline.handleView?.setBounds(bounds.handle);
      inline.lastBoundsKey = nextBoundsKey;
      inline.viewsHidden = false;
    }
    inline.ownerWindow.setTopBrowserView?.(inline.handleView);
  } catch {
    /* non-critical */
  }
}

function hideInlineDevToolsViews(inline) {
  if (inline.viewsHidden) return;
  const hidden = { x: -10000, y: -10000, width: 1, height: 1 };
  try {
    inline.view?.setBounds(hidden);
    inline.handleView?.setBounds(hidden);
    inline.lastBoundsKey = "hidden";
    inline.viewsHidden = true;
  } catch {
    /* non-critical */
  }
}

function inlineDevToolsBoundsKey(bounds) {
  const devTools = bounds?.devTools;
  const handle = bounds?.handle;
  return [
    devTools?.x,
    devTools?.y,
    devTools?.width,
    devTools?.height,
    handle?.x,
    handle?.y,
    handle?.width,
    handle?.height,
  ].join(":");
}

function isInlineDevToolsActiveForOwner(entry) {
  const state = globalThis[GLOBAL_STATE_KEY];
  const pageState = findBrowserPageForWebContentsId(entry.wc.id);
  const ownerWebContents =
    pageState?.windowState?.owner ??
    pageState?.ownerWebContents ??
    pageState?.owner ??
    null;
  if (!state || !ownerWebContents || ownerWebContents.isDestroyed?.()) return true;

  const conversationId = getPageStateConversationId(pageState);
  if (typeof conversationId !== "string" || conversationId.length === 0) return true;

  const shortcutState = getShortcutState(state, ownerWebContents);
  if (!shortcutState) return true;
  const activeConversationId = shortcutState.rightPanelBrowserConversationId;
  if (typeof activeConversationId !== "string" || activeConversationId.length === 0) {
    return shortcutState.rightPanelCanCloseActiveTab === true && getBrowserPageContentBounds(entry.wc) != null;
  }
  return activeConversationId === conversationId;
}

function getInlineDevToolsViewBounds(entry, ownerWindow) {
  const { container, visible } = getInlineDevToolsLayoutContainer(entry.wc, ownerWindow);
  if (!visible) return null;
  const dock = getInlineDevToolsDock(entry);
  const size = getInlineDevToolsSize(entry, dock, container);
  const handleSize = INLINE_DEVTOOLS_HANDLE_SIZE;
  let devTools;
  let handle;

  if (dock === "left") {
    devTools = {
      x: Math.round(container.x),
      y: Math.round(container.y),
      width: Math.round(size),
      height: Math.round(container.height),
    };
    handle = {
      x: Math.round(container.x + size),
      y: Math.round(container.y),
      width: handleSize,
      height: Math.round(container.height),
    };
  } else if (dock === "bottom") {
    devTools = {
      x: Math.round(container.x),
      y: Math.round(container.y + container.height - size),
      width: Math.round(container.width),
      height: Math.round(size),
    };
    handle = {
      x: Math.round(container.x),
      y: Math.round(devTools.y - handleSize),
      width: Math.round(container.width),
      height: handleSize,
    };
  } else {
    devTools = {
      x: Math.round(container.x + container.width - size),
      y: Math.round(container.y),
      width: Math.round(size),
      height: Math.round(container.height),
    };
    handle = {
      x: Math.round(devTools.x - handleSize),
      y: Math.round(container.y),
      width: handleSize,
      height: Math.round(container.height),
    };
  }

  return {
    devTools: clampRectToBounds(devTools, container),
    handle: clampRectToBounds(handle, container),
  };
}

function getInlineDevToolsLayoutContainer(wc, ownerWindow) {
  const contentBounds = ownerWindow.getContentBounds();
  const pageBounds = getBrowserPageContentBounds(wc);
  const entry = wc?.[PATCHED_WEB_CONTENTS] ?? null;
  const hasPageState = findBrowserPageForWebContentsId(wc.id) != null;
  if ((hasPageState || entry?.hadBrowserPageState === true) && !pageBounds) {
    return {
      container: { x: 0, y: 0, width: 0, height: 0 },
      contentBounds,
      visible: false,
    };
  }
  const rawContainer = pageBounds
    ? rectToContentBounds(pageBounds, contentBounds)
    : {
        x: 0,
        y: 0,
        width: contentBounds.width,
        height: contentBounds.height,
      };

  const container = clampRectToBounds(rawContainer, {
    x: 0,
    y: 0,
    width: contentBounds.width,
    height: contentBounds.height,
  });

  const visible = container.width >= 260 && container.height >= 180;

  return { container, contentBounds, visible };
}

function getInlineDevToolsDock(entry) {
  const dock = entry.devToolsLayout?.dock;
  return INLINE_DEVTOOLS_DOCKS.has(dock) ? dock : INLINE_DEVTOOLS_DEFAULT_DOCK;
}

function getInlineDevToolsSize(entry, dock, container) {
  const saved = Number(entry.devToolsLayout?.sizes?.[dock]);
  if (Number.isFinite(saved) && saved > 0) {
    return clampInlineDevToolsSize(dock, saved, container);
  }

  const desired =
    dock === "bottom"
      ? Math.round(container.height * INLINE_DEVTOOLS_HEIGHT_RATIO)
      : Math.round(container.width * INLINE_DEVTOOLS_WIDTH_RATIO);
  return clampInlineDevToolsSize(dock, desired, container);
}

function clampInlineDevToolsSize(dock, size, container) {
  const dimension = dock === "bottom" ? container.height : container.width;
  const min = dock === "bottom" ? INLINE_DEVTOOLS_MIN_HEIGHT : INLINE_DEVTOOLS_MIN_WIDTH;
  const configuredMax = dock === "bottom" ? INLINE_DEVTOOLS_MAX_HEIGHT : INLINE_DEVTOOLS_MAX_WIDTH;
  const max = Math.max(80, Math.min(configuredMax, dimension - INLINE_DEVTOOLS_HANDLE_SIZE));
  const minForContainer = Math.min(min, max);
  return Math.max(minForContainer, Math.min(max, Math.round(size)));
}

function getBrowserPageContentBounds(wc) {
  const pageState = findBrowserPageForWebContentsId(wc.id);
  if (pageState && wc?.[PATCHED_WEB_CONTENTS]) {
    wc[PATCHED_WEB_CONTENTS].hadBrowserPageState = true;
  }
  const candidates = [
    pageState?.threadState?.bounds,
    pageState?.thread?.bounds,
    pageState?.page?.bounds,
    pageState?.browserBounds,
    pageState?.bounds,
  ];

  for (const candidate of candidates) {
    const rect = normalizeRect(candidate);
    if (rect && rect.width >= 320 && rect.height >= 240) return rect;
  }

  return null;
}

function getBrowserOwnerWebContents(entry) {
  const pageState = findBrowserPageForWebContentsId(entry?.wc?.id);
  const ownerWebContents =
    pageState?.windowState?.owner ??
    pageState?.ownerWebContents ??
    pageState?.owner ??
    null;
  return ownerWebContents && !ownerWebContents.isDestroyed?.() ? ownerWebContents : null;
}

function getBrowserOwnerWindow(wc) {
  const { BrowserWindow } = require("electron");
  const directWindow = BrowserWindow.fromWebContents(wc);
  if (directWindow && !directWindow.isDestroyed()) return directWindow;

  const pageState = findBrowserPageForWebContentsId(wc.id);
  const stateWindow = pageState?.windowState?.window ?? pageState?.window;
  if (stateWindow && typeof stateWindow.isDestroyed === "function" && !stateWindow.isDestroyed()) {
    return stateWindow;
  }

  const ownerContents =
    pageState?.windowState?.owner ??
    pageState?.ownerWebContents ??
    pageState?.owner ??
    null;
  const ownerWindow =
    ownerContents && !ownerContents.isDestroyed?.()
      ? BrowserWindow.fromWebContents(ownerContents)
      : null;
  if (ownerWindow && !ownerWindow.isDestroyed()) return ownerWindow;

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed() && isAppShellContent(focusedWindow.webContents)) {
    return focusedWindow;
  }

  return null;
}

function getOwnerWindowForWebContents(wc) {
  if (!wc || wc.isDestroyed?.()) return null;
  try {
    const { BrowserWindow } = require("electron");
    const window = BrowserWindow.fromWebContents(wc);
    return window && !window.isDestroyed() ? window : null;
  } catch {
    return null;
  }
}

function getBrowserTheme(entry) {
  if (BROWSER_THEMES.has(entry?.browserTheme)) return entry.browserTheme;
  const state = globalThis[GLOBAL_STATE_KEY];
  const owner = getBrowserOwnerWebContents(entry);
  const ownerTheme = owner ? state?.browserThemeByOwnerWebContentsId?.get(owner.id) : null;
  return BROWSER_THEMES.has(ownerTheme) ? ownerTheme : getDefaultBrowserTheme();
}

function getDefaultBrowserTheme() {
  try {
    const { nativeTheme } = require("electron");
    return nativeTheme?.shouldUseDarkColors ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyBrowserThemeForEntry(api, entry) {
  const wc = entry?.wc;
  if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) return false;
  const url = wc.getURL?.() ?? "";
  if (!isInjectablePageUrl(url)) return false;

  const theme = getBrowserTheme(entry);
  let applied = applyBrowserThemeViaCdp(api, entry, theme);
  applied = applyBrowserThemeFallback(api, entry, theme) || applied;
  return applied;
}

function applyBrowserThemeViaCdp(api, entry, theme) {
  const wc = entry?.wc;
  const dbg = wc?.debugger;
  if (!dbg || typeof dbg.sendCommand !== "function") return false;

  try {
    if (typeof dbg.isAttached === "function" && !dbg.isAttached()) {
      dbg.attach("1.3");
      entry.browserThemeDebuggerAttached = true;
      if (!entry.browserThemeDebuggerDetachListener && typeof dbg.on === "function") {
        entry.browserThemeDebuggerDetachListener = () => {
          entry.browserThemeDebuggerAttached = false;
        };
        dbg.on("detach", entry.browserThemeDebuggerDetachListener);
      }
    }

    Promise.resolve(
      dbg.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      }),
    ).catch((error) => {
      warnBrowserThemeOnce(api, entry, "failed to set browser theme media emulation", error);
    });
    return true;
  } catch (error) {
    warnBrowserThemeOnce(api, entry, "failed to attach browser theme media emulation", error);
    return false;
  }
}

function applyBrowserThemeFallback(api, entry, theme) {
  const wc = entry?.wc;
  if (!wc || wc.isDestroyed?.()) return false;

  try {
    const script = browserThemeFallbackScript(theme);
    wc.executeJavaScript(script, true).catch(() => {
      /* non-critical */
    });
  } catch {
    /* non-critical */
  }

  if (typeof wc.insertCSS !== "function") return true;

  try {
    const previousKey = entry.browserThemeCssKey;
    const token = {};
    entry.browserThemeCssToken = token;
    entry.browserThemeCssKey = null;

    if (previousKey && typeof wc.removeInsertedCSS === "function") {
      wc.removeInsertedCSS(previousKey).catch(() => {
        /* non-critical */
      });
    }

    const css = `:root,html,body{color-scheme:${theme}!important;}`;
    Promise.resolve(wc.insertCSS(css, { cssOrigin: "user" }))
      .then((key) => {
        if (entry.browserThemeCssToken === token) {
          entry.browserThemeCssKey = key;
        } else if (key && typeof wc.removeInsertedCSS === "function" && !wc.isDestroyed?.()) {
          wc.removeInsertedCSS(key).catch(() => {
            /* non-critical */
          });
        }
      })
      .catch(() => {
        /* non-critical */
      });
  } catch {
    /* non-critical */
  }

  return true;
}

function browserThemeFallbackScript(theme) {
  return `(() => {
    const theme = ${JSON.stringify(theme)};
    try {
      const root = document.documentElement;
      if (!root) return;
      root.style.colorScheme = theme;
      if (document.body) document.body.style.colorScheme = theme;

      let meta = document.querySelector('meta[name="color-scheme"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "color-scheme");
        document.head?.appendChild(meta);
      }
      meta.setAttribute("content", theme);

      const setThemeAttribute = (name) => {
        if (root.hasAttribute(name)) root.setAttribute(name, theme);
      };
      setThemeAttribute("data-color-mode");
      setThemeAttribute("data-theme");
      setThemeAttribute("data-bs-theme");
      setThemeAttribute("theme");

      if (root.classList.contains("dark") || root.classList.contains("light")) {
        root.classList.toggle("dark", theme === "dark");
        root.classList.toggle("light", theme === "light");
      }
    } catch {
    }
  })();`;
}

function clearBrowserThemeForEntry(entry) {
  const wc = entry?.wc;
  if (!wc || wc.isDestroyed?.()) return;

  entry.browserThemeCssToken = {};
  if (entry.browserThemeCssKey && typeof wc.removeInsertedCSS === "function") {
    wc.removeInsertedCSS(entry.browserThemeCssKey).catch(() => {
      /* non-critical */
    });
    entry.browserThemeCssKey = null;
  }

  const dbg = wc.debugger;
  if (dbg && entry.browserThemeDebuggerDetachListener && typeof dbg.off === "function") {
    try {
      dbg.off("detach", entry.browserThemeDebuggerDetachListener);
    } catch {
      /* non-critical */
    }
    entry.browserThemeDebuggerDetachListener = null;
  }

  if (dbg && entry.browserThemeDebuggerAttached && typeof dbg.isAttached === "function" && dbg.isAttached()) {
    try {
      Promise.resolve(dbg.sendCommand("Emulation.setEmulatedMedia", { features: [] })).finally(() => {
        try {
          if (!wc.isDestroyed?.() && dbg.isAttached?.()) dbg.detach();
        } catch {
          /* non-critical */
        }
      });
    } catch {
      try {
        dbg.detach();
      } catch {
        /* non-critical */
      }
    }
  }
  entry.browserThemeDebuggerAttached = false;
}

function warnBrowserThemeOnce(api, entry, message, error) {
  if (!entry || entry.browserThemeWarned) return;
  entry.browserThemeWarned = true;
  api.log.warn(message, stringifyError(error));
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = Number(rect.x ?? rect.left);
  const y = Number(rect.y ?? rect.top);
  const width = Number(rect.width ?? (Number(rect.right) - x));
  const height = Number(rect.height ?? (Number(rect.bottom) - y));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function rectToContentBounds(rect, contentBounds) {
  const isAlreadyContentRelative =
    rect.x >= -8 &&
    rect.y >= -8 &&
    rect.x + rect.width <= contentBounds.width + 8 &&
    rect.y + rect.height <= contentBounds.height + 8;

  if (isAlreadyContentRelative) {
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  const isScreenRelative =
    rect.x >= contentBounds.x - 8 &&
    rect.y >= contentBounds.y - 8 &&
    rect.x + rect.width <= contentBounds.x + contentBounds.width + 8 &&
    rect.y + rect.height <= contentBounds.y + contentBounds.height + 8;

  if (isScreenRelative) {
    return {
      x: rect.x - contentBounds.x,
      y: rect.y - contentBounds.y,
      width: rect.width,
      height: rect.height,
    };
  }

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function clampRectToBounds(rect, bounds) {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - width)),
    y: Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - height)),
    width,
    height,
  };
}

function restoreWebContents(entry) {
  const wc = entry.wc;
  if (!wc || wc.isDestroyed?.()) return;

  disposeInlineDevTools(entry, { closeDevTools: true });
  clearBrowserThemeForEntry(entry);

  wc.inspectElement = entry.originalInspectElement;
  wc.openDevTools = entry.originalOpenDevTools;
  wc.closeDevTools = entry.originalCloseDevTools;
  wc.send = entry.originalSend;

  for (const [eventName, listener] of entry.listeners) {
    wc.off(eventName, listener);
  }

  try {
    delete wc[PATCHED_WEB_CONTENTS];
  } catch {
    /* non-critical */
  }
}

function reloadExistingAppWindowsIfHotEnabled(api) {
  const { app, BrowserWindow } = require("electron");
  if (!app.isReady()) return;

  const token = getReloadToken();
  if (globalThis[RELOAD_TOKEN_KEY] === token) return;

  const windows = BrowserWindow.getAllWindows().filter((window) => {
    if (window.isDestroyed()) return false;
    const url = window.webContents.getURL();
    return url.startsWith("app://-/");
  });

  if (windows.length === 0) return;
  globalThis[RELOAD_TOKEN_KEY] = token;

  setTimeout(() => {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        logInfo(api, "reloading Codex window to apply Better Browser renderer patch");
        window.webContents.reloadIgnoringCache();
      }
    }
  }, 200);
}

function getReloadToken() {
  try {
    const fs = require("node:fs");
    const stat = fs.statSync(__filename);
    return `${__filename}:${stat.mtimeMs}`;
  } catch {
    return `${__filename}:unknown`;
  }
}

function rememberBrowserDirectCommentAlias(
  state,
  ownerWebContentsId,
  baseConversationId,
  browserConversationId,
  sessionId,
) {
  const key = browserDirectCommentAliasKey(ownerWebContentsId, baseConversationId, sessionId);
  if (!key) return;
  cleanupBrowserDirectCommentAliases(state);
  state.directCommentAliases.set(key, {
    browserConversationId,
    expiresAt: Date.now() + DIRECT_COMMENT_ALIAS_TTL_MS,
  });
}

function routeBrowserDirectCommentAlias(state, event, message) {
  if (!message || typeof message !== "object") return message;
  if (
    message.type !== "browser-sidebar-comment-overlay-close" &&
    message.type !== "browser-sidebar-comment-overlay-submit"
  ) {
    return message;
  }

  const key = browserDirectCommentAliasKey(event.sender.id, message.conversationId, message.sessionId);
  if (!key) return message;
  const alias = state.directCommentAliases.get(key);
  if (!alias) return message;
  if (alias.expiresAt <= Date.now()) {
    state.directCommentAliases.delete(key);
    return message;
  }

  state.directCommentAliases.delete(key);
  return {
    ...message,
    conversationId: alias.browserConversationId,
  };
}

function cleanupBrowserDirectCommentAliases(state) {
  const now = Date.now();
  for (const [key, alias] of state.directCommentAliases) {
    if (alias.expiresAt <= now) state.directCommentAliases.delete(key);
  }
}

function browserDirectCommentAliasKey(ownerWebContentsId, conversationId, sessionId) {
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;
  if (sessionId == null) return null;
  return `${ownerWebContentsId}:${conversationId}:${String(sessionId)}`;
}

function observeRendererMessage(state, event, message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "better-browser-devtools-dock") {
    setInlineDevToolsDockForOwnerWebContents(state, event.sender, message.dock, message);
    return;
  }

  if (message.type === "better-browser-devtools-toggle") {
    toggleInlineDevToolsForOwnerWebContents(state, event.sender, message);
    return;
  }

  if (message.type === "better-browser-devtools-state-request") {
    sendInlineDevToolsStateForOwnerWebContents(state, event.sender, message);
    return;
  }

  if (message.type === "better-browser-theme") {
    setBrowserThemeForOwnerWebContents(state, event.sender, message.theme, message);
    return;
  }

  if (message.type === "app-shell-shortcut-state-changed") {
    state.shortcutStateByWebContentsId.set(event.sender.id, {
      bottomPanelCanCloseActiveTab: !!message.bottomPanelCanCloseActiveTab,
      focusArea: message.focusArea ?? "main",
      rightPanelBrowserConversationId: message.rightPanelBrowserConversationId ?? null,
      rightPanelCanCloseActiveTab: !!message.rightPanelCanCloseActiveTab,
    });
    syncInlineDevToolsForOwnerWebContents(state, event.sender);
  }
}

function setInlineDevToolsDockForOwnerWebContents(state, ownerWebContents, dock, hints = null) {
  if (!INLINE_DEVTOOLS_DOCKS.has(dock)) return false;
  const entry =
    findOpenInlineDevToolsEntryForOwnerWebContents(state, ownerWebContents) ??
    findBrowserEntryForOwnerWebContents(state, ownerWebContents, hints);
  if (!entry) return false;

  entry.devToolsLayout.dock = dock;
  if (entry.inlineDevTools && !entry.inlineDevTools.disposed) {
    loadInlineDevToolsControlViews(entry);
    positionInlineDevToolsViews(entry);
  }
  sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents, hints);
  return true;
}

function findOpenInlineDevToolsEntryForOwnerWebContents(state, ownerWebContents) {
  if (!ownerWebContents || ownerWebContents.isDestroyed?.()) return null;

  for (const entry of state.webContentsEntries.values()) {
    if (!entry.inlineDevTools || entry.inlineDevTools.disposed) continue;
    const pageState = findBrowserPageForWebContentsId(entry.wc.id, ownerWebContents);
    if (!pageStateBelongsToOwner(pageState, ownerWebContents)) continue;
    if (isInlineDevToolsActiveForOwner(entry)) return entry;
  }

  for (const entry of state.webContentsEntries.values()) {
    if (!entry.inlineDevTools || entry.inlineDevTools.disposed) continue;
    const pageState = findBrowserPageForWebContentsId(entry.wc.id, ownerWebContents);
    if (pageStateBelongsToOwner(pageState, ownerWebContents)) return entry;
  }

  return null;
}

function toggleInlineDevToolsForOwnerWebContents(state, ownerWebContents, hints = null) {
  const entry = findBrowserEntryForOwnerWebContents(state, ownerWebContents, hints);
  if (!entry) {
    sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents);
    return false;
  }

  return toggleInlineDevToolsForEntry(state, entry, ownerWebContents);
}

function toggleInlineDevToolsForEntry(state, entry, ownerWebContents = null) {
  if (!entry?.wc || entry.wc.isDestroyed?.()) {
    if (ownerWebContents) sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents);
    return false;
  }

  const isOpen =
    entry.devToolsLayout.open === true &&
    entry.inlineDevTools &&
    !entry.inlineDevTools.disposed &&
    (ownerWebContents ? isInlineDevToolsActiveForOwner(entry) : true);
  if (isOpen) {
    entry.devToolsLayout.open = false;
    disposeInlineDevTools(entry, { closeDevTools: true });
  } else if (!openInlineDevTools(state.api, state, entry, { activate: true })) {
    openFallbackDevTools(state.api, entry, { activate: true });
  }

  const stateOwner = ownerWebContents ?? getBrowserOwnerWebContents(entry);
  if (stateOwner) sendInlineDevToolsStateForOwnerWebContents(state, stateOwner);
  return true;
}

function syncInlineDevToolsForOwnerWebContents(state, ownerWebContents) {
  for (const entry of state.webContentsEntries.values()) {
    if (!entry.inlineDevTools || entry.inlineDevTools.disposed) continue;
    const pageState = findBrowserPageForWebContentsId(entry.wc.id, ownerWebContents);
    if (!pageStateBelongsToOwner(pageState, ownerWebContents)) continue;
    positionInlineDevToolsViews(entry);
  }
  sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents);
}

function setBrowserThemeForOwnerWebContents(state, ownerWebContents, theme, hints = null) {
  if (!BROWSER_THEMES.has(theme)) {
    sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents);
    return false;
  }

  const entries = findBrowserThemeEntriesForOwnerWebContents(state, ownerWebContents, hints);
  for (const entry of entries) {
    entry.browserTheme = theme;
    applyBrowserThemeForEntry(state.api, entry);
  }
  if (ownerWebContents && !ownerWebContents.isDestroyed?.()) {
    state.browserThemeByOwnerWebContentsId.set(ownerWebContents.id, theme);
  }
  sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents, hints);
  return entries.length > 0;
}

function findBrowserThemeEntriesForOwnerWebContents(state, ownerWebContents, hints = null) {
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry?.wc || entry.wc.isDestroyed?.() || seen.has(entry.wc.id) || !isLikelyBrowserContent(entry.wc)) {
      return;
    }
    seen.add(entry.wc.id);
    entries.push(entry);
  };

  add(findBrowserEntryForOwnerWebContents(state, ownerWebContents, hints));

  for (const entry of state.webContentsEntries.values()) {
    const wc = entry.wc;
    if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) continue;
    const pageState = findBrowserPageForWebContentsId(wc.id, ownerWebContents);
    if (pageState) {
      if (pageStateBelongsToOwner(pageState, ownerWebContents)) add(entry);
      continue;
    }

    const ownerWindow = getBrowserOwnerWindow(wc);
    const ownerShellWindow = getOwnerWindowForWebContents(ownerWebContents);
    if (ownerWindow && ownerShellWindow && ownerWindow.id === ownerShellWindow.id) add(entry);
  }

  if (entries.length > 0) return entries;

  try {
    const { webContents } = require("electron");
    for (const wc of webContents.getAllWebContents()) {
      if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) continue;
      add(ensureWebContentsEntry(state, wc));
    }
  } catch {
    /* non-critical */
  }

  return entries;
}

function ensureWebContentsEntry(state, wc) {
  if (!wc || wc.isDestroyed?.()) return null;
  const existing = state.webContentsEntries.get(wc.id) ?? wc[PATCHED_WEB_CONTENTS] ?? null;
  if (existing) return existing;
  patchWebContents(state.api, state, wc);
  return state.webContentsEntries.get(wc.id) ?? wc[PATCHED_WEB_CONTENTS] ?? null;
}

function sendInlineDevToolsStateForOwnerWebContents(state, ownerWebContents, hints = null) {
  if (!ownerWebContents || ownerWebContents.isDestroyed?.()) return;
  const entry =
    findBrowserEntryForOwnerWebContents(state, ownerWebContents, hints) ??
    findActiveBrowserEntryForOwnerWebContents(state, ownerWebContents);
  const open =
    entry?.devToolsLayout?.open === true &&
    entry.inlineDevTools &&
    !entry.inlineDevTools.disposed &&
    isInlineDevToolsActiveForOwner(entry);
  ownerWebContents.send(MESSAGE_FOR_VIEW, {
    type: "better-browser-devtools-state",
    dock: entry ? getInlineDevToolsDock(entry) : INLINE_DEVTOOLS_DEFAULT_DOCK,
    open: !!open,
    theme:
      (ownerWebContents ? state.browserThemeByOwnerWebContentsId.get(ownerWebContents.id) : null) ??
      (entry ? getBrowserTheme(entry) : getDefaultBrowserTheme()),
  });
}

function findActiveBrowserEntryForOwnerWebContents(state, ownerWebContents) {
  const shortcutState = getShortcutState(state, ownerWebContents);
  const conversationId =
    typeof shortcutState?.rightPanelBrowserConversationId === "string"
      ? shortcutState.rightPanelBrowserConversationId
      : null;
  return (
    findBrowserEntryForConversationId(state, ownerWebContents, conversationId) ??
    findBrowserEntryForConversationId(
      state,
      ownerWebContents,
      getActiveBrowserConversationIdForOwner(ownerWebContents),
    ) ??
    findBrowserEntryForOwnerWebContents(state, ownerWebContents)
  );
}

function findBrowserEntryForOwnerWebContents(state, ownerWebContents, hints = null) {
  if (!ownerWebContents || ownerWebContents.isDestroyed?.()) return null;

  const hintedWebContentsId = Number(hints?.browserWebContentsId ?? hints?.webContentsId);
  if (Number.isInteger(hintedWebContentsId) && hintedWebContentsId > 0) {
    const hintedEntry = getOrCreateWebContentsEntryById(state, hintedWebContentsId);
    const hintedPageState = findBrowserPageForWebContentsId(hintedWebContentsId, ownerWebContents);
    if (browserEntryBelongsToOwner(hintedEntry, ownerWebContents, hintedPageState)) {
      return hintedEntry;
    }
  }

  const hintedConversationId =
    typeof hints?.browserConversationId === "string"
      ? hints.browserConversationId
      : typeof hints?.conversationId === "string"
        ? hints.conversationId
        : null;
  const hinted = findBrowserEntryForConversationId(state, ownerWebContents, hintedConversationId);
  if (hinted) return hinted;

  const shortcutState = getShortcutState(state, ownerWebContents);
  const conversationId =
    typeof shortcutState?.rightPanelBrowserConversationId === "string"
      ? shortcutState.rightPanelBrowserConversationId
      : null;
  const exact = findBrowserEntryForConversationId(state, ownerWebContents, conversationId);
  if (exact) return exact;

  const activeConversationId = getActiveBrowserConversationIdForOwner(ownerWebContents);
  const active = findBrowserEntryForConversationId(state, ownerWebContents, activeConversationId);
  if (active) return active;

  const candidates = [];
  for (const entry of state.webContentsEntries.values()) {
    const wc = entry.wc;
    if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) continue;

    const pageState = findBrowserPageForWebContentsId(wc.id, ownerWebContents);
    if (!pageStateBelongsToOwner(pageState, ownerWebContents)) continue;
    candidates.push(entry);
  }

  const hintedUrl = typeof hints?.browserUrl === "string" ? normalizeBrowserUrl(hints.browserUrl) : null;
  if (hintedUrl) {
    const urlMatch = candidates.find((entry) => normalizeBrowserUrl(entry.wc?.getURL?.() ?? "") === hintedUrl);
    if (urlMatch) return urlMatch;
  }

  return (
    candidates.find((entry) => entry.inlineDevTools && !entry.inlineDevTools.disposed) ??
    candidates.find((entry) => entry.wc?.isFocused?.()) ??
    candidates[0] ??
    null
  );
}

function getOrCreateWebContentsEntryById(state, webContentsId) {
  const existing = state.webContentsEntries.get(webContentsId);
  if (existing) return existing;

  try {
    const { webContents } = require("electron");
    const wc = webContents.fromId?.(webContentsId);
    return wc ? ensureWebContentsEntry(state, wc) : null;
  } catch {
    return null;
  }
}

function browserEntryBelongsToOwner(entry, ownerWebContents, pageState = null) {
  const wc = entry?.wc;
  if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) return false;
  if (pageState) return pageStateBelongsToOwner(pageState, ownerWebContents);

  const ownerWindow = getOwnerWindowForWebContents(ownerWebContents);
  const browserOwnerWindow = getBrowserOwnerWindow(wc);
  return !!ownerWindow && !!browserOwnerWindow && ownerWindow.id === browserOwnerWindow.id;
}

function normalizeBrowserUrl(url) {
  if (typeof url !== "string") return "";
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function findBrowserEntryForConversationId(state, ownerWebContents, conversationId) {
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;

  const manager = getBrowserSidebarManager(ownerWebContents);
  const methods = [
    "findPageStateForConversationId",
    "findPageForConversationId",
    "getPageStateForConversationId",
    "getPageForConversationId",
    "getPageState",
    "getThreadPageState",
  ];

  for (const method of methods) {
    if (typeof manager?.[method] !== "function") continue;
    let pageState = null;
    try {
      pageState = manager[method](conversationId);
    } catch {
      /* non-critical */
    }
    if (!pageState) {
      try {
        pageState = manager[method](ownerWebContents, conversationId);
      } catch {
        /* non-critical */
      }
    }

    const webContentsId = getPageStateWebContentsId(pageState);
    if (webContentsId != null) {
      const entry = state.webContentsEntries.get(webContentsId);
      if (entry && pageStateBelongsToOwner(pageState, ownerWebContents)) return entry;
    }
  }

  const windowPageState = getBrowserPageStateFromOwnerWindowState(ownerWebContents, conversationId);
  const windowWebContentsId = getPageStateWebContentsId(windowPageState);
  if (windowWebContentsId != null) {
    const entry = state.webContentsEntries.get(windowWebContentsId);
    if (entry && pageStateBelongsToOwner(windowPageState, ownerWebContents)) return entry;
  }

  for (const entry of state.webContentsEntries.values()) {
    const wc = entry.wc;
    if (!wc || wc.isDestroyed?.() || !isLikelyBrowserContent(wc)) continue;
    const pageState = findBrowserPageForWebContentsId(wc.id, ownerWebContents);
    if (!pageStateBelongsToOwner(pageState, ownerWebContents)) continue;
    if (getPageStateConversationId(pageState) === conversationId) return entry;
  }

  return null;
}

function getActiveBrowserConversationIdForOwner(ownerWebContents) {
  const manager = getBrowserSidebarManager(ownerWebContents);
  const windowState = getBrowserWindowStateForOwner(manager, ownerWebContents);
  return typeof windowState?.activeConversationId === "string" ? windowState.activeConversationId : null;
}

function getBrowserPageStateFromOwnerWindowState(ownerWebContents, conversationId) {
  const manager = getBrowserSidebarManager(ownerWebContents);
  const windowState = getBrowserWindowStateForOwner(manager, ownerWebContents);
  const threadState =
    typeof windowState?.threads?.get === "function" ? windowState.threads.get(conversationId) : null;
  const page = threadState?.page ?? null;
  return page ? { conversationId, page, threadState, windowState } : null;
}

function getBrowserWindowStateForOwner(manager, ownerWebContents) {
  if (!manager || !ownerWebContents || ownerWebContents.isDestroyed?.()) return null;
  const methods = ["getCurrentWindowState", "ensureCurrentWindowState"];
  for (const method of methods) {
    if (typeof manager?.[method] !== "function") continue;
    try {
      const windowState = manager[method](ownerWebContents);
      if (windowState) return windowState;
    } catch {
      /* non-critical */
    }
  }
  return null;
}

function getPageStateWebContentsId(pageState) {
  const candidates = [
    pageState?.webContentsId,
    pageState?.browserWebContentsId,
    pageState?.webContents?.id,
    pageState?.view?.webContents?.id,
    pageState?.view?.webContentsId,
    pageState?.page?.webContentsId,
    pageState?.page?.webContents?.id,
    pageState?.page?.view?.webContents?.id,
    pageState?.page?.view?.webContentsId,
    pageState?.threadState?.webContentsId,
    pageState?.windowState?.webContentsId,
    pageState?.windowState?.webContents?.id,
  ];

  for (const candidate of candidates) {
    const id = Number(candidate);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function getPageStateConversationId(pageState) {
  const candidates = [
    pageState?.conversationId,
    pageState?.browserConversationId,
    pageState?.page?.conversationId,
    pageState?.threadState?.conversationId,
    pageState?.thread?.conversationId,
    pageState?.windowState?.conversationId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function getBaseConversationIdForBrowserTab(conversationId) {
  if (typeof conversationId !== "string") return null;
  const marker = ":browser:";
  const markerIndex = conversationId.indexOf(marker);
  if (markerIndex <= 0) return null;
  return conversationId.slice(0, markerIndex);
}

function pageStateBelongsToOwner(pageState, ownerWebContents) {
  if (!pageState) return false;
  const owner =
    pageState?.windowState?.owner ??
    pageState?.ownerWebContents ??
    pageState?.owner ??
    null;
  return !owner || owner.id === ownerWebContents.id;
}

function goBrowserHistory(state, ownerWebContents, direction) {
  const shortcutState = getShortcutState(state, ownerWebContents);
  const conversationId = shortcutState?.rightPanelBrowserConversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) return false;

  const manager = getBrowserSidebarManager(ownerWebContents);
  if (!manager) return false;

  if (direction === "back" && typeof manager.goBack === "function") {
    manager.goBack(ownerWebContents, conversationId);
    return true;
  }

  if (direction === "forward" && typeof manager.goForward === "function") {
    manager.goForward(ownerWebContents, conversationId);
    return true;
  }

  return false;
}

function goBrowserHistoryForFocusedRightPanel(state, ownerWebContents, direction) {
  const shortcutState = getShortcutState(state, ownerWebContents);
  if (shortcutState?.focusArea !== "right-panel") return false;
  return goBrowserHistory(state, ownerWebContents, direction);
}

function switchRightPanelBrowserTabByOrdinal(browserWebContents, ordinal) {
  const pageState = findBrowserPageForWebContentsId(browserWebContents.id);
  const owner = pageState?.windowState?.owner;
  if (!owner || owner.isDestroyed?.()) return false;

  sendActivateRightPanelTab(owner, ordinal);
  return true;
}

function switchFocusedRightPanelTabByOrdinal(state, ownerWebContents, ordinal) {
  const shortcutState = getShortcutState(state, ownerWebContents);
  if (shortcutState?.focusArea !== "right-panel") return false;

  sendActivateRightPanelTab(ownerWebContents, ordinal);
  return true;
}

function sendActivateRightPanelTab(ownerWebContents, ordinal) {
  ownerWebContents.send(MESSAGE_FOR_VIEW, {
    type: "better-browser-activate-right-tab",
    index: ordinal,
  });
}

function getShortcutState(state, ownerWebContents) {
  const services = getServices();
  return (
    services?.windowManager?.getAppShellShortcutState?.(ownerWebContents.id) ??
    state.shortcutStateByWebContentsId.get(ownerWebContents.id) ??
    null
  );
}

function getBrowserSidebarManager(ownerWebContents) {
  const services = getServices();
  const context =
    ownerWebContents && typeof services?.getContextForWebContents === "function"
      ? services.getContextForWebContents(ownerWebContents)
      : null;

  return (
    context?.getBrowserSidebarManager?.() ??
    context?.browserSidebarManager ??
    services?.browserSidebarManager ??
    services?.windowManager?.browserSidebarManager ??
    services?.getContext?.("local")?.getBrowserSidebarManager?.() ??
    services?.getContext?.("local")?.browserSidebarManager ??
    null
  );
}

function getBrowserSidebarManagers(ownerWebContents = null) {
  const services = getServices();
  const managers = [];
  const seen = new Set();
  const add = (manager) => {
    if (!manager || typeof manager !== "object" || seen.has(manager)) return;
    seen.add(manager);
    managers.push(manager);
  };

  add(getBrowserSidebarManager(ownerWebContents));
  add(services?.browserSidebarManager);
  add(services?.windowManager?.browserSidebarManager);
  add(services?.getContext?.("local")?.getBrowserSidebarManager?.());
  add(services?.getContext?.("local")?.browserSidebarManager);

  const contexts = services?.contextsByHostId;
  if (contexts && typeof contexts.values === "function") {
    for (const context of contexts.values()) {
      add(context?.getBrowserSidebarManager?.());
      add(context?.browserSidebarManager);
    }
  }

  return managers;
}

function findBrowserPageForWebContentsId(webContentsId, ownerWebContents = null) {
  for (const manager of getBrowserSidebarManagers(ownerWebContents)) {
    if (typeof manager.findPageStateForWebContentsId !== "function") continue;
    try {
      const pageState = manager.findPageStateForWebContentsId(webContentsId);
      if (pageState) return pageState;
    } catch {
      /* non-critical */
    }
  }
  return null;
}

function getServices() {
  const services = globalThis[SERVICES_KEY];
  return services && typeof services === "object" ? services : null;
}

function isLikelyBrowserContent(wc) {
  if (findBrowserPageForWebContentsId(wc.id) != null) return true;

  const url = wc.getURL?.() ?? "";
  if (!url) return false;
  if (url.startsWith("app://") || url.startsWith("devtools://")) return false;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
  return /^(https?|file|about):/i.test(url);
}

function isDevToolsShortcut(input) {
  if (input?.type !== "keyDown") return false;
  const keyIsI = input.code === "KeyI" || String(input.key ?? "").toLowerCase() === "i";
  const keyIsF12 = input.code === "F12" || input.key === "F12";
  if (keyIsF12 && !input.control && !input.meta && !input.alt && !input.shift) return true;
  if (!keyIsI) return false;

  if (process.platform === "darwin") {
    return input.meta === true && input.alt === true && !input.control && !input.shift;
  }

  return input.control === true && input.shift === true && !input.meta && !input.alt;
}

function isAppShellContent(wc) {
  const url = wc.getURL?.() ?? "";
  return url.startsWith("app://-/index.html");
}

function isInjectablePageUrl(url) {
  if (!url) return false;
  if (url.startsWith("app://") || url.startsWith("devtools://")) return false;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
  return /^(https?|file|about):/i.test(url);
}

function isBrowserHistoryShortcut(input) {
  if (input?.type !== "keyDown") return false;
  if (input.alt || input.shift) return false;

  const isMac = process.platform === "darwin";
  const modifierOk = isMac
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;

  return modifierOk && (isBackInput(input) || isForwardInput(input));
}

function getRightPanelTabShortcutOrdinal(input) {
  if (input?.type !== "keyDown") return null;
  const hasTabModifier = input.control === true || input.meta === true;
  if (
    !hasTabModifier ||
    (input.control === true && input.meta === true) ||
    input.alt === true ||
    input.shift === true
  ) {
    return null;
  }

  const codeMatch = /^Digit([1-9])$/.exec(input.code ?? "");
  const keyMatch = /^[1-9]$/.exec(input.key ?? "");
  const ordinal = Number(codeMatch?.[1] ?? keyMatch?.[0] ?? NaN);
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= 9 ? ordinal : null;
}

function isBackInput(input) {
  return (
    input.key === "[" ||
    input.code === "BracketLeft" ||
    input.key === "ArrowLeft" ||
    input.key === "Left" ||
    input.code === "ArrowLeft"
  );
}

function isForwardInput(input) {
  return (
    input.key === "]" ||
    input.code === "BracketRight" ||
    input.key === "ArrowRight" ||
    input.key === "Right" ||
    input.code === "ArrowRight"
  );
}

function browserGestureInjectionScript(wc) {
  const canBack = !!wc.canGoBack?.();
  const canForward = !!wc.canGoForward?.();
  return `window.__codexppBetterBrowserGestureState={canBack:${JSON.stringify(canBack)},canForward:${JSON.stringify(canForward)}};\n${BROWSER_SWIPE_SCRIPT}`;
}

const BROWSER_SWIPE_SCRIPT = `(() => {
  const flag = "__codexppBetterBrowserGesturesV2";
  if (window[flag]?.version === 3) return;
  Object.defineProperty(window, flag, { configurable: true, value: { version: 3 } });

  const threshold = 125;
  const minDelta = 18;
  const cooldownMs = 620;
  let accumulatedX = 0;
  let lastNavigationAt = 0;
  let resetTimer = 0;
  let hideTimer = 0;
  let ui = null;

  const historyGuardKey = "__codexppBetterBrowserGestureHistoryGuard";
  const historyGuard = window[historyGuardKey] || {
    back: null,
    forward: null,
    installed: false,
    suppressBackUntil: 0,
    suppressForwardUntil: 0,
  };

  if (!window[historyGuardKey]) {
    try {
      Object.defineProperty(window, historyGuardKey, {
        configurable: true,
        value: historyGuard,
      });
    } catch {
      window[historyGuardKey] = historyGuard;
    }
  }

  if (!historyGuard.installed) {
    try {
      historyGuard.back = window.history.back.bind(window.history);
      historyGuard.forward = window.history.forward.bind(window.history);
      window.history.back = (...args) => {
        if (Date.now() < historyGuard.suppressBackUntil) return undefined;
        return historyGuard.back(...args);
      };
      window.history.forward = (...args) => {
        if (Date.now() < historyGuard.suppressForwardUntil) return undefined;
        return historyGuard.forward(...args);
      };
      historyGuard.installed = true;
    } catch {
    }
  }

  const applyStyle = (element, styles) => {
    for (const [key, value] of Object.entries(styles)) element.style[key] = value;
  };

  const getGestureState = () => {
    const state = window.__codexppBetterBrowserGestureState;
    return {
      canBack: state?.canBack === true,
      canForward: state?.canForward === true,
    };
  };

  const canNavigate = (direction) => {
    const state = getGestureState();
    return direction === "back" ? state.canBack : state.canForward;
  };

  const suppressLegacyNavigation = (direction) => {
    const until = Date.now() + cooldownMs + 180;
    if (direction === "back") historyGuard.suppressBackUntil = until;
    else historyGuard.suppressForwardUntil = until;
  };

  const navigate = (direction) => {
    suppressLegacyNavigation(direction);
    try {
      if (direction === "back") {
        if (typeof historyGuard.back === "function") historyGuard.back();
        else window.history.back();
      } else if (typeof historyGuard.forward === "function") {
        historyGuard.forward();
      } else {
        window.history.forward();
      }
    } catch {
    }
  };

  const ensureUi = () => {
    if (ui != null) return ui;
    const root = document.documentElement || document.body;
    if (!root) return null;

    const host = document.createElement("div");
    host.setAttribute("data-codexpp-better-browser-gesture-ui", "");
    applyStyle(host, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    });

    const rail = document.createElement("div");
    applyStyle(rail, {
      position: "fixed",
      top: "calc(50% - 54px)",
      width: "4px",
      height: "108px",
      borderRadius: "999px",
      background: "rgba(16, 163, 127, 0)",
      boxShadow: "0 0 28px rgba(16, 163, 127, 0)",
      opacity: "0",
      transition: "opacity 120ms ease, background 120ms ease, box-shadow 120ms ease",
    });

    const pill = document.createElement("div");
    applyStyle(pill, {
      position: "fixed",
      top: "50%",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      minWidth: "148px",
      height: "54px",
      boxSizing: "border-box",
      padding: "0 16px 0 12px",
      border: "1px solid rgba(255, 255, 255, 0.16)",
      borderRadius: "16px",
      background: "linear-gradient(180deg, rgba(25, 28, 32, 0.94), rgba(15, 17, 20, 0.9))",
      boxShadow: "0 14px 38px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
      color: "white",
      opacity: "0",
      transform: "translate3d(0, -50%, 0) scale(0.96)",
      transition: "opacity 120ms ease, transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease",
      backdropFilter: "blur(18px) saturate(1.2)",
      WebkitBackdropFilter: "blur(18px) saturate(1.2)",
    });

    const arrow = document.createElement("div");
    applyStyle(arrow, {
      display: "grid",
      placeItems: "center",
      width: "30px",
      height: "30px",
      borderRadius: "10px",
      background: "rgba(255, 255, 255, 0.13)",
      color: "white",
      fontSize: "20px",
      lineHeight: "1",
      fontWeight: "700",
      boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.12)",
    });

    const content = document.createElement("div");
    applyStyle(content, {
      display: "grid",
      gap: "6px",
      minWidth: "82px",
    });

    const label = document.createElement("div");
    applyStyle(label, {
      fontSize: "12px",
      fontWeight: "700",
      lineHeight: "1",
      letterSpacing: "0",
      textTransform: "uppercase",
    });

    const hint = document.createElement("div");
    applyStyle(hint, {
      color: "rgba(255, 255, 255, 0.62)",
      fontSize: "11px",
      fontWeight: "500",
      lineHeight: "1",
      letterSpacing: "0",
    });

    const track = document.createElement("div");
    applyStyle(track, {
      width: "82px",
      height: "4px",
      overflow: "hidden",
      borderRadius: "999px",
      background: "rgba(255, 255, 255, 0.16)",
    });

    const bar = document.createElement("div");
    applyStyle(bar, {
      width: "100%",
      height: "100%",
      borderRadius: "inherit",
      background: "rgb(16, 163, 127)",
      transform: "scaleX(0)",
      transformOrigin: "left center",
      transition: "transform 80ms linear",
    });

    track.appendChild(bar);
    content.append(label, hint, track);
    pill.append(arrow, content);
    host.append(rail, pill);
    root.appendChild(host);
    ui = { arrow, bar, hint, host, label, pill, rail };
    return ui;
  };

  const hideGesture = () => {
    if (ui == null) return;
    ui.pill.style.opacity = "0";
    ui.pill.style.transform = "translate3d(0, -50%, 0) scale(0.96)";
    ui.rail.style.opacity = "0";
  };

  const showGesture = (direction, progress, triggered) => {
    const indicator = ensureUi();
    if (indicator == null) return;
    const clamped = Math.max(0, Math.min(1, progress));
    const isBack = direction === "back";
    const offset = isBack ? -10 + clamped * 10 : 10 - clamped * 10;
    const opacity = Math.min(0.98, 0.26 + clamped * 0.72);
    indicator.pill.style.left = isBack ? "16px" : "";
    indicator.pill.style.right = isBack ? "" : "16px";
    indicator.pill.style.borderColor = triggered ? "rgba(16, 163, 127, 0.72)" : "rgba(255, 255, 255, 0.16)";
    indicator.pill.style.boxShadow = triggered
      ? "0 16px 44px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(16, 163, 127, 0.24), 0 0 34px rgba(16, 163, 127, 0.26)"
      : "0 14px 38px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)";
    indicator.pill.style.opacity = String(opacity);
    indicator.pill.style.transform = "translate3d(" + offset + "px, -50%, 0) scale(" + (0.96 + clamped * 0.04) + ")";
    indicator.rail.style.left = isBack ? "0" : "";
    indicator.rail.style.right = isBack ? "" : "0";
    indicator.rail.style.opacity = String(Math.min(0.9, 0.15 + clamped * 0.75));
    indicator.rail.style.background = "rgba(16, 163, 127, " + (0.2 + clamped * 0.55) + ")";
    indicator.rail.style.boxShadow = "0 0 " + (12 + clamped * 22) + "px rgba(16, 163, 127, " + (0.18 + clamped * 0.34) + ")";
    indicator.arrow.textContent = isBack ? "<" : ">";
    indicator.label.textContent = isBack ? "Back" : "Forward";
    indicator.hint.textContent = triggered ? "Navigating" : Math.round(clamped * 100) + "%";
    indicator.bar.style.transformOrigin = isBack ? "right center" : "left center";
    indicator.bar.style.transform = "scaleX(" + clamped + ")";

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hideGesture, triggered ? 380 : 220);
  };

  window.addEventListener("wheel", (event) => {
    if (event.defaultPrevented) return;
    if (Math.abs(event.deltaX) < minDelta) return;
    if (Math.abs(event.deltaX) < Math.abs(event.deltaY) * 1.35) return;

    accumulatedX += event.deltaX;
    const direction = accumulatedX < 0 ? "back" : "forward";
    if (!canNavigate(direction)) {
      suppressLegacyNavigation(direction);
      accumulatedX = 0;
      hideGesture();
      return;
    }

    const progress = Math.abs(accumulatedX) / threshold;
    showGesture(direction, progress, false);

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      accumulatedX = 0;
      hideGesture();
    }, 220);

    const now = Date.now();
    if (now - lastNavigationAt < cooldownMs || Math.abs(accumulatedX) < threshold) return;

    accumulatedX = 0;
    lastNavigationAt = now;
    showGesture(direction, 1, true);
    navigate(direction);
  }, { capture: true, passive: true });
})();`;

const APP_SHELL_RIGHT_TAB_SHORTCUT_SCRIPT = `(() => {
  const flag = "__codexppBetterBrowserRightTabShortcuts";
  const existing = window[flag];
  if (existing && existing.version === 5) return;
  try {
    delete window[flag];
  } catch {
  }
  Object.defineProperty(window, flag, { configurable: true, value: { version: 5 } });

  let rightPanelHadRecentFocus = false;

  const getRightTabs = () =>
    Array.from(document.querySelectorAll('[data-app-shell-tab-controller="right"][data-tab-id]'))
      .filter((element) => element instanceof HTMLElement);

  const getReactProps = (element) => {
    const key = Object.keys(element).find((key) => key.startsWith("__reactProps"));
    return key == null ? null : element[key];
  };

  const callReactMouseDown = (element) => {
    const props = getReactProps(element);
    if (typeof props?.onMouseDown !== "function") return false;
    props.onMouseDown({
      button: 0,
      buttons: 1,
      currentTarget: element,
      target: element,
      nativeEvent: {},
      preventDefault() {},
      stopPropagation() {},
    });
    return true;
  };

  const activateTabElement = (tab) => {
    const tabButton = tab.querySelector('button[role="tab"]');
    if (tabButton instanceof HTMLElement && callReactMouseDown(tabButton)) return true;

    const activator = tab.querySelector('[role="button"][tabindex]') ?? tab;
    if (activator instanceof HTMLElement) {
      const props = getReactProps(activator);
      if (typeof props?.onPointerDown === "function") {
        const rect = activator.getBoundingClientRect();
        props.onPointerDown({
          button: 0,
          buttons: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          currentTarget: activator,
          target: activator,
          nativeEvent: {},
          preventDefault() {},
          stopPropagation() {},
        });
        return true;
      }
      activator.click();
      return true;
    }

    return false;
  };

  const activateOrdinal = (ordinal) => {
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 9) return false;
    const tabs = getRightTabs();
    if (tabs.length === 0) return false;
    const tab = tabs[ordinal - 1];
    if (!(tab instanceof HTMLElement)) return false;
    return activateTabElement(tab);
  };

  const rightPanelHasDomFocus = (target) => {
    if (target instanceof Element && target.closest('[data-app-shell-focus-area="right-panel"], [data-app-shell-tab-controller="right"]')) {
      rightPanelHadRecentFocus = true;
      return true;
    }
    if (document.querySelector('[data-app-shell-focus-area="right-panel"]:focus-within') != null) {
      rightPanelHadRecentFocus = true;
      return true;
    }
    return rightPanelHadRecentFocus && document.hasFocus();
  };

  const shortcutOrdinal = (event) => {
    const hasTabModifier = event.ctrlKey || event.metaKey;
    if (!hasTabModifier || (event.ctrlKey && event.metaKey) || event.altKey || event.shiftKey) return null;
    if (/^Digit[1-9]$/.test(event.code)) return Number(event.code.slice(5));
    if (/^[1-9]$/.test(event.key)) return Number(event.key);
    return null;
  };

  const rememberRightPanelFocus = (event) => {
    rightPanelHadRecentFocus = event.target instanceof Element && event.target.closest('[data-app-shell-focus-area="right-panel"], [data-app-shell-tab-controller="right"]') != null;
  };

  window.addEventListener("focusin", rememberRightPanelFocus, true);
  window.addEventListener("pointerdown", rememberRightPanelFocus, true);

  window.addEventListener("keydown", (event) => {
    const ordinal = shortcutOrdinal(event);
    if (ordinal == null || !rightPanelHasDomFocus(event.target)) return;
    if (activateOrdinal(ordinal)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "better-browser-activate-right-tab") return;
    const ordinal = Number(message.index);
    if (activateOrdinal(ordinal)) {
      event.stopImmediatePropagation?.();
    }
  });
})();`;

const APP_SHELL_DEVTOOLS_DOCK_MENU_SCRIPT = `(() => {
  const flag = "__codexppBetterBrowserDevToolsDockMenu";
  const existing = window[flag];
  if (existing && existing.version === 11) return;
  if (existing && typeof existing.disconnect === "function") {
    try {
      existing.disconnect();
    } catch {
    }
  }

  const marker = "data-codexpp-better-browser-devtools-dock-menu";
  const toggleMarker = "data-codexpp-better-browser-devtools-toggle";
  const toggleSlotMarker = "data-codexpp-better-browser-devtools-toggle-slot";
  const itemSelector = '[role="menuitem"], [data-radix-collection-item], [cmdk-item], button';
  const dockOptions = [
    ["left", "Dock left"],
    ["bottom", "Dock bottom"],
    ["right", "Dock right"],
  ];
  const themeOptions = [
    ["dark", "Dark"],
    ["light", "Light"],
  ];

  const state = {
    version: 11,
    dock: "bottom",
    open: false,
    theme: window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light",
    disconnect() {},
  };

  try {
    Object.defineProperty(window, flag, { configurable: true, value: state });
  } catch {
    window[flag] = state;
  }

  const textOf = (element) => [
    element.getAttribute?.("aria-label") || "",
    element.getAttribute?.("title") || "",
    element.textContent || "",
  ].join(" ").replace(/\\s+/g, " ").trim();

  const controlLabelOf = (element) =>
    [element.getAttribute?.("aria-label") || "", element.getAttribute?.("title") || ""]
      .join(" ")
      .replace(/\\s+/g, " ")
      .trim();

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const isBrowserToolsText = (text) =>
    /hard reload/i.test(text) ||
    /show device toolbar/i.test(text) ||
    /clear cookies/i.test(text) ||
    /clear cache/i.test(text) ||
    /^zoom\\b/i.test(text);

  const rootFor = (item) => {
    const menu = item.closest('[role="menu"], [data-radix-menu-content]');
    if (menu) return menu;
    const wrapper = item.closest('[data-radix-popper-content-wrapper]');
    return wrapper?.querySelector?.('[role="menu"], [data-radix-menu-content]') ?? null;
  };

  const sendMessage = (type, payload = {}) => {
    try {
      const bridge = window.electronBridge;
      if (typeof bridge?.sendMessageFromView !== "function") return;
      Promise.resolve(
        bridge.sendMessageFromView({
          ...payload,
          type,
        }),
      ).catch(() => {});
    } catch {
    }
  };

  const collectWebviews = () => {
    const webviews = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      try {
        for (const webview of root.querySelectorAll?.("webview") ?? []) {
          if (!seen.has(webview)) {
            seen.add(webview);
            webviews.push(webview);
          }
        }
        for (const element of root.querySelectorAll?.("*") ?? []) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      } catch {
      }
    };
    visit(document);
    return webviews;
  };

  const browserHint = () => {
    const webviews = collectWebviews();
    const visible = webviews.find((webview) => {
      if (!(webview instanceof HTMLElement)) return false;
      const rect = webview.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || rect.x < -1000 || rect.y < -1000) return false;
      const style = window.getComputedStyle(webview);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const webview = visible || (webviews.length === 1 ? webviews[0] : null);
    let browserWebContentsId = null;
    try {
      if (typeof webview?.getWebContentsId === "function") browserWebContentsId = webview.getWebContentsId();
    } catch {
    }
    return {
      browserConversationId: webview?.getAttribute?.("data-browser-sidebar-conversation-id") || null,
      browserWebContentsId,
      browserUrl: webview?.getAttribute?.("src") || null,
    };
  };

  const sendDock = (dock) => sendMessage("better-browser-devtools-dock", { ...browserHint(), dock });
  const sendTheme = (theme) => sendMessage("better-browser-theme", { ...browserHint(), theme });
  const toggleDevTools = () => sendMessage("better-browser-devtools-toggle", browserHint());
  const requestState = () => sendMessage("better-browser-devtools-state-request", browserHint());
  const chooseDock = (dock) => {
    sendDock(dock);
    state.dock = dock;
    updateDockRows();
    closeMenu();
  };
  const chooseTheme = (theme) => {
    sendTheme(theme);
    state.theme = theme;
    updateThemeRows();
    closeMenu();
  };

  const closeMenu = () => {
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Escape",
          key: "Escape",
        }),
      );
    } catch {
    }
  };

  const dockIcon = (dock) => {
    if (dock === "left") {
      return '<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><rect x="3" y="3" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4.8" y="4.8" width="4.8" height="10.4" rx="1" fill="currentColor"/></svg>';
    }
    if (dock === "right") {
      return '<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><rect x="3" y="3" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="10.4" y="4.8" width="4.8" height="10.4" rx="1" fill="currentColor"/></svg>';
    }
    return '<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><rect x="3" y="3" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4.8" y="10.4" width="10.4" height="4.8" rx="1" fill="currentColor"/></svg>';
  };

  const inspectIcon = () =>
    '<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><path d="M4.5 4.5h11v11h-11z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 8l5.5 2-2.25 1.05L10.2 13.4 8 8z" fill="currentColor"/></svg>';

  const themeIcon = (theme) =>
    theme === "dark"
      ? '<svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14"><path d="M14.7 12.9A6.7 6.7 0 0 1 7.1 5.3a6 6 0 1 0 7.6 7.6z" fill="currentColor"/></svg>'
      : '<svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="10" r="3.2" fill="currentColor"/><path d="M10 2.7v2M10 15.3v2M3.8 3.8l1.4 1.4M14.8 14.8l1.4 1.4M2.7 10h2M15.3 10h2M3.8 16.2l1.4-1.4M14.8 5.2l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const makeSeparator = () => {
    const separator = document.createElement("div");
    separator.setAttribute(marker, "separator");
    separator.setAttribute("role", "separator");
    separator.style.cssText =
      "height:1px;margin:4px 8px;background:var(--color-token-border-default,rgba(255,255,255,.12));opacity:.9;";
    return separator;
  };

  const makeDockButton = (dock, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.codexppBetterBrowserDevtoolsDock = dock;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = dockIcon(dock);
    button.style.cssText =
      "display:grid;place-items:center;width:26px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--color-token-text-secondary,currentColor);cursor:pointer;";
    const refresh = () => {
      const active = state.dock === dock;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.style.background = active
        ? "color-mix(in srgb, var(--color-token-text-link-foreground,currentColor) 16%, transparent)"
        : "transparent";
      button.style.color = active
        ? "var(--color-token-text-link-foreground,currentColor)"
        : "var(--color-token-text-secondary,currentColor)";
    };
    button.addEventListener("mouseenter", refresh);
    button.addEventListener("mouseleave", refresh);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chooseDock(dock);
    });
    refresh();
    return button;
  };

  const makeDockRow = (base) => {
    const row = base.cloneNode(false);
    row.removeAttribute("id");
    row.removeAttribute("disabled");
    row.removeAttribute("aria-disabled");
    row.setAttribute(marker, "row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "-1");
    row.style.cssText += ";" + [
      "display:flex",
      "flex-direction:row",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "width:100%",
      "box-sizing:border-box",
      "cursor:default",
      "user-select:none",
      "background:transparent",
    ].join(";");

    const label = document.createElement("span");
    label.textContent = "Dock DevTools";
    label.style.cssText = "display:block;min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    const controls = document.createElement("span");
    controls.style.cssText = "display:inline-flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:2px;margin-left:auto;white-space:nowrap;";
    for (const [dock, buttonLabel] of dockOptions) {
      controls.appendChild(makeDockButton(dock, buttonLabel));
    }

    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("mouseenter", () => {
      row.style.background = "transparent";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    row.append(label, controls);
    return row;
  };

  const makeThemeButton = (theme, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.codexppBetterBrowserTheme = theme;
    button.setAttribute("aria-label", label + " theme");
    button.title = label + " theme";
    button.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px">' + themeIcon(theme) + '<span>' + label + '</span></span>';
    button.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:52px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--color-token-text-secondary,currentColor);font:inherit;font-size:12px;line-height:1;cursor:pointer;";
    const refresh = () => {
      const active = state.theme === theme;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.style.background = active
        ? "color-mix(in srgb, var(--color-token-text-link-foreground,currentColor) 16%, transparent)"
        : "transparent";
      button.style.color = active
        ? "var(--color-token-text-link-foreground,currentColor)"
        : "var(--color-token-text-secondary,currentColor)";
    };
    button.addEventListener("mouseenter", refresh);
    button.addEventListener("mouseleave", refresh);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chooseTheme(theme);
    });
    refresh();
    return button;
  };

  const makeThemeRow = (base) => {
    const row = base.cloneNode(false);
    row.removeAttribute("id");
    row.removeAttribute("disabled");
    row.removeAttribute("aria-disabled");
    row.setAttribute(marker, "theme-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "-1");
    row.style.cssText += ";" + [
      "display:flex",
      "flex-direction:row",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "width:100%",
      "box-sizing:border-box",
      "cursor:default",
      "user-select:none",
      "background:transparent",
    ].join(";");

    const label = document.createElement("span");
    label.textContent = "Theme";
    label.style.cssText = "display:block;min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    const controls = document.createElement("span");
    controls.style.cssText = "display:inline-flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:2px;margin-left:auto;white-space:nowrap;";
    for (const [theme, buttonLabel] of themeOptions) {
      controls.appendChild(makeThemeButton(theme, buttonLabel));
    }

    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("mouseenter", () => {
      row.style.background = "transparent";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    row.append(label, controls);
    return row;
  };

  const installIntoMenu = (items) => {
    const target =
      items.find((item) => /show device toolbar/i.test(textOf(item))) ||
      items.find((item) => /hard reload/i.test(textOf(item))) ||
      items.find((item) => /^zoom\\b/i.test(textOf(item))) ||
      items[0];
    if (!(target instanceof HTMLElement) || !target.parentElement) return false;

    const menuRoot = rootFor(target) || target.parentElement;
    if (menuRoot.querySelector("[" + marker + "]")) return false;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(makeSeparator());
    fragment.appendChild(makeThemeRow(target));
    fragment.appendChild(makeDockRow(target));
    target.after(fragment);
    updateDockRows();
    updateThemeRows();
    return true;
  };

  const updateDockRows = () => {
    for (const button of document.querySelectorAll("button[data-codexpp-better-browser-devtools-dock]")) {
      const active = button.dataset.codexppBetterBrowserDevtoolsDock === state.dock;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.style.background = active
        ? "color-mix(in srgb, var(--color-token-text-link-foreground,currentColor) 16%, transparent)"
        : "transparent";
      button.style.color = active
        ? "var(--color-token-text-link-foreground,currentColor)"
        : "var(--color-token-text-secondary,currentColor)";
    }
  };

  const updateThemeRows = () => {
    for (const button of document.querySelectorAll("button[data-codexpp-better-browser-theme]")) {
      const active = button.dataset.codexppBetterBrowserTheme === state.theme;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.style.background = active
        ? "color-mix(in srgb, var(--color-token-text-link-foreground,currentColor) 16%, transparent)"
        : "transparent";
      button.style.color = active
        ? "var(--color-token-text-link-foreground,currentColor)"
        : "var(--color-token-text-secondary,currentColor)";
    }
  };

  const updateToggleButtons = () => {
    for (const button of document.querySelectorAll("[" + toggleMarker + "]")) {
      button.setAttribute("aria-pressed", state.open ? "true" : "false");
      button.dataset.active = state.open ? "true" : "false";
      button.style.background = state.open
        ? "color-mix(in srgb, var(--color-token-text-link-foreground,currentColor) 16%, transparent)"
        : "";
      button.style.color = state.open ? "var(--color-token-text-link-foreground,currentColor)" : "";
    }
  };

  const makeToolbarButton = (base) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = base.className || "";
    button.setAttribute(toggleMarker, "");
    button.setAttribute("aria-label", "Inspect element");
    button.title = "Inspect element";
    button.innerHTML = inspectIcon();
    button.style.cssText += [
      "cursor:pointer",
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "width:28px",
      "height:28px",
      "min-width:28px",
      "max-width:28px",
      "flex:0 0 28px",
    ].join(";");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleDevTools();
    });
    return button;
  };

  const makeToolbarSlot = (button) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute(toggleSlotMarker, "");
    wrapper.className = "no-drag flex shrink-0 items-center justify-center";
    wrapper.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "width:28px",
      "height:28px",
      "min-width:28px",
      "max-width:28px",
      "flex:0 0 28px",
      "overflow:visible",
      "opacity:1",
      "transform:none",
      "position:relative",
      "z-index:1",
      "margin-inline-end:4px",
    ].join(";");
    wrapper.appendChild(button);
    return wrapper;
  };

  const installToolbarButton = () => {
    const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => isVisible(element));
    const screenshot = candidates.find((element) =>
      /(^|\\b)take a screenshot(\\b|$)/i.test(controlLabelOf(element)),
    );
    const annotate = candidates.find((element) =>
      /(^|\\b)annotat(e|ing)(\\b|$)/i.test(controlLabelOf(element)),
    );
    const target = screenshot || annotate;
    if (!(target instanceof HTMLElement) || !target.parentElement) return;

    const slot = target.parentElement;
    const group = slot?.parentElement ?? target.parentElement;
    if (!(group instanceof HTMLElement)) return;

    if (group.querySelector("[" + toggleMarker + "]")) {
      updateToggleButtons();
      return;
    }

    const button = makeToolbarButton(target);
    if (slot instanceof HTMLElement && slot.parentElement === group) {
      slot.after(makeToolbarSlot(button));
    } else if (screenshot) {
      screenshot.after(makeToolbarSlot(button));
    } else {
      annotate.after(makeToolbarSlot(button));
    }
    updateToggleButtons();
    requestState();
  };

  const scan = () => {
    installToolbarButton();

    const groups = new Map();
    for (const item of Array.from(document.querySelectorAll(itemSelector))) {
      if (!isVisible(item)) continue;
      const text = textOf(item);
      if (!isBrowserToolsText(text)) continue;
      const root = rootFor(item);
      if (!root) continue;
      const group = groups.get(root) || [];
      group.push(item);
      groups.set(root, group);
    }

    for (const items of groups.values()) {
      const labels = items.map(textOf).join("\\n");
      const looksLikeBrowserToolsMenu =
        /hard reload/i.test(labels) &&
        (/show device toolbar/i.test(labels) || /clear cache/i.test(labels) || /clear cookies/i.test(labels));
      if (looksLikeBrowserToolsMenu) installIntoMenu(items);
    }
  };

  const handleMenuChoicePointer = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const dockButton = target?.closest?.("button[data-codexpp-better-browser-devtools-dock]") ?? null;
    const themeButton = target?.closest?.("button[data-codexpp-better-browser-theme]") ?? null;
    const button = dockButton || themeButton;
    if (!(button instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const dock = button.dataset.codexppBetterBrowserDevtoolsDock;
    const theme = button.dataset.codexppBetterBrowserTheme;
    if (typeof dock === "string") chooseDock(dock);
    else if (typeof theme === "string") chooseTheme(theme);
  };

  let pending = 0;
  const schedule = () => {
    if (pending) return;
    pending = window.requestAnimationFrame(() => {
      pending = 0;
      scan();
    });
  };

  const observer = new MutationObserver(schedule);
  document.querySelectorAll("[" + marker + "], [" + toggleMarker + "], [" + toggleSlotMarker + "]").forEach((element) => {
    element.remove();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("pointerdown", handleMenuChoicePointer, true);
  document.addEventListener("pointerdown", schedule, true);
  document.addEventListener("keydown", schedule, true);
  const handleHostMessage = (event) => {
    const message = event.data;
    if (message?.type !== "better-browser-devtools-state") return;
    state.open = message.open === true;
    if (typeof message.dock === "string") state.dock = message.dock;
    if (typeof message.theme === "string") state.theme = message.theme;
    updateDockRows();
    updateThemeRows();
    updateToggleButtons();
  };

  window.addEventListener("message", handleHostMessage);
  state.disconnect = () => {
    observer.disconnect();
    document.removeEventListener("pointerdown", handleMenuChoicePointer, true);
    document.removeEventListener("pointerdown", schedule, true);
    document.removeEventListener("keydown", schedule, true);
    window.removeEventListener("message", handleHostMessage);
    if (pending) window.cancelAnimationFrame(pending);
  };

  schedule();
})();`;

function shouldPatchRendererAsset(rawUrl) {
  return assetPatchKind(rawUrl) != null;
}

function assetPatchKind(rawUrl) {
  if (typeof rawUrl !== "string") return null;

  let basename;
  try {
    const pathname = new URL(rawUrl).pathname;
    basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  } catch {
    return null;
  }

  if (/^use-model-settings-[A-Za-z0-9_]+\.js$/.test(basename)) {
    return "use-model-settings";
  }
  if (/^review-runtime-bridge-[A-Za-z0-9_]+\.js$/.test(basename)) {
    return "review-runtime-bridge";
  }
  if (/^app-shell-[A-Za-z0-9_]+\.js$/.test(basename)) {
    return "app-shell";
  }
  return null;
}

function patchRendererAsset(rawUrl, source) {
  switch (assetPatchKind(rawUrl)) {
    case "use-model-settings":
      return patchUseModelSettings(source);
    case "review-runtime-bridge":
      return patchReviewRuntimeBridge(source);
    case "app-shell":
      return patchAppShell(source);
    default:
      return source;
  }
}

function patchUseModelSettings(source) {
  let out = source;

  out = replaceRequired(
    out,
    "l=t=>{r(n=>{let r={...n},i=r[e]??[],a=typeof t==`function`?t(i):t;return a.length===0?(r[e]===void 0||delete r[e],r):(r[e]=a,r)})}",
    "l=t=>{r(n=>{let r={...n},i=r[e]??[],a=typeof t==`function`?t(i):t,o=typeof e==`string`?e.indexOf(`:browser:`):-1,s=o>0?e.slice(0,o):null;if(a.length===0)return r[e]===void 0||delete r[e],s!=null&&delete r[s],r;return r[e]=a,s!=null&&(r[s]=a),r})}",
    "browser comments base conversation mirror",
  );

  out = replaceRequired(
    out,
    "x=l&&c?.tabId===iu.BROWSER,S=x&&u,C;",
    "x=l&&c?.tabId===e.tabId,S=x&&u,C;",
    "browser panel active-tab check",
  );

  out = replaceRequired(
    out,
    "children:(0,Y.jsx)(qL,{autoFocusOnOpen:!0,conversationId:n,cwd:a,hostDisplayName:r,rolloutPath:g,agentBrowserControlLabel:v,agentBrowserControlTurnId:b,isAgentControllingBrowser:m,isDeviceToolbarMenuItemVisible:d,isFloatingComposerMenuItemVisible:S,isFloatingComposerVisible:p,isVisible:x,onToggleFloatingComposer:C,transferSourceConversationId:i})",
    "children:(0,Y.jsxs)(Y.Fragment,{children:[(0,Y.jsx)(xje,{browserConversationId:n,browserTabFallbackTitle:`Browser`,isAgentWorking:o,transferSourceConversationId:i,browserTabId:e.tabId}),(0,Y.jsx)(qL,{autoFocusOnOpen:!0,conversationId:n,cwd:a,hostDisplayName:r,rolloutPath:g,agentBrowserControlLabel:v,agentBrowserControlTurnId:b,isAgentControllingBrowser:m,isDeviceToolbarMenuItemVisible:d,isFloatingComposerMenuItemVisible:S,isFloatingComposerVisible:p,isVisible:x,onToggleFloatingComposer:C,transferSourceConversationId:i})]})",
    "browser tab metadata watcher",
  );

  out = replaceRequired(
    out,
    "vu.updateTab(o,iu.BROWSER,{",
    "vu.updateTab(o,e.browserTabId??iu.BROWSER,{",
    "browser metadata tab id",
  );

  const start = out.indexOf("function V3(e,t=!0,n={}){");
  const end = out.indexOf("function H3(", start);
  if (start === -1 || end === -1) {
    throw new Error("missing patch target: browser open helper block");
  }

  const replacement =
    'function V3(e,t=!0,n={}){let r=e.value,i=zr(r),a=n.browserConversationId??i;if(a==null)return!1;let o=e.get(No).formatMessage({id:`thread.sidePanel.browserTab`,defaultMessage:`Browser`,description:`Title for the browser tab in the thread side panel`}),s=e.get(vu.tabs$),c=e=>e.tabId===iu.BROWSER||typeof e.tabId==="string"&&e.tabId.startsWith(iu.BROWSER+":"),l=s.filter(c);if(n.browserTabId==null&&l.length>=25)return!1;let u=()=>typeof crypto<`u`&&typeof crypto.randomUUID==`function`?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`,d=n.browserTabId??(l.length===0?iu.BROWSER:`${iu.BROWSER}:${u()}`),f=d===iu.BROWSER?a:`${a}:browser:${d.slice(iu.BROWSER.length+1)}`,p=n.isAgentWorking??_(e,ze,a)??!1,m=zD({browserSnapshot:FS.getSnapshot(f,n.browserTransferSourceConversationId),browserTabFallbackTitle:o,browserUseActiveState:FS.getBrowserUseActiveState(f),conversationTurns:_(e,Ge,a)??RD,isResponseInProgress:p}),h=()=>{e.set(BD,{conversationId:f,...n.browserTransferSourceConversationId==null?{}:{transferSourceConversationId:n.browserTransferSourceConversationId}})};return h(),vu.openTab(e,bje,{highlightedIcon:(0,J.createElement)(sw,{className:`size-[13px]`}),icon:(0,J.createElement)(nw,{alt:``,className:`icon-xs shrink-0 rounded-2xs`,logoUrl:m.faviconUrl,fallback:(0,J.createElement)(Gr,{className:`size-full`})}),isHighlighted:m.isHighlighted,isShimmering:m.isShimmering,props:{browserConversationId:f,browserHostDisplayName:n.browserHostDisplayName??e.get(hd).display_name,...n.browserTransferSourceConversationId==null?{}:{browserTransferSourceConversationId:n.browserTransferSourceConversationId},cwd:n.cwd??e.get(pd),isAgentWorking:p},id:d,activate:t,onActivate:h,onClose:()=>{e.get(BD)?.conversationId===f&&e.set(BD,null),dn.dispatchMessage(`browser-sidebar-command`,{conversationId:f,command:{type:`reset`}})},title:m.title}),t&&uw(e),!0}function Tje(e,t){if(!V3(e,!0,t))return!1;e.set(ql,!0),e.set(Gl,!0);let n=e.get(Kl);return n.stop(),n.set(1),!0}';

  return out.slice(0, start) + replacement + out.slice(end);
}

function patchReviewRuntimeBridge(source) {
  let out = source;

  out = replaceRequired(
    out,
    "E=c&&!s.some(yr)",
    `E=c&&s.filter(yr).length<${MAX_BROWSER_TABS}`,
    "browser plus-menu cap",
  );

  out = replaceRequired(
    out,
    "function yr(e){return e.tabId===A.BROWSER}",
    'function yr(e){return e.tabId===A.BROWSER||typeof e.tabId==="string"&&e.tabId.startsWith(A.BROWSER+":")}',
    "browser tab detector",
  );

  out = replaceRequired(
    out,
    "if(!n||e!==A.BROWSER)return!1;",
    'if(!n||!(e===A.BROWSER||typeof e==="string"&&e.startsWith(A.BROWSER+":")))return!1;',
    "browser find shortcut detector",
  );

  return out.replace(
    "p=i?.tabId!==A.BROWSER||!a||o",
    'p=!(i?.tabId===A.BROWSER||typeof i?.tabId==="string"&&i.tabId.startsWith(A.BROWSER+":"))||!a||o',
  );
}

function patchAppShell(source) {
  let out = source;

  out = replaceRequired(
    out,
    "c=i?.tabId===E.BROWSER?a:null",
    'c=(i?.tabId===E.BROWSER||typeof i?.tabId==="string"&&i.tabId.startsWith(E.BROWSER+":"))?a:null',
    "browser shortcut state active tab",
  );

  out = replaceRequired(
    out,
    "i?.tabId===E.BROWSER&&G.closeTab(t,i.tabId)",
    '(i?.tabId===E.BROWSER||typeof i?.tabId==="string"&&i.tabId.startsWith(E.BROWSER+":"))&&G.closeTab(t,i.tabId)',
    "browser close-active-tab detector",
  );

  out = patchRightPanelTabShortcuts(out);

  return out;
}

function patchRightPanelTabShortcuts(source) {
  const start = source.indexOf("function nn(){let e=(0,Z.c)(13),");
  const end = source.indexOf("function rn(){", start);
  if (start === -1 || end === -1) {
    throw new Error("missing patch target: right-panel shortcut controller");
  }

  const replacement =
    'function nn(){let e=(0,Z.c)(18),t=q(X),n=J(o.canCloseActiveTab$),r=J(f),i=J(G.activeTab$),a=J(y),s=J(G.canCloseActiveTab$),c=J(G.tabs$),l=(i?.tabId===E.BROWSER||typeof i?.tabId==="string"&&i.tabId.startsWith(E.BROWSER+":"))?a:null,u=s||l!=null,d;e[0]===l?d=e[1]:(d=()=>l==null?null:F.getSnapshot(l.conversationId,l.transferSourceConversationId),e[0]=l,e[1]=d);let p=d,m=((0,$.useSyncExternalStore)(on,p,p)?.tabType===fe.WEB?l:null)?.conversationId??null,h,g;e[2]!==n||e[3]!==r||e[4]!==u||e[5]!==m?(h=()=>{xe.dispatchMessage(`app-shell-shortcut-state-changed`,{bottomPanelCanCloseActiveTab:n,focusArea:r,rightPanelBrowserConversationId:m,rightPanelCanCloseActiveTab:u})},g=[n,r,u,m],e[2]=n,e[3]=r,e[4]=u,e[5]=m,e[6]=h,e[7]=g):(h=e[6],g=e[7]),(0,$.useEffect)(h,g);let _;e[8]===Symbol.for(`react.memo_cache_sentinel`)?(_=[],e[8]=_):_=e[8],(0,$.useEffect)(rn,_);let v=e=>{if(!Array.isArray(c)||c.length===0)return!1;let n=c[e-1];return n==null?!1:(G.activateTab(t,n.tabId),!0)},b,x;e[9]!==c||e[10]!==r||e[11]!==t?(b=()=>{let e=e=>{let n=e.ctrlKey||e.metaKey;if(r!==`right-panel`||e.defaultPrevented||!n||e.ctrlKey&&e.metaKey||e.altKey||e.shiftKey)return;let i=null,a=e.code??``;if(/^Digit[1-9]$/.test(a))i=Number(a.slice(5));else{let o=e.key??``;/^[1-9]$/.test(o)&&(i=Number(o))}i!=null&&v(i)&&(e.preventDefault(),e.stopPropagation())},n=e=>{let t=e.data,n=Number(t?.index);t?.type===`better-browser-activate-right-tab`&&Number.isInteger(n)&&v(n)&&e.stopImmediatePropagation?.()};return window.addEventListener(`keydown`,e,!0),window.addEventListener(`message`,n),()=>{window.removeEventListener(`keydown`,e,!0),window.removeEventListener(`message`,n)}},x=[c,r,t],e[9]=c,e[10]=r,e[11]=t,e[12]=b,e[13]=x):(b=e[12],x=e[13]),(0,$.useEffect)(b,x);let S,C;return e[14]!==i||e[15]!==t?(S=e=>{let{panelId:n}=e;bb47:switch(n){case`bottom`:o.closeActiveTab(t);break bb47;case`right`:if(G.closeTab(t))break bb47;(i?.tabId===E.BROWSER||typeof i?.tabId==="string"&&i.tabId.startsWith(E.BROWSER+":"))&&G.closeTab(t,i.tabId)}},C=[i,t],e[14]=i,e[15]=t,e[16]=S,e[17]=C):(S=e[16],C=e[17]),Se(`close-active-app-shell-tab`,S,C),null}';

  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`missing patch target: ${label}`);
  }
  return source.replace(from, to);
}

function responseInitFrom(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
}

function stringifyError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function logInfo(api, message) {
  if (typeof api.log?.info === "function") {
    api.log.info(message);
  } else if (typeof api.log?.warn === "function") {
    api.log.warn(message);
  }
}
