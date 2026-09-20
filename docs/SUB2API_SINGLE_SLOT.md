# Sub2API × vm2api：单账号、单槽位、受控并发部署

## 1. 目标与边界

本方案把多个 Sub2API 下游用户汇聚到一个经过授权的 vm2api 执行端：

```text
下游用户 A ┐
下游用户 B ├─ Sub2API ─ Single-Slot Gateway ─ vm2api Slot-01 ─ 上游账号 X
下游用户 C ┘
```

稳定项：

- 一个上游账号；
- 一个持久化 slot；
- 一个持久化 HOME 与登录态；
- 一个固定代理出口，或明确允许的固定本地出口；
- 同时最多 `N` 个请求；
- 超出的请求进入有界队列；
- 各请求保留独立会话标识，Codex 任务仍应使用独立 workspace。

本方案不模拟真人操作、不伪造硬件指纹、不随机制造“人类节奏”，也不承诺上游会将真实多人并发判断为一个真人。

## 2. 为什么增加独立侧车

vm2api 已有 `x-kin-vm`，但它是主密钥诊断钉槽，不适合作为生产路由。生产链不应依赖会放宽正常门禁的诊断能力。

Single-Slot Gateway 的做法是：

1. vm2api 实例中只允许一个 slot 调度；
2. 侧车以只读方式检查 `active.json`、VM JSON、代理绑定和并发值；
3. 每次推理前重新检查，发现第二个可调度 slot 或配置漂移立即返回 `503 single_slot_preflight_failed`；
4. 侧车只持有 `sk-vm-*` 协议密钥，不能访问管理面板；
5. 不向 vm2api 发送 `x-kin-vm`、`x-kin-backend`、Cookie 或下游转发 IP 头。

因此，账号额度、代理同步、凭证状态和 vm2api 自身调度门禁仍正常生效。

## 3. 准备 vm2api

以 `vm-01`、并发 `2` 为例：

1. 只保留 `vm-01` 为 `schedulable=true`；其他 VM 全部关闭调度。
2. `vms/active.json` 的 `active_vm` 必须是 `vm-01`。
3. `vm-01.json` 中设置：

```json
{
  "id": "vm-01",
  "schedulable": true,
  "policy": {
    "maxConcurrency": 2
  }
}
```

4. 固定挂载 `vms/vm-01/cli-home`，重启后不得重新生成 HOME 或登录态。
5. 绑定长期稳定的 SOCKS5；代理故障时保持 fail-closed。确实使用固定 VPS 本地出口时，部署侧车设置 `ALLOW_LOCAL_EGRESS=1`。
6. 在 vm2api 面板签发一个只允许 `/v1/*` 的 `sk-vm-*` 密钥；不要使用 `VM2API_API_KEY` 主密钥。
7. 确认 `GET /health`、目标模型和真实流式请求均正常。

## 4. 启动 Single-Slot Gateway

准备两个独立秘密文件：

```text
deploy/secrets/single-slot-inbound-key.txt   # Sub2API → 侧车
deploy/secrets/vm2api-managed-key.txt        # 侧车 → vm2api，内容为 sk-vm-*
```

设置部署变量：

```bash
export VM2API_PROJECT_ROOT=/opt/vm2api
export SINGLE_SLOT_VM_ID=vm-01
export MAX_CONCURRENCY=2
export MAX_WAITERS=32
export QUEUE_TIMEOUT_MS=120000
export SUB2API_DOCKER_NETWORK=sub2api-deploy_default
```

启动前确认 `SUB2API_DOCKER_NETWORK` 是 Sub2API 后端实际加入的内部 Docker 网络。侧车不映射公网端口，只加入该内部网络，并通过 `host.docker.internal` 访问 host-network 模式的 vm2api。

启动：

```bash
docker compose -f deploy/docker-compose.single-slot.yml up -d --build
docker compose -f deploy/docker-compose.single-slot.yml ps
docker exec vm2api-single-slot-gateway wget -qO- http://127.0.0.1:8790/ready
```

