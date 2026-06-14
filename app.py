#!/usr/bin/env python3
"""Lightweight Tailscale device monitor for Raspberry Pi 3B+.

Standard-library only. It periodically checks configured tailnet machines via:
- local `tailscale ping`
- read-only SSH commands
- HTTP health endpoints
- llama.cpp service log summaries for recent model activity
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import http.server
import json
import mimetypes
import os
import pathlib
import shlex
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any, Dict, List

BASE_DIR = pathlib.Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATE_LOCK = threading.Lock()
STATE: Dict[str, Any] = {"ok": False, "started_at": None, "updated_at": None, "poll_interval_seconds": None, "devices": [], "errors": []}
CONFIG: Dict[str, Any] = {}

REMOTE_PROBE = r'''
import glob, json, os, re, shutil, subprocess, sys, time
services = json.loads(os.environ.get('MONITOR_SERVICES_JSON') or (sys.argv[1] if len(sys.argv) > 1 else '[]'))
ports = json.loads(os.environ.get('MONITOR_PORTS_JSON') or (sys.argv[2] if len(sys.argv) > 2 else '[]'))
model_services = json.loads(os.environ.get('MONITOR_MODEL_SERVICES_JSON') or '[]')

def run(cmd, timeout=4):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return {"ok": p.returncode == 0, "code": p.returncode, "stdout": p.stdout.strip(), "stderr": p.stderr.strip()}
    except Exception as e:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(e)}

def read(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ""

def read_first(paths):
    for path in paths:
        s = read(path).strip()
        if s:
            return path, s
    return None, ""

def cpu_times():
    vals = list(map(int, read('/proc/stat').splitlines()[0].split()[1:]))
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return idle, sum(vals)

def cpu_percent():
    try:
        i1, t1 = cpu_times(); time.sleep(0.2); i2, t2 = cpu_times()
        return round((1 - (i2 - i1) / max(1, t2 - t1)) * 100, 1)
    except Exception:
        return None

def meminfo():
    data = {}
    for line in read('/proc/meminfo').splitlines():
        parts = line.replace(':','').split()
        if len(parts) >= 2:
            data[parts[0]] = int(parts[1]) * 1024
    total = data.get('MemTotal'); avail = data.get('MemAvailable')
    used = total - avail if total is not None and avail is not None else None
    return {"total": total, "available": avail, "used": used, "used_percent": round(used / total * 100, 1) if total and used is not None else None}

def disk(path='/'):
    try:
        u = shutil.disk_usage(path)
        return {"path": path, "total": u.total, "used": u.used, "free": u.free, "used_percent": round(u.used / u.total * 100, 1)}
    except Exception as e:
        return {"path": path, "error": str(e)}

def parse_temp(raw):
    try:
        v = float(str(raw).strip())
        if abs(v) > 1000:
            v = v / 1000.0
        return round(v, 1)
    except Exception:
        return None

def thermal_sensors():
    items = []
    seen = set()
    for temp_path in sorted(glob.glob('/sys/class/thermal/thermal_zone*/temp')):
        label_path = temp_path.rsplit('/', 1)[0] + '/type'
        label = read(label_path).strip() or temp_path
        temp = parse_temp(read(temp_path))
        if temp is not None:
            key = (label, temp_path)
            if key not in seen:
                items.append({"label": label, "temp_c": temp, "source": temp_path})
                seen.add(key)
    for temp_path in sorted(glob.glob('/sys/class/hwmon/hwmon*/temp*_input')):
        base = temp_path.rsplit('_', 1)[0]
        label = read(base + '_label').strip()
        if not label:
            name = read('/'.join(temp_path.split('/')[:-1]) + '/name').strip()
            label = name or temp_path
        temp = parse_temp(read(temp_path))
        if temp is not None and -20 <= temp <= 130:
            key = (label, temp_path)
            if key not in seen:
                items.append({"label": label, "temp_c": temp, "source": temp_path})
                seen.add(key)
    # Keep output compact but useful.
    return items[:16]

def gpu():
    q = run(['sh','-lc','command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=index,name,driver_version,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu,power.draw --format=csv,noheader,nounits'], timeout=5)
    if not q['ok'] or not q['stdout']:
        return {"available": False, "error": q['stderr'] or q['stdout'] or 'nvidia-smi not available'}
    gpus = []
    for line in q['stdout'].splitlines():
        cols = [c.strip() for c in line.split(',')]
        if len(cols) >= 10:
            total = float(cols[5]) if cols[5].replace('.','',1).isdigit() else None
            used = float(cols[6]) if cols[6].replace('.','',1).isdigit() else None
            mem_used_percent = round(used / total * 100, 1) if total and used is not None else None
            gpus.append({
                "index": cols[0], "name": cols[1], "driver": cols[2],
                "utilization_gpu_percent": cols[3], "utilization_memory_percent": cols[4],
                "memory_total_mib": cols[5], "memory_used_mib": cols[6], "memory_free_mib": cols[7],
                "memory_used_percent": mem_used_percent,
                "temperature_c": cols[8], "power_w": cols[9]
            })
        else:
            gpus.append({"raw": line})
    return {"available": True, "gpus": gpus}

def service_status(name):
    active = run(['systemctl','--user','is-active',name], timeout=3)
    enabled = run(['systemctl','--user','is-enabled',name], timeout=3)
    sub = run(['systemctl','--user','show',name,'-p','SubState','--value'], timeout=3)
    return {"name": name, "active": active['stdout'] or 'unknown', "enabled": enabled['stdout'] or 'unknown', "sub_state": sub['stdout'] or ''}

def listening_ports(port_list):
    ss = run(['ss','-ltnp'], timeout=4)
    out = ss['stdout']
    return [{"port": p, "listening": any((':'+str(p)) in ln for ln in out.splitlines())} for p in port_list]

def collect_llama_lines(service, log_files):
    sources = []
    j = run(['journalctl','--user','-u',service,'--since','24 hours ago','-n','500','--no-pager','-o','short-iso'], timeout=6)
    if j['stdout']:
        sources.append({'source': 'journal', 'text': j['stdout']})
    for path in log_files or []:
        path = os.path.expanduser(path)
        r = run(['tail','-n','500',path], timeout=4)
        if r['stdout']:
            sources.append({'source': path, 'text': r['stdout']})
    return sources

def extract_ts(line):
    # journalctl -o short-iso starts with ISO timestamp; llama append logs often start with relative uptime.
    m = re.match(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*)', line)
    if m:
        return m.group(1)
    m = re.match(r'([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)', line)
    if m:
        return 'uptime+' + m.group(1)
    return ''

def parse_llama_activity(service, label, log_files=None):
    # llama-server logs task lifecycle and timing lines. Summarize newest task found.
    sources = collect_llama_lines(service, log_files or [])
    if not sources:
        return {"label": label, "service": service, "ok": True, "last_call": None, "note": "no llama-server log source found"}
    tasks = {}
    latest_task = None
    latest_ts = None
    latest_source = None
    for src in sources:
        for line in src['text'].splitlines():
            ts = extract_ts(line)
            m = re.search(r'task\s+(\d+)', line)
            if not m:
                continue
            task = m.group(1)
            d = tasks.setdefault(task, {"task_id": task, "service": service, "label": label, "last_seen": ts, "lines": 0, "source": src['source']})
            d['last_seen'] = ts or d.get('last_seen')
            d['source'] = src['source']
            d['lines'] += 1
            if 'processing task' in line:
                d['started_at'] = ts
            m2 = re.search(r'prompt eval time =\s*([0-9.]+) ms /\s*(\d+) tokens .*?([0-9.]+) tokens per second', line)
            if m2:
                d['prompt_eval_ms'] = float(m2.group(1)); d['prompt_tokens'] = int(m2.group(2)); d['prompt_tokens_per_second'] = float(m2.group(3))
            m2 = re.search(r'\beval time =\s*([0-9.]+) ms /\s*(\d+) tokens .*?([0-9.]+) tokens per second', line)
            if m2 and 'prompt eval time' not in line:
                d['eval_ms'] = float(m2.group(1)); d['eval_tokens'] = int(m2.group(2)); d['eval_tokens_per_second'] = float(m2.group(3))
            m2 = re.search(r'total time =\s*([0-9.]+) ms /\s*(\d+) tokens', line)
            if m2:
                d['total_ms'] = float(m2.group(1)); d['total_tokens'] = int(m2.group(2))
            m2 = re.search(r'stop processing: n_tokens =\s*(\d+), truncated =\s*(\d+)', line)
            if m2:
                d['n_tokens'] = int(m2.group(1)); d['truncated'] = bool(int(m2.group(2))); d['completed_at'] = ts
            latest_task = task
            latest_ts = ts
            latest_source = src['source']
    if not latest_task:
        return {"label": label, "service": service, "ok": True, "last_call": None, "note": "no llama-server task in configured logs"}
    last = tasks[latest_task]
    last['ok'] = True
    last['last_seen'] = latest_ts or last.get('last_seen')
    last['source'] = latest_source or last.get('source')
    return {"label": label, "service": service, "ok": True, "last_call": last}

def model_activity():
    out = []
    for item in model_services:
        service = item.get('service')
        if not service:
            continue
        parser = item.get('parser', 'llama-server')
        label = item.get('label') or service
        if parser == 'llama-server':
            out.append(parse_llama_activity(service, label, item.get('log_files', [])))
        else:
            out.append({"label": label, "service": service, "ok": False, "error": "unsupported parser: " + parser})
    return out

uptime_raw = read('/proc/uptime').split()
print(json.dumps({
    "hostname": run(['hostname'], timeout=2)['stdout'],
    "time": time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    "uptime_seconds": float(uptime_raw[0]) if uptime_raw else None,
    "loadavg": read('/proc/loadavg').split()[:3],
    "cpu_percent": cpu_percent(),
    "memory": meminfo(),
    "disk_root": disk('/'),
    "temperatures": thermal_sensors(),
    "gpu": gpu(),
    "services": [service_status(s) for s in services],
    "ports": listening_ports(ports),
    "model_activity": model_activity(),
}, ensure_ascii=False))
'''


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def run_cmd(cmd: List[str], timeout: int) -> Dict[str, Any]:
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return {"ok": p.returncode == 0, "code": p.returncode, "stdout": p.stdout.strip(), "stderr": p.stderr.strip()}
    except Exception as e:
        return {"ok": False, "code": None, "stdout": "", "stderr": str(e)}


def tailscale_ping(device: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    target = device.get("host") or device.get("ip") or device["name"]
    r = run_cmd(["tailscale", "ping", "--timeout=3s", "--c", "1", target], timeout=max(timeout, 5))
    text = (r["stdout"] + "\n" + r["stderr"]).strip()
    # `tailscale ping` may return non-zero when it gets a DERP pong but no direct path.
    # For monitoring reachability, a pong is enough; directness is shown separately.
    return {"ok": "pong" in text, "raw": text[:1000], "via_derp": "DERP" in text, "direct": "direct connection" in text and "not established" not in text}


def ssh_probe(device: Dict[str, Any], monitor: Dict[str, Any]) -> Dict[str, Any]:
    if device.get("ssh_enabled") is False or monitor.get("ssh_enabled") is False:
        return {"ok": True, "skipped": True, "reason": "ssh disabled by config"}
    key = os.path.expanduser(monitor.get("ssh_key_path", "~/.ssh/id_ed25519"))
    user = device.get("ssh_user") or monitor.get("ssh_user") or os.environ.get("USER", "pi")
    host = device.get("host") or device.get("ip") or device["name"]
    timeout = int(monitor.get("ssh_command_timeout", 12))
    connect_timeout = str(int(monitor.get("ssh_connect_timeout", 5)))
    cmd = ["ssh"]
    if key:
        cmd += ["-i", key]
    cmd += ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={connect_timeout}"]
    cmd += monitor.get("ssh_extra_options", [])
    services_json = json.dumps(device.get("expected_services", []))
    ports_json = json.dumps(device.get("ports", []))
    model_services_json = json.dumps(device.get("model_services", []))
    encoded_probe = base64.b64encode(REMOTE_PROBE.encode("utf-8")).decode("ascii")
    loader = "import base64; exec(base64.b64decode(%r).decode('utf-8'))" % encoded_probe
    remote = (
        "MONITOR_SERVICES_JSON=" + shlex.quote(services_json) + " " +
        "MONITOR_PORTS_JSON=" + shlex.quote(ports_json) + " " +
        "MONITOR_MODEL_SERVICES_JSON=" + shlex.quote(model_services_json) + " " +
        "python3 -c " + shlex.quote(loader)
    )
    cmd += [f"{user}@{host}", remote]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        if p.returncode != 0:
            return {"ok": False, "error": p.stderr.strip() or p.stdout.strip(), "code": p.returncode}
        return {"ok": True, "data": json.loads(p.stdout)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def http_health(url: str, timeout: int) -> Dict[str, Any]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "raspi-tailnet-monitor/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(512).decode("utf-8", "replace")
            return {"url": url, "ok": 200 <= resp.status < 300, "status": resp.status, "body": body}
    except Exception as e:
        return {"url": url, "ok": False, "error": str(e)}


def check_device(device: Dict[str, Any], monitor: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    result: Dict[str, Any] = {"name": device.get("name"), "host": device.get("host"), "ip": device.get("ip"), "notes": device.get("notes", ""), "monitored_only": bool(device.get("monitored_only")), "checked_at": now_iso()}
    result["tailscale"] = tailscale_ping(device, int(monitor.get("ssh_connect_timeout", 5)) + 3)
    result["ssh"] = ssh_probe(device, monitor)
    result["health"] = [http_health(url, int(monitor.get("http_timeout", 5))) for url in device.get("health_urls", [])]
    result["duration_ms"] = int((time.time() - started) * 1000)
    ok_parts = [result["tailscale"].get("ok"), result["ssh"].get("ok")]
    if result["health"]:
        ok_parts.append(all(h.get("ok") for h in result["health"]))
    result["ok"] = all(ok_parts)
    return result


def poll_once() -> Dict[str, Any]:
    monitor = CONFIG.get("monitor", {})
    devices = CONFIG.get("devices", [])
    results: List[Dict[str, Any]] = []
    errors: List[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(1, len(devices)))) as pool:
        futs = [pool.submit(check_device, d, monitor) for d in devices]
        for fut in concurrent.futures.as_completed(futs):
            try:
                results.append(fut.result())
            except Exception as e:
                errors.append(str(e))
    order = {d.get("name"): i for i, d in enumerate(devices)}
    results.sort(key=lambda x: order.get(x.get("name"), 999))
    return {"ok": not errors, "updated_at": now_iso(), "poll_interval_seconds": monitor.get("poll_interval_seconds"), "devices": results, "errors": errors}


def poll_loop() -> None:
    interval = int(CONFIG.get("monitor", {}).get("poll_interval_seconds", 30))
    while True:
        snapshot = poll_once()
        with STATE_LOCK:
            STATE.update(snapshot)
        time.sleep(interval)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (now_iso(), fmt % args))

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/status":
            with STATE_LOCK:
                data = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        file_path = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(file_path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ThreadingHTTPServer(__import__('socketserver').ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    global CONFIG
    with open(args.config, "r", encoding="utf-8") as f:
        CONFIG = json.load(f)
    STATE["started_at"] = now_iso()
    STATE["poll_interval_seconds"] = CONFIG.get("monitor", {}).get("poll_interval_seconds")
    if args.once:
        print(json.dumps(poll_once(), ensure_ascii=False, indent=2))
        return 0
    with STATE_LOCK:
        STATE.update(poll_once())
    threading.Thread(target=poll_loop, daemon=True).start()
    mon = CONFIG.get("monitor", {})
    host = mon.get("listen_host", "0.0.0.0")
    port = int(mon.get("listen_port", 8080))
    print(f"raspi-tailnet-monitor listening on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
