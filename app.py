#!/usr/bin/env python3
"""Lightweight Tailscale device monitor for Raspberry Pi 3B+.

Standard-library only. It periodically checks configured tailnet machines via:
- local `tailscale ping`
- read-only SSH commands
- HTTP health endpoints
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
import json, os, shutil, subprocess, sys, time
services = json.loads(os.environ.get('MONITOR_SERVICES_JSON') or (sys.argv[1] if len(sys.argv) > 1 else '[]'))
ports = json.loads(os.environ.get('MONITOR_PORTS_JSON') or (sys.argv[2] if len(sys.argv) > 2 else '[]'))

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

def gpu():
    q = run(['sh','-lc','command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,temperature.gpu,power.draw --format=csv,noheader,nounits'], timeout=5)
    if not q['ok'] or not q['stdout']:
        return {"available": False, "error": q['stderr'] or q['stdout'] or 'nvidia-smi not available'}
    gpus = []
    for line in q['stdout'].splitlines():
        cols = [c.strip() for c in line.split(',')]
        if len(cols) >= 6:
            gpus.append({"name": cols[0], "driver": cols[1], "memory_total_mib": cols[2], "memory_used_mib": cols[3], "temperature_c": cols[4], "power_w": cols[5]})
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

uptime_raw = read('/proc/uptime').split()
print(json.dumps({
    "hostname": run(['hostname'], timeout=2)['stdout'],
    "time": time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    "uptime_seconds": float(uptime_raw[0]) if uptime_raw else None,
    "loadavg": read('/proc/loadavg').split()[:3],
    "cpu_percent": cpu_percent(),
    "memory": meminfo(),
    "disk_root": disk('/'),
    "gpu": gpu(),
    "services": [service_status(s) for s in services],
    "ports": listening_ports(ports),
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
    encoded_probe = base64.b64encode(REMOTE_PROBE.encode("utf-8")).decode("ascii")
    loader = "import base64; exec(base64.b64decode(%r).decode('utf-8'))" % encoded_probe
    remote = (
        "MONITOR_SERVICES_JSON=" + shlex.quote(services_json) + " " +
        "MONITOR_PORTS_JSON=" + shlex.quote(ports_json) + " " +
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
