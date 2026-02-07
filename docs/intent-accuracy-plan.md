# Intent 识别准确率提升方案（不牺牲自然语言）

## 目标
- 提升意图识别准确率与稳定性
- 保留自然语言输入的自由度
- 降低误判与无意义触发
- 对不确定场景优先澄清而非硬判

## 核心原则
1) 输入保持自然语言，解析输出必须结构化  
2) 置信度驱动：高置信度执行，低置信度澄清或拒绝  
3) 澄清优先：宁可多问一次，不要误判  
4) 上下文利用：reply_text 与会话上下文优先于关键词  
5) 误判闭环：真实线上样本驱动迭代  

## 指标与闭环（必须先做）
**核心指标**
- intent_accuracy：命中率（人工抽检或回访确认）
- clarify_rate：澄清率
- false_positive：误触发率
- unknown_rate：拒绝率
- latency_ms：响应耗时

**日志字段（最小集合）**
- raw_query / reply_text
- channel / is_group / is_reply / mention_bot
- resolved_intent / confidence / need_clarify / reason / unknown_reason
- decision（accept/clarify/unknown）
- followup（用户是否继续补充、纠正、沉默）

## 意图边界清单
- 为每个 intent 明确三类规则：
  - 必须条件（必填参数/前置条件）
  - 排除条件（容易混淆的语义场景）
  - 澄清条件（不满足必须条件、或歧义）
- 示例：  
  - `news_summary`：必须有 reply_text；否则直接澄清  
  - `alert_explain`：必须回复告警内容；否则澄清  
  - `news_hot`：无需 reply_text，但不允许在缺少触发入口的群聊场景被解析  

## 结构化输出契约
解析器输出固定字段：
```
{
  intent: string,
  params: object,
  confidence: number,
  need_clarify: boolean,
  reason: string,
  unknown_reason: string
}
```
字段语义：
- `confidence`：0~1 置信度
- `need_clarify`：是否需要澄清
- `unknown_reason`：low_confidence / ambiguous / out_of_scope / parse_error / policy_block

## 置信度策略（默认建议）
- `T_high = 0.75`：直接执行
- `T_low = 0.45`：低于此阈值直接 unknown
- 介于区间：返回澄清

> 阈值可按真实数据迭代调优，但不要用“关键词强制命中”来替代。

## 澄清策略
- 一次只问一个问题
- 只问必要信息（意图或参数二选一）
- 对明显冲突的语义，优先澄清而非猜测

示例：
- “你要查询热点新闻，还是要摘要当前回复的新闻？”

## Prompt 与负样本策略
- 在 LLM prompt 中加入：
  - 正样本
  - 易混淆样本
  - 必须返回 unknown 的样本
- 强化 reply_text 的作用（如：摘要/解释必须依赖 reply_text）
- 明确禁止“猜测式解析”

## 影子验证与灰度
**影子阶段**
- 与现有规则并行执行
- 只记录日志，不影响用户体验

**灰度阶段**
- 逐步放量（10% → 30% → 100%）
- 重点监控 false_positive 与 clarify_rate

## 实施顺序（建议）
1) 加日志与指标闭环  
2) 意图边界清单落地  
3) 更新 LLM 解析 prompt  
4) 置信度策略上线  
5) 影子验证 → 灰度  

## 验收标准（最低要求）
- 命中率提升且误判率下降  
- 澄清率可控（不过度打扰）  
- 无自然语言输入限制新增  

## 备注
- 命令仅作为触发入口，不替代自然语言解析  
- 真正提升准确率的关键是 **真实误判样本闭环**
