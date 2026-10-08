// Preload · the Google Form view. Turns off passkeys / security keys
// (WebAuthn): on Windows, Google sign-in would open a "Windows Security"
// dialog over the exam, which ExamGuard counts as leaving the exam window.
// Without WebAuthn, Google falls back to the normal password sign-in.
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    const creds = navigator.credentials;
    if (creds) {
      const deny = () => Promise.reject(new DOMException("Passkeys are turned off during the exam.", "NotAllowedError"));
      const get = creds.get.bind(creds);
      creds.get = (options) => (options && options.publicKey ? deny() : get(options));
      creds.create = (options) => (options && options.publicKey ? deny() : Promise.resolve(null));
    }
    // Pages check for this before offering passkeys at all.
    try {
      delete window.PublicKeyCredential;
    } catch {
      // not configurable; the credentials overrides above still apply
    }
  },
});
