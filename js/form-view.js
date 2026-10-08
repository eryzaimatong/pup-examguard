// Main process · the Google Form, shown in a WebContentsView laid over the
// exam screen's form slot (Google refuses to load forms inside iframes).
// Uses an in-memory session so no Google login survives on shared PCs.

const path = require("path");
const { WebContentsView, session: electronSession } = require("electron");

const PARTITION = "examguard-form"; // no "persist:" prefix → memory only
let sessionReady = false;

const AI_HOSTS = [
  "chatgpt.com",
  "openai.com",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "copilot.cloud.microsoft",
  "claude.ai",
  "perplexity.ai",
  "poe.com",
  "deepseek.com",
  "meta.ai",
];

// Subframes Google pages embed (sign-in helpers, picker, YouTube videos).
const GOOGLE_FRAME_HOSTS = ["google.com", "gstatic.com", "googleusercontent.com", "youtube.com", "youtube-nocookie.com"];

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Top-level pages the form may navigate to.
function isAllowedPage(url, rules) {
  const u = parse(url);
  if (!u || u.protocol !== "https:") return false;
  const host = u.hostname;
  if (rules.web) {
    return (
      (host === "docs.google.com" && u.pathname.startsWith("/forms")) ||
      host === "forms.gle" ||
      host === "accounts.google.com" ||
      (host === "www.google.com" && u.pathname.startsWith("/accounts")) ||
      hostIs(host, "gstatic.com")
    );
  }
  if (rules.ai) return !AI_HOSTS.some((domain) => hostIs(host, domain));
  return true;
}

function isAllowedFrame(url, rules) {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === "about:" || u.protocol === "data:") return true;
  if (u.protocol !== "https:") return false;
  if (rules.web) return GOOGLE_FRAME_HOSTS.some((domain) => hostIs(u.hostname, domain));
  return isAllowedPage(url, rules);
}

// A normal desktop Chrome user agent (Electron's default mentions Electron,
// which Google sign-in rejects).
function chromeUserAgent() {
  const chrome = process.versions.chrome;
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Google's confirmation page: URL has formResponse and no answer fields left.
const NO_INPUTS_JS = `!document.querySelector(
  'input:not([type=hidden]), textarea, select, [role=radio], [role=checkbox], [role=listbox], [role=textbox]'
)`;

// Finds the button labelled Submit / Isumite; returns its centre or null.
const FIND_SUBMIT_JS = `(() => {
  const want = /^(submit|isumite)$/i;
  const els = document.querySelectorAll('[role="button"], button, input[type="submit"]');
  for (const el of els) {
    const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!want.test(label)) continue;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    window.__examguardSubmit = el;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  return null;
})()`;

function createFormView({ win, exam, onKey, onBlocked, onSubmitted }) {
  const ses = electronSession.fromPartition(PARTITION);
  const userAgent = chromeUserAgent();
  if (!sessionReady) {
    sessionReady = true;
    ses.setUserAgent(userAgent);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event) => event.preventDefault());
  }

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, "form-preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
    },
  });
  if (typeof view.setBorderRadius === "function") view.setBorderRadius(10);
  view.setBackgroundColor("#ffffff");
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setUserAgent(userAgent);
  let autoSubmitting = false;
  let destroyed = false;

  wc.on("before-input-event", onKey);

  wc.setWindowOpenHandler(({ url }) => {
    onBlocked("popup", url);
    return { action: "deny" };
  });

  const guardPage = (event) => {
    if (!isAllowedPage(event.url, exam.rules)) {
      event.preventDefault();
      onBlocked("page", event.url);
    }
  };
  wc.on("will-navigate", guardPage);
  wc.on("will-redirect", guardPage);
  wc.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedFrame(event.url, exam.rules)) {
      event.preventDefault();
      onBlocked("frame", event.url);
    }
  });

  async function isSubmittedPage() {
    if (destroyed || !wc.getURL().includes("formResponse")) return false;
    try {
      return Boolean(await wc.executeJavaScript(NO_INPUTS_JS, true));
    } catch {
      return false;
    }
  }

  async function checkSubmitted() {
    if (!autoSubmitting && (await isSubmittedPage())) onSubmitted();
  }
  wc.on("did-finish-load", checkSubmitted);
  wc.on("did-navigate-in-page", checkSubmitted);

  wc.on("render-process-gone", () => {
    if (!destroyed) wc.loadURL(exam.formUrl);
  });

  wc.loadURL(exam.formUrl);

  async function waitForSubmitted(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await sleep(500);
      if (await isSubmittedPage()) return true;
    }
    return false;
  }

  // Where the view is, for the activity log when auto-submit fails.
  function pageDetail() {
    const u = parse(wc.getURL());
    return u ? `${u.hostname}${u.pathname}` : "no page";
  }

  // Looks for the Submit button for up to `ms` (the page may still be
  // loading). Returns { point } or { error }.
  async function findSubmit(ms) {
    const until = Date.now() + ms;
    let error = null;
    for (;;) {
      try {
        const point = await wc.executeJavaScript(FIND_SUBMIT_JS, true);
        if (point) return { point };
        error = null;
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      if (Date.now() >= until) return { error };
      await sleep(500);
    }
  }

  // Clicks Submit / Isumite with a real mouse click, then falls back to a DOM
  // click. Resolves to { clicked, ok, detail } where ok means Google
  // confirmed it and detail explains a failure.
  async function autoSubmit() {
    autoSubmitting = true;
    try {
      if (await isSubmittedPage()) return { clicked: false, ok: true };
      const found = await findSubmit(5000);
      if (!found.point) {
        const why = found.error ? `script error: ${found.error}` : "no Submit button";
        return { clicked: false, ok: false, detail: `Submit button not found (${why}) on ${pageDetail()}` };
      }

      await sleep(300); // let scrollIntoView settle
      const click = { x: found.point.x, y: found.point.y, button: "left", clickCount: 1 };
      wc.sendInputEvent({ type: "mouseDown", ...click });
      wc.sendInputEvent({ type: "mouseUp", ...click });
      if (await waitForSubmitted(4000)) return { clicked: true, ok: true };

      try {
        await wc.executeJavaScript("window.__examguardSubmit && window.__examguardSubmit.click()", true);
      } catch {
        // page navigated away mid-call
      }
      if (await waitForSubmitted(6000)) return { clicked: true, ok: true };
      return {
        clicked: true,
        ok: false,
        detail: `Clicked Submit but Google didn't confirm (unanswered required question or not on the last page) on ${pageDetail()}`,
      };
    } finally {
      autoSubmitting = false;
    }
  }

  return {
    setBounds(rect) {
      view.setBounds(rect);
    },
    setVisible(visible) {
      view.setVisible(visible);
      if (visible) wc.focus();
    },
    autoSubmit,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.contentView.removeChildView(view);
      wc.close();
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    },
  };
}

module.exports = { createFormView, isAllowedPage, isAllowedFrame };
