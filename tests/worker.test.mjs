import { test } from "node:test";
import assert from "node:assert/strict";
import { worker, extensionId } from "./helpers.mjs";
import { createApp } from "../server/app.mjs";
await import("../extension/lib/team-crypto.js");
const page = {
  id: extensionId,
  url: "https://www.ic.net.cn/search/SYNTHETIC.html",
  tab: { id: 5, url: "https://www.ic.net.cn/search/SYNTHETIC.html" },
};
test("fresh and upstream legacy state never activate network; private storage restricted", async () => {
  const w = worker({
    team: { token: "synthetic-old" },
    teamDirty: { a: 1 },
    settings: { apiBase: "https://old.example" },
  });
  await w.fire("installed");
  await w.fire("startup");
  await w.fire("alarm", { name: "teamSync" });
  assert.equal(w.calls.length, 0);
  assert.equal(w.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(w.db.team, undefined);
  assert(!w.alarms.has("teamSync"));
});
test("host page cannot read team secrets, alter server, edit quotes or trigger team operations", async () => {
  const w = worker({
    inquiryLog: [{ id: "private", price: "9.12" }],
    cxTeam: { key: "SYNTHETIC-KEY", token: "SYNTHETIC-TOKEN" },
    settings: {
      apiBase: "https://private.example",
      diagnostics: true,
      hideAds: true,
    },
  });
  const state = await w.send({ type: "pageState" }, page);
  assert(!JSON.stringify(state).includes("SYNTHETIC"));
  assert(!JSON.stringify(state).includes("9.12"));
  assert(!("apiBase" in state.settings));
  assert.equal(
    (
      await w.send(
        { type: "pageSettings", value: { apiBase: "https://evil.example" } },
        page,
      )
    ).ok,
    false,
  );
  for (const type of [
    "teamState",
    "teamSync",
    "updateRecord",
    "clearRecords",
    "ping",
  ])
    assert.equal(
      await w.send({ type, id: "private", patch: { price: "0" } }, page),
      undefined,
    );
  assert.equal(w.calls.length, 0);
  assert.equal(w.db.inquiryLog[0].price, "9.12");
});
test("diagnostics never keep supplied business content and clearing removes stored traces", async () => {
  const w = worker({
    settings: { diagnostics: true },
    src2_test: { pn: "SYNTHETIC" },
  });
  await w.run(
    "dlog('PRIVATE-COMPANY','PRIVATE-QQ-123',{token:'PRIVATE-TOKEN'})",
  );
  assert(!JSON.stringify(w.db.debugLog).includes("PRIVATE"));
  await w.send(
    {
      type: "logInquiry",
      entry: { company: "SYNTHETIC-SUPPLIER", pn: "DEMO-123" },
    },
    page,
  );
  await w.send({ type: "clearRecords" });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.db.inquiryLog.length, 0);
  assert.equal(w.db.debugLog, undefined);
  assert.equal(w.db.src2_test, undefined);
});
test("encrypted team clients synchronize only selected records, pause, unshare and leave", async (t) => {
  const bootstrap = "synthetic-create-token-only-for-tests-123";
  const app = createApp({ createToken: bootstrap, rateLimit: 10000 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const endpoint = "http://127.0.0.1:" + app.server.address().port;
  const owner = worker(
    {
      inquiryLog: [
        {
          v: 2,
          id: "record1",
          pn: "SYNTHETIC-PN",
          company: "SYNTHETIC-PRIVATE-CO",
          price: "1.23",
          time: Date.now(),
        },
        {
          v: 2,
          id: "private2",
          pn: "MUST-STAY-LOCAL",
          price: "9",
          time: Date.now(),
        },
      ],
    },
    fetch,
    [endpoint + "/*"],
  );
  assert.equal(
    (
      await owner.send({
        type: "teamCreate",
        endpoint,
        createToken: bootstrap,
        name: "合成团队",
        myName: "甲",
      })
    ).ok,
    true,
  );
  assert.equal(app.store.one("SELECT COUNT(*) n FROM records").n, 0);
  const invitation = await owner.send({ type: "teamInvite" });
  const member = worker({}, fetch, [endpoint + "/*"]);
  assert.equal(
    (
      await member.send({
        type: "teamJoin",
        endpoint,
        invitation: invitation.invitation,
        myName: "乙",
      })
    ).ok,
    true,
  );
  await owner.send({ type: "teamShare", ids: ["record1"] });
  assert.equal((await owner.send({ type: "teamSync" })).ok, true);
  assert.equal((await member.send({ type: "teamSync" })).ok, true);
  assert.equal(
    Object.values(member.db.cxTeamRecords)[0].company,
    "SYNTHETIC-PRIVATE-CO",
  );
  assert.equal(app.store.one("SELECT COUNT(*) n FROM records").n, 1);
  assert(
    !JSON.stringify(app.store.all("SELECT * FROM records")).includes(
      "SYNTHETIC-PRIVATE-CO",
    ),
  );
  await owner.send({ type: "teamPause", on: true });
  const count = owner.calls.length;
  await owner.send({
    type: "updateRecord",
    id: "record1",
    patch: { price: "2.34" },
  });
  await owner.send({ type: "teamSync" });
  await owner.fire("startup");
  assert.equal(owner.calls.length, count);
  assert.equal(Object.keys(owner.db.cxTeamQueue).length, 1);
  await owner.send({ type: "teamPause", on: false });
  await owner.send({ type: "teamSync" });
  await member.send({ type: "teamSync" });
  assert.equal(Object.values(member.db.cxTeamRecords)[0].price, "2.34");
  await owner.send({ type: "teamUnshare", ids: ["record1"] });
  await owner.send({ type: "teamSync" });
  await member.send({ type: "teamSync" });
  assert.equal(Object.keys(member.db.cxTeamRecords).length, 0);
  await member.send({ type: "teamLeave" });
  const after = member.calls.length;
  await member.fire("startup");
  await member.fire("alarm", { name: "caixin-team" });
  assert.equal(member.calls.length, after);
  assert.equal(member.db.cxTeam, undefined);
  assert.equal(
    (
      await owner.send({
        type: "teamCreate",
        endpoint: "https://different.example",
        name: "x",
        myName: "y",
      })
    ).ok,
    false,
  );
  assert(
    !owner.calls.some((c) => c.url.startsWith("https://different.example")),
  );
});
test("offline queues survive, conflicts require explicit choice, permissions stop networking", async (t) => {
  const bootstrap = "synthetic-bootstrap-conflict-test-only";
  const app = createApp({ createToken: bootstrap, rateLimit: 10000 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const endpoint = "http://127.0.0.1:" + app.server.address().port;
  let offline = false;
  const w = worker(
    {
      inquiryLog: [
        {
          v: 2,
          id: "one",
          time: Date.now(),
          pn: "SYNTHETIC-CONFLICT",
          price: "1.00",
        },
      ],
    },
    (u, o) => (offline ? Promise.reject(new Error("合成断网")) : fetch(u, o)),
    [endpoint + "/*"],
  );
  await w.send({
    type: "teamCreate",
    endpoint,
    createToken: bootstrap,
    name: "冲突测试",
    myName: "甲",
  });
  await w.send({ type: "teamShare", ids: ["one"] });
  await w.send({ type: "teamSync" });
  const team = w.db.cxTeam,
    id = team.memberId + ":one",
    rev = team.shared.one.rev;
  const data = await CaixinCrypto.seal(team.key, team.teamId, id, {
    pn: "SYNTHETIC-CONFLICT",
    price: "3.45",
    time: Date.now(),
  });
  const remote = await fetch(endpoint + "/v1/records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + team.token,
    },
    body: JSON.stringify({ records: [{ id, baseRev: rev, data }] }),
  });
  assert(remote.ok);
  await w.send({ type: "updateRecord", id: "one", patch: { price: "2.34" } });
  await w.send({ type: "teamSync" });
  assert(w.db.cxTeam.conflicts.one);
  assert.equal(w.db.inquiryLog[0].price, "2.34");
  await w.send({ type: "teamResolve", id: "one", choice: "remote" });
  assert.equal(w.db.inquiryLog[0].price, "3.45");
  assert.equal(Object.keys(w.db.cxTeam.conflicts).length, 0);
  offline = true;
  await w.send({ type: "updateRecord", id: "one", patch: { price: "4.56" } });
  assert.equal((await w.send({ type: "teamSync" })).ok, false);
  assert.equal(Object.keys(w.db.cxTeamQueue).length, 1);
  offline = false;
  assert.equal((await w.send({ type: "teamSync" })).ok, true);
  assert.equal(Object.keys(w.db.cxTeamQueue).length, 0);
  w.granted.clear();
  const count = w.calls.length;
  await w.fire("permissionRemoved");
  await w.send({ type: "teamSync" });
  assert(w.db.cxTeam.paused);
  assert.equal(w.calls.length, count);
});
test("auto-share is opt-in and covers future records only", async (t) => {
  const bootstrap = "synthetic-bootstrap-auto-share-test-only";
  const app = createApp({ createToken: bootstrap });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const endpoint = "http://127.0.0.1:" + app.server.address().port;
  const w = worker(
    {
      inquiryLog: [
        { v: 2, id: "old", time: 1, pn: "SYNTHETIC-OLD", price: "2" },
      ],
    },
    fetch,
    [endpoint + "/*"],
  );
  await w.send({
    type: "teamCreate",
    endpoint,
    createToken: bootstrap,
    name: "自动共享测试",
    myName: "甲",
  });
  assert.equal(w.db.cxTeam.autoShare, false);
  await w.send({ type: "teamAutoShare", on: true });
  await w.send({ type: "updateRecord", id: "old", patch: { price: "3" } });
  assert.equal(Object.keys(w.db.cxTeamQueue).length, 0);
  await w.send(
    {
      type: "logInquiry",
      entry: { pn: "SYNTHETIC-NEW", company: "合成新记录" },
    },
    page,
  );
  assert.equal(Object.keys(w.db.cxTeamQueue).length, 1);
  await w.send({ type: "teamSync" });
  const wire = app.store.all("SELECT id FROM records");
  assert.equal(wire.length, 1);
  assert(!wire[0].id.endsWith(":old"));
});
test("monitor comparisons distinguish missing baseline from real price/stock changes", () => {
  const w = worker();
  assert.equal(w.run("diffSite('szlcsc',null,{stock:2,price:1})"), null);
  assert.equal(
    w.run("diffSite('szlcsc',{stock:2,price:1},{stock:2,price:1})"),
    null,
  );
  assert.match(
    w.run("diffSite('szlcsc',{stock:2,price:1},{stock:0,price:1}).text"),
    /卖完/,
  );
  assert.match(
    w.run("diffSite('szlcsc',{stock:0,price:1},{stock:20,price:0.9}).text"),
    /到货/,
  );
});

test('concurrent share selections preserve both metadata and upload queue entries', async () => {
  const w = worker({
    cxTeam: { memberId: 'synthetic-member', shared: {}, conflicts: {}, paused: true },
    inquiryLog: [{ v: 2, id: 'a', pn: 'SYNTHETIC-A' }, { v: 2, id: 'b', pn: 'SYNTHETIC-B' }],
  });
  await Promise.all([
    w.send({ type: 'teamShare', ids: ['a'] }),
    w.send({ type: 'teamShare', ids: ['b'] }),
  ]);
  assert.deepEqual(Object.keys(w.db.cxTeam.shared).sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(w.db.cxTeamQueue).sort(), ['a', 'b']);
  assert.equal(w.calls.length, 0);
});