`/ready` 必须同时满足：

- 预检通过；
- 只有 `vm-01` 可调度；
- VM 并发等于 `MAX_CONCURRENCY`；
- 固定代理存在，除非明确允许固定本地出口；
- vm2api `/health` 可达。

## 5. 在 Sub2API 中建立唯一上游

Sub2API 已支持 `upstream` 类型，即通过 Base URL + API Key 连接另一个网关。

### Claude / Anthropic Messages

```text
平台：Anthropic
账号类型：Upstream
Base URL：http://vm2api-single-slot-gateway:8790
API Key：single-slot-inbound-key.txt 的内容
API 协议：anthropic
账号并发：2
```

### Codex / OpenAI Responses

```text
平台：OpenAI
账号类型：Upstream
Base URL：http://vm2api-single-slot-gateway:8790
API Key：single-slot-inbound-key.txt 的内容
API 协议：responses
账号并发：2
```

Sub2API 的账号并发与 `MAX_CONCURRENCY`、`vm-01.policy.maxConcurrency` 必须保持一致：

```text
有效并发 = min(Sub2API账号并发, 侧车并发, vm2api槽并发, 上游实际限制)
```

不要同时在 Sub2API 中导入相同的真实上游凭证；真实凭证只保存在 vm2api slot。

## 6. 会话与 workspace

推荐由 Sub2API 或调用客户端提供不可逆、无个人信息的会话标识：

```text
x-session-id = HMAC(内部密钥, user_id + conversation_id)
```

侧车会保留以下任一头：

- `x-session-id`
- `x-conversation-id`
- `x-claude-code-session-id`

未提供时，侧车为本次请求生成随机 `ssg-UUID`，防止不同请求意外复用同一会话。不要传邮箱、用户名、真实 API Key 或明文用户 ID。

Codex 会话可以共用账号 HOME，但执行代码的任务目录必须按请求隔离，例如：

```text
/workspaces/<request-id>/
```

## 7. 队列与故障语义

| 条件 | 行为 |
|---|---|
| 活动请求 `< N` | 立即执行 |
| 活动请求 `= N` | FIFO 排队 |
| 等待数达到 `MAX_WAITERS` | `429 queue_full` |
| 等待超过 `QUEUE_TIMEOUT_MS` | `429 queue_timeout` |
| 客户端断开 | 从队列删除；已执行请求被中止 |
| 第二个 VM 被开启调度 | `503 single_slot_preflight_failed` |
| 活动 VM/并发/代理配置漂移 | `503`，fail-closed |
| vm2api 不可达 | `502 upstream_transport_error` |
| 上游 401/403/429 | 原状态与响应由 vm2api 返回，不更换账号或 IP |

## 8. 验收清单

部署前必须完成：

1. `npm test`：侧车单元与代理测试全通过。
2. `/ready` 返回 200，且 `schedulable_vms` 只有目标 VM。
3. 两个并发请求可同时流式返回；第 `N+1` 个进入队列。
4. 临时启用第二个 VM 后，新请求必须返回 503；关闭后恢复。
5. 删除/停用代理后，新请求必须失败而不是改用其他出口。
6. 通过抓取 vm2api 日志确认侧车使用专用 `sk-vm-*`，没有传递 `x-kin-vm`。
7. 重启全部服务后，slot ID、HOME、登录态、代理绑定和并发值不变。
8. Sub2API 用户、余额、Key、计费仍只存在于 Sub2API 层。

## 9. 审查结论

这套部署实现的是“多用户入口 → 单一稳定执行端”，不是“把多人真实并发变成真人单线程行为”。上游仍可观察总请求量、并发数、上下文数量和持续运行时间。需要更高吞吐时，应增加被授权的上游容量或使用允许多用户/团队使用的正式方案，而不是通过身份或节奏伪装扩大单账号容量。
