# 念头池 MCP（让 TA 自己记惦记的事）

地址：`https://你的Zeabur域名/mcp`，鉴权用同一个 `TOKEN`（Bearer）。

工具：
- `remember_thought`（text 必填，weight 5–25）：记下一件惦记的事，返回 id。同样的话再记一次只会刷新。
- `resolve_thought`（id）：划掉。
- `list_thoughts`：看现在记着的。

规则：
- TA 自己最多同时记 8 条（`MAX_AI_ITEMS`），每条权重上限 25，防止它记太多把自己点爆。
- 72 小时（`ITEM_TTL_H`）没被提起自动淡掉。
- 每次触发（守望放行）后，TA 自己记的念头权重减半，淡到很轻就不再算；你手动 `POST /item` 加的不受影响。
- 念头内容会在触发时被带进"为什么找他"的提示里。

在 Sully 里接：MCP 设置→添加服务器，URL 填上面的地址，Token 填 `TOKEN`，发现工具后启用。
