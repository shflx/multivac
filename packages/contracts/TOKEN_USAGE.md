# 设置 · 统计的数据契约

呈现基准是 prototypes@d52053a85bba2bc385e79bfb624978afda801436 的 prototypes/app.jsx 中 UsageSettings（5012 行起）、prototypes/usage-stats.js。只提供近7/30/90天，默认30天；总览四格、每日柱图、模型/项目/来源分布、Top5依次排列。禁止复制 seedUsageRecords、费用、项目筛选、导出或预算入口。原型的模拟汇总不能证明真实 SDK 的缓存语义。

## 权威来源与单位

每次 ModelRuntime 的 stream/streamSimple/complete/completeSimple 终态 AssistantMessage.usage 是采集来源，覆盖协调、工作会话、任务、重试与压缩。用户发送数、turn_end、TaskRun 数及 CoordinatorRunResult.usage 均不能替代请求数量或累计。当前 pi-event-mapper 的 lastUsage 只是最后一次响应。

适配 Pi 0.85.1 已暴露的 input/output/cacheRead/cacheWrite/totalTokens 字段，不依赖费用。仅接收非负安全整数，且 input+cacheRead+cacheWrite+output 必须等于 totalTokens；不符合分解关系时标记无法确定用量，不推测差值。推理字段存在时须为安全整数且不超过 output，独立保存供核对，不再相加。现有执行环境未提供已安装 SDK 源码，无法宣称逐 provider 语义验证已完成；字段关系检查是保守兼容门槛，异常明确列为缺失。provider 未给出字段而 SDK 填充零的失败/取消响应不能证明真实零用量，整组为零时标为缺失。

显示的非缓存输入 = input+cacheWrite；缓存命中 = cacheRead；显示输出 = output（含推理）；总量 = 三段之和。缓存写入属于输入，不能既加到输入又再加到总量。输入总览 = 非缓存输入+缓存命中。命中率 = cacheRead/(非缓存输入+cacheRead)，分母为零时 null。保留 raw 字段，不持久费用、正文、凭据。

例如 input=100、cacheWrite=20、cacheRead=80、output=40、reasoning=10、totalTokens=240，显示三段为120/80/40，总量240，输入总览200，命中率40%；推理10不另外相加。

## 请求身份与持久化

调用开始生成 UUID 并持久化调用时会话、Pi session、模型及项目/来源快照。结束只补同一请求的 usage，重复终态不能增加请求数。给实际响应附加无秘密 multivacUsageRequestId，历史按该标记复用身份；没有标记的旧记录仅在采集启用时间之前按 Pi session ID+entry ID 回补。启用后无标记的记录不冒险计入，避免数据库落盘与 Pi 文件跨存储失败造成重复。每次请求独立记录，一轮内多次响应全部计入。

进程退出时尚无终态的记录仍是缺失，重启不重发模型。实时统计与回补共用一个主键；已测量记录不可被回补或迟到缺失记录降级。改名/归档不删除统计，Top5身份按会话ID；显示名可用当前名称，归属仍用调用快照。

## 缺失与历史

失败、取消有可确认的正数usage也计入；缺失、异常、失败取消的全零占位保留请求数，但不伪造token。已测量零响应区别于缺失。总量是“已记录用量”；缺失请求存在时属于下界，禁止显示为完整统计。

历史只读已绑定 Pi 文件的全部 entries（不能只读 active branch 或页面分页），跳过已损坏/无稳定身份/时间不可信的记录并记录原因。不触发模型，不改写历史。旧记录项目和来源没有调用快照时为未知，不能以当前所属项目反推；已知全局协调ID可确定协调来源，可靠 TaskRun 与 Pi 绑定可用于确定任务来源，其余无法确定为未知。未知项目独立于明确无项目（日常）。历史扫描不能证明旧压缩及无响应失败调用完整，所以即使扫描完成，启用前仍为部分/未覆盖。

## 时间和查询

GET /api/usage?days=30&timeZone=Asia%2FShanghai。days只接受7/30/90、默认30；IANA时区由浏览器传入，默认UTC，非法值400；不接受项目筛选。服务端在一次查询中固定 generatedAt，按请求开始UTC时间转用户时区日历日。当天包含至查询时刻，当前N天为今日及前N-1天；上一周期为紧邻的前N个日历日，无重叠。夏令时不使用N×24小时倒推。

每日、全部维度和Top5共用同一记录集和累加器。每日固定N项，用coverage区分真零和未知日；未覆盖无记录日期显示未知。requests为观测到的实际SDK调用，measuredRequests+missingRequests=requests；历史请求计数是可恢复的响应次数，下界，不能声称包括SDK内不可见HTTP重试。

日均=当前总量/N，仅覆盖完整且无缺失时给值，否则null。环比=(当前-上期)/上期，仅两期完整且上期>0，否则null；不会把上一周期无覆盖解释为零增长。份额以已测量token总量计算，分母为零null；未知归属保留独立分组。Top5从全部数据按token降序、稳定ID次序取5，不提供跳转。时间不可定位的记录仅进入coverage.unplacedRequests，不强塞进某一天。

## 验证边界

必须覆盖同轮多调用、重复终态、重启/恢复/回补幂等、归档改名、缓存写入、推理、失败取消与缺失、真实零、未知归属、时区跨日及DST、7/30/90天和总览/趋势/所有维度合计。原型对照包含侧栏展开与窄容器、当天明细、维度切换、加载/错误/空及覆盖说明。未实际运行的类型检查、构建、测试和浏览器验证必须逐项标明，不能以手工代码检查替代通过证据。
