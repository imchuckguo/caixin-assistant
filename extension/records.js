// 采芯助手 · 询价记录本：每行直接填写，像 Excel 一样
const $ = (s) => document.querySelector(s);
const KEY = "inquiryLog";
const COLS_KEY = "recordCols2";
const PAGE = 300;
const R = ICMRecord;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const fmtTime = (t) =>
  new Date(t).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const COLS = [
  ["time", "日期时间"],
  ["company", "公司名"],
  ["qq", "QQ"],
  ["brand", "品牌"],
  ["batch", "批次"],
  ["qty", "数量"],
  ["price", "价格"],
  ["goods", "货品"],
  ["lead", "货期"],
  ["note", "备注"],
  ["by", "记录人"],
];
let cols = {
  time: true,
  company: true,
  qq: true,
  brand: true,
  batch: true,
  qty: true,
  price: true,
  goods: true,
  lead: true,
  note: false,
  by: true,
};
let logs = [];
// 团队共享：队友的记录（只读）
let team = null;
let teamRecs = [];
const memberName = (id) => {
  const m = team && (team.members || []).find((x) => x.id === id);
  return m ? m.name : "已退出的成员";
};
const allRecs = () => (team ? logs.concat(teamRecs) : logs);
let shown = PAGE;
let dirtyRender = false; // 有外部更新，但用户正在填写，等离开表格再刷新
const pending = new Map(); // id -> { patch, timer }

const params = new URLSearchParams(location.search);
// 在网站右侧半屏抽屉里打开时：去掉大标题，紧凑显示
if (params.get("embed")) document.documentElement.classList.add("embed");
if (params.get("pn")) $("#q").value = params.get("pn");

// ---------- 读写 ----------
async function load() {
  const got = await chrome.storage.local.get([
    KEY,
    COLS_KEY,
    "cxTeam",
    "cxTeamRecords",
  ]);
  const raw = got[KEY] || [];
  logs = raw.map(R.migrate);
  loadTeam(got.cxTeam, got.cxTeamRecords);
  cols = { ...cols, ...(got[COLS_KEY] || {}) };
  document.querySelectorAll("[data-col]").forEach((c) => {
    c.checked = cols[c.dataset.col] !== false;
  });
  // 有旧格式记录：让后台统一转换一次
  if (raw.some((r) => r && r.v !== 2)) send({ type: "migrateRecords" });
  render();
}

function loadTeam(t, log) {
  team = t || null;
  teamRecs = team
    ? Object.values(log || {})
        .map((r) => ({ ...R.migrate(r), _by: r._by, _ro: true }))
        .sort((a, b) => b.time - a.time)
    : [];
  const box = $("#teamBar");
  if (box) {
    box.classList.toggle("hidden", !team);
    if (team)
      $("#teamInfo").textContent =
        ` ${team.name || "团队"} · ${(team.members || []).length} 人 · 队友记录 ${teamRecs.length} 条${team.lastError ? " · 同步失败：" + team.lastError : ""}`;
  }
  const byCol = document.querySelector("[data-col=by]");
  if (byCol) byCol.parentElement.classList.toggle("hidden", !team);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

// 后台没响应（插件没刷新）时直接写本地存储
async function directPatch(fn) {
  const { [KEY]: raw = [] } = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: fn(raw.map(R.migrate)) });
}

function flash(text = "已自动保存") {
  const s = $("#saved");
  s.textContent = "✓ " + text;
  s.style.opacity = 1;
  clearTimeout(s._h);
  s._h = setTimeout(() => (s.style.opacity = 0), 1500);
}

