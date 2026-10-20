import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const dir of ["src", "scripts", "test"])
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const r = spawnSync(process.execPath, ["--check", dir + "/" + file], {
      stdio: "inherit",
    });
    if (r.status) process.exit(r.status);
  }
console.log("ERPBack 0.1.0: sintaxe verificada.");
