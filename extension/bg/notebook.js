// 采芯助手 · 询价记录本 + 库存变化提醒（全部保存在本机，不上传）

const LOG_KEY = "inquiryLog";
const LOG_MAX = 5000;
const WATCH_KEY = "watches";
const WATCH_EVENTS_KEY = "watchEvents";
const WATCH_MAX = 50;
const WATCH_MINUTES = 120;

// ---------- 询价记录 ----------
// 同一天 + 同一家公司 + 同一个型号只保留一行：再次点 QQ 只更新时间和自动记录的字段，不动用户填写的内容
let logQueue = Promise.resolve();
function appendLog(entry) {
  logQueue = logQueue.then(async () => {
    const { [LOG_KEY]: raw = [] } = await chrome.storage.local.get(LOG_KEY);
    const list = raw.map(ICMRecord.migrate);
    const fresh = ICMRecord.create(entry || {});
    const key = ICMRecord.dedupeKey(fresh);
    const i =
      fresh.company && fresh.pn
        ? list.findIndex((r) => ICMRecord.dedupeKey(r) === key)
        : -1;
    let item;
    if (i >= 0) {
      item = list.splice(i, 1)[0];
      const auto = ICMRecord.pickAuto(entry || {});
      for (const [k, v] of Object.entries(auto)) if (v) item[k] = v;
      if (!item.qty && fresh.qty) item.qty = fresh.qty;
      item.time = fresh.time;
      dlog(
        "记录本",
        `更新询价记录（同一天同公司同型号）：${item.pn} · ${item.company}`,
        undefined,
        "ok",
      );
    } else {
      item = fresh;
      dlog(
        "记录本",
        `新增询价记录：${item.pn} · ${item.company || "-"} · ${item.brand || "-"} · ${item.batch || "-"}`,
        undefined,
        "ok",
      );
    }
    list.unshift(item);
    if (list.length > LOG_MAX) list.length = LOG_MAX;
    await chrome.storage.local.set({ [LOG_KEY]: list });
    await teamMarkDirty([item.id], i < 0);
    return item;
  });
  return logQueue;
}

// 记录本页面的修改（排队写入，避免和新记录同时写导致丢数据）
function patchLog(fn) {
  logQueue = logQueue.then(async () => {
    const { [LOG_KEY]: raw = [] } = await chrome.storage.local.get(LOG_KEY);
    const list = fn(raw.map(ICMRecord.migrate));
    await chrome.storage.local.set({ [LOG_KEY]: list });
    return { ok: true };
  });
  return logQueue;
}
const EDITABLE = [
  "company",
  "qq",
  "pn",
  "brand",
  "batch",
  "qty",
  "price",
  "tax",
  "goods",
  "lead",
  "valid",
  "validAt",
  "note",
];
function updateRecord(id, patch) {
  return patchLog((list) => {
    const r = list.find((x) => x.id === id);
    if (r)
      for (const k of EDITABLE)
        if (patch && k in patch) {
          if (k === "valid") r[k] = patch[k] === true;
          else if (k === "validAt") r[k] = Number(patch[k]) || 0;
          else r[k] = String(patch[k] ?? "").slice(0, 2000);
        }
    return list;
  }).then(async (r) => {
    await teamMarkDirty([id]);
    return r;
  });
}

// ---------- 库存价格监控 ----------
// 两种监控：
// 1. 型号（kind 缺省 / 'pn'）：在 IC交易网 / 正能量网 / 华强电子网点，查货源对比里开着的网站，每个网站记库存合计和最低价
// 2. 单个商品（kind 'item'）：在立创、云汉、圣禾堂、贸泽、得捷的某一条商品旁边点，只盯这一条（立创按编号，云汉 / 贸泽 / 得捷按商品链接，圣禾堂按型号 + 品牌 + 封装 + 批次）
// 下次检查有变化就弹出系统通知，写明是哪个网站、从多少变成多少
const WATCH_SITES = ["szlcsc", "ickey", "bomman", "digikey", "mouser"];
const SITE_LABEL = {
  szlcsc: "立创商城",
  ickey: "云汉芯城",
  bomman: "圣禾堂",
  digikey: "得捷",
  mouser: "贸泽",
};
const SRC_OFF_DEFAULT = ["mouser", "digikey", "taobao", "ti"];
const WATCH_INTERVALS = [30, 60, 120, 240, 720, 1440]; // 分钟，可在弹窗里选
const fmtN = (n) => Number(n || 0).toLocaleString("zh-CN");
const nrm = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9一-龥]/g, "");
const wid = (w) =>
  w.id ||
  "pn|" +
    String(w.pn || "")
      .trim()
      .toUpperCase();