// 改动先记在内存里，停顿 400 毫秒后保存（边填边存草稿）
function queuePatch(id, patch, now = false) {
  const cur = pending.get(id) || { patch: {} };
  Object.assign(cur.patch, patch);
  clearTimeout(cur.timer);
  pending.set(id, cur);
  if (now) return flushOne(id);
  cur.timer = setTimeout(() => flushOne(id), 400);
}
async function flushOne(id) {
  const cur = pending.get(id);
  if (!cur) return;
  pending.delete(id);
  clearTimeout(cur.timer);
  const r = await send({ type: "updateRecord", id, patch: cur.patch });
  if (!r)
    await directPatch((list) => {
      const x = list.find((y) => y.id === id);
      if (x) Object.assign(x, cur.patch);
      return list;
    });
  flash();
}
const flushAll = () => Promise.all([...pending.keys()].map(flushOne));
window.addEventListener("pagehide", flushAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushAll();
});

// ---------- 过滤 / 比价 ----------
function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const who = team ? $("#who").value : "mine";
  const src =
    who === "mine"
      ? logs
      : who === "team"
        ? teamRecs
        : allRecs()
            .slice()
            .sort((a, b) => b.time - a.time);
  return src.filter(
    (l) =>
      (!q ||
        [
          l.pn,
          l.company,
          l.qq,
          l.brand,
          l.note,
          l._by ? memberName(l._by) : "",
        ].some((v) =>
          String(v || "")
            .toLowerCase()
            .includes(q),
        )) &&
      (!$("#onlyValid").checked || l.valid),
  );
}

// 每个型号的有效报价里，未税单价最低的那条
function bestIds() {
  const best = {};
  for (const l of allRecs()) {
    if (!l.valid) continue;
    const p = R.netPrice(l);
    if (p == null) continue;
    const k = String(l.pn || "")
      .trim()
      .toUpperCase();
    if (!k) continue;
    if (!best[k] || p < best[k].p) best[k] = { id: l.id, p };
  }
  return new Set(Object.values(best).map((b) => b.id));
}

const netText = (l) => {
  if (l.tax !== "含税") return "";
  const p = R.netPrice(l);
  return p == null
    ? ""
    : "未税≈" + p.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
};

// ---------- 表格 ----------
function cell(l, f, cls, w, ph = "") {
  return `<td class="${cls}"><input class="${w}" data-f="${f}" aria-label="${esc(COLS.find(([key]) => key === f)?.[1] || "型号")}" value="${esc(l[f])}" placeholder="${l._ro ? "" : ph}" spellcheck="false" ${l._ro ? 'readonly tabindex="-1"' : ""}></td>`;
}

function rowHtml(l, best) {
  const C = cols;
  const qqTag = l.qqType
    ? `<span class="qqt ${l.qqType === "enterprise" ? "ent" : ""}">${l.qqType === "enterprise" ? "企业" : "私人"}</span>`
    : "";
  const ro = l._ro ? 'readonly tabindex="-1"' : "";
  return `<tr data-id="${esc(l.id)}" class="${l.valid ? "valid" : ""} ${best.has(l.id) ? "best" : ""} ${l._ro ? "ro" : ""}">
    ${C.time ? `<td class="time" title="${esc(new Date(l.time).toLocaleString("zh-CN", { hour12: false }))}${l.site === "bom" ? " · 正能量网" : l.site === "ic" ? " · IC交易网" : ""}">${fmtTime(l.time)}</td>` : ""}
    ${C.company ? cell(l, "company", "auto", "w-co") : ""}
    ${C.qq ? `<td class="auto" style="white-space:nowrap"><input class="w-qq" data-f="qq" aria-label="QQ 号码" value="${esc(l.qq)}" spellcheck="false" ${ro}>${qqTag}</td>` : ""}
    ${cell(l, "pn", "auto pn", "w-pn", "型号")}
    ${C.brand ? cell(l, "brand", "auto", "w-br") : ""}
    ${C.batch ? cell(l, "batch", "auto", "w-bt") : ""}
    ${C.qty ? cell(l, "qty", "fill", "w-qty", "数量") : ""}
    ${C.price ? `<td class="fill pricecell"><div class="price"><input class="w-pr" data-f="price" aria-label="单价" value="${esc(l.price)}" placeholder="${l._ro ? "" : "单价"}" inputmode="decimal" spellcheck="false" ${ro}><button type="button" class="taxbtn ${l.tax === "含税" ? "t1" : "t0"}" ${l._ro ? "disabled" : 'data-a="tax"'} tabindex="-1" title="点击切换未税 / 含税">${l.tax === "含税" ? "含税" : "未税"}</button><span class="best-tag">最低</span></div><div class="net">${netText(l)}</div></td>` : ""}
    ${C.goods ? `<td class="fill"><select class="w-gd" data-f="goods" ${l._ro ? "disabled" : ""}>${R.GOODS.map((g) => `<option ${g === l.goods ? "selected" : ""}>${g}</option>`).join("")}</select></td>` : ""}
    ${C.lead ? cell(l, "lead", "fill", "w-ld", "货期") : ""}
    ${C.note ? cell(l, "note", "auto", "w-nt", "备注") : ""}
    ${team && C.by ? `<td class="by">${l._ro ? `<span class="who">${esc(memberName(l._by))}</span>` : '<span class="who me">我</span>'}</td>` : ""}
    ${
      l._ro
        ? `<td class="ops muted">${l.valid ? '<span class="okmark">✓ 有效报价</span>' : "只读"}</td>`
        : `<td class="ops"><button type="button" class="ok-btn" data-a="ok" tabindex="-1" title="${l.valid ? "已标记为有效报价，再点一次取消" : "有货，标记为有效报价"}">✓</button>
      <button type="button" data-a="reset" tabindex="-1" title="把数量、价格、货品、货期恢复默认，不删除这一行">清除</button>
      <button type="button" class="del" data-a="del" tabindex="-1" title="删除这一行（点两次）">删除</button></td>`
    }
  </tr>`;
}

