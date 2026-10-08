// 05 · Exam Submitted — summary and activity log for the finished session.
(async function () {
  const EG = window.ExamGuard;
  const $ = (id) => document.getElementById(id);

  const state = await EG.getState();
  const session = state.session;
  if (!session || !session.submittedAt) return;
  const exam = session.exam;

  // ---- Lead: how the exam ended, and whether auto-submit worked ----
  const auto = session.autoSubmit || {};
  const autoText = auto.ok
    ? "ExamGuard submitted your answers to Google Forms automatically."
    : auto.restarted
      ? "ExamGuard was restarted after time ran out, so your form could not be submitted automatically. Tell your proctor right away."
      : auto.clicked
        ? "ExamGuard tried to submit your form automatically but Google Forms didn’t confirm it (a required question may be unanswered). Tell your proctor right away."
        : "ExamGuard couldn’t find the form’s Submit button, so your answers were not submitted automatically. Tell your proctor right away.";

  const leads = {
    form: "Your answers were sent to Google Forms. You may now exit locked mode.",
    time: `Time is up. ${autoText}`,
    strikes: `You reached the strike limit. ${autoText}`,
    proctor: "Your proctor ended this exam early. ExamGuard did not submit the form.",
  };
  $("summary-lead").textContent = leads[session.submitReason] || leads.form;
  if (session.submitReason !== "form" && !auto.ok) {
    $("summary-lead").classList.add("form-error");
  }

  // ---- Stats ----
  $("stat-student").textContent = session.student.name;
  $("stat-time").textContent = EG.formatClock((session.submittedAt - session.startedAt) / 1000);

  const violations = $("stat-violations");
  violations.textContent = `${session.strikes} of ${exam.maxStrikes}`;
  violations.classList.toggle("stat__value--danger", session.strikes > 0);

  // ---- Activity log ----
  const body = $("log-body");
  if (session.log.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = "log__empty";
    cell.textContent = "No violations recorded.";
  } else {
    for (const entry of session.log) {
      const row = body.insertRow();
      row.insertCell().textContent = EG.formatTimeOfDay(entry.at);
      row.insertCell().textContent = entry.app;
      const action = row.insertCell();
      action.className = entry.strike ? "log__action" : "log__action log__action--info";
      action.textContent = entry.action;
    }
  }

  // ---- Where the log went ----
  function renderNote(pending) {
    if (!exam.logUrl) {
      $("summary-note").textContent = "This activity log was saved on this computer for your professor.";
    } else if (pending > 0) {
      $("summary-note").textContent =
        `This activity log is being sent to your professor (${pending} event${pending === 1 ? "" : "s"} still uploading — ExamGuard keeps retrying).`;
    } else {
      $("summary-note").textContent = "This activity log was sent to your professor.";
    }
  }
  renderNote(state.uploadsPending);
  EG.onUploads(renderNote);

  $("exit-btn").addEventListener("click", () => EG.exitApp());
})();
