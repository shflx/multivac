/** 只按明确的阻塞标记和创建时间排序；展示文案不参与业务判断。 */
export function pendingInboxRequests(requests) {
  const timestamp = (request) => {
    const value = Date.parse(request.createdAt);
    return Number.isFinite(value) ? value : Infinity;
  };
  return requests.filter((request) => request.state !== 'done').sort((left, right) =>
    Number(Boolean(right.blocksWork)) - Number(Boolean(left.blocksWork)) || timestamp(left) - timestamp(right)
  );
}

export function nextInboxRequest(requests, currentId) {
  return pendingInboxRequests(requests).find((request) => request.id !== currentId) || null;
}

/** 抽屉打开且详情可见时才算查看；仅在列表预选不消费未查看状态。 */
export function markInboxRequestSeen(requests, requestId, { visible = false, detailOpen = false } = {}) {
  if (!visible || !detailOpen || !requests.some((request) => request.id === requestId && request.state === 'new')) return requests;
  return requests.map((request) => request.id === requestId && request.state === 'new' ? { ...request, state: 'seen' } : request);
}

/** 默认只允许一次；失效的项目范围退回最小范围，不扩大到会话。 */
export function toolAuthorizationAction(scope = 'once', projectId = null) {
  if (scope === 'session') return 'session';
  if (scope === 'project' && projectId) return 'project';
  return 'once';
}

export function inboxDecisionConsequence(request, action, answer, { task, project } = {}) {
  if (request.type === '澄清') return action === 'deny' ? '不引用这份资料，任务按现有项目资料继续。' : action === 'custom' ? `任务按你指定的范围继续：${answer.trim()}` : '仅在本次任务中引用所列资料，任务继续推进。';
  if (request.type === '验收') return action === 'accept' ? '成果已验收，来源任务已完成。' : `修改意见已保存，任务已暂停，可在来源会话按原边界修改：${answer.trim()}`;
  if (request.type === '工具授权') {
    if (action === 'deny') return '本次操作已拒绝，任务改用已授权的方式继续。';
    if (action === 'project') return `任务继续执行；「${project?.name || '当前项目'}」内的「${request.capability}」已记住，可在项目权限中撤销。`;
    if (action === 'session') return `任务继续执行；会话「${task?.session || '当前会话'}」内的「${request.capability}」已记住，可在会话授权记录中撤销。`;
    return '仅允许本次操作，任务继续执行；没有新增长期授权。';
  }
  if (request.type === '恢复确认') return action === 'stop' ? '任务保持停止，已有工作区变更保留。' : action === 'restart' ? '任务从安全起点重新推进，先核对已有变更，避免重复执行。' : '任务继续推进，先核对遗留命令的状态。';
  return action === 'allow' ? '本次发布已授权，来源任务已完成；授权不适用于后续发布。' : '本次发布已拒绝，成果保留，来源任务已完成。';
}
