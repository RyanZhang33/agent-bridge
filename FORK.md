# FORK.md — 本 fork 与上游的差异说明

上游：[raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge)。
本 fork 在上游基础上叠加了以下本地改动，用于个人多 agent 协作环境。升级上游时按此清单重打/核对补丁。

## 改动清单

### 1. Always-queue + ACK 邮箱（commit `058069c`）
修复 Codex→前端推送在 idle 时静默丢失的问题（上游 Issue #223）：所有消息先入内存 ACK 邮箱（`get_messages` 可靠拉取，`ack_ids` 显式签收才移除），channel 推送降为实时优化。

### 2. Kimi Code 前端支持
让 Codex ↔ Kimi Code 通过 AgentBridge 协作（替代 Claude Code 前端）：
- `src/kimi-adapter.ts`：`KimiAdapter extends ClaudeAdapter`，关闭 Claude 专有的 channel 推送，纯邮箱拉取；`claude-adapter.ts` 构造函数新增 `channelPush`/`instructions` 选项（默认行为不变）
- `src/cli/kimi.ts`：`abg kimi` 启动器（默认注入 `--yolo`，单前端冲突守卫复用 claude 侧逻辑）
- `src/kimi-session.ts` + `abg resume kimi`：读 `~/.kimi-code/session_index.jsonl` 找最近会话
- `src/bridge.ts`：按 `AGENTBRIDGE_FRONTEND=kimi` 选择 adapter；**守卫**：kimi 前端无 pair env 时直接退出（用户级 mcp.json 会让普通 kimi 会话也拉起 bridge-server，不能让它抢占默认 pair）
- Kimi 侧配置在机器上（不入库）：`~/.kimi-code/mcp.json` 注册 bridge-server 为 stdio MCP server
- daemon / Codex 侧零改动（Kimi 消息继续打 `source:"claude"` 协议标签）

### 3. 前端身份动态命名
Codex 可见文案中的对端名称按实际前端动态生成：前端在 `claude_connect` 的 identity 里上报 `frontend` 字段（"claude" | "kimi"），daemon 在 attach 时解析存下，REPLY REQUIRED 包裹（"Kimi has explicitly requested a reply"）和 steer 前缀（"[STEER from Kimi]"）都使用真实名字。老前端无此字段时默认 Claude，向后兼容。（早期版本曾把文案静态泛化为 "the other agent"，已被本方案取代。）

### 4. 测试对齐
`message-delivery.test.ts` 17 个用例对齐 ACK 邮箱语义（`pendingMessages`→`messageEntries`、drain 从"取出即清"变"ack 才清"）；新增 `kimi-session.test.ts`。

### 5. Relay 模式：两个 MCP 前端直连（Kimi Code ↔ Claude Code）
`AGENTBRIDGE_RELAY=1`（经 `abg kimi|claude --relay a|b` 开启）把 Codex 槽位换成第二个 MCP 前端：`src/peer-adapter.ts` 的 PeerAdapter 提供 CodexAdapter 同接口但路由到第二控制 socket；A→B 走 injectMessage，B→A 按发送方 socket 识别后走 codex 消息路径（标记过滤/reply 追踪/注意力窗口全复用）。daemon 加分流（identity.side）、预算强制禁用、relay 文案；`DaemonStatus.peerName` 按接收方个性化，前端 `setPeerName` 渲染真实对端名。无 turn 协调（steer/interrupt 惰性化，v1 设计如此）。经典 pair 零影响（relay 默认关）。测试：`src/integration-test/relay.test.ts`。与上游 v3 rooms 功能重叠已知悉并接受（v3 未合并且面向跨机多人场景）。

### 6. Stop hook 唤醒（拉模式前端的 turn 边界接续）
MCP 前端无法被 daemon 推送唤醒（CC channel 自 v2.1.220 失效、Kimi 本无），空闲时对端消息只能躺在邮箱。解法：claude-adapter 在每次入队/取出时把邮箱状态写到 `<stateDir>/mailbox-pending-<frontend>.json`（relay 双前端共享 state dir 所以按 frontend 分文件）；Stop hook 脚本 `plugins/agentbridge/hooks/check-mailbox.cjs`（CC 经插件 hooks.json、Kimi 经 `~/.kimi-code/config.toml` 的 `[[hooks]]` 注册）在 turn 结束时检查，非空则 exit 2 阻塞 Stop 并提示模型调 get_messages + ack——两 host 对 exit 2+stderr 语义一致。防死循环：每个 latestAt 最多提醒 2 次，新消息（新 latestAt）重新武装。覆盖"turn 期间来消息"场景；纯 idle 唤醒仍靠会话 cron 轮询。
`AGENTBRIDGE_RELAY=1`（经 `abg kimi|claude --relay a|b` 开启）把 Codex 槽位换成第二个 MCP 前端：`src/peer-adapter.ts` 的 PeerAdapter 提供 CodexAdapter 同接口但路由到第二控制 socket；A→B 走 injectMessage，B→A 按发送方 socket 识别后走 codex 消息路径（标记过滤/reply 追踪/注意力窗口全复用）。daemon 加分流（identity.side）、预算强制禁用、relay 文案；`DaemonStatus.peerName` 按接收方个性化，前端 `setPeerName` 渲染真实对端名。无 turn 协调（steer/interrupt 惰性化，v1 设计如此）。经典 pair 零影响（relay 默认关）。测试：`src/integration-test/relay.test.ts`。与上游 v3 rooms 功能重叠已知悉并接受（v3 未合并且面向跨机多人场景）。

## 部署备忘

```bash
bun run build:cli && bun run build:plugin
npm install -g --force .     # abg 是 npm 全局安装，改完必须重装
bun run test:unit            # 全绿才算完
```

- Claude 侧实际运行的是插件缓存拷贝（`~/.claude/plugins/cache/.../bridge-server.js`），改动 bridge-server 时需另行同步
- 已知：`e2e-cli.test.ts` 两个 kill 用例在 macOS 本机预置失败（上游 HEAD 同样失败，与本 fork 改动无关）

## 维护原则

- 不改上游 README.md 等既有文件，避免 rebase 冲突；fork 说明集中在本文件
- 本地运维笔记（含机器路径、pair ID 等）不入库
