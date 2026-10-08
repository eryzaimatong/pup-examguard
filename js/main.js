// Main process · window, page routing, locked mode, strikes and IPC.

const path = require("path");
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, powerSaveBlocker } = require("electron");
const storage = require("./storage");
const activityLog = require("./activity-log");
const { createMonitor, sweep } = require("./process-monitor");
const { createFormView } = require("./form-view");

const ROOT = path.join(__dirname, "..");
// --dev (ignored in the packaged .exe): no kiosk/always-on-top, window can close.
const DEV = process.argv.includes("--dev") && !app.isPackaged;
const BLUR_GRACE_MS = 2500;
const NOTICE_REPEAT_MS = 3000;
const BLOCKED_KEYS = new Set(["F5", "F11", "F12"]);
const BLOCKED_CODES = new Set(["KeyC", "KeyV", "KeyX", "KeyP", "KeyS", "KeyR", "KeyW", "KeyN", "KeyT", "KeyL", "KeyO", "KeyU", "KeyI", "KeyJ"]);

let win = null;
let session = null; // active or just-finished exam session (also in session.json)
let facultyUnlocked = false;
let locked = false;
let finishing = false;
let monitor = null;
let formView = null;
let examTimer = null;
let powerBlockId = null;
let blurTimer = null;
let lastViolationAt = 0;
const lastNotice = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Helpers ----------

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function showPage(name) {
  win.loadFile(path.join(ROOT, `${name}.html`));
}

const examActive = () => Boolean(session && !session.submittedAt);

function publicSession() {
  if (!session) return null;
  return { ...session, exam: storage.publicExam(session.exam) };
}

function sendSession() {
  send("session", publicSession());
}

function log(event, detail) {
  activityLog.record(session.exam, session, event, detail);
}

function addLogRow(appName, action, strike) {
  session.log.push({ at: Date.now(), app: appName, action, strike });
}

// ---------- Locked mode ----------

function lock() {
  locked = true;
  clipboard.clear();
  if (!DEV) {
    win.setKiosk(true);
    win.setAlwaysOnTop(true, "screen-saver");
  }
  if (powerBlockId === null) powerBlockId = powerSaveBlocker.start("prevent-display-sleep");
  win.show();
  win.focus();
}

function unlock() {
  locked = false;
  clearInterval(examTimer);
  clearTimeout(blurTimer);
  examTimer = null;
  blurTimer = null;
  if (monitor) monitor.stop();
  monitor = null;
  if (formView) formView.destroy();
  formView = null;
  if (powerBlockId !== null) powerSaveBlocker.stop(powerBlockId);
  powerBlockId = null;
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
}

