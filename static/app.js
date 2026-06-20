/* Hakase Tailnet NOC - dashboard controller */
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
  let firstLoad = true;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
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
  function emptyState(text, compact) {
    return '<div class="empty-state' + (compact ? ' compact' : '') + '">' + esc(text) + '</div>';
  }
  function miniGauge(label, value, detail, warn, bad, abbr) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    return '<article class="mini-gauge ' + tone + '" style="--p:' + p + '" data-na="' + (v == null ? 1 : 0) + '" title="' + esc(label) + ' ' + pct(value) + '">'
      + '<div class="dial" aria-label="' + esc(label) + ' ' + pct(value) + '"><span>' + pct(value) + '</span></div>'
      + '<div class="dial-text"><b>' + esc(abbr || label) + '</b><small>' + esc(detail || "") + '</small></div>'
      + '</article>';
  }
  function gaugeCard(label, value, detail, warn, bad) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    return '<article class="gauge-card ' + tone + '" style="--p:' + p + '" data-na="' + (v == null ? 1 : 0) + '">'
      + '<div class="gauge"><span>' + pct(value) + '</span></div>'
      + '<div class="gauge-text"><b>' + esc(label) + '</b><small>' + esc(detail || "") + '</small></div>'
      + '</article>';
  }
  function bar(label, value, detail, warn, bad) {
    const v = num(value);
    const p = v == null ? 0 : Math.max(0, Math.min(100, v));
    const tone = v == null ? "neutral" : toneFor(v, warn || 70, bad || 88);
    return '<div class="bar-row ' + tone + '" data-na="' + (v == null ? 1 : 0) + '">'
      + '<div class="bar-top"><span>' + esc(label) + '</span><b>' + pct(value) + '</b></div>'
      + '<div class="bar"><i style="width:' + p + '%"></i></div>'
      + (detail ? '<small>' + esc(detail) + '</small>' : '')
      + '</div>';
  }
  function thermometer(label, c, detail) {
    c = num(c);
    const p = c == null ? 0 : Math.max(0, Math.min(100, (c / 90) * 100));
    const tone = c == null ? "neutral" : (c >= 82 ? "bad" : c >= 65 ? "warn" : "ok");
    return '<article class="thermo ' + tone + '" style="--temp:' + p + '" title="' + esc(label) + ' ' + (c == null ? "--" : c + "°C") + '">'
      + '<div class="tube"><i></i></div>'
      + '<div><b>' + esc(label) + '</b><strong>' + (c == null ? '--' : (c.toFixed(c % 1 ? 1 : 0) + "°C")) + '</strong>'
      + (detail ? '<small>' + esc(detail) + '</small>' : '')
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
      if (tone === "ok") ok++; else if (tone === "warn") warn++; else bad++;
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
      { label: "告警/离线", value: (warn + bad) + "", foot: warn + " 关注 · " + bad + " 离线", tone: (warn + bad) ? (bad ? "bad" : "warn") : "ok" },
      { label: "Tailscale", value: direct + " 直连", foot: derp + " 经 DERP", tone: derp ? "warn" : "ok" },
      { label: "GPU 在线", value: gpuCount + "", foot: gpuCount ? "已识别" : "暂无", tone: gpuCount ? "ok" : "neutral" },
      { label: "模型活动", value: modelsActive + "", foot: modelsActive ? "有最近任务" : "暂无活动", tone: modelsActive ? "ok" : "neutral" },
      { label: "平均 CPU", value: avgCpu == null ? "--" : avgCpu.toFixed(0) + "%", foot: avgMem == null ? "" : ("平均内存 " + avgMem.toFixed(0) + "%"), tone: avgCpu == null ? "neutral" : toneFor(avgCpu, 60, 80) }
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

  function renderOps(container, items, kind) {
    if (!container) return;
    if (!items || !items.length) {
      container.innerHTML = emptyState("暂无" + kind, true);
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

  function renderTemps(elm, temps) {
    if (!elm) return;
    if (!temps || !temps.length) {
      elm.innerHTML = emptyState("暂无温度传感器");
      return;
    }
    elm.innerHTML = temps.slice(0, 8).map(t => t ? thermometer(t.label || "传感器", num(t.temp_c), t.source || "") : "").join("");
  }

  function renderQuickMetrics(elm, d, name) {
    if (!elm) return;
    if (!d) {
      elm.innerHTML = emptyState("暂无资源数据（SSH 未连通）", true);
      return;
    }
    const g = (d.gpu && d.gpu.gpus && d.gpu.gpus[0]) || {};
    const loadVal = (d.loadavg || [])[0];
    elm.innerHTML = [
      miniGauge("CPU", d.cpu_percent, "负载 " + (loadVal == null ? "--" : loadVal), 70, 88, "CPU"),
      miniGauge("内存", d.memory && d.memory.used_percent, fmtBytes(d.memory && d.memory.used) + " / " + fmtBytes(d.memory && d.memory.total), 70, 88, "内存"),
      miniGauge("GPU", g.utilization_gpu_percent, d.gpu && d.gpu.available ? (g.name || "GPU") : (d.gpu && d.gpu.error ? "未检测" : "未检测"), 70, 88, "GPU"),
      miniGauge("VRAM", g.memory_used_percent, d.gpu && d.gpu.available ? (g.memory_used_mib + " / " + g.memory_total_mib + " MiB") : "未检测", 78, 92, "VRAM")
    ].join("");
  }

  function renderModelActivity(elm, items) {
    if (!elm) return;
    if (!items || !items.length) { elm.innerHTML = emptyState("暂无配置模型服务"); return; }
    elm.innerHTML = "";
    items.forEach(item => {
      if (!item) return;
      const last = item.last_call;
      const box = el("article", "activity-card");
      if (!last) {
        box.innerHTML = '<div class="activity-title"><b>' + esc(item.label || item.service || "模型") + '</b><span>' + esc(item.service || "") + '</span></div>'
          + emptyState(item.note || item.error || "暂无最近调用", true);
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
    if (!dev.ok) {
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
    if (dev.tailscale && dev.tailscale.ok) {
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
    renderQuickMetrics(node.querySelector(".quick-metrics"), d, dev.name);
    const resources = node.querySelector(".resources");
    if (d) {
      const loadHist = hist(dev.name, "load");
      resources.innerHTML = [
        gaugeCard("磁盘 /", d.disk_root && d.disk_root.used_percent, fmtBytes(d.disk_root && d.disk_root.used) + " / " + fmtBytes(d.disk_root && d.disk_root.total), 70, 90),
        '<article class="chart-card"><b>负载趋势</b>' + spark(loadHist, "负载历史") + '<small>运行 ' + fmtUptime(d.uptime_seconds) + ' · ' + esc(d.hostname || "") + '</small></article>'
      ].join("");
    } else {
      resources.innerHTML = emptyState("暂无 SSH 资源数据");
    }
    renderTemps(node.querySelector(".temps"), d && d.temperatures);
    renderGpuWithName(node.querySelector(".gpu"), d && d.gpu, dev.name);
    renderModelActivity(node.querySelector(".model-activity"), d && d.model_activity);
    renderOps(node.querySelector(".services"), d && d.services, "服务");
    renderOps(node.querySelector(".ports"), d && d.ports, "端口");
    renderOps(node.querySelector(".health"), dev.health, "健康");

    // card foot
    const checkedAt = node.querySelector(".checked-at");
    if (dev.checked_at) {
      const t = new Date(dev.checked_at);
      checkedAt.textContent = "检查 " + (isNaN(t.getTime()) ? dev.checked_at : t.toLocaleTimeString("zh-CN")) + " · " + relTime(dev.checked_at);
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

  function renderGpuWithName(elm, gpu, name) {
    if (!elm) return;
    if (!gpu || !gpu.available) {
      elm.innerHTML = emptyState(gpu && gpu.error ? ("无 GPU: " + gpu.error) : "该设备无 GPU / 未检测到 nvidia-smi");
      return;
    }
    const list = gpu.gpus || [];
    if (!list.length) { elm.innerHTML = emptyState("GPU 信息为空"); return; }
    const wrap = el("div", "gpu-grid");
    list.forEach((g, i) => {
      if (!g) return;
      const gpuUtil = num(g.utilization_gpu_percent);
      const vram = num(g.memory_used_percent);
      const temp = num(g.temperature_c);
      wrap.insertAdjacentHTML("beforeend",
        '<article class="gpu-card">'
        + '<div class="gpu-title"><b>' + esc(g.name || ("GPU " + i)) + '</b><small>驱动 ' + esc(g.driver || "--") + '</small></div>'
        + '<div class="visual-grid">'
        + gaugeCard("GPU", gpuUtil, (g.power_w || "--") + "W · " + (temp == null ? "--" : (temp + "°C")))
        + gaugeCard("VRAM", vram, (g.memory_used_mib || "--") + " / " + (g.memory_total_mib || "--") + " MiB", 78, 92)
        + '</div>'
        + spark(hist(name, "gpu"), "GPU 使用率历史")
        + '<div class="chip-row">'
        + chip("显存控制器", "neutral", pct(g.utilization_memory_percent))
        + chip("剩余 VRAM", "neutral", (g.memory_free_mib || "--") + " MiB")
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
  async function refresh(force) {
    if (inFlight && !force) return;
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

      // Update header
      metaText.textContent = "更新 " + relTime(data.updated_at || Date.now());
      const absolute = data.updated_at ? new Date(data.updated_at) : new Date();
      metaEl.title = "数据时间：" + (isNaN(absolute.getTime()) ? "--" : absolute.toLocaleString("zh-CN")) + "（点击立即刷新）";
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
      metaEl.classList.remove("refreshing");
      const isFatal = retryAttempt >= 3;
      setBanner("与监控后端连接中断：" + (e && e.message ? e.message : e), isFatal ? "bad" : "warn");
      footErr.textContent = "API 请求失败";
      footErr.classList.remove("muted");
      if (isFatal) showToast("无法连接监控后端 /api/status（已重试 " + retryAttempt + " 次）");
      // exponential backoff for next try
      const backoff = Math.min(60000, 2000 * Math.pow(2, Math.min(retryAttempt - 1, 5)));
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, backoff);
      inFlight = false;
      return;
    } finally {
      metaEl.classList.remove("refreshing");
      inFlight = false;
    }
    // Schedule next refresh
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, refreshIntervalMs);
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
      metaText.textContent = "更新 " + relTime(lastData.updated_at || Date.now());
      $$(".device-card[data-name] .checked-at", devicesEl).forEach((el) => {
        const card = el.closest(".device-card");
        if (!card) return;
        const dev = (lastData.devices || []).find(d => d && d.name === card.dataset.name);
        if (dev && dev.checked_at) {
          const t = new Date(dev.checked_at);
          el.textContent = "检查 " + (isNaN(t.getTime()) ? dev.checked_at : t.toLocaleTimeString("zh-CN")) + " · " + relTime(dev.checked_at);
        }
      });
    }, 5000);
  }

  /* ---------- init ---------- */
  function init() {
    bindFilters();
    metaEl.addEventListener("click", () => refresh(true));
    metaEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); refresh(true); }
    });
    startTicker();
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
