/* New opt-in protocol; upstream team/apiBase state is never used. */
const CX_TEAM = "cxTeam",
  CX_QUEUE = "cxTeamQueue",
  CX_CACHE = "cxTeamRecords",
  CX_ALARM = "caixin-team";
const teamGet = async () =>
  (await chrome.storage.local.get(CX_TEAM))[CX_TEAM] || null;
let queueSerial = Promise.resolve(),
  teamSerial = Promise.resolve(),
  teamSyncing = null;
const controllers = new Set();
function editQueue(fn) {
  const p = queueSerial.then(async () => {
    const q = (await chrome.storage.local.get(CX_QUEUE))[CX_QUEUE] || {};
    await fn(q);
    await chrome.storage.local.set({ [CX_QUEUE]: q });
  });
  queueSerial = p.catch(() => {});
  return p;
}
function saveTeam(id, fn) {
  const operation = teamSerial.then(async () => {
    const t = await teamGet();
    if (!t || t.memberId !== id) return null;
    fn(t);
    await chrome.storage.local.set({ [CX_TEAM]: t });
    return t;
  });
  teamSerial = operation.catch(() => {});
  return operation;
}
function stopNetwork() {
  for (const c of controllers) c.abort();
  controllers.clear();
}
async function requestTeam(endpoint, path, token, method = "GET", body) {
  endpoint = CaixinCrypto.endpoint(endpoint);
  if (!(await chrome.permissions.contains({ origins: [endpoint + "/*"] })))
    throw new Error("服务器站点权限尚未授权");
  const c = new AbortController();
  controllers.add(c);
  const timer = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(endpoint + "/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: c.signal,
      redirect: "error",
      credentials: "omit",
    });
    const j = await r.json();
    if (!r.ok) {
      const errors = {
        INVITE_INVALID: "邀请已失效、已使用或已过期",
        OWNER_REQUIRED: "需要团队管理员权限",
        ORIGIN_DENIED: "服务器未允许这个扩展来源",
        RATE_LIMITED: "请求过于频繁，请稍后重试",
        BODY_TOO_LARGE: "本次共享数据过大",
        UNAUTHORIZED: "成员或创建凭据无效",
        NOT_RECORD_OWNER: "不能修改其他成员的记录",
      };
      const e = new Error(
        errors[j.error] || "服务器请求未完成（HTTP " + r.status + "）",
      );
      e.status = r.status;
      throw e;
    }
    return j;
  } finally {
    clearTimeout(timer);
    controllers.delete(c);
  }
}
async function teamApi(t, path, method = "GET", body, manual = false) {
  const cur = await teamGet();
  if (
    !cur ||
    cur.memberId !== t.memberId ||
    cur.endpoint !== t.endpoint ||
    (!manual && cur.paused)
  )
    throw new Error("团队同步已停止");
  return requestTeam(t.endpoint, path, t.token, method, body);
}
async function teamState() {
  const t = await teamGet();
  return t
    ? {
        connected: true,
        endpoint: t.endpoint,
        name: t.name,
        myName: t.myName,
        memberId: t.memberId,
        role: t.role,
        members: t.members || [],
        paused: !!t.paused,
        autoShare: !!t.autoShare,
        lastSync: t.lastSync || 0,
        lastError: t.lastError || "",
        shared: t.shared || {},
        conflicts: t.conflicts || {},
        queued: Object.keys(
          (await chrome.storage.local.get(CX_QUEUE))[CX_QUEUE] || {},
        ).length,
      }
    : { connected: false };
}
async function teamEnter(t) {
  if (await teamGet()) throw new Error("请先退出当前团队");
  await chrome.storage.local.set({
    [CX_TEAM]: {
      ...t,
      paused: false,
      autoShare: false,
      since: Date.now(),
      shared: {},
      conflicts: {},
      members: [],
      cursor: 0,
      failures: 0,
    },
    [CX_QUEUE]: {},
    [CX_CACHE]: {},
  });
  await chrome.alarms.create(CX_ALARM, { periodInMinutes: 5 });
  await teamSync(true);
  return { ok: true };
}
function checkedName(s, max) {
  s = String(s || "").trim();
  if (!s || s.length > max) throw new Error("请填写合适长度的名称");
  return s;
}
async function teamCreate(msg) {
  if (await teamGet()) throw new Error("请先退出当前团队");
  const endpoint = CaixinCrypto.endpoint(msg.endpoint),
    teamId = crypto.randomUUID(),
    memberId = crypto.randomUUID(),
    key = CaixinCrypto.key(),
    name = checkedName(msg.name, 40),
    myName = checkedName(msg.myName, 20);
  const b = {
    teamId,
    memberId,
    nameEnc: await CaixinCrypto.seal(key, teamId, "team", name),
    memberNameEnc: await CaixinCrypto.seal(
      key,
      teamId,
      "member:" + memberId,
      myName,
    ),
  };
  const r = await requestTeam(
    endpoint,
    "/teams",
    String(msg.createToken || ""),
    "POST",
    b,
  );
  return teamEnter({ ...r, endpoint, key, name, myName });
}
async function teamJoin(msg) {
  if (await teamGet()) throw new Error("请先退出当前团队");
  const v = JSON.parse(String(msg.invitation || ""));
  const endpoint = CaixinCrypto.endpoint(v.endpoint);
  if (msg.endpoint && CaixinCrypto.endpoint(msg.endpoint) !== endpoint)
    throw new Error("邀请服务器与授权地址不一致");
  if (
    !/^[0-9a-f-]{36}$/i.test(v.teamId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.invite || "")
  )
    throw new Error("邀请格式无效");
  const memberId = crypto.randomUUID(),
    myName = checkedName(msg.myName, 20);
  const memberNameEnc = await CaixinCrypto.seal(
    v.key,
    v.teamId,
    "member:" + memberId,
    myName,
  );
  const r = await requestTeam(endpoint, "/join", null, "POST", {
    teamId: v.teamId,
    memberId,
    invite: v.invite,
    memberNameEnc,
  });
  return teamEnter({ ...r, endpoint, key: v.key, name: "团队", myName });
}
async function teamMarkDirty(ids, isNew = false) {
  const t = await teamGet();
  if (!t) return;
  const selected = ids.filter((id) => t.shared[id] || (isNew && t.autoShare));
  if (!selected.length) return;
  if (isNew && t.autoShare)
    await saveTeam(t.memberId, (cur) => {
      for (const id of selected)
        cur.shared[id] ||= { rev: 0, includeNote: false };
    });
  await editQueue((q) => {
    for (const id of selected) q[id] = { stamp: crypto.randomUUID() };
  });
}
async function teamShare(ids, includeNote = false, deleted = false) {
  const t = await teamGet();
  if (!t) throw new Error("尚未加入团队");
  const log = (await chrome.storage.local.get("inquiryLog")).inquiryLog || [];
  const selected = ids.filter((id) =>
    deleted ? t.shared[id] : log.some((r) => r.id === id),
  );
  if (selected.length > 5000) throw new Error("记录过多");
  await saveTeam(t.memberId, (cur) => {
    for (const id of selected)
      cur.shared[id] = {
        ...(cur.shared[id] || { rev: 0 }),
        includeNote: !!includeNote,
      };
  });
  await editQueue((q) => {
    for (const id of selected) q[id] = { stamp: crypto.randomUUID(), deleted };
  });
  return { ok: true, queued: selected.length };
}
async function teamSync(force = false) {
  if (teamSyncing) return teamSyncing;
  teamSyncing = (async () => {
    let t = await teamGet();
    if (!t || t.paused || (!force && t.retryAt > Date.now()))
      return { ok: true, offline: true };
    try {
      const info = await teamApi(t, "/team");
      const name = await CaixinCrypto.open(
          t.key,
          t.teamId,
          "team",
          info.nameEnc,
        ),
        members = [];
      for (const m of info.members) {
        try {
          members.push({
            ...m,
            name: await CaixinCrypto.open(
              t.key,
              t.teamId,
              "member:" + m.id,
              m.nameEnc,
            ),
          });
        } catch {
          members.push({ ...m, name: "名称无法解密" });
        }
      }
      await saveTeam(t.memberId, (cur) => {
        cur.name = name;
        cur.members = members.map(({ id, name, role }) => ({ id, name, role }));
      });
      const q = (await chrome.storage.local.get(CX_QUEUE))[CX_QUEUE] || {};
      for (const [id, entry] of Object.entries(q)) {
        t = await teamGet();
        if (!t || t.paused) return { ok: true, offline: true };
        if (t.conflicts[id]) continue;
        const rows =
            (await chrome.storage.local.get("inquiryLog")).inquiryLog || [],
          r = rows.find((x) => x.id === id),
          deleted = !!entry.deleted || !r,
          wireId = t.memberId + ":" + id;
        const clean = r ? CaixinBackup.validate([r])[0] : null;
        if (clean) {
          delete clean.text;
          delete clean.action;
          delete clean.site;
          delete clean.id;
          if (!t.shared[id]?.includeNote) delete clean.note;
        }
        const result = await teamApi(t, "/records", "POST", {
          records: [
            {
              id: wireId,
              baseRev: t.shared[id]?.rev || 0,
              deleted,
              ...(!deleted
                ? {
                    data: await CaixinCrypto.seal(
                      t.key,
                      t.teamId,
                      wireId,
                      clean,
                    ),
                  }
                : {}),
            },
          ],
        });
        const ack = result.results[0];
        await saveTeam(t.memberId, (cur) => {
          if (ack.conflict)
            cur.conflicts[id] = ack.current || { rev: 0, deleted: true };
          else if (deleted) delete cur.shared[id];
          else cur.shared[id] = { ...cur.shared[id], rev: ack.rev };
        });
        await editQueue((cur) => {
          if (cur[id]?.stamp === entry.stamp) delete cur[id];
        });
      }
      t = await teamGet();
      if (!t) return { ok: true, offline: true };
      let cursor = t.cursor || 0,
        more = true;
      const cache = (await chrome.storage.local.get(CX_CACHE))[CX_CACHE] || {},
        alive = new Set(members.map((m) => m.id));
      for (const [id, r] of Object.entries(cache))
        if (!alive.has(r._by)) delete cache[id];
      while (more) {
        const page = await teamApi(t, "/records?cursor=" + cursor);
        for (const r of page.records) {
          if (r.by === t.memberId) continue;
          if (r.deleted) {
            delete cache[r.id];
            continue;
          }
          try {
            const value = await CaixinCrypto.open(
              t.key,
              t.teamId,
              r.id,
              r.data,
            );
            const clean = CaixinBackup.validate([value])[0];
            cache[r.id] = { ...clean, id: r.id, _by: r.by, _ro: true };
          } catch {
            throw new Error("共享记录校验失败；未接受该批数据");
          }
        }
        cursor = page.next;
        more = page.more;
      }
      const cur = await teamGet();
      if (!cur || cur.memberId !== t.memberId || cur.paused)
        return { ok: true, offline: true };
      await chrome.storage.local.set({ [CX_CACHE]: cache });
      await saveTeam(t.memberId, (x) => {
        x.cursor = cursor;
        x.lastSync = Date.now();
        x.lastError = "";
        x.failures = 0;
        x.retryAt = 0;
      });
      return { ok: true };
    } catch (e) {
      if (t)
        await saveTeam(t.memberId, (x) => {
          x.failures = Math.min((x.failures || 0) + 1, 6);
          x.retryAt = Date.now() + Math.min(1800000, 30000 * 2 ** x.failures);
          x.lastError =
            e.status === 401
              ? "成员凭据已失效，请退出并重新加入"
              : String(e.message).slice(0, 160);
          if (e.status === 401) x.paused = true;
        });
      return {
        ok: false,
        error:
          e.status === 401 ? "成员凭据已失效" : String(e.message).slice(0, 160),
      };
    }
  })();
  try {
    return await teamSyncing;
  } finally {
    teamSyncing = null;
  }
}
async function teamLeave(localOnly = false) {
  stopNetwork();
  const t = await teamGet();
  if (t && !localOnly) await teamApi(t, "/leave", "POST", {}, true);
  await chrome.alarms.clear(CX_ALARM);
  await queueSerial;
  await teamSerial;
  await chrome.storage.local.remove([CX_TEAM, CX_QUEUE, CX_CACHE]);
  return { ok: true };
}
async function teamPause(on) {
  stopNetwork();
  const t = await teamGet();
  if (t)
    await saveTeam(t.memberId, (x) => {
      x.paused = !!on;
    });
  if (on) await chrome.alarms.clear(CX_ALARM);
  else if (t) await chrome.alarms.create(CX_ALARM, { periodInMinutes: 5 });
  return { ok: true };
}
async function teamInvite() {
  const t = await teamGet();
  if (!t) throw new Error("尚未加入团队");
  const r = await teamApi(t, "/invites", "POST", {}, true);
  return {
    ok: true,
    id: r.id,
    expires: r.expires,
    invitation: JSON.stringify({
      v: 1,
      endpoint: t.endpoint,
      teamId: t.teamId,
      invite: r.invite,
      key: t.key,
    }),
  };
}
async function teamResolve(id, choice) {
  const t = await teamGet(),
    r = t?.conflicts[id];
  if (!r) throw new Error("冲突不存在");
  if (choice === "remote") {
    const value = r.deleted
      ? null
      : CaixinBackup.validate([
          await CaixinCrypto.open(
            t.key,
            t.teamId,
            t.memberId + ":" + id,
            r.data,
          ),
        ])[0];
    await patchLog((list) =>
      value
        ? list.map((x) => (x.id === id ? { ...value, id } : x))
        : list.filter((x) => x.id !== id),
    );
  } else if (choice !== "local") throw new Error("请选择处理方式");
  await saveTeam(t.memberId, (x) => {
    if (r.deleted && choice === "remote") delete x.shared[id];
    else x.shared[id] = { ...(x.shared[id] || {}), rev: r.rev || 0 };
    delete x.conflicts[id];
  });
  if (choice === "local")
    await editQueue((q) => {
      q[id] = { stamp: crypto.randomUUID() };
    });
  return { ok: true };
}
chrome.runtime.onMessage.addListener((m, s, reply) => {
  if (!isTrusted(s) || !m) return false;
  const h = {
    recordCreated: () => teamMarkDirty([m.id], true).then(() => ({ ok: true })),
    teamState: teamState,
    teamCreate: () => teamCreate(m),
    teamJoin: () => teamJoin(m),
    teamSync: () => teamSync(true),
    teamPause: () => teamPause(m.on),
    teamLeave: () => teamLeave(!!m.localOnly),
    teamInvite,
    teamInvites: async () => {
      const t = await teamGet();
      return teamApi(t, "/invites", "GET", undefined, true);
    },
    teamRevoke: async () => {
      const t = await teamGet();
      return teamApi(
        t,
        "/invites/" + encodeURIComponent(m.id),
        "DELETE",
        undefined,
        true,
      );
    },
    teamKick: async () => {
      const t = await teamGet();
      const r = await teamApi(
        t,
        "/members/" + encodeURIComponent(m.id),
        "DELETE",
        undefined,
        true,
      );
      await saveTeam(t.memberId, (x) => {
        x.members = (x.members || []).filter((v) => v.id !== m.id);
      });
      const cache = (await chrome.storage.local.get(CX_CACHE))[CX_CACHE] || {};
      for (const [id, v] of Object.entries(cache))
        if (v._by === m.id) delete cache[id];
      await chrome.storage.local.set({ [CX_CACHE]: cache });
      await teamSync(true);
      return r;
    },
    teamShare: () => teamShare(m.ids || [], m.includeNote),
    teamUnshare: () => teamShare(m.ids || [], false, true),
    teamAutoShare: async () => {
      const t = await teamGet();
      if (t)
        await saveTeam(t.memberId, (x) => {
          x.autoShare = !!m.on;
          x.since = Date.now();
        });
      return { ok: true };
    },
    teamResolve: () => teamResolve(m.id, m.choice),
  }[m.type];
  if (!h) return false;
  Promise.resolve()
    .then(h)
    .then(reply, (e) =>
      reply({ ok: false, error: String(e.message).slice(0, 160) }),
    );
  return true;
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CX_ALARM) teamSync();
});
async function teamStartup() {
  const t = await teamGet();
  if (t && !t.paused) {
    await chrome.alarms.create(CX_ALARM, { periodInMinutes: 5 });
    teamSync();
  } else await chrome.alarms.clear(CX_ALARM);
}
chrome.runtime.onStartup.addListener(teamStartup);
chrome.runtime.onInstalled.addListener(teamStartup);
chrome.permissions.onRemoved.addListener(async () => {
  const t = await teamGet();
  if (
    t &&
    !(await chrome.permissions.contains({ origins: [t.endpoint + "/*"] }))
  )
    await teamPause(true);
});