function render() {
  dirtyRender = false;
  const list = filtered();
  const valid = list.filter((l) => l.valid).length;
  $("#stats").textContent = `共 ${list.length} 条，其中 ${valid} 条有效报价`;
  if (!list.length) {
    $("#list").innerHTML =
      `<div class="empty">${logs.length ? "没有符合条件的记录" : "还没有询价记录。去 IC交易网或正能量网点对方的 QQ，这里会自动记下来。"}</div>`;
    return;
  }
  const best = bestIds();
  const C = cols;
  const head = [
    C.time && "<th>日期时间</th>",
    C.company && "<th>公司名</th>",
    C.qq && "<th>QQ</th>",
    "<th>型号</th>",
    C.brand && "<th>品牌</th>",
    C.batch && "<th>批次</th>",
    C.qty && '<th class="fill">数量</th>',
    C.price && '<th class="fill">价格</th>',
    C.goods && '<th class="fill">货品</th>',
    C.lead && '<th class="fill">货期</th>',
    C.note && "<th>备注</th>",
    team && C.by && "<th>记录人</th>",
    "<th>操作</th>",
  ]
    .filter(Boolean)
    .join("");
  const page = list.slice(0, shown);
  $("#list").innerHTML =
    `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${page.map((l) => rowHtml(l, best)).join("")}</tbody></table>
    ${list.length > shown ? `<div class="more"><button id="more">再显示 ${Math.min(PAGE, list.length - shown)} 条（还有 ${list.length - shown} 条）</button></div>` : ""}</div>`;
  const more = $("#more");
  if (more)
    more.onclick = () => {
      shown += PAGE;
      render();
    };
}

// 只刷新比价标记和统计，不重画表格（不打断输入）
function refreshMarks() {
  const best = bestIds();
  document.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
    const l =
      byId(tr.dataset.id) || teamRecs.find((x) => x.id === tr.dataset.id);
    if (!l) return;
    tr.classList.toggle("valid", !!l.valid);
    tr.classList.toggle("best", best.has(l.id));
    const net = tr.querySelector(".net");
    if (net) net.textContent = netText(l);
    const ok = tr.querySelector("[data-a=ok]");
    if (ok)
      ok.title = l.valid
        ? "已标记为有效报价，再点一次取消"
        : "有货，标记为有效报价";
  });
  const list = filtered();
  $("#stats").textContent =
    `共 ${list.length} 条，其中 ${list.filter((l) => l.valid).length} 条有效报价`;
}