const isItem = (w) => w.kind === "item";

async function watchSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const off = settings.sources || {};
  const sites = WATCH_SITES.filter((k) =>
    off[k] === undefined ? !SRC_OFF_DEFAULT.includes(k) : off[k] !== false,
  );
  const minutes = WATCH_INTERVALS.includes(Number(settings.watchMinutes))
    ? Number(settings.watchMinutes)
    : WATCH_MINUTES;
  return { sites, minutes };
}

// 一次检查里，同一个网站同一个型号只查一次（几条商品监控共用）
function lookupShared(cache, site, pn) {
  const k = site + "|" + String(pn).toUpperCase();
  if (!cache.has(k))
    cache.set(
      k,
      lookup(site, pn, { force: true }).catch((e) => ({
        ok: false,
        error: e.message,
      })),
    );
  return cache.get(k);
}

// 型号监控：一个型号在各网站的当前情况：{ szlcsc: { stock, count, price, url }, ... }；查询失败的网站不记（避免误报）
async function snapshot(pn, sites, cache = new Map()) {
  const snap = {};
  for (const site of sites) {
    const r = await lookupShared(cache, site, pn);
    if (r && r.ok)
      snap[site] = {
        stock: Number(r.stock) || 0,
        count: Number(r.count) || 0,
        price: Number(r.minPrice) || 0,
        url: r.url || "",
      };
    else
      dlog(
        "库存提醒",
        `${pn} · ${SITE_LABEL[site]}：${(r && r.error) || "查询失败"}，这次不比较`,
        undefined,
        "warn",
      );
  }
  return snap;
}
async function sitesOf(w) {
  if (Array.isArray(w.sites) && w.sites.length)
    return w.sites.filter((k) => WATCH_SITES.includes(k));
  return (await watchSettings()).sites;
}

// ---------- 单个商品：在查询结果里找到用户点的那一条 ----------
const normUrl = (u) =>
  String(u || "")
    .split("#")[0]
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
const isSearchUrl = (u) =>
  /[?&](k|keyword|q|searchWord|keywords)=/i.test(u || "");
const brandEq = (a, b) => {
  a = nrm(a);
  b = nrm(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};
function pickItem(items, ident) {
  if (!items || !items.length || !ident) return null;
  if (ident.code) {
    // 立创的“合作库存”里同一个商品也用同一个编号；在立创现货页面点的，要的是立创自己的那条（立创现货 / 立创订货）
    const hits = items.filter(
      (it) => it.code && nrm(it.code) === nrm(ident.code),
    );
    if (ident.channel)
      return hits.find((it) => it.channel === ident.channel) || hits[0] || null;
    return hits.find((it) => it.channel !== "合作库存") || hits[0] || null;
  }
  if (ident.url && !isSearchUrl(ident.url)) {
    const f = items.find(
      (it) =>
        it.url &&
        !isSearchUrl(it.url) &&
        normUrl(it.url) === normUrl(ident.url),
    );
    if (f) return f;
  }
  let best = null;
  let bs = -1;
  for (const it of items) {
    if (nrm(it.model) !== nrm(ident.model)) continue;
    let s = 0;
    if (ident.brand) s += brandEq(it.brand, ident.brand) ? 4 : -4;
    if (ident.pkg) s += nrm(it.pkg) === nrm(ident.pkg) ? 3 : -3;
    if (ident.batch) s += nrm(it.batch) === nrm(ident.batch) ? 2 : -2;
    if (ident.channel) s += it.channel === ident.channel ? 2 : -2;
    if (ident.stock && Number(it.stock) === Number(ident.stock)) s += 1;
    if (s > bs) {
      bs = s;
      best = it;
    }
  }
  return bs >= 0 ? best : null;
}
const snapItem = (it) => ({
  stock: Number(it.stock) || 0,
  price: Number(it.price) || 0,
  ladder: (it.ladder || [])
    .slice(0, 10)
    .map((x) => [Number(x[0]) || 0, Number(x[1]) || 0]),
  url: it.url || "",
});
const infoOf = (it) => {
  const o = {};
  for (const k of [
    "model",
    "brand",
    "pkg",
    "category",
    "code",
    "channel",
    "img",
    "url",
    "batch",
    "delivery",
    "priceNote",
    "pack",
    "moq",
    "step",
    "datasheet",
  ])
    if (it[k]) o[k] = it[k];
  return o;
};
// 型号监控 / 单个商品共用的比较：库存变多 / 变少 / 到货 / 卖完；价格涨 / 降（单个商品比较第一档价格，并看其它档）
const fmtP = (p) =>
  "¥" +
  (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4)).replace(
    /\.?0+$/,
    "",
  );
