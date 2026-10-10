/**
 * Synthetic phone screenshots for the image pipeline: a headline card, a two-company post, a dark-mode
 * post, a price chart, and a recipe (no company). Drawn with sharp from SVG, so they exercise read →
 * resolve → annotate without a model that has seen real apps. Replace or add real screenshots (with their
 * entry in expected.json) as they come in; the scorer treats both the same.
 *
 *   pnpm tsx src/scripts/make-image-fixtures.ts [outDir ...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const outs = process.argv.slice(2).length ? process.argv.slice(2) : ["src/services/fixtures/images", "../glance-whatsapp/fixtures/images"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const wrap = (text: string, perLine: number) => {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine) {
      lines.push(cur.trim());
      cur = w;
    } else cur = `${cur} ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
};
const textBlock = (lines: string[], x: number, y: number, size: number, fill: string, weight = 400, lh = 1.25) => lines.map((l, i) => `<text x="${x}" y="${y + i * size * lh}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(l)}</text>`).join("");

function headline(dark = false, who = "Nvidia", body = "Nvidia shares jumped 5% in early trading after the chipmaker reported record data-center revenue and raised its guidance for the quarter.") {
  const w = 1080;
  const h = 1920;
  const bg = dark ? "#0b0b10" : "#ffffff";
  const fg = dark ? "#f2f2f5" : "#111111";
  const muted = dark ? "#9a9aa8" : "#666666";
  const title = wrap(`${who} shares jump after record quarter`, 24);
  const para = wrap(body, 44);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>
    <text x="60" y="110" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="${muted}">9:41</text>
    <text x="60" y="260" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="${muted}">MARKETS · 2 hours ago</text>
    ${textBlock(title, 60, 360, 72, fg, 700, 1.15)}
    ${textBlock(para, 60, 360 + title.length * 82 + 40, 40, fg)}
    <rect x="60" y="${360 + title.length * 82 + 40 + para.length * 50 + 60}" width="960" height="540" rx="24" fill="${dark ? "#1a1a24" : "#e9e9ee"}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

function post() {
  const w = 1080;
  const h = 1600;
  const lines = wrap("Apple and Nvidia both up today. Apple on the new iPhone pre-orders out of China, Nvidia on the data-center print. Which one are you buying?", 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ffffff"/>
    <circle cx="110" cy="200" r="50" fill="#5b8cff"/>
    <text x="190" y="190" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="#111">Market Mike</text>
    <text x="190" y="236" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#666">@marketmike · 3h</text>
    ${textBlock(lines, 60, 340, 44, "#111")}
    <text x="60" y="${340 + lines.length * 55 + 60}" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#666">1.2K reposts · 4.8K likes</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

function chart() {
  const w = 1080;
  const h = 1400;
  const plot = { x: 80, y: 260, w: 900, h: 800 };
  const prices = [258, 256, 251, 247, 249, 244, 241, 243, 240.7];
  const max = 260;
  const min = 240;
  const px = (i: number) => plot.x + (plot.w * i) / (prices.length - 1);
  const py = (p: number) => plot.y + ((max - p) / (max - min)) * plot.h;
  const path = prices.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p).toFixed(1)}`).join(" ");
  const ticks = [260, 255, 250, 245, 240].map((p) => `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${py(p)}" y2="${py(p)}" stroke="#eee"/><text x="${plot.x + plot.w + 12}" y="${py(p) + 10}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#555">$${p}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ffffff"/>
    <text x="80" y="110" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="700" fill="#111">TSLA</text>
    <text x="80" y="160" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#555">Tesla, Inc. · $240.70 · -6.7% today</text>
    ${ticks}
    <path d="${path}" fill="none" stroke="#e5484d" stroke-width="6"/>
    <g font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#555">
      <text x="80" y="1140">9:30</text><text x="500" y="1140">12:00</text><text x="920" y="1140">16:00</text>
    </g>
    <g font-family="Helvetica, Arial, sans-serif" font-size="32">
      <rect x="80" y="1200" width="90" height="56" rx="12" fill="#111"/><text x="100" y="1240" fill="#fff">1D</text>
      <text x="200" y="1240" fill="#555">5D</text><text x="290" y="1240" fill="#555">1M</text><text x="380" y="1240" fill="#555">1Y</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

function recipe() {
  const w = 1080;
  const h = 1500;
  const lines = wrap("Apple pie, the easy way. Six Granny Smith apples, a cup of sugar, two tablespoons of flour, a teaspoon of cinnamon, and a store-bought crust. Bake at 425 for 45 minutes.", 42);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff8f0"/>
    <text x="60" y="200" font-family="Georgia, serif" font-size="70" font-weight="700" fill="#3a2a1a">Sunday apple pie</text>
    ${textBlock(lines, 60, 320, 42, "#3a2a1a")}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const files: Record<string, () => Promise<Buffer>> = {
  "headline.jpg": () => headline(),
  "headline-dark.jpg": () => headline(true, "Tesla", "Tesla fell 6% after deliveries missed estimates for a second quarter, with analysts pointing at softer demand in China."),
  "post-two-companies.jpg": post,
  "chart.jpg": chart,
  "recipe.jpg": recipe,
};
for (const dir of outs) {
  mkdirSync(dir, { recursive: true });
  for (const [name, make] of Object.entries(files)) writeFileSync(join(dir, name), await make());
  console.log(`wrote ${Object.keys(files).length} images to ${dir}`);
}