const byId = (id) => logs.find((l) => l.id === id);
const rowOf = (el) => el.closest("tr[data-id]");

function toast(html, ms = 2600) {
  const t = $("#toast");
  t.innerHTML = html;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
  return t;
}

// ---------- 操作 ----------
function setField(l, f, v) {
  l[f] = v;
  const patch = { [f]: v };
  // 价格被删空，就不再是有效报价
  if (f === "price" && l.valid && !String(v).trim()) {
    l.valid = false;
    l.validAt = 0;
    patch.valid = false;
    patch.validAt = 0;
  }
  queuePatch(l.id, patch);
  refreshMarks();
}

function confirmValid(tr) {
  const l = byId(tr.dataset.id);
  if (!l) return;
  if (l.valid) {
    l.valid = false;
    l.validAt = 0;
    queuePatch(l.id, { valid: false, validAt: 0 }, true);
    refreshMarks();
    return;
  }
  if (R.netPrice(l) == null) {
    toast("请先填价格");
    const p = tr.querySelector("[data-f=price]");
    if (p) p.focus();
    return;
  }
  l.valid = true;
  l.validAt = Date.now();
  queuePatch(
    l.id,
    {
      valid: true,
      validAt: l.validAt,
      qty: l.qty,
      price: l.price,
      tax: l.tax,
      goods: l.goods,
      lead: l.lead,
    },
    true,
  );
  refreshMarks();
  flash("已标记为有效报价");
}

function resetRow(tr) {
  const l = byId(tr.dataset.id);
  if (!l) return;
  const before = {
    qty: l.qty,
    price: l.price,
    tax: l.tax,
    goods: l.goods,
    lead: l.lead,
    valid: l.valid,
    validAt: l.validAt,
  };
  const d = {
    qty: "",
    price: "",
    tax: "未税",
    goods: "原装",
    lead: "现货",
    valid: false,
    validAt: 0,
  };
  Object.assign(l, d);
  queuePatch(l.id, d, true);
  render();
  const t = toast('已清除这一行填写的内容 <a id="undo">撤销</a>', 5000);
  t.querySelector("#undo").onclick = () => {
    Object.assign(l, before);
    queuePatch(l.id, before, true);
    t.classList.remove("show");
    render();
  };
}

async function deleteRow(tr, btn) {
  const l = byId(tr.dataset.id);
  if (!l) return;
  // 点一次变成 （3 秒内再点一次才删除），不弹确认框
  if (btn && !btn.classList.contains("armed")) {
    document.querySelectorAll("button.del.armed").forEach((x) => {
      x.classList.remove("armed");
      x.textContent = "";
    });
    btn.classList.add("armed");
    btn.textContent = "";
    btn.title = "再点一次删除";
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.classList.remove("armed");
      btn.textContent = "";
      btn.title = "删除这一行（点两次）";
    }, 3000);
    return;
  }
  pending.delete(l.id);
  logs = logs.filter((x) => x.id !== l.id);
  render();
  if (!(await send({ type: "deleteRecord", id: l.id })))
    await directPatch((list) => list.filter((x) => x.id !== l.id));
}

// 输入：边填边存
$("#list").addEventListener("input", (e) => {
  const f = e.target.dataset.f;
  const tr = rowOf(e.target);
  if (!f || !tr) return;
  const l = byId(tr.dataset.id);
  if (l) setField(l, f, e.target.value);
});
$("#list").addEventListener("change", (e) => {
  if (e.target.tagName === "SELECT") {
    const tr = rowOf(e.target);
    const l = tr && byId(tr.dataset.id);
    if (l) setField(l, e.target.dataset.f, e.target.value);
  }
});
$("#list").addEventListener("focusout", (e) => {
  const tr = rowOf(e.target);
  if (tr && pending.has(tr.dataset.id)) flushOne(tr.dataset.id);
  // 离开表格后再处理外部更新
  setTimeout(() => {
    if (dirtyRender && !document.activeElement.closest("#list")) render();
  }, 0);
  // 修剪首尾空格
  if (
    e.target.dataset &&
    e.target.dataset.f &&
    e.target.value !== e.target.value.trim()
  ) {
    e.target.value = e.target.value.trim();
    const l = tr && byId(tr.dataset.id);
    if (l) setField(l, e.target.dataset.f, e.target.value);
  }
});

