# 单次提醒契约

单次提醒旧工具保留兼容契约，由独立[定时安排](design/scheduled-arrangements.md)统一消费。Schedule 保存安排，Occurrence 保存一次触发，InboxNotification 保存已生成通知；旧 Reminder/命令回执保留用于兼容查询。提醒 ID 稳定；每次修改 revision 增加，触发 ID 为 `notification:<reminderId>:<revision>`，仅执行服务端注册的 inbox-notification 处理器。文本始终是数据，不进入 Agent 或 TaskRun。

创建和修改必须提供含 Z 或偏移的 scheduledAt、IANA timeZone、该时区下的 localTime。持久化 scheduledAt 统一 UTC；原 localTime 与 timeZone 保留用于核对和展示。当前时间由服务端读取，用户时区由用户或浏览器提供，不能采用服务器时区。日期有歧义、已过时间、夏令时重复时刻缺少明确偏移时集中澄清；不存在的本地时间拒绝。不能静默安排明天。用户说“下午3点”且用户本地今天的该时间尚未过去时，可以采用今天；回执必须明确完整日期。

生命周期：scheduled → delivered / cancelled / failed。只有 scheduled 能修改或取消，revision 必须匹配；已生成通知独立保留。旧定时项在迁移后退出消费，不再并行派发。统一调度先持久保存 Occurrence 与游标，再领取动作；开始前核对安排版本。提醒通知插入、提醒 delivered 与 Occurrence 成功在同一短事务提交，唯一身份防重。提醒仅涉及可事务核对的本地通知；Agent 的租约到期不能证明副作用停止，不按此规则重放。

创建、修改、取消使用 commandId 和完整输入指纹；内部工具的 commandId 是模型为该次明确用户意图选择的稳定身份，按来源会话命名空间保存，响应丢失用 reconcile_reminder_command 查询同一身份；同命令同输入返回固定回执，不同输入冲突。回执与事实同事务保存。请求响应丢失后按原 commandId 只读对账，不重新创建。已保存回执的重放不因时间已过去而失败；新的过去时间请求拒绝。保存失败不回复已安排。版本冲突、终态、无效时间为明确错误；存储错误不猜测成功。

Inbox 复用 GET /api/inbox 与 GET /api/inbox/:id 查询、POST /api/inbox/:id/state 实际查看、POST /api/inbox/:id/decision 确认；通知决定为 `acknowledge`，绑定 commandId 和通知 revision，不扩展原 HumanDecision。变更发布 inbox.changed，窗口重连补读事实。通知 pending 表示待“知道了”；实际查看只保存 seen，不改变待处理。确认后 acknowledgedAt 保存，Inbox 投影为 answered。查询不标记查看。通知不阻塞任务，不构成完成、验收、授权或恢复；阻塞人工请求排序优先，当前详情保持原位。来源只在当前可访问时提供入口。

服务在线时统一调度每秒扫描到期项；后端关闭期间无法准时提醒，启动后补发且保留原计划时间。提醒动作不创建模型执行，不阻断其他安排。周期提醒和定时 Agent 使用独立安排工具与管理面板；不支持任务条件或 deadline。

`delivered` 只表示 Inbox 原通知已生成，不表示外部渠道送达。已启用的[通知渠道](notification-channels.md)可在提交后额外发送提醒文本副本；不在原事务请求外网，也不另建提醒计时器。外部投递有效期是通知生成后24小时，超时原通知继续保留。启用前及暂停期间无历史补发，用户在 Multivac 点“知道了”仅取消尚未开始的外发；外部接受、阅读或回复不会改变 Inbox 查看/确认及业务决定。微信真实准入和手机实收需按渠道说明独立验证。
