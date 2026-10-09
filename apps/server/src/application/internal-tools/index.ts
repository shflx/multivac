import { INBOX_TOOLS } from './inbox-tools.js';
import { proposeGitPublishTool } from './external-publish-tool.js';
import { RUN_TOOLS, WORK_PROCESS_TOOLS, stopSessionProcessTool, stopSessionProcessesTool } from './run-tools.js';
import type { InternalToolDefinition } from './internal-tool-service.js';
import { READING_TOOLS } from './reading-tools.js';
import { listTasksTool, getTaskTool, listTaskGroupsTool } from './task-query-tools.js';
import { confirmHumanTaskTool, completeTaskTool, createTaskTool, proposeCreateTaskTool, updateTaskTool, controlTaskTool, deleteTaskTool, createTaskGroupTool } from './task-management-tools.js';
import { TASK_REVIEW_TOOLS } from './task-review-tools.js';
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
  ...READING_TOOLS,
  ...RUN_TOOLS, stopSessionProcessTool, stopSessionProcessesTool,
  listTasksTool, getTaskTool, listTaskGroupsTool,
  confirmHumanTaskTool, createTaskTool, proposeCreateTaskTool, updateTaskTool, controlTaskTool, deleteTaskTool, createTaskGroupTool,
  ...INBOX_TOOLS, ...TASK_REVIEW_TOOLS, proposeGitPublishTool,
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

/** 工作会话可查询、更新属性并报告手动完成；不授予后台控制、删除或人工决定能力。 */
export const WORK_SESSION_TASK_TOOLS: readonly InternalToolDefinition[] = [
  listTasksTool, getTaskTool, listTaskGroupsTool, updateTaskTool, completeTaskTool, confirmHumanTaskTool, proposeGitPublishTool, ...WORK_PROCESS_TOOLS,
];
