# 分类依据 v1

> 这份文档是**唯一约定**。菜单里看到的每一个数字、每一条技能落在哪一类，
> 都必须能在这里找到依据；`verify-consistency.mjs` 会逐条核对它和产物是否一致。
> 改了这里的任何一条，都算改分类依据，必须同时改 `taxonomy.mjs` 并让全部验收集转绿。

---

## 1. 唯一真源

```
技能文件（SKILL.md frontmatter）
        │  ingest / asar 扫描
        ▼
   index.json  ←── 唯一真源（每条技能的 category 就是最终答案）
        │  pack 烘焙
        ▼
 client.js 里的 MAP / CATCOUNT / TOTAL          ← 菜单照抄，不重新判断
        │  运行期只处理「索引里没有的新技能」
        ▼
   RULES 表现场判定 → 落类 / 落未归类
```

三条推论，也是三条铁律：

1. **索引内技能，菜单一律照抄** `MAP[name]`，不用运行期规则重算。
   所以「装完看到的位置」和「重新建索引后的位置」不会不一致。
2. **索引外的新技能**，用与构建期同一份 `RULES` 现场判定；下次重建时被固化进索引，
   判定结果应当与当时看到的一致（`verify-consistency` 的第 5 条断言守这个）。
3. **构建期专用裁决只有两种**：人工覆盖（`curated.json`，`tier=manual`）与
   同族聚合（`tier=family`）。它们无法在运行期复现，所以重建后允许变化——
   但必须在索引里标明 tier，且不影响其余技能。

## 2. 输入

| 字段 | 来源 | 说明 |
|---|---|---|
| `name` | 技能目录名 | 连字符换成空格后参与匹配（`web-design-engineer` → `web design engineer`） |
| `desc` | SKILL.md `description` | **原文，不截断**。DSH 侧同样不截断，两边必须一致 |

只看这两个字段。不看正文、不看文件路径、不看安装时间、不看谁先装的。

## 3. 打分（每个细分面 facet 各算一次）

```
score(facet) = Σ strongName 命中      → +26
             + Σ 规则命中 desc        → +w
             + Σ 规则命中 name(空格版) → +w × 1.6
```

- `strongName`：命名前缀直接声明家族（如 `^ios-`、`deck-`），命中即 +26，通常一击定音。
- 普通规则：中英各一套（`TAXONOMY[].rules` + `EN_RULES`），权重 `w` 写在规则里。
- **name 命中权重 ×1.6**：同样的词出现在名字里比出现在描述里更能代表这个技能。
- 参数常量只在 `taxonomy.mjs` 里定义：`MIN_SCORE = 3`、`NAME_BOOST = 1.6`、`STRONG_NAME_BONUS = 26`，
  bundle 里烘焙进 `RSCORE`，两边必须相等（断言 7 守）。

## 4. 判定

```
top = 分数最高的 facet
若 top.score >= 3  → 判给 top（同分时按 TAXONOMY 声明顺序取先者）
否则               → misc（未归类）
```

## 5. 展示类映射

细分面 14 个 → 展示类 10 个 + 未归类。映射表在 `display.mjs` 的 `FACET_TO_DISPLAY`：

| 展示类 | 收纳的细分面 |
|---|---|
| 设计与视觉 `style` | style、ui |
| 页面与转化 `page` | page |
| 图像与素材 `image` | image |
| 演示与图示 `deck` | deck |
| 动效与动画 `motion` | motion |
| 求职与职业 `career` | career |
| 内容与运营 `content` | wechat、research |
| 文档与办公 `doc` | office |
| 工程与质量 `eng` | eng、flow |
| 评审与工具 `review-tool` | review、tools |
| 未归类 `misc` | 规则无命中 |

## 6. 同族聚合（构建期）

一整套引擎/平台技能（`unity-*`、`godot-*`）常被通用词打散到多个类。判定成族要**同时**满足：

1. 同前缀成员数 ≥ 5（库内技能 < 60 条时降为 3）；
2. 前缀本身不是一条技能名（`design-*` 的 `design` 是共用词，不是生态）；
3. 这些成员原本落在 ≥ 2 个不同的类（说明规则没有共识）；
4. 低置信成员（`tier=low` 或 `score < 6`）占多数（≥ 60%）。

成族后整族钉成一个临时类 `dyn-<prefix>`，标签 `✦ <prefix>`，排在所有固定类之后。
人工覆盖的技能不参与成族。

## 7. 计数口径

```
TOTAL   = 目录里出现的所有技能条数
CATCOUNT[c] = 该展示类的条数          （含 misc）
Σ CATCOUNT === TOTAL === index.skills.length
```

**为什么不是「只数用户能点的」**：列表本身会把隐藏技能（`user-invocable: false`，
只允许模型调用）也渲染出来。只数可见的就会出现「评审 19」但下面列了 21 行。
口径必须和渲染面一致——用户会数行数。

## 8. 三个数字的对应关系

| 界面元素 | 数据来源 | 断言 |
|---|---|---|
| 芯片 `设计 23` | `CATCOUNT.design` | 断言 3 |
| 分组头 `设计与视觉 · 23` | 同 `CATCOUNT`（`syncCrumbs` 就地同步） | verify-client |
| 面包屑 `全部 154` | `TOTAL` | 断言 4 |
| 列表行数 | 目录里的实际条目 | 断言 4（行数 == TOTAL） |

## 9. 刷新与缓存

- 技能目录变化 → 宿主监听作废缓存 → 客户端每次开菜单重新取目录（500ms TTL）。
- 装/删技能**不需要重启**；改插件代码需要重启。
- 语义索引按 `catalogFingerprint`（名字 + 描述长度 + 模型）失效重建。

## 10. 一致性闸门

`node verify-consistency.mjs` 九条断言，任一条红即视为「用户看到的东西会和测试不符」：

1. MAP 键集合 == 索引技能名集合
2. `MAP[name] === index.category`（逐条）
3. `CATCOUNT` 各项 == 按 `category` 统计的条数（含 misc）
4. `TOTAL == index.skills.length == ΣCATCOUNT`
5. 用 bundle 里的 `RULES`/`RSCORE`/`F2D` 现场重算每条技能 == `index.category`
6. 索引里出现的每个 facet 都有运行期规则（misc 与 `dyn-*` 除外）
7. 索引里出现的每个 facet 都能映射到展示类
8. `CATCOUNT` 里出现的类都能在 `CATS` 找到
9. `RSCORE` 与 `taxonomy.mjs` 的三个常量相等

空目录、未知技能、删除技能这些动态场景由 `verify-client` 与 `verify-fixture` 覆盖。

## 11. 变更流程

改分类依据 = 改这份文档 + 改 `taxonomy.mjs` + 重跑 `node setup.mjs --skip-asar --no-install`
+ `node verify-all.mjs` 全绿 + 重启 DSH 让新 bundle 生效。

只改 bundle 不改 index、或只改 index 不改 bundle，都会被断言 1–2 拦下。