function diffParts(before, now, priceWord) {
  const parts = [];
  if (now.missing && !before.missing) {
    parts.push("这一条在网站上找不到了（可能卖完或下架）");
    return parts;
  }
  if (before.missing && !now.missing)
    parts.push(`重新上架，库存 ${fmtN(now.stock)}`);
  else {
    const d = now.stock - before.stock;
    if (before.stock > 0 && now.stock === 0)
      parts.push(`卖完了（原库存 ${fmtN(before.stock)}）`);
    else if (before.stock === 0 && now.stock > 0)
      parts.push(`到货了，库存 ${fmtN(now.stock)}`);
    else if (d > 0)
      parts.push(
        `库存增加 ${fmtN(d)}：${fmtN(before.stock)} → ${fmtN(now.stock)}`,
      );
    else if (d < 0)
      parts.push(
        `库存减少 ${fmtN(-d)}：${fmtN(before.stock)} → ${fmtN(now.stock)}`,
      );
  }
  if (
    before.price > 0 &&
    now.price > 0 &&
    Math.abs(now.price - before.price) / before.price >= 0.001
  ) {
    const pct = (((now.price - before.price) / before.price) * 100)
      .toFixed(1)
      .replace("-", "");
    parts.push(
      `${priceWord}${now.price < before.price ? "降" : "涨"} ${pct}%：${fmtP(before.price)} → ${fmtP(now.price)}`,
    );
  } else if (
    Array.isArray(before.ladder) &&
    Array.isArray(now.ladder) &&
    before.ladder.length &&
    now.ladder.length
  ) {
    const changed = now.ladder.filter(([q, p]) => {
      const o = before.ladder.find((x) => x[0] === q);
      return o && o[1] > 0 && p > 0 && Math.abs(p - o[1]) / o[1] >= 0.001;
    });
    if (changed.length) parts.push(`价格梯度有 ${changed.length} 档变化`);
  }
  return parts;
}
function diffSite(site, before, now) {
  if (!before || typeof before !== "object" || !now) return null;
  const parts = diffParts(before, now, "最低价");
  if (!parts.length) return null;
  return {
    site,
    text: `${SITE_LABEL[site] || site}：${parts.join("；")}`,
    url: now.url,
  };
}
function diffItem(w, before, now) {
  if (!before || typeof before !== "object" || !now) return null;
  const parts = diffParts(before, now, "价格");
  if (!parts.length) return null;
  const tag = (w.info && (w.info.code || w.info.channel)) || "";
  return {
    site: w.site,
    text: `${SITE_LABEL[w.site] || w.site}${tag ? `（${tag}）` : ""}：${parts.join("；")}`,
    url: now.url || (w.info && w.info.url) || "",
  };
}

function notifyWatch(pn, changes, test) {
  const nid =
    "watch_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  chrome.storage.session.set({ [nid]: changes[0].url || "" }).catch(() => {});
  chrome.notifications.create(nid, {
    type: "basic",
    iconUrl: "icons/128.png",
    title: `${test ? "【模拟】" : ""}库存/价格变化：${pn}`,
    message: changes.map((c) => c.text).join("\n"),
    contextMessage: test
      ? "采芯助手 · 这是模拟提醒，不是真实变化"
      : "采芯助手 · 点击打开变化的网站",
    priority: 1,
  });
}

