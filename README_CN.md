# dsh-plugin-quota-badges

> **改名说明**：本插件已从 `dsh-plugin-opencode-quota` 改名为 `dsh-plugin-quota-badges`
> （插件 id、settings 命名空间、HTTP 路由前缀、client 模块 id 全部同步为 `quota-badges`）。
> 源码目录名保留 `dsh-opencode-quota` 未动，安装命令仍以该真实目录为准。

DeepSeek Harness 外挂插件：**多厂商订阅额度徽章**。当前支持 OpenCode（Zen Go）、
MiniMax、Kimi Code 与 DeepSeek 四家，查询各自的额度窗口/余额并在输入栏模型
选择器旁边渲染一个小徽章。

```
┌──────────────────────────────────────────────────────────────┐
│  输入栏（第二行）   [＋] [模式] [OpenCode 5h ██░░ 剩78% · 周 ██ 剩20%] … [模型 ▾] │
└──────────────────────────────────────────────────────────────┘
```

徽章位于 `conversation.input.right` 扩展槽，紧邻模型选择器；文本块进度条
（████░░░░）直观呈现剩余额度，点击弹出完整详情。

- 徽章**聚合所有已配置厂商**的窗口（滚动 **5 小时** / **周**，部分厂商还有
  **月**）的**剩余百分比**（剩余视角更利于把控）；剩余低于 30% 转警告色、低于
  10% 转危险色。详情面板按厂商分节展示各窗口百分比进度条、重置倒计时。
- 点击徽章弹出详情卡片：各厂商窗口进度条、重置倒计时、订阅续期与更新时间、
  独立的「立即刷新」按钮（刷新全部厂商）；未配置 Key 的厂商显示配置指引。
- 服务端后台轮询（默认 60 秒），多开标签页不增加上游请求。
- **跟随当前模型显示**（默认开）：仅当选中模型的提供商属于已注册额度厂商
  （opencode 系 / minimax 系 / kimi 系 / deepseek 系）时徽章才出现，切到其他服务商自动隐藏。
- **架构**：每个厂商一个 provider 适配器（`providers/opencode.js`、
  `providers/minimax.js`、`providers/kimi.js`、`providers/deepseek.js`），统一快照结构经
  `/status` 的 `all` 字段带出全部厂商状态，顶层字段保持单厂商兼容。
- OpenCode 窗口解析移植自 ~/CodexBar 的 Swift 实现
  （`Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift`，
  见免依赖的 `usage-core.js`，带单元测试）；MiniMax 解析移植自
  `Sources/CodexBarCore/Providers/MiniMax/MiniMaxUsageFetcher.swift` 的
  **API Token / JSON 路径**（`providers/minimax.js`）；Kimi Code 解析移植自
  `Sources/CodexBarCore/Providers/Kimi/KimiUsageFetcher.swift` 的
  **API Key 路径**（`providers/kimi.js`：周配额 = 顶层 `usage`，5 小时限流 =
  `limits[0]`，计数为字符串，`used` 权威、`remaining` 兜底）。DeepSeek 是
  **余额型**厂商（无窗口配额）：适配器移植自
  `Sources/CodexBarCore/Providers/DeepSeek/DeepSeekUsageFetcher.swift` 的
  **API Key 余额路径**（`providers/deepseek.js`：`/user/balance` 的
  `balance_infos[]`，优先有余额的 USD、否则任一有余额币种、否则 USD；客户端以
  「余额 + 金额 + 可用性条」渲染，不再用百分比窗口）。
- **模型列表同步**（OpenCode 专属）：修复 dsh「获取可用模型」对 OpenCode 路由
  只显示内置目录旧清单的问题——实时拉取端点 `/models`，与已安装目录合并后写入
  `llm-pi-ai` 设置，新模型立即出现在选择器中（见下文专节）。

## 为什么需要服务端代理

浏览器无法直连 opencode.ai / miniMax 平台：这些端点对 CORS 预检不透明，跨域请求
必然失败。因此插件的服务端半在 Node 里轮询各上游，把缓存快照通过共享 `webServer`
服务的同源路由发给前端——不加端口、没有 CORS、密钥也不进浏览器。

## 安装

```sh
node /path/to/deepseek-harness/apps/cli/lib/bin.js plugin --profile web \
  add "file:/root/dsh-opencode-quota"
# 然后重启 web 服务
```

