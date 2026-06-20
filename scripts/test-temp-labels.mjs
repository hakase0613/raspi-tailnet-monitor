#!/usr/bin/env node
// scripts/test-temp-labels.mjs
//
// Lightweight smoke test for the temperature-label normalization that lives
// inside static/app.js. We re-implement the rules here (kept in sync by
// hand — both files are intentionally tiny) and also load the browser
// bundle to assert that the inlined logic exists.
//
// Run: `node scripts/test-temp-labels.mjs`
// Exit 0 on green, exit 1 on first failure with a clear diff.
//
// No external dependencies. Node >= 18.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appJsPath = resolve(here, "..", "static", "app.js");
const appJs = readFileSync(appJsPath, "utf8");

// --- Reference implementation, kept structurally identical to app.js ---
function humanTempLabel(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "传感器";
  const lower = s.toLowerCase();
  if (lower.indexOf("k10temp") >= 0) return "CPU 核心 (Tctl)";
  if (lower === "tctl" || lower.indexOf("tctl") >= 0) return "CPU 核心 (Tctl)";
  if (lower === "tdie" || lower.indexOf("tdie") >= 0) return "CPU Die (Tdie)";
  if (lower.indexOf("coretemp") >= 0) return "Intel CPU (coretemp)";
  if (lower.indexOf("package id") >= 0 || lower.indexOf("physical id") >= 0) return "Intel CPU 封装";
  if (/(^|[^a-z])core\s*\d+/i.test(s) || lower === "core") return "CPU 核心";
  if (lower.indexOf("cpu-thermal") >= 0 || lower.indexOf("cpu_thermal") >= 0 || lower === "cpu") return "CPU 温度";
  if (lower === "edge" || lower === "amdgpu-edge") return "核显 (edge)";
  if (lower === "junction" || lower.indexOf("junction") >= 0) return "核显结点 (junction)";
  if (lower.indexOf("amdgpu") >= 0) return "核显 (amdgpu)";
  if (lower.indexOf("tesla") >= 0) return "NVIDIA Tesla";
  if (lower.indexOf("nvidia") >= 0 || lower.indexOf("geforce") >= 0 || lower.indexOf("quadro") >= 0) return "NVIDIA GPU";
  if (lower === "mem") return "显存 (mem)";
  if (lower.indexOf("composite") >= 0) return "NVMe Composite";
  if (lower.indexOf("nvme") >= 0) return "NVMe 固态";
  if (lower === "acpitz" || lower === "x86_pkg_temp" || lower.indexOf("acpitz") >= 0 || lower.indexOf("x86_pkg_temp") >= 0) return "主板/封装";
  return s;
}

function tempBucket(raw) {
  const lower = String(raw == null ? "" : raw).toLowerCase();
  if (!lower) return { group: 99, key: "misc" };
  if (lower.indexOf("tctl") >= 0 || lower.indexOf("k10temp") >= 0) return { group: 1, key: "cpu-tctl" };
  if (lower.indexOf("tdie") >= 0) return { group: 1, key: "cpu-tdie" };
  if (lower.indexOf("coretemp") >= 0 || lower.indexOf("package id") >= 0) return { group: 1, key: "cpu-pkg" };
  if (/(^|[^a-z])core\s*\d+/i.test(lower) || lower === "core") return { group: 1, key: "cpu-core-" + lower };
  if (lower.indexOf("cpu-thermal") >= 0 || lower.indexOf("cpu_thermal") >= 0 || lower === "cpu") return { group: 1, key: "cpu-thermal" };
  if (lower === "edge" || lower.indexOf("amdgpu") >= 0) return { group: 2, key: "igpu-edge" };
  if (lower.indexOf("junction") >= 0) return { group: 2, key: "igpu-junction" };
  if (lower === "mem") return { group: 2, key: "igpu-vram" };
  if (lower.indexOf("tesla") >= 0 || lower.indexOf("nvidia") >= 0 || lower.indexOf("geforce") >= 0 || lower.indexOf("quadro") >= 0) return { group: 3, key: "nvgpu-" + lower };
  if (lower.indexOf("composite") >= 0 || lower.indexOf("nvme") >= 0) return { group: 4, key: "nvme" };
  if (lower.indexOf("acpitz") >= 0 || lower.indexOf("x86_pkg_temp") >= 0) return { group: 4, key: "acpitz" };
  return { group: 5, key: "misc-" + lower };
}