// 弹窗里的“模拟一次提醒”：用一个示例型号弹出一条和真实提醒一样格式的通知
function testNotify() {
  const pn = "ICM-42688-P";
  notifyWatch(
    pn,
    [
      {
        text: "立创商城：库存减少 2,936：12,936 → 10,000；最低价降 4.6%：¥132.18 → ¥126",
        url: "https://so.szlcsc.com/global.html?k=" + pn,
      },
      { text: "云汉芯城：到货了，库存 813", url: "" },
      { text: "贸泽：最低价涨 2.1%：¥40.19 → ¥41.03", url: "" },
    ],
    true,
  );
  dlog("库存提醒", "弹出了一条模拟提醒");
  return { ok: true };
}

// 监控列表的所有写入排队执行：检查要几分钟，期间取消 / 新增不会被检查结果覆盖回来
let watchQueue = Promise.resolve();
function editWatches(fn) {
  const run = watchQueue.then(async () => {
    const { [WATCH_KEY]: list = [] } =
      await chrome.storage.local.get(WATCH_KEY);
    const out = await fn(list);
    await chrome.storage.local.set({ [WATCH_KEY]: list });
    return out;
  });
  watchQueue = run.catch(() => {});
  return run;
}
const samePn = (a, b) =>
  String(a || "")
    .trim()
    .toUpperCase() ===
  String(b || "")
    .trim()
    .toUpperCase();

// 单个商品当前情况：找到 → { stock, price, ladder, url }；网站查询成功但没有这一条 → { missing: true, stock: 0 }；查询失败 → null
async function itemNow(w, cache) {
  const r = await lookupShared(cache, w.site, w.pn);
  if (!r || !r.ok) {
    dlog(
      "库存提醒",
      `${w.pn} · ${SITE_LABEL[w.site]}：${(r && r.error) || "查询失败"}，这次不比较`,
      undefined,
      "warn",
    );
    return { snap: null };
  }
  const it = pickItem([...(r.items || []), ...(r.others || [])], w.ident);
  if (!it)
    return {
      snap: {
        missing: true,
        stock: 0,
        price: 0,
        ladder: [],
        url: (w.info && w.info.url) || r.url,
      },
    };
  return { snap: snapItem(it), info: infoOf(it) };
}

