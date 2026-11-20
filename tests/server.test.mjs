import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
await import("../extension/lib/team-crypto.js");
const C = globalThis.CaixinCrypto,
  bootstrap = "synthetic-test-bootstrap-not-a-real-secret";
async function fixture(options = {}) {
  const app = createApp({
    createToken: bootstrap,
    rateLimit: 10000,
    ...options,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + app.server.address().port;
  const api = async (path, method = "GET", data, token, headers = {}) => {
    const r = await fetch(url + "/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  return { ...app, url, api };
}
async function create(f) {
  const teamId = randomUUID(),
    memberId = randomUUID(),
    key = C.key();
  const r = await f.api(
    "/teams",
    "POST",
    {
      teamId,
      memberId,
      nameEnc: await C.seal(key, teamId, "team", "合成测试团队"),
      memberNameEnc: await C.seal(
        key,
        teamId,
        "member:" + memberId,
        "合成管理员",
      ),
    },
    bootstrap,
  );
  assert.equal(r.status, 201);
  return { ...r.body, key };
}
async function invite(f, t) {
  const r = await f.api("/invites", "POST", {}, t.token);
  assert.equal(r.status, 201);
  return r.body;
}
async function joinTeam(f, t, i) {
  const id = randomUUID();
  return f.api("/join", "POST", {
    teamId: t.teamId,
    memberId: id,
    invite: i.invite,
    memberNameEnc: await C.seal(t.key, t.teamId, "member:" + id, "合成成员"),
  });
}
test("two teams, single-use invitations, owner permissions, records, conflicts, withdrawal and revocation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await create(f),
    b = await create(f),
    i = await invite(f, a),
    member = (await joinTeam(f, a, i)).body;
  assert.equal((await joinTeam(f, a, i)).status, 403);
  assert.equal((await f.api("/invites", "POST", {}, member.token)).status, 403);
  const id = a.memberId + ":demo",
    payload = {
      pn: "SYNTHETIC-PRIVATE-PN",
      price: "19.73",
      company: "SYNTHETIC-SUPPLIER",
    },
    data = await C.seal(a.key, a.teamId, id, payload);
  let r = await f.api(
    "/records",
    "POST",
    { records: [{ id, baseRev: 0, data }] },
    a.token,
  );
  assert.equal(r.status, 200);
  const rev = r.body.results[0].rev;
  const got = (await f.api("/records", "GET", undefined, member.token)).body
    .records;
  assert.deepEqual(await C.open(a.key, a.teamId, id, got[0].data), payload);
  assert.equal(
    (await f.api("/records", "GET", undefined, b.token)).body.records.length,
    0,
  );
  assert.equal(
    (
      await f.api(
        "/records",
        "POST",
        { records: [{ id, baseRev: rev, data }] },
        member.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(
        "/records",
        "POST",
        { records: [{ id, baseRev: 0, data }] },
        a.token,
      )
    ).body.results[0].conflict,
    true,
  );
  assert.equal(
    (
      await f.api(
        "/records",
        "POST",
        {
          records: [
            { id: a.memberId + ":rollback", baseRev: 0, data },
            { id: member.memberId + ":foreign", baseRev: 0, data },
          ],
        },
        a.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.api("/records", "GET", undefined, a.token)).body.records.length,
    1,
  );
  await f.api(
    "/records",
    "POST",
    { records: [{ id, baseRev: rev, deleted: true }] },
    a.token,
  );
  assert(
    (await f.api("/records?cursor=" + rev, "GET", undefined, member.token)).body
      .records[0].deleted,
  );
  await f.api("/members/" + member.memberId, "DELETE", undefined, a.token);
  assert.equal(
    (await f.api("/team", "GET", undefined, member.token)).status,
    401,
  );
  assert.equal((await f.api("/leave", "POST", {}, a.token)).status, 200);
  assert.equal((await f.api("/team", "GET", undefined, a.token)).status, 401);
});
test("invitation expiry, explicit revocation, origin, field and body limits", async (t) => {
  let clock = 100000;
  const f = await fixture({
    now: () => clock,
    allowedOrigins: ["chrome-extension://" + "a".repeat(32)],
  });
  t.after(() => f.close());
  const a = await create(f),
    i = await invite(f, a);
  clock += 86400001;
  assert.equal((await joinTeam(f, a, i)).status, 403);
  const j = await invite(f, a);
  await f.api("/invites/" + j.id, "DELETE", undefined, a.token);
  assert.equal((await joinTeam(f, a, j)).status, 403);
  assert.equal(
    (
      await f.api("/health", "GET", undefined, undefined, {
        Origin: "https://hostile.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(
        "/records",
        "POST",
        { records: [], unexpected: true },
        a.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.api("/records", "POST", { padding: "x".repeat(1100000) }, a.token))
      .status,
    413,
  );
});
test("database survives restart and contains no plaintext quotes or credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "caixin-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "team.sqlite");
  let f = await fixture({ dbPath: path });
  const a = await create(f),
    id = a.memberId + ":private";
  await f.api(
    "/records",
    "POST",
    {
      records: [
        {
          id,
          baseRev: 0,
          data: await C.seal(a.key, a.teamId, id, {
            company: "SYNTHETIC-SUPPLIER-DO-NOT-STORE",
            price: "99.12345",
          }),
        },
      ],
    },
    a.token,
  );
  assert.equal(
    f.store.one("SELECT token_hash FROM members").token_hash.length,
    64,
  );
  await f.close();
  const bytes = readFileSync(path);
  assert(!bytes.includes(Buffer.from("SYNTHETIC-SUPPLIER-DO-NOT-STORE")));
  assert(!bytes.includes(Buffer.from(a.token)));
  f = await fixture({ dbPath: path });
  try {
    assert.equal(
      (await f.api("/records", "GET", undefined, a.token)).body.records.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("rate limiting rejects excessive requests", async (t) => {
  const f = await fixture({ rateLimit: 2 });
  t.after(() => f.close());
  await f.api("/health");
  await f.api("/health");
  assert.equal((await f.api("/health")).status, 429);
});
