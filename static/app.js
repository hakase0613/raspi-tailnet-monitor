/* Hakase Tailnet 监控中心 - dashboard controller */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const devicesEl = $("#devices");
  const metaEl = $("#meta");
  const metaText = $("#meta-text");
  const summaryEl = $("#kpis");
  const bannerEl = $("#banner");
  const toastEl = $("#toast");
  const legendTime = $("#legend-time");
  const footErr = $("#foot-err");
  const filterInput = $("#filter-text");
  const segBtns = $$(".seg-btn");
  const tpl = $("#device-card");
  const taskTpl = $("#task-card");
  const taskColActive = $("#task-col-active");
  const taskColDoneToday = $("#task-col-done-today");
  const taskColHistory = $("#task-col-history");
  const taskCountActive = $("#task-count-active");
  const taskCountDoneToday = $("#task-count-done-today");
  const taskCountHistory = $("#task-count-history");
  const taskBoardTime = $("#task-board-time");
  const taskRefreshBtn = $("#task-refresh");
  const taskHistoryToggle = $("#task-history-toggle");
  const taskHistoryCol = $(".task-col[data-col='history']");

  /* ---------- helpers ---------- */
  const history = new Map();      // name -> array of { t, cpu, mem, disk, load, gpu, vram, temp }
  const MAX_HISTORY = 48;
  const prevSnapshot = new Map(); // name -> previous state signature for change detection
  let lastData = null;
  let lastSuccessAt = 0;
  let retryAttempt = 0;
  let activeFilter = "all";
  let activeText = "";
  let refreshTimer = null;
  let refreshIntervalMs = 8000; // base cadence; updated by /api/status.poll_interval_seconds
  let inFlight = false;
  let pendingForce = false;      // a manual refresh was requested while a request was in-flight
  let firstLoad = true;
  /* ---------- task board state ---------- */
  let taskRefreshTimer = null;
  let taskInFlight = false;
  let taskLastSuccessAt = 0;
  let lastTasks = [];
  const TASK_REFRESH_MS = 15000;
  /* history column is collapsed by default; remember the choice in memory only. */
  let historyExpanded = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }
  // Number coercion that preserves the distinction between:
  //   - real numeric value (including 0 / 0.0) -> returned as a Number
  //   - missing / non-numeric / NaN            -> returned as null
  // Callers must treat the two cases differently in the UI: 0 means "I have
  // data and the metric is idle", while null means "no data at all".
  //
  // Note: we explicitly reject null/undefined/"", because Number(null) === 0
  // and Number("") === 0 in JavaScript, which would otherwise make "no data"
  // look like a valid 0 reading. Strings like "--" still become NaN -> null
  // because Number("--") is NaN. This is what the 0-vs-null UI distinction
  // in miniGauge / gaugeCard / bar / thermometer relies on.
  function num(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  /**
   * Map a raw /sys/class/hwmon sensor label into a human-friendly Chinese name.
   * Unknown labels fall through unchanged so the original string is always
   * visible (better than "Unknown" for power users).
   * Order matters: longer / more specific keys are checked first.
   */
  function humanTempLabel(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "传感器";
    const lower = s.toLowerCase();
    // ---- Priority order (iter2): CPU core -> iGPU -> NVIDIA/Tesla -> NVMe/board ----
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
  /**
   * Bucket a raw sensor label into a coarse group used for both ordering and
   * deduplication. Same bucket+human label collapses to the hottest reading.
   */
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
  function dedupeTemps(temps) {
    if (!Array.isArray(temps)) return [];
    const map = new Map();
    const order = [];
    temps.forEach(t => {
      if (!t) return;
      const c = num(t.temp_c);
      const human = humanTempLabel(t.label || "传感器");
      const bucket = tempBucket(t.label || "");
      const key = bucket.key + "|" + human;
      if (!map.has(key)) {
        map.set(key, { label: t.label || "传感器", human, group: bucket.group, temp_c: c, source: t.source || "", merged: 1 });
        order.push(key);
        return;
      }
      const cur = map.get(key);
      cur.merged += 1;
      if (c != null && (cur.temp_c == null || c > cur.temp_c)) {
        cur.temp_c = c;
        cur.label = t.label || cur.label;
        cur.source = t.source || cur.source;
      }
    });
    const out = order.map(k => map.get(k));
    out.sort((a, b) => (a.group - b.group));
    return out;
  }
  /**
   * Map a Celsius value to a temperature level: "ok" / "warn" / "bad" / "neutral".
   * Reused by thermometer() so that the per-card text and the tube color agree.
   *  - < 65   -> ok     (正常)
   *  - 65-82  -> warn   (偏高)
   *  - >= 82  -> bad    (过热)
   *  - null   -> neutral (无数据)
   */
  function tempLevel(c) {
    c = num(c);
    if (c == null) return "neutral";
    if (c >= 82) return "bad";
    if (c >= 65) return "warn";
    return "ok";
  }
  function tempLevelLabel(level) {
    if (level === "bad") return "过热";
    if (level === "warn") return "偏高";
    if (level === "ok") return "正常";
    return "无数据";
  }
  function clamp(v, min, max) {
    v = num(v);
    if (v == null) return null;
    return Math.max(min, Math.min(max, v));
  }
  function fmtBytes(n) {
    n = num(n);
    if (n == null) return "--";
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return x.toFixed(i ? 1 : 0) + " " + u[i];
  }
  function fmtUptime(s) {
    s = num(s);
    if (s == null) return "--";
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return [d && (d + "d"), h && (h + "h"), m + "m"].filter(Boolean).join(" ") || "< 1m";
  }
  function pct(v) { v = num(v); return v == null ? "--" : v.toFixed(v % 1 ? 1 : 0) + "%"; }
  /**
   * Format an absolute timestamp using the timezone embedded in the ISO
   * string itself (the offset part, e.g. "+08:00" or "Z"). This avoids the
   * pitfall where `toLocaleString` reinterprets the moment in the *viewer's*
   * local timezone, which is wrong for cross-region users on a single
   * monitoring server.
   *
   * If the input has no offset, we fall back to UTC.
   * Returns a string like "2026-06-20 22:30:45 +08:00".
   */
  function fmtIsoInSourceTz(iso) {
    if (!iso) return "--";
    if (typeof iso !== "string") iso = String(iso);
    // Normalize trailing "Z" -> "+00:00" so Date parsing keeps the offset.
    const normalized = /[Zz]$/.test(iso) ? iso.replace(/[Zz]$/, "+00:00") : iso;
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return iso;
    // Use the parts that match the offset baked into the ISO string itself,
    // not the viewer's local clock.
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const y = d.getUTCFullYear();
    const mo = pad(d.getUTCMonth() + 1);
    const da = pad(d.getUTCDate());
    const hh = pad(d.getUTCHours());
    const mm = pad(d.getUTCMinutes());
    const ss = pad(d.getUTCSeconds());
    // Re-extract the offset that was in the original string (so "源时区" = source tz).
    const m = iso.match(/([+-]\d{2}:?\d{2}|Z|[+-]\d{2})$/);
    const off = m ? m[1].replace(/(\d{2})(\d{2})$/, "$1:$2") : "+00:00";
    return y + "-" + mo + "-" + da + " " + hh + ":" + mm + ":" + ss + " " + off;
  }
  function fmtIsoTimeInSourceTz(iso) {
    if (!iso) return "--";
    const full = fmtIsoInSourceTz(iso);
    // Trim to HH:MM:SS for compact card footers; keep offset tag.
    return full.length >= 19 ? full.substring(11, 19) + " " + full.substring(20) : full;
  }
  function relTime(isoOrTs) {
    if (!isoOrTs) return "--";
    const t = typeof isoOrTs === "number" ? isoOrTs : new Date(isoOrTs).getTime();
    if (!Number.isFinite(t)) return "--";
    const diff = (Date.now() - t) / 1000;
    if (diff < 5) return "刚刚";
    if (diff < 60) return Math.floor(diff) + " 秒前";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    return Math.floor(diff / 86400) + " 天前";
  }
  function toneFor(v, warn, bad) {
    v = num(v);
    if (v == null) return "neutral";
    if (v >= bad) return "bad";
    if (v >= warn) return "warn";
    return "ok";
  }
  function deviceTone(dev) {
    if (!dev) return "bad";
    // Local hosts are always treated as "ok": self-ping is intentionally
    // skipped and the network category is "local".
    const isLocal = !!(dev.is_self || (dev.network || (dev.tailscale && dev.tailscale.network)) === "local");
    if (isLocal) return "ok";
    if (dev.ok) {
      // OK overall; escalate to warn if any monitored service is failing
      const d = dev.ssh && dev.ssh.data;
      if (d && Array.isArray(d.services)) {
        const failing = d.services.filter(s => s && s.active && s.active !== "active" && s.active !== "unknown" && s.active !== "inactive");
        if (failing.length && dev.monitored_only) return "warn";
      }
      return "ok";
    }
    // not ok: distinguish warn vs bad
    const ts = dev.tailscale || {};
    if (ts.ok) return "warn";
    return "bad";
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  /* ---------- builders ---------- */
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function setHTML(parent, html) { parent.innerHTML = html; }
  function chip(label, tone, detail) {
    tone = tone || "neutral";
    return '<span class="chip ' + tone + '"><span class="chip-dot" aria-hidden="true"></span><b>' + esc(label) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>';
  }
  // Empty-state helper.
  // `tone` distinguishes three semantic categories so the card can surface the
  // right hint to the user:
  //   "skipped"     - SSH collection is intentionally disabled by config (class a)
  //   "failed"      - SSH collection tried but failed (unreachable / auth / timeout, class b)
  //   "unavailable" - SSH collection succeeded, but the device has no such hardware
  //                   (no temperature sensor, no GPU, no model service, class c)
  // Anything else falls back to a neutral grey note.
  function emptyState(text, compact, tone) {
    const t = tone || "neutral";
    return '<div class="empty-state' + (compact ? ' compact' : '') + ' tone-' + t + '" data-empty-kind="' + t + '">'
      + '<span class="empty-icon" aria-hidden="true"></span>'
      + '<span class="empty-text">' + esc(text) + '</span>'
      + '</div>';
  }
  function miniGauge(label, value, detail, warn, bad, abbr) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    const isNA = v == null ? 1 : 0;
    const isIdle = v === 0 ? 1 : 0;
    const detailWithIdle = isIdle
      ? (detail ? (detail + ' · 空闲') : '空闲')
      : (detail || "");
    return '<article class="mini-gauge ' + tone + '" style="--p:' + p + '" data-na="' + isNA + '" data-idle="' + isIdle + '" title="' + esc(label) + ' ' + pct(value) + '">'
      + '<div class="dial" aria-label="' + esc(label) + ' ' + pct(value) + '"><span>' + pct(value) + '</span></div>'
      + '<div class="dial-text"><b>' + esc(abbr || label) + '</b><small>' + esc(detailWithIdle) + '</small></div>'
      + '</article>';
  }
  function gaugeCard(label, value, detail, warn, bad) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    const isNA = v == null ? 1 : 0;
    const isIdle = v === 0 ? 1 : 0;
    const detailWithIdle = isIdle
      ? (detail ? (detail + ' · 空闲') : '空闲')
      : (detail || "");
    return '<article class="gauge-card ' + tone + '" style="--p:' + p + '" data-na="' + isNA + '" data-idle="' + isIdle + '">'
      + '<div class="gauge"><span>' + pct(value) + '</span></div>'
      + '<div class="gauge-text"><b>' + esc(label) + '</b><small>' + esc(detailWithIdle) + '</small></div>'
      + '</article>';
  }
  function bar(label, value, detail, warn, bad) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    const isNA = v == null ? 1 : 0;
    const isIdle = v === 0 ? 1 : 0;
    const detailWithIdle = isIdle
      ? (detail ? (detail + ' · 空闲') : '空闲')
      : (detail || "");
    return '<div class="bar-row ' + tone + '" data-na="' + isNA + '" data-idle="' + isIdle + '">'
      + '<div class="bar-top"><span>' + esc(label) + '</span><b>' + pct(value) + '</b></div>'
      + '<div class="bar"><i style="width:' + p + '%"></i></div>'
      + (detailWithIdle ? '<small>' + esc(detailWithIdle) + '</small>' : '')
      + '</div>';
  }
  function thermometer(label, c, detail) {
    c = num(c);
    const p = c == null ? 0 : Math.max(0, Math.min(100, (c / 90) * 100));
    const level = tempLevel(c);
    const levelText = tempLevelLabel(level);
    const tempStr = c == null ? '--' : c.toFixed(c % 1 ? 1 : 0) + '°C';
    const isNA = c == null ? 1 : 0;
    const isIdle = c === 0 ? 1 : 0;
    const friendlyLabel = humanTempLabel(label);
    const titleExtra = isNA
      ? '（无数据）'
      : (isIdle ? '（空闲 / 0°C 视为有效值）' : '（' + levelText + '）');
    return '<article class="thermo ' + level + '" style="--temp:' + p + '" data-na="' + isNA + '" data-idle="' + isIdle + '" data-level="' + level + '" title="' + esc(friendlyLabel) + ' ' + tempStr + ' ' + titleExtra + '">'
      + '<div class="tube"><i></i></div>'
      + '<div><b>' + esc(friendlyLabel) + '</b><strong>' + tempStr + '</strong>'
      + '<small><span class="thermo-level ' + level + '">' + levelText + '</span>' + (detail ? ' · ' + esc(detail) : '') + '</small>'
      + '</div></article>';
  }
  function spark(vals, label) {
    vals = (vals || []).map(num).filter(v => v != null);
    if (vals.length < 2) {
      return '<div class="spark empty" role="img" aria-label="' + esc(label) + '">采集中…</div>';
    }
    const w = 160, h = 36, pad = 4;
    const max = Math.max.apply(null, vals.concat([1]));
    const min = Math.min.apply(null, vals.concat([0]));
    const span = (max - min) || 1;
    const step = vals.length > 1 ? (w - pad * 2) / (vals.length - 1) : 0;
    const pts = vals.map((v, i) => (pad + i * step) + "," + (h - pad - ((v - min) / span) * (h - pad * 2))).join(" ");
    const area = "M " + pad + "," + (h - pad) + " L " + pts + " L " + (pad + (vals.length - 1) * step) + "," + (h - pad) + " Z";
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">'
      + '<path class="area" d="' + area + '"/><polyline points="' + pts + '"/></svg>';
  }

  /* ---------- per-device persistence ---------- */
  function remember(dev) {
    if (!dev || !dev.name) return;
    const d = dev.ssh && dev.ssh.data || {};
    const g = (d.gpu && d.gpu.gpus && d.gpu.gpus[0]) || {};
    const rec = {
      t: Date.now(),
      cpu: num(d.cpu_percent), mem: num(d.memory && d.memory.used_percent),
      disk: num(d.disk_root && d.disk_root.used_percent), load: num((d.loadavg || [])[0]),
      gpu: num(g.utilization_gpu_percent), vram: num(g.memory_used_percent), temp: num(g.temperature_c)
    };
    const arr = history.get(dev.name) || [];
    arr.push(rec);
    while (arr.length > MAX_HISTORY) arr.shift();
    history.set(dev.name, arr);
  }
  function hist(name, key) { return (history.get(name) || []).map(x => x[key]); }
  function signature(dev) {
    if (!dev) return "";
    const d = dev.ssh && dev.ssh.data || {};
    return [
      dev.ok ? 1 : 0,
      dev.tailscale && dev.tailscale.ok ? 1 : 0,
      dev.ssh && dev.ssh.ok ? 1 : 0,
      num(d.cpu_percent), num(d.memory && d.memory.used_percent), num(d.disk_root && d.disk_root.used_percent),
      num((d.loadavg || [])[0])
    ].join("|");
  }
  function detectChange(name, dev) {
    const sig = signature(dev);
    const prev = prevSnapshot.get(name);
    prevSnapshot.set(name, sig);
    if (prev == null) return null;
    if (prev === sig) return null;
    return { prev: prev, now: sig };
  }

  /* ---------- rendering ---------- */
  function renderKpis(data) {
    const devs = (data.devices || []).filter(Boolean);
    const total = devs.length;
    let ok = 0, warn = 0, bad = 0, derp = 0, direct = 0;
    let gpuCount = 0, modelsActive = 0, totalCpu = 0, cpuSamples = 0, totalMem = 0, memSamples = 0;
    devs.forEach(d => {
      const tone = deviceTone(d);
      // Local hosts are never counted as "offline" — they are always online.
      const isLocal = !!(d && (d.is_self || (d.network || (d.tailscale && d.tailscale.network)) === "local"));
      if (isLocal) {
        ok++;
      } else if (tone === "ok") {
        ok++;
      } else if (tone === "warn") {
        warn++;
      } else {
        bad++;
      }
      if (d.tailscale && d.tailscale.via_derp) derp++;
      if (d.tailscale && d.tailscale.direct) direct++;
      const dd = d.ssh && d.ssh.data;
      if (dd) {
        if (dd.gpu && dd.gpu.available) gpuCount += (dd.gpu.gpus || []).length;
        if (Array.isArray(dd.model_activity)) modelsActive += dd.model_activity.filter(m => m && m.last_call).length;
        const cpu = num(dd.cpu_percent);
        if (cpu != null) { totalCpu += cpu; cpuSamples++; }
        const mem = num(dd.memory && dd.memory.used_percent);
        if (mem != null) { totalMem += mem; memSamples++; }
      }
    });
    const avgCpu = cpuSamples ? totalCpu / cpuSamples : null;
    const avgMem = memSamples ? totalMem / memSamples : null;
    const pi = num(data.poll_interval_seconds) || 60;
    const minPi = num(data.poll_interval_min_seconds) || pi;
    const maxPi = num(data.poll_interval_max_seconds) || pi;

    const cards = [
      { label: "在线设备", value: ok + "/" + total, foot: total ? (ok === total ? "全部正常" : (ok === 0 ? "全部离线" : (warn + bad) + " 台需关注")) : "暂无设备", tone: ok === total ? "ok" : (ok === 0 ? "bad" : "warn") },
      { label: "告警设备", value: warn + "", foot: warn ? "需关注" : "无", tone: warn ? "warn" : "ok" },
      { label: "离线设备", value: bad + "", foot: bad ? "不可达" : "无", tone: bad ? "bad" : "ok" },
      { label: "GPU 在线", value: gpuCount + "", foot: gpuCount ? "已识别" : "暂无", tone: gpuCount ? "ok" : "neutral" },
      { label: "平均 CPU", value: avgCpu == null ? "--" : avgCpu.toFixed(0) + "%", foot: avgMem == null ? "" : ("平均内存 " + avgMem.toFixed(0) + "%"), tone: avgCpu == null ? "neutral" : toneFor(avgCpu, 60, 80) },
      { label: "Tailscale 链路", value: direct + " 直连", foot: derp + " 经 DERP", tone: derp ? "warn" : "ok" }
    ];
    setHTML(summaryEl, cards.map(c =>
      '<article class="kpi ' + c.tone + '" data-tone="' + c.tone + '"><div class="kpi-label">' + esc(c.label) + '</div>'
      + '<div class="kpi-value"><b>' + esc(c.value) + '</b></div>'
      + '<div class="kpi-foot">' + esc(c.foot || "") + '</div></article>'
    ).join(""));

    // Top stat chips
    const set = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = String(n); };
    set("stat-ok", ok);
    set("stat-warn", warn);
    set("stat-bad", bad);

    // Poll cadence label
    const cadence = minPi === maxPi
      ? "轮询 " + pi + " 秒"
      : "轮询 " + minPi + "-" + maxPi + " 秒";
    if (legendTime) legendTime.textContent = cadence;
  }

  function renderOps(container, items, kind, sshState) {
    if (!container) return;
    // SSH-level gating: if the SSH probe was skipped or failed for this device,
    // we have no per-service/port/health data, so surface that explicitly
    // rather than the misleading "暂无xxx".
    if (sshState && sshState.skipped) {
      container.innerHTML = emptyState("采集已按配置关闭", true, "skipped");
      return;
    }
    if (sshState && sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      container.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), true, "failed");
      return;
    }
    if (!items || !items.length) {
      container.innerHTML = emptyState("该设备未配置" + kind, true, "unavailable");
      return;
    }
    container.innerHTML = "";
    items.forEach(x => {
      if (!x) return;
      if (kind === "服务") {
        const active = x.active === "active";
        container.insertAdjacentHTML("beforeend", chip(x.name || "?", active ? "ok" : "bad", (x.active || "?") + " · " + (x.enabled || "?")));
      } else if (kind === "端口") {
        container.insertAdjacentHTML("beforeend", chip(":" + x.port, x.listening ? "ok" : "bad", x.listening ? "监听中" : "未开放"));
      } else {
        container.insertAdjacentHTML("beforeend", chip(x.url || "?", x.ok ? "ok" : "bad", x.ok ? ("HTTP " + x.status) : (x.error || "失败")));
      }
    });
  }

  function renderTemps(elm, temps, sshState) {
    if (!elm) return;
    // SSH-level gates: do NOT show "无温度传感器" when the real reason is that
    // SSH never reported in. That confuses the user into thinking the device
    // has no hwmon while in fact we just couldn't read /sys.
    if (sshState && sshState.skipped) {
      elm.innerHTML = emptyState("采集已按配置关闭", false, "skipped");
      return;
    }
    if (sshState && sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      elm.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), false, "failed");
      return;
    }
    if (!temps || !temps.length) {
      elm.innerHTML = emptyState("无温度传感器（设备无 /sys/class/thermal 或 hwmon 读数）", false, "unavailable");
      return;
    }
    // Use humanTempLabel to translate raw sensor labels (Tctl / edge / mem / ...)
    // into readable Chinese names. Source path is kept in the detail line for
    // power users who want to know which /sys file this came from. Same label
    // appearing through multiple hwmon paths is merged via dedupeTemps() to
    // the hottest reading and rendered in CPU → iGPU → NVIDIA → other order.
    const merged = dedupeTemps(temps).slice(0, 8);
    elm.innerHTML = merged.map(t => {
      if (!t) return "";
      const detail = (t.merged > 1 ? "合并 " + t.merged + " 路 · " : "") + (t.source || "");
      return thermometer(t.label || "传感器", num(t.temp_c), detail);
    }).join("");
  }

  function renderQuickMetrics(elm, d, name, sshState) {
    if (!elm) return;
    if (sshState && sshState.skipped) {
      elm.innerHTML = emptyState("采集已按配置关闭", false, "skipped");
      return;
    }
    if (sshState && sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      elm.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), false, "failed");
      return;
    }
    if (!d) {
      elm.innerHTML = emptyState("暂无可采集的资源数据", false, "neutral");
      return;
    }
    const g = (d.gpu && d.gpu.gpus && d.gpu.gpus[0]) || {};
    const loadVal = (d.loadavg || [])[0];
    const gpuAvailable = !!(d.gpu && d.gpu.available);
    elm.innerHTML = [
      miniGauge("CPU", d.cpu_percent, "负载 " + (loadVal == null ? "--" : loadVal), 70, 88, "CPU"),
      miniGauge("内存", d.memory && d.memory.used_percent, fmtBytes(d.memory && d.memory.used) + " / " + fmtBytes(d.memory && d.memory.total), 70, 88, "内存"),
      miniGauge("GPU", g.utilization_gpu_percent, gpuAvailable ? (g.name || "GPU") : "该设备无 GPU", 70, 88, "GPU"),
      miniGauge("VRAM", g.memory_used_percent, gpuAvailable ? (g.memory_used_mib + " / " + g.memory_total_mib + " MiB") : "该设备无 GPU", 78, 92, "VRAM")
    ].join("");
  }

  function renderModelActivity(elm, items, sshState) {
    if (!elm) return;
    if (sshState && sshState.skipped) {
      elm.innerHTML = emptyState("采集已按配置关闭", false, "skipped");
      return;
    }
    if (sshState && sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      elm.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), false, "failed");
      return;
    }
    if (!items || !items.length) { elm.innerHTML = emptyState("该设备未配置模型服务", false, "unavailable"); return; }
    elm.innerHTML = "";
    items.forEach(item => {
      if (!item) return;
      const last = item.last_call;
      const box = el("article", "activity-card");
      if (!last) {
        box.innerHTML = '<div class="activity-title"><b>' + esc(item.label || item.service || "模型") + '</b><span>' + esc(item.service || "") + '</span></div>'
          + emptyState(item.note || item.error || "暂无最近调用", true, "neutral");
      } else {
        const evalT = num(last.eval_tokens_per_second);
        const total = num(last.total_ms);
        const tokens = num(last.total_tokens != null ? last.total_tokens : last.eval_tokens);
        const throughputPct = evalT == null ? 0 : Math.min(100, Math.max(0, evalT / 2));
        box.innerHTML = '<div class="activity-title"><b>' + esc(item.label || item.service || "模型") + '</b><span>' + esc(item.service || "") + '</span></div>'
          + '<div class="metric-strip">'
          + '<div><b>' + esc(last.task_id || "?") + '</b><small>任务</small></div>'
          + '<div><b>' + (evalT == null ? '--' : evalT.toFixed(1)) + '</b><small>tok/s</small></div>'
          + '<div><b>' + (tokens == null ? '--' : tokens) + '</b><small>tokens</small></div>'
          + '<div><b>' + (total == null ? '--' : total.toFixed(0)) + '</b><small>总耗时 ms</small></div>'
          + '</div>'
          + bar("吞吐", throughputPct, "提示 " + (last.prompt_tokens == null ? "--" : last.prompt_tokens) + " tok · 生成 " + (last.eval_tokens == null ? "--" : last.eval_tokens) + " tok", 50, 85)
          + '<p class="timeline">最近 ' + esc(last.completed_at || last.last_seen || last.started_at || "未知") + ' · ' + esc(last.source || "日志") + '</p>';
      }
      elm.appendChild(box);
    });
  }

  function renderCard(dev) {
    if (!dev) return null;
    remember(dev);
    const node = tpl.content.firstElementChild.cloneNode(true);
    const tone = deviceTone(dev);
    node.setAttribute("data-state", tone);
    node.dataset.name = dev.name || "";
    node.querySelector(".title").textContent = dev.name || "未命名";
    node.querySelector(".notes").textContent = dev.notes || "";
    const badge = node.querySelector(".badge");
    let badgeText = "正常";
    let badgeTone = "ok";
    const isSelf = !!dev.is_self;
    const network = (dev.network || (dev.tailscale && dev.tailscale.network) || "").toString();
    if (isSelf || network === "local") {
      // Self / local host: never red "offline".
      badgeText = isSelf ? "本机" : "本地";
      badgeTone = "ok";
    } else if (!dev.ok) {
      const ts = dev.tailscale || {};
      badgeTone = ts.ok ? "warn" : "bad";
      badgeText = ts.ok ? "网络受限" : "离线";
    } else if (dev.monitored_only) {
      badgeText = "监控正常";
    }
    badge.className = "badge " + badgeTone;
    badge.textContent = badgeText;
    const piEl = node.querySelector(".poll-interval");
    const intervals = (lastData && lastData.poll_intervals) || null;
    // Always trust the backend-supplied per-device interval. Do not hardcode
    // any default here so the displayed value never drifts from the actual
    // _device_interval_map() output.
    if (intervals && dev.name && intervals[dev.name]) {
      piEl.textContent = "轮询 " + intervals[dev.name] + "s";
    } else {
      piEl.textContent = "";
    }

    // kv
    const kv = node.querySelector(".kv");
    const hostVal = el("span", "mono");
    hostVal.textContent = (dev.host || "?") + (dev.ip ? " · " + dev.ip : "");
    addKV(kv, "主机", hostVal);
    const netVal = el("span");
    if (isSelf || network === "local") {
      // Local host: skip self-ping, surface "本机" instead of pretending
      // it's a real offline peer.
      const tip = dev.tailscale && dev.tailscale.raw ? dev.tailscale.raw : "本机 (tailscale 自 ping 已跳过)";
      netVal.innerHTML = chip(isSelf ? "本机" : "本地", "ok", tip);
    } else if (dev.tailscale && dev.tailscale.ok) {
      const t = dev.tailscale;
      const label = t.direct ? "直连" : t.via_derp ? "DERP" : "可达";
      netVal.innerHTML = chip(label, "ok");
    } else {
      netVal.innerHTML = chip("不可达", "bad", dev.tailscale && dev.tailscale.error || "");
    }
    addKV(kv, "网络", netVal);
    const sshVal = el("span");
    if (dev.ssh && dev.ssh.ok) {
      sshVal.innerHTML = chip(dev.ssh.skipped ? "已跳过" : "正常", dev.ssh.skipped ? "neutral" : "ok");
    } else {
      sshVal.innerHTML = chip("失败", "bad", dev.ssh && dev.ssh.error || "");
    }
    addKV(kv, "SSH", sshVal);
    const durVal = el("span", "mono");
    durVal.textContent = (dev.duration_ms || 0) + " ms";
    addKV(kv, "耗时", durVal);

    // body sections
    const d = dev.ssh && dev.ssh.data;
    // Compute a single normalized "ssh state" so EVERY block (quick-metrics,
    // resources, temps, gpu, model, services, ports, health) can render
    // consistently whether this is the local coordinator or a remote peer.
    // The same code path is used regardless of `is_self` — only the badge
    // and network chip differ for the local host.
    const sshState = {
      skipped: !!(dev.ssh && dev.ssh.skipped),
      failed: !!(dev.ssh && !dev.ssh.ok),
      error: (dev.ssh && dev.ssh.error) || ""
    };
    renderQuickMetrics(node.querySelector(".quick-metrics"), d, dev.name, sshState);
    const resources = node.querySelector(".resources");
    if (sshState.skipped) {
      resources.innerHTML = emptyState("采集已按配置关闭", false, "skipped");
    } else if (sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      resources.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), false, "failed");
    } else if (d) {
      const loadHist = hist(dev.name, "load");
      resources.innerHTML = [
        gaugeCard("磁盘 /", d.disk_root && d.disk_root.used_percent, fmtBytes(d.disk_root && d.disk_root.used) + " / " + fmtBytes(d.disk_root && d.disk_root.total), 70, 90),
        '<article class="chart-card"><b>负载趋势</b>' + spark(loadHist, "负载历史") + '<small>运行 ' + fmtUptime(d.uptime_seconds) + ' · ' + esc(d.hostname || "") + '</small></article>'
      ].join("");
    } else {
      resources.innerHTML = emptyState("暂无可采集的资源数据", false, "neutral");
    }
    renderTemps(node.querySelector(".temps"), d && d.temperatures, sshState);
    renderGpuWithName(node.querySelector(".gpu"), d && d.gpu, dev.name, sshState);
    renderModelActivity(node.querySelector(".model-activity"), d && d.model_activity, sshState);
    renderOps(node.querySelector(".services"), d && d.services, "服务", sshState);
    renderOps(node.querySelector(".ports"), d && d.ports, "端口", sshState);
    renderOps(node.querySelector(".health"), dev.health, "健康", sshState);

    // card foot
    const checkedAt = node.querySelector(".checked-at");
    if (dev.checked_at) {
      const t = new Date(dev.checked_at);
      const abs = isNaN(t.getTime()) ? dev.checked_at : fmtIsoTimeInSourceTz(dev.checked_at);
      checkedAt.textContent = "检查 " + abs + " · " + relTime(dev.checked_at);
    } else {
      checkedAt.textContent = "";
    }
    const changeEl = node.querySelector("[data-change]");
    const ch = detectChange(dev.name, dev);
    if (ch) {
      changeEl.textContent = "状态已更新";
      changeEl.classList.add("changed");
      const card = node;
      card.classList.remove("flash");
      // restart animation
      void card.offsetWidth;
      card.classList.add("flash");
    } else {
      changeEl.textContent = "";
      changeEl.classList.remove("changed");
    }
    return node;
  }

  function renderGpuWithName(elm, gpu, name, sshState) {
    if (!elm) return;
    if (sshState && sshState.skipped) {
      elm.innerHTML = emptyState("采集已按配置关闭", false, "skipped");
      return;
    }
    if (sshState && sshState.failed) {
      const err = (sshState.error || "").toString().split(/\r?\n/)[0] || "主机不可达";
      elm.innerHTML = emptyState("采集失败：" + (err.length > 80 ? err.slice(0, 80) + "…" : err), false, "failed");
      return;
    }
    if (!gpu || !gpu.available) {
      // SSH ran cleanly but the device simply has no NVIDIA GPU. This is a
      // normal absence (e.g. coordinator/recorder) and must NOT be styled
      // as an error — only the `unavailable` tone communicates "正常没有".
      const reason = gpu && gpu.error ? ("未检测到 nvidia-smi：" + (gpu.error || "").split(/\r?\n/)[0]) : "该设备无 GPU / 未安装 nvidia-smi";
      elm.innerHTML = emptyState(reason, false, "unavailable");
      return;
    }
    const list = gpu.gpus || [];
    if (!list.length) { elm.innerHTML = emptyState("GPU 信息为空", false, "unavailable"); return; }
    const wrap = el("div", "gpu-grid");
    list.forEach((g, i) => {
      if (!g) return;
      const gpuUtil = num(g.utilization_gpu_percent);
      const vram = num(g.memory_used_percent);
      const temp = num(g.temperature_c);
      const memUsedMib = num(g.memory_used_mib);
      // Compute-idle: 0% utilization but VRAM is still reserved by a loaded
      // model (llama.cpp / torch idling between requests).
      const computeIdle = (gpuUtil === 0 && memUsedMib != null && memUsedMib > 0);
      const utilDetail = computeIdle
        ? ("显存占用 " + memUsedMib + " MiB（计算空闲）")
        : ((g.power_w || "--") + "W · " + (temp == null ? "--" : (temp + "°C")));
      wrap.insertAdjacentHTML("beforeend",
        '<article class="gpu-card" data-compute-idle="' + (computeIdle ? 1 : 0) + '">'
        + '<div class="gpu-title"><b>' + esc(g.name || ("GPU " + i)) + '</b><small>驱动 ' + esc(g.driver || "--") + '</small></div>'
        + '<div class="visual-grid">'
        + gaugeCard("GPU", gpuUtil, utilDetail)
        + gaugeCard("VRAM", vram, (g.memory_used_mib || "--") + " / " + (g.memory_total_mib || "--") + " MiB", 78, 92)
        + '</div>'
        + spark(hist(name, "gpu"), "GPU 使用率历史")
        + '<div class="chip-row">'
        + chip("显存控制器", "neutral", pct(g.utilization_memory_percent))
        + chip("剩余 VRAM", "neutral", (g.memory_free_mib || "--") + " MiB")
        + (computeIdle ? chip("计算空闲", "neutral", "GPU 0% · 显存已加载") : "")
        + '</div></article>'
      );
    });
    elm.innerHTML = "";
    elm.appendChild(wrap);
  }

  function addKV(kv, k, vNode) {
    const kEl = el("div", "k"); kEl.textContent = k;
    const vEl = el("div", "v"); vEl.appendChild(vNode);
    kv.appendChild(kEl); kv.appendChild(vEl);
  }

  /* ---------- task board ---------- */
  // Map of owner string -> display label. The hint says "human name + machine emoji".
  // Unknown owners still render so user-defined strings are never silently dropped.
  const OWNER_DISPLAY = {
    doer: { emoji: "🛠", cn: "doer · 行动派" },
    supervisor: { emoji: "🔍", cn: "supervisor · 审查官" },
    coordinator: { emoji: "📚", cn: "coordinator · 书记官" }
  };
  const STATUS_DISPLAY = {
    dispatched:  { emoji: "📨", cn: "已派发",    tone: "neutral" },
    in_progress: { emoji: "🔧", cn: "进行中",    tone: "accent" },
    review:      { emoji: "🔎", cn: "待审查",    tone: "violet" },
    done:        { emoji: "✅", cn: "已完成",    tone: "ok" },
    archived:    { emoji: "📦", cn: "已归档",    tone: "muted" },
    failed:      { emoji: "⚠️", cn: "失败",     tone: "bad" }
  };
  const ACTIVE_STATUSES = new Set(["dispatched", "in_progress", "review"]);

  function ownerLabel(owner) {
    const s = String(owner == null ? "" : owner).trim();
    if (!s) return { emoji: "👤", cn: "未指派" };
    const known = OWNER_DISPLAY[s];
    if (known) return { emoji: known.emoji, cn: known.cn };
    return { emoji: "👤", cn: s };
  }
  function statusDisplay(s) {
    const key = String(s == null ? "" : s);
    return STATUS_DISPLAY[key] || { emoji: "❔", cn: key || "未知", tone: "neutral" };
  }
  // "today 00:00 in local time" → unix seconds.
  function todayStartTs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  function partitionTasks(tasks) {
    const tStart = todayStartTs();
    const active = [];
    const doneToday = [];
    const history = [];
    const failed = [];
    (tasks || []).forEach(t => {
      if (!t || typeof t !== "object") return;
      if (t.status === "failed") { failed.push(t); return; }
      if (ACTIVE_STATUSES.has(t.status)) { active.push(t); return; }
      if (t.status === "done") {
        if ((t.last_ts || 0) >= tStart) doneToday.push(t);
        else history.push(t);
        return;
      }
      // archived / unknown / anything else: history bucket.
      history.push(t);
    });
    // active: keep backend-provided desc order (newest first).
    // doneToday / history: also newest first.
    return { active, doneToday, history, failed };
  }
  function buildTaskCard(t) {
    if (!taskTpl || !taskTpl.content || !taskTpl.content.firstElementChild) return null;
    const node = taskTpl.content.firstElementChild.cloneNode(true);
    const st = statusDisplay(t.status);
    node.setAttribute("data-status", t.status || "");
    const idEl = node.querySelector(".task-id");
    if (idEl) idEl.textContent = t.id || "--";
    const statusEl = node.querySelector(".task-status");
    if (statusEl) {
      statusEl.setAttribute("data-tone", st.tone);
      statusEl.textContent = st.emoji + " " + st.cn;
    }
    const titleEl = node.querySelector(".task-title");
    if (titleEl) titleEl.textContent = t.title || "(无标题)";
    const ownerEl = node.querySelector(".task-owner");
    if (ownerEl) {
      const o = ownerLabel(t.owner);
      ownerEl.textContent = o.emoji + " " + o.cn;
    }
    const timeEl = node.querySelector(".task-time");
    if (timeEl) {
      const ts = Number(t.last_ts) || 0;
      timeEl.textContent = ts > 0 ? relTime(ts * 1000) : "--";
    }
    const noteEl = node.querySelector(".task-note");
    if (noteEl) {
      if (t.note) {
        noteEl.textContent = t.note;
        noteEl.hidden = false;
      } else {
        noteEl.textContent = "";
        noteEl.hidden = true;
      }
    }
    return node;
  }
  function renderColumn(container, countEl, items, emptyText) {
    if (!container) return;
    container.innerHTML = "";
    if (!items || !items.length) {
      const ph = document.createElement("div");
      ph.className = "task-col-empty";
      ph.textContent = emptyText || "暂无";
      container.appendChild(ph);
    } else {
      items.forEach(t => {
        const card = buildTaskCard(t);
        if (card) container.appendChild(card);
      });
    }
    if (countEl) countEl.textContent = String(items ? items.length : 0);
  }
  function renderFailedBanner(failed) {
    // Surface failed tasks at the top of the board, above the columns, only when
    // present. We create/reuse a single banner element to avoid duplicating
    // notifications.
    let banner = $("#task-failed-banner");
    if (!failed || !failed.length) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "task-failed-banner";
      banner.className = "task-failed-banner";
      const board = $("#task-board");
      if (board) board.insertBefore(banner, board.querySelector(".task-board-grid"));
    }
    banner.innerHTML = '<span class="task-failed-eyebrow">⚠️ 失败任务</span>'
      + '<div class="task-failed-list"></div>';
    const list = banner.querySelector(".task-failed-list");
    failed.forEach(t => {
      const card = buildTaskCard(t);
      if (card) list.appendChild(card);
    });
  }
  function renderTaskBoard(tasks) {
    lastTasks = Array.isArray(tasks) ? tasks : [];
    const buckets = partitionTasks(lastTasks);
    renderColumn(taskColActive, taskCountActive, buckets.active, taskColActive && taskColActive.getAttribute("data-empty-text"));
    renderColumn(taskColDoneToday, taskCountDoneToday, buckets.doneToday, taskColDoneToday && taskColDoneToday.getAttribute("data-empty-text"));
    renderColumn(taskColHistory, taskCountHistory, buckets.history, taskColHistory && taskColHistory.getAttribute("data-empty-text"));
    renderFailedBanner(buckets.failed);
    if (taskBoardTime) {
      taskBoardTime.textContent = taskLastSuccessAt
        ? ("更新 " + relTime(taskLastSuccessAt))
        : "加载中…";
    }
    if (taskHistoryCol) {
      taskHistoryCol.classList.toggle("collapsed", !historyExpanded);
      if (taskHistoryToggle) taskHistoryToggle.setAttribute("aria-expanded", historyExpanded ? "true" : "false");
      if (taskColHistory) {
        if (historyExpanded) taskColHistory.removeAttribute("hidden");
        else taskColHistory.setAttribute("hidden", "");
      }
    }
  }
  function scheduleNextTaskRefresh(ms) {
    if (taskRefreshTimer != null) {
      clearTimeout(taskRefreshTimer);
      taskRefreshTimer = null;
    }
    taskRefreshTimer = setTimeout(() => {
      taskRefreshTimer = null;
      refreshTasks(false);
    }, ms);
  }
  async function refreshTasks(force) {
    if (taskRefreshTimer != null) {
      clearTimeout(taskRefreshTimer);
      taskRefreshTimer = null;
    }
    if (taskInFlight) {
      if (force) scheduleNextTaskRefresh(50);
      return;
    }
    taskInFlight = true;
    if (taskRefreshBtn) taskRefreshBtn.classList.add("refreshing");
    try {
      const resp = await fetch("/api/tasks", { cache: "no-store", headers: { "X-Requested-With": "noc" } });
      if (resp.status === 401) {
        // Auth required but not provided — keep the existing data and surface a hint.
        if (taskBoardTime) taskBoardTime.textContent = "需要登录（请输入凭证）";
        scheduleNextTaskRefresh(TASK_REFRESH_MS);
        return;
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (!data || !Array.isArray(data.tasks)) throw new Error("响应格式异常");
      taskLastSuccessAt = Date.now();
      renderTaskBoard(data.tasks);
    } catch (e) {
      if (taskBoardTime) taskBoardTime.textContent = "刷新失败 · " + (e && e.message ? e.message : e);
    } finally {
      taskInFlight = false;
      if (taskRefreshBtn) taskRefreshBtn.classList.remove("refreshing");
      scheduleNextTaskRefresh(TASK_REFRESH_MS);
    }
  }
  function bindTaskBoard() {
    if (taskRefreshBtn) {
      taskRefreshBtn.addEventListener("click", () => refreshTasks(true));
    }
    if (taskHistoryToggle) {
      const toggle = () => {
        historyExpanded = !historyExpanded;
        if (taskHistoryCol) {
          taskHistoryCol.classList.toggle("collapsed", !historyExpanded);
          taskHistoryToggle.setAttribute("aria-expanded", historyExpanded ? "true" : "false");
        }
        if (taskColHistory) {
          if (historyExpanded) taskColHistory.removeAttribute("hidden");
          else taskColHistory.setAttribute("hidden", "");
        }
      };
      taskHistoryToggle.addEventListener("click", toggle);
      taskHistoryToggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }
  }

  /* ---------- filter / list rendering ---------- */
  function matchesFilter(dev) {
    if (activeFilter === "all") return true;
    return deviceTone(dev) === activeFilter;
  }
  function matchesText(dev) {
    if (!activeText) return true;
    const t = activeText.toLowerCase();
    return [dev.name, dev.host, dev.ip, dev.notes].some(v => v && String(v).toLowerCase().indexOf(t) >= 0);
  }

  function renderList(data) {
    if (!data || !Array.isArray(data.devices)) return;
    const devs = data.devices.filter(Boolean);
    const visible = devs.filter(d => matchesFilter(d) && matchesText(d));
    // Reuse existing card DOM by name to avoid full repaint
    const existing = new Map();
    $$(".device-card", devicesEl).forEach(c => { if (c.dataset && c.dataset.name) existing.set(c.dataset.name, c); });
    const seen = new Set();
    // Clear skeleton placeholders on first real render
    if (firstLoad) {
      $$(".skeleton", devicesEl).forEach(s => s.remove());
    }
    // Build new ordering
    visible.forEach(dev => {
      const name = dev.name || "?";
      seen.add(name);
      let card = existing.get(name);
      const fresh = renderCard(dev);
      if (card && fresh) {
        // Patch in place: copy children from fresh to existing card to keep animation continuity
        card.setAttribute("data-state", fresh.getAttribute("data-state"));
        card.classList.toggle("flash", fresh.classList.contains("flash"));
        // Replace innerHTML
        card.innerHTML = fresh.innerHTML;
      } else if (fresh) {
        devicesEl.appendChild(fresh);
      }
    });
    // Remove cards no longer visible (filtered out or removed from config)
    existing.forEach((node, name) => {
      if (!seen.has(name)) node.remove();
    });
  }

  /* ---------- global errors / banner / toast ---------- */
  function setBanner(text, tone) {
    if (!text) { bannerEl.hidden = true; bannerEl.textContent = ""; return; }
    bannerEl.hidden = false;
    bannerEl.className = "banner " + (tone || "");
    bannerEl.textContent = text;
  }
  function showToast(text) {
    toastEl.hidden = false;
    toastEl.innerHTML = '<span>' + esc(text) + '</span><button type="button" id="toast-retry">立即重试</button><button type="button" id="toast-dismiss">×</button>';
    $("#toast-retry", toastEl).addEventListener("click", () => { toastEl.hidden = true; refresh(true); });
    $("#toast-dismiss", toastEl).addEventListener("click", () => { toastEl.hidden = true; });
    setTimeout(() => { if (!toastEl.hidden) toastEl.hidden = true; }, 8000);
  }

  /* ---------- refresh loop ---------- */
  // Single source of truth for the next refresh tick. Always clears the
  // previously scheduled timer before queueing a new one, so manual clicks
  // cannot stack on top of an existing scheduled refresh.
  function scheduleNext(ms) {
    if (refreshTimer != null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh(false);
    }, ms);
  }
  async function refresh(force) {
    // Always drop any pending scheduled refresh first; otherwise a manual
    // click that lands near a scheduled tick can fire a second request.
    if (refreshTimer != null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (inFlight) {
      // Already a request in flight. Remember the intent so we re-run
      // immediately after it finishes, but do NOT start a second fetch.
      if (force) pendingForce = true;
      // Still reschedule so the timer chain keeps progressing.
      scheduleNext(refreshIntervalMs);
      return;
    }
    inFlight = true;
    metaEl.classList.add("refreshing");
    try {
      const resp = await fetch("/api/status", { cache: "no-store", headers: { "X-Requested-With": "noc" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (!data || typeof data !== "object") throw new Error("响应格式异常");
      lastData = data;
      lastSuccessAt = Date.now();
      retryAttempt = 0;
      const pi = num(data.poll_interval_seconds);
      if (pi && pi > 0) refreshIntervalMs = Math.max(3000, Math.min(120000, Math.floor(pi * 1000 * 0.7)));

      // Update header (iter2: relative time + 采集滞后 lag tag when age > pi×2)
      const upd = data.updated_at || Date.now();
      const piSecHdr = num(data.poll_interval_seconds) || 60;
      const ageSec = (Date.now() - (typeof upd === "number" ? upd : new Date(upd).getTime())) / 1000;
      const lagged = Number.isFinite(ageSec) && ageSec > piSecHdr * 2;
      metaText.textContent = "最后采集 " + relTime(upd) + (lagged ? " · 采集滞后" : "");
      metaEl.classList.toggle("lagging", !!lagged);
      metaEl.title = "数据时间：" + (data.updated_at ? fmtIsoInSourceTz(data.updated_at) : "--") + "（点击立即刷新）";
      setBanner("");
      toastEl.hidden = true;
      footErr.textContent = (data.errors && data.errors.length) ? ("巡检告警：" + data.errors.length + " 条") : "无错误";
      footErr.classList.toggle("muted", !(data.errors && data.errors.length));

      // Render KPIs then device list
      renderKpis(data);
      renderList(data);

      if (firstLoad) {
        firstLoad = false;
        // Remove any leftover skeletons
        $$(".skeleton", devicesEl).forEach(s => s.remove());
      }
    } catch (e) {
      retryAttempt++;
      metaText.textContent = "刷新失败 #" + retryAttempt;
      const isFatal = retryAttempt >= 3;
      setBanner("与监控后端连接中断：" + (e && e.message ? e.message : e), isFatal ? "bad" : "warn");
      footErr.textContent = "API 请求失败";
      footErr.classList.remove("muted");
      if (isFatal) showToast("无法连接监控后端 /api/status（已重试 " + retryAttempt + " 次）");
      // Exponential backoff for next try. scheduleNext handles clearing
      // any prior timer, so we don't manually clearTimeout here.
      const backoff = Math.min(60000, 2000 * Math.pow(2, Math.min(retryAttempt - 1, 5)));
      metaEl.classList.remove("refreshing");
      inFlight = false;
      scheduleNext(backoff);
      return;
    }
    metaEl.classList.remove("refreshing");
    inFlight = false;
    // Schedule next refresh via the single scheduler. (The catch branch
    // already schedules a backoff retry and returns, so we only get here on
    // success — no risk of overwriting a backoff timer.)
    scheduleNext(refreshIntervalMs);
    // If a force refresh was requested while we were busy, honor it now
    // (only one extra round to avoid run-away loops).
    if (pendingForce) {
      pendingForce = false;
      scheduleNext(50);
    }
  }

  /* ---------- filter UI ---------- */
  function bindFilters() {
    segBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        segBtns.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
        btn.classList.add("active"); btn.setAttribute("aria-selected", "true");
        activeFilter = btn.getAttribute("data-filter") || "all";
        if (lastData) renderList(lastData);
      });
    });
    const onText = debounce(() => {
      activeText = (filterInput.value || "").trim();
      if (lastData) renderList(lastData);
    }, 150);
    filterInput.addEventListener("input", onText);
  }

  /* ---------- relative-time ticker ---------- */
  function startTicker() {
    setInterval(() => {
      if (!lastData) return;
      // iter2: relative time + 采集滞后 lag tag when age > pi×2
      const upd = lastData.updated_at || Date.now();
      const piSec = num(lastData.poll_interval_seconds) || 60;
      const ageSec = (Date.now() - (typeof upd === "number" ? upd : new Date(upd).getTime())) / 1000;
      const lagged = Number.isFinite(ageSec) && ageSec > piSec * 2;
      metaText.textContent = "最后采集 " + relTime(upd) + (lagged ? " · 采集滞后" : "");
      metaEl.classList.toggle("lagging", !!lagged);
      $$(".device-card[data-name] .checked-at", devicesEl).forEach((el) => {
        const card = el.closest(".device-card");
        if (!card) return;
        const dev = (lastData.devices || []).find(d => d && d.name === card.dataset.name);
        if (dev && dev.checked_at) {
          const t = new Date(dev.checked_at);
          const abs = isNaN(t.getTime()) ? dev.checked_at : fmtIsoTimeInSourceTz(dev.checked_at);
          el.textContent = "检查 " + abs + " · " + relTime(dev.checked_at);
        }
      });
    }, 5000);
  }

  /* ---------- init ---------- */
  function init() {
    bindFilters();
    bindTaskBoard();
    metaEl.addEventListener("click", () => refresh(true));
    metaEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); refresh(true); }
    });
    startTicker();
    refresh();
    refreshTasks(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
