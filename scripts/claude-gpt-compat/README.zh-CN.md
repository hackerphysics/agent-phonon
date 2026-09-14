# Claude → 本地 GPT：可选流式兼容 sidecar

这是 **agent-phonon 项目边界的隔离运行工具**，不是新的协议网关实现、4000 服务补丁或生产 Phonon 默认配置迁移。Messages↔Responses、tool schema/arguments/IDs、usage 映射继续使用官方 **LiteLLM 1.100.0**。仅在这个进程中替换其 Responses→Messages adapter 类绑定；不修改任何 site-packages 文件。

## 适用范围与真实行为

- 监听固定 `127.0.0.1:24339`，单 worker；role alias `local-gpt-sol` → `openai/gpt-5.6-sol`。
- 模型请求固定 `http://127.0.0.1:4000/v1/responses`，`store:false`，零配置重试。运行时拒绝其他 upstream URL、model、store 和非指定占位认证，禁止跟随重定向。
- 本机原生 Claude 必须显式选择独立 `~/.claude/providers/phonon-local4000-gpt.json`。原 Claude settings、独立 Qwen、Hermes、OpenCode、生产 Phonon override 均不需要改变。
- 本地上游已观察到 `output_item.added/done/completed` 带完整文字但没有 `output_text.delta`。shim 在 `item.done` 之前将**这个已完成 item 的实际文本**交给官方 text-delta handler，不生成任何新文字。completed-only 的完整 message 也可通过同一路径处理。
- **这不是逐 token 实时输出修复。** 只有标准 delta 本来就存在时才实时转发；final-item-only 的文字要等完整 item 到达。工具由官方流式转换继续传输，不切成非流式上游，不提前返回工具结果。
- 按 `(item_id, content_index)` 检查已有 delta：完全相等不补；重复相同 done 不重复；部分 delta/最终文字冲突、会改变内容顺序、缺失 final、空成功、未知最终内容，均报错而非补猜测文字。
- Tool call ID/name 与 argument delta 拼接必须和 final tool item 一致；缺失/冲突参数直接报错，不自行补工具数据。标准 delta 流另有与官方 adapter 输出逐事件相等的回归（只归一化随机 message ID）。
- failed/incomplete、提前 EOF、transport error、超时不能变成 `end_turn`。错误返回 Anthropic SSE `error`，无成功 `message_stop`；incomplete 保守算失败，不宣称可续写。未知/refusal/media final 内容保守失败，当前工具不是完整多模态支持声明。
- 流开始后总 deadline 45 秒，官方 upstream timeout 40 秒。取消/下游关闭会关闭官方 iterator 持有的 httpx.Response。错误不记录完整异常字符串；可识别的 HTTP 错误状态映射到对应 Anthropic 错误类别。

## 为什么不是官方 callback 开关

本次检查 PyPI 当前最新仍为 1.100.0，也检查了官方 main 的对应源码与正式 callback 文档。没有找到该路径可直接启用的官方“非流式 upstream → 流式 Messages”缓冲设置。

- `responses.streaming_iterator._call_post_streaming_deployment_hook` 每次只能返回一个事件，异常又被忽略；无法原样保留 done 同时在前面多插一个 delta，亦不能依赖其拒绝异常。
- proxy `async_post_call_streaming_iterator_hook` 收到的是已经转换的 Anthropic SSE，原 final-item 文本已经丢失。
- `compat.py` 因此在官方 Responses adapter 的最窄调用点，用进程内子类补事件、强化 EOF/error/cleanup；`install()` 同时检查版本和两个官方源码文件 SHA。未知升级**启动拒绝**，不要取消检查直接套用。

## 隔离安装、测试与前台启动

在仓库根执行（需要现有 `uv`；不全局安装）：

```bash
uv venv --python 3.13 scripts/claude-gpt-compat/.venv
uv pip sync --python scripts/claude-gpt-compat/.venv/bin/python scripts/claude-gpt-compat/requirements.lock
LITELLM_LOCAL_MODEL_COST_MAP=True LITELLM_TELEMETRY=False scripts/claude-gpt-compat/.venv/bin/python scripts/claude-gpt-compat/test_compat.py
mkdir -p scripts/claude-gpt-compat/runtime/converter-home
scripts/claude-gpt-compat/.venv/bin/python scripts/claude-gpt-compat/launch.py --home scripts/claude-gpt-compat/runtime/converter-home
```

`requirements.lock` 固定已验收的完整 107 项依赖；Python 3.13.12 / Linux 上验证。安装需要公开包下载网络；**模型请求**仅 local4000。进程必须前台保持运行。Ctrl-C/SIGTERM 正常停止；未提供系统自启、未改任何生产 service。

启动程序清空继承环境并使用专用 HOME；不加载真实 OAuth/API key。native-required `local-no-auth-placeholder` 是配置中明确的**非秘密占位**，只允许发往本地。不要把真实凭据填入该配置。不要将监听暴露到 LAN/Tailscale，也不要将 `--home` 指向真实 HOME。

可选 `--audit <private-log-path>` 仅供非秘密验收，记录模型文本、工具结果及事件；默认关闭。真实工作资料不要启用该日志，也不要上传原始日志。

## Claude 独立入口

先确认前台 sidecar 已启动：

```bash
curl --fail http://127.0.0.1:24339/health/liveliness
mkdir -p scripts/claude-gpt-compat/runtime/native-home
```

验收所用安全、一次性 Read 入口（不会把生产配置当作已迁移）：

```bash
env -i PATH=/home/haipw/.local/bin:/usr/bin:/bin HOME="$PWD/scripts/claude-gpt-compat/runtime/native-home" \
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost \
  /home/haipw/.local/bin/claude --bare \
  --settings /home/haipw/.claude/providers/phonon-local4000-gpt.json --setting-sources '' \
  --no-session-persistence --strict-mcp-config --tools Read --allowedTools Read \
  --permission-mode dontAsk -p 'Use Read to read the test file I specify, then report its contents.'
```

上述只明确授权本次进程的 Read，未使用跳过全部权限或全局 policy。若要用于常规交互、额外工具或生产 daemon，需另外评审相应权限/默认入口；本工具不自动授权。

**验收结束 sidecar 会停止，独立 GPT settings 会保留。因此仅保留该文件不代表当前可直接用或长期后台可用。** 原独立 Qwen 入口不依赖此 sidecar，仍保持原状。生产长期运行需另行决定服务托管与 Phonon 的独立 settings 支持，不能只修改 endpoint 并沿用真实旧 token。

## 回滚与证据

- shim 回滚：停止本 sidecar 即消除进程内 binding；官方包磁盘字节不变。不要将用户默认入口指向已停止的 24339。
- settings 回滚：使用原维护 broker/Rescue 的 `rollback_config`，指定验收报告中的 backupId 和**当前实际 SHA**；只允许已注册的独立 GPT 文件和 `env` root。不要整份复制旧真实 settings/凭据。
- 本轮初次配置成功后额外由真实 Rescue 做了 `{}` 原字节回滚演练，再由新 Rescue 会话重新写入 GPT，并重新做真实 Claude 后验。宿主只最初创建空文件、安装/启动 sidecar、运行验收，不能称模型写了 shim。
- 详细证据、源基线/增量 diff、工具 IDs、随机 marker、网络 connect 审计、backup/rollback 和清理记录：`acceptance/claude-gpt-compat-20260909-173426/REPORT.zh-CN.md`。
