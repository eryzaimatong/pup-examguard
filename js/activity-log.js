// Main process · activity log. Every event is appended to a per-student CSV in
// userData/logs and, when the exam has a Google Sheet log link, queued for
// upload to that Apps Script web app. The queue is saved to disk and retried
// with backoff until each event is accepted.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { net } = require("electron");

const COLUMNS = [
  ["id", "Event ID"],
  ["timestamp", "Timestamp"],
  ["examKey", "Exam Key"],
  ["examTitle", "Exam Title"],
  ["studentName", "Student Name"],
  ["studentNo", "Student Number"],
  ["section", "Section"],
  ["event", "Event"],
  ["detail", "Detail"],
  ["strikes", "Strikes"],
  ["computer", "Computer"],
];

const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

let logsDir = null;
let queueFile = null;
let queue = [];
let flushing = false;
let retryTimer = null;
let retryDelay = RETRY_MIN_MS;
let onChange = () => {};

function init(userDataDir, { onQueueChange } = {}) {
  logsDir = path.join(userDataDir, "logs");
  queueFile = path.join(userDataDir, "upload-queue.json");
  fs.mkdirSync(logsDir, { recursive: true });
  if (onQueueChange) onChange = onQueueChange;
  try {
    queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    if (!Array.isArray(queue)) queue = [];
  } catch {
    queue = [];
  }
  flush();
}

function saveQueue() {
  try {
    fs.writeFileSync(queueFile, JSON.stringify(queue));
  } catch {
    // Disk trouble — the in-memory queue still retries this run.
  }
  onChange(queue.length);
}

function pendingCount() {
  return queue.length;
}

// ---------- CSV ----------

// Quote every field; prefix formula-looking text so Excel/Sheets won't run it.
function csvField(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvFileFor(record) {
  const safe = (s) => String(s || "").replace(/[^A-Za-z0-9_-]+/g, "_");
  return path.join(logsDir, `${safe(record.examKey)}_${safe(record.studentNo)}.csv`);
}

function appendCsv(record) {
  const file = csvFileFor(record);
  const line = COLUMNS.map(([key]) => csvField(record[key])).join(",") + "\r\n";
  try {
    if (!fs.existsSync(file)) {
      // BOM so Excel opens names like "Peña" correctly.
      fs.writeFileSync(file, "﻿" + COLUMNS.map(([, title]) => csvField(title)).join(",") + "\r\n");
    }
    fs.appendFileSync(file, line);
  } catch {
    // Keep the exam running even if the log folder is unwritable.
  }
}

// ---------- Upload ----------

async function post(item) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await net.fetch(item.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(item.record),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && body.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function flush() {
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  try {
    while (queue.length) {
      const ok = await post(queue[0]);
      if (!ok) {
        retryTimer = setTimeout(flush, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        return;
      }
      retryDelay = RETRY_MIN_MS;
      queue.shift();
      saveQueue();
    }
  } finally {
    flushing = false;
  }
}

// ---------- Public ----------

function record(exam, session, event, detail = "") {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    examKey: exam.key,
    examTitle: exam.title,
    studentName: session.student.name,
    studentNo: session.student.studentNo,
    section: session.student.section,
    event,
    detail,
    strikes: session.strikes,
    computer: os.hostname(),
  };
  appendCsv(entry);
  if (exam.logUrl) {
    queue.push({ url: exam.logUrl, record: entry });
    saveQueue();
    if (!retryTimer) flush();
  }
  return entry;
}

module.exports = { init, record, flush, pendingCount, csvField, COLUMNS };
