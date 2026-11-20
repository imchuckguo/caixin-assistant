// 采芯助手 · 询价记录的数据格式（后台和记录本页面共用）
// 一条记录：自动记录 时间/公司/QQ/型号/品牌/批次，用户填写 数量/价格/未税含税/货品/货期，✓ = 有效报价
(function (root) {
  const GOODS = ["原装", "散新", "翻新", "国产替代"];
  const DEFAULTS = {
    qty: "",
    price: "",
    tax: "未税",
    goods: "原装",
    lead: "现货",
    valid: false,
    validAt: 0,
  };
  const TAX_RATE = 1.13;

  const normTax = (t) => (t === "含税" ? "含税" : "未税");
  const dayOf = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  // 同一天 + 同一家公司 + 同一个型号 = 同一条记录
  const dedupeKey = (r) =>
    `${dayOf(r.time)}|${String(r.company || "").trim()}|${String(r.pn || "")
      .trim()
      .toUpperCase()}`;

  function goodsOf(cond) {
    const c = String(cond || "");
    if (/散新/.test(c)) return "散新";
    if (/翻新/.test(c)) return "翻新";
    if (/国产|替代/.test(c)) return "国产替代";
    return "原装";
  }

  // 旧版记录（quote 对象）转成新格式；新格式原样返回
  function migrate(r) {
    if (!r || r.v === 2) return r;
    const q = r.quote || {};
    const price = q.price != null && q.price !== "" ? String(q.price) : "";
    const out = {
      v: 2,
      id:
        r.id ||
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: r.time || Date.now(),
      company: r.company || "",
      qq: r.qq || "",
      qqType: r.qqType || "",
      pn: r.pn || "",
      brand: r.brand || "",
      batch: r.batch || q.batch || "",
      site: r.site || "ic",
      action: r.action || "",
      text: r.text || "",
      ...DEFAULTS,
      qty: String((q.qty != null && q.qty !== "" ? q.qty : r.qty) ?? ""),
      price,
      tax: normTax(q.tax),
      goods: goodsOf(q.condition),
      lead: q.delivery || "现货",
      valid: price !== "",
      validAt: price !== "" ? q.at || r.time || 0 : 0,
      note: [
        r.note,
        q.currency === "USD" ? "美元报价" : "",
        q.raw ? "原回复：" + q.raw : "",
      ]
        .filter(Boolean)
        .join("；"),
    };
    return out;
  }

  function create(entry) {
    return {
      v: 2,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: Date.now(),
      company: "",
      qq: "",
      qqType: "",
      pn: "",
      brand: "",
      batch: "",
      site: "",
      action: "",
      text: "",
      note: "",
      ...DEFAULTS,
      ...pickAuto(entry),
      qty: entry.qty ? String(entry.qty) : "",
    };
  }

  // 只取自动记录的字段（防止页面传来的内容覆盖用户填写的内容）
  function pickAuto(e) {
    const o = {};
    for (const k of [
      "company",
      "qq",
      "qqType",
      "pn",
      "brand",
      "batch",
      "site",
      "action",
      "text",
    ])
      if (e[k] != null) o[k] = String(e[k]).trim().slice(0, 2000);
    return o;
  }

  // 未税单价，用于比价；不是数字返回 null
  function netPrice(r) {
    const p = parseFloat(String(r.price).replace(/[^\d.]/g, ""));
    if (!isFinite(p) || p <= 0) return null;
    return r.tax === "含税" ? p / TAX_RATE : p;
  }

  root.ICMRecord = {
    GOODS,
    DEFAULTS,
    TAX_RATE,
    normTax,
    dayOf,
    dedupeKey,
    migrate,
    create,
    pickAuto,
    netPrice,
  };
})(typeof self !== "undefined" ? self : this);
