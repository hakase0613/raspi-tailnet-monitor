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
import logging
import mimetypes
import os
import pathlib
import shlex
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

BASE_DIR = pathlib.Path(__file__).resolve().parent
STATIC_DIR = (BASE_DIR / "static").resolve()
STATE_LOCK = threading.Lock()
STATE: Dict[str, Any] = {"ok": False, "started_at": None, "updated_at": None, "poll_interval_seconds": None, "devices": [], "errors": []}
CONFIG: Dict[str, Any] = {}

logger = logging.getLogger("raspi-tailnet-monitor")

REMOTE_PROBE = r'''
import glob, json, os, re, shutil, subprocess, sys, time
# Configuration payloads are passed by the local monitor as JSON literal
# strings in sys.argv[1..3]. SSH does not forward custom env vars by default,
# so we do not rely on MONITOR_*_JSON here.
def _arg(i, default='[]'):
    return sys.argv[i] if len(sys.argv) > i and sys.argv[i] else default
def _load(i):
    try:
        return json.loads(_arg(i, '[]'))
    except Exception:
        return []
services = _load(1)
ports = _load(2)
model_services = _load(3)

def run(cmd, timeout=4):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
        return {"ok": p.returncode == 0, "code": p.returncode, "stdout": (p.stdout or "").strip(), "stderr": (p.stderr or "").strip()}
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
    if not isinstance(name, str) or not name:
        return {"name": str(name), "active": "invalid", "enabled": "invalid", "sub_state": ""}
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
    paths = log_files if isinstance(log_files, (list, tuple)) else []
    for path in paths:
        if not isinstance(path, str) or not path:
            continue
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
    for item in model_services or []:
        if not isinstance(item, dict):
            continue
        service = item.get('service')
        if not service or not isinstance(service, str):
            continue
        parser = item.get('parser', 'llama-server')
        label = item.get('label') or service
        if parser == 'llama-server':
            out.append(parse_llama_activity(service, label, item.get('log_files', [])))
        else:
            out.append({"label": label, "service": service, "ok": False, "error": "unsupported parser: " + str(parser)})
    return out

# Coerce unexpected top-level types to empty lists (defensive).
if not isinstance(services, list): services = []
if not isinstance(ports, list): ports = []
if not isinstance(model_services, list): model_services = []

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
    "services": [service_status(s) for s in services if isinstance(s, str) and s],
    "ports": listening_ports([p for p in ports if isinstance(p, (int, str))]),
    "model_activity": model_activity(),
}, ensure_ascii=False))
'''


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def run_cmd(cmd: List[str], timeout: int) -> Dict[str, Any]:
    """Run a subprocess and normalize the result. Never raises."""
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        return {
            "ok": p.returncode == 0,
            "code": p.returncode,
            "stdout": (p.stdout or "").strip(),
            "stderr": (p.stderr or "").strip(),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as e:
        return {
            "ok": False,
            "code": None,
            "stdout": (e.stdout or b"").decode("utf-8", "replace").strip() if isinstance(e.stdout, (bytes, bytearray)) else (e.stdout or "").strip(),
            "stderr": (e.stderr or b"").decode("utf-8", "replace").strip() if isinstance(e.stderr, (bytes, bytearray)) else (e.stderr or str(e)),
            "timed_out": True,
        }
    except FileNotFoundError as e:
        return {"ok": False, "code": None, "stdout": "", "stderr": f"command not found: {e.filename or cmd[0]}", "timed_out": False}
    except Exception as e:  # pragma: no cover - defensive
        return {"ok": False, "code": None, "stdout": "", "stderr": str(e), "timed_out": False}


def tailscale_ping(device: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    name = device.get("name")
    target = device.get("host") or device.get("ip") or name
    if not target:
        return {"ok": False, "raw": "no target host configured", "via_derp": False, "direct": False, "error": "missing host"}
    r = run_cmd(["tailscale", "ping", "--timeout=3s", "--c", "1", str(target)], timeout=max(timeout, 5))
    text = ((r.get("stdout") or "") + "\n" + (r.get("stderr") or "")).strip()
    # `tailscale ping` may return non-zero when it gets a DERP pong but no direct path.
    # For monitoring reachability, a pong is enough; directness is shown separately.
    result: Dict[str, Any] = {
        "ok": "pong" in text,
        "raw": text[:1000],
        "via_derp": "DERP" in text,
        "direct": ("direct connection" in text) and ("not established" not in text),
    }
    if not text:
        result["ok"] = False
        result["error"] = "tailscale produced no output"
    if r.get("timed_out"):
        result["timed_out"] = True
    return result


def ssh_probe(device: Dict[str, Any], monitor: Dict[str, Any]) -> Dict[str, Any]:
    if device.get("ssh_enabled") is False or monitor.get("ssh_enabled") is False:
        return {"ok": True, "skipped": True, "reason": "ssh disabled by config"}
    name = device.get("name")
    host = device.get("host") or device.get("ip") or name
    if not host:
        return {"ok": False, "error": "no host/ip/name configured for ssh"}
    key = os.path.expanduser(monitor.get("ssh_key_path", "~/.ssh/id_ed25519"))
    user = device.get("ssh_user") or monitor.get("ssh_user") or os.environ.get("USER", "pi")
    timeout = max(1, int(monitor.get("ssh_command_timeout", 12)))
    connect_timeout = str(max(1, int(monitor.get("ssh_connect_timeout", 5))))
    cmd = ["ssh"]
    if key:
        cmd += ["-i", key]
    cmd += ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={connect_timeout}"]
    for opt in monitor.get("ssh_extra_options", []) or []:
        if isinstance(opt, str):
            cmd += ["-o", opt]
    services_json = json.dumps(device.get("expected_services", []))
    ports_json = json.dumps(device.get("ports", []))
    model_services_json = json.dumps(device.get("model_services", []))
    # SSH does not forward arbitrary env vars by default. Pass the JSON payloads
    # as positional argv to the embedded Python loader instead of relying on
    # MONITOR_*_JSON env vars (which would otherwise be empty on the remote).
    encoded_probe = base64.b64encode(REMOTE_PROBE.encode("utf-8")).decode("ascii")
    # Build `python3 -c '<loader>' <probe_b64> <services> <ports> <models>`.
    # `python3 -c` does not put the script body into sys.argv; the trailing
    # args start at sys.argv[1]. The loader decodes+execs the probe, then
    # trims sys.argv down to the JSON payloads so the probe's
    # sys.argv[1..3] hold services, ports, models.
    loader = (
        "import base64,sys\n"
        "_probe=base64.b64decode(sys.argv[1]).decode('utf-8')\n"
        "_args=sys.argv[2:5]\n"
        "sys.argv[:]=['-']+_args\n"
        "exec(_probe)\n"
    )
    remote = "python3 -c " + shlex.quote(loader) + " " + shlex.quote(encoded_probe) + " " + shlex.quote(services_json) + " " + shlex.quote(ports_json) + " " + shlex.quote(model_services_json)
    cmd += [f"{user}@{host}", remote]
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        if p.returncode != 0:
            err = (p.stderr or p.stdout or "").strip() or f"ssh exited with code {p.returncode}"
            return {"ok": False, "error": err[:2000], "code": p.returncode}
        out = (p.stdout or "").strip()
        if not out:
            return {"ok": False, "error": "ssh returned empty output"}
        try:
            return {"ok": True, "data": json.loads(out)}
        except json.JSONDecodeError as e:
            # The remote probe occasionally prints a warning before JSON. Try
            # to recover by picking the last JSON-looking line.
            tail = out[out.rfind("{"):]
            try:
                return {"ok": True, "data": json.loads(tail)}
            except json.JSONDecodeError:
                return {"ok": False, "error": f"invalid JSON from remote probe: {e}", "raw": out[-500:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"ssh timed out after {timeout}s", "timed_out": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def http_health(url: str, timeout: int) -> Dict[str, Any]:
    if not isinstance(url, str) or not url:
        return {"url": str(url), "ok": False, "error": "empty url"}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "raspi-tailnet-monitor/0.1"})
        with urllib.request.urlopen(req, timeout=max(1, timeout)) as resp:
            try:
                body_bytes = resp.read(512)
            except Exception:
                body_bytes = b""
            try:
                body = body_bytes.decode("utf-8")
            except UnicodeDecodeError:
                body = body_bytes.decode("utf-8", "replace")
            return {
                "url": url,
                "ok": 200 <= resp.status < 300,
                "status": resp.status,
                "body": body,
            }
    except urllib.error.HTTPError as e:
        return {"url": url, "ok": False, "status": e.code, "error": f"HTTP {e.code}"}
    except urllib.error.URLError as e:
        return {"url": url, "ok": False, "error": f"url error: {e.reason}"}
    except Exception as e:
        return {"url": url, "ok": False, "error": str(e)}


def check_device(device: Dict[str, Any], monitor: Dict[str, Any]) -> Dict[str, Any]:
    started = time.time()
    result: Dict[str, Any] = {
        "name": device.get("name"),
        "host": device.get("host"),
        "ip": device.get("ip"),
        "notes": device.get("notes", "") or "",
        "monitored_only": bool(device.get("monitored_only")),
        "checked_at": now_iso(),
    }
    try:
        result["tailscale"] = tailscale_ping(device, int(monitor.get("ssh_connect_timeout", 5)) + 3)
    except Exception as e:
        result["tailscale"] = {"ok": False, "error": str(e), "raw": "", "via_derp": False, "direct": False}
    try:
        result["ssh"] = ssh_probe(device, monitor)
    except Exception as e:
        result["ssh"] = {"ok": False, "error": str(e)}
    try:
        health_urls = [u for u in (device.get("health_urls") or []) if isinstance(u, str) and u]
        result["health"] = [http_health(u, int(monitor.get("http_timeout", 5))) for u in health_urls]
    except Exception as e:
        result["health"] = []
        result["health_error"] = str(e)
    result["duration_ms"] = int((time.time() - started) * 1000)
    ok_parts = [bool(result["tailscale"].get("ok")), bool(result["ssh"].get("ok"))]
    if result.get("health"):
        ok_parts.append(all(h.get("ok") for h in result["health"]))
    result["ok"] = all(ok_parts)
    return result


def poll_once() -> Dict[str, Any]:
    monitor = CONFIG.get("monitor") or {}
    devices = CONFIG.get("devices") or []
    results: List[Dict[str, Any]] = []
    errors: List[str] = []
    if not devices:
        return {
            "ok": True,
            "updated_at": now_iso(),
            "poll_interval_seconds": monitor.get("poll_interval_seconds"),
            "devices": [],
            "errors": [],
        }
    workers = min(8, max(1, len(devices)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(check_device, d, monitor): d for d in devices}
        for fut in concurrent.futures.as_completed(futs):
            d = futs[fut]
            try:
                results.append(fut.result())
            except Exception as e:
                logger.exception("check_device failed for %s", d.get("name"))
                errors.append(f"{d.get('name') or '?'}: {e}")
    order = {d.get("name"): i for i, d in enumerate(devices)}
    results.sort(key=lambda x: order.get(x.get("name"), 10**9))
    return {
        "ok": not errors,
        "updated_at": now_iso(),
        "poll_interval_seconds": monitor.get("poll_interval_seconds"),
        "devices": results,
        "errors": errors,
    }


def poll_loop() -> None:
    interval = max(2, int(CONFIG.get("monitor", {}).get("poll_interval_seconds", 30)))
    logger.info("poll loop started, interval=%ss", interval)
    while True:
        cycle_started = time.time()
        try:
            snapshot = poll_once()
            with STATE_LOCK:
                STATE.update(snapshot)
        except Exception:
            logger.exception("poll cycle crashed; keeping previous state")
        elapsed = time.time() - cycle_started
        sleep_for = max(0.5, interval - elapsed)
        time.sleep(sleep_for)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "raspi-tailnet-monitor/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        try:
            sys.stderr.write("[%s] %s - %s\n" % (now_iso(), self.address_string(), fmt % args))
        except Exception:
            pass

    def _send(self, status: int, body: bytes, content_type: str = "application/octet-stream", extra_headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0] or "/"
        if path == "/api/status":
            try:
                with STATE_LOCK:
                    data = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
            except (TypeError, ValueError) as e:
                self._send(500, json.dumps({"error": f"state serialization failed: {e}"}).encode("utf-8"), "application/json; charset=utf-8")
                return
            self._send(200, data, "application/json; charset=utf-8")
            return
        if path == "/":
            path = "/index.html"
        try:
            rel = urllib.parse.unquote(path.lstrip("/"))
            file_path = (STATIC_DIR / rel).resolve()
        except (OSError, ValueError):
            self.send_error(400)
            return
        try:
            file_path.relative_to(STATIC_DIR)
        except ValueError:
            self.send_error(404)
            return
        if not file_path.is_file():
            self.send_error(404)
            return
        try:
            data = file_path.read_bytes()
        except OSError as e:
            self._send(500, json.dumps({"error": f"read failed: {e}"}).encode("utf-8"), "application/json; charset=utf-8")
            return
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self._send(200, data, ctype)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def load_config(path: str) -> Dict[str, Any]:
    p = pathlib.Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"config not found: {path}")
    with p.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("config root must be a JSON object")
    cfg.setdefault("monitor", {})
    cfg.setdefault("devices", [])
    if not isinstance(cfg["devices"], list):
        raise ValueError("config.devices must be a list")
    # De-duplicate by name; the first occurrence wins.
    seen = set()
    deduped = []
    for d in cfg["devices"]:
        if not isinstance(d, dict) or not d.get("name"):
            logger.warning("skipping invalid device entry: %r", d)
            continue
        if d["name"] in seen:
            logger.warning("duplicate device name %r; skipping later occurrence", d["name"])
            continue
        seen.add(d["name"])
        deduped.append(d)
    cfg["devices"] = deduped
    return cfg


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="Raspberry Pi Tailscale monitor")
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"))
    parser.add_argument("--once", action="store_true", help="run one poll and print JSON, then exit")
    args = parser.parse_args()
    global CONFIG
    try:
        CONFIG = load_config(args.config)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
        logger.error("failed to load config %s: %s", args.config, e)
        return 2
    STATE["started_at"] = now_iso()
    STATE["poll_interval_seconds"] = CONFIG.get("monitor", {}).get("poll_interval_seconds")
    if args.once:
        print(json.dumps(poll_once(), ensure_ascii=False, indent=2))
        return 0
    try:
        first = poll_once()
        with STATE_LOCK:
            STATE.update(first)
    except Exception:
        logger.exception("initial poll failed; serving dashboard anyway")
    threading.Thread(target=poll_loop, name="poll-loop", daemon=True).start()
    mon = CONFIG.get("monitor", {})
    host = mon.get("listen_host", "0.0.0.0")
    try:
        port = int(mon.get("listen_port", 8080))
    except (TypeError, ValueError):
        logger.warning("invalid listen_port %r, falling back to 8080", mon.get("listen_port"))
        port = 8080
    print(f"raspi-tailnet-monitor listening on http://{host}:{port}", flush=True)
    try:
        ThreadingHTTPServer((host, port), Handler).serve_forever()
    except OSError as e:
        logger.error("HTTP server failed to start on %s:%s: %s", host, port, e)
        return 3
    except KeyboardInterrupt:
        logger.info("shutting down")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