let watchRunning = null;
async function checkWatches() {
  if (watchRunning) return watchRunning; // 同一时间只跑一次
  watchRunning = (async () => {
    const { [WATCH_KEY]: list = [] } =
      await chrome.storage.local.get(WATCH_KEY);
    if (!list.length) {
      dlog("库存提醒", "没有监控的型号，跳过检查");
      return;
    }
    dlog("库存提醒", `开始检查 ${list.length} 条监控`);
    await chrome.storage.local.set({
      watchRunning: { start: Date.now(), total: list.length, done: 0 },
    });
    const cache = new Map();
    let done = 0;
    for (const item of list) {
      const id = wid(item);
      // 每条查之前再看一眼：期间被取消的不查
      const { [WATCH_KEY]: curList = [] } =
        await chrome.storage.local.get(WATCH_KEY);
      const cur = curList.find((x) => wid(x) === id);
      if (!cur) continue;
      let snap = null;
      let info = null;
      if (isItem(cur)) ({ snap, info } = await itemNow(cur, cache));
      else snap = await snapshot(cur.pn, await sitesOf(cur), cache);
      await editWatches((l) => {
        const w = l.find((x) => wid(x) === id);
        if (!w) return; // 查的时候被取消了
        let changes = [];
        if (isItem(w)) {
          if (!snap) {
            w.lastError = Date.now();
            return;
          }
          const last = w.last || null;
          const c = last ? diffItem(w, last, snap) : null;
          if (c) changes = [c];
          if (!w.first) w.first = last || snap;
          w.prev = last;
          w.last = snap;
          if (info) w.info = { ...(w.info || {}), ...info };
        } else {
          const last = w.last && typeof w.last === "object" ? w.last : {};
          changes = Object.keys(snap)
            .map((k) => diffSite(k, last[k], snap[k]))
            .filter(Boolean);
          const next = {};
          for (const k of WATCH_SITES)
            if (snap[k]) next[k] = snap[k];
            else if (last[k] && typeof last[k] === "object") next[k] = last[k];
          if (!w.first) w.first = last; // 老版本的监控没有记“刚加入时”，用上一次的当作起点
          w.prev = last;
          w.last = next;
        }
        w.lastError = 0;
        w.prevCheck = w.lastCheck || 0;
        w.lastCheck = Date.now();
        dlog(
          "库存提醒",
          `${w.pn}${isItem(w) ? ` · ${SITE_LABEL[w.site]}单条` : ""}：${changes.length ? changes.map((c) => c.text).join("；") : "无变化"}`,
          undefined,
          changes.length ? "warn" : "info",
        );
        if (changes.length) {
          w.lastChange = Date.now();
          notifyWatch(w.pn, changes);
          return {
            id,
            pn: w.pn,
            time: Date.now(),
            changes: changes.map((c) => c.text),
            sites: changes.map((c) => c.site),
            url: changes[0].url,
          };
        }
      }).then(async (ev) => {
        if (!ev) return;
        const { [WATCH_EVENTS_KEY]: events = [] } =
          await chrome.storage.local.get(WATCH_EVENTS_KEY);
        events.unshift(ev);
        if (events.length > 200) events.length = 200;
        await chrome.storage.local.set({ [WATCH_EVENTS_KEY]: events });
      });
      await chrome.storage.local.set({
        watchRunning: {
          start: Date.now(),
          total: list.length,
          done: ++done,
          pn: item.pn,
        },
      });
    }
    await chrome.storage.local.set({ watchLastRun: Date.now() });
  })().finally(() => {
    watchRunning = null;
    chrome.storage.local.remove("watchRunning");
  });
  return watchRunning;
}

// 型号监控（三个网站的货源对比条）。sites：要查的网站（不传 = 按当前“货源网站”勾选）
async function addWatch(pn, sites, from) {
  pn = String(pn || "").trim();
  if (!pn) return { ok: false, error: "型号为空" };
  const id = "pn|" + pn.toUpperCase();
  const { minutes, sites: enabled } = await watchSettings();
  const want = (Array.isArray(sites) && sites.length ? sites : enabled).filter(
    (k) => WATCH_SITES.includes(k),
  );
  if (!want.length)
    return {
      ok: false,
      error:
        "没有勾选货源网站（立创、云汉、圣禾堂、得捷、贸泽），请先在“ 货源网站”里勾选",
    };
  const { [WATCH_KEY]: list0 = [] } = await chrome.storage.local.get(WATCH_KEY);
  const old0 = list0.find((w) => wid(w) === id);
  const have = old0 ? await sitesOf(old0) : [];
  const add = want.filter((k) => !have.includes(k));
  if (old0 && !add.length)
    return {
      ok: true,
      exists: true,
      minutes,
      sites: have.map((k) => SITE_LABEL[k]),
    };
  if (!old0 && list0.length >= WATCH_MAX)
    return { ok: false, error: `最多监控 ${WATCH_MAX} 条` };
  const snap = await snapshot(pn, add); // 记下当前值，之后有变化才提醒
  return editWatches((list) => {
    let w = list.find((x) => wid(x) === id);
    if (!w) {
      if (list.length >= WATCH_MAX)
        return { ok: false, error: `最多监控 ${WATCH_MAX} 条` };
      w = {
        id,
        kind: "pn",
        pn,
        addedAt: Date.now(),
        from: from || "",
        sites: [],
        first: {},
        last: {},
        lastCheck: Date.now(),
      };
      list.push(w);
    }
    w.id = id;
    if (!Array.isArray(w.sites) || !w.sites.length) w.sites = have.slice();
    for (const k of add) if (!w.sites.includes(k)) w.sites.push(k);
    w.first = { ...(w.first || {}), ...snap };
    w.last = { ...(w.last || {}), ...snap };
    dlog(
      "库存提醒",
      `监控 ${pn}：${add.map((k) => `${SITE_LABEL[k]} ${snap[k] ? fmtN(snap[k].stock) : "暂未取到"}`).join("，")}`,
      undefined,
      "ok",
    );
    return {
      ok: true,
      added: add.map((k) => SITE_LABEL[k]),
      minutes,
      sites: w.sites.map((k) => SITE_LABEL[k]),
    };
  });
}

