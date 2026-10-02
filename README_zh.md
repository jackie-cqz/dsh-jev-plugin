# dsh-jev-plugin

[English](./README.md) | **简体中文**

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Agent 能调用 TypeSafe Jev（System One）做**类型化决策**的工具插件。

Jev 不是聊天模型：它不生成文本，只返回结构化判断。本插件把它的三种原语封装成 Agent 可主动调用的工具：

| 原语 | 含义 | 返回 |
|---|---|---|
| `noul` | 是/否判断 | 0–1 概率 |
| `choice` | 从若干标签中选一个 | 选中项、概率分布、confidence |
| `score` | 按有序等级评分 | score、概率分布、confidence |

## 状态

- 版本：`0.1.0`
- 目标 DSH 版本：`0.2.0-rc.2`；保留 `0.1.7-rc.2` 和 `0.1.6-alpha.2` 安装回归验证（声明范围 `>=0.1.6-alpha.2 <0.2.0 || >=0.2.0-rc.2 <0.3.0`，其他版本尚未逐一验证）
- 许可证：MIT
- 独立包，通过 `dsh.bundle` 机制安装；不修改 DSH 主仓库

## 兼容矩阵

| 项目 | 范围 |
|---|---|
| 目标 DeepSeek Harness | `0.2.0-rc.2`（另验证 `0.1.7-rc.2`、`0.1.6-alpha.2`） |
| `@deepseek-ai/cordis`（peerDependency） | `^4.0.2` |
| `@deepseek-ai/dsh-tools`（peerDependency） | `^0.1.6-alpha.2`、`^0.1.7-rc.2` 或 `^0.2.0-rc.2` |
| Node（插件 `engines`） | `>=22` |
| Node（DSH 宿主） | `^22.19.0` 或 `>=24.0.0` |

构建与测试依赖由 `package-lock.json` 锁定。CI 配置覆盖 Node 22 / 24；本地发布检查已在 Node 24 上通过。

兼容检查：目标运行时的类型检查、782 个插件测试和 2 个打包报告解析测试通过；三版 DSH 的 tarball 安装检查均通过。Windows / Node 24 上的真实 TypeSafe smoke 和场景检查通过。Chromium 验收验证了四个成功工具调用、九个结果概率条以及刷新后重放，使用固定 LLM 测试适配器驱动真实 Jev 请求。Git 源码安装验收见发布记录。

### 为什么一批 `@deepseek-ai/*` 出现在 devDependencies

发布的 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 把 `dsh-agent`、`dsh-invariants`、`dsh-llm`、`dsh-ptc-runtime`、`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-scope`、`dsh-session`、`dsh-system-prompt`、`dsh-user-approval` 声明为 peerDependencies（另有 `cordis`，本包已单独声明）。`npm install --legacy-peer-deps` 不会自动安装它们，而缺少任何一个都会让 `import '@deepseek-ai/dsh-tools'` 直接失败，因此本包把这 10 个包全部列入 devDependencies。运行期它们由目标 profile 提供，所以不进入 `dependencies`。

### 已知环境限制

如果 Node 连接 TypeSafe API 时握手超时，但 `curl` 能正常连接，可以尝试 `--tls-max-v1.2` 排查 TLS 兼容问题。需要时，**运行中的 DSH 进程同样需要该参数**；命令见本文「开发」一节。

## 安装

本地源码安装（将路径替换为实际目录，先在插件目录执行 `npm ci --legacy-peer-deps`）：

```sh
dsh --profile jev-dev --from-default-profile web --dump-config
dsh plugin --profile jev-dev add /path/to/dsh-jev-plugin
dsh --profile jev-dev --dump-config   # 应能看到 tool-jev 这一行
dsh --profile jev-dev
```

第一条命令用 Web 模板初始化新 profile，只对未使用的名称执行一次。直接给新名称添加插件只会创建基础 profile，不会启用 Web 应用。已有 Web profile 可跳过初始化。

从 GitHub 安装（先按上面初始化 Web profile；版本标签固定安装的代码版本）：

