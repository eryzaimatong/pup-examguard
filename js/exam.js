// 03 · Exam Window (Locked) and 04 · Violation Warning.
//
// The main process does the locking: it shows the Google Form in a native
// view over #form-slot, closes blocked apps, counts strikes and runs the
// clock. This page draws the header, timer, warnings and proctor prompt.
(async function () {
  const EG = window.ExamGuard;
  const LOW_TIME_SECONDS = 5 * 60;
  const NOTICE_MS = 5000;

  const $ = (id) => document.getElementById(id);
  const state = await EG.getState();
  let session = state.session;
  if (!session) return;
  const exam = session.exam;
  let submitting = false;
  let noticeTimer = null;
  const closers = { violation: null, proctor: null };

  // ---- Static header ----
  $("exam-title").textContent = exam.title;
  $("exam-student").textContent =
    `${session.student.name} · ${session.student.studentNo} · ${session.student.section}`;
  document.title = `${exam.title} · PUP ExamGuard`;

  // ---- Form view placement ----
  const slot = $("form-slot");
  function sendBounds() {
    const r = slot.getBoundingClientRect();
    EG.setFormBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  new ResizeObserver(sendBounds).observe(slot);
  window.addEventListener("resize", sendBounds);

  function anyModalOpen() {
    return !$("violation").hidden || !$("proctor").hidden;
  }

  function showForm() {
    if (!anyModalOpen()) EG.setFormVisible(true);
  }

  // ---- Strikes / status bar ----
  function statusText() {
    const n = session.strikes;
    const sync = exam.logUrl ? "Activity log syncing to professor" : "Activity log saved on this computer";
    return `Monitoring active  ·  ${n} violation${n === 1 ? "" : "s"}  ·  ${sync}`;
  }

  function renderStrikes() {
    const wrap = $("strikes");
    wrap.querySelectorAll(".strike").forEach((dot) => dot.remove());
    for (let i = 0; i < exam.maxStrikes; i++) {
      const dot = document.createElement("span");
      dot.className = i < session.strikes ? "strike strike--hit" : "strike";
      wrap.appendChild(dot);
    }
    wrap.setAttribute("aria-label", `Strikes: ${session.strikes} of ${exam.maxStrikes}`);
    if (!noticeTimer && !submitting) $("monitor-text").textContent = statusText();
  }

  // ---- Timer (the main process enforces the deadline) ----
  function tick() {
    const left = (session.endsAt - Date.now()) / 1000;
    $("timer-value").textContent = EG.formatClock(left);
    $("timer").classList.toggle("timer--low", left <= LOW_TIME_SECONDS);
  }

  // ---- Violation warning ----
  function showWarning({ title, body }) {
    const left = exam.maxStrikes - session.strikes;
    $("violation-title").textContent = title;
    $("violation-body").textContent = body;
    $("meter-label").textContent = `Strike ${session.strikes} of ${exam.maxStrikes}`;
    $("meter-note").textContent =
      `${left} more strike${left === 1 ? "" : "s"} and your exam submits automatically.`;

    const bars = $("meter-bars");
    bars.replaceChildren();
    for (let i = 0; i < exam.maxStrikes; i++) {
      const bar = document.createElement("span");
      if (i < session.strikes) bar.className = "is-hit";
      bars.appendChild(bar);
    }
    if (!closers.violation) closers.violation = EG.openModal($("violation"), $("return-btn"));
  }

  $("return-btn").addEventListener("click", () => {
    if (closers.violation) closers.violation();
    closers.violation = null;
    showForm();
  });

  // ---- Proctor exit (Ctrl+Shift+Alt+E) ----
  const proctorForm = $("proctor-form");
  const proctorError = $("proctor-error");

  function closeProctor() {
    if (closers.proctor) closers.proctor();
    closers.proctor = null;
    showForm();
  }

  EG.onProctorPrompt(() => {
    if (closers.proctor || submitting) return;
    proctorForm.reset();
    proctorError.hidden = true;
    proctorForm.elements.password.removeAttribute("aria-invalid");
    closers.proctor = EG.openModal($("proctor"), proctorForm.elements.password);
  });

  $("proctor-cancel").addEventListener("click", closeProctor);
  $("proctor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProctor();
  });

  proctorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = proctorForm.elements.password;
    const result = await EG.proctorExit(input.value);
    if (result.ok) return; // main process shows the summary
    proctorError.textContent = result.error;
    proctorError.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.select();
  });

  // ---- Events from the main process ----
  EG.onSession((next) => {
    if (!next) return;
    session = next;
    renderStrikes();
  });

  EG.onViolation(showWarning);

  EG.onNotice((text) => {
    if (submitting) return;
    $("monitor-text").textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      $("monitor-text").textContent = statusText();
    }, NOTICE_MS);
  });

  EG.onSubmitting((reason) => {
    submitting = true;
    clearTimeout(noticeTimer);
    for (const close of Object.values(closers)) if (close) close();
    $("monitor-text").textContent =
      reason === "time" ? "Time is up  ·  Submitting your exam…" : "Strike limit reached  ·  Submitting your exam…";
  });

  renderStrikes();
  tick();
  setInterval(tick, 1000);
  sendBounds();
})();
