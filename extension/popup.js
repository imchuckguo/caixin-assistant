const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
async function save(patch) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, ...patch } });
}
async function render() {
  const {
    settings: s = {},
    inquiryLog = [],
    watches = [],
  } = await chrome.storage.local.get(["settings", "inquiryLog", "watches"]);
  for (const k of ["qqCopy", "hideAds", "autoTabs"])
    $("#" + k).checked = s[k] !== false;
  $("#personalQQ").value = s.personalQQ || "copy";
  $("#darkMode").value = s.darkMode || "off";
  $("#watchMinutes").value = String(s.watchMinutes || 120);
  $("#logCount").textContent = inquiryLog.length;
  $("#watchCount").textContent = watches.length;
  document
    .querySelectorAll("[data-src]")
    .forEach(
      (el) =>
        (el.checked =
          s.sources?.[el.dataset.src] === undefined
            ? !["mouser", "digikey", "taobao", "ti"].includes(el.dataset.src)
            : s.sources[el.dataset.src]),
    );
  const t = await send({ type: "teamState" });
  $("#teamState").textContent = t.connected
    ? `${t.name} · ${t.paused ? "同步已暂停" : "已连接"} · ${t.queued} 条待处理`
    : "未连接 · 数据保存在本机";
}
for (const k of ["qqCopy", "hideAds", "autoTabs"])
  $("#" + k).onchange = (e) => save({ [k]: e.target.checked });
for (const k of ["personalQQ", "darkMode"])
  $("#" + k).onchange = (e) => save({ [k]: e.target.value });
$("#watchMinutes").onchange = (e) =>
  save({ watchMinutes: Number(e.target.value) });
document.querySelectorAll("[data-src]").forEach(
  (el) =>
    (el.onchange = async () => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      save({ sources: { ...settings.sources, [el.dataset.src]: el.checked } });
    }),
);
for (const [id, page] of [
  ["recordsBtn", "records.html"],
  ["watchPage", "watch.html"],
  ["teamBtn", "team.html"],
  ["accountsBtn", "accounts.html"],
])
  $("#" + id).onclick = () =>
    chrome.tabs.create({ url: chrome.runtime.getURL(page) });
$("#openExt").onclick = () =>
  chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
$("#checkNow").onclick = async () => {
  const b = $("#checkNow");
  b.disabled = true;
  $("#status").textContent = "正在检查已监控的商品";
  try {
    const r = await send({ type: "checkWatchesNow" });
    $("#status").textContent = r?.ok
      ? "检查已完成，请查看库存监控页"
      : "检查未完成，请重试";
  } finally {
    b.disabled = false;
  }
};
(async () => {
  const v = chrome.runtime.getManifest().version;
  $("#ver").textContent = "v" + v;
  try {
    const r = await send({ type: "ping" });
    if (!r || r.build !== v) {
      $("#staleText").textContent = r
        ? "后台版本与界面不一致，请重新加载扩展"
        : "后台未响应，请重新加载扩展";
      $("#stale").classList.remove("hidden");
    }
  } catch {
    $("#staleText").textContent = "后台未响应，请重新加载扩展";
    $("#stale").classList.remove("hidden");
  }
  await render();
})().catch(() => {
  $("#status").textContent = "无法读取状态，请重新打开面板";
});
