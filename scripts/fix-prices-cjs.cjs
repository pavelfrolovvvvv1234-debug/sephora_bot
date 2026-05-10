/**
 * After tsc, rewrite dist/helpers/prices.js to dist/helpers/prices.cjs
 * using only module.exports so Node always loads it as CommonJS.
 * Then patch all dist .js files to require("./helpers/prices.cjs") etc.
 */
const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const pricesJs = path.join(distDir, "helpers", "prices.js");
const pricesCjs = path.join(distDir, "helpers", "prices.cjs");

if (!fs.existsSync(pricesJs)) {
  console.warn("fix-prices-cjs: dist/helpers/prices.js not found, skipping");
  process.exit(0);
}

let code = fs.readFileSync(pricesJs, "utf-8");
// Remove exports.__esModule and use module.exports = default export
code = code
  .replace(/Object\.defineProperty\(exports,\s*["']__esModule["'],\s*\{\s*value:\s*true\s*\}\);?\s*\n?/g, "")
  .replace(/exports\.default\s*=/g, "module.exports =");
fs.writeFileSync(pricesCjs, code, "utf-8");
fs.unlinkSync(pricesJs);
console.log("fix-prices-cjs: wrote dist/helpers/prices.cjs, removed prices.js");

// Patch all dist/**/*.js: require(".../prices") or require(".../prices.js") -> require(".../prices.cjs")
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".js")) {
      let content = fs.readFileSync(full, "utf-8");
      const before = content;
      content = content
        .replace(
          /require\s*\(\s*(["'])([^"']*helpers\/prices)(\.js)?\1\s*\)/g,
          (_, q, p) => `require(${q}${p}.cjs${q})`
        )
        .replace(
          /require\s*\(\s*(["'])\.\/prices(\.js)?\1\s*\)/g,
          (_, q) => `require(${q}./prices.cjs${q})`
        );
      if (content !== before) {
        fs.writeFileSync(full, content, "utf-8");
        console.log("fix-prices-cjs: patched", path.relative(distDir, full));
      }
    }
  }
}
walk(distDir);
