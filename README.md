# dsh-skill-categories

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 `/` 技能菜单加上**信息架构**：分组、中文入口词、面包屑计数、分类跳转，以及一层本地语义兜底。

> English: the `/` slash menu in DeepSeek Harness lists every installed skill flat. This plugin regroups it into 10 display classes, gives each skill Chinese lookup words, shows counts in a breadcrumb bar, and adds an offline semantic fallback for queries no keyword table covers. It works on the user's own skill library — nothing is pre-baked, you generate the index locally.

**状态**：在 DSH `0.2.1-rc.5` / Windows 上验证过。macOS 与 Linux 未实测（脚本已尽量跨平台）。

---

## 它解决什么

DSH 的技能库会长到一百多个。`/` 一打开是 **110 条平铺的 kebab-case 英文名**：

```
academy-guide
agent-browser
audio-to-structured-notes
aws-wechat-article-assets
...
```

三个具体问题：

1. **找不着**——字母序对人没有语义，你不知道「做杂志感 PPT」那个叫 `deck-guizang-editorial`
2. **中文搜不到**——`/做落地页` 命中 0 条，因为 110 个名字全是 ASCII
3. **没有全局感**——不知道总共有多少、分几类、哪类臃肿

## 装上之后

空查询：

```
┌──────────────────────────────────────────────┐
│ 设计 22 · 页面 7 · 图像 8 · 演示 7 · 动效 13   │  ← 面包屑，可点，带数量
├──────────────────────────────────────────────┤
│ ◐ 设计与视觉 · 22                             │  ← 分组标题带数量
│   brand                                      │
│   design                                     │
│ ⌘ 工程与质量 · 18                             │
│   ...                                        │
└──────────────────────────────────────────────┘
```

- 点面包屑上的「设计」→ 直接落到该类
- 打 `/设计` → 同样是筛选到该类
- 打 `/做个高级感落地页` → 别名 + 语义补充，能命中 `landing-page-design-hard-rules`

## 快速开始

**前置**：Node ≥ 20、装过 DSH 且至少启动过一次。

### 一键安装（Windows）

```
install.cmd
```

它会：找 DSH 安装位置 → 找 Node（PATH 或 DSH 自带 runtime）→ 跑 `setup.mjs` →
重启 DSH。不想自动重启就加 `-NoRestart`：

```
install.cmd -NoRestart
```

> `install.cmd` 保持纯 ASCII，中文提示都在 `install.ps1` 里（带 UTF-8 BOM）。
> 原因：cmd.exe 会把 .bat/.cmd 里的 CJK 字节按本地代码页误解析；PowerShell 5.1
> 又会把无 BOM 的 .ps1 当 ANSI 读。这两点都会把脚本本身弄坏。

### 手动安装

```bash
git clone <repo> dsh-skill-categories
cd dsh-skill-categories
node setup.mjs
```

`setup.mjs` 会自己找 DSH 安装位置、profile、技能目录，然后：

```
asar-skills → ingest → aliases → build → pack → install
```

跑完**重启 DSH**。

### 常用命令

```bash
node setup.mjs --dry-run        # 只看环境，不写文件
node doctor.mjs                 # 装不上时先跑这个
node setup.mjs --profile web    # 指定 profile
node setup.mjs --asar <path>    # 指定 app.asar（自动发现失败时）
node rollback.mjs               # 从 profile 里摘掉
npm test                        # 分类器 + 客户端 + 检索 全部断言
```

## 它到底改了什么

| 位置 | 动作 |
|---|---|
| `~/.dsh/local-plugins/dsh-skill-categories/` | 生成插件本体（宿主半 + 客户端 bundle） |
| `~/.dsh/profiles/<p>/package.json` | 加一条 `file:` 依赖，写进 `dsh.profile.bundles` |
| `~/.dsh/profiles/<p>/node_modules/` | 建目录链接指向插件 |

**只改这三处**，`rollback.mjs` 可逆。

## 自我迭代：新技能自动纳入

分类不是一次性的快照。装新技能时它有两层反应：

### 运行时（立刻生效，零配置）

bundle 里带的不只是「分类结果」，还有**整张规则表**。菜单每次取目录时：

1. 没见过的技能 → 用同一套规则当场分类，直接进对应分组
2. 仍然分不出的 → 按名字族（`resume-*`、`deck-*`）聚类；
   **同族满 3 个就长出一个 `✦ 族名` 的新分组**