$("#list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const tr = rowOf(b);
  if (!tr) return;
  const a = b.dataset.a;
  if (a === "ok") confirmValid(tr);
  else if (a === "reset") resetRow(tr);
  else if (a === "del") deleteRow(tr, b);
  else if (a === "tax") {
    const l = byId(tr.dataset.id);
    l.tax = l.tax === "含税" ? "未税" : "含税";
    b.textContent = l.tax;
    b.className = `taxbtn ${l.tax === "含税" ? "t1" : "t0"}`;
    setField(l, "tax", l.tax);
  }
});

// 键盘：回车 / Tab 下一格，↑↓ 上下行，价格格回车 = ✓
const fields = (tr) => [...tr.querySelectorAll("[data-f]")];
$("#list").addEventListener("keydown", (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.f) return;
  const tr = rowOf(el);
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    if (el.dataset.f === "price") {
      confirmValid(tr);
      return;
    }
    const fs = fields(tr);
    const next = fs[fs.indexOf(el) + 1];
    if (next) next.focus();
    else {
      const nr = tr.nextElementSibling;
      const t = nr && nr.querySelector(`[data-f="${fs[0].dataset.f}"]`);
      if (t) t.focus();
    }
    if (document.activeElement.select) document.activeElement.select();
  } else if (
    (e.key === "ArrowDown" || e.key === "ArrowUp") &&
    el.tagName === "INPUT" &&
    !e.isComposing
  ) {
    const nr =
      e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
    const t = nr && nr.querySelector(`[data-f="${el.dataset.f}"]`);
    if (t) {
      e.preventDefault();
      t.focus();
      t.select();
    }
  }
});
$("#list").addEventListener("focusin", (e) => {
  if (
    e.target.tagName === "INPUT" &&
    e.target.closest("td.fill") &&
    e.target.select
  )
    e.target.select();
});

// ---------- 工具栏 ----------
$("#q").oninput = () => {
  shown = PAGE;
  render();
};
$("#onlyValid").onchange = () => {
  shown = PAGE;
  render();
};
$("#who").onchange = () => {
  shown = PAGE;
  render();
};
$("#teamSync").onclick = async (e) => {
  e.target.disabled = true;
  e.target.textContent = "同步中…";
  const r = await send({ type: "teamSync", force: true, why: "记录本手动" });
  e.target.disabled = false;
  e.target.textContent = "⟳ 同步团队";
  flash(
    r && r.ok
      ? `同步完成：上传 ${r.sent || 0} 条，收到 ${r.got || 0} 条`
      : "同步失败：" + ((r && r.error) || "后台没有响应"),
  );
};
$("#teamOpen").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("team.html") });
document.querySelectorAll("[data-col]").forEach(
  (c) =>
    (c.onchange = async () => {
      cols[c.dataset.col] = c.checked;
      await chrome.storage.local.set({ [COLS_KEY]: cols });
      render();
    }),
);

$("#add").onclick = async () => {
  const item = R.create({ pn: $("#q").value.trim(), action: "手动新增" });
  logs.unshift(item);
  await directPatch((list) => [item, ...list]);
  await send({ type: "recordCreated", id: item.id });
  $("#onlyValid").checked = false;
  render();
  const tr = document.querySelector(`tr[data-id="${item.id}"]`);
  if (tr) {
    tr.classList.add("flash");
    const f =
      tr.querySelector("[data-f=company]") || tr.querySelector("[data-f=pn]");
    f.focus();
  }
};

