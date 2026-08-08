// Generates DoneX PWA icons from an inline SVG using sharp.
import sharp from "sharp";
import { mkdirSync } from "fs";

const OUT = new URL("../public/icons/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// full-bleed square (iOS + maskable), rounded variant for regular icons
const svg = (rounded) => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFB454"/>
      <stop offset="1" stop-color="#FF6B6B"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    ${rounded ? '<clipPath id="r"><rect width="512" height="512" rx="115"/></clipPath>' : ""}
  </defs>
  <g ${rounded ? 'clip-path="url(#r)"' : ""}>
    <rect width="512" height="512" fill="url(#g)"/>
    <rect width="512" height="512" fill="url(#sheen)"/>
    <circle cx="420" cy="88" r="150" fill="#ffffff" fill-opacity="0.08"/>
    <path d="M128 268 L222 360 L390 172"
      fill="none" stroke="#1C1106" stroke-opacity="0.28" stroke-width="64"
      stroke-linecap="round" stroke-linejoin="round" transform="translate(0 10)"/>
    <path d="M128 268 L222 360 L390 172"
      fill="none" stroke="#ffffff" stroke-width="58"
      stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const jobs = [
  ["icon-192.png", 192, true],
  ["icon-512.png", 512, true],
  ["maskable-512.png", 512, false],
  ["apple-touch-icon.png", 180, false],
];

for (const [name, size, rounded] of jobs) {
  await sharp(Buffer.from(svg(rounded))).resize(size, size).png().toFile(OUT + name);
  console.log("wrote", name);
}
