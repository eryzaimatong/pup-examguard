// Shared helpers for the ExamGuard screens. Exam configs and sessions now live
// in the main process (userData/exam.json, userData/session.json); this file
// exposes that bridge (window.examguard from js/preload.js) plus formatting.

(function () {

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatTimeOfDay(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Shows a modal and keeps Tab focus inside it. Returns a close function.
function openModal(overlay, focusEl) {
  overlay.hidden = false;
  (focusEl || overlay.querySelector("input, button")).focus();
  function trap(event) {
    if (event.key !== "Tab") return;
    const items = [...overlay.querySelectorAll("input, button")].filter((el) => !el.disabled);
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  overlay.addEventListener("keydown", trap);
  return () => {
    overlay.removeEventListener("keydown", trap);
    overlay.hidden = true;
  };
}

window.ExamGuard = {
  ...window.examguard,
  formatClock,
  formatTimeOfDay,
  openModal,
};
})();
