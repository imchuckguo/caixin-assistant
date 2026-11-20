// 采芯助手 · 腾讯企点跳转页：读取跳转结果，判断 QQ 是否能直接发起会话
(() => {
  const uinFromUrl = () =>
    ((location.hash + location.search).match(/[?&#]uin=(\d+)/) || [])[1] || "";
  let reported = false;

  function banner(html) {
    let b = document.getElementById("cxm-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "cxm-banner";
      b.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 16px;text-align:center;" +
        'font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#fff;' +
        "background:#087f68;box-shadow:0 6px 20px rgba(0,0,0,.15)";
      document.documentElement.appendChild(b);
    }
    b.innerHTML = html;
    return b;
  }

  function report(outcome) {
    if (reported) return;
    reported = true;
    const qq = uinFromUrl();
    chrome.runtime
      .sendMessage({ type: "chatOutcome", outcome, qq })
      .then((r) => {
        const num = (r && r.qq) || qq;
        if (outcome === "personal" && num) {
          const b = banner(
            `采芯助手：<b>${num}</b> 是私人 QQ，需要先加好友。已记录，以后会直接复制号码。 <button id="cxm-copy" style="margin-left:8px;border:0;border-radius:6px;padding:3px 10px;cursor:pointer">复制 QQ 号</button>`,
          );
          b.querySelector("#cxm-copy").onclick = async () => {
            await navigator.clipboard.writeText(num).catch(() => {});
            b.querySelector("#cxm-copy").textContent = "已复制 ✓";
          };
        } else if (outcome === "enterprise") {
          banner("采芯助手：企业 QQ，正在唤起 QQ 会话…（本页稍后自动关闭）");
        }
      })
      .catch(() => {});
  }

  function check() {
    const text = document.body ? document.body.innerText : "";
    if (/无法发起临时会话|未开通临时会话/.test(text))
      return (report("personal"), true);
    if (/该链接会唤起QQ/.test(text)) return (report("enterprise"), true);
    if (/qr-code-jump/.test(location.pathname))
      return (report("enterprise"), true);
    return false;
  }

  if (!check()) {
    const ob = new MutationObserver(() => {
      if (check()) ob.disconnect();
    });
    ob.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    setTimeout(() => ob.disconnect(), 15000);
  }
})();