// 单个商品监控（立创、云汉、圣禾堂、贸泽、得捷页面上每条商品旁的按钮）
// ident：页面上读到的这一条 { key, model, code, url, brand, pkg, batch, channel, stock, price, img }
async function addItemWatch(site, pn, ident) {
  pn = String(pn || "").trim();
  if (!pn || !WATCH_SITES.includes(site) || !ident || !ident.key)
    return { ok: false, error: "没有读到这条商品的信息" };
  const id = `item|${site}|${ident.key}`;
  const { minutes } = await watchSettings();
  const { [WATCH_KEY]: list0 = [] } = await chrome.storage.local.get(WATCH_KEY);
  if (list0.some((w) => wid(w) === id))
    return { ok: true, exists: true, minutes };
  if (list0.length >= WATCH_MAX)
    return { ok: false, error: `最多监控 ${WATCH_MAX} 条` };
  const r = await lookup(site, pn, { force: true }).catch((e) => ({
    ok: false,
    error: e.message,
  }));
  const it =
    r && r.ok
      ? pickItem([...(r.items || []), ...(r.others || [])], ident)
      : null;
  // 网站查询没找到这一条时，先用页面上看到的数字当起点
  const snap = it
    ? snapItem(it)
    : {
        stock: Number(ident.stock) || 0,
        price: Number(ident.price) || 0,
        ladder: ident.ladder || [],
        url: ident.url || "",
      };
  const info = it ? infoOf(it) : infoOf(ident);
  return editWatches((list) => {
    if (list.some((w) => wid(w) === id))
      return { ok: true, exists: true, minutes };
    list.push({
      id,
      kind: "item",
      site,
      pn,
      ident,
      info,
      from: site,
      addedAt: Date.now(),
      first: snap,
      last: snap,
      prev: null,
      lastCheck: Date.now(),
    });
    dlog(
      "库存提醒",
      `监控 ${SITE_LABEL[site]}单条 ${pn}${info.code ? `（${info.code}）` : ""}：库存 ${fmtN(snap.stock)}${it ? "" : "（这次查询没找到这一条，先用页面上的数字）"}`,
      undefined,
      "ok",
    );
    return { ok: true, id, minutes, stock: snap.stock, matched: !!it };
  });
}

// 取消监控。id：某一条；pn（老写法）：型号监控。site：型号监控只去掉这一个网站（去掉后没有网站了就整条删掉）
async function removeWatch(msg) {
  const { sites: enabled } = await watchSettings();
  const id =
    msg.id ||
    "pn|" +
      String(msg.pn || "")
        .trim()
        .toUpperCase();
  return editWatches((list) => {
    const i = list.findIndex((w) => wid(w) === id);
    if (i < 0) return { ok: true, removed: true };
    const w = list[i];
    if (msg.site && !isItem(w)) {
      const cur = Array.isArray(w.sites) && w.sites.length ? w.sites : enabled;
      w.sites = cur.filter((k) => k !== msg.site);
      if (w.sites.length) {
        dlog("库存提醒", `${w.pn} 不再查 ${SITE_LABEL[msg.site] || msg.site}`);
        return {
          ok: true,
          removed: false,
          sites: w.sites.map((k) => SITE_LABEL[k]),
        };
      }
    }
    list.splice(i, 1);
    dlog(
      "库存提醒",
      `取消监控 ${w.pn}${isItem(w) ? ` · ${SITE_LABEL[w.site]}单条` : ""}`,
    );
    return { ok: true, removed: true };
  });
}

chrome.notifications.onClicked.addListener(async (nid) => {
  if (!nid.startsWith("watch_")) return;
  const { [nid]: url } = await chrome.storage.session
    .get(nid)
    .catch(() => ({}));
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(nid);
});

