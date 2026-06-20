# raspi-tailnet-monitor

轻量级 Tailscale 设备监控页面，目标运行环境：Raspberry Pi 3B+。

## 特点

- Python 3 标准库实现，无 Flask/FastAPI 依赖。
- 只读监控：`tailscale ping`、SSH 只读采集、HTTP health check。
- Web 页面自动轮询 `/api/status`。
- 配置驱动，可监控 doer / supervisor / coordinator / recorder。
- 不保存、不打印密钥；仅使用本机已有 SSH key。


## Dashboard visualization

The UI is dependency-free and renders quantifiable metrics as lightweight browser-side visuals:

- top-bar NOC chips (在线 / 告警 / 离线) and a 6-card KPI strip (fleet health, DERP, GPUs, model activity, avg CPU/mem);
- per-device CPU / memory / GPU / VRAM ring gauges, load sparkline, and history-based flash on state change;
- temperature thermometers, GPU utilization/VRAM gauges, and model-throughput bars;
- service / port / HTTP health chips with explicit `--` placeholders when missing;
- skeleton placeholders on first load; global retry with exponential backoff on API failure.

No CDN, npm package, or Python backend dependency is required. The browser keeps a small in-memory history for sparklines; `/api/status` remains the same JSON endpoint (now also exposes `poll_interval_min/max_seconds` and `poll_intervals` for transparency).

## 采集内容

每台设备：

- Tailscale 可达性，是否经 DERP。
- SSH 可达性。
- uptime、load、CPU 粗略占用、内存、根分区磁盘。
- `nvidia-smi` GPU 信息（存在则采集，不存在则跳过）。
- `systemctl --user` 服务状态。
- 配置中的 HTTP health URL。
- 配置中的监听端口状态。

## 默认设备

- `doer`：OpenClaw gateway、Qwen chat、heartbeat、Tesla P4。
- `supervisor`：OpenClaw gateway/node、Qwen3 embedding、heartbeat、Tesla P4。
- `coordinator`：OpenClaw gateway/node、heartbeat。
- `recorder`：仅监控基础状态，不期望 OpenClaw/模型/心跳服务。

## 树莓派准备

树莓派需要：

1. 已加入同一个 Tailscale tailnet。
2. 能通过 MagicDNS 访问 `doer`、`supervisor`、`coordinator`、`recorder`。
3. 有一把能 SSH 到这些机器的私钥。
4. Python 3、ssh、tailscale 命令可用。

```bash
python3 --version
ssh -V
tailscale status
```

## 本地运行

```bash
cp config.example.json config.json
nano config.json   # 修改 ssh_key_path，例如 /home/pi/.ssh/hakase_managed_ubuntu
python3 app.py --config config.json
```

打开：

```text
http://<raspberry-pi-ip>:8080/
```

一次性 JSON 巡检：

```bash
python3 app.py --config config.json --once
```

## 安装为 systemd 服务

```bash
sudo APP_DIR=/opt/raspi-tailnet-monitor CONF_DIR=/etc/raspi-tailnet-monitor ./scripts/install.sh
sudo nano /etc/raspi-tailnet-monitor/config.json
sudo systemctl start raspi-tailnet-monitor
sudo systemctl status raspi-tailnet-monitor
```

## SSH key 建议

建议在树莓派上放只读监控用 key，例如：

```text
/home/pi/.ssh/hakase_managed_ubuntu
```

`config.json` 中设置：

```json
"ssh_key_path": "/home/pi/.ssh/hakase_managed_ubuntu"
```

本程序不会使用 sudo，也不会写远端机器。

## 安全注意

- 页面默认监听 `0.0.0.0:8080`，建议只在 Tailscale 网络内访问。
- 如果树莓派暴露到局域网外，请加反向代理认证或改为 `127.0.0.1`。
- SSH key 请设置合适权限：`chmod 600 ~/.ssh/hakase_managed_ubuntu`。
- 远程命令均为只读：读取 `/proc`、`systemctl --user`、`ss`、`nvidia-smi`。
- systemd unit 使用 `ProtectHome=read-only` 并仅通过 `BindReadOnlyPaths` 放行
  `~/.ssh` 目录，避免服务越权访问家目录。

## 资源占用

默认每 60 秒巡检一次，最多并发 4 台 SSH；适合 Raspberry Pi 3B+。如果负载高或被控机较慢，可调大：

```json
"poll_interval_seconds": 120,
"monitor_only_interval_seconds": 600
```

`monitor_only: true` 的设备（例如 `recorder`）默认走更长的轮询周期（`max(poll_interval_seconds, monitor_only_interval_seconds)`），可大幅降低对被控设备的负载。每台设备也可单独设置 `poll_interval_seconds` 覆盖全局值。SSH 通过 `ControlMaster=auto` + `ControlPersist` 复用连接，避免每次巡检都重新握手。


## HTTP Basic Auth（可选）

监控面板支持可选的 HTTP Basic Auth，保护所有路由（`/`、`/index.html`、`/api/status`、`/static/*`）。

启用方式（二选一，环境变量优先级更高）：

1. **config.json**：在顶层加入 `auth` 字段：

   ```json
   {
     "auth": { "username": "hasake", "password": "你的密码" },
     "monitor": { ... },
     "devices": [ ... ]
   }
   ```

2. **环境变量**：设置 `MONITOR_AUTH_USER` 和 `MONITOR_AUTH_PASS`。环境变量会覆盖 config.json 里的 `auth`。

   ```bash
   MONITOR_AUTH_USER=hasake MONITOR_AUTH_PASS=你的密码 python3 app.py --config config.json
   ```

**向后兼容**：如果既没有 `config.auth` 也没有设置环境变量（或用户名/密码为空），认证保持关闭，服务完全开放，不影响现有无认证部署。启动日志会打印 `HTTP Basic Auth: ENABLED/DISABLED`（不会打印密码明文）。

**实现细节**：纯标准库（`base64` + `hmac`），用 `hmac.compare_digest` 做常数时间比较防时序攻击；认证失败返回 `401` 并带 `WWW-Authenticate: Basic realm="raspi-tailnet-monitor"` 头。

测试：

```bash
curl -i http://127.0.0.1:8080/            # 401
curl -i -u hasake:你的密码 http://127.0.0.1:8080/   # 200
```

> 注意：`config.json` 已加入 `.gitignore`，请不要把真实凭证提交到仓库。
