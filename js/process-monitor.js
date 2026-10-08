// Main process · closes blocked desktop apps.
// Windows: `tasklist /fo csv /nh` + `taskkill /F /T /IM`.
// macOS:   `ps -axo comm=`       + `killall -9`.

const { execFile } = require("child_process");
const path = require("path");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Each rule group lists [process name, label shown to student/teacher, short name].
// Names are matched case-insensitively against the executable's file name.
const BLOCKLISTS = {
  web: {
    win: [
      ["chrome.exe", "Google Chrome", "Chrome"],
      ["msedge.exe", "Microsoft Edge", "Edge"], // never msedgewebview2.exe
      ["firefox.exe", "Firefox", "Firefox"],
      ["opera.exe", "Opera", "Opera"],
      ["brave.exe", "Brave", "Brave"],
      ["vivaldi.exe", "Vivaldi", "Vivaldi"],
      ["arc.exe", "Arc", "Arc"],
    ],
    mac: [
      ["Google Chrome", "Google Chrome", "Chrome"],
      ["Microsoft Edge", "Microsoft Edge", "Edge"],
      ["firefox", "Firefox", "Firefox"],
      ["Opera", "Opera", "Opera"],
      ["Brave Browser", "Brave", "Brave"],
      ["Vivaldi", "Vivaldi", "Vivaldi"],
      ["Arc", "Arc", "Arc"],
      ["Safari", "Safari", "Safari"],
    ],
  },
  ai: {
    win: [
      ["ChatGPT.exe", "ChatGPT", "ChatGPT"],
      ["Claude.exe", "Claude", "Claude"],
      ["Copilot.exe", "Microsoft Copilot", "Copilot"],
      ["M365Copilot.exe", "Microsoft 365 Copilot", "Copilot"],
      ["Perplexity.exe", "Perplexity", "Perplexity"],
    ],
    mac: [
      ["ChatGPT", "ChatGPT", "ChatGPT"],
      ["Claude", "Claude", "Claude"],
      ["Copilot", "Microsoft Copilot", "Copilot"],
      ["Perplexity", "Perplexity", "Perplexity"],
    ],
  },
  word: {
    win: [
      ["winword.exe", "Microsoft Word", "Word"],
      ["wps.exe", "WPS Writer", "WPS"],
    ],
    mac: [
      ["Microsoft Word", "Microsoft Word", "Word"],
      ["wpsoffice", "WPS Office", "WPS"],
      ["Pages", "Pages", "Pages"],
    ],
  },
  notes: {
    win: [
      ["notepad.exe", "Notepad", "Notepad"],
      ["notepad++.exe", "Notepad++", "Notepad++"],
      ["wordpad.exe", "WordPad", "WordPad"],
      ["onenote.exe", "OneNote", "OneNote"],
      ["onenoteim.exe", "OneNote", "OneNote"],
      ["microsoft.notes.exe", "Sticky Notes", "Sticky Notes"],
      ["Obsidian.exe", "Obsidian", "Obsidian"],
      ["Notion.exe", "Notion", "Notion"],
    ],
    mac: [
      ["Notes", "Notes", "Notes"],
      ["TextEdit", "TextEdit", "TextEdit"],
      ["Microsoft OneNote", "OneNote", "OneNote"],
      ["Obsidian", "Obsidian", "Obsidian"],
      ["Notion", "Notion", "Notion"],
    ],
  },
  pdf: {
    win: [
      ["Acrobat.exe", "Adobe Acrobat", "Acrobat"],
      ["AcroRd32.exe", "Adobe Acrobat Reader", "Acrobat Reader"],
      ["FoxitPDFReader.exe", "Foxit PDF Reader", "Foxit"],
      ["FoxitReader.exe", "Foxit Reader", "Foxit"],
      ["FoxitPDFEditor.exe", "Foxit PDF Editor", "Foxit"],
      ["SumatraPDF.exe", "SumatraPDF", "SumatraPDF"],
      ["PDFXEdit.exe", "PDF-XChange Editor", "PDF-XChange"],
      ["PDFXCview.exe", "PDF-XChange Viewer", "PDF-XChange"],
    ],
    mac: [
      ["Preview", "Preview", "Preview"],
      ["PDF Expert", "PDF Expert", "PDF Expert"],
      ["AdobeAcrobat", "Adobe Acrobat", "Acrobat"],
      ["AdobeReader", "Adobe Acrobat Reader", "Acrobat Reader"],
    ],
  },
};

function blocklistFor(rules) {
  const os = IS_WIN ? "win" : IS_MAC ? "mac" : null;
  const list = new Map();
  if (!os) return list;
  for (const [rule, lists] of Object.entries(BLOCKLISTS)) {
    if (!rules[rule]) continue;
    for (const [name, label, short] of lists[os]) {
      list.set(name.toLowerCase(), { name, label, short });
    }
  }
  return list;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? "" : String(stdout));
    });
  });
}

// "chrome.exe","1234","Console","1","123,456 K" → chrome.exe
function parseTasklist(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// /Applications/Safari.app/Contents/MacOS/Safari → safari
function parsePs(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const comm = line.trim();
    if (comm) names.add(path.posix.basename(comm).toLowerCase());
  }
  return names;
}

async function runningProcesses() {
  if (IS_WIN) return parseTasklist(await run("tasklist", ["/fo", "csv", "/nh"]));
  if (IS_MAC) return parsePs(await run("ps", ["-axo", "comm="]));
  return new Set();
}

function kill(name) {
  if (IS_WIN) return run("taskkill", ["/F", "/T", "/IM", name]);
  if (IS_MAC) return run("killall", ["-9", name]);
  return Promise.resolve("");
}

// Finds and closes every running blocked app. Returns the apps it closed.
async function sweep(rules) {
  const blocked = blocklistFor(rules);
  if (blocked.size === 0) return [];
  const running = await runningProcesses();
  const found = [...blocked.entries()].filter(([key]) => running.has(key)).map(([, app]) => app);
  await Promise.all(found.map((app) => kill(app.name)));
  return found;
}

// Sweeps every second. onClosed(closed, fresh) receives every app closed in a
// sweep, plus the ones not already closed within the cooldown (a relaunching
// or slow-to-die app shouldn't earn a strike every second).
function createMonitor({ rules, intervalMs = 1000, cooldownMs = 3000, onClosed }) {
  let timer = null;
  let busy = false;
  const lastClosedAt = new Map();

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const closed = await sweep(rules);
      const now = Date.now();
      const fresh = closed.filter((app) => now - (lastClosedAt.get(app.name) || 0) > cooldownMs);
      for (const app of closed) lastClosedAt.set(app.name, now);
      if (closed.length && timer) onClosed(closed, fresh);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { BLOCKLISTS, blocklistFor, parseTasklist, parsePs, sweep, createMonitor };
