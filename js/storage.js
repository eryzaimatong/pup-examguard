// Main process · exam config (userData/exam.json), the active session
// (userData/session.json) and exam-file export/import.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RULE_NAMES = ["web", "ai", "word", "notes", "pdf", "blur"];
const DEFAULT_RULES = { web: true, ai: true, word: true, notes: true, pdf: true, blur: true };
const MIN_STRIKES = 1;
const MAX_STRIKES = 10;

let dataDir = null;

function init(userDataDir) {
  dataDir = userDataDir;
  fs.mkdirSync(dataDir, { recursive: true });
}

const examPath = () => path.join(dataDir, "exam.json");
const sessionPath = () => path.join(dataDir, "session.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Write to a temp file and rename, so a crash never leaves half a file.
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Keys, passwords, URLs ----------

function generateExamKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let part = "";
  for (let i = 0; i < 4; i++) part += alphabet[crypto.randomInt(alphabet.length)];
  return `PUP-${part}-${String(crypto.randomInt(100)).padStart(2, "0")}`;
}

function normalizeKey(key) {
  return String(key || "").trim().toUpperCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { algo: "scrypt", salt, hash };
}

function checkPassword(password, stored) {
  if (!stored || stored.algo !== "scrypt" || !stored.salt || !stored.hash) return false;
  const expected = Buffer.from(stored.hash, "hex");
  const actual = crypto.scryptSync(String(password || ""), stored.salt, expected.length);
  return expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

function isGoogleFormUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (
      (url.hostname === "docs.google.com" && url.pathname.startsWith("/forms/")) ||
      url.hostname === "forms.gle"
    );
  } catch {
    return false;
  }
}

// Teachers often paste the editor link; students need the respondent link.
function toViewformUrl(value) {
  const url = new URL(value);
  if (url.hostname === "docs.google.com") {
    const m = url.pathname.match(/^(\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[^/]+)\/edit\b/);
    if (m) {
      url.pathname = `${m[1]}/viewform`;
      url.search = "";
      url.hash = "";
    }
  }
  return url.toString();
}

function isLogUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" && /\/exec$/.test(url.pathname);
  } catch {
    return false;
  }
}

// ---------- Exam config ----------

// Returns an error message, or null when the config is usable.
function validateExam(exam) {
  if (!exam || typeof exam !== "object") return "The file is not an ExamGuard exam.";
  if (!/^PUP-[A-Z0-9]{4}-\d{2}$/.test(exam.key || "")) return "The exam key is missing or invalid.";
  if (!exam.title || typeof exam.title !== "string") return "The exam title is missing.";
  if (!isGoogleFormUrl(exam.formUrl)) return "The Google Form link is missing or invalid.";
  if (!Number.isInteger(exam.durationMinutes) || exam.durationMinutes < 1 || exam.durationMinutes > 600) {
    return "The duration must be 1–600 minutes.";
  }
  if (!Number.isInteger(exam.maxStrikes) || exam.maxStrikes < MIN_STRIKES || exam.maxStrikes > MAX_STRIKES) {
    return `Strikes must be ${MIN_STRIKES}–${MAX_STRIKES}.`;
  }
  if (!exam.passwordHash || !exam.passwordHash.salt || !exam.passwordHash.hash) return "The exit password is missing.";
  if (exam.logUrl && !isLogUrl(exam.logUrl)) return "The Google Sheet log link is invalid.";
  return null;
}

function cleanExam(exam) {
  const rules = {};
  for (const name of RULE_NAMES) {
    rules[name] = exam.rules && typeof exam.rules[name] === "boolean" ? exam.rules[name] : DEFAULT_RULES[name];
  }
  return {
    version: 1,
    key: normalizeKey(exam.key),
    title: String(exam.title).trim(),
    formUrl: toViewformUrl(exam.formUrl),
    durationMinutes: exam.durationMinutes,
    maxStrikes: exam.maxStrikes,
    rules,
    logUrl: exam.logUrl || "",
    passwordHash: {
      algo: exam.passwordHash.algo || "scrypt",
      salt: exam.passwordHash.salt,
      hash: exam.passwordHash.hash,
    },
    createdAt: exam.createdAt || new Date().toISOString(),
  };
}

function getExam() {
  const exam = readJson(examPath());
  return exam && !validateExam(exam) ? cleanExam(exam) : null;
}

// What the renderer may see: everything except the password hash.
function publicExam(exam) {
  if (!exam) return null;
  const { passwordHash, ...rest } = exam;
  return rest;
}

// Builds a new exam (new key) from the teacher form. An empty password keeps
// the current one when editing an existing exam.
function createExam(input, current) {
  const formUrl = String(input.formUrl || "").trim();
  if (!isGoogleFormUrl(formUrl)) return { error: "Enter a Google Forms link (docs.google.com/forms/… or forms.gle/…).", field: "formUrl" };

  const logUrl = String(input.logUrl || "").trim();
  if (logUrl && !isLogUrl(logUrl)) {
    return { error: "Enter the Apps Script web app URL (https://script.google.com/macros/s/…/exec).", field: "logUrl" };
  }

  const password = String(input.exitPassword || "");
  if (!password && !current) return { error: "Set an exit password.", field: "exitPassword" };

  const exam = {
    key: generateExamKey(),
    title: String(input.title || "").trim(),
    formUrl: toViewformUrl(formUrl),
    durationMinutes: Number(input.durationMinutes),
    maxStrikes: Number(input.maxStrikes),
    rules: input.rules || {},
    logUrl,
    passwordHash: password ? hashPassword(password) : current.passwordHash,
    createdAt: new Date().toISOString(),
  };
  const error = validateExam(exam);
  if (error) return { error };
  return { exam: cleanExam(exam) };
}

function saveExam(exam) {
  writeJson(examPath(), exam);
}

function exportFileName(exam) {
  const safe = exam.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return `${safe || exam.key}.examguard.json`;
}

function exportExam(exam, file) {
  fs.writeFileSync(file, JSON.stringify(exam, null, 2));
}

function importExam(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { error: "That file isn’t a readable ExamGuard exam file." };
  }
  const error = validateExam(data);
  if (error) return { error };
  const exam = cleanExam(data);
  saveExam(exam);
  return { exam };
}

// ---------- Session ----------

function getSession() {
  return readJson(sessionPath());
}

function saveSession(session) {
  writeJson(sessionPath(), session);
}

function clearSession() {
  fs.rmSync(sessionPath(), { force: true });
}

module.exports = {
  MIN_STRIKES,
  MAX_STRIKES,
  init,
  normalizeKey,
  checkPassword,
  isGoogleFormUrl,
  toViewformUrl,
  getExam,
  publicExam,
  createExam,
  saveExam,
  exportFileName,
  exportExam,
  importExam,
  getSession,
  saveSession,
  clearSession,
};
