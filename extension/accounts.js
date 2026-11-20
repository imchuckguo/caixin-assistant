const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const t = (x) =>
  new Date(x).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

// site：对应货源查询的 key；没有 site 的只提供登录入口
const SITES = [
  {
    site: "szlcsc",
    name: "立创商城",
    home: "https://www.szlcsc.com/",
    desc: "未登录时连续查询几次就会要求登录，建议保持登录",
  },
  {
    site: "ickey",
    name: "云汉芯城",
    home: "https://www.ickey.cn/",
    desc: "部分货源登录后才显示价格",
  },
  {
    site: "bomman",
    name: "圣禾堂",
    home: "https://www.bomman.com/",
    desc: "部分价格登录后才显示",
  },
  {
    site: "mouser",
    name: "贸泽 Mouser",
    home: "https://www.mouser.cn/",
    desc: "首次访问可能需要通过人机验证",
  },
  {
    site: "digikey",
    name: "得捷 Digi-Key",
    home: "https://www.digikey.cn/",
    desc: "有 Cloudflare 人机验证：先点“去登录”打开一次，通过验证后插件才能读取",
  },
  {
    site: "taobao",
    name: "淘宝",
    home: "https://www.taobao.com/",
    desc: "必须登录才能看到搜索结果；遇到滑块验证需要你自己完成",
  },
  {
    name: "TI 官网",
    home: "https://www.ti.com.cn/",
    desc: "库存和价格登录后才显示；插件只提供跳转链接",
  },
  {
    name: "IC交易网",
    home: "https://www.ic.net.cn/",
    desc: "搜索结果需要登录；库存提醒也需要保持登录",
  },
  {
    name: "华强电子网",
    home: "https://passport.hqew.com/",
    desc: "搜索结果需要登录才能看到",
  },
  ...((self.ICM_BUILD || {}).marks === false
    ? []
    : [
        {
          name: "火眼甄芯",
          home: "https://www.iczhenxin.com/",
          desc: "原装会员名单需要登录查看",
        },
      ]),
];

const state = {};

async function lastResult(site) {
  const { debugLog = [] } = await chrome.storage.local.get("debugLog");
  return debugLog.find(
    (x) =>
      x.cat === "货源" &&
      x.msg.startsWith(SITES.find((s) => s.site === site).name.split(" ")[0]) &&
      /条货源|查询失败/.test(x.msg),
  );
}

async function render() {
  const rows = await Promise.all(
    SITES.map(async (s) => {
      let st = '<div class="st unk">只能手动登录，插件不查询这个网站</div>';
      if (s.site) {
        const cur = state[s.site];
        if (cur === "loading")
          st =
            '<div class="st unk">测试中…（可能会短暂打开一个后台标签页）</div>';
        else if (cur)
          st = cur.ok
            ? `<div class="st ok"> 可以查到：${cur.count} 条货源，库存 ${cur.stock.toLocaleString("zh-CN")}${cur.minPrice ? "，¥" + cur.minPrice + " 起" : "（没有读到价格，可能需要登录）"}</div>`
            : `<div class="st bad">❌ 查询失败：${esc(cur.error)}。请点“去登录”或在该网站完成验证后再试</div>`;
        else {
          const l = await lastResult(s.site);
          st = l
            ? `<div class="st ${l.level === "ok" ? "ok" : "bad"}">上次（${t(l.t)}）：${esc(l.msg)}</div>`
            : '<div class="st unk">还没有查询过</div>';
        }
      }
      return `<div class="site"><div><div class="n">${s.name}</div><div class="d">${s.desc}</div>${st}</div>
      <div class="ops"><a class="btn" href="${s.home}" target="_blank" rel="noopener">去登录 ↗</a>${s.site ? `<button data-test="${s.site}">测试查询</button>` : ""}</div></div>`;
    }),
  );
  $("#sites").innerHTML = rows.join("");
  document.querySelectorAll("[data-test]").forEach(
    (b) =>
      (b.onclick = async () => {
        const site = b.dataset.test;
        state[site] = "loading";
        render();
        const r = await chrome.runtime
          .sendMessage({
            type: "lookup",
            site,
            pn: $("#testPn").value.trim() || "STM32F103C8T6",
            force: true,
          })
          .catch(() => null);
        state[site] = r || {
          ok: false,
          error: "后台没有响应，请到 chrome://extensions 刷新插件",
        };
        render();
      }),
  );
}
render();
