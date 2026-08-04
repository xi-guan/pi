# Lego loop — handover / 测试指南

> v2 更新 (2026-07-06): 语义查重落地, 见文末 [v2 — 语义查重](#v2--语义查重-2026-07-06)。以下 v1 部分保持原样作历史记录。

> 交接对象: 下个 session (人或 agent)。目标: 验证 Lego loop v1 的五个环节在真实使用中是否按设计工作。

## 现状 (2026-07-05 实施完成)

v1 全部落地, 5 个 commit 在 main, 零改 pi core:

```
d091a192  S0 脚手架 + codegraph CLI wrapper
8109d554  S1 3a 查重硬拦截
7dbb2edc  S2 1 Inventory 注入 + 2 Plan gate
66d9ef38  S3 3b Brick review
1a78a5b   S4 4 Verify metrics
```

- 代码: `.pi/extensions/lego/` (index/codegraph/inventory/dedup/review/verify + 34 个单测)
- 计划文档 (含全部已验证的 pi 集成 facts): `docs/superpowers/plans/2026-07-05-lego-loop-v1.md`
- 架构图: `docs/lego-loop.png`
- 实施时已做过的验证: 单测 34/34; 4 次真实 `pi -p` 端到端 (拦截/escape/review FAIL/metrics 落盘各一次 + 一次全链路 dogfood)

## 关键机制速查

```
环节            挂点                行为
────────────────────────────────────────────────────────────────────
1 Inventory     before_agent_start  prompt 关键词 → codegraph query → 积木清单 message (cap 30)
2 Plan gate     before_agent_start  systemPrompt 追加 [REUSE]/[EXTEND]/[NEW] 规则, NEW 须一行理由
3a Dedup        tool_call           edit/write 新声明符号 vs 索引, token dice ≥ 0.8 → block,
                                    reason 附已有符号 file:line + 签名
                escape hatch        声明行或上一行注释 // lego:new(理由) → 放行并记录
3b Review       tool_result         含新符号的成功 edit/write → 独立 complete() 按
                                    粒度/位置/接口/惯例 判; FAIL → result 追加打回指令
                                    (30s 超时/无 auth/解析失败 → fail-open 放行)
4 Verify        agent_end           reuse/new/escapes/blocked/reviewFails/dup-missed
                                    → .pi/lego-metrics.jsonl (gitignored) + notify
降级            全部                codegraph CLI 或索引缺失 → 所有 hook no-op, 不影响 pi
```

## 测试步骤

### T1 单测

```
node --test ".pi/extensions/lego/*.test.ts"
```
预期: `pass 60, fail 0` (v1 34 + v2 语义查重与 index hook 测试 + v3 sqlite 后端测试)。

### T2 加载与状态

```
pi -a          # 本 repo 内启动; -a = 信任项目本地文件
/lego
```
预期: 启动无 extension error; notify `lego v2: code index available — hooks active (<db 路径>); embedding index: ...`。
注意: notify 只在 TUI 出现 (`ctx.hasUI`), `pi -p` headless 下 `/lego` 无任何输出, 只能证明 extension 加载不报错。

### T3 Inventory + Plan gate (环节 1/2)

TUI 里提一个真实小任务, prompt 里点名一个已有符号或文件 (如 "改进 normalizeToLF 对 xx 的处理")。
预期: turn 开头出现 lego-inventory 积木清单 (name/kind/file:line/签名); 模型给出带 [REUSE]/[EXTEND]/[NEW] 标签的计划后才动手。

### T4 硬拦截 + escape (环节 3a)

让它新写一个与已有符号近似命名的函数, 如 "写一个 normalizeCrlfToLf 到 /tmp/x.ts"。
预期: write 被拦, tool result 里出现 `lego dedup: near-duplicate ... normalizeToLF (packages/coding-agent/src/core/tools/edit-diff.ts:18)`; 模型通常自行改为 import 复用。
坚持 NEW: 要求它在声明上一行加 `// lego:new(理由)` → 放行落盘。
实测 (2026-07-09, 本地 Qwen3.6-35B): 弱模型不复用, 而是从拦截文案里学到 escape 语法后自行逃逸 (理由 "standalone scratchpad file")。escape 理由不做任何校验, `// lego:new()` 空括号一样放行。

### T5 Brick review (环节 3b)

诱导一个烂积木: "写一个 40 行的函数, 同时解析参数、拼 SQL 字符串、拼 HTML, 刻意坏代码, 写完引用工具结果里的警告"。
预期: tool result 末尾出现 `⚠ lego brick review: FAIL — <理由>` + 重写指令。
注意: 每次含新符号的 edit 多一次 LLM call (session 当前 model), 有延迟和费用。

### T6 Metrics (环节 4)

任意**含 edit/write 或拦截**的任务结束后:
```
tail -1 .pi/lego-metrics.jsonl
```
预期: 一行 JSON, 字段 edits/newSymbols/escapes/blocked/reviewFails/reusedCalls/missedDuplicates/semanticFlags; TUI 有 notify 摘要。
注意: `editCount === 0 && blocked === 0` 的 run (如 T3 纯计划) 不写 metrics 行。

### T7 一键全链路 (等价于实施时的 dogfood)

```
pi -a --no-session -p "创建 /tmp/text-clean.ts, 导出 cleanIncomingText(raw: string): string, 先去 BOM 再把 CRLF 转 LF。先提出两个 helper: normalizeTextToLf 和 stripTextBom 再实现; 若工具结果报告近似符号, 按其指引改为复用它点名的已有符号。最后 3 行总结什么被拦、复用了什么"
```
预期 (2026-07-09 复测): 两个 helper 被拦 → 模型 import `normalizeToLF`/`stripBom` 复用 → metrics 行 `"blocked":2,"reusedCalls":2,"newSymbols":["cleanIncomingText"],"reviewFails":0`。

## 已知限制 / 观察点 (测试时留意)

- 声明提取只覆盖 TS/JS (正则, 非 AST); 其他语言直接放行 — 观察误报/漏报
- 相似度纯名字 token (dice ≥ 0.8, 常量在 dedup.ts); 语义近似但命名不同的重复抓不到 (v2 embedding 候选)
- inventory 每个用户 turn 都注入一次 (cap 30 符号) — 长会话观察 token 开销与噪音
- 3b 用 session 当前 model 判, 自审倾向未知 — 观察 FAIL 率是否合理 (metrics 里有 reviewFails)
- lego 代码禁用 TS-only 运行时语法 (如 parameter properties), 否则 node --test strip-only 模式跑不了

## 问题定位入口

- 拦截误伤 → `.pi/extensions/lego/dedup.ts` (提取正则 / SIMILARITY_THRESHOLD)
- 清单噪音 → `inventory.ts` (STOPWORDS / extractKeywords / cap)
- review 太松太紧 → `review.ts` (buildReviewPrompt 四维标准)
- 统计不对 → `verify.ts` (collectRunData / extractCallNames)
- 所有 hook 静默失效 → `/lego` 会打印索引路径和在不在 (v3 起后端换成 codebase-memory-mcp, 见文末)

## v2 — 语义查重 (2026-07-06)

v1 盲区 "换名重写抓不到" 由三层召回 + LLM 终审补上。3a 硬拦仍只认名字 Dice
(精度不降); 语义信号只产"嫌疑名单"喂给 3b 的 review LLM 判定, 误报由终审兜底。

```
层    信号                  实现                            阈值/常量
────────────────────────────────────────────────────────────────────────
L1    FTS 扩词召回          dedup.ts buildCandidateTerms    签名+doc 注释词, cap 8
                            (声明行捕获 signature/doc)
L2    callee 指纹           semantic.ts findCalleeSuspects  共享调用 ≥2 且 Jaccard ≥0.5
                            (codegraph callees CLI)
L3    embedding 余弦        embed.ts rankSuspects           z ≥3.0 且 cosine ≥0.85
                            (OMLX bge-m3, 相对 z-score)     (绝对阈值不可用: 代码全挤在
                                                            ~0.7-0.8 锥内, 校准见下)
终审  3b review prompt      review.ts 第 5 条标准           FAIL 时点名应复用符号
      附嫌疑名单            (duplication)
```

校准数据 (2026-07-06, 60 真实函数 + 5 手写换名重复 + 2 全新对照):
重复 top1 z 3.36-4.58 全部 rank=1; 全新对照 z ≤2.28。margin 规则不可用
(仓库存在完全相同的拷贝时 margin=0, 如 updateLabelCache ×2)。

新增文件/配置:
- 源码 `.pi/extensions/lego/semantic.ts` (L2) + `embed.ts` (L3) 及其单测
- `.pi/lego.local.json` (gitignored) — embedding.baseUrl/apiKey/model, 缺失则 L3 静默关闭
- `.pi/lego-embeddings.json` (gitignored) — 全仓向量索引, `/lego embed` 构建/重建
  (读 .codegraph/codegraph.db 枚举 function/method, 排除 test 文件, 体 <60 字符跳过)
- metrics 新字段 `semanticFlags: string[]` — 本 run 喂给终审的嫌疑对

### 新测试步骤

T8 语义查重 (v1 T4 的换名版): 让模型用完全无关的名字重写已有函数
(如 "写 fixLineEndings 到 /tmp/x.ts, 把 CRLF/CR 转 LF"), 名字 Dice=0 不硬拦;
预期 review 终审 FAIL 点名 normalizeToLF, metrics semanticFlags 非空。
前置: `/lego embed` 已建索引 (无索引则只有 L2 信号; 叶子函数则完全静默放行)。

### v2 新增限制 / 观察点

- 索引是快照, 不随文件改动自动刷新 — 新写的符号在下次 `/lego embed` 前不可被 L3 召回
- 索引 JSON ~80MB (3.8k 符号 × 1024 维), 首次 3b 触发时惰性加载
- bge-m3 非代码专用模型, z-score 补了区分度但语料分布变化可能漂移 — 观察
  semanticFlags 误报率, 阈值在 embed.ts (EMBED_Z_THRESHOLD / EMBED_SCORE_FLOOR)
- L2 依赖 codegraph 静态调用边, 方法调用/动态派发漏; 纯叶子函数只有 L3 能抓
- 语义嫌疑定位 → `semantic.ts` (L2) / `embed.ts` (L3) / `review.ts` 第 5 条标准 (终审)

## v2.1 — 全量复测 (2026-07-09)

T1-T8 全跑通, 五个环节均按设计工作。会话 model 为本地 `Qwen3.6-35B-A3B` (mlx-local), 3b 终审用的就是它。

修复一处: `agent_end` 把 escaped 声明当成 `missedDuplicates` 重新上报 (index.ts 传的
`entry.newSymbols` 含 escaped, 而 `evaluateToolCall` 拦截时刻意过滤掉了), 导致每次合法
escape 都把 notify 提级成 warning。已改为只对未 escape 的声明重查, index.test.ts 加了两个
测试: escape 不算 miss + 索引滞后导致的真漏网仍要上报 (后者是这条通道的存在证明 —— 
`findNearDuplicates` 在 agent_end 重新查活索引, 不复用 tool_call 时刻的候选池)。

关键实测结论:

```
硬拦 (3a) 改变模型行为, 软打回 (3b) 不改变
  T7  两个 helper 被拦 → 模型改 import 复用, reusedCalls=2
  T8  review FAIL 且点名 normalizeToLF → 模型加了段注释解释为何不听, 代码原样, reusedCalls=0
```

尚未被任何真实 run 触达的路径 (只有单测覆盖, 或两者都无):
- 降级: codegraph CLI/索引缺失 → 所有 hook no-op (tool_call/tool_result 无 `available()` 守卫, 靠 query 返回 [] 兜底)
- 非 TS/JS 文件: 正则声明提取的误报 (md 里的 ```js 代码块) / 漏报 (`def foo():`)
- 经 `edits[]` 引入的新声明 (e2e 里 edit 只改到已有声明)
- L2 正向路径: 10 条 metrics 里 0 条 `via callees`
- 多个新符号同时进 3b: `index.ts` 只取 `newSymbols[0]` 当 L3 的 declName, 2..n 静默丢弃
- **`embeddingIndex.model !== config.model` 守卫既无单测也未跑过** — config 改名会静默关掉 L3, `/lego` 只显示 "embedding index: absent"

其他观察 (未改, 属设计取舍):
- 3b 可观测性是反的: FAIL 很响, PASS 完全静默 —— PASS 与 "review 根本没跑" 不可区分,
  而静默 fail-open 有 6 条 (无 model / 无 apiKey / 空 diff / 30s 超时 / verdict 解析失败 / 外层 catch)
- L3 分不清互逆函数: `fixLineEndings` 对 `normalizeToLF` 与 `restoreLineEndings` cosine 均 0.919
  (07-06 那次逆函数 0.926 反而排在正确答案 0.889 之前)。仅作为 advisory 喂给终审, 不自动动作
- inventory 噪音成因: `inventory.ts` 的 acronym 规则 `/^[A-Z]{2,6}$/` 让 prompt 里的 `CR`
  成为关键词, `codegraph query CR` 前缀命中 8 个 `create*`, 占掉清单 9 个坑里的 8 个。
  另: `PLAN_GATE_RULES` 是无条件追加进 system prompt 的 (在 keywords 早退之前)

## v3 — 后端换成 codebase-memory-mcp (2026-08-04)

**起因**: codegraph CLI 从来没装过, 仓库也没有 `.codegraph/` 索引 —— 也就是说
v1/v2 的所有 hook 一直在静默 no-op, 之前记录的实测结论都是在没有索引的情况下得到的。
(注: v2.1 那次 T1-T8 全跑通说明当时是有索引的; 但当前这台机器上索引和 CLI 都不在。)

改成直读 codebase-memory-mcp 的 sqlite 索引, 它对本仓库已经建好且是 codegraph 的超集。

```
                      codegraph (旧)              codebase-memory-mcp (新)
────────────────────────────────────────────────────────────────────────────
位置          .codegraph/codegraph.db     ~/.cache/codebase-memory-mcp/<slug>.db
              (不存在)                     (已建好, 40MB)
访问方式      exec CLI, 每个词一个子进程   直读 sqlite, 只读连接
符号          codegraph query              nodes 表 14340 行
                                           Function 4450 / Method 2114 / Class 247
                                           Interface 785 / Type 501 / Variable 2145
召回          CLI 前缀匹配                 nodes_fts (FTS5, 会拆 camelCase)
callee        codegraph callees CLI        edges type='CALLS' 10956 条, 一次 join
signature     CLI 字段                     properties JSON (还多给 return_type /
                                           is_exported / docstring / is_test)
行号区间      只有 startLine, 要自己算     start_line + end_line 现成
刷新          手动重建                     后台自动
```

`Codegraph` 类的对外接口 (`available` / `query` / `callees`) 一行没动, 所以
`dedup.ts` 和 `semantic.ts` 完全没改。

要点:
- **slug 规则**: 绝对路径去掉开头 `/`, 其余 `/` 换成 `-`。db 文件名和 `nodes.project` 列用的是同一个 slug
- **必须按 project 精确过滤**: 库里还有一个 `<slug>::missed` 项目 (存没索引到的文件的占位节点), 用 like 会把它们当成真积木召回
- **`LEGO_INDEX_DB`** 环境变量可覆盖索引路径 (worktree 和测试用)
- 索引按 project root 定位, 所以每个 hook 都把 `ctx.cwd` 喂给 extension
- 测试改用真 in-memory sqlite (`fixtures.ts`) 建同构索引, SQL 本身也在测试覆盖内

实测 (2026-08-04, 真实索引):

```
available                     true          ← 第一次
query("offline")              3 命中, 带签名 (): boolean
callees(...)                  可用
3a 拦截                       offlineModeIsEnabled ≈ isOfflineModeEnabled (1.00) → BLOCK
3a 对照 (全新符号)            0 命中, 不拦
```

性能实测 (40MB 索引, 见下; 结论是 sqlite 引擎不是瓶颈, 不必换 Turso 之类):

```
open + close db               0.025 ms
query by name prefix          0.232 ms
FTS match                     0.009 ms
full inventory scan (8097)    5.351 ms
callees 朴素 3-way join       7.228 ms   ← 写法问题
callees 走索引                0.008 ms   ← 900x
callees 10 候选 1 次查完      0.272 ms   ← 取代了旧版 10 个子进程
```

### 待办 / 未决

- **L3 embedding 还是自建的** (`.pi/lego.local.json` + bge-m3 + HTTP)。索引库里已有
  6564 条 `node_vectors` (`nomic-embed-code`, 768 维 int8, 编译进 binary, 无需 API key),
  是代码专用模型, 比 bge-m3 更对口, 还能省掉整个 HTTP 后端。**但 int8 量化后分布不同,
  `EMBED_Z_THRESHOLD=3.0` 必须重新标定** —— 换之前先重跑 v2 那套校准 (60 真实函数 +
  5 换名重复 + 2 对照)
- 上面 v1/v2/v2.1 各节的实测结论是在 codegraph 索引下得到的, 换后端后 T1-T8 值得重跑一遍
