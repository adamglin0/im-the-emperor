#!/usr/bin/env node
// 生产打包：packages/{hub,gateway,dept,sandbox}/src/main.ts → dist/<name>/main.js（单文件 ESM，打包全部依赖）。
// 用法：node scripts/build.mjs [hub gateway ...]   缺失入口的角色跳过并告警。
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["hub", "gateway", "dept", "sandbox"];
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const roles = wanted.length ? wanted : ALL;

// CJS 依赖在 ESM 包里需要 require/__dirname/__filename
const banner = [
  "import { createRequire as __court_createRequire } from 'node:module';",
  "import { fileURLToPath as __court_fileURLToPath } from 'node:url';",
  "import { dirname as __court_dirname } from 'node:path';",
  "const require = __court_createRequire(import.meta.url);",
  "const __filename = __court_fileURLToPath(import.meta.url);",
  "const __dirname = __court_dirname(__filename);",
].join("\n");

let built = 0;
let failed = 0;
for (const role of roles) {
  if (!ALL.includes(role)) {
    console.warn(`[build] 未知角色 ${role}，跳过`);
    continue;
  }
  const entry = join(root, "packages", role, "src", "main.ts");
  if (!existsSync(entry)) {
    console.warn(`[build] ⚠ ${role}: 入口 ${entry} 不存在，跳过`);
    continue;
  }
  const outdir = join(root, "dist", role);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  try {
    const t0 = Date.now();
    const result = await build({
      entryPoints: [entry],
      outfile: join(outdir, "main.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: "linked",
      legalComments: "none",
      banner: { js: banner },
      logLevel: "warning",
      metafile: true,
    });
    if (role === "hub") {
      const schema = join(root, "packages", "hub", "src", "schema.sql");
      if (existsSync(schema)) copyFileSync(schema, join(outdir, "schema.sql"));
    }
    const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
    console.log(`[build] ✓ ${role} → dist/${role}/main.js（${(bytes / 1024).toFixed(0)} KB，${Date.now() - t0} ms）`);
    built++;
  } catch (e) {
    failed++;
    console.error(`[build] ✗ ${role} 打包失败：${e.message}`);
  }
}
console.log(`[build] 完成：成功 ${built}，失败 ${failed}`);
if (failed) process.exit(1);
