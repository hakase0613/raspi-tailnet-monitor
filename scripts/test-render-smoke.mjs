#!/usr/bin/env node
// scripts/test-render-smoke.mjs
//
// Lightweight bundle-level smoke test for the iter3 rendering surface in
// static/app.js. We don't load the file (no JSDOM, no DOM at all); we just
// read it as a string and assert that every key symbol/substring the
// render path depends on is present.
//
// This guards against accidental refactors that rename internal helpers,
// drop the offline-chip, or otherwise break the iter3 device tab / offline
// indicator without anyone noticing in CI.
//
// Run: `node scripts/test-render-smoke.mjs`
// Exit 0 on green, exit 1 on any failure.
//
// No external dependencies. Node >= 18.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appJsPath = resolve(here, "..", "static", "app.js");
const appJs = readFileSync(appJsPath, "utf8");

const requiredSubstrings = [
  "function renderCard(",
  "function dedupeTemps(",
  "function humanTempLabel(",
  "sparklineSvg",
  "deviceSortBucket",
  "offline-chip",
  "firstSeenSshFail",
  "humanDuration"
];

let passed = 0;
let failed = 0;

console.log("== static/app.js render surface ==");
for (const needle of requiredSubstrings) {
  const ok = appJs.includes(needle);
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] contains ${JSON.stringify(needle)}`);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log(`         missing ${JSON.stringify(needle)} in static/app.js`);
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
