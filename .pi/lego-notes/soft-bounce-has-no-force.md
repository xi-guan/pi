---
name: soft-bounce-has-no-force
status: rejected
date: 2026-08-20
triggers: [soft bounce, 软打回, hard block, 硬拦, review fail, advisory, semantic dedup, 语义查重, semantic signal]
summary: Hard blocks change model behavior while soft bounces do not, and semantic signals are too unreliable to be trusted with hard-block power, so semantic dedup can only ride the soft path and is a dead end by design rather than a tuning problem.
---

## 试了什么
lego 有两条干预路径: 3a 在 edit/write 执行前按名字相似度**硬拦** (block, 工具根本不跑);
3b 是 LLM 复审, FAIL 时只往 tool result 后面追加一段"请重写这块砖"的提示 —— **软打回**,
模型可以无视。语义查重信号 (L2 共享 callee、已删的 L3 embedding) 按设计只喂 3b。

## 实测: 本仓库 12 次真实 run 的 metrics
```
                blocked  reuse  reviewFail  semanticFlags
07-05 18:59        0       1        0         0
07-05 19:03        1       2        1         0
07-06 07:59        3       1        1         0
07-06 10:51        0       0        1         3   ← 头号嫌疑是反向函数, 判错
07-09 09:02        2       0        1         1
07-09 09:07        0       0        1         2
07-09 09:34        0       0        1         2
07-09 09:06        2       2        0         0
08-04 13:05        2       2        0         0
```
- 语义层响过 4 次 (semanticFlags 非空), 这 4 次的 reusedCalls **全是 0**。每次 3b 都判了
  FAIL, 每次模型都没改代码 —— 有一次模型还加了段注释解释自己为什么不听, 代码原样
- 真正发生复用的几次语义层全程沉默, 全是 3a 名字硬拦的功劳 (两个 helper 被拦 → 模型改 import 复用, reusedCalls=2)

## 为什么是死结
硬拦改变模型行为, 软打回不改变。而语义信号判不出两个 function 的功能是否 overlap (见
no-reliable-function-overlap-detection), precision 不够, 不敢给它硬拦的权力, 只能走软
打回这条路。这是设计上的死结, 不是调参能解决的。

## 重试前必须先改变什么
- 要么把语义信号的 precision 做到敢直接硬拦 —— 前提是先解决 function overlap 判定
- 要么承认 3b 的 FAIL 只是给人看的 advisory, 不要指望它改变模型行为
