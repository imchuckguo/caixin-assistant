const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let state = { connected: false };
const send = (m) => chrome.runtime.sendMessage(m);
function message(s, error = false) {
  $("#message").textContent = s;
  $("#message").className = "dialog-status " + (error ? "err" : "ok");
}
async function run(fn) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const r = await fn();
    if (r?.ok === false) throw new Error(r.error || "操作失败");
    message("操作已完成");
    await render();
    return r;
  } catch (e) {
    message(e.message || "操作未完成", true);
  } finally {
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}
async function render() {
  state = await send({ type: "teamState" });
  $("#connect").classList.toggle("hidden", state.connected);
  $("#connected").classList.toggle("hidden", !state.connected);
  if (!state.connected) return;
  $("#teamTitle").textContent = state.name;
  $("#summary").textContent =
    `${state.endpoint} · ${state.paused ? "已暂停" : "已连接"} · ${state.queued} 条待处理 · ${state.lastSync ? "上次同步 " + new Date(state.lastSync).toLocaleString("zh-CN") : "尚未同步"}${state.lastError ? " · " + state.lastError : ""}`;
  $("#autoShare").checked = state.autoShare;
  $("#pause").textContent = state.paused ? "恢复同步" : "暂停同步";
  $("#ownerBox").classList.toggle("hidden", state.role !== "owner");
  $("#members").innerHTML = state.members
    .map(
      (m) =>
        `<li><span>${esc(m.name)} <small class="muted">${m.role === "owner" ? "管理员" : "成员"}</small></span>${state.role === "owner" && m.id !== state.memberId ? `<button data-kick="${esc(m.id)}">移除</button>` : ""}</li>`,
    )
    .join("");
  const { inquiryLog = [] } = await chrome.storage.local.get("inquiryLog");
  $("#records").innerHTML =
    inquiryLog
      .map(
        (r) =>
          `<tr><td><input aria-label="选择 ${esc(r.pn)}" type="checkbox" data-record="${esc(r.id)}"></td><td>${esc(r.pn)}</td><td>${esc(r.company)}</td><td class="price">${r.price !== "" ? "¥" + esc(r.price) : "未报价"}</td><td>${state.conflicts[r.id] ? "存在冲突" : state.shared[r.id] ? "已选择共享" : "仅本机"}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty">还没有本地询价记录</td></tr>';
  const conflicts = Object.keys(state.conflicts);
  $("#conflictBox").classList.toggle("hidden", !conflicts.length);
  $("#conflicts").innerHTML = conflicts
    .map(
      (id) =>
        `<li><span>${esc(inquiryLog.find((r) => r.id === id)?.pn || id)}</span><button data-resolve="${esc(id)}" data-choice="remote">保留远端</button><button data-resolve="${esc(id)}" data-choice="local">推送本地</button></li>`,
    )
    .join("");
  if (state.role === "owner" && !state.paused) {
    const r = await send({ type: "teamInvites" });
    $("#invites").innerHTML = (r.invites || [])
      .map(
        (i) =>
          `<li><span class="muted">${new Date(i.expires).toLocaleString("zh-CN")} · ${i.revoked ? "已撤销" : i.used ? "已使用" : i.expires < Date.now() ? "已过期" : "待使用"}</span>${!i.used && !i.revoked ? `<button data-revoke="${esc(i.id)}">撤销</button>` : ""}</li>`,
      )
      .join("");
  }
}
$("#create").onclick = () => {
  let endpoint;
  try {
    endpoint = CaixinCrypto.endpoint($("#endpoint").value);
  } catch (e) {
    return message(e.message, true);
  }
  const permission = chrome.permissions.request({ origins: [endpoint + "/*"] });
  run(async () => {
    if (!(await permission)) throw new Error("未授权服务器访问");
    const token = $("#createToken").value;
    $("#createToken").value = "";
    return send({
      type: "teamCreate",
      endpoint,
      createToken: token,
      name: $("#name").value,
      myName: $("#myName").value,
    });
  });
};
$("#join").onclick = () => {
  let endpoint;
  try {
    endpoint = CaixinCrypto.endpoint(
      JSON.parse($("#invitation").value).endpoint,
    );
  } catch {
    return message("邀请格式无效", true);
  }
  const permission = chrome.permissions.request({ origins: [endpoint + "/*"] });
  run(async () => {
    if (!(await permission)) throw new Error("未授权服务器访问");
    const invitation = $("#invitation").value;
    const r = await send({
      type: "teamJoin",
      endpoint,
      invitation,
      myName: $("#joinName").value,
    });
    if (r?.ok) $("#invitation").value = "";
    return r;
  });
};
$("#sync").onclick = () => run(() => send({ type: "teamSync" }));
$("#pause").onclick = () =>
  run(() => send({ type: "teamPause", on: !state.paused }));
$("#autoShare").onchange = (e) =>
  run(() => send({ type: "teamAutoShare", on: e.target.checked }));
$("#leave").onclick = () => {
  if (
    confirm(
      state.role === "owner"
        ? "退出将关闭整个团队，其他成员也将无法继续同步。确定退出？"
        : "退出会撤回你的共享记录并清除本机团队凭据。确定退出？",
    )
  )
    run(() => send({ type: "teamLeave" }));
};
$("#localLeave").onclick = () => {
  if (
    confirm("仅清除本机连接；服务器成员凭据仍有效，需要管理员撤销。确定断开？")
  )
    run(() => send({ type: "teamLeave", localOnly: true }));
};
$("#invite").onclick = () =>
  run(async () => {
    const r = await send({ type: "teamInvite" });
    if (r.ok) {
      $("#invitationOutput").value = r.invitation;
      $("#inviteExpiry").textContent =
        "有效期至 " + new Date(r.expires).toLocaleString("zh-CN");
    }
    return r;
  });
const selected = () =>
  [...document.querySelectorAll("[data-record]:checked")].map(
    (el) => el.dataset.record,
  );
$("#share").onclick = () => {
  const ids = selected();
  if (!ids.length) return message("请先勾选记录", true);
  if (
    confirm(
      `共享选中的 ${ids.length} 条报价${$("#includeNote").checked ? "及备注" : ""}？`,
    )
  )
    run(async () => {
      const r = await send({
        type: "teamShare",
        ids,
        includeNote: $("#includeNote").checked,
      });
      if (r.ok && !state.paused) return send({ type: "teamSync" });
      return r;
    });
};
$("#unshare").onclick = () => {
  const ids = selected();
  if (
    ids.length &&
    confirm(`撤回选中的 ${ids.length} 条共享记录？同事已下载的副本无法追回`)
  )
    run(async () => {
      const r = await send({ type: "teamUnshare", ids });
      if (r.ok && !state.paused) return send({ type: "teamSync" });
      return r;
    });
};
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.kick && confirm("移除该成员并撤销其服务访问？"))
    run(() => send({ type: "teamKick", id: b.dataset.kick }));
  if (b.dataset.revoke)
    run(() => send({ type: "teamRevoke", id: b.dataset.revoke }));
  if (b.dataset.resolve)
    run(() =>
      send({
        type: "teamResolve",
        id: b.dataset.resolve,
        choice: b.dataset.choice,
      }),
    );
});
render().catch(() => message("读取团队状态失败，请重新打开页面", true));
