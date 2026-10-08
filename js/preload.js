// Preload · the only bridge between the screens and the main process.
const { contextBridge, ipcRenderer } = require("electron");

function listen(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("examguard", {
  getState: () => ipcRenderer.invoke("state:get"),

  // Student
  startExam: (student) => ipcRenderer.invoke("exam:start", student),
  setFormBounds: (rect) => ipcRenderer.send("form:bounds", rect),
  setFormVisible: (visible) => ipcRenderer.send("form:visible", visible),
  proctorExit: (password) => ipcRenderer.invoke("exam:proctorExit", password),
  exitApp: () => ipcRenderer.invoke("app:exit"),
  goToCheckin: () => ipcRenderer.invoke("nav:checkin"),

  // Faculty
  openFaculty: (password) => ipcRenderer.invoke("faculty:open", password),
  saveExam: (input) => ipcRenderer.invoke("faculty:save", input),
  exportExam: () => ipcRenderer.invoke("faculty:export"),
  importExam: () => ipcRenderer.invoke("faculty:import"),

  // Events from the main process
  onSession: listen("session"),
  onViolation: listen("violation"),
  onProctorPrompt: listen("proctor-prompt"),
  onNotice: listen("notice"),
  onSubmitting: listen("submitting"),
  onUploads: listen("uploads"),
});