该命令会把本包加为 profile 依赖并自动追加进 bundle 层叠列表（本包声明了
`dsh.bundle.patch`），下次服务器重启后生效。不启动进程即可验证组合：

```sh
dsh --profile web --dump-config | grep -A8 quota-badges
```

## 配置

**推荐：全部在 Web 界面完成** —— 打开 设置 → 插件 页的「OpenCode 订阅额度」卡片，
填写 API Key、调整轮询间隔与超时，点保存后立即生效，无需重启。

配置卡片按 **通用设置 / 厂商接入 / 模型能力** 三组排布。「厂商接入」只展示你
选择接入的厂商：段头右侧「＋ 添加厂商」列出尚未接入的厂商，点选即出现一个
配置块；每个配置块右上角的「移除」会取消固定并**清除该厂商已保存的密钥**
（之后可随时重新添加）。清单持久化在 `visibleProviders`，未来版本新增的厂商
默认不出现在卡片里（opt-in），厂商再多卡片也不会变长。底层仍由客户端
`PROVIDER_FIELDS` 注册表驱动：接入新厂商 = `providers/` 目录加一个适配器 +
注册表补一条字段描述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | `''` | 显式 OpenCode API Key；留空则回退读取下面的环境变量。 |
| `apiKeyEnvVar` | `OPENCODE_API_KEY` | `apiKey` 为空时读取的环境变量名（仅组合层）。 |
| `providers.minimax.apiKey` | `''` | MiniMax API Token；留空回退 `MINIMAX_CN_API_KEY` 环境变量。 |
| `providers.minimax.region` | `cn` | MiniMax 区域：`cn`（api.minimaxi.com）或 `global`（api.minimax.io）。 |
| `providers.kimi.apiKey` | `''` | Kimi Code（Kimi For Coding 订阅）API Key；留空回退 `KIMI_CODE_API_KEY` 环境变量。 |
| `providers.deepseek.apiKey` | `''` | DeepSeek API Key（余额型，无窗口配额）；留空回退 `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` 环境变量。 |
| `providers.kimi.baseURL` | `https://api.kimi.com` | Kimi 用量端点基址（`/coding/v1/usages`；仅测试兼容代理时改）。 |
| `visibleProviders` | `['opencode', 'minimax']` | 设置卡片中固定展示的厂商块；其余留在「添加厂商」选择器里（纯界面字段，服务端仍轮询全部已注册厂商）。 |
| `intervalSec` | `60` | 上游轮询周期（下限 15 秒）。 |
| `timeoutSec` | `10` | 单次上游请求超时。 |
| `statusPath` | `/api/quota-badges/status` | 提供缓存快照的 GET 路由（改动需重启）。 |
| `refreshPath` | `/api/quota-badges/refresh` | 强制刷新一次的 POST 路由（改动需重启）。 |
| `modelsSyncEnabled` | `true` | 模型列表同步总开关（发现增强 + 同步按钮，OpenCode 专属）。 |
| `modelsRouteKey` | `opencode-go` | 要保持最新的 llm-pi-ai 路由键。 |
| `modelsBaseURL` | `https://opencode.ai/zen/go/v1` | 探测实时模型清单的端点。 |
| `syncModelsPath` | `/api/quota-badges/sync-models` | 强制同步一次模型清单的 POST 路由（改动需重启）。 |

### 多厂商配置

顶层扁平键（`apiKey`/`modelsRouteKey` 等）是 **OpenCode 兼容层**（旧设置文档沿用）；
新增的 `providers.<id>.*` 嵌套块覆盖对应厂商的配置。MiniMax 支持：

- `providers.minimax.apiKey` —— API Token（Bearer），空的回退环境变量
  `MINIMAX_CN_API_KEY`。
- `providers.minimax.region` —— `cn`（默认，api.minimaxi.com）或 `global`
  （api.minimax.io）。

Kimi Code（Kimi For Coding 订阅，区别于月之暗面开放平台）支持：

- `providers.kimi.apiKey` —— Kimi Code API Key（Bearer），空的回退环境变量
  `KIMI_CODE_API_KEY`。
- `providers.kimi.baseURL` —— 用量端点基址（默认 `https://api.kimi.com`，
  端点 `/coding/v1/usages`；仅测试兼容代理时改）。

DeepSeek 为余额型帐户（无窗口配额），支持：

