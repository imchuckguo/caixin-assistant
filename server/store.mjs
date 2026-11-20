import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openStore(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name_enc TEXT NOT NULL,rev INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),name_enc TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','member')),token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS members_team ON members(team_id,active);
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),secret_hash TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS records(team_id TEXT NOT NULL REFERENCES teams(id),id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES members(id),data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,rev INTEGER NOT NULL,PRIMARY KEY(team_id,id));
    CREATE INDEX IF NOT EXISTS records_rev ON records(team_id,rev);`);
  return {
    db,
    one: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}
