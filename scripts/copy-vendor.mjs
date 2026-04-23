import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const assetsDir = path.join(rootDir, "app", "assets");
const fontawesomeDir = path.join(assetsDir, "fontawesome");

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(fontawesomeDir, { recursive: true });

fs.copyFileSync(
  path.join(rootDir, "node_modules", "chart.js", "dist", "chart.umd.min.js"),
  path.join(assetsDir, "chart.umd.min.js")
);

fs.mkdirSync(path.join(fontawesomeDir, "css"), { recursive: true });
fs.copyFileSync(
  path.join(rootDir, "node_modules", "@fortawesome", "fontawesome-free", "css", "all.min.css"),
  path.join(fontawesomeDir, "css", "all.min.css")
);

fs.cpSync(
  path.join(rootDir, "node_modules", "@fortawesome", "fontawesome-free", "webfonts"),
  path.join(fontawesomeDir, "webfonts"),
  { recursive: true, force: true }
);

console.log("Copied vendor assets into app/assets");
