import { test } from "node:test";
import assert from "node:assert/strict";
await import("../extension/lib/team-crypto.js");
await import("../extension/lib/backup.js");
const C = globalThis.CaixinCrypto,
  B = globalThis.CaixinBackup;
test("AES-GCM authenticates team, record and ciphertext; random IV per encryption", async () => {
  const k = C.key(),
    value = { pn: "SYNTHETIC-123", price: "1.27" },
    a = await C.seal(k, "team-a", "record-a", value),
    b = await C.seal(k, "team-a", "record-a", value);
  assert.notEqual(a, b);
  assert.deepEqual(await C.open(k, "team-a", "record-a", a), value);
  await assert.rejects(C.open(k, "team-b", "record-a", a));
  await assert.rejects(C.open(k, "team-a", "record-b", a));
  await assert.rejects(C.open(C.key(), "team-a", "record-a", a));
  const changed = a.slice(0, -3) + (a.at(-3) === "A" ? "B" : "A") + a.slice(-2);
  await assert.rejects(C.open(k, "team-a", "record-a", changed));
  assert(!a.includes(value.pn));
});
test("endpoint rules reject credentials, plaintext internet, paths and query secrets", () => {
  assert.equal(
    C.endpoint("https://team.example.com/"),
    "https://team.example.com",
  );
  assert.equal(C.endpoint("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  for (const u of [
    "http://example.com",
    "file:///tmp/a",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?token=x",
  ])
    assert.throws(() => C.endpoint(u));
});
test("CSV formulas neutralized and original CSV migrated including quoted multiline cells", () => {
  const csv = B.csv([
    ["型号", "公司名", "价格"],
    ["=CMD()", ' A, "B"\nC', "1.25"],
  ]);
  assert(csv.includes("'=CMD()"));
  const rows = B.parse(csv);
  assert.equal(rows[0].pn, "'=CMD()");
  assert.equal(rows[0].company, ' A, "B"\nC');
  assert.equal(rows[0].price, "1.25");
  for (const x of ["=1", " +1", "@SUM(1)", "-2"])
    assert(B.csv([[x]]).includes("'"));
});
test("backup rejects invalid files atomically and keeps explicit validated fields only", () => {
  const raw = JSON.stringify({
    records: [
      { pn: "SYNTHETIC-A", price: "2.00", token: "never import", valid: true },
    ],
  });
  const [r] = B.parse(raw);
  assert.equal(r.pn, "SYNTHETIC-A");
  assert(!("token" in r));
  assert(r.id);
  assert.throws(() => B.parse("{broken"));
  assert.throws(() =>
    B.parse(
      JSON.stringify({ records: [{ pn: "ok" }, { pn: { secret: "x" } }] }),
    ),
  );
  assert.throws(() => B.parse('型号,公司名\n"unclosed'));
  assert.throws(() => B.parse("x".repeat(5242881)));
});
