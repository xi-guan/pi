---
name: no-reliable-function-overlap-detection
status: rejected
date: 2026-08-20
triggers: [embedding, cosine, semantic dedup, 语义查重, similarity, overlap, z-score, nomic-embed, bge-m3, vector]
summary: There is no reliable way to decide whether two functions overlap in behavior, so the whole class of semantic-dedup approaches (embeddings, cosine ranking, z-score calibration) is blocked at the root rather than by any single technique.
---

## 试了什么
lego 曾有一层 L3 语义查重: 把仓库 function 体做 embedding (自建 bge-m3 HTTP 服务,
`.pi/lego-embeddings.json` ~80MB), 新函数取余弦 top-1 近邻当"疑似重复"喂给 3b 复审。
2026-08-04 整层删除。

## 为什么否掉
根因: **没有可靠的办法判断两个 function 的功能是否 overlap。** 这堵死的是整类语义查重
方案, 不只是 embedding 这一种技术 —— 相似度只测得出表面形状, 测不出行为等价。

- **绝对余弦阈值不可用**: 代码向量全挤在 ~0.7-0.8 的窄锥内, 分不开
- **相对 z-score 只在人造样本上成立**: 校准集 (2026-07-06) = 60 个真实函数 + 5 个手写
  换名重复 + 2 个全新对照; 重复 top1 z 3.36-4.58 且全部 rank=1, 全新对照 z ≤ 2.28,
  于是阈值定成 z ≥ 3.0 且 cosine ≥ 0.85
- **margin 规则不可用**: 仓库存在完全相同的拷贝时 top1/top2 差值 margin = 0 (实例
  `updateLabelCache` ×2), 靠 margin 判"够不够突出"会把真重复判成不确定
- **互逆函数完全分不清**: `fixLineEndings` 对 `normalizeToLF` (统一成 LF) 与
  `restoreLineEndings` (还原) 的 cosine 都是 0.919, 07-06 那次逆函数 0.926 反而排在
  正确答案 0.889 之前 —— "做 X" 和 "撤销 X" 在向量空间里几乎重合
- **线上战绩**: 12 次真实 run 里语义层只响过 4 次, 其中 2 次头号嫌疑就是反向函数

## 重试前必须先改变什么
1. 解决互逆函数分不清 —— 不解决, 语义信号永远不敢拿硬拦的权力
2. 软打回没有强制力, 见 soft-bounce-has-no-force
3. 阈值必须重新标定: z ≥ 3.0 是对 bge-m3 调的, 换模型后分布完全不同

## 现成资产
codebase-memory-mcp 索引库里仍有 6564 条 `nomic-embed-code` 向量 (768 维 int8, 编译进
binary, 不需要 API key)。真要重做 L3 用它, 别再自建 HTTP 后端 —— 但 int8 量化后分布
不同, 阈值必须重标。
