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

## 访问鉴权（HTTP Basic Auth）

所有路由（`/`、`/index.html`、`/style.css`、`/app.js`、`/api/status`、`/api/tasks`）默认支持 HTTP Basic Auth。凭证按以下顺序读取，**先到先得**：

1. 环境变量 `MONITOR_AUTH_USER` / `MONITOR_AUTH_PASS`（推荐用于部署/容器，优先级最高）。
2. `config.json` 里的 `auth.username` / `auth.password`（适合开发与小团队，提交前请把 `config.json` 加入 `.gitignore`）。
3. 若以上都没配置，启动时打印 `[AUTH DISABLED]` 且**不**强制鉴权（保持向后兼容）。

示例（`config.json`）：

```json
{
  "auth": {
    "username": "hakase",
    "password": "hakase0620"
  }
}
```

示例（环境变量）：

```bash
export MONITOR_AUTH_USER=hakase
export MONITOR_AUTH_PASS='hakase0620'
python3 app.py --config config.json
```

校验逻辑使用 `hmac.compare_digest` 做常量时间比较；校验失败返回 `401` 并携带 `WWW-Authenticate: Basic realm="raspi-tailnet-monitor"` 头。浏览器在第一次访问时会弹出系统级登录框，凭证会被记住并在后续请求中自动带上。

## 团队任务看板 / `/api/tasks` API

监控面板顶部集成了一块"团队任务看板"，用于在小队群里跟踪任务流转。后端把任务持久化到本地 JSON 文件 `state/tasks.json`（启动时自动创建目录）。所有写操作都走"写临时文件 + `os.replace`"的原子化路径，线程锁保护，并发安全。

### 任务数据结构

```json
{
  "tasks": [
    {
      "id": "T-20260620-001",
      "title": "接入团队任务看板",
      "owner": "doer",
      "status": "in_progress",
      "note": "等 supervisor 验收",
      "first_ts": 1750391760,
      "last_ts": 1750391900,
      "history": [
        {"status": "dispatched",  "ts": 1750391760, "note": ""},
        {"status": "in_progress",  "ts": 1750391800, "note": "开始落地"}
      ]
    }
  ]
}
```

字段约束：

- `id` 非空字符串，作为主键用于 upsert。
- `status` 必须是 `dispatched` / `in_progress` / `done` / `review` / `archived` / `failed` 之一。
- `owner` 建议三选一：`doer` / `supervisor` / `coordinator`，也允许自定义字符串。
- `title` 新任务必填；后续更新可省略以保留原值。
- `ts` Unix 秒；缺省取服务器当前时间。
- `first_ts` 仅在插入时打戳；`last_ts` 每次更新都会被刷新。
- `history` 每次 POST 追加一条 `{status, ts, note}`。

### `GET /api/tasks`

返回 `{ "tasks": [...] }`，默认按 `last_ts` 降序。可选查询参数：

- `?status=in_progress,done` — 多状态过滤（英文逗号分隔）。
- `?limit=20` — 限制返回条数。

### `POST /api/tasks`

写入一条任务，body 为 JSON，**需要 Basic Auth**。新增时 `id` / `status` / `owner` / `title` 必填；更新已有任务时 `owner` / `title` 可省略。返回 200 + 更新后的完整任务 JSON；非法输入返回 400。

curl 示例：

```bash
curl -u hakase:hakase0620 -X POST http://localhost:8080/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"id":"T-20260620-001","status":"in_progress","owner":"doer","title":"测试","note":"hello","ts":1750391760}'
```

把这条任务推到 review 状态：

```bash
curl -u hakase:hakase0620 -X POST http://localhost:8080/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"id":"T-20260620-001","status":"review","note":"等 supervisor 验收"}'
```

## 资源占用

默认每 60 秒巡检一次，最多并发 4 台 SSH；适合 Raspberry Pi 3B+。如果负载高或被控机较慢，可调大：

```json
"poll_interval_seconds": 120,
"monitor_only_interval_seconds": 600
```

`monitor_only: true` 的设备（例如 `recorder`）默认走更长的轮询周期（`max(poll_interval_seconds, monitor_only_interval_seconds)`），可大幅降低对被控设备的负载。每台设备也可单独设置 `poll_interval_seconds` 覆盖全局值。SSH 通过 `ControlMaster=auto` + `ControlPersist` 复用连接，避免每次巡检都重新握手。
