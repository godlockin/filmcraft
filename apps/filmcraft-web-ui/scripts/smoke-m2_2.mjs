#!/usr/bin/env node
/**
 * M2.2 browser smoke test (M2.2 deliverable).
 *
 * Drives the real web UI bundle against the running FilmCraft server
 * with system Chrome via playwright-core, then verifies:
 *
 *   1. The root page loads with the bundle.
 *   2. ProjectDetail reaches the project list (smoke through routing).
 *   3. /api/v1/projects/{id}/fcproj returns 404 with the no-save shape.
 *   4. The bundle is the M2.2 build (filename matches the new build).
 *
 * For interactive use, navigate by hand to:
 *   http://100.117.145.94:9081/projects/<id>
 * then click the "Engine console" buttons. This script only confirms
 * the wiring is reachable.
 */

import { chromium } from "playwright-core";

const BASE = process.env.FILMCRAFT_BASE ?? "http://100.117.145.94:9081";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  // 1. Root page loads.
  const home = await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  if (home === null || home.status() !== 200) {
    throw new Error(`GET / → ${home?.status()}`);
  }
  const indexHtml = await home.text();
  const scriptName = indexHtml.match(/index-[A-Za-z0-9_-]+\.js/)?.[0];
  const cssName = indexHtml.match(/index-[A-Za-z0-9_-]+\.css/)?.[0];
  if (scriptName === undefined || cssName === undefined) {
    throw new Error(`no bundle script/css in /`);
  }
  console.log(`✓ / serves bundle ${scriptName} + ${cssName}`);

  // 2. Bundle loads cleanly (no console errors during init).
  await page.waitForLoadState("networkidle", { timeout: 5000 });
  if (errors.length > 0) {
    throw new Error(`page errors: ${errors.join("; ")}`);
  }
  console.log("✓ bundle initialises without page errors");

  // 3. /fcproj endpoint shape.
  const fcprojResp = await page.request.get(`${BASE}/api/v1/projects/noexist/fcproj`);
  if (fcprojResp.status() !== 404) throw new Error(`/fcproj noexist → ${fcprojResp.status()}`);
  const body = await fcprojResp.json();
  if (body.ok !== false || !String(body.error).includes("no saved fcproj")) {
    throw new Error(`/fcproj body unexpected: ${JSON.stringify(body)}`);
  }
  console.log("✓ /api/v1/projects/{id}/fcproj returns 404 + no-save shape");

  // 4. Project list page reaches a rendered list.
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
  const rootHtml = await page.content();
  // The M1.7 page renders the heading "Projects" + an upload/new form.
  if (!rootHtml.includes("Projects")) {
    throw new Error("/projects did not render the Projects page");
  }
  console.log("✓ /projects page renders");

  // 5. Confirm the M2.2 strings are actually present in the JS bundle.
  const jsResp = await page.request.get(`${BASE}/assets/${scriptName}`);
  if (jsResp.status() !== 200) throw new Error(`/assets/${scriptName} → ${jsResp.status()}`);
  const js = await jsResp.text();
  for (const needle of ["engine-console", "inspectSequence", "prefs.set", "engine.execute", "fetchRawFcproj", "rawFcproj"]) {
    if (!js.includes(needle)) throw new Error(`bundle missing \`${needle}\``);
  }
  console.log("✓ bundle contains M2.2 entry points (engine-console / inspectSequence / prefs.set / engine.execute / fetchFcproj / rawFcproj)");

  await browser.close();
  console.log("\nALL OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});