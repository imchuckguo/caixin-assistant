import { createApp } from "./app.mjs";
import { resolve } from "node:path";
const app = createApp({
  dbPath: resolve(process.env.CAIXIN_DB || "data/caixin.sqlite"),
  createToken: process.env.CAIXIN_CREATE_TOKEN,
  allowedOrigins: (process.env.CAIXIN_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});
const port = Number(process.env.PORT || 8787),
  host = process.env.HOST || "127.0.0.1";
app.server.listen(port, host, () =>
  console.log(`采芯助手团队服务监听 ${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
