/* 采芯助手 — ciphertext protocol v1; shared by extension and integration tests. */
(function (root) {
  const enc = new TextEncoder();
  const b64 = (bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const unb64 = (s) => {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("无效编码");
    return Uint8Array.from(
      atob(
        s.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (s.length % 4)) % 4),
      ),
      (c) => c.charCodeAt(0),
    );
  };
  const key = () => b64(crypto.getRandomValues(new Uint8Array(32)));
  async function importKey(raw) {
    const bytes = unb64(raw);
    if (bytes.length !== 32) throw new Error("团队密钥无效");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  const aad = (teamId, recordId) =>
    enc.encode(JSON.stringify(["caixin", 1, teamId, recordId]));
  async function seal(raw, teamId, recordId, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(teamId, recordId) },
      await importKey(raw),
      enc.encode(JSON.stringify(value)),
    );
    return `v1.${b64(iv)}.${b64(new Uint8Array(data))}`;
  }
  async function open(raw, teamId, recordId, sealed) {
    const [v, iv, ct, extra] = String(sealed).split(".");
    if (v !== "v1" || !iv || !ct || extra || unb64(iv).length !== 12)
      throw new Error("密文格式不支持");
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: aad(teamId, recordId) },
      await importKey(raw),
      unb64(ct),
    );
    return JSON.parse(new TextDecoder().decode(data));
  }
  function endpoint(value) {
    const u = new URL(String(value || "").trim());
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["", "/"].includes(u.pathname)
    )
      throw new Error("请填写不带路径或凭据的服务器地址");
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )
    )
      throw new Error("服务器需要 HTTPS；HTTP 仅限本机开发");
    return u.origin;
  }
  root.CaixinCrypto = { key, seal, open, endpoint };
})(globalThis);
