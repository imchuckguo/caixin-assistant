import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const version = JSON.parse(readFileSync("package.json")).version;
mkdirSync("dist", { recursive: true });
const out = `caixin-assistant-v${version}.zip`;
const r = spawnSync(
  "python3",
  [
    "-c",
    `from pathlib import Path\nfrom zipfile import ZipFile,ZIP_DEFLATED\nwith ZipFile('dist/${out}','w',ZIP_DEFLATED) as z:\n for p in sorted(Path('extension').rglob('*')):\n  if p.is_file(): z.write(p,p.relative_to('extension'))\n z.write('LICENSE','LICENSE')\n z.write('THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md')`,
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status || 1);
const hash = createHash("sha256")
  .update(readFileSync("dist/" + out))
  .digest("hex");
writeFileSync("dist/SHA256SUMS", `${hash}  ${out}\n`);
console.log(`dist/${out}\nSHA256 ${hash}`);
