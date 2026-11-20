// 采芯助手 · 库存价格监控页面
// 单个商品：排得像商城的商品行（图片、型号、品牌、封装、编号、价格梯度、库存），每个数字旁边并排“加入时 → 现在”
// 型号汇总：每个网站一行，库存合计和最低价的加入时 / 上次 / 现在
const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const SITE_ORDER = ["szlcsc", "ickey", "bomman", "digikey", "mouser"];
const LABEL = {
  szlcsc: "立创商城",
  ickey: "云汉芯城",
  bomman: "圣禾堂",
  digikey: "得捷",
  mouser: "贸泽",
};
const FROM = { ic: "IC交易网", bom: "正能量网", hqew: "华强电子网", ...LABEL };
const SRC_OFF_DEFAULT = ["mouser", "digikey"];
const fmtN = (n) => Number(n || 0).toLocaleString("zh-CN");
const fmtP = (p) =>
  p > 0
    ? "¥" +
      (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4)).replace(
        /\.?0+$/,
        "",
      )
    : "-";
const pad = (n) => String(n).padStart(2, "0");
const wid = (w) =>
  w.id ||
  "pn|" +
    String(w.pn || "")
      .trim()
      .toUpperCase();
function when(t) {
  if (!t) return "-";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return (
    (today ? "今天 " : `${d.getMonth() + 1}/${d.getDate()} `) +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
function rel(t) {
  const m = Math.round((t - Date.now()) / 60e3);
  if (m <= 0) return "马上";
  if (m < 60) return `${m} 分钟后`;
  const h = Math.floor(m / 60);
  return `${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}后`;
}
const pnParam = new URLSearchParams(location.search).get("pn") || "";
let filter = "all";
let scrolled = false;

// 库存变化：+4,800（绿）/ −28（红）
function stockChip(a, b) {
  if (!a || !b) return "";
  const d = (b.stock || 0) - (a.stock || 0);
  if (!d) return "";
  return `<span class="chip ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${fmtN(Math.abs(d))}</span>`;
}
function pctOf(a, b) {
  return a > 0 && b > 0 ? ((b - a) / a) * 100 : 0;
}
function changed(a, b) {
  if (!a || !b) return false;
  if ((a.missing || false) !== (b.missing || false)) return true;
  if ((a.stock || 0) !== (b.stock || 0)) return true;
  if (Math.abs(pctOf(a.price, b.price)) >= 0.1) return true;
  return (b.ladder || []).some(([q, p]) => {
    const o = (a.ladder || []).find((x) => x[0] === q);
    return o && Math.abs(pctOf(o[1], p)) >= 0.1;
  });
}
// 型号监控：任何一个网站和加入时不一样
function pnChanged(w) {
  const f = w.first || {};
  const l = w.last || {};
  return Object.keys(l).some((k) => f[k] && changed(f[k], l[k]));
}
const hasChange = (w) =>
  w.kind === "item" ? changed(w.first, w.last) : pnChanged(w);

function highlight(model, pn) {
  const m = String(model || pn || "");
  const i = m.toUpperCase().indexOf(String(pn || "").toUpperCase());
  if (!pn || i < 0) return esc(m);
  return (
    esc(m.slice(0, i)) +
    "<mark>" +
    esc(m.slice(i, i + pn.length)) +
    "</mark>" +
    esc(m.slice(i + pn.length))
  );
}

function stripHtml(w, ch, extra) {
  const err = w.lastError && w.lastError > (w.lastCheck || 0);
  return `<div class="strip">
    <span class="site">${extra}</span>
    ${err ? '<span class="badge b-err">上次检查没取到数据</span>' : ch ? '<span class="badge b-chg">有变化</span>' : '<span class="badge b-same">无变化</span>'}
    <span>加入于 ${when(w.addedAt)}</span><span>·</span><span>最新数据 ${when(w.lastCheck)}</span>
    ${w.lastChange ? `<span>·</span><span>最近一次变化 ${when(w.lastChange)}</span>` : ""}
    <span class="grow"></span>
    <button data-rm="${esc(wid(w))}">移出监控</button>
  </div>`;
}

function itemCard(w, evs) {
  const info = w.info || {};
  const f = w.first || null;
  const p = w.prev || null;
  const l = w.last || null;
  const ch = changed(f, l);
  const url = (l && l.url) || info.url || "";
  // 价格梯度：按现在的档位，配上加入时同一档的价格
  const qs = [];
  for (const [q] of [...((l && l.ladder) || []), ...((f && f.ladder) || [])])
    if (!qs.includes(q)) qs.push(q);
  qs.sort((a, b) => a - b);
  const lad = qs
    .slice(0, 8)
    .map((q) => {
      const a = ((f && f.ladder) || []).find((x) => x[0] === q);
      const b = ((l && l.ladder) || []).find((x) => x[0] === q);
      const pc = a && b ? pctOf(a[1], b[1]) : 0;
      const cls = Math.abs(pc) >= 0.1 ? (pc < 0 ? "down" : "up") : "";
      return `<tr><td class="q">${fmtN(q)}+</td><td class="was">${a ? fmtP(a[1]) : "-"}</td><td class="now ${cls}">${b ? fmtP(b[1]) : "-"}${cls ? `<span class="pct">${pc < 0 ? "↓" : "↑"}${Math.abs(pc).toFixed(1)}%</span>` : ""}</td></tr>`;
    })
    .join("");
  const priceBox = lad
    ? `<table class="lad"><thead><tr><th>数量</th><th>加入时</th><th>现在</th></tr></thead><tbody>${lad}</tbody></table>`
    : `<div class="hist">单价：<s>${fmtP(f && f.price)}</s> → <b>${fmtP(l && l.price)}</b></div>`;
  const stockNow = l
    ? l.missing
      ? '<span class="stock-now zero">找不到了</span>'
      : `<span class="stock-now ${l.stock ? "" : "zero"}">${fmtN(l.stock)}</span>${stockChip(f, l)}`
    : '<span class="same">暂未取到</span>';
  const d1 = p && l ? (l.stock || 0) - (p.stock || 0) : 0;
  const tag = info.code
    ? `编号 ${esc(info.code)}`
    : info.channel
      ? esc(info.channel)
      : "";
  return `<div class="card2 ${ch ? "chg" : ""} ${pnParam && w.pn.toUpperCase() === pnParam.toUpperCase() ? "hl" : ""}" data-pn="${esc(w.pn)}">
    ${stripHtml(w, ch, `${LABEL[w.site] || w.site} <span class="badge b-src">单个商品</span>${tag ? ` <span class="muted">${tag}</span>` : ""}`)}
    <div class="main">
      ${info.img ? `<img class="pic" src="${esc(info.img)}" alt="" referrerpolicy="no-referrer">` : '<div class="nopic">无图片</div>'}
      <div>
        <div class="model">${url ? `<a href="${esc(url)}" target="_blank" title="打开${LABEL[w.site]}商品页">${highlight(info.model, w.pn)} ↗</a>` : highlight(info.model, w.pn)}</div>
        <div class="meta">
          ${info.brand ? `品牌：<b>${esc(info.brand)}</b><br>` : ""}
          ${info.pkg ? `封装：<b>${esc(info.pkg)}</b><br>` : ""}
          ${info.batch ? `批次：<b>${esc(info.batch)}</b><br>` : ""}
          ${info.code ? `编号：<b>${esc(info.code)}</b><br>` : ""}
          ${info.channel ? `渠道：<b>${esc(info.channel)}</b><br>` : ""}
          ${info.category ? `类目：<b>${esc(info.category)}</b>` : ""}
        </div>
      </div>
      <div><div class="h">价格梯度${info.priceNote ? `（${esc(info.priceNote)}）` : ""}</div>${priceBox}</div>
      <div>
        <div class="h">库存</div>
        ${stockNow}
        <div class="hist">
          加入时：${f ? (f.missing ? "找不到" : fmtN(f.stock)) : "-"}<br>
          上次检查：${p ? `${p.missing ? "找不到" : fmtN(p.stock)}${d1 ? ` → <span class="${d1 > 0 ? "up" : "down"}">${d1 > 0 ? "+" : "−"}${fmtN(Math.abs(d1))}</span>` : ""}` : '<span class="same">还没检查过</span>'}
          ${info.delivery ? `<br>${esc(info.delivery)}` : ""}${info.pack ? `<br>${esc(info.pack)}` : ""}
        </div>
      </div>
    </div>
    ${evs.length ? `<div class="ev">${evs.map((e) => `<div> ${when(e.time)}　${esc(e.changes.join("；"))}</div>`).join("")}</div>` : ""}
  </div>`;
}

function pnCard(w, evs, enabled) {
  const sites = (
    Array.isArray(w.sites) && w.sites.length ? w.sites : enabled
  ).filter((k) => LABEL[k]);
  const f = w.first || {};
  const p = w.prev || {};
  const l = w.last || {};
  const ch = pnChanged(w);
  const rows = SITE_ORDER.filter((k) => sites.includes(k))
    .map((k) => {
      const a = f[k];
      const b = l[k];
      const url = (b && b.url) || (a && a.url) || "";
      const d = a && b ? b.stock - a.stock : 0;
      const pc = a && b ? pctOf(a.price, b.price) : 0;
      const pcls =
        Math.abs(pc) >= 0.1 ? (pc < 0 ? "cell-up" : "cell-down") : "";
      return `<tr>
      <td>${url ? `<a href="${esc(url)}" target="_blank">${LABEL[k]} ↗</a>` : `<b>${LABEL[k]}</b>`}</td>
      <td class="same">${a ? fmtN(a.stock) : "-"}</td>
      <td class="${d ? (d > 0 ? "cell-up" : "cell-down") : ""}">${b ? fmtN(b.stock) : "暂未取到"}${d ? `<span class="pct">${d > 0 ? "+" : "−"}${fmtN(Math.abs(d))}</span>` : ""}</td>
      <td class="same">${a ? fmtP(a.price) : "-"}</td>
      <td class="${pcls}">${b ? fmtP(b.price) : "-"}${pcls ? `<span class="pct">${pc < 0 ? "↓" : "↑"}${Math.abs(pc).toFixed(1)}%</span>` : ""}</td>
      <td class="same">${w.prevCheck && p[k] ? `${fmtN(p[k].stock)} / ${fmtP(p[k].price)}` : "-"}</td>
      <td><button class="x" data-rmsite="${esc(wid(w))}" data-site="${k}" title="不再查${LABEL[k]}">×</button></td>
    </tr>`;
    })
    .join("");
  return `<div class="card2 ${ch ? "chg" : ""} ${pnParam && w.pn.toUpperCase() === pnParam.toUpperCase() ? "hl" : ""}" data-pn="${esc(w.pn)}">
    ${stripHtml(w, ch, `<span class="model" style="font-size:15px">${esc(w.pn)}</span> <span class="badge b-src">型号汇总${w.from ? ` · 在${esc(FROM[w.from] || w.from)}加入` : ""}</span>`)}
    <div style="padding:6px 16px 10px">
      <table class="sites">
        <thead><tr><th>网站</th><th>加入时库存</th><th>现在库存</th><th>加入时最低价</th><th>现在最低价</th><th>上次检查（库存 / 最低价）</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="same">没有要查的网站</td></tr>'}</tbody>
      </table>
      <div class="muted" style="margin-top:4px">库存是这个型号在该网站所有货源的合计（含合作库存），最低价是所有货源里最低的一档。只想盯某一条货源，请到那个网站的商品旁点“ 监控”。</div>
    </div>
    ${evs.length ? `<div class="ev">${evs.map((e) => `<div> ${when(e.time)}　${esc(e.changes.join("；"))}</div>`).join("")}</div>` : ""}
  </div>`;
}

async function render() {
  const {
    watches = [],
    watchEvents = [],
    settings = {},
    watchLastRun = 0,
    watchRunning,
  } = await chrome.storage.local.get([
    "watches",
    "watchEvents",
    "settings",
    "watchLastRun",
    "watchRunning",
  ]);
  const minutes = Number(settings.watchMinutes) || 120;
  $("#minutes").value = String(minutes);
  $("#nWatch").textContent = watches.length;
  $("#nChg").textContent = watches.filter(hasChange).length;
  $("#lastRun").textContent = when(watchLastRun);
  const alarms = await Promise.all(
    ["watch", "watchCatchUp"].map((n) => chrome.alarms.get(n)),
  );
  const next = alarms
    .filter(Boolean)
    .map((a) => a.scheduledTime)
    .sort((a, b) => a - b)[0];
  $("#nextRun").textContent = watches.length
    ? next
      ? `${when(next)}（${rel(next)}）`
      : "浏览器重新打开后"
    : "-";
  $("#running").textContent = watchRunning
    ? `正在检查 ${Math.min(watchRunning.done + 1, watchRunning.total)} / ${watchRunning.total}…（会短暂打开后台标签页）`
    : "";
  $("#checkNow").disabled = !!watchRunning;
  $("#checkNow").textContent = watchRunning ? "检查中…" : "立即检查";

  const off = settings.sources || {};
  const enabled = SITE_ORDER.filter((k) =>
    off[k] === undefined ? !SRC_OFF_DEFAULT.includes(k) : off[k] !== false,
  );
  const q = $("#q").value.trim().toUpperCase();
  const list = watches
    .filter((w) => !q || w.pn.toUpperCase().includes(q))
    .filter(
      (w) =>
        filter === "all" ||
        (filter === "chg"
          ? hasChange(w)
          : filter === "item"
            ? w.kind === "item"
            : w.kind !== "item"),
    )
    .sort(
      (a, b) =>
        hasChange(b) - hasChange(a) ||
        (b.lastChange || 0) - (a.lastChange || 0) ||
        (b.addedAt || 0) - (a.addedAt || 0),
    );
  if (!watches.length) {
    $("#list").innerHTML =
      `<div class="empty">还没有监控的商品或型号。<br>在立创、云汉、圣禾堂、贸泽、得捷的商品旁边点“ 监控”，只盯那一条商品；<br>在 IC交易网 / 正能量网 / 华强电子网的货源对比条上点“ 加入库存价格监控”，查这个型号在各网站的合计。</div>`;
  } else {
    $("#list").innerHTML =
      list
        .map((w) => {
          const evs = watchEvents
            .filter((e) =>
              e.id
                ? e.id === wid(w)
                : w.kind !== "item" &&
                  e.pn.toUpperCase() === w.pn.toUpperCase(),
            )
            .slice(0, 3);
          return w.kind === "item" ? itemCard(w, evs) : pnCard(w, evs, enabled);
        })
        .join("") || '<div class="empty">没有符合条件的监控</div>';
  }
  $("#nEv").textContent = watchEvents.length;
  $("#hist").innerHTML = watchEvents.length
    ? watchEvents
        .map(
          (e) =>
            `<div class="e"><span class="t">${when(e.time)}</span><b>${esc(e.pn)}</b>　${esc(e.changes.join("；"))}</div>`,
        )
        .join("") +
      '<p style="margin:10px 0 0"><button id="clearEv">清空提醒记录</button></p>'
    : '<p class="muted">还没有提醒记录</p>';
  const ce = $("#clearEv");
  if (ce)
    ce.onclick = async () => {
      if (confirm("清空全部提醒记录？监控本身不受影响。")) {
        await chrome.storage.local.set({ watchEvents: [] });
        render();
      }
    };

  document.querySelectorAll("[data-rm]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("把这一条移出库存价格监控？")) return;
        b.disabled = true;
        await chrome.runtime.sendMessage({
          type: "removeWatch",
          id: b.dataset.rm,
        });
        render();
      }),
  );
  document.querySelectorAll("[data-rmsite]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        await chrome.runtime.sendMessage({
          type: "removeWatch",
          id: b.dataset.rmsite,
          site: b.dataset.site,
        });
        render();
      }),
  );
  if (pnParam && !scrolled) {
    const el = [...document.querySelectorAll(".card2[data-pn]")].find(
      (x) => x.dataset.pn.toUpperCase() === pnParam.toUpperCase(),
    );
    if (el) {
      el.scrollIntoView({ block: "center" });
      scrolled = true;
    }
  }
}

$("#minutes").onchange = async (e) => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: { ...settings, watchMinutes: Number(e.target.value) },
  });
  setTimeout(render, 300); // 后台按新间隔重新排定时
};
$("#checkNow").onclick = async () => {
  const { watches = [] } = await chrome.storage.local.get("watches");
  if (!watches.length) return alert("还没有监控的商品或型号。");
  $("#checkNow").disabled = true;
  $("#checkNow").textContent = "检查中…";
  chrome.runtime.sendMessage({ type: "checkWatchesNow" }).then(render);
};
$("#testNotify").onclick = () =>
  chrome.runtime.sendMessage({ type: "watchTest" });
$("#q").oninput = render;
document.querySelectorAll("#tabs button").forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.f;
      document
        .querySelectorAll("#tabs button")
        .forEach((x) => x.classList.toggle("on", x === b));
      render();
    }),
);
chrome.storage.onChanged.addListener((c, area) => {
  if (
    area === "local" &&
    (c.watches ||
      c.watchEvents ||
      c.watchRunning ||
      c.watchLastRun ||
      c.settings)
  )
    render();
});
setInterval(render, 60e3); // “下次检查”的倒计时
render();
