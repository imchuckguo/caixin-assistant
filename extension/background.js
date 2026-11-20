/* 采芯助手 — source-checked local operations. */
const isTrusted = (s) =>
  s?.id === chrome.runtime.id &&
  String(s.url || "").startsWith(chrome.runtime.getURL(""));
const senderHost = (s) => {
  try {
    return new URL(s.url || s.tab?.url);
  } catch {
    return null;
  }
};
const onHosts = (s, hosts) => {
  const u = senderHost(s);
  return (
    s?.id === chrome.runtime.id &&
    u &&
    /^https?:$/.test(u.protocol) &&
    hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h))
  );
};
const isSite = (s) => onHosts(s, ["ic.net.cn", "bom.ai", "hqew.com"]);
const isSource = (s) =>
  onHosts(s, [
    "szlcsc.com",
    "ickey.cn",
    "bomman.com",
    "mouser.cn",
    "digikey.cn",
    "taobao.com",
    "qidian.qq.com",
  ]);
const allowedPage = (s) => isTrusted(s) || isSite(s) || isSource(s);
const SAFE_SETTINGS = [
  "hideAds",
  "qqCopy",
  "autoTabs",
  "darkMode",
  "personalQQ",
  "sources",
  "watchMinutes",
];
const DEFAULT_SETTINGS = {
  hideAds: true,
  qqCopy: true,
  autoTabs: true,
  darkMode: "off",
  personalQQ: "copy",
};
const protectStorage = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});
importScripts(
  "build.js",
  "bg/debug.js",
  "lib/record.js",
  "lib/backup.js",
  "lib/team-crypto.js",
  "bg/sources.js",
  "bg/notebook.js",
  "bg/team.js",
);
async function publicState() {
  const s = await chrome.storage.local.get([
    "settings",
    "localQQ",
    "watches",
    "inquiryTemplate",
  ]);
  return {
    settings: Object.fromEntries(
      SAFE_SETTINGS.filter((k) => k in (s.settings || {})).map((k) => [
        k,
        s.settings[k],
      ]),
    ),
    localQQ: s.localQQ || {},
    watches: (s.watches || []).map((w) => ({
      id: w.id,
      kind: w.kind,
      pn: w.pn,
      site: w.site,
      ident: w.ident ? { key: w.ident.key } : undefined,
    })),
    inquiryTemplate: s.inquiryTemplate || "",
  };
}
function backgroundReply(reply, fn) {
  Promise.resolve()
    .then(fn)
    .then(reply, () => reply({ ok: false, error: "操作失败，请重试" }));
  return true;
}
const chatTabs = new Map();
async function recordQQ(qq, type) {
  if (
    !/^[1-9]\d{4,11}$/.test(String(qq)) ||
    !["enterprise", "personal"].includes(type)
  )
    return;
  const { localQQ = {} } = await chrome.storage.local.get("localQQ");
  await chrome.storage.local.set({ localQQ: { ...localQQ, [qq]: type } });
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !allowedPage(sender)) return false;
  if (msg.type === "pageState") return backgroundReply(reply, publicState);
  if (msg.type === "pageSettings")
    return backgroundReply(reply, async () => {
      const p = msg.value || {},
        { settings = {} } = await chrome.storage.local.get("settings");
      if (Object.keys(p).some((k) => !SAFE_SETTINGS.includes(k)))
        return { ok: false, error: "不允许修改此设置" };
      const clean = {};
      for (const [k, v] of Object.entries(p)) {
        if (
          ["hideAds", "qqCopy", "autoTabs"].includes(k) &&
          typeof v === "boolean"
        )
          clean[k] = v;
        if (k === "darkMode" && ["off", "on", "auto"].includes(v)) clean[k] = v;
        if (k === "personalQQ" && ["copy", "open"].includes(v)) clean[k] = v;
        if (k === "watchMinutes" && [30, 60, 120, 240, 720, 1440].includes(v))
          clean[k] = v;
        if (k === "sources" && v && typeof v === "object")
          clean[k] = Object.fromEntries(
            Object.entries(v).filter(
              ([s, b]) => Object.hasOwn(SOURCES, s) && typeof b === "boolean",
            ),
          );
      }
      await chrome.storage.local.set({ settings: { ...settings, ...clean } });
      return { ok: true };
    });
  if (msg.type === "pageTemplate")
    return backgroundReply(reply, async () => {
      await chrome.storage.local.set({
        inquiryTemplate: String(msg.value || "").slice(0, 2000),
      });
      return { ok: true };
    });
  if (msg.type === "openChat" && /^[1-9]\d{4,11}$/.test(String(msg.qq)))
    return backgroundReply(reply, async () => {
      const w = await chrome.windows.create({
        url: `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(msg.qq)}&site=qq&menu=yes`,
        type: "popup",
        width: 460,
        height: 360,
      });
      const id = w.tabs?.[0]?.id;
      if (id) chatTabs.set(id, String(msg.qq));
      return { tabId: id };
    });
  if (msg.type === "markQQ" && (isSite(sender) || isTrusted(sender)))
    return backgroundReply(reply, () =>
      recordQQ(msg.qq, msg.qqType).then(() => ({ ok: true })),
    );
  if (msg.type === "chatOutcome" && isSource(sender))
    return backgroundReply(reply, async () => {
      const qq = chatTabs.get(sender.tab?.id) || "";
      if (qq) await recordQQ(qq, msg.outcome);
      return { qq };
    });
  return false;
});
function menus() {
  chrome.contextMenus.removeAll(() => {
    for (const [t, label] of [
      ["personal", "私人号"],
      ["enterprise", "企业号"],
    ])
      chrome.contextMenus.create({
        id: "cx-" + t,
        title: "采芯助手：标记为" + label,
        contexts: ["all"],
        documentUrlPatterns: [
          "*://*.ic.net.cn/*",
          "*://*.bom.ai/*",
          "*://*.hqew.com/*",
        ],
      });
  });
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !["cx-personal", "cx-enterprise"].includes(info.menuItemId))
    return;
  const r = await chrome.tabs
    .sendMessage(tab.id, { type: "getContextTarget" })
    .catch(() => null);
  if (r?.qq) await recordQQ(r.qq, info.menuItemId.slice(3));
});
chrome.runtime.onInstalled.addListener(async () => {
  await protectStorage;
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await chrome.storage.local.remove([
    "team",
    "teamLog",
    "teamDirty",
    "clientId",
    "data",
    "debugLog",
  ]);
  await chrome.alarms.clear("sync");
  await chrome.alarms.clear("teamSync");
  menus();
});
chrome.runtime.onStartup.addListener(() => menus());
chrome.storage.onChanged.addListener(async (c, area) => {
  if (area !== "local" || !["settings", "localQQ", "watches"].some((k) => c[k]))
    return;
  const tabs = await chrome.tabs.query({
    url: [
      "*://*.ic.net.cn/*",
      "*://*.bom.ai/*",
      "*://*.hqew.com/*",
      "https://*.szlcsc.com/*",
      "https://*.ickey.cn/*",
      "https://*.bomman.com/*",
      "https://*.mouser.cn/*",
      "https://*.digikey.cn/*",
    ],
  });
  for (const tab of tabs)
    chrome.tabs.sendMessage(tab.id, { type: "pageChanged" }).catch(() => {});
});
