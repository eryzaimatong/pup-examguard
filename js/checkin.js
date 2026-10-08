// 02 · Student Check-in — validates the exam key and starts a locked session.
(async function () {
  const EG = window.ExamGuard;

  const form = document.getElementById("checkin-form");
  const startBtn = document.getElementById("start-btn");
  const error = document.getElementById("checkin-error");
  const fields = ["name", "studentNo", "section", "examKey"];
  const $ = (id) => document.getElementById(id);

  let busy = false;
  const state = await EG.getState();
  const exam = state.exam;

  // ---- Rules and exam status from userData/exam.json ----
  if (exam) {
    $("rule-strikes").textContent = exam.maxStrikes;
    $("exam-status").textContent = `Exam on this computer: ${exam.title}`;

    const apps = [];
    if (exam.rules.word) apps.push("Word");
    if (exam.rules.notes) apps.push("Notes");
    if (exam.rules.pdf) apps.push("PDF readers");
    if (exam.rules.ai) apps.push("AI apps");
    if (exam.rules.web) apps.push("other browsers");
    const list = apps.length > 1 ? `${apps.slice(0, -1).join(", ")}, and ${apps[apps.length - 1]}` : apps[0];
    $("rule-apps").textContent = list
      ? `${list.charAt(0).toUpperCase()}${list.slice(1)} will close automatically.`
      : "Your activity is monitored while the exam is open.";

    if (exam.rules.web) $("rule-web").textContent = "ChatGPT and all websites except the exam are blocked.";
    else if (exam.rules.ai) $("rule-web").textContent = "ChatGPT and other AI websites are blocked.";
    else $("rule-web").hidden = true;
  } else {
    $("exam-status").textContent = "No exam is set up on this computer yet.";
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function update() {
    const filled = fields.every((name) => form.elements[name].value.trim() !== "");
    startBtn.disabled = busy || !(filled && form.elements.agree.checked);
  }

  form.addEventListener("input", () => {
    showError("");
    form.elements.examKey.removeAttribute("aria-invalid");
    update();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (startBtn.disabled) return;

    const data = new FormData(form);
    busy = true;
    update();
    startBtn.textContent = "Starting…";
    const result = await EG.startExam({
      name: data.get("name"),
      studentNo: data.get("studentNo"),
      section: data.get("section"),
      examKey: data.get("examKey"),
    });
    if (result.ok) return; // main process loads the exam screen

    busy = false;
    startBtn.innerHTML = "Start Exam&nbsp;&nbsp;→";
    update();
    if (result.field) {
      form.elements[result.field].setAttribute("aria-invalid", "true");
      form.elements[result.field].focus();
    }
    showError(result.error);
  });

  // ---- Faculty setup ----
  const modal = $("faculty-modal");
  const facultyForm = $("faculty-form");
  const facultyError = $("faculty-error");
  let closeModal = null;

  $("faculty-link").addEventListener("click", async () => {
    const result = await EG.openFaculty("");
    if (result.ok) return;
    if (result.needsPassword) {
      facultyForm.reset();
      facultyError.hidden = true;
      closeModal = EG.openModal(modal, facultyForm.elements.password);
    } else {
      showError(result.error);
    }
  });

  $("faculty-cancel").addEventListener("click", () => closeModal && closeModal());
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeModal) closeModal();
  });

  facultyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = facultyForm.elements.password;
    const result = await EG.openFaculty(input.value);
    if (result.ok) return;
    facultyError.textContent = result.error || "Incorrect exit password.";
    facultyError.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.select();
  });

  update();
})();