function refocus() {
  if (!DEV) win.setAlwaysOnTop(true, "screen-saver");
  win.show();
  win.moveTop();
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

function handleLockedKeys(event, input) {
  if (!locked || input.type !== "keyDown") return;
  const mod = input.control || input.meta;
  if (mod && input.shift && input.alt && input.code === "KeyE") {
    event.preventDefault();
    if (formView) formView.setVisible(false);
    send("proctor-prompt");
    return;
  }
  if (BLOCKED_KEYS.has(input.key) || (mod && BLOCKED_CODES.has(input.code))) {
    event.preventDefault();
  }
}

// ---------- Strikes ----------

function addStrike({ appName, action, event, title, body }) {
  if (!examActive() || finishing) return;
  lastViolationAt = Date.now();
  session.strikes += 1;
  addLogRow(appName, `${action} · Strike ${session.strikes}`, true);
  storage.saveSession(session);
  log(event, appName);
  sendSession();

  if (session.strikes >= session.exam.maxStrikes) {
    finishExam("strikes");
    return;
  }
  if (formView) formView.setVisible(false);
  send("violation", { title, body });
}

// One strike per sweep, for apps outside their cooldown.
function onAppsClosed(closed, fresh) {
  if (!examActive() || finishing) return;
  // Any app we close (even without a strike) can steal focus for a moment;
  // don't also count that as leaving the window.
  lastViolationAt = Date.now();
  if (fresh.length === 0) return;
  const names = fresh.map((a) => a.label).join(", ");
  const shorts = [...new Set(fresh.map((a) => a.short))].join(", ");
  addStrike({
    appName: names,
    action: "Closed",
    event: "app_closed",
    title: `${fresh[0].label}${fresh.length > 1 ? " and others were" : " was"} blocked`,
    body: `Opening other apps is not allowed during the exam. ${shorts} ${fresh.length > 1 ? "were" : "was"} closed and this attempt has been recorded.`,
  });
}

function onWindowBlur() {
  if (!locked || finishing || !examActive()) return;
  const blurAt = Date.now();
  refocus();
  if (!session.exam.rules.blur || blurTimer) return;
  // Opening Word blurs the window too; only count the blur if no other
  // violation happened around the same moment.
  blurTimer = setTimeout(() => {
    blurTimer = null;
    if (!locked || finishing) return;
    if (Math.abs(lastViolationAt - blurAt) <= BLUR_GRACE_MS) return;
    addStrike({
      appName: "Another window",
      action: "Left exam",
      event: "window_left",
      title: "You left the exam window",
      body: "Switching away from the exam is not allowed. This attempt has been recorded.",
    });
  }, BLUR_GRACE_MS);
}

function onBlocked(kind, url) {
  if (!examActive() || finishing) return;
  let host = url;
  try {
    host = new URL(url).hostname || url;
  } catch {
    // keep raw url
  }
  const key = `${kind}:${host}`;
  const now = Date.now();
  if (now - (lastNotice.get(key) || 0) < NOTICE_REPEAT_MS) return;
  lastNotice.set(key, now);

  const action = kind === "popup" ? "Pop-up blocked" : "Page blocked";
  addLogRow(host, `${action} · No strike`, false);
  storage.saveSession(session);
  log(kind === "popup" ? "popup_blocked" : "navigation_blocked", url);
  sendSession();
  send("notice", `${action}: ${host} — only the exam form can open`);
}

// ---------- Exam lifecycle ----------

function beginLockedExam(closedBeforeStart = []) {
  lock();
  monitor = createMonitor({
    rules: session.exam.rules,
    grace: closedBeforeStart.map((a) => a.name),
    onClosed: onAppsClosed,
  });
  monitor.start();
  examTimer = setInterval(() => {
    if (Date.now() >= session.endsAt) finishExam("time");
  }, 1000);
  showPage("exam");
}

function ensureFormView() {
  if (formView || !locked) return;
  formView = createFormView({
    win,
    exam: session.exam,
    onKey: handleLockedKeys,
    onBlocked,
    onSubmitted: () => finishExam("form"),
  });
}

async function startExam(input) {
  if (examActive()) return { ok: false, error: "An exam is already in progress." };
  const student = {
    name: String(input.name || "").trim().slice(0, 120),
    studentNo: String(input.studentNo || "").trim().slice(0, 40),
    section: String(input.section || "").trim().slice(0, 40),
  };
  if (!student.name || !student.studentNo || !student.section) {
    return { ok: false, error: "Fill in your name, student number and section." };
  }
  const exam = storage.getExam();
  if (!exam) {
    return { ok: false, field: "examKey", error: "No exam is set up on this computer yet. Ask your proctor to import the exam file." };
  }
  if (storage.normalizeKey(input.examKey) !== exam.key) {
    return { ok: false, field: "examKey", error: "That exam key wasn’t found. Check the key from your professor." };
  }

  const now = Date.now();
  session = {
    exam,
    student,
    startedAt: now,
    endsAt: now + exam.durationMinutes * 60 * 1000,
    strikes: 0,
    log: [],
    submittedAt: null,
    submitReason: null,
    autoSubmit: null,
  };
  facultyUnlocked = false;

  // Close blocked apps before the exam starts — no strike for these.
  const closed = await sweep(exam.rules);
  for (const a of closed) {
    addLogRow(a.label, "Closed before start · No strike", false);
    log("closed_before_start", a.label);
  }
  storage.saveSession(session);
  log("exam_started", `${exam.durationMinutes} min · ${exam.maxStrikes} strikes`);
  lastViolationAt = Date.now();
  beginLockedExam(closed);
  return { ok: true };
}

async function finishExam(reason) {
  if (finishing || !examActive()) return;
  finishing = true;
  clearInterval(examTimer);
  examTimer = null;
  if (monitor) monitor.stop();

  try {
    if (reason === "time" || reason === "strikes") {
      send("submitting", reason);
      log("auto_submit_attempt", reason === "time" ? "Time is up" : "Strike limit reached");
      let result = { clicked: false, ok: false, detail: "The form wasn't loaded" };
      if (formView) {
        formView.setVisible(true);
        result = await formView.autoSubmit();
      }
      session.autoSubmit = result;
      log(result.ok ? "auto_submit_ok" : "auto_submit_failed", result.detail || "");
    }

    session.submittedAt = Date.now();
    session.submitReason = reason;
    storage.saveSession(session);
    log("exam_ended", reason);
  } finally {
    unlock();
    finishing = false;
  }
  showPage("submitted");
}

// Restores an exam after a crash, forced quit or power loss.
function resumeSession() {
  const saved = storage.getSession();
  if (!saved || !saved.exam || !saved.student) return "index";
  session = saved;
  if (session.submittedAt) return "submitted";

  if (Date.now() >= session.endsAt) {
    // The form reloads empty after a restart, so don't auto-submit it.
    session.submittedAt = Date.now();
    session.submitReason = "time";
    session.autoSubmit = { clicked: false, ok: false, restarted: true };
    storage.saveSession(session);
    log("exam_ended", "time (ExamGuard was restarted after time ran out)");
    return "submitted";
  }

  addLogRow("ExamGuard restarted", "Exam resumed · No strike", false);
  storage.saveSession(session);
  log("resumed_after_restart", "");
  return "exam";
}

// ---------- Window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f7f4ef",
    title: "PUP ExamGuard",
    icon: path.join(ROOT, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: DEV,
    },
  });

  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }

  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });

  // Pages only change through showPage().
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("before-input-event", handleLockedKeys);

  win.on("blur", onWindowBlur);
  win.on("close", (event) => {
    if (locked && !DEV) event.preventDefault();
  });
  win.on("closed", () => {
    win = null;
  });
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: "Not allowed." };
    return fn(...args);
  });
}

