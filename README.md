# PUP ExamGuard

Secure exam mode for Google Forms, built for the Polytechnic University of the Philippines.

Students take a Google Form inside a locked, full-screen ExamGuard window. While the exam is open, ExamGuard:

- closes other browsers, AI apps, Word, notes apps and PDF readers
- blocks every website except the form
- counts strikes
- auto-submits the form when time runs out or the strike limit is reached
- logs every event to the computer and, optionally, to a Google Sheet

It is an Electron desktop app for Windows (macOS works too).

---

## Contents

1. [Install](#install)
2. [Run](#run)
3. [Teacher flow](#teacher-flow)
4. [Student flow](#student-flow)
5. [Proctor exit](#proctor-exit)
6. [Google Sheet activity log](#google-sheet-activity-log)
7. [Copying the exam file to lab PCs](#copying-the-exam-file-to-lab-pcs)
8. [Building the portable .exe](#building-the-portable-exe)
9. [Testing checklist](#testing-checklist)
10. [Limitations](#limitations)
11. [Where things are stored](#where-things-are-stored)
12. [Project layout](#project-layout)

---

## Install

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
```

## Run

```bash
npm start      # the real thing: kiosk, always-on-top, can't be closed during an exam
npm run dev    # for development: same app, but not kiosk/always-on-top and the window can close
```

`--dev` mode still closes blocked apps for real. It is ignored in the packaged `.exe`.

> **Running from VS Code's terminal?** VS Code sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. If the app doesn't open, clear the variable first:
> PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE` · Git Bash: `unset ELECTRON_RUN_AS_NODE`

## Teacher flow

1. Open ExamGuard. It always opens on **Student Check-in**.
2. Click **Faculty setup** (bottom right).
   - If an exam is already set up on this computer, you'll be asked for **that exam's exit password** first.
3. Fill in the setup form:
   - **Exam title**
   - **Google Form link.** Either the student link (`…/viewform`, `forms.gle/…`) or the editor link (`…/edit`), which ExamGuard converts to `/viewform` automatically.
   - **Duration** in minutes.
   - **Exit password.** The proctor uses this to end an exam early. It's also needed to open Faculty setup again. Only a salted scrypt hash is stored.
   - **Google Sheet log link** (optional). This is the Apps Script web app URL; see [below](#google-sheet-activity-log).
   - **Blocked During Exam** toggles and **Strikes before auto-submit** (1–10).
     - *Other web pages* turns on the website allowlist and closes other browsers.
     - *Leaving the exam window* makes Alt+Tab and clicking another window count as a strike.
4. Click **Generate Exam Key**. The exam is saved to `exam.json` on this computer and the key (e.g. `PUP-3X7K-92`) appears. Share the key with your students.
5. Click **Export Exam File** to save `<exam title>.examguard.json`, then copy it to the other lab PCs.
6. **Preview as Student** returns to the check-in screen.

Generating again always creates a **new key**. Leave the password field blank to keep the current password.

## Student flow

1. Enter your full name, student number, section and the **exam key**, tick the agreement, and click **Start Exam**.
2. Before the exam starts, ExamGuard closes any blocked apps that are already open. **These don't count as strikes.**
3. The exam opens in locked mode:
   - Full screen (kiosk), always on top at the "screen-saver" level, and the window can't be closed.
   - The clipboard is cleared, and the display won't go to sleep.
   - The Google Form loads in a private, in-memory browser session, so no Google login is saved on the PC.
   - Blocked keys: F5, F11, F12, and Ctrl/Cmd with C, V, X, P, S, R, W, N, T, L, O, U, plus the devtools shortcuts.
4. **Strikes.** One strike is added per check (ExamGuard checks every second) when a blocked app is found. It's closed immediately, and the same app won't earn another strike for 3 seconds.
   - If "Leaving the exam window" is on, switching away is a strike too. ExamGuard pulls the window back immediately and skips the strike if an app was just closed within about 2.5 seconds, so opening Word doesn't count twice.
   - Blocked websites and pop-ups are logged but **don't** count as strikes.
5. The exam ends when:
   - **The student submits the form.** ExamGuard sees Google's confirmation page (URL contains `formResponse` and the page has no answer fields) and shows the summary.
   - **Time runs out or the strike limit is reached.** ExamGuard clicks the form's **Submit** / **Isumite** button. The summary then says whether Google confirmed the submission. This can fail on a multi-page form when the student isn't on the last page, or when a required question is unanswered.
6. The summary screen shows the activity log. **Exit ExamGuard** closes the app with no password, because the exam is over.

If ExamGuard is force-closed or the PC restarts mid-exam, the next launch resumes the same exam: same timer and strikes, and the restart is logged. The Google Form itself reloads empty.

## Proctor exit

To end an exam early (an emergency, a wrong exam, a student who needs to leave), press **Ctrl+Shift+Alt+E** on the exam screen and enter the exit password.

- The exam ends without submitting the form and the PC unlocks.
- The summary says the proctor ended it.
- Wrong passwords are logged.

## Google Sheet activity log

Every event is always written to a CSV file on the PC (see [Where things are stored](#where-things-are-stored)). To collect events from every lab PC in one Google Sheet:

1. Create a Google Sheet, e.g. "ExamGuard – COMP 012 Midterm".
2. Open **Extensions → Apps Script**. Delete the sample code and paste in everything from [`google-apps-script/Code.gs`](google-apps-script/Code.gs). Save.
3. Click **Deploy → New deployment**, choose type **Web app**, and set:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**

   Then click **Deploy** and authorize when asked.
4. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.
5. To check it works, open the URL in a browser. You should see `{"ok":true,"service":"PUP ExamGuard activity log"}`.
6. In ExamGuard's Faculty setup, paste it into **Google Sheet log link**, then generate the key and export the exam file as usual.

Events then appear as rows in the **Activity Log** sheet, which is created automatically. Columns:

- Event ID
- Timestamp
- Exam Key
- Exam Title
- Student Name
- Student Number
- Section
- Event
- Detail
- Strikes
- Computer

Event types:

- `exam_started`
- `closed_before_start`
- `app_closed`
- `window_left`
- `navigation_blocked`
- `popup_blocked`
- `auto_submit_attempt`
- `auto_submit_ok` / `auto_submit_failed`
- `proctor_exit` / `proctor_exit_failed`
- `resumed_after_restart`
- `exam_ended`

How uploads are handled:

- If the network is down, events wait in a queue (`upload-queue.json`) and are retried with backoff (5 seconds, growing to 5 minutes), even across restarts. The summary screen shows how many are still uploading.
- The script uses `LockService`, so many PCs can write at once, and it ignores repeat uploads of the same event ID.
- Text a student types that starts with `=`, `+`, `-` or `@` is stored as text, never as a formula.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## Copying the exam file to lab PCs

Either way, each PC ends up with the same `exam.json`.

**Option A: through the app** (recommended)

1. On your PC: Faculty setup → **Export Exam File**, then copy `<exam title>.examguard.json` to a USB drive or shared folder.
2. On each lab PC: open ExamGuard → **Faculty setup** → **Import Exam File** and pick the file.
   - If that PC already has an exam, you'll need the old exam's exit password to open Faculty setup.

**Option B: copy the file directly**

Copy the exported file to the lab PC as:

- Windows: `%APPDATA%\PUP ExamGuard\exam.json`
- macOS: `~/Library/Application Support/PUP ExamGuard/exam.json`

This is handy for scripting many PCs at once.

The exam file contains the exit password **hash**, not the password itself. Treat it like an answer key anyway: anyone with the file can see the form link and the exam key.

## Building the portable .exe

```bash
npm run dist
```

This creates `dist/PUP-ExamGuard-1.0.0-portable.exe`, a single file that runs without installing. Copy it to each lab PC.

- The build isn't code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**, or sign the exe with your school's certificate.
- The portable exe still stores its data in `%APPDATA%\PUP ExamGuard`.

## Testing checklist

Use `npm run dev` on your own PC, then `npm start` or the `.exe` on a spare lab PC.

**Faculty setup**
- [ ] With no exam yet, Faculty setup opens without a password.
- [ ] An `/edit` form link is saved as `/viewform`.
- [ ] A non-Google link and a non-`/exec` Sheet link are rejected.
- [ ] Generate Exam Key shows a `PUP-XXXX-00` key.
- [ ] Export writes `<title>.examguard.json`, and Import of that file on another PC works.
- [ ] With an exam set up, Faculty setup asks for the exit password and rejects a wrong one.

**Check-in**
- [ ] A wrong exam key is rejected. The key is not case-sensitive.
- [ ] Notepad, if open, closes when Start Exam is clicked and is logged *without* a strike.

**Locked mode** (use `npm start` or the .exe)
- [ ] Full screen with no taskbar, and stays on top.
- [ ] Alt+F4 and closing from the taskbar do nothing.
- [ ] F5, Ctrl+R, Ctrl+C, Ctrl+V, Ctrl+P and F12 do nothing.

**Exam**
- [ ] The form loads between the top bar and the status bar.
- [ ] Clicking a link to another site (or the Google Forms logo) is blocked and the status bar says so, with no strike.
- [ ] Opening Notepad or Word closes it within about 1 second and shows "Strike 1 of N".
- [ ] Alt+Tab to another window brings ExamGuard back and adds a strike (when "Leaving the exam window" is on). Opening Word adds only **one** strike, not two.
- [ ] Reaching the strike limit clicks Submit and the summary says whether it worked.
- [ ] With a 1-minute exam, time-up clicks Submit and the summary says so.
- [ ] Submitting the form normally goes to the summary.
- [ ] Ctrl+Shift+Alt+E rejects a wrong password and ends the exam with the right one.
- [ ] Ending ExamGuard in Task Manager mid-exam, then reopening it, resumes the exam with the same timer and strikes.

**After the exam**
- [ ] A Google sign-in form (one that collects emails) can sign in, and the next student's session isn't still signed in.
- [ ] The summary's Exit ExamGuard closes the app without a password.
- [ ] `%APPDATA%\PUP ExamGuard\logs\` has the student's CSV.
- [ ] With a Sheet link: rows appear in the Activity Log sheet. Unplug the network mid-exam, and the rows still arrive after reconnecting.

## Limitations

ExamGuard makes cheating on the exam PC harder. It cannot make it impossible:

- **Phones, smartwatches and second devices** are invisible to ExamGuard. Proctors still need to watch the room.
- **A second monitor** stays usable. ExamGuard covers only one screen, and someone else could use the other one, or the student could glance at it. Unplug extra monitors on lab PCs.
- **Alt+Tab, the Windows key, Ctrl+Alt+Del and Win+L can't be fully blocked** without native keyboard hooks or Windows Assigned Access. ExamGuard pulls itself back to the front and (if enabled) gives a strike, but a quick glance at another window is possible.
- **Only the apps on the blocklist are closed**, matched by process name. A renamed program, a portable app with a different name, or a browser not on the list won't be caught. Remote-desktop and screen-sharing tools aren't blocked.
- **Google may block sign-in** inside embedded browsers ("This browser or app may not be secure"), especially for accounts with extra security checks. ExamGuard uses a normal Chrome user agent, but Google can still refuse. If that happens, turn off "Restrict to users in your organization" / "Collect email addresses (verified)" on the form, or ask students to type their email as a question.
- **Auto-submit can't fix an incomplete form.** If a required question is blank or the student isn't on the last page of a multi-page form, Google won't accept the submission. The summary says so, and the event is logged.
- **After a restart, the form reloads empty** because the login session is kept in memory only. The timer and strikes are kept.
- **The activity log on the PC is not tamper-proof.** Someone with admin rights after the exam could edit the CSV. Use the Google Sheet log for a copy the student can't change.
- **macOS hasn't been tested.** The app checks use `ps` and `killall` and need no extra permissions, but test kiosk mode and app closing on your Macs before relying on them.

## Where things are stored

All data stays in the user-data folder: `%APPDATA%\PUP ExamGuard` on Windows, `~/Library/Application Support/PUP ExamGuard` on macOS.

| File | What it is |
| --- | --- |
| `exam.json` | The current exam config, including the password hash |
| `session.json` | The exam in progress, for crash recovery. Deleted when the student exits |
| `logs/<examKey>_<studentNo>.csv` | Activity log per student (opens in Excel) |
| `upload-queue.json` | Events waiting to be sent to the Google Sheet |

## Project layout

```
index.html  teacher.html  exam.html  submitted.html   screens (match the Figma file)
css/styles.css                                        shared styles + bundled fonts
assets/                                               PUP logo, campus banner, icon, fonts (SIL OFL)
js/main.js             main process: window, locked mode, strikes, IPC
js/storage.js          exam.json / session.json, password hashing, export/import
js/form-view.js        Google Form WebContentsView, allowlist, submit detection
js/process-monitor.js  blocked-app lists, tasklist/taskkill (ps/killall on macOS)
js/activity-log.js     CSV log + Google Sheet upload queue
js/preload.js          safe bridge between screens and main process
js/store.js            shared helpers for the screens
js/checkin.js  js/teacher.js  js/exam.js  js/submitted.js   screen scripts
google-apps-script/Code.gs   Google Sheet receiver
```