3. 落单的 → 留在「· 未归类」

不需要重跑构建，不需要重启，下一屏就看得到。

### 构建时（把临时分组固化成正式分类）

运行时的新分组是每次启动重算的临时组。想让它变成一等公民：

```bash
node promote.mjs          # 报告：哪些名字族够格升格
node promote.mjs --apply  # 写进 taxonomy.local.json
node setup.mjs            # 并入索引与运行时规则
```

`taxonomy.local.json` 是你的私有扩展（已 gitignore）：

```json
{ "categories": [
  { "id": "x-resume", "label": "简历", "glyph": "✦", "order": 910,
    "keywords": ["resume", "简历"], "skills": ["resume-writer"] }
] }
```

`build.mjs` 用它参与分类，`pack.mjs` 把它的关键词带进运行时规则 ——
所以固化之后，**以后再装同类技能也会自动进这个类**。

### 边界

- 运行时临时组用名字族当标签，语义不准时得靠 `promote --apply` 后手工改 label
- 新类只影响你自己的机器（`taxonomy.local.json` 不进仓库）
- 内置 10 类的规则仍然是产品自带的，改它们要改 `taxonomy.mjs`
## 装完技能要重启 DSH 吗

不用。分三种情况：

| 改了什么 | 要做什么 |
|---|---|
| **装 / 删技能** | 什么都不用做 —— 关掉 `/` 再按一次就能看到 |
| 改插件客户端 `lib/client.js` | `Ctrl+R` 重载渲染进程 |
| 改插件宿主半 `lib/index.js` | 重启 DSH（只有这一种需要） |

### 为什么装技能能立刻生效

**两层，缺一不可。**

**宿主侧**：`@deepseek-ai/dsh-skill-filesystem` 用 chokidar 盯着
`~/.agents/skills`（`watch: true`，`depth: 1`），增删触发 `control.invalidate`
→ 清掉 `collectCache`，下一次 RPC 就是新数据。

**渲染进程侧**：`@deepseek-ai/dsh-client-ui-skill` 把目录缓存在
`fetches: Map<sessionId, …>` 里，**一个会话只取一次**，只有换 preset 或重载页面
才会清。所以光靠宿主刷新，重开 `/` 看到的还是旧列表。

本插件绕过这一层：每次取目录都自己走同一条 RPC（`ctx.remote.skills.list`），
500ms 内复用、失败则退回内置缓存。这才是「装完立刻能看见」的真正原因。

插件再叠一层兜底：宿主半用 `fs.watch(recursive)` 盯同一个目录，
防 chokidar 漏事件（网络盘、事件队列溢出、关掉了 polling 的情况），
命中就调 `ctx.skills.invalidateCache()` + `notifyChange()`。

### 怎么确认它真的动了

宿主半会往日志里写：

```powershell
Get-Content "$env:USERPROFILE\.dsh\skill-categories-host.log" -Tail 20
```

装一个技能，几秒内会出现：

```
2026-11-03T...  watching C:\Users\You\.agents\skills
2026-11-03T...  invalidate #1  rename  new-skill
```

### 删技能也会同步

客户端每次取目录都会对账：已经不在磁盘上的技能会被撤掉计数与临时分组，
不会出现「删了但菜单数字还挂着」的情况。
## 原理

### 分类：14 个细分面 → 10 个展示类

分类不是关键词查表，是**加权打分**：

```
style  风格与审美   ui  界面实现   page 页面与转化
image  图像与素材   deck 演示与图示 motion 动效与动画
wechat 内容与运营   office 文档与办公
eng    工程与质量   flow 流程协作
career 求职与职业   review 评审         tools 工具集成
```

每个面有一组带权重的正则（中文词 + 英文短语），命中即累加；名称命中权重更高。得分低于阈值或并列无法仲裁时落 `misc`（菜单里显示为「· 未归类」）。

10 个展示类是**给人看的**，14 个细分面是**给算法用的**——两者分开，菜单不会被切成 14 段。

### 检索：本地重排 + 可选语义

`/` 菜单的候选由宿主内置的技能源提供（只有英文名模糊匹配）。插件把它包装一层：