```sh
dsh plugin --profile jev-dev add github:jackie-cqz/dsh-jev-plugin#v0.1.0
```

从 Git 源码安装时，pnpm 会先执行本包的 `prepare` 脚本（`npm run build`）再加载；若 pnpm 提示构建脚本被拦截，按它打印的键名把该包加入 profile 的 `pnpm-workspace.yaml` 下的 `allowBuilds` 后重试。

也可以使用 [v0.1.0 发布页](https://github.com/jackie-cqz/dsh-jev-plugin/releases/tag/v0.1.0) 的预构建安装包。初始化 Web profile 后直接执行：

```sh
dsh plugin --profile jev-dev add https://github.com/jackie-cqz/dsh-jev-plugin/releases/download/v0.1.0/dsh-jev-plugin-0.1.0.tgz
```

安装包包含服务端与 Web 客户端构建产物，无需编译插件。发布附件提供 SHA256SUMS，变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | — | TypeSafe API key，优先于 `apiKeyEnv` |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 未配置 `apiKey` 时读取的环境变量名 |
| `baseURL` | `https://api.typesafe.ai/v1` | TypeSafe API 根地址，尾部斜杠会被去掉 |
| `model` | `jev-latest` | 默认 Jev 模型，可在每次工具调用时用 `model` 参数覆盖 |
| `timeoutMs` | `10000` | 单次调用超时（毫秒） |
| `retry.maxAttempts` | `3` | 总尝试次数，含第一次 |
| `retry.baseDelayMs` | `500` | 首次退避（毫秒） |
| `retry.maxDelayMs` | `5000` | 单次退避上限（毫秒） |
| `maxStateChars` | `64000` | `state` 序列化后的字符上限；超限在发请求前就被拒绝，`0` 表示不限制 |
| `confidence.approveAt` | `0.8` | 置信度达到此值可自动采纳（供 `verdictFor` 使用） |
| `confidence.escalateBelow` | `0.5` | 置信度低于此值应转人工；不得大于 `approveAt` |
| `policy.enabled` | `false` | 开启调用准入策略（连续失败熔断 + 最小间隔限流） |
| `policy.failureThreshold` | `5` | 连续失败多少次打开熔断 |
| `policy.openMs` | `30000` | 熔断打开多久后放行一次探测调用 |
| `policy.minIntervalMs` | `200` | 两次调用之间的最小间隔（毫秒） |
| `cache.enabled` | `false` | 开启响应缓存（相同 model + state + questions 命中） |
| `cache.maxEntries` | `100` | 缓存条目上限，超出按 LRU 淘汰 |
| `cache.ttlMs` | `60000` | 缓存条目存活时间（毫秒） |
| `guard.enabled` | `false` | 开启 `tools/pre-execute` 风险闸门（拦截其他工具调用） |
| `guard.tools` | `[]` | 闸门检查的工具名；空列表表示检查全部 |
| `guard.question` | 内置风险问题 | 每次调用问 Jev 的问题 |
| `guard.levels` | `["low","medium","high","critical"]` | 有序风险等级，2–10 个 |
| `guard.denyAt` | `3` | 风险分达到此级即拒绝（最高等级） |
| `guard.askAt` | `1` | 风险分达到此级需人工确认 |
| `guard.escalateOnLowConfidence` | `true` | 置信度低于 `confidence.escalateBelow` 时转为人工确认 |
| `guard.reviseAt` | 最高级下标 | 风险分达到此级改为**拒绝并附改写指引**；默认等于 `denyAt`，即**默认不启用**，要生效必须显式放宽 |
| `guard.onError` | `"allow"` | 闸门自身失败时的行为：`allow` 为 fail-open，`deny` 为 fail-closed |
| `rules.enabled` | `false` | 开启**离线硬拒止层**：同步、不联网、不需要 key、不可被审批越过 |
| `rules.tools` | `[]` | 规则检查的工具名；空列表检查全部 |
| `rules.deny` | `[]` | 追加到内置规则集的拒绝模式（大小写不敏感正则，非法正则在加载时报错） |
| `review.enabled` | `false` | 开启 `tools/post-execute` 结果复核（会改写已完成的工具结果，风险较高） |
| `review.blockAt` / `review.onError` | `0.8` / `"accept"` | 判定为需纠正的概率门槛；失败时默认放行 |
| `routing.enabled` | `false` | 开启模型路由（`agent/request`），按请求复杂度改派 `routing.models` 里的档位 |
| `context.enabled` | `false` | 开启上下文裁剪（`agent/pre-step`） |
| `context.maxDrops` / `context.shadow` | `0` / `false` | 单次最多丢几条（0 不限）；`shadow` 只报告不改动，**任何会删内容的钩子都应先跑它** |
| `intent.enabled` | `false` | intent routing 的决策层已实现，但**注入路径不接线**：当前宿主缺少插件来源的 pre-step 消息通道，开启此选项不会注入指令 |
| `quotaCooldownMs` | `900000` | 收到 `402` 后停止发请求的时长；**独立于 `policy.enabled`**，`0` 表示不冷却 |
| `enableDecide` / `enableEvaluate` | `true` | 是否注册对应的工具 |
| `telemetry.log` | `false` | 每次调用输出一条脱敏结构化记录 |
| `telemetry.sampleRate` | `1` | 记录抽样比例（0–1） |
| `telemetry.errorRateAlert` | `0.5` | 错误率达到此值判为 degraded |
| `telemetry.alertMinCalls` | `10` | 样本少于此数不下健康结论 |

`guard.askAt` 默认为 `1`，`guard.denyAt` 默认为 `3`。阈值需要按目标场景验证；模型评分和置信度可能波动。修改 `guard.levels` 时默认阈值会夹到合法范围，显式设置越界值则报错。

`maxStateChars` 超限是**拒绝**而不是截断——截断会静默改变被判断的内容，可能让决策基于残缺文本。`policy`、`cache`、`guard` 默认关闭，开启前行为与最初版本一致。

推荐用环境变量提供密钥，不要写进 `cordis.patch.yml`：

```sh
export TYPESAFE_API_KEY="..."
```

PowerShell：

```powershell
$env:TYPESAFE_API_KEY = "..."
```

需要写进配置时，使用 secret role 并限制文件权限。API key 不会出现在工具输出、错误消息或日志里。

## 工具

### `jev_decide`

面向单个决策的便捷工具：给出文本、问题、原语类型和选项，插件负责拼装 Jev 请求。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `state` | JSON | 是 | 要判断的文本、对象或数组 |
| `question` | string | 是 | 要问 Jev 的问题 |
| `kind` | `noul` \| `choice` \| `score` | 是 | 决策原语 |
| `options` | string[] | 否 | `choice` 的标签（2–255，去重后计数）；`score` 的有序等级（2–10） |
| `model` | string | 否 | 覆盖默认模型 |

`state` 接受字符串、数组和普通对象，拒绝 `null`、number、boolean。

返回：

```json
{
  "model": "jev-1.13.0",
  "answer": {
    "type": "choice",
    "choice": "billing",
    "probabilities": { "billing": 0.91, "technical": 0.08, "sales": 0.01 },
    "confidence": 0.87
  },
  "usage": { "input_tokens": 320, "output_tokens": 34 }
}
```

### `jev_evaluate`

面向原生多问题的工具：直接传 Jev 的 `questions` map，一次调用回答多个问题，适合结构化 instructions 与自定义 criteria。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `state` | JSON | 是 | 同 `jev_decide` |
| `questions` | JSON object | 是 | Jev 原生 questions map，至少一个问题 |
| `model` | string | 否 | 覆盖默认模型 |

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Payment issues", "technical": "Bugs", "sales": "Pricing" }
    },
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
  }
}
```

返回 `{ "model", "answers", "usage" }`，`answers` 保持 Jev 原始结构。`questions` 只做「非空对象」校验，深层结构交给 TypeSafe API。

何时用哪个：一个问题上 `jev_decide`；多个问题、结构化 instructions 或自定义 criteria 用 `jev_evaluate`。

## 输出约定

两个工具都返回 JSON envelope，**`model` / `answer`（或 `answers`）/ `usage` 三个字段必须同时存在**，缺任何一个都按接口异常报错，不做静默兜底。

模型看到的文本是**一行人类可读摘要 + 完整的 canonical JSON**：

```
score: 2.99/3 = 紧急 (confidence=0.99)

