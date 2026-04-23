import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "博士工作台_整合打卡逻辑优化版_fix5_sidebar_trim.html");
const appDir = path.join(rootDir, "app");
const targetPath = path.join(appDir, "index.html");

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Source HTML not found: ${sourcePath}`);
}

let html = fs.readFileSync(sourcePath, "utf8");

html = html.replace(/<title>[\s\S]*?<\/title>/, "<title>博士工作台</title>");
html = html.replace(/\s*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\r?\n/, "\n");
html = html.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^"]+"><\/script>\r?\n/, "\n");
html = html.replace(/\s*<link rel="stylesheet" href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/[^"]+">\r?\n/, "\n");
html = html.replace(/\s*<script>\s*tailwind\.config = \{[\s\S]*?<\/script>\r?\n/, "\n");
html = html.replace(
  "<title>博士工作台</title>",
  `<title>博士工作台</title>
  <link rel="stylesheet" href="./assets/tailwind.css" />
  <link rel="stylesheet" href="./assets/fontawesome/css/all.min.css" />
  <script src="./assets/chart.umd.min.js"></script>`
);

fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(targetPath, html, "utf8");

console.log(`Prepared static frontend: ${path.relative(rootDir, targetPath)}`);
