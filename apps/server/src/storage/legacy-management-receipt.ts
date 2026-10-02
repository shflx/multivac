/**
 * 旧会话管理页已经移除。读取历史工具结果时只迁移回执操作的页面 id，
 * 然后仍由调用方按完整白名单校验；不改原始摘要、账本参数或执行任何动作。
 */
export function migrateLegacyManagementReceipt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('receipt' in value)) return value;
  const receipt = value.receipt;
  if (!receipt || typeof receipt !== 'object' || !('actions' in receipt) || !Array.isArray(receipt.actions)) return value;
  return {
    ...value,
    receipt: {
      ...receipt,
      actions: receipt.actions.map((action: unknown) => action && typeof action === 'object'
        && 'kind' in action && action.kind === 'open-management-page' && 'page' in action && action.page === 'sessions'
        ? { ...action, page: 'archive' }
        : action),
    },
  };
}
