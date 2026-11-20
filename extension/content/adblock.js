// 采芯助手 · 其他网站去广告（跟随插件弹窗里的“隐藏广告”开关，默认关闭）
(() => {
  const RULES = {
    "bom.ai": {
      hide: [
        ".bom_banner_text", // 搜索框右边的文字广告（进口报关…）
        ".bom_banner_img_container", // 搜索结果上方的横幅
        "section.bom_content_th", // 右侧整列广告
        ".bom_bottom_adverts_container", // 底部广告
        ".view_rightbottom_ad", // 右下角浮动广告
      ],
      // 右侧广告列去掉后，左侧内容铺满
      extra:
        "article.bom_content_rl section.bom_content_l { width: 100% !important; float: none !important; }",
    },
    "hqew.com": {
      hide: [
        ".kw-adver-ul", // 搜索框右边的型号广告
        ".advertising-box", // 搜索结果上方的大横幅
        "#ad_bot", // 结果底部的横幅
      ],
    },
  };
  const host = Object.keys(RULES).find(
    (h) => location.hostname === h || location.hostname.endsWith("." + h),
  );
  if (!host) return;
  const rule = RULES[host];

  function apply(on) {
    let st = document.getElementById("cxm-adblock");
    if (!on) {
      if (st) st.remove();
      return;
    }
    if (!st) {
      st = document.createElement("style");
      st.id = "cxm-adblock";
      document.documentElement.appendChild(st);
    }
    st.textContent = `${rule.hide.join(",\n")} { display: none !important; }\n${rule.extra || ""}`;
  }

  CxPage.get("settings").then(({ settings }) => {
    const on = !!(settings && settings.hideAds);
    apply(on);
    if (on)
      chrome.runtime
        .sendMessage({
          type: "dlog",
          cat: "去广告",
          msg: `${host}：已隐藏广告（${rule.hide.length} 类）`,
        })
        .catch(() => {});
  });
  CxPage.onChanged((c, area) => {
    if (area === "local" && c.settings)
      apply(!!(c.settings.newValue && c.settings.newValue.hideAds));
  });
})();
