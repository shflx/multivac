# 单次提醒契约

用户提醒（Reminder）、技术定时项（ReminderTimer）和已生成通知（InboxNotification）分别保存。提醒 ID 稳定；每次修改 revision 增加，触发 ID 为 `notification:<reminderId>:<revision>`，仅执行服务端注册的 inbox-notification 处理器。文本始终是数据，不进入 Agent 或 TaskRun。

创建和修改必须提供含 Z 或偏移的 scheduledAt、IANA timeZone、该时区下的 localTime。持久化 scheduledAt 统一 UTC；原 localTime 与 timeZone 保留用于核对和展示。当前时间由服务端读取，用户时区由用户或浏览器提供，不能采用服务器时区。无日期、有歧义、已过时间、夏令时重复时刻缺少明确偏移时集中澄清；不存在的本地时间拒绝。不能静默安排明天。

生命周期：scheduled → delivered / cancelled / failed。只有 scheduled 能修改或取消，revision 必须匹配；已生成通知独立保留。定时项 pending → claimed → done，失败可返回 pending，达到有限重试上限进入 failed。旧版本的定时项取消，认领后再次核对提醒版本。认领租约过期允许恢复。通知插入、提醒 delivered、定时项 done 同一短事务提交，唯一触发 ID 防重。

创建、修改、取消使用 commandId 和完整输入指纹；同命令同输入返回固定回执，不同输入冲突。回执与事实同事务保存。请求响应丢失后按原 commandId 只读对账，不重新创建。已保存回执的重放不因时间已过去而失败；新的过去时间请求拒绝。保存失败不回复已安排。版本冲突、终态、无效时间为明确错误；存储错误不猜测成功。

通知 pending 表示待“知道了”；实际查看只保存 seen，不改变待处理。确认后 acknowledgedAt 保存，Inbox 投影为 answered。查询不标记查看。通知不阻塞任务，不构成完成、验收、授权或恢复；阻塞人工请求排序优先，当前详情保持原位。来源只在当前可访问时提供入口。

服务在线时每 5 秒补查到期项；后端关闭期间无法准时提醒，启动后补发且保留原计划时间。有限重试失败保存故障原因，不创建模型执行，不阻断其他调度项。首版不支持周期、任务条件、deadline 或外部推送。