- **别名通道**：每个技能 3–5 个中文入口词，命中得分高
- **名称通道**：完整名 > 前缀 > 包含
- **描述通道**：兜底
- **语义通道**（可选）：浏览器里跑 `bge-small-zh-v1.5`（512 维，量化约 30MB），首次使用从 CDN 下载，之后走缓存；只做「补充召回」，不改变既有顺序

语义层失败（断网、CSP、模型下载失败）会静默降级，检索照旧。

### 菜单：用宿主原生能力，不碰 DOM

- **分组标题**：候选项带 `section` 字段，宿主自己渲染 `.sectionTitle`
- **面包屑**：实现 `header` 钩子，宿主渲染成菜单顶部的可点条
- **分类跳转**：面包屑点击走宿主的 `drill` 通道，返回 `{ text: '/设计', continue: true }` 改写输入框

没有 monkey-patch，没有注入样式覆盖宿主布局。

## 修复记录

### 1.0.5 — 把验收固化进仓库

第三方复测 1.0.4 为 49/49 通过。本版没有改运行时逻辑，只把「每次生成后必须跑什么」固化下来：

| 新增 | 作用 |
|---|---|
| `pack.mjs` 生成期 lint | 产物若出现「注释吞掉声明」直接抛错，构建阶段拦住（1.0.3 那类回退不可能再发布） |
| `verify-host.mjs` | 宿主四类场景：正常 / 失效抛错 / 服务缺失 / 删除被监听目录，真实临时目录 + 独立子进程 |
| `verify-all.mjs` | 五组一起跑：分类体系、客户端、别名、检索、宿主；任一组失败即整体失败 |

```powershell
node pack.mjs        # 生成（含产物 lint 门禁）
node verify-all.mjs  # 发行前验收集
```

生成期 lint 的拦截实测：把 `var out = [];` 并回注释后执行 `node pack.mjs`：

```
Error: 产物 lint 失败：有语句被并进注释 ->  // 逐条向量化    var out = [];
```
### 1.0.4 — 第四轮复测修复（发行产物回退）

| 报告项 | 问题 | 修法 |
|---|---|---|
| 新回退 | 生成文件里 `var out = [];` 被并进上一行注释，建索引报 `index:out is not defined` | 恢复换行；`node --check` 查不出（注释后仍是合法 JS），因此加行级 lint |

新增两道防线（`verify-client` 67 → 75 条）：

1. **产物 lint**：检查「`//` 注释后紧跟 ≥2 个 tab 再跟关键字」的行，命中即失败。
2. **真跑建索引**：注入可控模型（`importLib` + `makePipe`），空缓存下断言
   `status=ready`、`indexed=N`、`error=null`、持久缓存带当前指纹且写入 N 条向量。

两条在注入回退后都会红（实测 7 条失败，报错与报告一致 `index:out is not defined`），
恢复后全绿。

**教训**：只做语法检查不够。发行产物必须在「空缓存 + 正常模型」下跑一次真实建索引。
### 1.0.3 — 第三轮复测修复

| 报告项 | 问题 | 修法 |
|---|---|---|
| 剩余问题 | 旧任务在「模型初始化」阶段失败，仍会把新索引改成 `unavailable` | 最外层 catch 补上代次检查：`if (stale()) return;` |
| 诊断观察 | 被取代的任务把 `index:superseded` 写进 `error`，新索引就绪后仍残留 | 改为独立计数 `superseded`；当前任务成功时清空 `error` |

新增自动化回归：`verify-client` 64 → 67 条，用可控钩子复刻
「旧任务初始化 pending → 换目录 → 旧任务才拒绝」的时序，验证新索引状态、
错误字段与代次都不被旧任务改写。该用例在去掉修复后确实会红（`loading → unavailable`）。
### 1.0.2 — 第二轮复测修复

| 报告项 | 问题 | 修法 |
|---|---|---|
| 问题 1 | subagent 分支 `return []`，宿主 `.then()` 直接 TypeError | 改成 `Promise.resolve([])` |
| 问题 2 | 旧索引任务可覆盖新索引并写错缓存 | 每个任务带代次 `gen` + 自身指纹，提交前校验；过期结果不写缓存 |
| 问题 3 | 指纹只比描述长度，同长度改写不刷新 | 指纹改存描述内容哈希，并纳入模型与向量化参数 |
| 问题 4 | 空目录时计数与索引停在旧状态 | 空目录也走协调：计数归零、指纹更新、索引作废；不启动模型加载 |
| 问题 5 | 回退路径覆盖「用户专用」提示 | 去掉正则改用 `indexOf`（模板会把 `\s` 吞成 `s`），并保留该前缀 |
| 版本 | 所有构建都叫 3.4.0 | 版本号带构建时刻：`1.0.2+20261103112140` |

