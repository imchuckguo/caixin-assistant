// 采芯助手 · 货源网站上的“ 监控”按钮（立创、云汉、圣禾堂、贸泽、得捷）
// 立创 / 云汉 / 圣禾堂：搜索结果每个商品右边一个；贸泽 / 得捷：商品页库存旁边一个。
// 点一下 = 把这一条商品加入库存价格监控（只盯这一条，不是这个型号的全部货源），再点一下移出。
// 只在用户自己打开的页面显示；插件开的后台查询标签页（网址带 #cxm-lookup）不显示，免得影响读取。
(async () => {
  if (/cxm-lookup=/.test(location.hash)) return;
  const who = await chrome.runtime
    .sendMessage({ type: "lookupWho" })
    .catch(() => null);
  if (who && who.id) return;

  const host = location.hostname;
  const SITE = /szlcsc/.test(host)
    ? "szlcsc"
    : /ickey/.test(host)
      ? "ickey"
      : /bomman/.test(host)
        ? "bomman"
        : /mouser/.test(host)
          ? "mouser"
          : /digikey/.test(host)
            ? "digikey"
            : "";
  if (!SITE) return;
  const SITE_NAME = {
    szlcsc: "立创商城",
    ickey: "云汉芯城",
    bomman: "圣禾堂",
    mouser: "贸泽",
    digikey: "得捷",
  }[SITE];
  const norm = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const PN_RE = /^[A-Za-z0-9][A-Za-z0-9\-./#+_,]{2,40}$/;
  const cleanPn = (t) =>
    String(t || "")
      .trim()
      .replace(/[（(][^）)]*[）)]$/, "")
      .trim();

  // 一个商品块里的型号
  function pnOfRow(row) {
    if (row.dataset && row.dataset.productModel)
      return cleanPn(row.dataset.productModel);
    // 先看链接（型号一般是商品详情链接，里面可能有高亮的 span，所以取整个链接的文字），再看普通文字
    const ok = (t) => PN_RE.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t);
    const fromLinks = [...row.querySelectorAll("a")]
      .filter(visible)
      .slice(0, 20)
      .map((a) => cleanPn(a.textContent))
      .find(ok);
    if (fromLinks) return fromLinks;
    const leaves = [...row.querySelectorAll("span, div, p, h3, h4")]
      .filter((e) => e.children.length === 0 && visible(e))
      .slice(0, 60);
    return leaves.map((e) => cleanPn(e.textContent)).find(ok) || "";
  }

  // 找商品块：从“加入购物车 / 立即订货 / 咨询客服”按钮往上找到整行（宽度占列表大部分的那一层）
  function searchRows() {
    if (SITE === "ickey")
      return [...document.querySelectorAll("article.site-product-item")].filter(
        visible,
      );
    if (SITE === "szlcsc") {
      const rows = [
        ...document.querySelectorAll('section[class*="MainCard"]'),
      ].filter(visible);
      if (rows.length) return rows;
    }
    const btns = [...document.querySelectorAll("button, a")].filter(
      (b) =>
        /^(加入购物车|立即订货|咨询客服|直接购买|立即购买)$/.test(
          b.textContent.trim(),
        ) && visible(b),
    );
    const out = new Set();
    for (const b of btns) {
      let n = b;
      while (n && n.parentElement && n.getBoundingClientRect().width < 880)
        n = n.parentElement;
      if (n && n !== document.body && n.getBoundingClientRect().height < 600)
        out.add(n);
    }
    return [...out];
  }

  // 贸泽 / 得捷商品页：{ pn, anchor（按钮放在它右边）}
  function detailTarget() {
    if (SITE === "mouser") {
      const pnEl = document.querySelector("#spnManufacturerPartNumber");
      const box = document.querySelector("#pdpPricingAvailability");
      if (pnEl && box)
        return { pn: pnEl.textContent.trim(), anchor: box, dy: 52 };
      return null;
    }
    if (SITE === "digikey") {
      if (!/\/products\/detail\//.test(location.pathname)) return null;
      const stockEl = [
        ...document.querySelectorAll("div, span, p, h2, h3"),
      ].find(
        (e) =>
          e.children.length <= 1 &&
          /^现货\s*[:：]/.test(e.textContent.trim()) &&
          visible(e),
      );
      const mfr = document.querySelector('[data-testid="mfr-number"]');
      const seg = location.pathname.split("/").filter(Boolean);
      const pn =
        (mfr && mfr.textContent.trim()) ||
        decodeURIComponent(seg[seg.length - 2] || "");
      if (stockEl && pn) return { pn, anchor: stockEl, dy: 0, inline: true };
    }
    return null;
  }

  // ---------- 按钮 ----------
  const style = document.createElement("style");
  style.textContent = `
  #cxm-bells { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; }
  #cxm-bells .cxm-bell { position: absolute; display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 16px; cursor: pointer; white-space: nowrap;
    border: 1px solid #d9d2ff; background: #fff; color: #087558; font: 600 12px/1.3 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 2px 8px rgba(92, 70, 255, .15); transition: transform .12s, box-shadow .12s; }
  #cxm-bells .cxm-bell:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(92, 70, 255, .28); }
  #cxm-bells .cxm-bell.on { background: #087f68; color: #fff; border-color: transparent; }
  #cxm-bells .cxm-bell.busy { opacity: .7; cursor: progress; }
  #cxm-bell-tip { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483001; background: #172624; color: #fff; padding: 9px 16px; border-radius: 8px;
    font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 80vw; opacity: 0; pointer-events: none; transition: opacity .2s; }
  #cxm-bell-tip.show { opacity: 1; }`;
  document.documentElement.appendChild(style);
  const layer = document.createElement("div");
  layer.id = "cxm-bells";
  document.body.appendChild(layer);

  function tip(text) {
    let t = document.getElementById("cxm-bell-tip");
    if (!t) {
      t = document.createElement("div");
      t.id = "cxm-bell-tip";
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 5000);
  }

  // ---------- 这一条商品是哪一条：立创按编号，云汉按商品链接，贸泽 / 得捷按商品页网址，圣禾堂按型号 + 品牌 + 封装 + 批次 + 分区 ----------
  const normUrl = (u) =>
    String(u || "")
      .split("#")[0]
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .toLowerCase();
  const absU = (u) => {
    try {
      return u ? new URL(u, location.href).href.split("#")[0] : "";
    } catch {
      return "";
    }
  };
  const numOf = (s) => Number(String(s || "").replace(/[^\d.]/g, "")) || 0;
  function bommanChannel(row) {
    const block = row.closest('[id^="classify-"]');
    const first = block
      ? (block.innerText || "")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)[0] || ""
      : "";
    if (/^型号\/品牌/.test(first)) return "自营";
    if (/自营\s*·\s*在途/.test(first)) return "自营 · 在途";
    if (/严选/.test(first)) return "圣禾堂 · 严选";
    if (/合作库存/.test(first)) return "合作库存";
    return first.slice(0, 12);
  }
  function identOf(t) {
    const pn = t.pn;
    if (t.key === "detail") {
      const url = location.href.split("#")[0];
      const body = document.body.innerText;
      return {
        key: "url:" + normUrl(url),
        model: pn,
        url,
        stock: numOf((body.match(/(?:库存|现货)\s*[:：]\s*([\d,]+)/) || [])[1]),
      };
    }
    const row = t.el;
    const text = row.innerText || row.textContent || ""; // 标签页在后台时 innerText 可能是空的
    const g = (re) => ((text.match(re) || [])[1] || "").trim();
    const img = [...row.querySelectorAll("img")].find(
      (i) => i.getBoundingClientRect().width > 50,
    );
    const base = {
      model: pn,
      img: img ? img.src : "",
      price: numOf(g(/[¥￥]\s*([\d.]+)/)),
    };
    if (SITE === "szlcsc") {
      // 立创页面上“编号 / 现货 / 品牌”后面的冒号是样式画的，文字里没有；商品页链接里的数字是商品 ID，不是编号，不能拿来当编号
      // 逐个文字节点取，一个节点一行（直接用 textContent 会把“1652”和“160个/托盘”粘成一个数）
      const parts = [];
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const s = n.nodeValue.trim();
        if (s) parts.push(s);
      }
      const tc = parts.join("\n");
      const t1 = (re) => ((tc.match(re) || [])[1] || "").trim();
      const det = row.querySelector('a[href*="/lcsc/detail/C"]');
      let code = det
        ? ((det.getAttribute("href") || "").match(/\/(C\d+)\.html/) || [])[1] ||
          ""
        : "";
      if (!code) code = t1(/编号\s*[:：]?\s*(C\d+)/);
      const itemA = [...row.querySelectorAll("a")].find(
        (a) =>
          /^\/\d+\.html$/.test(a.pathname) &&
          /item\.szlcsc\.com$/.test(a.hostname),
      );
      const brand = t1(/(?:^|\n)品牌\s*[:：]?\s*\n?\s*([^\n]+)/);
      const pkg = t1(/(?:^|\n)封装\s*[:：]?\s*\n?\s*([^\n]+)/);
      // 现货那条写“现货 1652”；订货那条写“库存 830”（“嘉立创库存 1932”不在行首，不会读到）
      const stock = numOf(
        t1(/(?:^|\n)现货\s*[:：]?\s*\n?\s*([\d,]+)/) ||
          (
            (tc.match(/(?:^|\n)库存\s*[:：]?\s*\n?\s*([\d,]+)/g) || []).pop() ||
            ""
          ).replace(/^[\s\S]*库存\s*[:：]?\s*/, ""),
      );
      const ladder = [
        ...tc.matchAll(/(?:^|\n)(\d[\d,]*)\s*\+\s*[:：]?\s*[¥￥]\s*([\d.]+)/g),
      ].map((x) => [numOf(x[1]), Number(x[2])]);
      return {
        ...base,
        key: code
          ? "code:" + code
          : ["m", norm(pn), norm(brand), norm(pkg)].join("|"),
        code,
        brand,
        pkg,
        stock,
        ladder,
        price: ladder[0] ? ladder[0][1] : base.price,
        url: itemA ? `https://item.szlcsc.com${itemA.pathname}` : "",
      };
    }
    if (SITE === "ickey") {
      const tt = (id) => {
        const e = row.querySelector(`[data-testid="${id}"]`);
        return e ? e.textContent.replace(/\s+/g, " ").trim() : "";
      };
      const link =
        row.querySelector('[data-testid="site-product-title"]') ||
        row.querySelector("h2 a");
      const url = link ? absU(link.getAttribute("href")) : "";
      const brand = tt("site-product-manufacturer");
      const pkg = tt("site-product-package");
      const batch = tt("site-product-batch");
      return {
        ...base,
        key: url
          ? "url:" + normUrl(url)
          : ["m", norm(pn), norm(brand), norm(pkg), norm(batch)].join("|"),
        url,
        brand,
        pkg,
        batch,
        stock: numOf(tt("site-product-stock")),
      };
    }
    const brand = g(/品牌\s*[:：]\s*\n?([^\n]+)/).replace(/^复制$/, "");
    const pkg = g(/封装\s*[:：]\s*\n?([^\n]+)/);
    const batch = g(/批次\s*[:：]\s*\n?\s*([^\n]+)/);
    const channel = SITE === "bomman" ? bommanChannel(row) : "";
    const link = row.querySelector(
      'a[href*="ProductDetail"], a[href*="/products/detail/"]',
    );
    const url = link ? absU(link.getAttribute("href")) : "";
    return {
      ...base,
      key: url
        ? "url:" + normUrl(url)
        : ["m", norm(pn), norm(brand), norm(pkg), norm(batch), channel].join(
            "|",
          ),
      url,
      brand,
      pkg,
      batch,
      channel,
      stock: numOf(g(/库存\s*[:：]\s*\n?\s*([\d,]+)/)),
    };
  }

  // 在单个货源网站上点：只监控这一条商品（不是这个型号在这个网站的全部货源）
  let watchedKeys = new Map(); // key → watch id
  async function loadWatched() {
    const { watches = [] } = await CxPage.get("watches");
    watchedKeys = new Map(
      watches
        .filter((w) => w.kind === "item" && w.site === SITE && w.ident)
        .map((w) => [w.ident.key, w.id]),
    );
    paintStates();
  }
  function paintStates() {
    for (const b of layer.querySelectorAll(".cxm-bell")) {
      if (b.classList.contains("busy")) continue;
      const on = watchedKeys.has(b.dataset.key);
      b.classList.toggle("on", on);
      b.textContent = on ? " 已监控" : " 监控";
      b.title = on
        ? `这一条已在库存价格监控里，点击移出`
        : `把这一条 ${b.dataset.pn} 加入库存价格监控：只盯这一条的库存和价格，有变化弹出电脑通知`;
    }
  }
  const every = (m) =>
    m >= 1440 ? "每天" : m >= 60 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`;
  async function onBell(b) {
    const pn = b.dataset.pn;
    if (b.classList.contains("busy") || !b._target) return;
    const ident = identOf(b._target);
    if (watchedKeys.has(ident.key)) {
      await chrome.runtime
        .sendMessage({ type: "removeWatch", id: watchedKeys.get(ident.key) })
        .catch(() => null);
      tip(`已把这一条 ${pn} 移出库存价格监控`);
      return;
    }
    b.classList.add("busy");
    b.textContent = " 记录当前库存…";
    const r = await chrome.runtime
      .sendMessage({ type: "addItemWatch", site: SITE, pn, ident })
      .catch(() => null);
    b.classList.remove("busy");
    if (r && r.ok) {
      tip(
        r.exists
          ? "这一条已经在库存价格监控里了"
          : `已加入库存价格监控：${every(r.minutes || 120)}检查${SITE_NAME}这一条 ${pn}${ident.code ? `（${ident.code}）` : ""}，当前库存 ${Number(r.stock || 0).toLocaleString("zh-CN")}，有变化弹出电脑通知`,
      );
    } else
      tip(
        (r && r.error) ||
          "加入失败：请到 chrome://extensions 刷新采芯助手插件后，再刷新这个页面",
      );
    paintStates();
  }

  // 把按钮放到每个商品右边；右边没有空位时放进商品块的右上角
  const bells = new Map(); // key → button
  function place() {
    const targets = [];
    const det = detailTarget();
    if (det)
      targets.push({
        key: "detail",
        pn: det.pn,
        el: det.anchor,
        dy: det.dy,
        inline: det.inline,
      });
    else
      for (const row of searchRows()) {
        const pn = pnOfRow(row);
        if (pn) targets.push({ key: row, pn, el: row, dy: 14 });
      }
    const keep = new Set();
    const vw = document.documentElement.clientWidth;
    for (const t of targets.slice(0, 80)) {
      let b = bells.get(t.key);
      if (!b) {
        b = document.createElement("button");
        b.type = "button";
        b.className = "cxm-bell";
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onBell(b);
        });
        layer.appendChild(b);
        bells.set(t.key, b);
      }
      b._target = t;
      if (b.dataset.pn !== t.pn) {
        b.dataset.pn = t.pn;
        b.textContent = "";
      }
      try {
        b.dataset.key = identOf(t).key;
      } catch {
        b.dataset.key = "";
      }
      keep.add(b);
      const r = t.el.getBoundingClientRect();
      const w = b.offsetWidth || 86;
      let x = r.right + (t.inline ? 16 : 12);
      if (x + w > vw - 4) x = r.right - w - 12; // 右边放不下：放进块里
      b.style.left = `${Math.round(x + window.scrollX)}px`;
      b.style.top = `${Math.round(r.top + window.scrollY + (t.dy || 0))}px`;
    }
    for (const [k, b] of bells)
      if (!keep.has(b)) {
        b.remove();
        bells.delete(k);
      }
    paintStates();
  }

  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(place, 300);
  };
  new MutationObserver((muts) => {
    if (muts.some((m) => !layer.contains(m.target))) later();
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", later);
  setInterval(place, 2500);
  CxPage.onChanged((c, area) => {
    if (area === "local" && (c.watches || c.settings)) loadWatched();
  });
  await loadWatched();
  place();
})();
