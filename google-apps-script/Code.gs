/**
 * PUP ExamGuard — activity log receiver.
 *
 * Bind this script to a Google Sheet (Extensions → Apps Script), then deploy
 * it as a web app (Execute as: Me · Who has access: Anyone). Paste the /exec
 * URL into ExamGuard's "Google Sheet log link" field. See README.md.
 *
 * Each ExamGuard event arrives as one JSON POST and becomes one row in the
 * "Activity Log" sheet. ExamGuard retries failed uploads, so rows are
 * de-duplicated by event ID.
 */

var SHEET_NAME = 'Activity Log';
var COLUMNS = [
  ['id', 'Event ID'],
  ['timestamp', 'Timestamp'],
  ['examKey', 'Exam Key'],
  ['examTitle', 'Exam Title'],
  ['studentName', 'Student Name'],
  ['studentNo', 'Student Number'],
  ['section', 'Section'],
  ['event', 'Event'],
  ['detail', 'Detail'],
  ['strikes', 'Strikes'],
  ['computer', 'Computer'],
];
var SEEN_TTL_SECONDS = 6 * 60 * 60;

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
    var data = JSON.parse(e.postData.contents);
    var events = Array.isArray(data) ? data : [data];
    var cache = CacheService.getScriptCache();
    var sheet = getSheet_();
    var rows = [];

    events.forEach(function (event) {
      if (!event || !event.id) return;
      var seenKey = 'seen:' + event.id;
      if (cache.get(seenKey)) return; // retry of an event we already stored
      rows.push(COLUMNS.map(function (col) {
        var value = event[col[0]];
        if (col[0] === 'timestamp' && value) return new Date(value);
        return clean_(value);
      }));
      cache.put(seenKey, '1', SEEN_TTL_SECONDS);
    });

    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COLUMNS.length).setValues(rows);
    }
    return json_({ ok: true, added: rows.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Lets you open the /exec URL in a browser to check the deployment works.
function doGet() {
  return json_({ ok: true, service: 'PUP ExamGuard activity log' });
}

function getSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS.map(function (col) { return col[1]; }));
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

// Stop student-typed text like "=IMPORTXML(...)" from running as a formula.
function clean_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  var text = String(value).slice(0, 2000);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