回归用例：`verify-client` 58 → 64 条，新增「subagent 返回 Promise」「空目录归零」
「同长度改写换指纹」「回退保留用户专用」。
### 1.0.1 — 针对第三方测试报告的修复

| 报告项 | 问题 | 修法 |
|---|---|---|
| 优先 1 | 删技能后旧缓存把它补回来 | 空目录视为合法结果，不再回退；合并宿主结果时按当前目录取交集 |
| 优先 2 | 语义索引只看条数，换技能不重建 | 用「名字+描述长度+模型版本」做目录指纹，指纹变了索引作废 |
| 优先 3 | 语义模型卡住会阻塞精确搜索 | 语义改为按需取 + 250ms 预算；已精确命中时直接不等 |
| 优先 4 | watcher 缺少异步错误处理；日志假成功 | 注册 `error`/`close`；日志区分 ok / FAILED / SERVICE-MISSING |
| 优先 5 | 计数不随目录变化；同族只看本轮 | 计数一律由当前目录重算；同族从整个未归类池聚合 |

回归用例：`verify-client` 从 54 条增加到 58 条，新增
「空目录不回退」「已删技能不被补回」「合计等于目录条数」「跨轮累积成族」。
## 兼容性与已知限制

| 限制 | 说明 |
|---|---|
| **版本耦合** | 依赖 DSH 未公开的内部结构（`candidates` / `onPick` / `header` / profile 布局）。升级 DSH 可能失效 |
| **Windows 脚本** | `restart` 等辅助脚本仅 Windows；插件本身跨平台 |
| **首次 30MB 下载** | 语义层首次使用要下模型。离线环境自动降级 |
| **中文入口词是生成的** | 从名称、描述、家族词自动派生，不保证覆盖所有口语说法 |
| **索引是快照** | 装了新技能后要重跑 
ode setup.mjs，否则菜单里看不到它们。
ode doctor.mjs 会提示差了几个 |
| **分类准确率没有公开基准** | 只有本仓库的 49 条断言。真实效果取决于你的技能描述质量 |

## 开发

```
.
├── setup.mjs           一条命令：发现环境 → 生成 → 安装
├── doctor.mjs          只读诊断
├── paths.mjs           所有路径推导（仓库里没有写死的机器路径）
├── taxonomy.mjs        14 个细分面 + 加权规则
├── display.mjs         13 → 9 的展示类映射
├── asar-skills.mjs     解析 app.asar 拿内置技能
├── ingest.mjs          扫描技能根，产出 inventory.json
├── aliases.mjs         生成中文入口词，产出 aliases.json
├── build.mjs           分类 + 建索引，产出 index.json
├── pack.mjs            生成客户端插件
├── install.mjs         挂进 profile
├── rollback.mjs        撤销
└── verify-*.mjs        测试
```

**数据流**：

```
app.asar ─┐
          ├→ inventory.json → aliases.json → index.json → client.js
~/.agents/skills ─┘
```

`index.json` 之类的产物**不进仓库**——每个人的技能库不同，必须本地生成。

### 测试

```bash
node verify-taxonomy.mjs   # 33 条：分类规则（纯离线，CI 跑这个）
node verify-client.mjs     # 42 条：客户端行为（需要先生成 index）
node verify-names.mjs      # 14 条：完整名称排序
node verify-query.mjs      # 30 条中文查询
```

## 设计取舍（写给想改的人）

- **为什么不做成 skill 的 frontmatter 字段**：内置技能在只读 asar 里，且升级会覆盖用户改动。用旁路索引。
- **为什么包装内置源而不是注册新源**：`registerSource` 拒绝重复的 `(trigger, name)`，而 `/` + `skill` 已被占用。
- **为什么语义层只补召回不重排**：实测语义 top3 只有约 6/10，让它推翻别名排序会伤害确定性。
- **为什么面包屑不是真·两级菜单**：宿主的 `drill` 会在点击后关闭菜单，没有「下钻后自动重开」的路径。

## License

MIT
