import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
export const extensionId = "a".repeat(32);
export function worker(
  seed = {},
  network = async () => {
    throw new Error("Unexpected network request");
  },
  permissions = [],
) {
  const db = structuredClone(seed),
    events = {},
    calls = [],
    granted = new Set(permissions),
    alarms = new Map();
  let accessLevel;
  const event = (name) => ({
    addListener(fn) {
      (events[name] ||= []).push(fn);
    },
  });
  const local = {
    async get(keys) {
      if (keys === null) return structuredClone(db);
      const names = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys || {});
      return Object.fromEntries(
        names
          .filter((k) => Object.hasOwn(db, k))
          .map((k) => [k, structuredClone(db[k])]),
      );
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: db[k], newValue: structuredClone(v) };
        db[k] = structuredClone(v);
      }
      for (const fn of events.changed || [])
        Promise.resolve()
          .then(() => fn(changes, "local"))
          .catch(() => {});
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete db[k];
    },
    async setAccessLevel(v) {
      accessLevel = v.accessLevel;
    },
  };
  const ctx = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    btoa,
    atob,
    AbortController,
    AbortSignal,
    Uint8Array,
    structuredClone,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    fetch: async (u, o) => {
      calls.push({ url: String(u), options: o });
      return network(u, o);
    },
    chrome: {
      storage: { local, session: local, onChanged: event("changed") },
      runtime: {
        id: extensionId,
        getManifest: () => ({ version: "0.1.0" }),
        getURL: (p) => `chrome-extension://${extensionId}/` + p,
        onMessage: event("message"),
        onInstalled: event("installed"),
        onStartup: event("startup"),
      },
      permissions: {
        async contains({ origins }) {
          return origins.every((o) => granted.has(o));
        },
        onRemoved: event("permissionRemoved"),
      },
      alarms: {
        async create(n, v) {
          alarms.set(n, v);
        },
        async get(n) {
          return alarms.get(n);
        },
        async clear(n) {
          alarms.delete(n);
        },
        onAlarm: event("alarm"),
      },
      contextMenus: {
        removeAll(cb) {
          cb();
        },
        create() {},
        onClicked: event("menu"),
      },
      tabs: {
        async query() {
          return [];
        },
        async create() {
          return { id: 1 };
        },
        async remove() {},
        async sendMessage() {
          return {};
        },
        onRemoved: event("tabRemoved"),
      },
      windows: {
        async create() {
          return { tabs: [{ id: 1 }] };
        },
      },
      notifications: {
        async create() {},
        async clear() {},
        onClicked: event("notification"),
      },
    },
  });
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files)
      vm.runInContext(readFileSync(resolve("extension", f), "utf8"), ctx, {
        filename: f,
        timeout: 2000,
      });
  };
  vm.runInContext(readFileSync("extension/background.js", "utf8"), ctx, {
    filename: "background.js",
    timeout: 2000,
  });
  const trusted = {
    id: extensionId,
    url: `chrome-extension://${extensionId}/team.html`,
  };
  async function send(msg, sender = trusted) {
    for (const fn of events.message || []) {
      let answered = false,
        value,
        done;
      const promise = new Promise((r) => (done = r));
      const r = fn(msg, sender, (v) => {
        answered = true;
        value = v;
        done(v);
      });
      if (answered) return value;
      if (r === true)
        return Promise.race([
          promise,
          new Promise((_, reject) => {
            const t = setTimeout(
              () => reject(new Error("Message timeout " + msg.type)),
              5000,
            );
            t.unref();
          }),
        ]);
    }
    return undefined;
  }
  return {
    ctx,
    db,
    calls,
    granted,
    alarms,
    get accessLevel() {
      return accessLevel;
    },
    send,
    async fire(name, ...args) {
      for (const fn of events[name] || []) await fn(...args);
    },
    run: (s) => vm.runInContext(s, ctx),
  };
}