- `providers.deepseek.apiKey` —— DeepSeek API Key（Bearer）；留空回退
  `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` 环境变量。客户端以余额卡片展示：
  金额 + 已充值/赠送拆分，满条=有可用余额、空条=余额耗尽
  或不可用。

`/status` 顶层字段始终是当前"活跃"厂商（第一个注册者，即 opencode）的快照，
新增 `all` 字段携带**全部厂商**各自的 `{provider, displayName, data, error,
fetchedAt, ageSec}`，供客户端聚合展示。

## 模型列表同步（v0.5.0）

dsh 对「内置目录 provider」（如 `opencode-go`）的「获取可用模型」动作直接返回
pi-ai 随版本钉死的模型目录、不访问端点；上游新增模型后目录滞后。本插件从两个
方向修复：

1. **发现增强**：包装 llm 运行时里 `llm-pi-ai` 已注册的 discovery，使配置界面的
   「获取可用模型」返回 *实时端点清单 ∪ 目录元数据*（实时顺序在前，目录独有模型
   附后；目录内条目保留名称与容量）。尽力而为：找不到内部注册时仅告警停用。
2. **显式同步**：插件卡片上的「同步模型列表」按钮（或 `POST <syncModelsPath>`）
   探测实时 `/models`，经 `ctx.llm.listModels()` 取当前目录做合并，再通过公开的
   settings 写入通道把结果写进 `llm-pi-ai` 用户设置层的
   `providers.<modelsRouteKey>.models`。写入走 llm-pi-ai 自己的 schema 校验，
   适配器按请求重新解析配置，因此新模型无需重启即可选用。

注意：显式同步会以合并结果**整体替换**该路由的 `models` 列表（其他路由字段不受
影响）；目录未收录的新模型只写 id，容量走 dsh 默认值（262144/32768、纯文本），
视觉等特殊型号可按需在设置中补 `input` 字段。

### v0.6.0：路由 api 与注册表容量富集

- 同步时一并写入 `modelsRouteApi`（默认 `openai-completions`）作为路由级线协议——
  否则 dsh 拒绝保存含目录外模型的清单（"needs an api"校验）。
- 新增 `modelsEnrichFromRegistry`（默认开）：同步与「获取可用模型」会从 models.dev
  注册表（OpenCode 的模型数据库）拉取每个新模型的上下文长度、最大输出、显示名与
  图像模态并自动填入；别名模型经其规范文件二级解析。注册表也没有的极少数超新
  模型保持裸条目走 dsh 默认值，可随时手动修改。

### v0.6.2：fetch 提速与更深的注册表覆盖

- 「获取可用模型」在注册表上最多等 3 秒：首次扫描偏慢时会转入后台继续，
  下一次 fetch 直接命中缓存秒回（非空答案缓存 6 小时；空扫描 1 分钟后重试）。
  注册表请求使用独立的 4 秒超时，并发上限 5。
- 别名条目沿整条 `base_model` 链解析（带环检测）；注册表确实没有容量的 id，
  会从路由目录中最接近的同族前缀兄弟继承容量（如 `deepseek-v4-flash-vision-exp`
  继承 `deepseek-v4-flash`）。模态依旧不做猜测。

### v0.6.3：OpenCode 路由的视觉输入

- 同一个视觉模型在官方 deepseek 路由可用、在这里被拒的原因：官方适配器的目录为
  `deepseek-v4-flash-vision-exp` 显式声明了 `inputModalities: ["text", "image"]`，
  而本插件写入的条目没有 `input` 字段，回落为纯文本，附件因此被拒。
- 同步现在会给**同进程内其他已注册 provider 按精确 id 声明为多模态**的路由模型
  授予 `input: ["text", "image"]`（跨 provider 精确 id 匹配是数据而非猜测；video/pdf
  模态忽略）。同步回包以 `grantedImageInput` 报告数量。
- 启动时对已保存的模型做同样的一次性补齐：GUI 自己的保存路径不带逐模型 input
  字段，否则图像支持会一直丢失到下次同步。在 GUI 里重新保存采纳的清单仍会清掉
  `input` --点一次同步（或重启）即可恢复。
- 注册表 404 现在视为确定性的「没有」，不再回落 raw 镜像，端点列出注册表未收录
  id 时冷扫描依旧快速。

### v0.6.4：显式视觉白名单

