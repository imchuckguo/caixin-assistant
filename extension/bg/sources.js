// 采芯助手 · 货源查询：立创商城、云汉芯城、圣禾堂在线
// 立创：直接请求搜索页，读取页面内嵌的数据。
// 云汉 / 圣禾堂：结果由它们自己的脚本加载，插件在后台标签页正常打开搜索页，读取页面显示的结果后关闭。
// 不调用任何未公开接口，不破解签名或字体混淆。

const SOURCES = {
  szlcsc: {
    name: "立创商城",
    url: (pn) =>
      `https://so.szlcsc.com/global.html?k=${encodeURIComponent(pn)}`,
  },
  ickey: {
    name: "云汉芯城",
    url: (pn) => `https://search.ickey.cn/?keyword=${encodeURIComponent(pn)}`,
  },
  bomman: {
    name: "圣禾堂",
    url: (pn) =>
      `https://www.bomman.com/global-search?searchWord=${encodeURIComponent(pn)}&eventType=search`,
  },
  mouser: {
    name: "贸泽",
    url: (pn) => `https://www.mouser.cn/c/?q=${encodeURIComponent(pn)}`,
  },
  digikey: {
    name: "得捷",
    url: (pn) =>
      `https://www.digikey.cn/zh/products/result?keywords=${encodeURIComponent(pn)}`,
  },
  taobao: {
    name: "淘宝",
    url: (pn) => `https://s.taobao.com/search?q=${encodeURIComponent(pn)}`,
  },
  ti: {
    name: "TI 官网",
    linkOnly: true,
    url: (pn) =>
      `https://www.ti.com.cn/sitesearch/zh-cn/docs/universalsearch.tsp?searchTerm=${encodeURIComponent(pn)}`,
  },
};
const CACHE_MS = 3 * 60 * 60 * 1000; // 3 小时内同一型号不重复查询
const TAB_TIMEOUT = 25000;

const norm = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

// 型号必须完全一致（忽略大小写、空格和横杠），网站的模糊匹配、替代型号一律不要
function relevant(items, pn) {
  const q = norm(pn);
  return items.filter((it) => norm(it.model) === q);
}

function summarize(site, pn, items, error) {
  const all = relevant(items || [], pn);
  const rel = all.filter((it) => !it.orderOnly);
  const others = all.filter((it) => it.orderOnly);
  const stock = rel.reduce((a, it) => a + (Number(it.stock) || 0), 0);
  const prices = rel.map((it) => it.price).filter((p) => p > 0);
  return {
    site,
    name: SOURCES[site].name,
    pn,
    url: SOURCES[site].url(pn),
    at: Date.now(),
    ok: !error,
    error: error || "",
    count: rel.length,
    stock,
    minPrice: prices.length ? Math.min(...prices) : 0,
    items: rel.slice(0, 60),
    others: others.slice(0, 20), // 只给单个商品监控用（立创订货）
    direct: rel.some((it) => it.direct),
    datasheet: (rel.find((it) => it.datasheet) || {}).datasheet || "",
  };
}

// ---------- 立创：立创现货（页面内嵌数据）+ 合作库存（立创页面自己请求的数据） ----------
// 立创现货：只算真正有现货的（hasStockNow = yes）；没现货的那条其实是原厂期货，立创页面把它放在“合作库存”里显示
function parseSzlcsc(htmlText) {
  const m = htmlText.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  const d = JSON.parse(m[1]);
  const list = (((d.props || {}).pageProps || {}).soData || {}).searchResult;
  const recs = (list && list.productRecordList) || [];
  // 没有现货（hasStockNow 不是 yes，页面上显示“订货 3-5 个工作日 / 库存 xxx”）的那条标成 orderOnly：
  // 货源对比的库存合计不算它，但单个商品监控能找到它
  return recs
    .map((r) => r.productVO || r)
    .filter(Boolean)
    .map((v) => ({
      channel: v.hasStockNow === "yes" ? "立创现货" : "立创订货",
      rank: 0,
      orderOnly: v.hasStockNow !== "yes",
      model: v.productModel,
      brand: v.productGradePlateName || "",
      pkg: v.encapsulationModel || "",
      category: v.productType || "",
      code: v.productCode || "",
      img: v.breviaryImageUrl || "",
      // 商品页网址用的是 productId（不是编号 C 后面的数字）
      url: v.productId ? `https://item.szlcsc.com/${v.productId}.html` : "",
      stock:
        Number(
          v.validStockNumber != null ? v.validStockNumber : v.stockNumber,
        ) || 0,
      price:
        v.productPriceList && v.productPriceList[0]
          ? Number(v.productPriceList[0].productPrice) || 0
          : 0,
      ladder: (v.productPriceList || []).map((x) => [
        x.spNumber || x.startPurchasedNumber,
        Number(x.productPrice),
      ]),
      priceNote: "含税",
      moq: v.minBuyNumber || "",
      pack: v.productMinEncapsulationNumber
        ? `${v.productMinEncapsulationNumber}个/${v.productMinEncapsulationUnit || "包"}`
        : "",
      delivery: "现货最快4小时发货",
      datasheet: findPdfIn(v),
    }));
}
function findPdfIn(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return "";
  for (const k in o) {
    const v = o[k];
    if (typeof v === "string" && /^https?:\/\/.+\.pdf(\?|$)/i.test(v)) return v;
    const f = typeof v === "object" ? findPdfIn(v, depth + 1) : "";
    if (f) return f;
  }
  return "";
}

