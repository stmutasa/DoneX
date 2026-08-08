// Captures screenshots of a running DoneX instance for design review.
// Usage: node scripts/shots.mjs [baseUrl] [pin]
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync } from "fs";

const BASE = process.argv[2] || "http://localhost:3000";
const PIN = process.argv[3] || "1234";
const OUT = new URL("../shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function findChromium() {
  const roots = ["/opt/pw-browsers"];
  for (const root of roots) {
    try {
      for (const dir of readdirSync(root)) {
        if (dir.startsWith("chromium")) {
          const candidates = [
            `${root}/${dir}/chrome-linux/chrome`,
            `${root}/${dir}/chrome-linux64/chrome`,
            `${root}/${dir}`,
          ];
          for (const c of candidates) {
            try {
              readdirSync(c);
            } catch {
              return c; // it's a file (or missing — launch will tell us)
            }
          }
        }
      }
    } catch {}
  }
  return "/opt/pw-browsers/chromium";
}

const browser = await chromium.launch({ executablePath: findChromium() });
const errors = [];

async function shoot(ctx, label, path, { settle = 1200 } = {}) {
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${label}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`[${label}] PAGEERROR ${String(e).slice(0, 300)}`));
  await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${OUT}${label}.png`, fullPage: false });
  await page.close();
}

for (const [device, viewport] of [
  ["phone", { width: 412, height: 915 }],
  ["desktop", { width: 1440, height: 900 }],
]) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: device === "phone" ? 2 : 1,
    isMobile: device === "phone",
    hasTouch: device === "phone",
  });
  // login once per context
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" }).catch(() => {});
  await page.screenshot({ path: `${OUT}${device}-00-login.png` });
  const pinInput = page.locator("input").first();
  if (await pinInput.isVisible().catch(() => false)) {
    await pinInput.fill(PIN);
    const btn = page.getByRole("button").filter({ hasText: /unlock|log in|sign in|enter/i }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await pinInput.press("Enter");
    await page.waitForTimeout(1500);
  }
  await page.close();

  const routes = [
    ["01-today", "/today"],
    ["02-upcoming", "/upcoming"],
    ["03-assistant", "/assistant"],
    ["04-voice", "/voice"],
    ["05-notes", "/notes"],
    ["06-projects", "/projects"],
    ["07-inbox", "/inbox"],
    ["08-review", "/review"],
    ["09-settings", "/settings"],
  ];
  for (const [label, path] of routes) {
    await shoot(ctx, `${device}-${label}`, path);
  }
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.log("── console errors ──");
  for (const e of [...new Set(errors)]) console.log(e);
} else {
  console.log("no console errors");
}
console.log("✓ screenshots in shots/");