function registerIpc() {
  handle("state:get", () => ({
    exam: storage.publicExam(storage.getExam()),
    session: publicSession(),
    uploadsPending: activityLog.pendingCount(),
    dev: DEV,
  }));

  handle("exam:start", (input) => startExam(input || {}));

  handle("exam:proctorExit", async (password) => {
    if (!examActive() || finishing) return { ok: false, error: "No exam is running." };
    if (!storage.checkPassword(password, session.exam.passwordHash)) {
      log("proctor_exit_failed", "Wrong exit password");
      return { ok: false, error: "Incorrect exit password." };
    }
    log("proctor_exit", "Exam ended early by proctor");
    finishExam("proctor");
    return { ok: true };
  });

  handle("app:exit", () => {
    if (locked) return { ok: false, error: "The exam is still running." };
    storage.clearSession();
    session = null;
    app.quit();
    return { ok: true };
  });

  handle("nav:checkin", () => {
    if (locked) return { ok: false };
    facultyUnlocked = false;
    if (session && session.submittedAt) {
      storage.clearSession();
      session = null;
    }
    showPage("index");
    return { ok: true };
  });

  handle("faculty:open", (password) => {
    if (examActive()) return { ok: false, error: "An exam is in progress." };
    const current = storage.getExam();
    if (current && !storage.checkPassword(password, current.passwordHash)) {
      return { ok: false, needsPassword: true, error: password ? "Incorrect exit password." : "" };
    }
    facultyUnlocked = true;
    showPage("teacher");
    return { ok: true };
  });

  handle("faculty:save", (input) => {
    if (!facultyUnlocked) return { ok: false, error: "Faculty access required." };
    const result = storage.createExam(input || {}, storage.getExam());
    if (result.error) return { ok: false, error: result.error, field: result.field };
    storage.saveExam(result.exam);
    return { ok: true, exam: storage.publicExam(result.exam) };
  });

  handle("faculty:export", async () => {
    if (!facultyUnlocked) return { ok: false, error: "Faculty access required." };
    const exam = storage.getExam();
    if (!exam) return { ok: false, error: "Generate an exam key first." };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export exam file",
      defaultPath: path.join(app.getPath("documents"), storage.exportFileName(exam)),
      filters: [{ name: "ExamGuard exam", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    storage.exportExam(exam, filePath);
    return { ok: true, filePath };
  });

  handle("faculty:import", async () => {
    if (!facultyUnlocked) return { ok: false, error: "Faculty access required." };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Import exam file",
      properties: ["openFile"],
      filters: [{ name: "ExamGuard exam", extensions: ["json"] }],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const result = storage.importExam(filePaths[0]);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, exam: storage.publicExam(result.exam) };
  });

  ipcMain.on("form:bounds", (event, rect) => {
    if (!win || event.sender !== win.webContents || !locked || !rect) return;
    const r = {
      x: Math.round(Number(rect.x) || 0),
      y: Math.round(Number(rect.y) || 0),
      width: Math.max(0, Math.round(Number(rect.width) || 0)),
      height: Math.max(0, Math.round(Number(rect.height) || 0)),
    };
    ensureFormView();
    formView.setBounds(r);
  });

  ipcMain.on("form:visible", (event, visible) => {
    if (!win || event.sender !== win.webContents || !formView || finishing) return;
    formView.setVisible(Boolean(visible));
  });
}

// ---------- App ----------

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("before-quit", (event) => {
  if (locked && !DEV) {
    event.preventDefault();
    return;
  }
  // The next student shouldn't see this student's summary.
  if (session && session.submittedAt) storage.clearSession();
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  storage.init(userData);
  activityLog.init(userData, { onQueueChange: (n) => send("uploads", n) });
  registerIpc();
  createWindow();

  const page = resumeSession();
  if (page === "exam") beginLockedExam();
  else showPage(page);
});