- 新增配置 `modelsVision`（模型 id 数组）：**强制**这些模型带 `input: ["text",
  "image"]`，不受自动判定影响；`modelsTextOnly` 则强制去掉图像输入。两者
  同时命中时视觉优先。同步回包以 `forcedVision` / `forcedTextOnly` 报告数量。
- dsh 本来就会在请求时拒绝给 `input` 不含 `image` 的模型发图，所以这两个列表
  更多是**显式控制与可发现性**，而非唯一的安全网。默认空。

界面保存的值写入用户设置层并即时生效；组合层默认值仍可在 profile 补丁中声明，
路由路径属于启动期组合项，修改后需重启 Web 服务。

## HTTP API

- `GET <statusPath>` → `{ ok, data, error, fetchedAt, ageSec }`；绝不触发上游请求。
- `POST <refreshPath>` → 强制一次上游拉取后返回同样结构。
- `POST <syncModelsPath>` → 同步模型清单，返回 `{ ok, routeKey, total, added[], removed[], syncedAt }`；
  失败时返回 `{ ok: false, error: { code, message } }`（code ∈ unconfigured / disabled /
  no-settings / invalid-credentials / api-error / parse-failed / network-error / settings-write-failed）。

`data` 为 `{ rolling?, weekly?, monthly?, renewsAt?, fetchedAt }`，每个窗口是
`{ percent, resetInSec }`。未配置密钥时返回 `error.code === "unconfigured"`。
响应还带 `all` 字段——每个已注册厂商一个 `{ provider, displayName, data,
error, fetchedAt, ageSec }` 条目，供客户端聚合展示；顶层字段始终为活跃
（第一个注册）厂商的快照，保持单厂商客户端兼容。

## 客户端徽章

注册进 `ui-conversation` 声明的 `conversation.input.right` 列表槽
（列表 id `quota-badges`，order 10）。徽章**聚合全部已配置厂商**的额度窗口
（多厂商时窗口前带厂商名），点开详情按厂商分节；上游失败时保留最后快照并标记
过期；未配置时显示灰色提示徽章，悬停提示缺失的环境变量。`syncWithModel` 门控
按「当前模型 provider 是否命中任一已注册厂商」判定。

## Model Experience

无：本插件不提供任何工具、提示词片段或模型可见状态，只是宿主侧 HTTP 代理加上
一个纯展示的输入栏徽章。

#### KV Cache effect

无；不参与任何模型请求。

## 从旧版升级

1. **改名**：`dsh-plugin-opencode-quota` → `dsh-plugin-quota-badges`（插件 id、
   settings 命名空间、路由前缀、client 模块 id 全部切换）。改完需重建 profile
   依赖并重启：`dsh plugin --profile web remove dsh-plugin-opencode-quota` 后
   `dsh plugin --profile web add "file:/root/dsh-opencode-quota"`（或以
   `link:` 协议替换，见下文），再 `dsh --profile web --dump-config | grep -A8 quota-badges`
   验证。
2. **设置迁移**：旧命名空间 `opencode-quota` 的已保存设置不会自动出现在新
   命名空间。用仓库内的一次性脚本迁移（保留注释、幂等，settings-file 热发布
   无需重启）：
   ```sh
   node scripts/migrate-legacy-settings.mjs
   ```
   脚本默认处理 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`），也
   可传显式路径。检测到新旧 section 同时存在时会拒绝执行（需手动合并）。
3. **开发期用 `link:` 依赖**：`dsh plugin add "link:/root/dsh-opencode-quota"`
   让 profile 直接符号链接源码目录，后续改代码只需 `systemctl restart
   deepseek-harness.service` 生效，不必每次重装。

## 已知限制与后续计划

- MiniMax 目前只实现 **API Token / JSON** 路径（CN + global 区域）；CodexBar 的
  Cookie/HTML 抓取、计费历史、多 service 车道详情尚未移植。
- 发现增强依赖 llm 运行时的内部注册结构（`discoveries` Map）；dsh 升级若改动该
  结构会静默降级为仅目录答案（启动日志有告警），显式同步按钮不受影响。
- 状态路由注册在共享 Web 服务器上；若部署用带认证的替代实现（如
  `webserver-auth`），是否被统一拦截取决于该插件的分发包裹方式——对回环地址之外
  暴露前请先验证。
- 客户端硬编码两条默认路由路径；如修改服务端路径配置需同步改 `client.js` 顶部常量。
