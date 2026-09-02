// Rewrites extensionless relative imports in dist/**/*.js to .js so the
// compiled ESM server can run under plain `node` (no bundler).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

async function walk(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = await walk("dist");
for (const file of files) {
  let text = await fsp.readFile(file, "utf8");
  const original = text;
  text = text.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (match, prefix, spec, suffix) => {
      if (spec.endsWith(".js") || spec.endsWith(".json")) return match;
      const resolved = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(resolved + ".js")) {
        return `${prefix}${spec}.js${suffix}`;
      }
      if (fs.existsSync(path.join(resolved, "index.js"))) {
        return `${prefix}${spec}/index.js${suffix}`;
      }
      return match;
    }
  );
  if (text !== original) {
    await fsp.writeFile(file, text, "utf8");
    console.log("fixed", file);
  }
}
console.log("done");