// --- Test cases ---
const labelCases = [
  ["Tctl", "CPU 核心 (Tctl)", 1],
  ["k10temp Tctl", "CPU 核心 (Tctl)", 1],
  ["Tdie", "CPU Die (Tdie)", 1],
  ["Core 0", "CPU 核心", 1],
  ["Core 7", "CPU 核心", 1],
  ["coretemp", "Intel CPU (coretemp)", 1],
  ["coretemp Package id 0", "Intel CPU (coretemp)", 1],
  ["Package id 0", "Intel CPU 封装", 1],
  ["edge", "核显 (edge)", 2],
  ["junction", "核显结点 (junction)", 2],
  ["amdgpu", "核显 (amdgpu)", 2],
  ["Tesla P4", "NVIDIA Tesla", 3],
  ["nvidia GeForce GT 710", "NVIDIA GPU", 3],
  ["acpitz", "主板/封装", 4],
  ["x86_pkg_temp", "主板/封装", 4],
  ["Composite", "NVMe Composite", 4],
  ["nvme0", "NVMe 固态", 4],
  ["mem", "显存 (mem)", 2],
  ["", "传感器", 99],
  ["unknown-sensor", "unknown-sensor", 5]
];

let failures = 0;
let passed = 0;

console.log("== humanTempLabel ==");
for (const [input, expectedLabel, expectedGroup] of labelCases) {
  const got = humanTempLabel(input);
  const bucket = tempBucket(input);
  const ok = got === expectedLabel && bucket.group === expectedGroup;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${JSON.stringify(input)} -> ${JSON.stringify(got)} (group ${bucket.group})`);
  if (!ok) {
    console.log(`         expected: ${JSON.stringify(expectedLabel)} (group ${expectedGroup})`);
    failures++;
  } else {
    passed++;
  }
}

// --- Priority assertion: same set of labels, mixed order, sorts CPU first ---
console.log("\n== priority order: CPU > iGPU > NVIDIA > NVMe/board ==");
const samples = [
  { label: "acpitz" },
  { label: "Tesla P4" },
  { label: "edge" },
  { label: "Tctl" },
  { label: "Composite" },
  { label: "junction" },
  { label: "Core 0" },
  { label: "amdgpu" }
];
const sorted = samples
  .map(s => ({ ...s, group: tempBucket(s.label).group }))
  .sort((a, b) => a.group - b.group);
const order = sorted.map(s => s.label);
console.log("  order:", order.join(" -> "));
const cpuIdx = order.findIndex(l => /tctl|core/i.test(l));
const iGpuIdx = order.findIndex(l => /edge|junction|amdgpu/i.test(l));
const nvIdx = order.findIndex(l => /tesla|nvidia/i.test(l));
const otherIdx = order.findIndex(l => /acpitz|composite/i.test(l));
const orderedOk = cpuIdx >= 0 && cpuIdx < iGpuIdx && iGpuIdx < nvIdx && nvIdx < otherIdx;
if (orderedOk) {
  console.log("  [PASS] CPU < iGPU < NVIDIA < other");
  passed++;
} else {
  console.log(`  [FAIL] indices cpu=${cpuIdx} iGPU=${iGpuIdx} nv=${nvIdx} other=${otherIdx}`);
  failures++;
}

// --- Asset assertion: app.js bundle still exposes the new symbols ---
console.log("\n== static/app.js bundle integrity ==");
const expectedSymbols = [
  "function humanTempLabel(",
  "function tempBucket(",
  "function dedupeTemps(",
  "data-compute-idle",
  "采集滞后"
];
for (const sym of expectedSymbols) {
  if (appJs.includes(sym)) {
    console.log(`  [PASS] contains ${JSON.stringify(sym)}`);
    passed++;
  } else {
    console.log(`  [FAIL] missing ${JSON.stringify(sym)} in static/app.js`);
    failures++;
  }
}

console.log(`\nResult: ${passed} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
