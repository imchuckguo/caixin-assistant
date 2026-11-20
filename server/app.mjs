import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { openStore } from "./store.mjs";

const digest = (s) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const equal = (a, b) => {
  const x = Buffer.from(digest(String(a))),
    y = Buffer.from(digest(String(b)));
  return timingSafeEqual(x, y);
};
class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const requireThat = (ok, code = "INVALID_REQUEST", status = 400) => {
  if (!ok) throw new ApiError(status, code);
};
const uuid = (s) =>
  typeof s === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    s,
  );
const sealed = (s, max = 65536) =>
  typeof s === "string" &&
  s.length <= max &&
  /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(s);
const keys = (obj, allowed) =>
  requireThat(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Object.keys(obj).every((k) => allowed.includes(k)),
  );
async function body(req) {
  requireThat(
    (req.headers["content-type"] || "").split(";")[0] === "application/json",
    "JSON_REQUIRED",
    415,
  );
  let n = 0;
  const chunks = [];
  for await (const chunk of req) {
    n += chunk.length;
    requireThat(n <= 1024 * 1024, "BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    requireThat(value && !Array.isArray(value) && typeof value === "object");
    return value;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "INVALID_JSON");
  }
}

export function createApp({
  dbPath = ":memory:",
  createToken,
  allowedOrigins = [],
  now = Date.now,
  rateLimit = 180,
} = {}) {
  requireThat(
    typeof createToken === "string" && createToken.length >= 32,
    "CREATE_TOKEN_MUST_HAVE_32_CHARACTERS",
  );
  const store = openStore(dbPath),
    rates = new Map(),
    origins = new Set(allowedOrigins);
  const memberView = (m) => ({ id: m.id, nameEnc: m.name_enc, role: m.role });
  function authenticate(req) {
    const raw = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization || "",
    );
    requireThat(raw, "UNAUTHORIZED", 401);
    const m = store.one(
      "SELECT m.* FROM members m JOIN teams t ON t.id=m.team_id WHERE m.token_hash=? AND m.active=1 AND t.active=1",
      digest(raw[1]),
    );
    requireThat(m, "UNAUTHORIZED", 401);
    return m;
  }
  const owner = (m) => requireThat(m.role === "owner", "OWNER_REQUIRED", 403);
  function push(m, batch) {
    requireThat(
      Array.isArray(batch) && batch.length > 0 && batch.length <= 50,
      "INVALID_BATCH",
    );
    return store.transaction(() => {
      const results = [],
        seen = new Set();
      for (const item of batch) {
        keys(item, ["id", "baseRev", "data", "deleted"]);
        requireThat(
          typeof item.id === "string" &&
            /^[A-Za-z0-9:_-]{1,180}$/.test(item.id) &&
            Number.isSafeInteger(item.baseRev) &&
            item.baseRev >= 0,
        );
        requireThat(!seen.has(item.id), "DUPLICATE_ID");
        seen.add(item.id);
        requireThat(
          item.deleted === undefined || typeof item.deleted === "boolean",
        );
        requireThat(item.deleted || sealed(item.data), "INVALID_CIPHERTEXT");
        const existing = store.one(
          "SELECT * FROM records WHERE team_id=? AND id=?",
          m.team_id,
          item.id,
        );
        requireThat(
          existing
            ? existing.owner_id === m.id
            : item.id.startsWith(m.id + ":"),
          "NOT_RECORD_OWNER",
          403,
        );
        if ((existing?.rev || 0) !== item.baseRev) {
          results.push({
            id: item.id,
            conflict: true,
            current: existing
              ? {
                  id: existing.id,
                  data: existing.data,
                  deleted: !!existing.deleted,
                  rev: existing.rev,
                  by: existing.owner_id,
                }
              : null,
          });
          continue;
        }
        store.run("UPDATE teams SET rev=rev+1 WHERE id=?", m.team_id);
        const rev = store.one(
          "SELECT rev FROM teams WHERE id=?",
          m.team_id,
        ).rev;
        store.run(
          "INSERT INTO records(team_id,id,owner_id,data,deleted,rev) VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,rev=excluded.rev",
          m.team_id,
          item.id,
          m.id,
          item.deleted ? "" : item.data,
          item.deleted ? 1 : 0,
          rev,
        );
        results.push({ id: item.id, rev });
      }
      return { results };
    });
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    function send(status, obj) {
      if (!res.destroyed) {
        res.writeHead(status);
        res.end(JSON.stringify(obj));
      }
    }
    try {
      const origin = req.headers.origin;
      if (origin) {
        requireThat(origins.has(origin), "ORIGIN_DENIED", 403);
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        return send(204, null);
      }
      const ip = req.socket.remoteAddress || "unknown",
        time = now();
      for (const [k, r] of rates) if (r.until <= time) rates.delete(k);
      requireThat(rates.has(ip) || rates.size < 10000, "RATE_LIMITED", 429);
      const rate = rates.get(ip) || { count: 0, until: time + 60000 };
      rate.count++;
      rates.set(ip, rate);
      requireThat(rate.count <= rateLimit, "RATE_LIMITED", 429);
      const u = new URL(req.url, "http://localhost"),
        path = u.pathname;
      if (path === "/v1/health" && req.method === "GET")
        return send(200, { ok: true, protocol: 1 });
      if (path === "/v1/teams" && req.method === "POST") {
        requireThat(
          equal(req.headers.authorization || "", "Bearer " + createToken),
          "UNAUTHORIZED",
          401,
        );
        const b = await body(req);
        keys(b, ["teamId", "memberId", "nameEnc", "memberNameEnc"]);
        requireThat(
          uuid(b.teamId) &&
            uuid(b.memberId) &&
            sealed(b.nameEnc, 4096) &&
            sealed(b.memberNameEnc, 4096),
        );
        requireThat(
          !store.one("SELECT id FROM teams WHERE id=?", b.teamId) &&
            !store.one("SELECT id FROM members WHERE id=?", b.memberId),
          "ID_EXISTS",
          409,
        );
        const token = secret();
        store.transaction(() => {
          store.run(
            "INSERT INTO teams(id,name_enc) VALUES(?,?)",
            b.teamId,
            b.nameEnc,
          );
          store.run(
            "INSERT INTO members(id,team_id,name_enc,role,token_hash) VALUES(?,?,?,?,?)",
            b.memberId,
            b.teamId,
            b.memberNameEnc,
            "owner",
            digest(token),
          );
        });
        return send(201, {
          teamId: b.teamId,
          memberId: b.memberId,
          role: "owner",
          token,
        });
      }
      if (path === "/v1/join" && req.method === "POST") {
        const b = await body(req);
        keys(b, ["teamId", "memberId", "invite", "memberNameEnc"]);
        requireThat(
          uuid(b.teamId) &&
            uuid(b.memberId) &&
            typeof b.invite === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(b.invite) &&
            sealed(b.memberNameEnc, 4096),
        );
        const result = store.transaction(() => {
          const inv = store.one(
            "SELECT i.* FROM invites i JOIN teams t ON t.id=i.team_id WHERE i.secret_hash=? AND i.team_id=? AND i.used=0 AND i.revoked=0 AND i.expires>? AND t.active=1",
            digest(b.invite),
            b.teamId,
            time,
          );
          requireThat(inv, "INVITE_INVALID", 403);
          requireThat(
            !store.one("SELECT id FROM members WHERE id=?", b.memberId),
            "ID_EXISTS",
            409,
          );
          const token = secret();
          store.run("UPDATE invites SET used=1 WHERE id=?", inv.id);
          store.run(
            "INSERT INTO members(id,team_id,name_enc,role,token_hash) VALUES(?,?,?,?,?)",
            b.memberId,
            b.teamId,
            b.memberNameEnc,
            "member",
            digest(token),
          );
          return {
            teamId: b.teamId,
            memberId: b.memberId,
            role: "member",
            token,
          };
        });
        return send(201, result);
      }
      const m = authenticate(req);
      if (path === "/v1/team" && req.method === "GET")
        return send(200, {
          id: m.team_id,
          nameEnc: store.one("SELECT name_enc FROM teams WHERE id=?", m.team_id)
            .name_enc,
          me: memberView(m),
          members: store
            .all(
              "SELECT * FROM members WHERE team_id=? AND active=1",
              m.team_id,
            )
            .map(memberView),
        });
      if (path === "/v1/invites" && req.method === "POST") {
        owner(m);
        const b = await body(req);
        keys(b, []);
        const value = secret(),
          id = randomUUID(),
          expires = time + 86400000;
        store.run(
          "INSERT INTO invites(id,team_id,secret_hash,expires) VALUES(?,?,?,?)",
          id,
          m.team_id,
          digest(value),
          expires,
        );
        return send(201, { id, invite: value, expires });
      }
      if (path === "/v1/invites" && req.method === "GET") {
        owner(m);
        return send(200, {
          invites: store.all(
            "SELECT id,expires,used,revoked FROM invites WHERE team_id=? ORDER BY expires DESC LIMIT 100",
            m.team_id,
          ),
        });
      }
      if (path.startsWith("/v1/invites/") && req.method === "DELETE") {
        owner(m);
        store.run(
          "UPDATE invites SET revoked=1 WHERE team_id=? AND id=?",
          m.team_id,
          path.slice(12),
        );
        return send(200, { ok: true });
      }
      if (path.startsWith("/v1/members/") && req.method === "DELETE") {
        owner(m);
        const id = path.slice(12);
        requireThat(id !== m.id, "USE_LEAVE");
        store.transaction(() => {
          store.run(
            "UPDATE members SET active=0 WHERE team_id=? AND id=?",
            m.team_id,
            id,
          );
          const rows = store.all(
            "SELECT id FROM records WHERE team_id=? AND owner_id=? AND deleted=0",
            m.team_id,
            id,
          );
          for (const r of rows) {
            store.run("UPDATE teams SET rev=rev+1 WHERE id=?", m.team_id);
            store.run(
              "UPDATE records SET data=?,deleted=1,rev=(SELECT rev FROM teams WHERE id=?) WHERE team_id=? AND id=?",
              "",
              m.team_id,
              m.team_id,
              r.id,
            );
          }
        });
        return send(200, { ok: true });
      }
      if (path === "/v1/leave" && req.method === "POST") {
        const b = await body(req);
        keys(b, []);
        store.transaction(() => {
          store.run("UPDATE members SET active=0 WHERE id=?", m.id);
          if (m.role === "owner")
            store.run("UPDATE teams SET active=0 WHERE id=?", m.team_id);
          else {
            for (const r of store.all(
              "SELECT id FROM records WHERE team_id=? AND owner_id=? AND deleted=0",
              m.team_id,
              m.id,
            )) {
              store.run("UPDATE teams SET rev=rev+1 WHERE id=?", m.team_id);
              store.run(
                "UPDATE records SET data=?,deleted=1,rev=(SELECT rev FROM teams WHERE id=?) WHERE team_id=? AND id=?",
                "",
                m.team_id,
                m.team_id,
                r.id,
              );
            }
          }
        });
        return send(200, { ok: true, teamClosed: m.role === "owner" });
      }
      if (path === "/v1/records" && req.method === "POST") {
        const b = await body(req);
        keys(b, ["records"]);
        return send(200, push(m, b.records));
      }
      if (path === "/v1/records" && req.method === "GET") {
        const raw = u.searchParams.get("cursor") || "0";
        requireThat(/^\d{1,15}$/.test(raw), "INVALID_CURSOR");
        const cursor = Number(raw);
        const rows = store.all(
            "SELECT * FROM records WHERE team_id=? AND rev>? ORDER BY rev LIMIT 201",
            m.team_id,
            cursor,
          ),
          more = rows.length > 200,
          page = rows.slice(0, 200);
        return send(200, {
          records: page.map((r) => ({
            id: r.id,
            by: r.owner_id,
            data: r.data,
            deleted: !!r.deleted,
            rev: r.rev,
          })),
          next: page.at(-1)?.rev || cursor,
          more,
        });
      }
      throw new ApiError(404, "NOT_FOUND");
    } catch (e) {
      send(e instanceof ApiError ? e.status : 500, {
        error: e instanceof ApiError ? e.code : "INTERNAL_ERROR",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    async close() {
      if (server.listening)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      store.close();
    },
  };
}
