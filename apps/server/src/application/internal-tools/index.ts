import type { InternalToolDefinition } from './internal-tool-service.js';
import { listTasksTool, getTaskTool } from './task-query-tools.js';
import {
  getCurrentViewTool,
  getSessionTool,
  listProjectsTool,
  listSessionsTool,
  listWorkspacesTool,
  readSessionRecentTool,
} from './query-tools.js';
import {
  proposeCreateProjectTool,
  proposeMountDirectoryTool,
  proposeMoveSessionToProjectTool,
  proposeSetPrimaryDirectoryTool,
  proposeUnmountDirectoryTool,
  renameProjectTool,
  updateProjectConstraintsTool,
} from './project-tools.js';
import { archiveSessionTool, createSessionTool, renameSessionTool, restoreSessionTool } from './session-tools.js';
import {
  openManagementPageTool,
  openSessionTool,
  setParallelCountTool,
  setViewModeTool,
  switchWorkspaceTool,
} from './workspace-tools.js';

export * from './internal-tool-service.js';

/**
 * 全局 Multivac 的全部内部工具。新增工具：在对应分组文件中用 defineInternalTool 定义，
 * 在契约 INTERNAL_TOOL_DISPLAY 中登记展示口径，再加到这里。提示词说明、Pi 注入与目录边界规则随之生效。
 */
export const MULTIVAC_INTERNAL_TOOLS: readonly InternalToolDefinition[] = [
  listTasksTool, getTaskTool,
  listProjectsTool,
  listWorkspacesTool,
  listSessionsTool,
  getSessionTool,
  getCurrentViewTool,
  readSessionRecentTool,
  createSessionTool,
  renameSessionTool,
  archiveSessionTool,
  restoreSessionTool,
  switchWorkspaceTool,
  openSessionTool,
  setParallelCountTool,
  setViewModeTool,
  openManagementPageTool,
  renameProjectTool,
  updateProjectConstraintsTool,
  proposeCreateProjectTool,
  proposeMountDirectoryTool,
  proposeUnmountDirectoryTool,
  proposeSetPrimaryDirectoryTool,
  proposeMoveSessionToProjectTool,
];