// 合作库存：和立创搜索页里“合作库存”一栏是同一份数据，原样显示（价格为立创页面上的含税价）
async function fetchSzlcscCoop(pn) {
  const q = encodeURIComponent(pn);
  const res = await fetch(
    `https://overseas.szlcsc.com/overseas/global/search?keyword=${q}&pageNumber=1&noShowSelf=false&from=${q}`,
    { credentials: "include" },
  );
  const j = await res.json();
  if (!j || !Array.isArray(j.result)) throw new Error("合作库存读取失败");
  const out = [];
  for (const grp of j.result) {
    for (const p of grp.products || []) {
      const tiers = (p.tieredPrices || []).filter((t) => t && t.price != null);
      out.push({
        channel: "合作库存",
        rank: 1,
        model: p.productCodeManufacturer || "",
        brand: p.productGradePlateName || p.brandName || "",
        pkg: p.selfStandard || p.encapsulationModel || "",
        category: p.lcCatalogName || "",
        code: p.productCode || "",
        img: p.selfBreviaryImageUrl || p.breviaryImageUrl || "",
        url: `https://so.szlcsc.com/global.html?k=${q}`,
        stock: Number(p.stockNumber) || 0,
        price: tiers[0] ? Number(tiers[0].price) || 0 : 0,
        ladder: tiers.map((t) => [t.countStart, Number(t.price)]),
        priceNote: "含税",
        moq: p.minBuyNumber || "",
        step: p.incrementalQuantity || "",
        pack: p.productMinEncapsulationNumber
          ? `最小包装 ${p.productMinEncapsulationNumber}${p.unit || "个"}`
          : "",
        batch: p.batchNumber || "",
        delivery: p.deliveryTimeWayDays || "",
        updated: (p.uploadTime || p.updateTime || "").slice(0, 10),
        datasheet: p.dataSheetUrl || "",
      });
    }
  }
  return out;
}

class NeedLogin extends Error {}
async function fetchSzlcsc(pn) {
  const res = await fetch(SOURCES.szlcsc.url(pn), { credentials: "include" });
  if (/passport|login/i.test(res.url))
    throw new NeedLogin(
      "立创要求登录后才能继续查询：请在“网站账号登录状态”里点“去登录”登录立创",
    );
  const text = await res.text();
  if (/用户登录中心/.test(text.slice(0, 3000)))
    throw new NeedLogin(
      "立创要求登录后才能继续查询：请在“网站账号登录状态”里点“去登录”登录立创",
    );
  const items = parseSzlcsc(text);
  if (!items) throw new Error("页面需要验证");
  return items;
}

// ---------- 后台标签页读取 ----------
const pendingTabs = new Map(); // id -> { resolve, tabId, timer }

function viaTab(site, pn) {
  return new Promise(async (resolve) => {
    const id = Math.random().toString(36).slice(2);
    const url = `${SOURCES[site].url(pn)}#cxm-lookup=${id}`;
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      resolve({ error: "无法打开页面" });
      return;
    }
    dlog("货源", `打开后台标签页读取 ${SOURCES[site].name}`, { url });
    const timer = setTimeout(
      () =>
        finish(id, {
          error:
            "超时：页面 25 秒内没有给出结果（网站可能要求登录或验证，可以点“去看看”确认）",
        }),
      TAB_TIMEOUT,
    );
    pendingTabs.set(id, { resolve, tabId: tab.id, timer });
  });
}

function finish(id, result) {
  const p = pendingTabs.get(id);
  if (!p) return;
  pendingTabs.delete(id);
  clearTimeout(p.timer);
  chrome.tabs.remove(p.tabId).catch(() => {});
  dlog(
    "货源",
    result.error
      ? `后台标签页读取失败：${result.error}`
      : `后台标签页读到 ${result.items.length} 条，已关闭标签页`,
    undefined,
    result.error ? "warn" : "info",
  );
  p.resolve(result);
}