{ "model": "jev-1.13.0", "answer": { ... }, "usage": { ... } }
```

摘要把 `legend` 里的下标映射成标签、把概率换算成百分比；遇到缺字段或畸形答案时**降级为纯 canonical JSON 且不报错**。canonical JSON 始终完整保留，所以下游不会因为「文案变友好了」而丢数据。

## Web 结果卡片

包内包含独立客户端产物 `lib/client.js`，通过 DSH 模块加载器注册两个工具的结果卡片，展示决策标签、概率或评分。工具仍保留完整 JSON 输出。当前未提供设置页或输入框开关。

## 错误处理

缺少密钥、参数不合法、请求超时、取消、HTTP 错误和响应结构异常会返回对应错误。`402` 会触发配额冷却；`401` / `403` 应检查密钥及权限，`422` 应检查请求参数。`/jev-status` 可用于查看配置、健康状态与冷却原因，不显示密钥值。

## 重试

- 默认最多 3 次尝试（含第一次），指数退避 + jitter，受 `retry.maxDelayMs` 截断。
- 服务端返回 `Retry-After` 时优先遵守（同时受 `maxDelayMs` 截断）。
- 重试：`429`、`529`、`500`、`502`、`503`、`504` 和网络瞬态错误。
- 不重试：`401`、`403`、`422`、参数校验错误、用户取消。
- 总时长同时受 `timeoutMs` 和调用方取消信号约束；Jev 是只读评估，重试不会产生重复副作用。

## 风险闸门（可选）

默认**关闭**。开启后，插件会挂在 DSH 的 `tools/pre-execute` 上，在**每次工具调用执行之前**让 Jev 给这次调用打一个风险分，再按分数决定放行、要求人工确认、还是拒绝：

```yaml
- id: tool-jev
  config:
    guard:
      enabled: true
      tools: ['run_shell', 'write_file']   # 留空则检查全部工具
      denyAt: 3
      askAt: 1
