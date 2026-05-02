# Better Browser

Built for [Codex++](https://github.com/b-nnett/codex-plusplus), a tweak system for the Codex desktop app.

<img width="2944" height="2196" alt="image" src="https://github.com/user-attachments/assets/afc31248-af43-435f-86fc-2f5ad7c3752c" />

Better Browser improves the Codex desktop in-app browser side panel. It is a main-process Codex++ tweak that patches Electron `webContents` behavior and selected Codex renderer bundles at runtime.

## Features

- Opens up to 25 browser tabs from the side-panel plus menu.
- Keeps browser tab metadata, titles, favicons, snapshots, and annotation routing separate per tab.
- Opens browser DevTools inline inside the browser panel instead of in a detached external window.
- Supports DevTools docking on the left, bottom, or right.
- Adds a resize handle for inline DevTools.
- Adds an Inspect Element toolbar button next to screenshot and annotation controls.
- Adds a browser Theme picker with Dark and Light options.
- Adds keyboard shortcuts for browser tab switching, DevTools, and browser navigation.
- Adds trackpad swipe gestures for browser back and forward navigation, with visible gesture feedback.

## Controls

### Browser Tabs

- Use the side-panel plus menu to open additional Browser tabs.
- Up to 25 Browser tabs can be open at once.
- `Ctrl+1` through `Ctrl+9` switches between right-panel tabs while the right panel or browser has focus.
- On macOS, `Cmd+1` through `Cmd+9` is also handled by the renderer shortcut path.

### Navigation

- macOS: `Cmd+Left` and `Cmd+Right` navigate browser history.
- Windows/Linux: `Ctrl+Left` and `Ctrl+Right` navigate browser history.
- Horizontal trackpad swipes trigger back/forward when browser history is available.
- Gesture UI is disabled when the active browser cannot go in that direction.

### DevTools

- Click the Inspect Element toolbar button to toggle inline DevTools.
- Keyboard shortcut:
  - macOS: `Cmd+Option+I`
  - Windows/Linux: `Ctrl+Shift+I`
  - `F12` also toggles DevTools.
- The browser tools menu contains `Dock DevTools` controls for left, bottom, and right docking.
- DevTools open/closed state is tracked per browser tab.

### Theme

- The browser tools menu contains a `Theme` row with `Dark` and `Light` choices.
- Theme changes are applied to browser `webContents` with Chromium `Emulation.setEmulatedMedia` for `prefers-color-scheme`.
- A page-level fallback also updates `color-scheme` and common theme attributes such as `data-color-mode`, `data-theme`, and `data-bs-theme` for sites that respond to DOM theme hints.

## Implementation Notes

The tweak runs in the Electron main process and installs these hooks:

- `protocol.handle("app", ...)` wraps selected renderer assets as they are served.
- `ipcMain.handle(...)` observes renderer messages sent through `codex_desktop:message-from-view`.
- `app.on("web-contents-created", ...)` patches browser `webContents` methods.
- `globalShortcut` registers right-panel tab switching while a Codex window is focused.

Renderer asset patches currently target:

- `use-model-settings-*`: multi-tab browser creation, browser tab metadata, and annotation routing.
- `review-runtime-bridge-*`: plus-menu browser availability and browser tab detection.
- `app-shell-*`: active browser tab shortcut state and right-panel tab switching.

Main-process `webContents` patches currently override:

- `openDevTools`
- `closeDevTools`
- `inspectElement`
- `send`

Inline DevTools is implemented with Electron `BrowserView` instances:

- one `BrowserView` hosts the DevTools frontend;
- one small `BrowserView` hosts the resize handle;
- bounds are recomputed against the visible browser panel area.

## Verification

Run these from the tweaks directory:

```sh
node --check co.bennett.better-browser/index.js
BETTER_BROWSER_TEST=1 node co.bennett.better-browser/index.js
```

For live debugging, use the Codex app CDP endpoint:

```sh
curl -s http://127.0.0.1:9222/json/list
```

Useful live checks:

- Confirm the app shell injected menu script version:

```js
window.__codexppBetterBrowserDevToolsDockMenu?.version
```

- Confirm a browser page is seeing the intended theme:

```js
matchMedia("(prefers-color-scheme: dark)").matches
matchMedia("(prefers-color-scheme: light)").matches
getComputedStyle(document.body).backgroundColor
```

## Troubleshooting

- If DevTools opens as a separate window, the target browser `webContents` was not resolved to an inline entry. Check active browser conversation hints and `webContentsId` resolution.
- If the theme menu changes UI state but the page does not change, verify `Emulation.setEmulatedMedia` is reaching the webview target. Some external CDP clients can block Electron's `webContents.debugger`; the fallback handles common DOM-driven theme systems but cannot fully replace media emulation for every site.
- If annotations work on the first tab but not later tabs, check direct-comment conversation alias routing and the base conversation mirror in `patchUseModelSettings`.
- If inline DevTools lags behind panel resizing, check BrowserView bounds polling and `getBrowserPageContentBounds`.
