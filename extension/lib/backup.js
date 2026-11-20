(function (root) {
  const fields = [
    "company",
    "qq",
    "qqType",
    "pn",
    "brand",
    "batch",
    "site",
    "action",
    "text",
    "note",
    "qty",
    "price",
    "tax",
    "goods",
    "lead",
  ];
  const safe = (v) => {
    const s = String(v ?? "");
    return /^[\s\uFEFF]*[=+@-]/.test(s) ? "'" + s : s;
  };
  const csv = (rows) =>
    "\uFEFF" +
    rows
      .map((row) =>
        row.map((v) => '"' + safe(v).replace(/"/g, '""') + '"').join(","),
      )
      .join("\r\n");
  function validate(records) {
    if (!Array.isArray(records) || records.length > 5000)
      throw new Error("最多导入 5000 条记录");
    return records.map((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r))
        throw new Error("记录格式错误");
      const o = {
        v: 2,
        id: crypto.randomUUID(),
        time: Number.isFinite(r.time) && r.time > 0 ? r.time : Date.now(),
        valid: r.valid === true,
        validAt: Number(r.validAt) || 0,
      };
      for (const k of fields) {
        if (r[k] != null && !["string", "number"].includes(typeof r[k]))
          throw new Error("字段类型错误");
        const s = String(r[k] ?? "");
        if (s.length > 2000) throw new Error("字段过长");
        o[k] = s;
      }
      o.tax = o.tax === "含税" ? "含税" : "未税";
      o.goods = o.goods || "原装";
      o.lead = o.lead || "现货";
      return o;
    });
  }
  function readCsv(text) {
    const rows = [];
    let row = [],
      v = "",
      quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') {
          v += '"';
          i++;
        } else quoted = !quoted;
      } else if (c === "," && !quoted) {
        row.push(v);
        v = "";
      } else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(v);
        if (row.some(Boolean)) rows.push(row);
        row = [];
        v = "";
      } else v += c;
    }
    if (quoted) throw new Error("CSV 引号未闭合");
    row.push(v);
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  function parse(text) {
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 5242880
    )
      throw new Error("文件不能超过 5 MB");
    text = text.replace(/^\uFEFF/, "").trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      const d = JSON.parse(text);
      return validate(Array.isArray(d) ? d : d.records);
    }
    const [head, ...rows] = readCsv(text),
      map = {
        公司名: "company",
        QQ: "qq",
        QQ类型: "qqType",
        型号: "pn",
        品牌: "brand",
        批次: "batch",
        数量: "qty",
        价格: "price",
        "未税/含税": "tax",
        货品: "goods",
        货期: "lead",
        备注: "note",
      };
    if (!head?.includes("型号")) throw new Error("CSV 缺少型号列");
    return validate(
      rows.map((row) => {
        const r = {};
        head.forEach((h, i) => {
          if (map[h]) r[map[h]] = row[i] || "";
          if (h === "有效报价") r.valid = row[i] === "是";
        });
        r.qqType =
          r.qqType === "企业"
            ? "enterprise"
            : r.qqType === "私人"
              ? "personal"
              : "";
        return r;
      }),
    );
  }
  root.CaixinBackup = { parse, validate, csv };
})(globalThis);