```

判分依据是 `{ tool: 工具名, arguments: 模型给出的参数 }`。真实运行样例（`run_shell`）：

```
命令: ls -la /tmp
  → 放行，工具真的执行了

命令: DROP TABLE users; then delete all production backups and rotate every credential
  → 拒绝：scored 3/3 (critical)，工具体从未执行
```

三条刻意的默认：

- **默认不拦截**。不显式开启，闸门连一次 Jev 调用都不会发。
- **默认 fail-open**（`guard.onError: "allow"`）。Jev 抖动、超时、熔断打开时，调用照常放行——一次判断服务的故障不该让 agent 的工具全线瘫痪。需要更严的部署可以设成 `"deny"`。
- **拒绝理由不含参数内容**。理由会进入模型上下文并落盘，而参数可能含密钥；理由只报工具名、等级标签、分数、置信度和错误的机器可读码（HTTP 错误附状态码，不含响应体）。

**判定限制**：相同输入的评分与置信度可能变化，例行开发操作也可能触发确认。开启前应在目标工作流中验证阈值，不能把模型判断当作确定性的安全边界。

**隐私**：开启闸门意味着**工具名与参数**会被发给 TypeSafe API 并记入 DSH 会话日志。`guard.tools` 就是用来把范围收窄到你真正想拦的那几个工具的。

## 离线硬拒止层（可选）

与语义闸门**互相独立**，建议一起开。它是一组**同步、纯文本匹配**的规则，挂 `ctx.tools.guard()`，**不联网、不需要 API key、不可被审批或令牌越过**：

```yaml
- id: tool-jev
  config:
    rules:
      enabled: true
      tools: ['bash', 'run_shell']
      deny: ['\bterraform\s+destroy\b']   # 追加到内置规则集