$("#export").onclick = async () => {
  await flushAll();
  const yes = (v) => (v ? "是" : "");
  const defs = [
    cols.time && [
      "日期时间",
      (l) => new Date(l.time).toLocaleString("zh-CN", { hour12: false }),
    ],
    cols.company && ["公司名", (l) => l.company],
    cols.qq && ["QQ", (l) => l.qq],
    cols.qq && [
      "QQ类型",
      (l) => (l.qqType === "enterprise" ? "企业" : l.qqType ? "私人" : ""),
    ],
    ["型号", (l) => l.pn],
    cols.brand && ["品牌", (l) => l.brand],
    cols.batch && ["批次", (l) => l.batch],
    cols.qty && ["数量", (l) => l.qty],
    cols.price && ["价格", (l) => l.price],
    cols.price && ["未税/含税", (l) => (l.price !== "" ? l.tax : "")],
    cols.price && [
      "未税单价",
      (l) => {
        const p = R.netPrice(l);
        return p == null ? "" : +p.toFixed(4);
      },
    ],
    cols.goods && ["货品", (l) => l.goods],
    cols.lead && ["货期", (l) => l.lead],
    ["有效报价", (l) => yes(l.valid)],
    team &&
      cols.by && [
        "记录人",
        (l) => (l._ro ? memberName(l._by) : team.myName || "我"),
      ],
    cols.note && ["备注", (l) => l.note],
  ].filter(Boolean);
  const rows = filtered().map((l) => defs.map(([, f]) => f(l)));
  const csv = CaixinBackup.csv([defs.map(([h]) => h), ...rows]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `询价记录_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$("#clear").onclick = async () => {
  if (
    !confirm(
      `确定清空全部 ${logs.length} 条本机记录？已共享的记录也会排队撤回，离线时需恢复同步后才生效；同事已下载的副本无法追回。建议先导出备份。`,
    )
  )
    return;
  pending.clear();
  logs = [];
  render();
  if (!(await send({ type: "clearRecords" })))
    await chrome.storage.local.set({ [KEY]: [] });
};

// 其他页面新增了记录（比如刚在 IC交易网点了 QQ）
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  // 队友的记录有更新
  if (c.cxTeam || c.cxTeamRecords) {
    chrome.storage.local.get(["cxTeam", "cxTeamRecords"]).then((g) => {
      loadTeam(g.cxTeam, g.cxTeamRecords);
      if (document.activeElement && document.activeElement.closest("#list")) {
        dirtyRender = true;
        return;
      }
      render();
    });
  }
  if (!c[KEY]) return;
  const incoming = (c[KEY].newValue || []).map(R.migrate);
  // 还没保存的改动叠加上去，避免被覆盖
  for (const r of incoming) {
    const p = pending.get(r.id);
    if (p) Object.assign(r, p.patch);
  }
  const sig = (arr) => arr.map((r) => r.id + r.time).join();
  const changedRows = sig(incoming) !== sig(logs);
  logs = incoming;
  if (!changedRows) return refreshMarks(); // 只是自己保存的内容
  if (document.activeElement && document.activeElement.closest("#list")) {
    dirtyRender = true;
    return;
  }
  render();
});

load();
send({ type: "teamSync", why: "打开记录本" });

function downloadBackup(name, text, type) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#backup").onclick = async () => {
  await flushAll();
  downloadBackup(
    "caixin-records-" + new Date().toISOString().slice(0, 10) + ".json",
    JSON.stringify({ format: "caixin-records-v1", records: logs }, null, 2),
    "application/json",
  );
};
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5242880) throw new Error("文件不能超过 5 MB");
    const imported = CaixinBackup.parse(await file.text());
    if (logs.length + imported.length > 5000)
      throw new Error("合并后超过 5000 条，请先整理现有记录");
    if (
      !confirm(
        "导入 " +
          imported.length +
          " 条记录并追加到本机？不会自动共享这些历史记录",
      )
    )
      return;
    await flushAll();
    await directPatch((list) => [...imported, ...list]);
    await load();
    flash("已导入 " + imported.length + " 条记录");
  } catch (err) {
    alert("导入失败：" + err.message);
  } finally {
    e.target.value = "";
  }
};