// ---------- 对外 ----------
// 同一个型号、同一个货源网站正在查询时，其他页面（IC交易网 / 正能量网 / 华强电子网同时打开）直接等这一次的结果，
// 不再重复打开后台标签页；查完的结果缓存 3 小时，三个网站共用
const inflight = new Map();
function lookup(site, pn, opts = {}) {
  const key = `${site}|${norm(pn)}`;
  if (inflight.has(key)) {
    dlog(
      "货源",
      `${(SOURCES[site] || {}).name || site} ${pn}：另一个页面正在查询，直接共用结果`,
    );
    return inflight.get(key);
  }
  const p = lookupOnce(site, pn, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function lookupOnce(site, pn, { force = false } = {}) {
  pn = String(pn || "").trim();
  if (!pn || !SOURCES[site]) return null;
  if (SOURCES[site].linkOnly)
    return summarize(
      site,
      pn,
      [],
      "该网站的库存需要登录后由接口加载，请点链接去官网查看",
    );
  const key = `src2_${site}_${norm(pn)}`; // 0.10.1 改了数据格式（分区、型号完全一致），旧缓存不再使用
  if (!force) {
    const c = (await chrome.storage.local.get(key))[key];
    if (c && Date.now() - c.at < CACHE_MS) {
      dlog(
        "货源",
        `${SOURCES[site].name} ${pn}：使用 ${Math.round((Date.now() - c.at) / 60000)} 分钟前的缓存`,
      );
      return c;
    }
  }
  let summary;
  dlog("货源", `开始查询 ${SOURCES[site].name}：${pn}`);
  try {
    if (site === "szlcsc") {
      let items;
      try {
        items = await fetchSzlcsc(pn);
      } catch (e) {
        if (e instanceof NeedLogin) throw e;
        dlog(
          "货源",
          `立创直接请求失败（${e.message}），改用后台标签页`,
          undefined,
          "warn",
        );
        const r = await viaTab(site, pn);
        if (r.error) throw new Error(r.error);
        items = r.items;
      }
      // 合作库存读不到不影响立创现货
      try {
        const coop = await fetchSzlcscCoop(pn);
        dlog("货源", `立创合作库存：${coop.length} 条（型号完全一致的才显示）`);
        items = [...items, ...coop];
      } catch (e) {
        dlog("货源", `立创合作库存读取失败：${e.message}`, undefined, "warn");
      }
      summary = summarize(site, pn, items);
    } else {
      const r = await viaTab(site, pn);
      summary = r.error
        ? summarize(site, pn, [], r.error)
        : summarize(site, pn, r.items);
    }
  } catch (e) {
    summary = summarize(site, pn, [], String(e.message || e));
  }
  if (summary.ok) await chrome.storage.local.set({ [key]: summary });
  dlog(
    "货源",
    summary.ok
      ? `${SOURCES[site].name} ${pn}：${summary.count} 条货源，库存 ${summary.stock}${summary.minPrice ? "，¥" + summary.minPrice + " 起" : ""}`
      : `${SOURCES[site].name} ${pn} 查询失败：${summary.error}`,
    summary.ok ? summary.items.slice(0, 3) : undefined,
    summary.ok ? "ok" : "error",
  );
  return summary;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !allowedPage(sender)) return false;
  if (msg.type === "lookup") {
    lookup(msg.site, msg.pn, { force: msg.force }).then(reply);
    return true;
  }
  if (msg.type === "lookupWho") {
    // 后台标签页里的读取脚本问：我是不是插件打开的查询标签页
    const tabId = sender.tab && sender.tab.id;
    const hit = [...pendingTabs.entries()].find(([, p]) => p.tabId === tabId);
    reply({ id: hit ? hit[0] : "" });
    return false;
  }
  if (msg.type === "lookupResult") {
    // 来自后台标签页里的读取脚本
    if (pendingTabs.get(msg.id)?.tabId !== sender.tab?.id) return false;
    finish(
      msg.id,
      msg.error ? { error: msg.error } : { items: msg.items || [] },
    );
    reply({});
    return false;
  }
  return false;
});

// 图片代理：内容脚本复制图片时需要跨域读取图片，由后台读取后转成 dataURL
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "fetchImage" || !allowedPage(sender)) return false;
  (async () => {
    try {
      const u = new URL(msg.url);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        ![
          "alimg.szlcsc.com",
          "szlcsc.com",
          "ickey.cn",
          "bomman.com",
          "mouser.cn",
          "mouser.com",
          "digikey.cn",
          "digikey.com",
        ].some((h) => u.hostname === h || u.hostname.endsWith("." + h))
      )
        throw new Error("图片来源未允许");
      const res = await fetch(u.href, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (
        !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(
          res.headers.get("content-type") || "",
        )
      )
        throw new Error("不是受支持图片");
      if (Number(res.headers.get("content-length")) > 5242880)
        throw new Error("图片过大");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader(),
        chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 5242880) {
          await reader.cancel();
          throw new Error("图片过大");
        }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
      }
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const type = res.headers.get("content-type") || "image/jpeg";
      return { ok: true, dataUrl: `data:${type};base64,${btoa(bin)}` };
    } catch (e) {
      dlog("图片", `读取图片失败：${e.message}`, { url: msg.url }, "warn");
      return { ok: false, error: String(e.message || e) };
    }
  })().then(reply);
  return true;
});