```

它**注册在语义闸门之前**，所以已被离线规则拒绝的调用**不会先花一次 Jev 往返**（实测 3 次工具调用只产生 1 次 Jev 调用——只有放行的那条走到语义层）。拒绝的约束力不变：只有 `ask` 会走审批。

内置覆盖递归删根、`dd of=/dev/`、`mkfs`、`git push --force`（不含 `--force-with-lease`）、`DROP`/`TRUNCATE`、`chmod -R 777 /`、fork bomb、关机重启。**实测**（禁用网络且不给 key，也就是语义层完全不可用时）：

```
DENY   rm -rf /                    allow  rm -rf ./build
DENY   git push --force            allow  git push --force-with-lease
DENY   shutdown -h now             allow  echo reboot
DENY   dd if=/dev/zero of=/dev/sda
DENY   DROP TABLE users
```

**它是事故安全网，不是安全边界**：只匹配已知文本形态，不做语义理解、不模拟文件系统、不防蓄意绕过（变量拼接、base64、脚本间接执行）。理由里**不会回显参数内容**（参数可能含密钥）。

## 可观测性

`ctx.jev.stats()` 给出 `calls` / `failures` / `retries` / `tokens` / `lastLatencyMs` / `totalLatencyMs` / `models`，以及准入策略与缓存的计数；成功率与错误率由前两项现算。`ctx.jev.health()` 返回 `healthy` / `degraded` / `unknown`，样本少于 `telemetry.alertMinCalls` 时返回 `unknown` 而不是「健康」——两次调用里错一次是 0.5 的错误率，同时也是零证据。

在会话里执行 **`/jev-status`** 会打印一份诊断：各能力开关、阈值、模型与判定端点、key 来源、调用与重试计数、健康状态，以及在 **Notes** 段列出「什么都没发生」的原因——未启用拦截、闸门开着但一次都没检查、检查了但一次都没到传输层、记录被采样丢弃、遥测出口报错、缺 key。失败默认放行，这些原因在别处都不会报错，所以诊断面是唯一能看见它们的地方。

开启 `telemetry.log` 后，每次调用（**含缓存命中**）会产出一条 `channel: 'ops'` 的记录，字段是**白名单重建**的：只含 outcome、model、耗时、token、重试次数、缓存标志与机器可读错误码。`state`、参数、工具结果与 API key **在接口上就没有对应字段**，所以脱敏是结构性的而不是约定。记录交给 `ctx.sessionTelemetry`，由 DSH 已挂载的遥测后端（例如 `@deepseek-ai/dsh-session-telemetry-otel`）导出——**本插件不依赖 OpenTelemetry**。没有挂后端的 profile 会退化成「只计数、不外发」，不会因此加载失败。

## 让它被用上：`jev-decisions` skill

工具描述说的是「这个工具能做什么」，而模型触发靠的是「**什么情况下该想起来用它**」。skill 的 `description` 会渲染进注入的 skill 目录、每一步都在模型上下文里，是比工具 schema 强得多的触发面。本包附一份，可在插件源码目录执行：

```sh
cp -r skills/jev-decisions ~/.agents/skills/
```

它对所有项目生效，覆盖：什么时候该用、用哪个工具（单问题 vs 多问题）、**怎么读答案**（概率未标定——适合排序不适合卡阈值；`score` 是零基下标，靠 `legend` 读标签；`confidence` 低就别当答案用）、什么时候不该用（计数 / 算术 / 日期与时区 / 多跳 / 对抗输入）、闸门会自行拦截不要试图绕过、以及 `state` 会离开本机。

## 限制与安全

- **把 `state` 交给 TypeSafe**：`state` 会发送到 TypeSafe API，也会进入 DSH 会话日志。不要放不必要的机密。
- **Jev 不擅长**：精确计数、数学、日期比较、间接推理、双否定，以及缺少相关 state 的长上下文；非英语准确率通常低于英语。不要把它当计算器或事实数据库。
- **对抗输入**：面向不可信输入时请自行加防护，不要依赖 Jev 单独做安全判定。
- `state` 超过 `maxStateChars`（默认 64000 序列化字符）会被拒绝，不会截断。
- 已提供可选 Hook 和 Web 结果卡片；Hook 默认关闭。尚未接入 DSH credentials / Settings，intent 指令注入也未启用。

## 开发

### 发布检查

```sh
npm ci --legacy-peer-deps
npm run check:release
```

`check:release` 依次运行类型检查、全部测试、服务端与客户端构建、严格打包检查和 tarball 安装 smoke。`npm publish` 的 `prepublishOnly` 也执行同一套检查；检查失败会阻止发布。

- `npm run check:pack`：要求先构建；核对 10 个发布文件、入口与 bundle patch、非空产物、双语 README 必需章节和语言切换链接，以及常见私钥/token 特征。特征扫描不保证识别所有格式的秘密。
- `npm run check:install`：要求先构建；实际打包并安装到 `.release-smoke-*` 临时消费者目录，使用固定的 DSH `0.2.0-rc.2` 运行时依赖验证工具调用、注销、客户端工厂和 slot 注册。安装禁用生命周期脚本，验证 npm 包自带构建产物。目录保留供排查，并被 Git 与发布文件白名单排除。
- 安装检查需要访问 npm registry，不调用真实 TypeSafe API，也不需要 API key；不代替 DSH CLI profile 安装与真实浏览器验收。
- CI 在 Ubuntu / Windows、Node 22 / 24 上运行以上检查。真实 API 和浏览器验收需手动执行：安装到独立 DSH profile，启动 Web，分别调用 `jev_decide` 的 noul/choice/score 和 `jev_evaluate` 多问题，并检查结果卡片。

CI 还分别设置 `DSH_TEST_VERSION=0.1.6-alpha.2` 和 `DSH_TEST_VERSION=0.1.7-rc.2` 运行安装检查，覆盖两版旧运行时。PowerShell 可先设置 `$env:DSH_TEST_VERSION` 再执行 `npm run check:install`。打包检查兼容 npm 10/11 的数组报告及 npm 12 的按包名索引报告。

### 本地验证

```sh
npm install --legacy-peer-deps   # npm 10.9.8 解析 vitest peer 依赖时会崩；用 pnpm 亦可
npm run typecheck
npm run test
npm run build        # 产出 dist/index.js、dist/index.d.ts 与 lib/client.js
```

真实 API 的端到端验证需要 `TYPESAFE_API_KEY`：

```sh
TYPESAFE_API_KEY=... npm run smoke
```

`scripts/smoke.mjs` 把构建产物装进真实的 DSH 工具注册表，对线上 TypeSafe API 依次验证 `jev_decide` 的三种 kind、`jev_evaluate` 多问题、object / array 形式的 `state`，以及错误 key 与缺 key 时的报错可读性。

`scripts/jev-cases.mjs` 是一份固定的 **Jev 用例套件**：13 个用例覆盖三种原语的真实场景（风险闸门、内容审核、工单分类、意图路由、语言识别、紧急度评分、客户情绪、多维度 `jev_evaluate`），再加 4 个已知短板探针（计数、算术、日期比较、双否定）。每个用例都会校验 envelope 结构（概率和、`legend` 与选项的对应、`score` 落在等级范围内、`choice` 属于给定标签），明确的用例还带 golden 期望；短板探针只记录不判定失败。

```sh
TYPESAFE_API_KEY=... npm run cases
TYPESAFE_API_KEY=... npm run cases -- score     # 只跑某一类：noul / choice / score / evaluate
```

若出现 Node 握手超时而 `curl` 正常，可临时限制到 TLS 1.2 排查：

```sh
TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/smoke.mjs
TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/jev-cases.mjs
```

插件默认使用平台 TLS 设置。若排查确认需要此参数，应同时应用于运行 DSH 的 Node 进程；不要将其视为所有环境的必需配置。

## 参考

- TypeSafe 介绍：<https://docs.typesafe.ai/introduction>
- TypeSafe API：<https://docs.typesafe.ai/api>
- Jev 已知短板：<https://docs.typesafe.ai/model-jaggedness/jev-1.13>
