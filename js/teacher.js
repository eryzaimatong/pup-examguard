// 01 · Teacher Setup — builds the exam config (userData/exam.json), issues an
// exam key, and exports/imports the exam file for other lab PCs.
(async function () {
  const EG = window.ExamGuard;
  const MIN_STRIKES = 1;
  const MAX_STRIKES = 10;

  const $ = (id) => document.getElementById(id);
  const form = $("setup-form");
  const urlError = $("form-url-error");
  const logUrlError = $("log-url-error");
  const setupError = $("setup-error");
  const keyBox = $("exam-key");
  const keyValue = $("exam-key-value");
  const exportBtn = $("export-btn");
  const fileStatus = $("file-status");
  const down = $("strikes-down");
  const up = $("strikes-up");
  const strikesOut = $("strikes-value");
  const toggles = document.querySelectorAll("[data-rule]");

  let maxStrikes = 3;
  let hasExam = false;

  function renderStrikes() {
    strikesOut.textContent = maxStrikes;
    down.disabled = maxStrikes <= MIN_STRIKES;
    up.disabled = maxStrikes >= MAX_STRIKES;
  }

  down.addEventListener("click", () => {
    maxStrikes = Math.max(MIN_STRIKES, maxStrikes - 1);
    renderStrikes();
  });
  up.addEventListener("click", () => {
    maxStrikes = Math.min(MAX_STRIKES, maxStrikes + 1);
    renderStrikes();
  });

  // Fills the form from an existing or just-imported exam.
  function showExam(exam) {
    hasExam = Boolean(exam);
    exportBtn.disabled = !exam;
    form.elements.exitPassword.required = !exam;
    $("password-hint").hidden = !exam;
    if (!exam) return;

    form.elements.title.value = exam.title;
    form.elements.formUrl.value = exam.formUrl;
    form.elements.duration.value = exam.durationMinutes;
    form.elements.logUrl.value = exam.logUrl || "";
    form.elements.exitPassword.value = "";
    toggles.forEach((toggle) => {
      toggle.checked = exam.rules[toggle.dataset.rule] !== false;
    });
    maxStrikes = exam.maxStrikes;
    renderStrikes();
    keyValue.textContent = exam.key;
    keyBox.hidden = false;
  }

  function showError(message) {
    setupError.textContent = message || "";
    setupError.hidden = !message;
  }

  function isGoogleFormUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        ((url.hostname === "docs.google.com" && url.pathname.startsWith("/forms/")) || url.hostname === "forms.gle")
      );
    } catch {
      return false;
    }
  }

  function isLogUrl(value) {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "script.google.com" && /\/exec$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function markInvalid(name, invalid) {
    form.elements[name].setAttribute("aria-invalid", String(invalid));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");

    const data = new FormData(form);
    const formUrl = String(data.get("formUrl")).trim();
    const logUrl = String(data.get("logUrl")).trim();
    const urlOk = isGoogleFormUrl(formUrl);
    const logOk = isLogUrl(logUrl);
    markInvalid("formUrl", !urlOk);
    markInvalid("logUrl", !logOk);
    urlError.hidden = urlOk;
    logUrlError.hidden = logOk;

    let valid = urlOk && logOk;
    for (const name of ["title", "duration", "exitPassword"]) {
      const input = form.elements[name];
      const optional = name === "exitPassword" && hasExam;
      const ok = optional || (input.checkValidity() && input.value.trim() !== "");
      markInvalid(name, !ok);
      valid = valid && ok;
    }
    if (!valid) {
      form.querySelector('[aria-invalid="true"]').focus();
      return;
    }

    const rules = {};
    toggles.forEach((toggle) => {
      rules[toggle.dataset.rule] = toggle.checked;
    });

    const result = await EG.saveExam({
      title: data.get("title"),
      formUrl,
      durationMinutes: Number(data.get("duration")),
      exitPassword: String(data.get("exitPassword")),
      logUrl,
      rules,
      maxStrikes,
    });
    if (!result.ok) {
      if (result.field) {
        markInvalid(result.field, true);
        form.elements[result.field].focus();
      }
      showError(result.error);
      return;
    }
    showExam(result.exam);
    fileStatus.textContent = "Saved on this computer. Export the exam file to set up other lab PCs.";
  });

  exportBtn.addEventListener("click", async () => {
    const result = await EG.exportExam();
    if (result.ok) fileStatus.textContent = `Exported to ${result.filePath}`;
    else if (!result.canceled) showError(result.error);
  });

  $("import-btn").addEventListener("click", async () => {
    const result = await EG.importExam();
    if (result.ok) {
      showExam(result.exam);
      showError("");
      fileStatus.textContent = `Imported “${result.exam.title}”. This computer is ready for students.`;
    } else if (!result.canceled) {
      showError(result.error);
    }
  });

  $("preview-btn").addEventListener("click", () => EG.goToCheckin());

  const state = await EG.getState();
  renderStrikes();
  showExam(state.exam);
})();
