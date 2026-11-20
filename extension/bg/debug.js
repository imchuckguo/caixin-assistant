const BG_BUILD = chrome.runtime.getManifest().version;
async function dlog(_cat, _msg, _data, level = "info") {
  const { settings = {}, debugLog = [] } = await chrome.storage.local.get([
    "settings",
    "debugLog",
  ]);
  if (!settings.diagnostics) return;
  await chrome.storage.local.set({
    debugLog: [
      {
        t: Date.now(),
        module: "extension",
        code: ["error", "warn"].includes(level)
          ? "OPERATION_FAILED"
          : "OPERATION",
        level,
      },
      ...debugLog,
    ].slice(0, 200),
  });
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!isTrusted(sender)) return false;
  if (msg?.type === "ping") {
    reply({ build: BG_BUILD, version: BG_BUILD });
    return false;
  }
  if (msg?.type === "clearDebugLog") {
    chrome.storage.local.remove("debugLog").then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
self.addEventListener("error", () => dlog("", "", undefined, "error"));
self.addEventListener("unhandledrejection", () =>
  dlog("", "", undefined, "error"),
);
