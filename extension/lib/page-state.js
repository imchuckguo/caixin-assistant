(function (root) {
  if (root.CxPage) return;
  const listeners = [];
  async function get(keys) {
    const s = await chrome.runtime.sendMessage({ type: "pageState" });
    return Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys])
        .filter((k) => k in (s || {}))
        .map((k) => [k, s[k]]),
    );
  }
  async function set(o) {
    if (o.settings)
      await chrome.runtime.sendMessage({
        type: "pageSettings",
        value: o.settings,
      });
    if ("inquiryTemplate" in o)
      await chrome.runtime.sendMessage({
        type: "pageTemplate",
        value: o.inquiryTemplate,
      });
  }
  function onChanged(fn) {
    listeners.push(fn);
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "pageChanged")
      get(["settings", "localQQ", "watches"]).then((s) => {
        const c = Object.fromEntries(
          Object.entries(s).map(([k, v]) => [k, { newValue: v }]),
        );
        for (const fn of listeners) fn(c, "local");
      });
  });
  root.CxPage = { get, set, onChanged };
})(globalThis);
