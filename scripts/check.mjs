import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const walk = (p) =>
  readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
  );
const m = JSON.parse(readFileSync("extension/manifest.json")),
  p = JSON.parse(readFileSync("package.json"));
if (m.version !== p.version)
  throw new Error("Package and manifest versions differ");
for (const file of [
  ...walk("extension"),
  ...walk("server"),
  ...walk("scripts"),
  ...walk("tests"),
].filter((f) => /\.m?js$/.test(f))) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(file + "\n" + r.stderr);
}
for (const c of m.content_scripts)
  for (const f of [...(c.js || []), ...(c.css || [])])
    if (!existsSync("extension/" + f)) throw new Error("Missing resource " + f);
for (const f of walk("extension").filter((f) => f.endsWith(".html"))) {
  for (const [, src] of readFileSync(f, "utf8").matchAll(
    /<script[^>]+src="([^"]+)"/g,
  )) {
    if (/^https?:/.test(src) || !existsSync("extension/" + src))
      throw new Error("Invalid script " + src);
  }
}
for (const f of walk("extension/content").filter((f) => f.endsWith(".js")))
  if (/chrome\.storage|inquiryLog|cxTeam|teamLog/.test(readFileSync(f, "utf8")))
    throw new Error("Private storage reference in content script " + f);
if (
  m.permissions.some((x) =>
    ["history", "cookies", "nativeMessaging", "debugger", "tabs"].includes(x),
  )
)
  throw new Error("Unexpected permission");
console.log(
  "Syntax, resources, versions and content-script storage boundaries checked",
);
