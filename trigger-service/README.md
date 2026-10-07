# 触发判断服务（Zeabur）

只做判断，不调模型、不发推送。推送仍走已部署的 AMSG Worker。

## 部署
1. Zeabur 新建服务 → 选这个仓库 → **Root Directory 填 `trigger-service`**，分支选 `trigger-gate`。
2. 环境变量：`TOKEN`（自己编一串长随机字符）、`TZ_NAME`（你所在的时区，例 `Asia/Tokyo`；默认 `Asia/Shanghai`）。
3. 加一个 Volume，挂载到 `/data`，再加环境变量 `DATA_DIR=/data`，否则重启会丢状态。
4. 生成域名，浏览器打开 `https://域名/` 看到 `{"ok":true}` 就通了。

## Worker 侧
Cloudflare → 你的 AMSG Worker → Settings → Variables，加两个：
- `TRIGGER_URL` = Zeabur 域名（带 https://，结尾不要斜杠）
- `TRIGGER_TOKEN` = 上面的 `TOKEN`

不配这两个，闸门就不启用，行为和以前完全一样。

## 使用
- **守望任务**：主动消息 2.0 新建任务 → 模式「自动」→ 重复「每天」→ 到点聊天选「自动作废」→ 「补充灵感」里写 `[守望]`。到点后每分钟问一次服务，90 分钟内没等到"该找他"就放弃当天。
- **早安**：不用做任何事。TA 睡前自排的任务会问 `/allow`：睡眠专注开着就推迟，最多等 3 小时。
- iOS 快捷指令（个人自动化）：睡眠专注开启 → `POST /event/sleep_on?token=…`；关闭 → `/event/sleep_off`。
- 看状态：`GET /status?token=…`。

## 接口
`POST /gate`、`POST /allow`（body 带 `lastUserMessageAt`）、`POST /event/{chat|phone|pc|sleep_on|sleep_off}`、`POST /item`、`POST /item/done`、`GET /status`。鉴权：请求头 `X-Token` 或参数 `?token=`。
