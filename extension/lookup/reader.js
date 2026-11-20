// 采芯助手 · 在立创 / 云汉 / 圣禾堂 / 贸泽 / 得捷 的页面里读取结果
// 只在插件打开的后台标签页里工作（网址带 #cxm-lookup=xxx），用户自己打开的页面不受影响。
// 只读取页面上显示给用户看的内容，不调用未公开接口，不绕过人机验证。
(async () => {
  // 先看网址里的标记；有些网站（如淘宝）会改写网址把标记去掉，这时问后台“这个标签页是不是插件开的”
  let id = (location.hash.match(/cxm-lookup=([a-z0-9]+)/) || [])[1];
  if (!id) {
    const r = await chrome.runtime
      .sendMessage({ type: "lookupWho" })
      .catch(() => null);
    id = r && r.id;
  }
  if (!id) return;
  const host = location.hostname;
  const num = (s) => Number(String(s || "").replace(/[,，\s+]/g, "")) || 0;
  const txt = (el) =>
    el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
  const abs = (u) =>
    !u
      ? ""
      : u.startsWith("//")
        ? "https:" + u
        : u.startsWith("/")
          ? location.origin + u
          : u;
  let done = false;

  function send(items, error) {
    if (done) return;
    done = true;
    chrome.runtime
      .sendMessage({ type: "lookupResult", id, items, error })
      .catch(() => {});
  }

  // 人机验证 / 登录页
  function blocked() {
    const t =
      document.title +
      " " +
      (document.body ? document.body.innerText.slice(0, 400) : "");
    if (
      /Just a moment|请稍候|正在进行安全验证|verify you are human|Access Denied/i.test(
        t,
      )
    )
      return "需要在该网站完成人机验证：请点“去看看”在网站里通过验证后再试";
    if (
      /passport|login/i.test(location.hostname + location.pathname) ||
      /用户登录中心/.test(t)
    )
      return "需要先登录该网站";
    return "";
  }

  // ---------- 立创：页面内嵌数据 ----------
  function findPdf(o) {
    for (const k in o) {
      const v = o[k];
      if (typeof v === "string" && /^https?:\/\/.+\.pdf(\?|$)/i.test(v))
        return v;
    }
    return "";
  }
  function readSzlcsc() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    const d = JSON.parse(el.textContent);
    const recs =
      ((((d.props || {}).pageProps || {}).soData || {}).searchResult || {})
        .productRecordList || [];
    // 只算真正有现货的；没现货的那条是原厂期货，在“合作库存”里另外读取
    return recs
      .map((r) => r.productVO || r)
      .filter(Boolean)
      .map((v) => ({
        channel: v.hasStockNow === "yes" ? "立创现货" : "立创订货",
        rank: 0,
        priceNote: "含税",
        orderOnly: v.hasStockNow !== "yes",
        model: v.productModel,
        brand: v.productGradePlateName || "",
        pkg: v.encapsulationModel || "",
        category: v.productType || "",
        code: v.productCode || "",
        img: v.bigImageUrl || v.breviaryImageUrl || "",
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
        moq: v.minBuyNumber || "",
        pack: v.productMinEncapsulationNumber
          ? `${v.productMinEncapsulationNumber}个/${v.productMinEncapsulationUnit || "包"}`
          : "",
        delivery: "现货最快4小时发货",
        datasheet: findPdf(v),
      }));
  }

  // ---------- 云汉：只要 云汉在库 / 云汉优选 / 全球集采 三组 ----------
  // 2026-11 起云汉换了新页面：分组标题 .search-page__result-group-title（云汉在库 / 云汉优选 / 全球集采），
  // 数据块 section.search-page__results（全球集采下有 国内现货 / 海外现货 等小标题），每个商品 article.site-product-item，
  // 字段带 data-testid（库存、批次、厂牌、封装）。全球集采里 Digi-Key / Mouser / Arrow 等海外分销商不要（得捷、贸泽另有单独查询）
  const ICKEY_GROUPS = { 云汉在库: 0, 云汉优选: 1, 全球集采: 2 };
  function readIckeyNew() {
    const els = [
      ...document.querySelectorAll(
        ".search-page__result-group-title, section.search-page__results",
      ),
    ];
    if (!els.some((e) => e.matches("section.search-page__results")))
      return null;
    const out = [];
    let group = "";
    for (const el of els) {
      if (el.matches(".search-page__result-group-title")) {
        group =
          Object.keys(ICKEY_GROUPS).find((g) => txt(el).startsWith(g)) || "";
        continue;
      }
      if (!group) continue;
      const sub = txt(el.querySelector(":scope > h2, :scope > h3"))
        .replace(/原厂直供.*/, "")
        .trim();
      const direct = /原厂直供|TI Store/i.test(
        txt(el.querySelector(":scope > h2, :scope > h3")),
      );
      if (
        group === "全球集采" &&
        /digi-?key|mouser|arrow|avnet|element14|future|verical|rs components/i.test(
          sub,
        )
      )
        continue;
      const channel = group === "全球集采" && sub ? `全球集采 · ${sub}` : group;
      for (const a of el.querySelectorAll("article.site-product-item")) {
        const t = (id) => txt(a.querySelector(`[data-testid="${id}"]`));
        const tiers = [...a.querySelectorAll(".site-product-item__tier")].map(
          (r) => [...r.children].map((c) => txt(c)),
        );
        const ladder = tiers
          .map((c) => [
            num(c[0]),
            Number(String(c[c.length - 1] || "").replace(/[^\d.]/g, "")) || 0,
            c.length > 2 ? c[1] : "",
          ])
          .filter((x) => x[0] && (x[1] || x[2]));
        const img = a.querySelector("img.site-product-item__image");
        const link =
          a.querySelector('[data-testid="site-product-title"]') ||
          a.querySelector("h2 a");
        const ds = [...a.querySelectorAll("a")].find((x) =>
          /\.pdf(\?|$)/i.test(x.getAttribute("href") || ""),
        );
        const meta = (label) => {
          const dt = [...a.querySelectorAll("dt")].find((d) =>
            txt(d).replace(/\s/g, "").startsWith(label),
          );
          return dt ? txt(dt.nextElementSibling) : "";
        };
        out.push({
          model: a.dataset.productModel || txt(link),
          brand: t("site-product-manufacturer"),
          pkg: t("site-product-package"),
          category: t("site-product-source-meta").replace(/^分类[:：]\s*/, ""),
          img: abs(img ? img.getAttribute("src") : ""),
          url: abs(link ? link.getAttribute("href") : ""),
          stock: num(t("site-product-stock")),
          batch: t("site-product-batch"),
          moq: num(meta("起订量")),
          step: num(meta("增量")),
          price: ladder.length ? ladder[0][1] : 0,
          ladder,
          ladderCols: ladder.some((x) => x[2])
            ? ["数量", "内地交货(含税)", "香港交货"]
            : null,
          priceNote: "含税",
          delivery: [
            ...a.querySelectorAll(".site-product-item__delivery label"),
          ]
            .map((l) => txt(l))
            .filter(Boolean)
            .join(" / "),
          tag: t("site-product-tag"),
          datasheet: ds ? abs(ds.getAttribute("href")) : "",
          channel,
          direct,
          rank: ICKEY_GROUPS[group],
        });
      }
    }
    return out;
  }
  function readIckey() {
    const fresh = readIckeyNew();
    if (fresh) return fresh;
    return readIckeyOld();
  }
  // 旧版页面（.search-data-item）
  function readIckeyOld() {
    const sections = [...document.querySelectorAll(".search-data-item")];
    if (!sections.length)
      return /库\s*存/.test(document.body.innerText) ? [] : null;
    const out = [];
    let group = "";
    for (const sec of sections) {
      const gm = (sec.id || "").match(/^scroll-title-(.+)$/);
      if (gm) group = decodeURIComponent(gm[1]);
      if (!(group in ICKEY_GROUPS)) continue;
      const head = sec.querySelector(".search-logo-new");
      const sub = head
        ? txt(head.querySelector(".fw-b") || head)
            .replace(/原厂直供.*/, "")
            .trim()
        : "";
      const direct = head ? /原厂直供/.test(head.textContent) : false;
      if (group === "全球集采" && !(direct || /国内现货|海外现货/.test(sub)))
        continue;
      const channel = group === "全球集采" && sub ? `全球集采 · ${sub}` : group;
      const rank = ICKEY_GROUPS[group];
      for (const row of sec.querySelectorAll(".result-list[data-pro-name]")) {
        const text = row.textContent.replace(/\s+/g, " ");
        const qtys = [...row.querySelectorAll(".search-w-price > div")].map(
          (d) => num(txt(d)),
        );
        const hk = [...row.querySelectorAll(".search-w-hk > div")].map((d) =>
          txt(d).replace(/\s/g, ""),
        );
        const cn = [...row.querySelectorAll(".search-w-home > div")].map(
          (d) => Number(txt(d).replace(/[^\d.]/g, "")) || 0,
        );
        const ladder = qtys
          .map((q, i) => [q, cn[i] || 0, hk[i] || ""])
          .filter((x) => x[0] && (x[1] || x[2]));
        const copyBtn = row.querySelector(".js_btn_copy_product");
        const img = row.querySelector("img");
        let imgUrl = "";
        if (img) {
          try {
            imgUrl =
              JSON.parse(
                decodeURIComponent(img.getAttribute("data-src") || "[]"),
              )[0] || "";
          } catch {
            /* ignore */
          }
          imgUrl = imgUrl || img.getAttribute("src") || "";
          if (/^data:|blank|loading/i.test(imgUrl)) imgUrl = "";
        }
        const deliveries = [...row.querySelectorAll("input[type=radio]")]
          .map((r) => txt(r.parentElement))
          .filter(Boolean);
        out.push({
          model: row.dataset.proName || "",
          brand: row.dataset.maf || "",
          pkg: (copyBtn && copyBtn.dataset.package) || "",
          category: ((text.match(/分类：\s*([^\s]+)/) || [])[1] || "").trim(),
          img: abs(imgUrl),
          url: abs(row.dataset.url || ""),
          stock: num(row.dataset.stock),
          batch: (copyBtn && copyBtn.dataset.dc) || "",
          moq: num((text.match(/起订量：\s*([\d,]+)/) || [])[1]),
          step: num((text.match(/增\s*量：\s*([\d,]+)/) || [])[1]),
          price: ladder.length ? ladder[0][1] : 0,
          ladder,
          ladderCols: hk.some(Boolean)
            ? ["数量", "内地交货(含税)", "香港交货"]
            : null,
          delivery:
            deliveries.join(" / ") ||
            (text.match(/((?:内地|香港)\S{1,14}?工作日)/) || [])[1] ||
            "",
          channel,
          direct,
          rank,
        });
      }
    }
    return out;
  }

  // ---------- 圣禾堂：按页面分区读取：自营 / 自营 · 在途 / 圣禾堂 · 严选 / 供应商 · 合作库存 ----------
  // 分区是 #classify-数字 的块；“替代参考”等不在这些块里，直接不要
  function bommanLabel(block) {
    const first =
      (block.innerText || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)[0] || "";
    if (/^型号\/品牌/.test(first)) return { channel: "自营", rank: 0 };
    if (/自营\s*·\s*在途/.test(first))
      return { channel: "自营 · 在途", rank: 1 };
    if (/严选/.test(first)) return { channel: "圣禾堂 · 严选", rank: 2 };
    if (/合作库存/.test(first)) return { channel: "合作库存", rank: 3 };
    return { channel: first.slice(0, 12), rank: 4 };
  }
  function readBommanBlock(block, label, pdf) {
    const text = block.innerText;
    const imgs = [...block.querySelectorAll("img")].filter(
      (i) =>
        /product|goods|oss/i.test(i.src) &&
        i.getBoundingClientRect().width > 60,
    );
    let k = 0;
    return text
      .split(/加入购物车|立即订货/)
      .map((b) => {
        const mm = b.match(
          /(?:^|\n)([A-Za-z0-9][A-Za-z0-9\-\/#.+_]{2,40})\n(?:复制\n)?品牌\s*[:：]/,
        );
        if (!mm) return null;
        const g = (re) => ((b.match(re) || [])[1] || "").trim();
        const ladder = [
          ...b.matchAll(/(\d[\d,]*)\+\s*\n?\s*￥\s*([\d.]+)/g),
        ].map((x) => [num(x[1]), Number(x[2])]);
        const img = imgs[k++];
        const mpq = g(/最小包\s*[:：]\s*\n?\s*([\d,]+)/);
        return {
          channel: label.channel,
          rank: label.rank,
          model: mm[1],
          brand: g(/品牌\s*[:：]\s*\n?([^\n]+)/).replace(/^复制$/, ""),
          pkg: g(/封装\s*[:：]\s*\n?([^\n]+)/),
          category: g(/类目\s*[:：]\s*\n?([^\n]+)/),
          img: img ? img.src : "",
          url: location.href.split("#")[0],
          stock: num(g(/库存\s*[:：]\s*\n?\s*([\d,]+)/)),
          pack: mpq ? `最小包 ${mpq}` : "",
          moq: num(g(/起订量\s*[:：]\s*\n?\s*([\d,]+)/)),
          step: num(g(/增量\s*[:：]\s*\n?\s*([\d,]+)/)),
          batch: g(/批次\s*[:：]\s*\n?\s*([^\n]+)/),
          price: ladder[0] ? ladder[0][1] : 0,
          ladder,
          priceNote: "含税",
          delivery:
            g(/(\d+\s*-\s*\d+\s*(?:个)?工作日内?发货)/) ||
            (/1小时发货/.test(b) ? "最快1小时发货" : "") ||
            g(/(预计[^\n]{2,20})/),
          datasheet: pdf ? pdf.href : "",
        };
      })
      .filter(Boolean);
  }
  function readBomman() {
    const text = document.body.innerText;
    if (!/库存\s*[:：]/.test(text))
      return /暂无相关|没有找到/.test(text) ? [] : null;
    const pdf = [...document.querySelectorAll('a[href*=".pdf"]')].find(
      (a) =>
        /数据手册|规格书/.test(a.textContent) || /oss_model_pdf/.test(a.href),
    );
    const blocks = [...document.querySelectorAll('[id^="classify-"]')];
    if (!blocks.length) return null; // 页面还没渲染完
    // 在途的数量不算现货库存，单独显示在“在途”里
    return blocks
      .flatMap((b) => readBommanBlock(b, bommanLabel(b), pdf))
      .map((it) =>
        it.channel === "自营 · 在途" && it.stock
          ? {
              ...it,
              onOrder: [`${it.stock.toLocaleString("zh-CN")}（在途）`],
              stock: 0,
            }
          : it,
      );
  }

  // ---------- 贸泽：单个商品页 或 搜索结果表格 ----------
  function readMouser() {
    const t = document.body.innerText;
    if (/ProductDetail/i.test(location.pathname) || /供货情况/.test(t)) {
      const model = (
        (t.match(/制造商编号\s*[:：]\s*\n?\s*([^\s]+)/) || [])[1] || ""
      ).trim();
      if (!model) return null;
      const availSec = (t.split("供货情况")[1] || "").split(/定价|输入数量/)[0];
      const onOrder = [
        ...availSec.matchAll(/([\d,]+)\s*\n?\s*预期\s*([\d/]+)/g),
      ].map((x) => `${x[1]} 预期 ${x[2]}`);
      const lead = (availSec.match(
        /生产周期\s*[:：]\s*\n?\s*(\d+)\s*\n?\s*周/,
      ) || [])[1];
      const priceTable = document.querySelector("table.pricing-table");
      const ladder = priceTable
        ? [
            ...priceTable.innerText.matchAll(
              /^\s*([\d,]+)\s+[¥￥]\s*([\d.,]+)/gm,
            ),
          ].map((x) => [num(x[1]), Number(x[2].replace(/,/g, ""))])
        : [];
      const img = [...document.querySelectorAll("img")].find(
        (i) =>
          /\/images\//.test(i.src) && i.getBoundingClientRect().width > 100,
      );
      const ds = [...document.querySelectorAll("a")].find(
        (a) => /lit\/|datasheet|\.pdf/i.test(a.href) && /^https?:/.test(a.href),
      );
      return [
        {
          model,
          brand: (
            (t.match(/制造商\s*[:：]\s*\n?\s*([^\n]+)/) || [])[1] || ""
          ).trim(),
          img: img ? img.src : "",
          imgBig: img ? img.src.replace(/\/images\/([^/]+)$/, "/lrg/$1") : "",
          url: location.href.split("#")[0],
          stock: num(
            (availSec.match(/库存\s*[:：]\s*\n?\s*([\d,]+)/) || [])[1],
          ),
          onOrder,
          leadTime: lead ? `${lead} 周` : "",
          price: ladder[0] ? ladder[0][1] : 0,
          ladder,
          priceNote: "含13%增值税",
          moq: num((t.match(/最少\s*[:：]\s*([\d,]+)/) || [])[1]),
          step: num((t.match(/倍数\s*[:：]\s*([\d,]+)/) || [])[1]),
          delivery: lead ? `生产周期 ${lead} 周` : "",
          datasheet: ds ? ds.href : "",
        },
      ];
    }
    const rows = [...document.querySelectorAll("table tr")].filter((r) =>
      /Mouser 零件编号|Mouser Part/.test(r.innerText),
    );
    if (!rows.length) return /没有找到|未找到|0 个结果/.test(t) ? [] : null;
    return rows
      .map((r) => {
        const text = r.innerText;
        const model =
          (text.match(/制造商零件编号\s*\n?\s*([^\s]+)/) || [])[1] || "";
        const tds = [...r.querySelectorAll("td")].map((td) =>
          td.innerText.replace(/\s+/g, " ").trim(),
        );
        const avail =
          tds.find(
            (x) => /有库存|库存|在途|预期|备用包装/.test(x) && /\d/.test(x),
          ) || "";
        const n = (avail.match(/([\d,]+)/) || [])[1];
        const isOnOrder = /在途|预期/.test(avail) && !/有库存/.test(avail);
        const priceTd = tds.find((x) => /[¥￥]/.test(x)) || "";
        const ladder = [
          ...priceTd.matchAll(/([\d,]+)\s*[¥￥]\s*([\d.]+)/g),
        ].map((x) => [num(x[1]), Number(x[2])]);
        const img = r.querySelector("img");
        const a = r.querySelector('a[href*="ProductDetail"]');
        const ds = [...r.querySelectorAll("a")].find((x) =>
          /lit\/|datasheet|\.pdf/i.test(x.href),
        );
        const exp = (avail.match(/预期\s*([\d/]+)/) || [])[1];
        return {
          model,
          brand:
            tds.find((x) =>
              /Texas|STMicro|Analog|Microchip|NXP|onsemi|Infineon|Renesas|Nexperia|Vishay/i.test(
                x,
              ),
            ) || "",
          img: img ? img.src : "",
          url: a ? a.href : "",
          stock: isOnOrder ? 0 : num(n),
          onOrder: isOnOrder && n ? [`${n}${exp ? " 预期 " + exp : ""}`] : [],
          price: ladder[0] ? ladder[0][1] : 0,
          ladder,
          priceNote: "含13%增值税",
          delivery: isOnOrder ? "在途" : n ? "现货" : "",
          datasheet: ds ? ds.href : "",
        };
      })
      .filter((x) => x.model);
  }

  // ---------- 得捷 Digi-Key：单个商品页（按页面文字读取） ----------
  function readDigikey() {
    const t = document.body.innerText;
    const stockM =
      t.match(/现货\s*[:：]\s*([\d,]+)/) ||
      t.match(/In[- ]Stock\s*[:：]?\s*([\d,]+)/i);
    if (stockM && /制造商产品编号|Manufacturer Product Number/.test(t)) {
      const model = (
        (t.match(/制造商产品编号\s*\n?\s*([^\s]+)/) ||
          t.match(/Manufacturer Product Number\s*\n?\s*([^\s]+)/) ||
          [])[1] || ""
      ).trim();
      const expected = [
        ...t.matchAll(/([\d,]+)\s*expected in stock on\s*([0-9A-Za-z\-]+)/gi),
      ].map((x) => `${x[1]} 预计 ${x[2]}`);
      const lead = (t.match(/原厂标准交货期\s*\n?\s*(\d+\s*周)/) ||
        t.match(/Manufacturer Standard Lead Time\s*\n?\s*(\d+\s*Weeks?)/i) ||
        [])[1];
      const ladder = [];
      for (const tb of document.querySelectorAll("table")) {
        if (!/单价|Unit Price/.test(tb.innerText)) continue;
        for (const tr of tb.querySelectorAll("tr")) {
          const c = [...tr.querySelectorAll("td")].map((td) =>
            td.innerText.trim(),
          );
          if (c.length >= 2 && /^\d[\d,]*$/.test(c[0]) && /[\d.]/.test(c[1]))
            ladder.push([num(c[0]), Number(c[1].replace(/[^\d.]/g, ""))]);
        }
        if (ladder.length) break;
      }
      const img = [...document.querySelectorAll("img")].find(
        (i) =>
          /digikey|media/i.test(i.src) && i.getBoundingClientRect().width > 100,
      );
      const ds = [...document.querySelectorAll("a")].find(
        (a) =>
          /规格书|Datasheet/i.test(a.textContent) && /^https?:/.test(a.href),
      );
      return [
        {
          model,
          brand: ((t.match(/制造商\s*\n\s*([^\n]+)/) || [])[1] || "").trim(),
          img: img ? img.src : "",
          url: location.href.split("#")[0],
          stock: num(stockM[1]),
          onOrder: expected,
          leadTime: lead || "",
          price: ladder[0] ? ladder[0][1] : 0,
          ladder,
          priceNote: "含13%增值税",
          delivery: lead ? `原厂标准交货期 ${lead}` : "",
          datasheet: ds ? ds.href : "",
        },
      ];
    }
    if (/没有找到|No results|0 个结果/.test(t)) return [];
    return null;
  }

  // ---------- 淘宝：搜索列表前 10 个商品（主图、店铺、标题、价格） ----------
  function readTaobao() {
    const cards = [...document.querySelectorAll('a[id^="item_id_"]')];
    if (!cards.length)
      return /没有找到|抱歉/.test(document.body.innerText) ? [] : null;
    const q = new URLSearchParams(location.search).get("q") || "";
    const nq = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return cards.slice(0, 10).map((a) => {
      const titleEl = a.querySelector('[class*="title--"]');
      const title = (
        (titleEl && (titleEl.getAttribute("title") || titleEl.textContent)) ||
        ""
      ).trim();
      const shopEl =
        a.querySelector('[class*="shopNameText"]') ||
        a.querySelector('[class*="shopName"]');
      let shop = shopEl ? shopEl.textContent.trim() : "";
      const tagM = shop.match(/^(\d+年老店)\s*/);
      const shopTag = tagM
        ? tagM[1]
        : (a.innerText.match(/(\d+年老店)/) || [])[1] || "";
      if (tagM) shop = shop.slice(tagM[0].length);
      const pi = a.querySelector('[class*="priceInt"]');
      const pf = a.querySelector('[class*="priceFloat"]');
      const price =
        Number(
          ((pi ? pi.textContent : "") + (pf ? pf.textContent : "")).replace(
            /[^\d.]/g,
            "",
          ),
        ) || 0;
      const img =
        a.querySelector('img[class*="mainPic--"]') ||
        [...a.querySelectorAll("img")].find((i) =>
          /bao\/uploaded/.test(i.src || i.getAttribute("data-src") || ""),
        );
      let imgUrl = img
        ? img.getAttribute("src") || img.getAttribute("data-src") || ""
        : "";
      if (/^data:/.test(imgUrl)) imgUrl = img.getAttribute("data-src") || "";
      const sales = (
        (a.querySelector('[class*="realSales"]') || {}).textContent || ""
      ).trim();
      const city = [...a.querySelectorAll('[class*="procity"]')]
        .map((e) => e.textContent.trim())
        .join(" ");
      const match =
        nq &&
        title
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .includes(nq);
      return {
        model: match ? q : title.slice(0, 40),
        title,
        shop,
        shopTag,
        img: abs(imgUrl),
        imgBig: abs(imgUrl).replace(/_\d+x\d+q\d+\.jpg.*$/, ""),
        url: a.href,
        price,
        stock: 0,
        sales,
        location: city,
        channel: shopTag,
      };
    });
  }

  const reader = host.includes("taobao")
    ? readTaobao
    : host.includes("szlcsc")
      ? readSzlcsc
      : host.includes("ickey")
        ? readIckey
        : host.includes("mouser")
          ? readMouser
          : host.includes("digikey")
            ? readDigikey
            : readBomman;

  let tries = 0;
  let firstHit = 0;
  const timer = setInterval(() => {
    tries++;
    const b = blocked();
    if (b && tries > 3) {
      clearInterval(timer);
      send([], b);
      return;
    }
    try {
      const items = reader();
      if (items && items.length) {
        // 读到结果后再等一会儿，让价格、图片等延迟加载的内容补齐
        if (!firstHit) firstHit = tries;
        if (tries - firstHit >= 2) {
          clearInterval(timer);
          send(reader() || items);
        }
      } else if (items && tries > 8) {
        clearInterval(timer);
        send(items);
      } else if (!items && tries > 16) {
        clearInterval(timer);
        send([]);
      }
    } catch (e) {
      if (tries > 8) {
        clearInterval(timer);
        send([], String(e.message || e));
      }
    }
    if (tries > 40) {
      clearInterval(timer);
      send([], "页面没有加载出结果");
    }
  }, 700);
})();