// 定时检查：间隔按设置；浏览器关着时不会检查，重新打开浏览器后如果已经超过间隔，1 分钟后补查一次
const WATCH_ON = !(self.ICM_BUILD && self.ICM_BUILD.watch === false);
async function scheduleWatch(catchUp) {
  if (!WATCH_ON) return chrome.alarms.clear("watch");
  const { minutes } = await watchSettings();
  const cur = await chrome.alarms.get("watch");
  if (!cur || cur.periodInMinutes !== minutes)
    chrome.alarms.create("watch", { periodInMinutes: minutes });
  if (catchUp) {
    const { watchLastRun = 0, [WATCH_KEY]: list = [] } =
      await chrome.storage.local.get(["watchLastRun", WATCH_KEY]);
    if (list.length && Date.now() - watchLastRun > minutes * 60e3)
      chrome.alarms.create("watchCatchUp", { delayInMinutes: 1 });
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if ((a.name === "watch" || a.name === "watchCatchUp") && WATCH_ON)
    checkWatches();
});
chrome.runtime.onInstalled.addListener(() => scheduleWatch(false));
chrome.runtime.onStartup.addListener(() => scheduleWatch(true));
chrome.storage.onChanged.addListener((c, area) => {
  if (
    area === "local" &&
    c.settings &&
    (c.settings.oldValue || {}).watchMinutes !==
      (c.settings.newValue || {}).watchMinutes
  )
    scheduleWatch(false);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    logInquiry: () => appendLog(msg.entry),
    updateRecord: () => updateRecord(msg.id, msg.patch),
    deleteRecord: () =>
      patchLog((list) => list.filter((x) => x.id !== msg.id)).then((r) => {
        dlog("记录本", "删除了一条询价记录");
        teamMarkDirty([msg.id]);
        return r;
      }),
    clearRecords: () => {
      let ids = [];
      return patchLog((list) => {
        ids = list.map((x) => x.id);
        return [];
      }).then((r) => {
        teamMarkDirty(ids);
        chrome.storage.local
          .get(null)
          .then((all) =>
            chrome.storage.local.remove(
              Object.keys(all).filter(
                (k) => k === "debugLog" || k.startsWith("src2_"),
              ),
            ),
          );
        return r;
      });
    },
    migrateRecords: () => patchLog((list) => list),
    addWatch: () => addWatch(msg.pn, msg.sites, msg.from),
    addItemWatch: () => addItemWatch(msg.site, msg.pn, msg.ident),
    removeWatch: () => removeWatch(msg),
    openWatch: () =>
      chrome.tabs
        .create({
          url:
            chrome.runtime.getURL("watch.html") +
            (msg.pn ? "?pn=" + encodeURIComponent(msg.pn) : ""),
        })
        .then(() => ({ ok: true })),
    checkWatchesNow: () => checkWatches().then(() => ({ ok: true })),
    watchTest: () => testNotify(),
    watchList: () =>
      chrome.storage.local
        .get(WATCH_KEY)
        .then((r) => ({
          ok: true,
          pns: (r[WATCH_KEY] || []).filter((w) => !isItem(w)).map((w) => w.pn),
        })),
    openLogs: () =>
      chrome.tabs
        .create({ url: chrome.runtime.getURL("logs.html") })
        .then(() => ({ ok: true })),
    openAccounts: () =>
      chrome.tabs
        .create({ url: chrome.runtime.getURL("accounts.html") })
        .then(() => ({ ok: true })),
    openRecords: () =>
      chrome.tabs
        .create({
          url:
            chrome.runtime.getURL("records.html") +
            (msg.pn ? "?pn=" + encodeURIComponent(msg.pn) : ""),
        })
        .then(() => ({ ok: true })),
  };
  const h = handlers[msg?.type];
  if (!h || !allowedPage(sender)) return false;
  const publicTypes = [
    "logInquiry",
    "addWatch",
    "addItemWatch",
    "removeWatch",
    "openWatch",
    "openAccounts",
    "openRecords",
  ];
  if (!isTrusted(sender) && !publicTypes.includes(msg.type)) return false;
  if (msg.type === "logInquiry" && !isSite(sender) && !isTrusted(sender))
    return false;
  Promise.resolve()
    .then(h)
    .then(reply, () => reply({ ok: false, error: "操作未完成" }));
  return true;
});
