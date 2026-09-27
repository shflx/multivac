import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Activity,
  Archive,
  AtSign,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Highlighter,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleStop,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Columns2,
  Command,
  Copy,
  Cpu,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Library,
  ListTodo,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Orbit,
  PanelLeftClose,
  Pause,
  Pencil,
  Plug,
  Play,
  Plus,
  Quote,
  Download,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareStack,
  Terminal,
  UserCog,
  X,
} from 'lucide-react';
import { ResizableConversations } from './resizable-conversations.jsx';
import { ANOMALY_STATUSES, RUN_INDICATOR_LABELS, canSubmitDecision, decisionLabel, deriveRunIndicator, describeRunIndicator, listRecentOutputs, matchByTitle, matchOutput, parseAssistantIntent, refersToFocus, DEFAULT_PARALLEL, PARALLEL_OPTIONS, normalizeScenes, placeInSlot, resizeSlots, resolveSlots, REASONING_MODES, effectiveThinking, resolveReasoning, EFFECT_LABELS, EFFECT_ORDER, applyComposerPick, capabilityEffect, composerTrigger, withinEffectCap, appendExcerpt, applySuggestion, isArrangementIntent, spoilerChapter, releaseForProject, resolveAvailability, resolveCapabilities, toolEffect } from './ui-state.js';
import './style.css';

/**
 * 项目是执行层：决定任务在哪里做、能动什么，挂载 0–N 个工作目录。
 * 学习、研究类项目可以没有目录；不属于任何项目的任务归入“日常”。
 */
const initialProjects = [
  { id: 'multivac', name: 'Multivac 开发', dirs: ['~/code/multivac'], scope: '项目文档与需求文档', constraint: '目录内的本地更新自动执行，目录外修改需要确认', effectCap: 'external', excluded: ['calendar'], accounts: { github: 'shflx（工作账号）' }, hiddenSkills: ['skill-paper'] },
  { id: 'research', name: '技术研究', dirs: [], scope: '指定的公开资料', constraint: '只读资料，不修改本地文件', effectCap: 'read', excluded: [], accounts: {}, hiddenSkills: [] },
];

/**
 * 能力的全局登记：内置工具、MCP 服务与 Skill。登记即默认可用，项目只划边界（效果上限、排除项、账号），
 * 智能体只说明常用什么。
 * MCP 工具的效果等级优先用服务自带注解；没有标注的（effect 缺省）按“外部副作用”处理。
 */
const initialCapabilities = [
  { id: 'builtin-files', kind: 'builtin', name: '文件与命令', description: 'read / edit / write / bash，运行时内置。', tools: [{ name: 'read', effect: 'read' }, { name: 'edit', effect: 'local' }, { name: 'write', effect: 'local' }, { name: 'bash', effect: 'local' }] },
  { id: 'github', kind: 'mcp', name: 'GitHub', transport: '远程 HTTP', status: 'connected', credential: '已配置', lastUsed: '今天 14:20', lastError: '', tools: [{ name: 'list_issues', effect: 'read' }, { name: 'get_pull_request', effect: 'read' }, { name: 'create_pull_request', effect: 'external' }, { name: 'push_branch', effect: 'external' }] },
  { id: 'web-search', kind: 'mcp', name: '网页搜索', transport: '远程 HTTP', status: 'connected', credential: '无需凭据', lastUsed: '今天 13:02', lastError: '', tools: [{ name: 'search', effect: 'read' }, { name: 'fetch', effect: 'read' }] },
  { id: 'calendar', kind: 'mcp', name: '日历', transport: '本地 stdio', status: 'disconnected', credential: '已配置', lastUsed: '9/25 09:12', lastError: '进程已退出（exit 1）', tools: [{ name: 'list_events', effect: 'read' }, { name: 'create_event' }] },
  // Skill 不标效果等级：它能做什么取决于会用到的服务（uses）；依赖在某个项目里不可用时，Skill 在该项目中也不可用。
  { id: 'skill-prd', kind: 'skill', name: '需求文档', description: '把讨论整理成结构化需求文档：范围、验收与待决问题。', trigger: '需要把讨论或零散想法整理成需求文档、确认范围与验收时', source: '自建', uses: ['builtin-files'], lastUsed: '今天 11:40', skillMd: '---\nname: 需求文档\ndescription: 把讨论整理成结构化需求文档\n---\n\n1. 先列目标与非目标，再写范围\n2. 每条需求写清验收标准\n3. 未决问题单列，不替用户做决定\n4. 输出到项目 docs/ 目录下的 Markdown 文件' },
  { id: 'skill-release', kind: 'skill', name: '发布前检查', description: '检查变更说明、版本号与测试结果。', trigger: '准备发布、打标签或合入主线前', source: '项目自带', projectId: 'multivac', uses: ['builtin-files', 'github'], lastUsed: '9/24', skillMd: '---\nname: 发布前检查\ndescription: 发布前核对变更说明、版本号与测试\n---\n\n1. 运行 npm test 与 npm run build\n2. 核对 CHANGELOG 与版本号\n3. 在 GitHub 上确认 CI 结果' },
  { id: 'skill-paper', kind: 'skill', name: '论文精读', description: '按问题、方法、结论与局限精读论文并摘录。', trigger: '需要精读一篇论文或技术报告时', source: '导入', uses: ['web-search'], lastUsed: '9/22', skillMd: '---\nname: 论文精读\ndescription: 按问题、方法、结论与局限精读论文\n---\n\n1. 一句话概括论文要解决的问题\n2. 方法与关键假设\n3. 结论与证据强度\n4. 局限与可以追问的点' },
];

/**
 * 智能体是执行配置，不是岗位：模型与推理等级 + 指令 + 常用 Skill 与需要的服务 + 效果上限。
 * 能力默认都可用，这里只说明“常用什么、最多能做到哪一档”。Multivac 按任务类型自动选择并在确认卡上显示；
 * 协调者只带内部工具，固定不可配置。
 */
const initialAgents = [
  { id: 'coordinator', name: 'Multivac（协调）', fixed: true, description: '只带内部工具与只读查询；有副作用的操作转交任务会话执行。', modelId: 'openai-main', thinking: 'high', preferredSkills: [], requiredServices: [], effectCap: 'read' },
  { id: 'general', name: '通用执行', description: '编码、文档与日常执行，适合大多数任务。', instructions: '先读项目约束与 AGENTS.md；改动小步提交，每步说明原因；不确定的地方先问。', modelId: 'openai-main', thinking: 'high', preferredSkills: ['skill-prd', 'skill-release'], requiredServices: ['builtin-files', 'github', 'web-search'], effectCap: 'external' },
  { id: 'research', name: '研究', description: '调研与资料整理，最高只读。', instructions: '保留来源与不确定性；结论和证据分开写；不下超出资料的判断。', modelId: 'anthropic-main', thinking: 'medium', preferredSkills: ['skill-paper', 'skill-prd'], requiredServices: ['web-search'], effectCap: 'read' },
];

// 可以通过对话接入的服务（原型中的示例）：来源、工具与效果等级、需要的凭据。
const CONNECTABLE_SERVICES = {
  notion: { id: 'notion', name: 'Notion', transport: '远程 HTTP', source: 'Notion 官方 MCP 服务', credential: 'Notion 集成令牌', tools: [{ name: 'search', effect: 'read' }, { name: 'read_page', effect: 'read' }, { name: 'create_page', effect: 'external' }, { name: 'update_block' }] },
  飞书: { id: 'lark', name: '飞书', transport: '远程 HTTP', source: '飞书开放平台 MCP 服务', credential: '应用凭据（App ID / Secret）', tools: [{ name: 'search_docs', effect: 'read' }, { name: 'send_message', effect: 'external' }] },
};

// 已记住的授权：由程序校验，可在“设置 · 能力”中查看和撤销。
const initialGrants = [
  { id: 'grant-1', capability: 'GitHub · get_pull_request', scope: '本项目内始终允许', target: 'Multivac 开发', at: '9/26 15:02' },
  { id: 'grant-2', capability: '网页搜索 · fetch', scope: '本任务内允许', target: '对比 Agent SDK', at: '9/27 10:18' },
];

// 效果上限各档的含义：分段选择下方直接写出，避免只看名字猜范围。
const EFFECT_DESCRIPTIONS = {
  read: '只读取资料、搜索与查询，不改动任何东西。',
  local: '可在项目目录内编辑文件、运行命令；目录外的修改仍需确认。',
  external: '可发消息、提交 PR、写入外部系统；每次仍需你确认，或按记住的授权放行。',
  egress: '可把资料内容发给第三方服务；首次向某个第三方传输某类资料时需确认。',
};

/** 效果上限的四档分段选择。 */
function EffectCapPicker({ value, onChange, label }) {
  return (
    <div className="effect-cap-picker">
      <div className="segmented" role="radiogroup" aria-label={label}>
        {EFFECT_ORDER.map((effect) => <button type="button" key={effect} role="radio" aria-checked={value === effect} className={value === effect ? 'active' : ''} onClick={() => onChange(effect)}>{EFFECT_LABELS[effect]}</button>)}
      </div>
      <p>{EFFECT_DESCRIPTIONS[value]}</p>
    </div>
  );
}

// 实际可用的工具数超过这个阈值时提示精简，避免拖累模型判断。
const TOOL_COUNT_HINT = 8;
const toolCount = (capabilities) => capabilities.reduce((sum, item) => sum + (item.tools?.length || 0), 0);

// 需要账号的服务可在项目里绑定不同账号（原型中的示例账号）。
const SERVICE_ACCOUNTS = { github: ['shflx（工作账号）', 'xiaofeng（个人账号）'], calendar: ['工作日历', '个人日历'] };

/**
 * 实际可用预览：逐项列出可用与不可用的能力，不可用的写明原因。
 * 项目详情与智能体详情共用；onRelease 提供“为本项目放开”。
 */
function AvailabilityPreview({ availability, onRelease, agentLimited = [] }) {
  return (
    <div className="availability-preview">
      <p className="muted-line">效果上限：{EFFECT_LABELS[availability.cap]} · 可用 {availability.available.length} 项{toolCount(availability.available) > TOOL_COUNT_HINT ? ` · ${toolCount(availability.available)} 个工具，工具过多会拖累模型判断，建议排除用不到的服务` : ''}</p>
      <ul>
        {availability.available.map((capability) => <li key={capability.id} className="available"><Check /><span>{capability.name}</span><small>{capability.kind === 'skill' ? 'Skill' : EFFECT_LABELS[capabilityEffect(capability)]}</small></li>)}
        {availability.unavailable.map(({ capability, reason }) => (
          <li key={capability.id} className="unavailable"><X /><span>{capability.name}</span><small>{agentLimited.includes(capability.id) ? (capability.kind === 'skill' ? '会用到的服务超出本智能体的效果上限' : '超出本智能体的效果上限') : reason}</small>{onRelease && reason !== '服务未连接' && !agentLimited.includes(capability.id) && <button type="button" className="inline-link" onClick={() => onRelease(capability)}>为本项目放开</button>}</li>
        ))}
      </ul>
    </div>
  );
}

function projectLabel(project) {
  if (!project) return '日常 · 不属于任何项目';
  return project.dirs.length ? `${project.name} · ${project.dirs[0]}` : `${project.name} · 无挂载目录`;
}

/**
 * 笔记是你亲手写的内容（本地 Markdown）。在工作区作为笔记对象打开，梳理助手只提建议。
 */
const initialNotes = [
  { id: 'weekly', title: '本周周报', updated: '今天 18:10', content: '## 本周进展\n- 完成原型的顶部状态区改版\n- 会话恢复问题定位到落盘顺序\n\n## 下周计划\n- 补齐工作区的笔记与读书对象\n- 恢复测试全部通过后发布' },
  { id: 'consistency', title: '一致性模型笔记', updated: '昨天 22:40', content: '## 线性一致性\n每次操作看起来都在调用和返回之间的某个瞬间原子发生。\n\n## 待整理\n- 顺序一致性和线性一致性的区别\n- 最终一致性适合哪些场景' },
];

/**
 * 书（原型用示例章节）。keywords 用来判断提问是否涉及还没读到的章节，书伴据此不剧透。
 */
// 资料内容（文档、书架、笔记库）在工作区“打开…”中浏览；设置里只管它们按类别的使用范围。
const initialDocuments = [
  { id: 'mvp', title: 'mvp.html', category: '产品定义', format: 'HTML', parsed: true },
  { id: 'requirements', title: 'personal-agent-requirements.html', category: '产品定义', format: 'HTML', parsed: true },
  { id: 'notes', title: 'distributed-systems-notes.pdf', category: '学习资料', format: 'PDF', parsed: true },
  { id: 'archive', title: 'sdk-comparison.pages', category: '研究资料', format: 'Pages', parsed: false },
];

const SCOPE_OPTIONS = ['所有项目', 'Multivac 项目', '仅指定任务', '仅书伴与笔记', '未授权使用'];

const initialScopeRules = [
  { id: '产品定义', source: '文档', scope: 'Multivac 项目' },
  { id: '学习资料', source: '文档', scope: '仅指定任务' },
  { id: '研究资料', source: '文档', scope: '未授权使用' },
  { id: '书架', source: '书', scope: '仅书伴与笔记' },
  { id: '笔记库', source: '笔记', scope: '所有项目' },
];

const initialBooks = [
  {
    id: 'ddia',
    title: '数据密集型应用系统设计',
    author: 'Martin Kleppmann',
    chapters: [
      { id: 'ch9', title: '第 9 章 一致性与共识', keywords: ['线性一致性', '共识', '全序'], paragraphs: [
        '在分布式系统里，网络可能丢包、时钟可能不准、节点可能暂停。容错的一种办法，是找到一些通用的抽象，让应用可以依赖它们提供的保证。',
        '多数复制数据库至少提供最终一致性：如果停止写入并等待一段不确定的时间，所有读请求最终会返回相同的值。这是一种很弱的保证，它没有说什么时候会收敛。',
        '线性一致性的想法是让系统看起来好像只有一个数据副本，而且所有操作都是原子的。有了这个保证，即使底层有多个副本，应用也不必关心它们。',
        '一旦某个读操作返回了新值，之后的所有读操作都必须返回新值，即使写操作还没有完成。这就是线性一致性里“新鲜度”的含义。',
        '线性一致性很容易和可串行化混淆。可串行化是事务的隔离属性，保证多个事务的执行结果等价于某种串行顺序；线性一致性是对单个对象读写的新鲜度保证。',
        '实现线性一致性要付出性能代价，网络延迟越大代价越明显。这也是很多数据库选择不提供它的原因。',
      ] },
      { id: 'ch10', title: '第 10 章 批处理', keywords: ['批处理', 'MapReduce', 'Unix 管道'], paragraphs: [
        '批处理系统接收大量输入数据，运行作业处理它们，并产生输出。作业通常要跑一段时间，所以不会有用户在等待。',
        'Unix 管道的设计哲学——每个程序只做一件事，并通过统一的接口组合——在 MapReduce 中得到了延续。',
      ] },
    ],
  },
];

const initialTasks = [
  { id: 'prototype', title: '整理 MVP 原型范围', projectId: 'multivac', status: 'running', priority: '高', session: '原型范围梳理', scope: 'mvp.html、需求文档', acceptance: true, reason: '正在整理页面状态和体验脚本', next: '完成交互说明并生成成果' },
  { id: 'recovery', title: '修复会话恢复问题', projectId: 'multivac', status: 'running', priority: '高', session: '恢复机制排查', scope: '当前仓库', acceptance: true, reason: '正在运行恢复测试', next: '检查失败用例' },
  { id: 'permissions', title: '梳理授权边界', projectId: 'multivac', status: 'running', priority: '中', session: '授权边界梳理', scope: '项目约束与需求文档', acceptance: false, reason: '正在区分验收、外发与资料传输', next: '补齐权限提示文案' },
  { id: 'isolation', title: '验证命令隔离', projectId: 'multivac', status: 'running', priority: '中', session: '命令隔离验证', scope: '隔离 PoC', acceptance: false, reason: '正在核对探针结果', next: '汇总验证边界' },
  { id: 'agent-sdk', title: '对比 Agent SDK', projectId: 'research', status: 'queued', priority: '中', session: 'Agent SDK 对比', scope: '指定调研资料', acceptance: false, reason: '并发名额已满，排队第 1 位', next: '等待执行名额' },
  { id: 'project-doc', title: '更新项目文档', projectId: 'multivac', status: 'scheduler-paused', priority: '中', session: '项目文档更新', scope: 'project.html', acceptance: false, reason: '为高优先级任务安全让位', next: '释放名额后自动恢复' },
  { id: 'scope', title: '确认资料使用范围', projectId: null, status: 'clarification', priority: '高', session: '资料范围确认', scope: '待确认', acceptance: true, reason: '需要确认是否可引用个人笔记', next: '等待你的回答' },
  { id: 'review', title: '审阅实现结果', projectId: 'multivac', status: 'acceptance', priority: '中', session: '实现审阅', scope: '当前变更', acceptance: true, reason: '自检已通过，等待验收', next: '接受成果或要求修改' },
  { id: 'publish', title: '发布变更说明', projectId: 'multivac', status: 'authorization', priority: '低', session: '发布说明', scope: '成果摘要', acceptance: false, reason: '成果已完成，等待外发授权', next: '确认是否发布' },
  { id: 'report', title: '生成技术调研报告', projectId: 'research', status: 'done', priority: '中', session: '技术调研', scope: '指定公开资料', acceptance: false, reason: '已完成并通过自检', next: '查看成果' },
  { id: 'index', title: '重建资料索引', projectId: 'research', status: 'stalled', priority: '中', session: '资料索引重建', scope: '资料库', acceptance: false, reason: '索引进程 25 分钟没有新进展', next: '进入现场检查进程，或重新启动' },
  { id: 'interrupted', title: '执行中断的代码修改', projectId: 'multivac', status: 'recovery', priority: '高', session: '中断恢复', scope: '隔离工作区', acceptance: true, reason: '上次关闭时命令状态不明确', next: '检查现场后决定恢复方式' },
];

const initialRequests = [
  { id: 'scope-request', taskId: 'scope', type: '澄清', title: '是否允许引用个人笔记？', detail: '这份资料能补足背景，但当前只授权了项目文档。其他不依赖该资料的整理工作仍在继续。', age: '8 分钟前', impact: '阻塞 1 个步骤', state: 'new' },
  { id: 'review-request', taskId: 'review', type: '验收', title: '实现结果已准备好审阅', detail: '3 个检查项通过。请确认当前交互是否符合预期，或返回工作会话提出修改。', age: '24 分钟前', impact: '等待完成', state: 'new' },
  { id: 'grant-request', taskId: 'recovery', type: '工具授权', title: '允许把修复分支推送到 GitHub？', detail: '恢复测试已通过，下一步要调用 GitHub · push_branch 推送修复分支。其他本地步骤不受影响。', age: '2 分钟前', impact: '阻塞 1 个步骤', state: 'new', capability: 'GitHub · push_branch', effect: 'external' },
  { id: 'publish-request', taskId: 'publish', type: '外发授权', title: '是否发布变更说明？', detail: '成果已经完成；发布到外部仓库仍需要单独授权。拒绝不会改变成果状态。', age: '1 小时前', impact: '不阻塞其他任务', state: 'seen' },
];

// at 是可排序的时间，updated 只用于展示；是否看过由 App 层的 viewedOutputIds 记录。
const initialOutputs = [
  { id: 'mvp-doc', taskId: 'review', title: 'MVP 交互原型说明', type: '文档', updated: '今天 14:32', at: '2026-09-24T14:32:00', icon: FileText, summary: '覆盖任务交代、后台推进、介入、验收与恢复的完整体验链路。', checks: ['内容结构检查通过', '关键状态覆盖完整', '未包含真实执行承诺'] },
  { id: 'sdk-report', taskId: 'report', title: 'Coding Agent SDK 调研报告', type: '研究', updated: '今天 13:50', at: '2026-09-24T13:50:00', icon: FileCode2, summary: '对比会话、工具调用、恢复与压缩能力，并保留来源和不确定性。', checks: ['12 个来源已核对', '引用可追溯', '结论边界已标记'] },
  { id: 'recovery-patch', taskId: 'recovery', title: '会话恢复修复候选', type: '代码变更', updated: '进行中', at: '2026-09-24T14:40:00', icon: Code2, summary: '恢复状态机的候选修改，当前仍在运行测试。', checks: ['类型检查通过', '单元测试 18/19', '恢复测试仍在运行'] },
];

/**
 * 执行中任务会话的现场快照：当前步骤、已用时、最近一次工具调用。
 * 距最近进展过久时标记为疑似卡住，免得要点进会话才看得出来。
 */
const runSnapshots = {
  prototype: { step: '整理页面状态与交互说明', elapsed: '18 分钟', lastTool: '读取 .my-docs/mvp.html', lastToolAge: '1 分钟前' },
  recovery: { step: '运行恢复测试', elapsed: '32 分钟', lastTool: '运行 sessions.test.ts', lastToolAge: '进行中' },
  permissions: { step: '补齐权限提示文案', elapsed: '11 分钟', lastTool: '编辑 permission-copy.md', lastToolAge: '3 分钟前' },
  isolation: { step: '核对探针结果', elapsed: '46 分钟', lastTool: '运行 probe-isolation.sh', lastToolAge: '4 分钟前' },
  index: { step: '为资料库重建全文索引', elapsed: '52 分钟', lastTool: '运行 build-index.sh', lastToolAge: '25 分钟前' },
  interrupted: { step: '上次关闭时正在执行代码修改', elapsed: '已中断', lastTool: '运行 apply-patch', lastToolAge: '状态不明确' },
};

/**
 * 由任务启动的后台进程。只收录可追溯到任务的进程，不做通用进程管理器。
 * requiredWhileRunning：启动它的任务仍在执行时依赖该进程，停止前需要提示影响。
 */
const initialProcesses = [
  { id: 'prototype-dev', taskId: 'prototype', name: '原型开发服务', command: 'vite --port 5173', port: 5173, uptime: '42 分钟', requiredWhileRunning: true, impact: '原型预览会中断，任务会在下一步重新启动服务。', log: ['14:05:12  VITE v5 ready in 412 ms', '14:05:12  ➜ Local: http://localhost:5173/', '14:31:40  hmr update /app.jsx', '14:32:05  hmr update /style.css'] },
  { id: 'recovery-watch', taskId: 'recovery', name: '恢复测试监听', command: 'vitest --watch sessions', port: null, uptime: '31 分钟', requiredWhileRunning: true, impact: '正在进行的恢复测试会被打断，需要重新运行。', log: ['RERUN  sessions.test.ts', ' ✓ 恢复记录按顺序落盘 (18)', ' × 重启后运行状态一致', 'Tests  18 passed | 1 failed'] },
  { id: 'report-preview', taskId: 'report', name: '调研报告预览', command: 'python3 -m http.server 8080', port: 8080, uptime: '2 小时', requiredWhileRunning: true, impact: '', log: ['Serving HTTP on 0.0.0.0 port 8080', '127.0.0.1 - - "GET /report.html" 200', '127.0.0.1 - - "GET /assets/chart.svg" 200'] },
];

/**
 * 原型演示用的后台完成事件：打开后陆续完成两项无需验收的任务，
 * 用来展示“完成不插话，停顿时合并成一张完成卡”。
 */
const demoCompletions = [
  { delay: 15000, taskId: 'isolation', output: { id: 'isolation-report', title: '命令隔离验证结论', type: '验证', icon: ShieldCheck, summary: '隔离 PoC 的探针结果与边界：文件系统与网络按预期拦截，子进程继承仍需补测。', checks: ['6 个探针通过', '边界已标记', '遗留 1 项补测'] } },
  { delay: 17500, taskId: 'permissions', output: { id: 'permissions-doc', title: '授权边界说明', type: '文档', icon: FileText, summary: '区分验收、外发授权与资料传输三类授权，并给出提示文案。', checks: ['三类授权已区分', '文案覆盖全部入口', '未扩大既有权限'] } },
];

const conversations = {
  learning: {
    title: '分布式系统学习',
    category: '探索会话',
    messages: [
      { who: '你', text: '我想从一致性模型开始理解，先不要急着下结论。' },
      { id: 'learning-turn-1', who: 'trace', trace: true, status: 'done', duration: '用时 9 秒', entries: [{ kind: 'thought', text: '先建立几个一致性模型之间的比较框架，再逐个解释它们的约束。' }] },
      { who: '工作会话', text: '可以。我们先区分线性一致性、顺序一致性和最终一致性，再看它们分别解决什么问题。' },
      { who: '你', text: '这里关于线性一致性的解释很有用，我想继续拆开理解。' },
      { id: 'learning-turn-2', who: 'trace', trace: true, status: 'done', duration: '用时 12 秒', entries: [{ kind: 'thought', text: '重点需要放在操作的实时顺序，而不是只讨论副本最终是否相同。' }] },
      { who: '工作会话', text: '线性一致性的关键不只是“所有副本一样”，而是每次操作看起来都在调用和返回之间的某个瞬间原子发生。' },
    ],
  },
  prototype: {
    title: '原型范围梳理',
    category: '任务会话',
    messages: [
      { who: '任务', text: '目标：根据 MVP 文档整理仅用于体验验证的界面原型范围。' },
      { id: 'prototype-turn-1', who: 'trace', trace: true, status: 'done', duration: '用时 24 秒', capabilities: ['文件与命令', '需求文档 Skill'], entries: [
        { kind: 'thought', text: '先读取范围文档，再把需求拆成核心链路、页面状态与明确不实现的部分。' },
        { kind: 'tool', tool: 'read', action: '读取 .my-docs/mvp.html', status: 'done' },
        { kind: 'tool', tool: 'read', action: '读取个人 Agent 需求文档', status: 'done' },
        { kind: 'thought', text: '文档范围已经明确，可以开始整理原型中的连续体验。' },
      ] },
      { who: 'Coding Agent', text: '已读取 mvp.html 和详细需求，正在拆分核心链路、页面状态与不实现范围。' },
      { who: 'Coding Agent', text: '当前重点是确保 Inbox、工作区返回和成果验收能形成连续演示，不把静态页面当成原型完成。' },
    ],
  },
  recovery: {
    title: '恢复机制排查',
    category: '任务会话',
    messages: [
      { who: '任务', text: '复现服务重启后会话恢复状态不一致的问题。' },
      { id: 'recovery-turn-1', who: 'trace', trace: true, status: 'running', capabilities: ['文件与命令'], entries: [
        { kind: 'thought', text: '先对比恢复记录和运行状态的落盘顺序，再用现有测试复现问题。' },
        { kind: 'tool', tool: 'run', action: '运行 sessions.test.ts', status: 'running' },
      ] },
      { who: 'Coding Agent', text: '已定位到恢复记录先于运行状态落盘，正在验证调整后的顺序。' },
    ],
  },
};

/**
 * 模型配置。catalog 是 Pi 模型目录里的条目（推理能力与等级），不在目录里时为 null；
 * reasoning 是用户设置的推理能力（auto / supported / unsupported），已有配置缺省即“自动”。
 */
const initialModelProfiles = [
  { id: 'openai-fast', name: 'GPT-4.1 mini', provider: 'openai', modelId: 'gpt-4.1-mini', endpoint: 'https://api.openai.com/v1', configured: true, description: '响应快，适合日常协调和轻量任务。', catalog: { reasoning: true, levels: ['off', 'minimal', 'low', 'medium'] } },
  { id: 'openai-main', name: 'GPT-5.2', provider: 'openai', modelId: 'gpt-5.2', endpoint: 'https://api.openai.com/v1', configured: true, description: '主力模型，适合复杂分析和编码任务。', catalog: { reasoning: true, levels: ['off', 'low', 'medium', 'high', 'xhigh'] } },
  { id: 'anthropic-main', name: 'Claude Sonnet', provider: 'anthropic', modelId: 'claude-sonnet-4-5', endpoint: 'https://api.anthropic.com', configured: true, description: '适合长文档、代码审阅和持续讨论。', catalog: { reasoning: true, levels: ['off', 'low', 'medium', 'high'] } },
  { id: 'local-coder', name: '本地 Coding 模型', provider: 'openai-compatible', modelId: 'qwen3-coder', endpoint: 'http://127.0.0.1:11434/v1', configured: false, description: '本地模型配置示例，尚未完成认证或连通检查。', catalog: null },
  { id: 'self-responses', name: '自建 Responses 模型', provider: 'openai-compatible', modelId: 'gpt-5-responses', endpoint: 'https://llm.internal.example/v1', configured: true, description: '自建地址的 Responses 模型，不在 Pi 模型目录中。', catalog: null },
];

const thinkingLabels = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };

/**
 * 管理导航按常用程度分三段：核心页、已钉住的插件、设置。
 * 插件分区只在接入首个真实插件后出现，不用模拟插件占位。
 */
const managementNav = {
  core: [
    { id: 'tasks', label: '待办', icon: ListTodo },
    { id: 'runs', label: '运行', icon: Activity },
    { id: 'inbox', label: 'Inbox', icon: Inbox },
    { id: 'outputs', label: '成果', icon: Archive },
  ],
  pinnedPlugins: [],
  settings: { id: 'settings', label: '设置', icon: Settings2 },
};

// 资料使用范围、记忆、模型使用频率低，从一级页降为设置内的分区；资料内容本身在工作区“打开…”中浏览。
const settingsSections = [
  { id: 'projects', label: '项目', icon: Folder },
  { id: 'capabilities', label: '能力', icon: Plug },
  { id: 'agents', label: '智能体', icon: UserCog },
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'library', label: '资料使用范围', icon: ShieldCheck },
  { id: 'memory', label: '记忆', icon: Sparkles },
];

function managementPageLabel(page) {
  return [...managementNav.core, ...managementNav.pinnedPlugins, managementNav.settings].find((item) => item.id === page)?.label;
}

const statusMeta = {
  running: ['执行中', 'green'],
  queued: ['排队', 'gray'],
  'scheduler-paused': ['调度暂停', 'amber'],
  paused: ['用户暂停', 'gray'],
  clarification: ['等待澄清', 'red'],
  acceptance: ['等待验收', 'blue'],
  authorization: ['等待授权', 'amber'],
  done: ['已完成', 'green'],
  recovery: ['恢复待确认', 'red'],
  failed: ['执行失败', 'red'],
  stalled: ['长时间无进展', 'amber'],
  'env-stopped': ['环境停止', 'amber'],
};

function IconButton({ label, children, className = '', ...props }) {
  const id = useId();
  const [anchor, setAnchor] = useState(null);
  function show(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ left: Math.max(168, Math.min(window.innerWidth - 168, rect.left + rect.width / 2)), top: rect.bottom + 8 > window.innerHeight - 40 ? rect.top - 38 : rect.bottom + 8 });
  }
  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('keydown', hide); };
  }, [anchor]);
  return <><button className={`icon-button ${className}`} aria-label={label} aria-describedby={anchor ? id : undefined} onMouseEnter={show} onMouseLeave={() => setAnchor(null)} onFocus={show} onBlur={() => setAnchor(null)} onPointerDown={() => setAnchor(null)} {...props}>{children}</button>{anchor && createPortal(<span id={id} role="tooltip" className="control-tooltip" style={anchor}>{label}</span>, document.body)}</>;
}

/**
 * 会话流跟随底部。
 *
 * 无条件滚到底会在用户上翻查看历史时把他拽回来，所以只在「本来就贴着底部」
 * 时才跟随；用户自己发消息则强制恢复跟随。
 */
function useStickToBottom(containerRef, deps) {
  const stick = useRef(true);

  function handleScroll() {
    const element = containerRef.current;
    if (element) stick.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
  }

  // 瞬时跟随而非平滑滚动：运行轨迹是持续追加的，平滑动画会被下一次追加打断，
  // 表现为一路追不上底部。
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  }, deps);

  return { handleScroll, followLatest: () => { stick.current = true; } };
}

/** 订阅媒体查询，窗口宽度跨过断点时重新渲染。 */
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

// 窄屏（手机）只保留日常层；与样式表里的断点一致。
const NARROW_QUERY = '(max-width: 760px)';

function StatusBadge({ status }) {
  const [label, tone] = statusMeta[status] || [status, 'gray'];
  const Icon = status === 'running' ? LoaderCircle : status === 'done' ? CheckCircle2 : ANOMALY_STATUSES.has(status) ? CircleAlert : status.includes('paused') ? Pause : Clock3;
  return <span className={`status-badge ${tone}`}><Icon className={status === 'running' ? 'status-spinner' : ''} />{label}</span>;
}

function App() {
  const [page, setPage] = useState('tasks');
  const [managementMode, setManagementMode] = useState(false);
  const [workSurface, setWorkSurface] = useState('assistant');
  const [workspaceNavigationVisible, setWorkspaceNavigationVisible] = useState(true);
  const [tasks, setTasks] = useState(initialTasks);
  const [requests, setRequests] = useState(initialRequests);
  const [selectedTaskId, setSelectedTaskId] = useState('prototype');
  const [sessionRequest, setSessionRequest] = useState(null);
  const [selectedRequestId, setSelectedRequestId] = useState('scope-request');
  const [decisionDrafts, setDecisionDrafts] = useState({});
  // 顶部抽屉（Inbox 等）原地打开，不切换页面或模式；同一时间只开一个，关闭后焦点回到触发位置。
  const [openDrawer, setOpenDrawer] = useState(null);
  const [inboxDetail, setInboxDetail] = useState(false);
  const drawerTrigger = useRef(null);
  const [outputs, setOutputs] = useState(initialOutputs);
  const [projects, setProjects] = useState(initialProjects);
  const [notes, setNotes] = useState(initialNotes);
  const [books] = useState(initialBooks);
  const [scopeRules, setScopeRules] = useState(initialScopeRules);
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [agents, setAgents] = useState(initialAgents);
  const [grants, setGrants] = useState(initialGrants);
  // 已打开过的成果：只用于成果抽屉与成果页里的淡标记，不产生任何计数。
  const [viewedOutputIds, setViewedOutputIds] = useState(() => new Set(['mvp-doc', 'recovery-patch']));
  const [selectedOutputId, setSelectedOutputId] = useState('mvp-doc');
  const [concurrency, setConcurrency] = useState(4);
  const [settingsSection, setSettingsSection] = useState('projects');
  const [processes, setProcesses] = useState(initialProcesses);
  const concurrencyRef = useRef(concurrency);
  concurrencyRef.current = concurrency;
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [modelProfiles, setModelProfiles] = useState(initialModelProfiles);
  const [defaultModelId, setDefaultModelId] = useState('openai-main');
  const [assistantModelId, setAssistantModelId] = useState('openai-main');
  const [assistantThinking, setAssistantThinking] = useState('high');
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  // 工作区里的 Multivac 侧栏：默认收起为一个按钮，交给 Multivac 或按快捷键时临时展开，用完即收。
  const [multivacSidebarOpen, setMultivacSidebarOpen] = useState(false);
  const [workspaceFocus, setWorkspaceFocus] = useState(null);
  const narrow = useMediaQuery(NARROW_QUERY);

  const openRequests = requests.filter((request) => request.state !== 'done');
  // 运行指示、管理模式的“x/y 执行中”、运行页共用同一份派生结果，保证口径一致。
  const runIndicator = deriveRunIndicator(tasks);
  const runningCount = runIndicator.running.length;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[0];

  const multivac = useMultivacConversation({
    queueHint: () => runningCount >= concurrency
      ? `排队 · 当前并发 ${runningCount}/${concurrency}`
      : `立即开始 · 当前并发 ${runningCount}/${concurrency}`,
    // 确认卡里的项目沿用来源会话所属的项目；没有来源时归入日常。
    projectHint: (sessionId) => {
      const projectId = tasks.find((task) => task.id === sessionId)?.projectId;
      return projects.find((project) => project.id === projectId) || null;
    },
    onCreateTask: createTaskFromReceipt,
    findObject: findWorkObject,
    openObject: openWorkObject,
    createProject: createProjectFromChat,
    manage: manageFromChat,
    findSkill: (name) => capabilities.find((item) => item.kind === 'skill' && item.name === name) || null,
    prepareConnection: (name) => {
      const existing = capabilities.find((item) => item.name.toLowerCase() === name.toLowerCase());
      return existing ? { existing } : { spec: CONNECTABLE_SERVICES[name.toLowerCase()] || null };
    },
  });

  /** “把 ~/code/notes 作为项目”：一句话创建项目并挂载目录，同名工作区随之出现。 */
  function createProjectFromChat(path) {
    const existing = projects.find((project) => project.dirs.includes(path));
    if (existing) return { created: false, name: existing.name };
    const name = path.replace(/\/+$/u, '').split('/').pop() || path;
    setProjects((current) => [...current, { id: `project-${Date.now()}`, name, dirs: [path], scope: '项目目录内的文档', constraint: '目录内的本地更新自动执行，目录外修改需要确认', effectCap: 'local', excluded: [], accounts: {}, hiddenSkills: [] }]);
    return { created: true, name };
  }

  /** 确认卡落成任务：在后台排队或执行，当前现场不被改成执行现场。 */
  function createTaskFromReceipt(receipt) {
    const running = tasks.filter((task) => task.status === 'running').length;
    const queued = tasks.filter((task) => task.status === 'queued').length;
    const startNow = running < concurrency;
    const taskId = `doc-${Date.now()}`;
    const title = receipt.source ? `整理「${receipt.source.title}」要点文档` : '整理讨论文档';
    const state = startNow ? '已开始执行' : `排队第 ${queued + 1} 位`;
    setTasks((current) => [...current, {
      id: taskId,
      title,
      projectId: receipt.project?.id || null,
      agentId: receipt.agentId || 'general',
      capabilityAdjust: { added: receipt.added || [], removed: receipt.removed || [] },
      status: startNow ? 'running' : 'queued',
      priority: '中',
      session: `文档整理 · ${receipt.source?.title || '当前讨论'}`,
      scope: receipt.scope,
      acceptance: receipt.acceptance,
      reason: startNow ? '已按确认内容开始整理' : `并发名额已满，${state}`,
      next: startNow ? '生成文档初稿' : '获得执行名额后自动开始',
    }]);
    return { taskId, title, state };
  }

  /**
   * 任务在后台完成：成果入库并计为新成果，空出的名额按顺序交给排队任务（静默，只改变数字），
   * 完成本身交给 Multivac 在停顿时合并呈现。
   */
  function completeTask(taskId, output) {
    const task = tasks.find((item) => item.id === taskId);
    setTasks((current) => {
      const next = current.map((item) => item.id === taskId ? { ...item, status: 'done', reason: '已完成并通过自检', next: '查看成果' } : item);
      // 为别人让位的任务先恢复，其次才是排队任务。
      const waiting = [...next.filter((item) => item.status === 'scheduler-paused'), ...next.filter((item) => item.status === 'queued')];
      const free = concurrencyRef.current - next.filter((item) => item.status === 'running').length;
      const promoted = new Set(waiting.slice(0, Math.max(0, free)).map((item) => item.id));
      return next.map((item) => promoted.has(item.id) ? {
        ...item,
        status: 'running',
        reason: item.status === 'scheduler-paused' ? '名额已释放，自动恢复执行' : '获得执行名额，已自动开始',
        next: '建立执行上下文',
      } : item);
    });
    setOutputs((current) => [{ ...output, taskId, updated: '刚刚', at: new Date().toISOString() }, ...current]);
    multivac.announceCompletion({ taskId, title: task?.title || output.title, summary: output.summary, outputId: output.id });
  }

  // 首屏后按演示节奏触发后台完成。
  useEffect(() => {
    const timers = demoCompletions.map((item) => window.setTimeout(() => completeTask(item.taskId, item.output), item.delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  function openOutput(outputId) {
    viewOutput(outputId);
    setAssistantOpen(false);
    navigate('outputs');
  }

  /** 成果交给 Multivac：作为引用放进输入区。工作区里用侧栏，不打断当前现场；其余情况回到 Multivac 对话。 */
  function handOutputToMultivac(output) {
    closeDrawer();
    if (workSurface === 'workspace') setMultivacSidebarOpen(true);
    else setWorkSurface('assistant');
    multivac.handOver({ text: `${output.title}：${output.summary}`, source: { kind: 'output', outputId: output.id, taskId: output.taskId, title: output.title } });
  }

  /** 对话里说到的工作对象：成果按标题重合找（没线索给最近一份），书与笔记按名称线索找。 */
  function findWorkObject(intent, prompt) {
    if (intent.type === 'output') return matchOutput(outputs, prompt);
    if (intent.type === 'book') return matchByTitle(books, intent.query) || (intent.query ? null : books[0]);
    return matchByTitle(notes, intent.query);
  }

  /** 书与笔记直接在当前工作区打开并聚焦，接着上次的状态。 */
  function openWorkObject(objectId) {
    setSessionRequest({ objectId });
    navigate('workspace');
  }

  /** 进入成果现场：在工作区打开成果查看器，来源任务会话作为伴随会话。 */
  function openOutputInWorkspace(outputId) {
    markOutputViewed(outputId);
    setSessionRequest({ outputId });
    navigate('workspace');
  }

  function expandOutputs(outputId) {
    if (outputId) viewOutput(outputId);
    navigate('outputs');
  }

  function summonMultivac() {
    if (!multivacSidebarOpen) multivac.requestFocus();
    setMultivacSidebarOpen(!multivacSidebarOpen);
  }

  /**
   * 用完即收：点回工作对象时，如果 Multivac 已处理完（没有进行中的处理、未发送的草稿、引用或待确认的卡片），
   * 侧栏自动收起；还有没说完的事就保持展开。
   */
  function collapseMultivacWhenIdle(event) {
    if (!multivacSidebarOpen || event.target.closest('.multivac-sidebar')) return;
    if (multivac.running || multivac.draft.trim() || multivac.quote || multivac.receipt) return;
    setMultivacSidebarOpen(false);
  }

  /** “为本项目放开”：取消排除或隐藏，必要时提高项目效果上限；确认卡随即按新边界重新计算。 */
  function releaseCapabilityForProject(projectId, capabilityId) {
    const capability = capabilities.find((item) => item.id === capabilityId);
    if (!capability) return;
    setProjects((current) => current.map((project) => project.id === projectId ? releaseForProject(project, capability, capabilities) : project));
    notify(`已为本项目放开“${capability.name}”，可在“设置 · 项目”中调整边界`);
  }

  /** 确认接入：登记即默认可用，受各项目效果上限约束；需要时一并为当前项目放开。 */
  function connectCapability(spec, projectId) {
    const capability = { ...spec, kind: 'mcp', status: 'connected', lastUsed: '从未使用', lastError: '' };
    setCapabilities((current) => current.some((item) => item.id === spec.id) ? current : [...current, capability]);
    if (projectId) {
      setProjects((current) => current.map((project) => project.id === projectId ? releaseForProject(project, capability, [capability]) : project));
    }
    notify(`已接入 ${spec.name}，各项目默认可用；不需要的项目可以在“设置 · 项目”中排除`);
  }

  const capabilityContext = { capabilities, agents, projects, releaseForProject: releaseCapabilityForProject, connect: connectCapability, references: referenceOptions({ outputs, projects, capabilities }) };

  /** 预填 Multivac 输入框：回到 Multivac 对话，把话术放进输入区等你补全。 */
  function draftToMultivac(text) {
    goHome();
    multivac.setDraft(text);
    multivac.requestFocus();
  }

  function handToMultivac(text, source) {
    multivac.handOver({ text, source });
    setMultivacSidebarOpen(true);
  }

  function notify(message) {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    function toggleWorkspaceNavigation(event) {
      if (!(event.metaKey || event.ctrlKey) || openDrawer || managementMode || workSurface !== 'workspace') return;
      if (event.key === '\\') {
        event.preventDefault();
        setWorkspaceNavigationVisible((current) => !current);
      }
      // ⌘J / Ctrl+J 随时叫出或收起 Multivac。
      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        summonMultivac();
      }
    }
    window.addEventListener('keydown', toggleWorkspaceNavigation);
    return () => window.removeEventListener('keydown', toggleWorkspaceNavigation);
  }, [openDrawer, managementMode, workSurface, multivacSidebarOpen]);

  // 管理模式是“过一遍就走”的集中层：Esc 先收起抽屉，再回到进入前的现场。
  useEffect(() => {
    if (!managementMode) return undefined;
    function leaveManagement(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // 弹层和输入框里的 Esc 只作用于自身，不连带离开管理模式。
      if (document.querySelector('dialog[open], [aria-modal="true"], .model-selector-menu')) return;
      if (event.target.closest?.('input, textarea, select')) return;
      if (assistantOpen) setAssistantOpen(false);
      else setManagementMode(false);
    }
    window.addEventListener('keydown', leaveManagement);
    return () => window.removeEventListener('keydown', leaveManagement);
  }, [managementMode, assistantOpen]);

  function goHome() {
    setManagementMode(false);
    setWorkSurface('assistant');
    setAssistantOpen(false);
  }

  function navigate(target) {
    setOpenDrawer(null);
    if (target === 'assistant' || target === 'workspace') {
      setManagementMode(false);
      setWorkSurface(target);
      setAssistantOpen(false);
      return;
    }
    // 设置内的分区（模型、资料库、记忆）仍可被直接定位，例如模型选择器里的“管理模型配置”。
    if (settingsSections.some((section) => section.id === target)) {
      setSettingsSection(target);
      setPage('settings');
    } else {
      setPage(target);
    }
    setManagementMode(true);
  }

  /**
   * 打开某个抽屉，并关掉另一个。
   * 从一个抽屉里跳到另一个时（如成果里的“去 Inbox 验收”），沿用最初的触发按钮作为焦点归还点。
   */
  function showDrawer(kind) {
    if (!document.activeElement?.closest('dialog')) drawerTrigger.current = document.activeElement;
    setOpenDrawer(kind);
  }

  const closeDrawer = () => setOpenDrawer(null);

  function openInbox() {
    showDrawer('inbox');
  }

  function updateDecisionDraft(id, patch) {
    setDecisionDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  function openTask(taskId, target = 'tasks') {
    setSelectedTaskId(taskId);
    if (target === 'workspace') setSessionRequest({ taskId });
    if (target === 'inbox') {
      const request = requests.find((item) => item.taskId === taskId && item.state !== 'done');
      if (request) setSelectedRequestId(request.id);
      setInboxDetail(true);
      openInbox();
      return;
    }
    if (target === 'outputs') {
      const output = outputs.find((item) => item.taskId === taskId);
      if (output) viewOutput(output.id);
    }
    navigate(target);
  }

  /** 看过即不再算“新成果”，状态摘要的数字随之回落。 */
  function markOutputViewed(outputId) {
    setViewedOutputIds((current) => current.has(outputId) ? current : new Set(current).add(outputId));
  }

  function viewOutput(outputId) {
    setSelectedOutputId(outputId);
    markOutputViewed(outputId);
  }

  function updateTask(taskId, patch) {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task));
  }

  /**
   * “先做这个”：立即执行；满额时让最近开始的一个任务安全让位，不突破并发上限。
   * 返回一句回执，界面操作时以通知呈现，对话里作为回复。
   */
  function doNow(taskId, { silent = false } = {}) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return '';
    if (task.status === 'running') return `“${task.title}”已经在执行了。`;
    const running = tasks.filter((item) => item.status === 'running');
    const pausedTask = running.length >= concurrency ? [...running].reverse().find((item) => item.id !== taskId) : null;
    setTasks((current) => current.map((item) => {
      if (pausedTask && item.id === pausedTask.id) return { ...item, status: 'scheduler-paused', reason: `为“${task.title}”安全让位`, next: '释放名额后自动恢复' };
      if (item.id === taskId) return { ...item, status: 'running', reason: '已按你的要求立即执行', next: '正在建立执行上下文' };
      return item;
    }));
    const message = pausedTask ? `已开始“${task.title}”；并发已满，“${pausedTask.title}”暂时让位，名额释放后自动恢复。` : `已开始“${task.title}”。`;
    if (!silent) notify(message);
    return message;
  }

  /**
   * 对话中的管理动作：效果与管理模式中的操作一致，并给出一句回执。
   * session 是发送时的焦点会话，用来解析“这个”。
   */
  function manageFromChat(intent, session) {
    const findTask = (target) => refersToFocus(target) ? tasks.find((task) => task.id === session?.id) : matchByTitle(tasks, target);
    if (intent.action === 'concurrency') {
      const value = Math.max(1, Math.min(8, intent.value));
      setConcurrency(value);
      return `并发上限已调到 ${value}${value !== intent.value ? '（可选 1–8）' : ''}，当前 ${tasks.filter((task) => task.status === 'running').length} 个在执行。`;
    }
    if (intent.action === 'open-page') {
      navigate(intent.page);
      return `已打开${managementPageLabel(intent.page)}，按 Esc 回到这里。`;
    }
    const task = findTask(intent.target);
    if (!task) return refersToFocus(intent.target) ? '没确定你说的是哪个任务，可以带上任务名再说一次。' : `没找到和“${intent.target}”对应的任务。`;
    if (intent.action === 'do-now') return doNow(task.id, { silent: true });
    if (intent.action === 'pause') {
      if (task.status !== 'running') return `“${task.title}”现在没有在执行（${statusMeta[task.status][0]}）。`;
      updateTask(task.id, { status: 'paused', reason: '由你主动暂停', next: '等待你手动继续' });
      return `已在安全节点暂停“${task.title}”，说“先做${task.title}”即可继续。`;
    }
    if (intent.action === 'no-acceptance') {
      updateTask(task.id, { acceptance: false });
      const pending = requests.some((request) => request.taskId === task.id && request.type === '验收' && request.state !== 'done');
      return `“${task.title}”改为自检通过后自动完成${pending ? '；已经发出的验收请求仍在 Inbox，可以直接接受' : ''}。`;
    }
    return '';
  }


  function resolveRequest(requestId, action, answer = '') {
    const request = requests.find((item) => item.id === requestId);
    if (!request || request.state === 'done' || !canSubmitDecision(request.type, action, answer)) return;
    setRequests((current) => current.map((item) => item.id === requestId ? { ...item, state: 'done', resolution: decisionLabel(request.type, action), answer: answer.trim() } : item));
    if (request.type === '澄清') {
      updateTask(request.taskId, { status: 'queued', reason: action === 'deny' ? '按现有资料继续，等待执行名额' : action === 'custom' ? `按补充范围继续：${answer.trim()}` : '资料范围已确认，等待执行名额', next: '获得名额后继续' });
    } else if (request.type === '验收') {
      updateTask(request.taskId, action === 'accept' ? { status: 'done', reason: '成果已验收', next: '可从成果区继续使用' } : { status: 'queued', reason: `修改意见：${answer.trim()}`, next: '根据反馈修改成果' });
    } else if (request.type === '工具授权') {
      const task = tasks.find((item) => item.id === request.taskId);
      updateTask(request.taskId, action === 'deny' ? { reason: `未获授权：${request.capability}，改用其他方式继续`, next: '调整方案后继续' } : { reason: `已获授权：${request.capability}`, next: '继续执行' });
      // 记住的决定由程序校验，可在“设置 · 能力”中查看和撤销。
      if (action === 'task' || action === 'project') {
        const project = projects.find((item) => item.id === task?.projectId);
        setGrants((current) => [...current, { id: `grant-${Date.now()}`, capability: request.capability, scope: action === 'project' ? '本项目内始终允许' : '本任务内允许', target: action === 'project' ? project?.name || '日常' : task?.title || '', at: '刚刚' }]);
      }
    } else {
      updateTask(request.taskId, { status: 'done', reason: action === 'allow' ? '已授权发布并完成' : '成果已完成，外发已拒绝', next: '无需进一步处理' });
    }
    // 决策结果由详情原位呈现，不用通知覆盖用户的阅读现场。
  }

  // 窄屏只显示日常层（Multivac 对话、Inbox、成果抽屉）；工作区与管理模式给出“请在桌面使用”的说明而非入口。
  // 桌面上的状态（现场、管理页、草稿）照常保留，回到宽屏即恢复。
  const desktopOnly = narrow && (managementMode || workSurface === 'workspace');
  const showManagement = managementMode && !narrow;

  return (
    <div className={`app-shell ${showManagement ? 'management-mode' : 'work-mode'} ${narrow ? 'narrow' : ''}`}>
      <LogoArea managementMode={showManagement} goHome={goHome} />

      <Topbar
        page={page}
        runIndicator={runIndicator}
        concurrency={concurrency}
        openRequests={openRequests.length}
        onOpenInbox={openInbox}
        onOpenOutputs={() => showDrawer('outputs')}
        onOpenTask={openTask}
        onViewRuns={narrow ? null : () => navigate('runs')}
        assistantOpen={assistantOpen}
        setAssistantOpen={setAssistantOpen}
        managementMode={showManagement}
        narrow={narrow}
        workSurface={workSurface}
        onOpenWorkspace={() => setWorkSurface('workspace')}
        onOpenAssistant={() => setWorkSurface('assistant')}
        onOpenManagement={() => setManagementMode(true)}
        onLeaveManagement={() => setManagementMode(false)}
      />

      {showManagement && <Sidebar page={page} onNavigate={navigate} openRequests={openRequests.length} />}

      <main className="content">
        {desktopOnly && (
          <section className="desktop-only" aria-labelledby="desktop-only-title">
            <Columns2 />
            <h2 id="desktop-only-title">{managementMode ? '管理模式' : '工作区'}请在桌面使用</h2>
            <p>窄屏只保留日常层：和 Multivac 对话、处理 Inbox、查看成果。并排、栈式深入和批量管理需要更宽的屏幕。</p>
            <button className="primary" onClick={goHome}><Orbit />回到 Multivac</button>
          </section>
        )}
        <div className="view-surface" hidden={managementMode || workSurface !== 'assistant'}><MultivacConversation conversation={multivac} variant="page" visible={!managementMode && workSurface === 'assistant'} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} onOpenOutput={openOutput} onEnterOutput={openOutputInWorkspace} capabilityContext={capabilityContext} /></div>
        <div className="view-surface" hidden={managementMode || workSurface !== 'workspace' || narrow}>
          <div className={`workspace-shell ${multivacSidebarOpen ? 'with-sidebar' : ''}`} onPointerDownCapture={collapseMultivacWhenIdle}>
            <WorkspaceView tasks={tasks} outputs={outputs} notes={notes} setNotes={setNotes} books={books} documents={initialDocuments} scopeRules={scopeRules} projects={projects} capabilities={capabilities} agents={agents} requests={requests} resolveRequest={resolveRequest} decisionDrafts={decisionDrafts} updateDecisionDraft={updateDecisionDraft} selectedTaskId={selectedTaskId} sessionRequest={sessionRequest} onOpenTask={openTask} notify={notify} navigationVisible={workspaceNavigationVisible} models={modelProfiles} defaultModelId={defaultModelId} manageModels={() => navigate('models')} onFocusChange={setWorkspaceFocus} onHandToMultivac={handToMultivac} />
            <MultivacSidebar open={multivacSidebarOpen} setOpen={setMultivacSidebarOpen} openLabel="Multivac（⌘J）" closeLabel="收起 Multivac（⌘J）" note="处理完、点回工作对象即自动收起">
              <MultivacConversation conversation={multivac} variant="sidebar" visible={!managementMode && workSurface === 'workspace' && multivacSidebarOpen} context={workspaceFocus} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} onOpenOutput={openOutput} onEnterOutput={openOutputInWorkspace} capabilityContext={capabilityContext} />
            </MultivacSidebar>
          </div>
        </div>
        {/* 管理模式里的 Multivac 停靠在右侧并挤压内容，而不是浮层盖住一侧页面。 */}
        {managementMode && (
          <div className={`management-shell ${assistantOpen ? 'with-sidebar' : ''}`} hidden={narrow}>
            <div className="management-page">
              {page === 'tasks' && (
                <TasksView
                  tasks={tasks}
                  projects={projects}
                  selectedTask={selectedTask}
                  setSelectedTaskId={setSelectedTaskId}
                  concurrency={concurrency}
                  setConcurrency={setConcurrency}
                  updateTask={updateTask}
                  doNow={doNow}
                  onOpenSession={(task) => openTask(task.id, 'workspace')}
                  notify={notify}
                />
              )}
              {page === 'runs' && (
                <RunsView
                  tasks={tasks}
                  runIndicator={runIndicator}
                  processes={processes}
                  stopProcess={(processId) => setProcesses((current) => current.filter((item) => item.id !== processId))}
                  concurrency={concurrency}
                  setConcurrency={setConcurrency}
                  updateTask={updateTask}
                  onOpenTask={openTask}
                  notify={notify}
                />
              )}
              {page === 'inbox' && (
                <InboxView
                  requests={requests}
                  tasks={tasks}
                  selectedRequestId={selectedRequestId}
                  setSelectedRequestId={setSelectedRequestId}
                  resolveRequest={resolveRequest}
                  drafts={decisionDrafts}
                  updateDraft={updateDecisionDraft}
                  markSeen={() => setRequests((current) => current.map((request) => request.state === 'new' ? { ...request, state: 'seen' } : request))}
                  onOpenTask={openTask}
                />
              )}
              {page === 'outputs' && (
                <OutputsView
                  outputs={outputs}
                  viewedIds={viewedOutputIds}
                  tasks={tasks}
                  selectedOutputId={selectedOutputId}
                  setSelectedOutputId={viewOutput}
                  onOpenTask={openTask}
                  resolveRequest={resolveRequest}
                  requests={requests}
                  notify={notify}
                />
              )}
              {page === 'settings' && (
                <SettingsView section={settingsSection} setSection={setSettingsSection}>
                  {settingsSection === 'projects' && <ProjectSettings projects={projects} setProjects={setProjects} tasks={tasks} capabilities={capabilities} />}
                  {settingsSection === 'capabilities' && <CapabilitySettings capabilities={capabilities} setCapabilities={setCapabilities} projects={projects} agents={agents} grants={grants} setGrants={setGrants} notify={notify} />}
                  {settingsSection === 'agents' && <AgentSettings agents={agents} setAgents={setAgents} capabilities={capabilities} models={modelProfiles} projects={projects} setProjects={setProjects} tasks={tasks} coordinatorModel={modelProfiles.find((model) => model.id === assistantModelId)?.name} onDraftToMultivac={draftToMultivac} />}
                {settingsSection === 'models' && <ModelSettings models={modelProfiles} setModels={setModelProfiles} defaultModelId={defaultModelId} setDefaultModelId={setDefaultModelId} notify={notify} />}
                  {settingsSection === 'library' && <ScopeSettings rules={scopeRules} setRules={setScopeRules} documents={initialDocuments} books={books} notes={notes} notify={notify} />}
                  {settingsSection === 'memory' && <MemorySettings notify={notify} />}
                </SettingsView>
              )}
            </div>
            {assistantOpen && (
              <MultivacSidebar open setOpen={setAssistantOpen} closeLabel="关闭 Multivac">
                <MultivacConversation conversation={multivac} variant="sidebar" visible={assistantOpen} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} onOpenOutput={openOutput} onEnterOutput={openOutputInWorkspace} capabilityContext={capabilityContext} />
              </MultivacSidebar>
            )}
          </div>
        )}
      </main>

      <SideDrawer open={openDrawer === 'inbox'} close={closeDrawer} trigger={drawerTrigger} labelledBy="inbox-drawer-title">
        <InboxView requests={requests} tasks={tasks} selectedRequestId={selectedRequestId} setSelectedRequestId={setSelectedRequestId} resolveRequest={resolveRequest} onOpenTask={openTask} drafts={decisionDrafts} updateDraft={updateDecisionDraft} compact detailOpen={inboxDetail} setDetailOpen={setInboxDetail} close={closeDrawer} expand={narrow ? null : () => navigate('inbox')} />
      </SideDrawer>
      <SideDrawer open={openDrawer === 'outputs'} close={closeDrawer} trigger={drawerTrigger} labelledBy="outputs-drawer-title">
        <OutputsDrawer
          items={listRecentOutputs(outputs, tasks, viewedOutputIds)}
          close={closeDrawer}
          onPreview={markOutputViewed}
          onHandOver={handOutputToMultivac}
          onEnterScene={(output) => openOutputInWorkspace(output.id)}
          onOpenInbox={(taskId) => openTask(taskId, 'inbox')}
          onExpand={narrow ? null : expandOutputs}
        />
      </SideDrawer>
      {toast && <div className="toast" role="status"><CheckCircle2 />{toast}</div>}
    </div>
  );
}

/**
 * Multivac 侧栏：与首页是同一个对话，收起时只剩一个按钮（不加角标、不显示数字）。
 * 展开状态由 App 持有，进出工作区不丢失。
 */
function MultivacSidebar({ open, setOpen, openLabel = '展开 Multivac', closeLabel = '折叠 Multivac', note = '与首页是同一个对话', children }) {
  if (!open) {
    return (
      <aside className="multivac-sidebar collapsed">
        <IconButton label={openLabel} onClick={() => setOpen(true)}><Orbit /></IconButton>
      </aside>
    );
  }
  return (
    <aside className="multivac-sidebar" aria-label="Multivac">
      <header>
        <div><Orbit /><span><strong>Multivac</strong><small>{note}</small></span></div>
        <IconButton label={closeLabel} onClick={() => setOpen(false)}><PanelLeftClose /></IconButton>
      </header>
      {children}
    </aside>
  );
}

/** 标志即“回到 Multivac”：任何层级点一下都回到日常对话。 */
function LogoArea({ managementMode, goHome }) {
  return (
    <button className={`logo-area ${managementMode ? '' : 'solo'}`} onClick={goHome} aria-label="回到 Multivac" title="回到 Multivac">
      <Orbit />
      <strong>Multivac</strong>
      {managementMode && <span className="mode-label">管理模式</span>}
    </button>
  );
}

function Sidebar({ page, onNavigate, openRequests }) {
  function navButton(item) {
    const Icon = item.icon;
    const badge = item.id === 'inbox' ? openRequests : null;
    return (
      <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)} title={item.label}>
        <Icon />
        <span className="nav-label">{item.label}</span>
        {badge > 0 && <span className="nav-badge">{badge}</span>}
      </button>
    );
  }

  return (
    <aside className="sidebar">
      <nav aria-label="主要导航">
        {managementNav.core.map(navButton)}
        {managementNav.pinnedPlugins.length > 0 && (
          <div className="nav-section" aria-label="已钉住的插件">
            <span className="nav-section-label">已钉住的插件</span>
            {managementNav.pinnedPlugins.map(navButton)}
          </div>
        )}
        <div className="nav-footer">{navButton(managementNav.settings)}</div>
      </nav>
      <div className="sidebar-status">
        <div className="system-line"><span className="live-dot" /><span className="nav-label">本地工作台运行中</span></div>
      </div>
    </aside>
  );
}

/**
 * 运行指示：只用一个状态点和短标签回答“后台是否正常”，不显示任务数量，
 * 避免会变化的数字诱导反复查看。点击弹出小浮层，原地查看，不切换页面。
 */
function RunIndicator({ indicator, concurrency, onOpenTask, onViewRuns }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const popover = useRef(null);
  const label = RUN_INDICATOR_LABELS[indicator.state];
  const summary = describeRunIndicator(indicator);
  const groups = [
    { title: '异常', tasks: indicator.anomalies },
    { title: '执行中', tasks: indicator.running },
  ].filter((group) => group.tasks.length);

  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) root.current?.querySelector('.run-indicator')?.focus();
  }

  // 打开后把焦点交给浮层里的第一项，键盘可以直接上下切换。
  useEffect(() => {
    if (open) popover.current?.querySelector('button')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function dismiss(event) {
      if (event.type === 'keydown' && event.key === 'Escape') {
        // 阻止默认，管理模式的 Esc 返回不会被同一次按键连带触发。
        event.preventDefault();
        close();
      }
      if (event.type === 'pointerdown' && !root.current?.contains(event.target)) {
        // 点到别的可聚焦控件时让焦点留在那里，否则回到触发按钮。
        close({ restoreFocus: !event.target.closest('button, a, input, textarea, select, [tabindex]') });
      }
    }
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [open]);

  function moveFocus(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...popover.current.querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  }

  return (
    <div className="run-indicator-root" ref={root}>
      <IconButton label={`${label}：${summary}`} className={`run-indicator ${indicator.state}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="run-indicator-dot" />
        <span>{label}</span>
      </IconButton>
      {open && (
        <div ref={popover} className="run-popover" role="dialog" aria-label="运行状态" onKeyDown={moveFocus}>
          {/* 并发上限在日常层只出现在这里，管理模式的待办与运行页可以调整。 */}
          <header><strong>{label}</strong><span>{summary}</span><em>并发 {indicator.running.length}/{concurrency}</em></header>
          {groups.length ? groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.tasks.map((task) => (
                <button key={task.id} className="run-popover-row" onClick={() => { close({ restoreFocus: false }); onOpenTask(task.id, 'workspace'); }}>
                  <StatusBadge status={task.status} />
                  <span className="run-popover-text"><strong>{task.title}</strong><small>{task.reason}</small></span>
                  <ArrowRight />
                </button>
              ))}
            </section>
          )) : <p className="run-popover-empty">没有执行中的任务。</p>}
          {onViewRuns && <footer><button className="inline-link" onClick={() => { close({ restoreFocus: false }); onViewRuns(); }}>在管理模式中查看<ArrowRight /></button></footer>}
        </div>
      )}
    </div>
  );
}

/** Inbox 是顶部唯一带数字的元素：需要你行动的事都由它计数，点击在抽屉里原地处理。 */
function InboxButton({ count, compact = false, onOpen }) {
  return (
    <button className={`inbox-summary ${compact ? 'compact' : ''}`} aria-label={`Inbox，${count} 项待处理`} title="打开 Inbox" onClick={onOpen}>
      <Inbox />
      <strong>{count}</strong>
      {!compact && <span>项待处理</span>}
    </button>
  );
}

function Topbar({ page, runIndicator, concurrency, openRequests, onOpenInbox, onOpenOutputs, onOpenTask, onViewRuns, assistantOpen, setAssistantOpen, managementMode, narrow = false, workSurface, onOpenWorkspace, onOpenAssistant, onOpenManagement, onLeaveManagement }) {
  if (!managementMode) {
    return (
      <header className="topbar">
        <div className="topbar-left" />
        <div className="topbar-actions">
          <RunIndicator indicator={runIndicator} concurrency={concurrency} onOpenTask={onOpenTask} onViewRuns={onViewRuns} />
          {/* 成果是取回入口，不是通知：不显示数字，也不加提示点。 */}
          <IconButton label="打开成果" className="outputs-entry" onClick={onOpenOutputs}><Archive /></IconButton>
          <InboxButton count={openRequests} compact onOpen={onOpenInbox} />
          {/* 窄屏不提供工作区与管理模式的入口。 */}
          {!narrow && <>
            <span className="topbar-divider" aria-hidden="true" />
            {workSurface === 'assistant'
              ? <button className="topbar-button" onClick={onOpenWorkspace}><Columns2 />进入工作区</button>
              : <button className="topbar-button" onClick={onOpenAssistant}><Orbit />返回 Multivac</button>}
            <button className="topbar-button" onClick={onOpenManagement}><LayoutDashboard />管理</button>
          </>}
        </div>
      </header>
    );
  }
  // 管理模式是集中处理层，适合看数字；执行数与运行指示同源。
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="page-identity"><span>{managementPageLabel(page)}</span></div>
      </div>
      <div className="topbar-actions">
        <div className="capacity-control" title="当前任务并发"><span className="live-dot" /><strong>{runIndicator.running.length}/{concurrency}</strong><span>执行中</span></div>
        <InboxButton count={openRequests} onOpen={onOpenInbox} />
        <span className="topbar-divider" aria-hidden="true" />
        <button className={`topbar-button ${assistantOpen ? 'active' : ''}`} aria-expanded={assistantOpen} onClick={() => setAssistantOpen(!assistantOpen)}><Orbit />Multivac</button>
        <button className="topbar-button leave-management" onClick={onLeaveManagement} title="返回进入管理前的现场"><kbd>Esc</kbd>返回</button>
      </div>
    </header>
  );
}

function PageIntro({ eyebrow, title, description, actions }) {
  return (
    <div className="page-intro">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

function ModelSelector({ models, modelId, setModelId, thinkingLevel, setThinkingLevel, manageModels, compact = false }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = models.find((model) => model.id === modelId) || models.find((model) => model.configured) || models[0];
  const reasoning = resolveReasoning(selected);
  // 会话保存的是偏好，这里显示按模型当前能力实际生效的等级。
  const effective = effectiveThinking(thinkingLevel, selected);

  useEffect(() => {
    function dismiss(event) {
      if (event.key === 'Escape') setOpen(false);
      if (event.type === 'pointerdown' && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, []);

  function chooseModel(model) {
    if (!model.configured) {
      setOpen(false);
      manageModels();
      return;
    }
    // 不改写会话的推理偏好：换到不支持推理的模型时实际按“关闭”发送，之后能力变了会自动恢复。
    setModelId(model.id);
    setOpen(false);
  }

  return (
    <div ref={root} className={`model-selector ${compact ? 'compact' : ''}`}>
      <button className="model-selector-trigger" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={`${selected.provider} / ${selected.modelId}`}><Cpu /><span>{selected.name}</span><small>{thinkingLabels[effective] || effective}</small><ChevronDown /></button>
      {open && <div className="model-selector-menu"><div className="model-selector-heading"><span>当前会话模型</span><strong>{selected.name}</strong></div><div className="model-options">{models.map((model) => <button key={model.id} className={model.id === selected.id ? 'selected' : ''} onClick={() => chooseModel(model)}><Cpu /><span><strong>{model.name}</strong><small>{model.provider} / {model.modelId}</small></span>{model.configured ? model.id === selected.id && <Check /> : <em>未配置</em>}</button>)}</div><label className="thinking-select"><span>推理等级</span><select value={effective} disabled={!reasoning.supported} onChange={(event) => setThinkingLevel(event.target.value)}>{reasoning.levels.map((level) => <option key={level} value={level}>{thinkingLabels[level] || level}</option>)}</select></label>{!reasoning.supported && <p className="thinking-hint">该模型不支持推理（来源：{reasoning.source}），可在模型配置中调整。</p>}<button className="manage-models-link" onClick={() => { setOpen(false); manageModels(); }}><Settings2 />管理模型配置<ArrowRight /></button></div>}
    </div>
  );
}

const activeRunPhases = new Set(['accepted', 'handed', 'processing', 'tool', 'retry', 'compaction']);

function RunStatus({ feedback, stop, compact = false }) {
  if (!feedback || feedback.phase === 'idle') return null;
  const active = activeRunPhases.has(feedback.phase);
  const Icon = active ? LoaderCircle : feedback.phase === 'succeeded' ? CheckCircle2 : feedback.phase === 'failed' ? CircleAlert : CircleStop;
  return <div className={`run-feedback ${feedback.phase} ${compact ? 'compact' : ''}`} role="status"><Icon className={active ? 'status-spinner' : ''} /><span>{feedback.message}</span>{active && stop && <button onClick={stop}><CircleStop />停止</button>}</div>;
}

/** 轨迹首条记录本轮实际使用的模型与推理等级，便于确认改设置后是否已生效。 */
function runSettingsEntry(run) {
  if (!run) return [];
  return [{ kind: 'thought', text: `本轮使用 ${run.model} · 推理${run.thinking === 'off' ? '关闭' : `等级：${thinkingLabels[run.thinking] || run.thinking}`}` }];
}

const multivacSeedMessages = [
  { who: 'assistant', text: '下午好。当前有 4 个任务在执行，3 项需要你处理。你可以继续当前工作，我会把需要判断的事项集中起来。' },
  { who: 'user', text: '先把界面原型的核心体验走通，暂时不要扩展真实执行能力。' },
  { id: 'demo-prototype-review', who: 'trace', trace: true, status: 'done', duration: '用时 18 秒', defaultOpen: true, capabilities: ['只读查询'], entries: [
    { kind: 'thought', text: '先核对协调助手现有的信息层级，确认工作过程与最终回复需要分开呈现。' },
    { kind: 'tool', tool: 'read', action: '读取 .my-docs/mvp.html', status: 'done' },
    { kind: 'thought', text: '现有工具记录可以直接纳入本轮过程，不需要再增加单条展开层级。' },
    { kind: 'tool', tool: 'read', action: '对照原型交互清单', status: 'done' },
  ] },
  { who: 'assistant', text: '明白。我会优先保持助手会话为主，只在你进入工作台时展示会话集合和任务状态。需要你判断的内容仍集中到 Inbox。' },
];

/** 标题加引号；已自带「」或《》的（如 笔记「周报」、《书名》）原样显示，避免套两层。 */
const quoted = (title) => /[「《]/u.test(title) ? title : `「${title}」`;

function excerptOf(text, limit = 36) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/**
 * Multivac 对话全局唯一。
 *
 * 首页、工作区侧栏、管理模式抽屉渲染的是同一份状态，而不是三个各说各话的助手；
 * 模拟运行的计时器也只在这里维护一份，任何一处发出的消息在其余两处同样可见。
 */
function useMultivacConversation({ onCreateTask, queueHint, projectHint, findObject, openObject, createProject, findSkill, prepareConnection, manage }) {
  const [messages, setMessages] = useState(multivacSeedMessages);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [runFeedback, setRunFeedback] = useState({ phase: 'idle', message: '' });
  const [focusToken, setFocusToken] = useState(0);
  // 待呈现的完成事件：不逐条插话，在对话停顿或下一次发消息时合并成一张完成卡。
  const pendingCompletions = useRef([]);
  const [pendingCount, setPendingCount] = useState(0);
  const timers = useRef([]);
  const activeTraceId = useRef(null);
  // 计时器回调里读取最新的调度与建任务逻辑，避免闭包停在发送那一刻。
  const onCreateTaskRef = useRef(onCreateTask);
  const queueHintRef = useRef(queueHint);
  const projectHintRef = useRef(projectHint);
  projectHintRef.current = projectHint;
  const intentsRef = useRef({ findObject, openObject, createProject, findSkill, prepareConnection, manage });
  intentsRef.current = { findObject, openObject, createProject, findSkill, prepareConnection, manage };
  onCreateTaskRef.current = onCreateTask;
  queueHintRef.current = queueHint;
  const running = activeRunPhases.has(runFeedback.phase);

  function clearRunTimers() {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  }

  function later(delay, callback) {
    const timer = window.setTimeout(callback, delay);
    timers.current.push(timer);
  }

  function updateTrace(id, updater) {
    setMessages((current) => current.map((message) => message.id === id ? updater(message) : message));
  }

  /** 确认卡的“这个”按引用来源解析：优先选中内容所在会话，其次当前焦点会话。 */
  function buildReceipt(context) {
    const source = context.quote?.source || context.session || null;
    const excerpt = context.quote?.text || '';
    // “/Skill 名”显式调用：确认卡把该 Skill 加进将用到的能力。
    const skill = context.skill ? intentsRef.current.findSkill(context.skill) : null;
    const goal = source ? `把「${source.title}」中${excerpt ? '选中的这段内容' : '当前讨论'}整理成结构化文档` : '把当前讨论整理成结构化文档';
    return {
      goal: skill ? `用「${skill.name}」Skill ${goal}` : goal,
      added: skill ? [skill.id] : [],
      scope: source ? `「${source.title}」${excerpt ? '选中内容' : '会话内容'} + 项目术语表` : '当前对话',
      source,
      excerpt,
      acceptance: true,
      // 执行智能体按工作类型自动选择：调研类用“研究”，其余用“通用执行”，确认卡上可以改。
      agentId: /调研|研究|论文|资料/u.test(context.prompt || '') ? 'research' : 'general',
      // 选中内容带 sessionId，焦点会话带 id，成果引用带来源任务 taskId；都指向一个任务会话。
      project: source ? projectHintRef.current(source.sessionId || source.id || source.taskId) : null,
      state: queueHintRef.current(),
    };
  }

  function finishRun(prompt, traceId, context) {
    updateTrace(traceId, (trace) => ({
      ...trace,
      status: 'done',
      duration: `用时 ${Math.max(1, Math.round((Date.now() - trace.startedAt) / 1000))} 秒`,
      entries: trace.entries.map((entry) => entry.kind === 'tool' && entry.status === 'running' ? { ...entry, status: 'done' } : entry),
    }));
    activeTraceId.current = null;
    const intent = parseAssistantIntent(prompt);
    // 协调者只用内部工具与只读查询，有副作用的操作转交任务会话。
    const used = { project: ['管理项目（内部工具）'], open: ['查找工作对象（内部工具）'], task: ['创建待办（内部工具）'], connect: ['能力登记（内部工具）'], manage: ['调整待办（内部工具）'] }[intent.kind] || [];
    if (used.length) updateTrace(traceId, (trace) => ({ ...trace, capabilities: [...(trace.capabilities || []), ...used] }));
    if (intent.kind === 'project') {
      const result = intentsRef.current.createProject(intent.path);
      setMessages((current) => [...current, { who: 'assistant', text: result.created
        ? `已创建项目「${result.name}」，挂载 ${intent.path}，并带上同名工作区。目录内的本地更新可以自动执行，目录外的修改会先问你。`
        : `${intent.path} 已经挂载在项目「${result.name}」里，不用重复创建。` }]);
    } else if (intent.kind === 'open') {
      // 对话仍是第一入口：成果在回复里带上成果卡；书与笔记直接在工作区打开，接着上次的状态。
      const found = intentsRef.current.findObject(intent, prompt);
      if (intent.type === 'output') {
        setMessages((current) => [...current, found
          ? { id: `output-${Date.now()}`, kind: 'output', text: '找到了，是这一份：', output: found }
          : { who: 'assistant', text: '还没有相关的成果。任务完成后，成果会出现在顶部的成果抽屉里。' }]);
      } else if (found) {
        intentsRef.current.openObject(`${intent.type}:${found.id}`);
        setMessages((current) => [...current, { who: 'assistant', text: intent.type === 'book' ? `已在工作区打开《${found.title}》，接着你上次读到的位置。` : `已在工作区打开「${found.title}」。` }]);
      } else {
        setMessages((current) => [...current, { who: 'assistant', text: `没找到${intent.type === 'book' ? '这本书' : '这篇笔记'}。可以在工作区的「打开…」里浏览书架和笔记库。` }]);
      }
    } else if (intent.kind === 'manage') {
      // 管理动作：直接生效，回复一句简短回执。
      setMessages((current) => [...current, { who: 'assistant', text: intentsRef.current.manage(intent, context.session) }]);
    } else if (intent.kind === 'connect') {
      // 通过对话接入能力：先给接入确认卡，确认后才登记。
      const connection = intentsRef.current.prepareConnection(intent.name);
      setMessages((current) => [...current, connection.existing
        ? { who: 'assistant', text: `${connection.existing.name} 已经接入${connection.existing.status === 'connected' ? '' : '，但当前连接异常，可以在“设置 · 能力”里测试连接'}。需要的话可以在确认卡上为项目开启。` }
        : connection.spec
          ? { id: `connect-${Date.now()}`, kind: 'connect', spec: connection.spec, project: context.session ? projectHintRef.current(context.session.id) : null, state: 'pending' }
          : { who: 'assistant', text: `还没有找到名为“${intent.name}”的服务。可以在“设置 · 能力”里粘贴标准 MCP 配置接入。` }]);
    } else if (intent.kind === 'task') {
      setReceipt(buildReceipt({ ...context, prompt, skill: intent.skill }));
    } else {
      setMessages((current) => [...current, { who: 'assistant', text: '我会把这项调整应用到相关工作。已明确的信息不会重复询问；需要你判断的事项仍会进入 Inbox。' }]);
    }
    setRunFeedback({ phase: 'succeeded', message: '处理完成' });
    later(1800, () => setRunFeedback({ phase: 'idle', message: '' }));
  }

  function startRun(prompt, steering, traceId, context) {
    clearRunTimers();
    if (activeTraceId.current) {
      const interruptedId = activeTraceId.current;
      updateTrace(interruptedId, (trace) => ({ ...trace, status: 'cancelled', duration: '已停止', entries: [...trace.entries, { kind: 'thought', text: '收到补充指令，本轮过程已停止并转入新的处理回合。' }] }));
    }
    activeTraceId.current = traceId;
    setRunFeedback(steering ? { phase: 'processing', message: '已补充指令，继续处理' } : { phase: 'accepted', message: '消息已接收' });
    if (!steering) later(650, () => setRunFeedback({ phase: 'handed', message: '消息已交给 Pi' }));
    later(steering ? 650 : 1100, () => {
      updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { kind: 'thought', text: context.quote?.source ? `已结合「${context.quote.source.title}」中选中的内容判断需要核对的信息。` : '已结合当前会话判断需要核对的信息和下一步动作。' }] }));
      setRunFeedback({ phase: 'processing', message: 'Multivac 正在处理' });
    });
    if (/文件|代码|文档|检查|运行|测试|报告|成果|项目/u.test(prompt)) {
      const toolName = /运行|测试|检查/u.test(prompt) ? '运行检查' : '读取工作区资料';
      const toolId = `${traceId}-tool`;
      later(1850, () => {
        updateTrace(traceId, (trace) => ({ ...trace, capabilities: ['只读查询'], entries: [...trace.entries, { id: toolId, kind: 'tool', tool: toolName === '运行检查' ? 'run' : 'read', action: toolName, status: 'running' }] }));
        setRunFeedback({ phase: 'tool', message: `正在使用 ${toolName}` });
      });
      later(2850, () => {
        updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries.map((entry) => entry.id === toolId ? { ...entry, status: 'done' } : entry), { kind: 'thought', text: '相关信息已核对，正在整理成直接回复。' }] }));
        setRunFeedback({ phase: 'processing', message: '工具执行完成，继续处理' });
      });
      later(3900, () => finishRun(prompt, traceId, context));
    } else {
      later(2100, () => updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { kind: 'thought', text: '响应重点已经整理完成。' }] })));
      later(2900, () => finishRun(prompt, traceId, context));
    }
  }

  function announceCompletion(item) {
    pendingCompletions.current = [...pendingCompletions.current, item];
    setPendingCount(pendingCompletions.current.length);
  }

  /** 紧跟在上一张完成卡后面的完成并入同一张卡，避免连续几张卡刷屏。 */
  function flushCompletions() {
    const items = pendingCompletions.current;
    if (!items.length) return;
    pendingCompletions.current = [];
    setPendingCount(0);
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.kind === 'completion') return [...current.slice(0, -1), { ...last, items: [...last.items, ...items] }];
      return [...current, { id: `completion-${Date.now()}`, kind: 'completion', items }];
    });
  }

  // 停顿 = 没有在处理、输入区也没有正在写的内容。
  useEffect(() => {
    if (!pendingCount || running || draft.trim()) return undefined;
    const timer = window.setTimeout(flushCompletions, 1200);
    return () => window.clearTimeout(timer);
  }, [pendingCount, running, draft]);

  /** context.session 是发送时所在现场的焦点会话，用来解析“这个”。 */
  function send(context = {}) {
    const prompt = draft.trim();
    if (!prompt) return;
    flushCompletions();
    const traceId = crypto.randomUUID();
    const sentQuote = quote;
    setMessages((current) => [...current, { who: 'user', text: prompt, quote: sentQuote }, { id: traceId, who: 'trace', trace: true, status: 'running', startedAt: Date.now(), entries: [...runSettingsEntry(context.run), { kind: 'thought', text: running ? '正在吸收补充指令，并重新调整本轮处理重点。' : '正在理解这条指令，并确定需要核对的上下文。' }] }]);
    setDraft('');
    setQuote(null);
    startRun(prompt, running, traceId, { quote: sentQuote, session: context.session || null });
  }

  function stop() {
    clearRunTimers();
    if (activeTraceId.current) {
      const cancelledId = activeTraceId.current;
      updateTrace(cancelledId, (trace) => ({ ...trace, status: 'cancelled', duration: '已停止', entries: [...trace.entries, { kind: 'thought', text: '已按要求停止处理。' }] }));
      activeTraceId.current = null;
    }
    setRunFeedback({ phase: 'cancelled', message: '处理已取消' });
    later(1800, () => setRunFeedback({ phase: 'idle', message: '' }));
  }

  /** 确认后卡片就地变成回执，不弹 toast，也不再追加一条“任务已创建”的消息。 */
  /** execution：确认卡上选定的执行智能体与临时增减的能力。 */
  function confirmReceipt(acceptance, execution = {}) {
    if (!receipt) return;
    const created = onCreateTaskRef.current({ ...receipt, acceptance, ...execution });
    setMessages((current) => [...current, { id: `receipt-${created.taskId}`, kind: 'receipt', receipt: { ...receipt, acceptance, ...execution, ...created } }]);
    setReceipt(null);
  }

  /** 卡片内的决定（如接入确认）原位更新这条消息。 */
  function settleMessage(id, patch) {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, ...patch } : message));
  }

  /** 叫出 Multivac 时请求可见实例把焦点放进输入区。 */
  function requestFocus() {
    setFocusToken((current) => current + 1);
  }

  /** 从工作区带着选中内容交给 Multivac：引用写入输入区，并请求侧栏聚焦。 */
  function handOver(nextQuote) {
    setQuote(nextQuote);
    setFocusToken((current) => current + 1);
  }

  useEffect(() => () => clearRunTimers(), []);

  return {
    messages, draft, setDraft, quote, setQuote, receipt, runFeedback, running, focusToken,
    send, stop, confirmReceipt, dismissReceipt: () => setReceipt(null), handOver, announceCompletion, requestFocus, settleMessage,
  };
}

// 可以 @ 引用的对象：文件、成果、项目、已接入 MCP 服务提供的资源（原型中的示例数据）。
const REFERENCE_FILES = ['mvp.html', 'personal-agent-requirements.html', 'PROJECT_CONSTRAINTS.md'];
const MCP_RESOURCES = { github: ['PR #42 恢复状态机修复', 'Issue #17 会话恢复不一致'], calendar: ['周三 10:00 原型评审'] };

/** 汇总 @ 候选；只列出已接入且连接正常的 MCP 服务的资源。 */
function referenceOptions({ outputs, projects, capabilities }) {
  const connected = capabilities.filter((item) => item.kind === 'mcp' && item.status === 'connected').map((item) => item.id);
  return [
    ...REFERENCE_FILES.map((name) => ({ group: '文件', label: name, token: `@${name}` })),
    ...outputs.map((output) => ({ group: '成果', label: output.title, token: `@成果:${output.title.replace(/\s+/gu, '')}` })),
    ...Object.entries(MCP_RESOURCES).filter(([id]) => connected.includes(id)).flatMap(([id, items]) => items.map((label) => ({ group: capabilities.find((item) => item.id === id).name, label, token: `@${label.split(' ').slice(0, 2).join('')}` }))),
    ...projects.map((project) => ({ group: '项目', label: project.name, token: `@项目:${project.name.replace(/\s+/gu, '')}` })),
  ];
}

/**
 * 输入区的 / 与 @：行首的 / 列出 Skill，@ 列出可引用的对象。默认靠自动匹配，
 * 这里只用于你想明确指定时；方向键选择，Enter / Tab 确认，Esc 关闭。
 */
function useComposerPicker({ draft, setDraft, textareaRef, skills, references }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const trigger = composerTrigger(draft);
  const pool = trigger?.kind === 'skill' ? skills.map((skill) => ({ group: 'Skill', label: skill.name, hint: skill.description, token: `/${skill.name}` })) : references;
  const items = trigger && dismissed !== draft ? pool.filter((item) => item.label.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 12) : [];
  const open = items.length > 0;

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query]);

  function pick(item) {
    setDraft(applyComposerPick(draft, trigger, item.token));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function onKeyDown(event) {
    if (!open) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
      event.preventDefault();
      pick(items[activeIndex] || items[0]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(draft);
      return true;
    }
    return false;
  }

  /** “@ 引用”按钮：在输入末尾插入 @ 并聚焦，候选随即出现。 */
  function startReference() {
    setDismissed('');
    setDraft(draft && !/\s$/u.test(draft) ? `${draft} @` : `${draft}@`);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const popup = open && (
    <div className="composer-picker" role="listbox" aria-label={trigger.kind === 'skill' ? '选择 Skill' : '选择要引用的对象'}>
      {items.map((item, index) => (
        <button type="button" key={`${item.group}-${item.label}`} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(item)}>
          <em>{item.group}</em><strong>{item.label}</strong>{item.hint && <small>{item.hint}</small>}
        </button>
      ))}
    </div>
  );

  return { popup, onKeyDown, startReference };
}

/** 消息里的 /Skill 与 @引用 显示为标记，便于一眼看出调用了什么、引用了什么。 */
function MessageText({ text }) {
  return text.split(/(^\/\S+|@\S+)/u).filter(Boolean).map((part, index) => /^[/@]/u.test(part) ? <span key={index} className="message-token">{part}</span> : part);
}

function MessageQuote({ quote }) {
  return (
    <blockquote className="message-quote">
      <Quote />
      <span>{quote.source && <cite>{quote.source.kind === 'output' ? '成果' : '来自'}{quoted(quote.source.title)}</cite>}{quote.text}</span>
    </blockquote>
  );
}

/**
 * Multivac 对话的呈现层。
 *
 * variant 决定外形：page 是首页整页，sidebar 是工作区与管理模式里停靠在右侧的侧栏。
 * 选区、滚动跟随这类纯界面状态每个实例各自持有；对话内容全部来自共享的 conversation。
 */
function MultivacConversation({ conversation, variant = 'page', visible = true, context = null, models, modelId, setModelId, thinkingLevel, setThinkingLevel, manageModels, onOpenTask, onOpenOutput, onEnterOutput, capabilityContext }) {
  const { messages, draft, setDraft, quote, setQuote, receipt, runFeedback, running } = conversation;
  const [selection, setSelection] = useState(null);

  const messagesRef = useRef(null);
  const composerRef = useRef(null);
  const picker = useComposerPicker({
    draft,
    setDraft,
    textareaRef: composerRef,
    skills: capabilityContext.capabilities.filter((item) => item.kind === 'skill'),
    references: capabilityContext.references,
  });
  const isPage = variant === 'page';
  const { handleScroll, followLatest } = useStickToBottom(messagesRef, [messages, receipt, runFeedback.phase, visible]);

  // 交接（选中内容或成果交给 Multivac）只由当前可见的实例接住焦点。
  useEffect(() => {
    if (!visible || !conversation.focusToken) return;
    followLatest();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [conversation.focusToken]);

  function submit() {
    followLatest();
    const model = models.find((item) => item.id === modelId) || models[0];
    conversation.send({ session: context, run: { model: model.name, thinking: effectiveThinking(thinkingLevel, model) } });
  }

  function captureSelection() {
    const current = window.getSelection();
    const selectedText = current?.toString().replace(/\s+/g, ' ').trim();
    if (!selectedText || !current.rangeCount) {
      setSelection(null);
      return;
    }
    const range = current.getRangeAt(0);
    if (!messagesRef.current?.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    const toolbarWidth = 92;
    setSelection({
      text: selectedText,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - toolbarWidth - 12)),
      top: Math.min(rect.bottom + 8, window.innerHeight - 48),
    });
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function continueFromOutput(output) {
    setQuote({ text: `${output.title}：${output.summary}`, source: { kind: 'output', outputId: output.id, taskId: output.taskId, title: output.title } });
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function quoteSelection() {
    setQuote({ text: selection.text, source: null });
    clearSelection();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  const stream = (
    <div ref={messagesRef} className="message-stream" onScroll={handleScroll} onMouseUp={captureSelection}>
      {messages.map((message, index) => {
        if (message.trace) return <RunTrace key={message.id} trace={message} />;
        if (message.tool) return <ToolResult key={message.id} message={message} />;
        if (message.kind === 'receipt') return <ConfirmedReceipt key={message.id} receipt={message.receipt} onOpenTask={onOpenTask} />;
        if (message.kind === 'completion') return <CompletionCard key={message.id} items={message.items} onOpenTask={onOpenTask} onOpenOutput={onOpenOutput} />;
        if (message.kind === 'connect') return <ConnectCard key={message.id} message={message} onConnect={(enableProject) => { capabilityContext.connect(message.spec, enableProject ? message.project?.id : null); conversation.settleMessage(message.id, { state: enableProject ? 'enabled' : 'connected' }); }} onCancel={() => conversation.settleMessage(message.id, { state: 'cancelled' })} />;
        if (message.kind === 'output') return <OutputReply key={message.id} message={message} onEnterOutput={onEnterOutput} onOpenOutput={onOpenOutput} onContinue={() => continueFromOutput(message.output)} />;
        return (
          <div key={index} className={`chat-row ${message.who}`}>
            <span className="avatar">{message.who === 'assistant' ? <Orbit /> : '你'}</span>
            <div className="chat-content">{message.quote && <MessageQuote quote={message.quote} />}<p><MessageText text={message.text} /></p></div>
          </div>
        );
      })}
      {receipt && <TaskReceipt receipt={receipt} capabilityContext={capabilityContext} onConfirm={conversation.confirmReceipt} />}
    </div>
  );

  const composer = (
    <div className="assistant-composer">
      <RunStatus feedback={runFeedback} stop={conversation.stop} />
      {quote && <div className="composer-quote"><Quote /><div><span>{quote.source?.kind === 'output' ? '引用成果' : '引用选中内容'}</span>{quote.source && <small className="quote-source">{quote.source.kind === 'output' ? '成果' : '来自'}{quoted(quote.source.title)}</small>}<p>{quote.text}</p></div><IconButton label="移除引用" onClick={() => setQuote(null)}><X /></IconButton></div>}
      {!quote && context && <div className="composer-context"><Columns2 /><span>正在看{quoted(context.title)}，可以直接说“这个”</span></div>}
      {picker.popup}
      <textarea ref={composerRef} aria-label="发送给 Multivac" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={quote ? (quote.source?.kind === 'output' ? '基于这份成果继续…' : '基于这段内容继续讨论…') : isPage ? '安排工作，或继续讨论…（/ 调用 Skill，@ 引用）' : '顺手安排工作，当前现场保持不动…'} onKeyDown={(event) => { if (picker.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } }} />
      <div className="composer-bar">
        <div><ModelSelector models={models} modelId={modelId} setModelId={setModelId} thinkingLevel={thinkingLevel} setThinkingLevel={setThinkingLevel} manageModels={manageModels} compact={!isPage} />{isPage && <><button className="text-button" onClick={picker.startReference}><AtSign />引用</button><button className="text-button"><ShieldCheck />范围：当前会话</button></>}</div>
        <IconButton label={running ? '补充指令' : '发送'} disabled={!draft.trim()} className="send-button" onClick={submit}><ArrowRight /></IconButton>
      </div>
    </div>
  );

  const toolbar = selection && <div className="selection-toolbar assistant-selection-toolbar" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()}><button onClick={quoteSelection}><Quote />引用</button><IconButton label="关闭" onClick={clearSelection}><X /></IconButton></div>;

  if (isPage) {
    return <div className="assistant-page"><section className="assistant-conversation">{stream}{toolbar}{composer}</section></div>;
  }
  return <div className={`multivac-panel ${variant}`}>{stream}{toolbar}{composer}</div>;
}

function TaskReceipt({ receipt, capabilityContext, onConfirm }) {
  const [acceptance, setAcceptance] = useState(receipt.acceptance);
  const [agentId, setAgentId] = useState(receipt.agentId || 'general');
  const [added, setAdded] = useState(receipt.added || []);
  const [removed, setRemoved] = useState([]);
  const { capabilities, agents, projects, releaseForProject } = capabilityContext;
  const agent = agents.find((item) => item.id === agentId) || agents[0];
  // 项目许可以当前设置为准（刚“为本项目开启”的能力立即生效）。
  const project = receipt.project ? projects.find((item) => item.id === receipt.project.id) : null;
  const { usable, blocked } = resolveCapabilities({ registry: capabilities, project, agent, added, removed });
  // 能力默认可用：可临时增加的是这里可用、但这类任务平时不用的能力。
  const { available } = resolveAvailability({ registry: capabilities, project, agent });
  // 只看项目边界时可用的能力：用来区分“项目不允许”与“智能体上限不够”。
  const projectAvailable = resolveAvailability({ registry: capabilities, project, agent: null }).available.map((capability) => capability.id);
  const addable = available.filter((capability) => !usable.includes(capability));
  const agentWants = (id) => (agent.requiredServices || []).includes(id) || (agent.preferredSkills || []).includes(id);

  function removeCapability(id) {
    setAdded((current) => current.filter((item) => item !== id));
    if (agentWants(id)) setRemoved((current) => [...current, id]);
  }

  function addCapability(id) {
    setRemoved((current) => current.filter((item) => item !== id));
    if (!agentWants(id)) setAdded((current) => [...current, id]);
  }

  return (
    <div className="task-receipt">
      <div className="receipt-title"><CheckCircle2 /><div><strong>准备创建任务</strong><span>请确认我理解得是否正确</span></div></div>
      <dl>
        <div><dt>目标</dt><dd>{receipt.goal}</dd></div>
        {receipt.source && <div><dt>来源</dt><dd className="receipt-source"><strong>「{receipt.source.title}」</strong>{receipt.excerpt && <q>{excerptOf(receipt.excerpt)}</q>}</dd></div>}
        <div><dt>项目</dt><dd>{projectLabel(receipt.project)}</dd></div>
        <div><dt>资料</dt><dd>{receipt.scope}</dd></div>
        <div><dt>执行</dt><dd><select className="receipt-agent" aria-label="执行智能体" value={agentId} onChange={(event) => { setAgentId(event.target.value); setAdded([]); setRemoved([]); }}>{agents.filter((item) => !item.fixed).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></dd></div>
        <div><dt>能力</dt><dd className="receipt-capabilities">
          {usable.map((capability) => <span key={capability.id} className="capability-chip">{capability.name}<small>{capability.kind === 'skill' ? 'Skill' : EFFECT_LABELS[capabilityEffect(capability)]}</small><button type="button" aria-label={`本次不用${capability.name}`} onClick={() => removeCapability(capability.id)}><X /></button></span>)}
          {addable.length > 0 && <select className="capability-add-select" aria-label="增加能力" value="" onChange={(event) => addCapability(event.target.value)}><option value="">+ 能力</option>{addable.map((capability) => <option key={capability.id} value={capability.id}>{capability.name}</option>)}</select>}
          {/* 冲突时说清楚原因，不静默降级也不静默越权。只有项目边界造成的才提供“为本项目放开”；
              受智能体自身上限限制的，放开项目也无济于事，提示改换智能体。 */}
          {blocked.map(({ capability, reason }) => {
            const agentLimited = projectAvailable.includes(capability.id);
            return (
              <span key={capability.id} className="capability-blocked">
                <strong>{capability.name}</strong>{agentLimited ? `受「${agent.name}」的效果上限（${EFFECT_LABELS[agent.effectCap]}）限制，可改用其他智能体` : reason}
                {project && !agentLimited && reason !== '服务未连接' && <button type="button" className="inline-link" onClick={() => releaseForProject(project.id, capability.id)}>为本项目放开</button>}
              </span>
            );
          })}
        </dd></div>
        <div><dt>调度</dt><dd>{receipt.state}</dd></div>
      </dl>
      <label className="checkbox-row"><input type="checkbox" checked={acceptance} onChange={(event) => setAcceptance(event.target.checked)} /><span><Check />完成后需要我验收</span></label>
      <div className="receipt-actions"><button className="secondary">调整</button><button className="primary" onClick={() => onConfirm(acceptance, { agentId, agentName: agent.name, added, removed })}>确认并执行</button></div>
    </div>
  );
}

function ConfirmedReceipt({ receipt, onOpenTask }) {
  return (
    <div className="task-receipt confirmed">
      <CheckCircle2 />
      <div>
        <strong>已创建：{receipt.title}</strong>
        <span>{receipt.state}{receipt.agentName ? ` · 执行：${receipt.agentName}` : ''}{receipt.source ? ` · 来源「${receipt.source.title}」` : ''}{receipt.acceptance ? ' · 完成后需要你验收' : ''}</span>
      </div>
      <button className="inline-link" onClick={() => onOpenTask(receipt.taskId, 'tasks')}>查看待办<ArrowRight /></button>
    </div>
  );
}

/** 对话里取回的成果：回复里直接带成果卡，可基于它继续、进入现场或在成果页打开。 */
function OutputReply({ message, onEnterOutput, onOpenOutput, onContinue }) {
  const { output } = message;
  const Icon = output.icon;
  return (
    <div className="chat-row assistant">
      <span className="avatar"><Orbit /></span>
      <div className="chat-content">
        <p>{message.text}</p>
        <div className="output-reply">
          <span className="file-icon"><Icon /></span>
          <div>
            <strong>{output.title}</strong>
            <small>{output.type} · {output.updated}</small>
            <p>{output.summary}</p>
            <div className="output-reply-actions">
              <button className="inline-link" onClick={onContinue}>基于它继续<ArrowRight /></button>
              <button className="inline-link" onClick={() => onEnterOutput(output.id)}>进入现场<ArrowRight /></button>
              <button className="inline-link" onClick={() => onOpenOutput(output.id)}>在成果页打开<ArrowRight /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 接入确认卡：来源、将获得的工具及效果等级、需要的凭据、默认启用范围。 */
function ConnectCard({ message, onConnect, onCancel }) {
  const { spec, project, state } = message;
  const overCap = project && !withinEffectCap(capabilityEffect(spec), project.effectCap);
  if (state !== 'pending') {
    return <div className="task-receipt confirmed"><CheckCircle2 /><div><strong>{state === 'cancelled' ? `已取消接入 ${spec.name}` : `已接入 ${spec.name}`}</strong><span>{state === 'enabled' ? `各项目默认可用，并已为「${project?.name}」放开` : state === 'connected' ? '各项目默认可用；不需要的项目可以在“设置 · 项目”中排除' : '没有做任何改动'}</span></div></div>;
  }
  return (
    <div className="task-receipt connect-card">
      <div className="receipt-title"><Plug /><div><strong>接入 {spec.name}</strong><span>确认后登记到“设置 · 能力”，凭据不会出现在对话或轨迹里</span></div></div>
      <dl>
        <div><dt>来源</dt><dd>{spec.source} · {spec.transport}</dd></div>
        <div><dt>工具</dt><dd className="receipt-capabilities">{spec.tools.map((tool) => <span key={tool.name} className="capability-chip"><code>{tool.name}</code><small>{tool.effect ? EFFECT_LABELS[tool.effect] : '未标注，按外部副作用'}</small></span>)}</dd></div>
        <div><dt>凭据</dt><dd>{spec.credential}</dd></div>
        <div><dt>可用</dt><dd>{overCap ? `登记后各项目默认可用，但超出「${project.name}」的效果上限（${EFFECT_LABELS[project.effectCap]}），在该项目中暂不可用` : '登记后各项目默认可用，受各项目效果上限约束；不需要的项目可以排除'}</dd></div>
      </dl>
      <div className="receipt-actions">
        <button className="secondary" onClick={onCancel}>取消</button>
        {overCap && <button className="secondary" onClick={() => onConnect(true)}>接入并为本项目放开</button>}
        <button className="primary" onClick={() => onConnect(false)}>确认接入</button>
      </div>
    </div>
  );
}

/** 完成卡：多个完成合并为一张，每项可直接查看成果或进入现场。 */
function CompletionCard({ items, onOpenTask, onOpenOutput }) {
  return (
    <section className="completion-card" aria-label="完成汇总">
      <header><CheckCircle2 /><strong>{items.length} 项工作已完成</strong><span>自检通过，无需验收</span></header>
      <ul>
        {items.map((item) => (
          <li key={item.taskId}>
            <div><strong>{item.title}</strong><p>{item.summary}</p></div>
            <div className="completion-actions">
              {item.outputId && <button className="inline-link" onClick={() => onOpenOutput(item.outputId)}>查看成果<ArrowRight /></button>}
              <button className="inline-link" onClick={() => onOpenTask(item.taskId, 'workspace')}>进入现场<ArrowRight /></button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TasksView({ tasks, projects, selectedTask, setSelectedTaskId, concurrency, setConcurrency, updateTask, doNow, onOpenSession, notify }) {
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const filters = ['全部', '执行中', '等待我', '已暂停', '已完成'];
  const visible = tasks.filter((task) => {
    const matchesQuery = task.title.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === '全部' ||
      (filter === '执行中' && task.status === 'running') ||
      (filter === '等待我' && ['clarification', 'acceptance', 'authorization', 'recovery'].includes(task.status)) ||
      (filter === '已暂停' && ['paused', 'scheduler-paused'].includes(task.status)) ||
      (filter === '已完成' && task.status === 'done');
    return matchesQuery && matchesFilter;
  });
  // 按项目分组，不属于任何项目的任务放在最后的“日常”。
  const sections = [...projects.map((project) => ({ key: project.id, project })), { key: 'daily', project: null }]
    .map((section) => ({ ...section, tasks: visible.filter((task) => (task.projectId || null) === (section.project?.id || null)) }))
    .filter((section) => section.tasks.length);

  return (
    <div className="page-column">
      <PageIntro eyebrow="任务与调度" title="待办" description="掌握整体工作状态，只在需要时干预顺序和并发。" actions={<ConcurrencyStepper concurrency={concurrency} setConcurrency={setConcurrency} notify={notify} />} />
      <div className="toolbar">
        <div className="segmented">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
        <label className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索待办" /></label>
      </div>
      <div className="master-detail">
        <section className="task-list" aria-label="待办列表">
          {sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.project?.name || '日常'}>
              <div className="task-group-label"><strong>{section.project?.name || '日常'}</strong><span>{section.project ? (section.project.dirs[0] || '无挂载目录') : '不属于任何项目'}</span></div>
              {section.tasks.map((task) => (
                <button key={task.id} className={`task-row ${selectedTask.id === task.id ? 'selected' : ''}`} onClick={() => setSelectedTaskId(task.id)}>
                  <span className={`task-state-mark ${statusMeta[task.status][1]}`} />
                  <div className="task-row-main">
                    <div><strong>{task.title}</strong><span className="priority">{task.priority}</span></div>
                    <p>{task.reason}</p>
                  </div>
                  <StatusBadge status={task.status} />
                  <ChevronRight />
                </button>
              ))}
            </div>
          ))}
        </section>
        <TaskDetail task={selectedTask} project={projects.find((project) => project.id === selectedTask.projectId)} updateTask={updateTask} doNow={doNow} onOpenSession={onOpenSession} notify={notify} />
      </div>
    </div>
  );
}

/** 并发上限在待办和运行两页都可调整，二者改的是同一个值。 */
function ConcurrencyStepper({ concurrency, setConcurrency, notify }) {
  function change(next) {
    const value = Math.max(1, Math.min(8, next));
    setConcurrency(value);
    notify(`任务并发上限已调整为 ${value}`);
  }
  return <div className="concurrency-stepper"><span>并发上限</span><IconButton label="减少" onClick={() => change(concurrency - 1)}><span>−</span></IconButton><strong>{concurrency}</strong><IconButton label="增加" onClick={() => change(concurrency + 1)}><Plus /></IconButton></div>;
}

/**
 * 运行：此刻真正在消耗资源的东西。
 *
 * 待办回答“有哪些事、先后如何”，这里只回答“什么在跑、有没有卡住”，
 * 把“点进会话看进度”和“去终端里找进程”两种巡查收拢到一处。
 */
function RunsView({ tasks, runIndicator, processes, stopProcess, concurrency, setConcurrency, updateTask, onOpenTask, notify }) {
  const { running, anomalies } = runIndicator;
  // 异常任务排在前面：它们才是“有没有卡住”的答案。
  const sessions = [...anomalies, ...running];
  const [openLogId, setOpenLogId] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);

  function pause(task) {
    updateTask(task.id, { status: 'paused', reason: '由你主动暂停', next: '等待你手动继续' });
    notify(`已在安全节点暂停“${task.title}”`);
  }

  function requestStop(process, owner) {
    // 任务仍依赖该进程时先说明影响，否则直接停止。
    if (process.requiredWhileRunning && owner?.status === 'running') {
      setConfirmingId(process.id);
      return;
    }
    stop(process);
  }

  function stop(process) {
    stopProcess(process.id);
    setConfirmingId(null);
    notify(`已停止“${process.name}”`);
  }

  return (
    <div className="page-column runs-page">
      <PageIntro eyebrow="现场视角" title="运行" description="此刻在执行的任务会话和由任务启动的后台进程。" actions={<ConcurrencyStepper concurrency={concurrency} setConcurrency={setConcurrency} notify={notify} />} />

      <section className="run-section" aria-label="执行中的任务会话">
        <div className="run-section-heading"><h2>任务会话</h2><span>{running.length}/{concurrency} 执行中</span></div>
        {sessions.map((task) => {
          const snapshot = runSnapshots[task.id] || { step: task.next, elapsed: '刚开始', lastTool: '尚无工具调用', lastToolAge: '' };
          const anomaly = ANOMALY_STATUSES.has(task.status);
          return (
            <article key={task.id} className={`run-row ${anomaly ? 'stalled' : ''}`}>
              {anomaly ? <CircleAlert className="run-row-mark" /> : <LoaderCircle className="status-spinner run-row-mark" />}
              <div className="run-row-main">
                <div><button className="run-row-title" onClick={() => onOpenTask(task.id, 'tasks')}>{task.title}</button>{anomaly && <span className="run-stalled">{statusMeta[task.status][0]}</span>}</div>
                <p>{anomaly ? task.reason : snapshot.step}</p>
              </div>
              <dl className="run-row-facts">
                <div><dt>已用时</dt><dd>{snapshot.elapsed}</dd></div>
                <div><dt>最近工具</dt><dd><Terminal />{snapshot.lastTool}{snapshot.lastToolAge && <small>{snapshot.lastToolAge}</small>}</dd></div>
              </dl>
              <div className="run-row-actions">
                {!anomaly && <button className="secondary" onClick={() => pause(task)}><Pause />暂停</button>}
                <button className="secondary" onClick={() => onOpenTask(task.id, 'workspace')}><MessageSquare />进入现场</button>
              </div>
            </article>
          );
        })}
        {!sessions.length && <p className="run-empty">没有正在执行的任务。</p>}
      </section>

      <section className="run-section" aria-label="后台进程">
        <div className="run-section-heading"><h2>后台进程</h2><span>只显示由任务启动的进程</span></div>
        {processes.map((process) => {
          const owner = tasks.find((task) => task.id === process.taskId);
          const ownerActive = owner?.status === 'running';
          const logOpen = openLogId === process.id;
          return (
            <article key={process.id} className="process-row">
              <div className="process-main">
                <span className={`process-dot ${ownerActive ? 'active' : 'idle'}`} />
                <div>
                  <strong>{process.name}</strong>
                  <code>{process.command}</code>
                </div>
                <dl className="run-row-facts">
                  <div><dt>端口</dt><dd>{process.port ?? '—'}</dd></div>
                  <div><dt>已运行</dt><dd>{process.uptime}</dd></div>
                  <div><dt>启动者</dt><dd><button className="inline-link" onClick={() => onOpenTask(process.taskId, 'tasks')}>{owner?.title}</button>{!ownerActive && <small>任务已{owner?.status === 'done' ? '完成' : '不在执行'}，不再需要</small>}</dd></div>
                </dl>
                <div className="run-row-actions">
                  <button className={`secondary ${logOpen ? 'active' : ''}`} aria-expanded={logOpen} onClick={() => setOpenLogId(logOpen ? null : process.id)}><FileText />日志</button>
                  <button className="secondary danger" onClick={() => requestStop(process, owner)}><CircleStop />停止</button>
                </div>
              </div>
              {confirmingId === process.id && (
                <div className="process-confirm" role="alert">
                  <CircleAlert />
                  <p><strong>“{owner.title}”仍在使用这个进程。</strong>{process.impact}</p>
                  <button className="secondary" onClick={() => setConfirmingId(null)}>取消</button>
                  <button className="secondary danger" onClick={() => stop(process)}>仍然停止</button>
                </div>
              )}
              {logOpen && <pre className="process-log" aria-label={`${process.name} 日志尾部`}>{process.log.join('\n')}</pre>}
            </article>
          );
        })}
        {!processes.length && <p className="run-empty">没有由任务启动的后台进程。</p>}
      </section>
    </div>
  );
}

function TaskDetail({ task, project, updateTask, doNow, onOpenSession, notify }) {
  const canStart = ['queued', 'scheduler-paused', 'paused'].includes(task.status);
  const canPause = task.status === 'running';
  return (
    <aside className="detail-panel">
      <div className="detail-header"><div><StatusBadge status={task.status} /><h2>{task.title}</h2><p>{projectLabel(project)}</p></div><IconButton label="更多操作"><MoreHorizontal /></IconButton></div>
      <div className="detail-actions">
        {canStart && <button className="primary" onClick={() => doNow(task.id)}><Play />先做这个</button>}
        {canPause && <button className="secondary" onClick={() => { updateTask(task.id, { status: 'paused', reason: '由你主动暂停', next: '等待你手动继续' }); notify('任务已在安全节点暂停'); }}><Pause />暂停</button>}
        {task.status === 'paused' && <button className="primary" onClick={() => doNow(task.id)}><Play />继续</button>}
        {/* 异常任务在检查现场后可以直接重新执行，仍按并发上限调度。 */}
        {ANOMALY_STATUSES.has(task.status) && <button className="primary" onClick={() => doNow(task.id)}><Play />{task.status === 'recovery' ? '恢复执行' : '重新执行'}</button>}
        <button className="secondary" onClick={() => onOpenSession(task)}><MessageSquare />工作会话</button>
      </div>
      <section className="detail-section"><h3>当前状态</h3><div className="state-callout"><span className={`task-state-mark ${statusMeta[task.status][1]}`} /><div><strong>{task.reason}</strong><p>{task.next}</p></div></div></section>
      <section className="detail-section"><h3>任务信息</h3><dl className="info-list"><div><dt>优先级</dt><dd><select value={task.priority} onChange={(event) => updateTask(task.id, { priority: event.target.value })}><option>高</option><option>中</option><option>低</option></select></dd></div><div><dt>资料范围</dt><dd>{task.scope}</dd></div><div><dt>验收</dt><dd>{task.acceptance ? '完成后需要你验收' : '自检通过后自动完成'}</dd></div><div><dt>工作会话</dt><dd><button className="inline-link" onClick={() => onOpenSession(task)}>{task.session} <ArrowRight /></button></dd></div></dl></section>
      <section className="detail-section"><h3>最近进展</h3><ol className="timeline"><li><span /><div><strong>完成上下文整理</strong><p>14:28</p></div></li><li><span /><div><strong>{task.next}</strong><p>现在</p></div></li></ol></section>
    </aside>
  );
}

/**
 * 顶部入口共用的侧边抽屉：原地打开，Esc 或关闭按钮关闭，关闭后焦点回到触发按钮。
 * 内容由调用方提供，标题元素的 id 通过 labelledBy 关联。
 */
function SideDrawer({ open, close, trigger, labelledBy, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open) {
      if (!dialog.current.open) dialog.current.showModal();
    } else if (dialog.current.open) {
      dialog.current.close();
      if (trigger.current?.isConnected) trigger.current.focus();
    }
  }, [open, trigger]);
  return createPortal(<dialog ref={dialog} className="side-drawer" aria-labelledby={labelledBy} onCancel={(event) => { event.preventDefault(); close(); }}>{children}</dialog>, document.body);
}

function InboxView({ requests, tasks, selectedRequestId, setSelectedRequestId, resolveRequest, onOpenTask, markSeen, drafts, updateDraft, compact = false, detailOpen, setDetailOpen, close, expand }) {
  const open = requests.filter((request) => request.state !== 'done');
  const selected = requests.find((request) => request.id === selectedRequestId) || open[0];
  const unread = requests.some((request) => request.state === 'new');
  function select(id) { setSelectedRequestId(id); if (compact) setDetailOpen(true); }
  return (
    <div className={`page-column ${compact ? 'inbox-compact' : ''}`}>
      {compact ? <header className="inbox-drawer-header">{detailOpen && <IconButton label="返回 Inbox 列表" onClick={() => setDetailOpen(false)}><ArrowLeft /></IconButton>}<h2 id="inbox-drawer-title">Inbox</h2><span>{detailOpen && selected ? `${requests.findIndex((item) => item.id === selected.id) + 1} / ${requests.length}` : `${open.length} 项待处理`}</span>{expand && <IconButton label="展开到管理模式" onClick={expand}><Maximize2 /></IconButton>}<IconButton label="关闭 Inbox" onClick={close}><X /></IconButton></header> : <PageIntro eyebrow="集中处理" title="Inbox" description="这里只放需要你判断的事项。后台进度与普通完成不会逐条打断。" actions={<button className="secondary" disabled={!unread} onClick={markSeen}><Check />{unread ? '全部标为已查看' : '已全部查看'}</button>} />}
      {selected ? (
        <div className="master-detail inbox-layout">
          <section className="request-list" hidden={compact && detailOpen}>
            <div className="list-section-label">需要处理 · {open.length}</div>
            {open.map((request) => {
              const task = tasks.find((item) => item.id === request.taskId);
              return <button key={request.id} className={`request-row ${selected?.id === request.id ? 'selected' : ''}`} aria-current={selected?.id === request.id ? 'true' : undefined} onClick={() => select(request.id)}><span className={`request-type ${request.type === '澄清' ? 'red' : request.type === '验收' ? 'blue' : 'amber'}`}>{request.type}</span><strong>{request.title}</strong><p>{task?.title}</p><div><span>{request.age}</span><span>{request.impact}</span>{request.state === 'new' && <span className="unread-mark">未查看</span>}</div></button>;
            })}
            {!open.length && <div className="inbox-clear"><CheckCircle2 /><strong>全部处理完毕</strong><span>没有待处理事项</span></div>}
          </section>
          <RequestDetail key={selected.id} hidden={compact && !detailOpen} draft={drafts[selected.id] || {}} updateDraft={(patch) => updateDraft(selected.id, patch)} request={selected} task={tasks.find((item) => item.id === selected.taskId)} resolveRequest={resolveRequest} onOpenTask={onOpenTask} nextRequest={open.find((request) => request.id !== selected.id)} onNext={select} />
        </div>
      ) : <EmptyState icon={Inbox} title="Inbox 已处理完" description="新的澄清、验收或授权请求会集中出现在这里。" />}
    </div>
  );
}

function RequestDetail({ request, task, resolveRequest, onOpenTask, nextRequest, onNext, draft, updateDraft, hidden }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    if (!hidden && scrollRef.current) scrollRef.current.scrollTop = draft.scrollTop || 0;
  }, [hidden, request.id]);
  const answer = draft.answer || '';
  const choice = draft.choice || '';
  const setAnswer = (answer) => updateDraft({ answer });
  const setChoice = (choice) => updateDraft({ choice });
  const resolved = request.state === 'done';
  const scope = request.type === '澄清' ? '个人笔记，仅限本次任务' : request.type === '验收' ? task.scope : request.type === '工具授权' ? `${request.capability}（${EFFECT_LABELS[request.effect]}）` : '成果摘要，本次外部仓库发布';
  return (
    <aside ref={scrollRef} className="detail-panel request-detail" hidden={hidden} onScroll={(event) => updateDraft({ scrollTop: event.currentTarget.scrollTop })}>
      <div className="request-context"><span className={`request-type ${request.type === '澄清' ? 'red' : request.type === '验收' ? 'blue' : 'amber'}`}>{request.type}</span><span>{request.age}</span></div>
      <h2>{request.title}</h2><p className="request-description">{request.detail}</p>
      <dl className="decision-facts"><div><dt>涉及范围</dt><dd>{scope}</dd></div><div><dt>影响</dt><dd>{resolved ? '本项已处理' : request.impact}</dd></div><div><dt>来源会话</dt><dd><button className="inline-link" onClick={() => onOpenTask(task.id, 'workspace')}>{task.session}<ArrowRight /></button></dd></div></dl>
      {resolved ? <div className="decision-complete" role="status"><CheckCircle2 /><h3>{request.resolution}</h3><p>{request.answer || task.reason}</p>{nextRequest && <button className="secondary" onClick={() => onNext(nextRequest.id)}>处理下一项<ArrowRight /></button>}</div> : <>
        {request.type === '澄清' && <form className="answer-block decision-form" onSubmit={(event) => { event.preventDefault(); if (canSubmitDecision(request.type, choice, answer)) resolveRequest(request.id, choice, answer); }}>
          <fieldset><legend>选择使用范围</legend>{[
            ['allow', '允许本次使用', '仅用于当前任务，不扩展到其他任务'],
            ['deny', '不使用这份资料', '使用已授权的项目文档继续'],
            ['custom', '指定其他范围', '补充允许使用的内容与限制'],
          ].map(([value, label, description]) => <label className={`decision-option ${choice === value ? 'selected' : ''}`} key={value}><input type="radio" name={`scope-${request.id}`} value={value} checked={choice === value} onChange={() => setChoice(value)} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</fieldset>
          {choice === 'custom' && <label className="decision-answer">范围说明<textarea autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="例如：只引用笔记中的公开资料摘要" required /></label>}
          <div className="decision-footer"><span><ShieldCheck />仅对本次任务生效</span><button type="submit" className="primary" disabled={!canSubmitDecision(request.type, choice, answer)}><Check />确认并继续</button></div>
        </form>}
        {request.type === '验收' && <div className="answer-block"><div className="checks"><span><Check />3 项自检通过</span><button className="inline-link" onClick={() => onOpenTask(task.id, 'outputs')}>查看成果 <ArrowRight /></button></div><label className="decision-answer">修改意见<textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="需要修改时，填写具体意见…" /></label><div className="button-row"><button className="secondary" disabled={!canSubmitDecision(request.type, 'revise', answer)} onClick={() => resolveRequest(request.id, 'revise', answer)}>要求修改</button><button className="primary" onClick={() => resolveRequest(request.id, 'accept')}><Check />接受成果</button></div></div>}
        {request.type === '工具授权' && <div className="answer-block"><div className="permission-note"><ShieldCheck /><p><strong>按效果分级授权</strong><br />记住的决定可在“设置 · 能力”中查看和撤销。</p></div><div className="button-row grant-actions"><button className="secondary danger" onClick={() => resolveRequest(request.id, 'deny')}>拒绝</button><button className="secondary" onClick={() => resolveRequest(request.id, 'once')}>仅这一次</button><button className="secondary" onClick={() => resolveRequest(request.id, 'task')}>本任务内允许</button><button className="primary" onClick={() => resolveRequest(request.id, 'project')}>本项目内始终允许</button></div></div>}
        {request.type === '外发授权' && <div className="answer-block"><div className="permission-note"><ShieldCheck /><p><strong>仅授权本次发布</strong><br />拒绝外发不影响已完成的成果，也不会扩大后续操作权限。</p></div><div className="button-row"><button className="secondary danger" onClick={() => resolveRequest(request.id, 'deny')}>拒绝外发</button><button className="primary" onClick={() => resolveRequest(request.id, 'allow')}><Send />允许本次发布</button></div></div>}
      </>}
    </aside>
  );
}

// 工作区现场（并排数、栏位、各栏宽度）存在本地，刷新后按工作区恢复（原型内的现场记忆）。
const SCENE_STORAGE_KEY = 'multivac.prototype.workspace-scene';
// 旧版只保存了两栏栏位，读取时自动沿用。
const LEGACY_SLOTS_STORAGE_KEY = 'multivac.prototype.parallel-slots';

function readStoredJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key)) || null;
  } catch {
    return null;
  }
}

function readScenes() {
  return normalizeScenes(readStoredJson(SCENE_STORAGE_KEY), readStoredJson(LEGACY_SLOTS_STORAGE_KEY));
}

// 不属于任何项目的会话（临时探索、随手提问）所在的工作区。
const DEFAULT_WORKSPACE = 'default';

// 首次进入各工作区时的默认栏位。
const initialSlots = { multivac: ['prototype', 'recovery'], [DEFAULT_WORKSPACE]: ['learning'] };

/**
 * 工作区按项目自动生成：每个项目带一个同名工作区，其余会话进入默认工作区。
 * 首版不能手动新建工作区，一个会话只在一个工作区；切换工作区即切换项目。
 * 工作区只决定“把哪些会话放在一起看”，不改变会话的目录和权限。
 */
// 工作对象：会话之外的应用对象以“类型:id”标识，首版只有成果查看器。
const OUTPUT_OBJECT_PREFIX = 'output:';
const NOTE_OBJECT_PREFIX = 'note:';
const BOOK_OBJECT_PREFIX = 'book:';
const isBookObject = (id) => id.startsWith(BOOK_OBJECT_PREFIX);
const isOutputObject = (id) => id.startsWith(OUTPUT_OBJECT_PREFIX);
const isNoteObject = (id) => id.startsWith(NOTE_OBJECT_PREFIX);

/** 梳理助手的示例建议（真实实现由模型生成）：按提问给出结构、润色或关联三类修改。 */
function suggestNoteEdits(note, prompt) {
  const bullets = note.content.split('\n').filter((line) => line.startsWith('- '));
  const suggestions = [];
  if (/润色|改写|通顺/u.test(prompt) && bullets[0]) suggestions.push({ before: bullets[0], after: `${bullets[0]}，并记下了这样做的原因`, reason: '补一句结果和原因，回看时更容易理解' });
  if (/关联|链接|相关/u.test(prompt)) suggestions.push({ before: '', after: '## 相关\n- 成果「MVP 交互原型说明」\n- 会话「原型范围梳理」', reason: '补上相关的成果与会话，方便跳转' });
  if (/结构|整理|梳理/u.test(prompt) || !suggestions.length) suggestions.push({ before: '', after: `## 小结\n${bullets.slice(0, 2).map((line) => line.replace(/^- /u, '- 要点：')).join('\n') || '- （待补充）'}`, reason: '把要点收成一段小结放在最后' });
  return suggestions.map((suggestion, index) => ({ ...suggestion, id: `${Date.now()}-${index}` }));
}

function WorkspaceView({ tasks, outputs, notes, setNotes, books, documents, scopeRules, projects, capabilities, agents, requests, resolveRequest, decisionDrafts, updateDecisionDraft, selectedTaskId, sessionRequest, onOpenTask, notify, navigationVisible, models, defaultModelId, manageModels, onFocusChange, onHandToMultivac }) {
  const workspaces = [
    ...projects.map((project) => ({ id: project.id, name: project.name, project })),
    { id: DEFAULT_WORKSPACE, name: '默认工作区', project: null },
  ];
  const workspaceOf = (taskId) => tasks.find((task) => task.id === taskId)?.projectId || DEFAULT_WORKSPACE;
  const [workspaceId, setWorkspaceId] = useState(() => workspaceOf(selectedTaskId));
  // 每个工作区记住自己的现场：并排数、栏位（slots[k] 是第 k + 1 栏的会话）与各栏宽度。
  const [scenes, setScenes] = useState(readScenes);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef(null);
  const pickerRef = useRef(null);
  const [customConversations, setCustomConversations] = useState({});
  const [creating, setCreating] = useState(false);
  const [creationName, setCreationName] = useState('');
  const creationTriggerRef = useRef(null);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [conversationState, setConversationState] = useState({});
  // 会话内临时关闭的能力：只影响这个会话，不改项目许可或智能体配置。
  const [pausedCapabilities, setPausedCapabilities] = useState({});
  // 梳理助手的对话与待定建议，按笔记分别保存。
  const [noteAssist, setNoteAssist] = useState({});
  const [openerOpen, setOpenerOpen] = useState(false);
  const [openerQuery, setOpenerQuery] = useState('');
  // 每本书读到哪、划线与想法，以及书伴的对话层级（长期保留，每次打开接着上次）。
  const [readings, setReadings] = useState({});
  const [bookAssist, setBookAssist] = useState({});
  const openerRef = useRef(null);

  /** 工作区的工作对象：会话，加上在这里打开过的应用对象（成果查看器）。 */
  function membersOf(id) {
    return [
      ...(id === DEFAULT_WORKSPACE ? ['learning'] : []),
      ...tasks.filter((task) => (task.projectId || DEFAULT_WORKSPACE) === id).map((task) => task.id),
      ...Object.keys(customConversations).filter((key) => customConversations[key].workspaceId === id),
      ...(sceneOf(id).objects || []).filter((objectId) => outputs.some((output) => OUTPUT_OBJECT_PREFIX + output.id === objectId) || notes.some((note) => NOTE_OBJECT_PREFIX + note.id === objectId) || books.some((book) => BOOK_OBJECT_PREFIX + book.id === objectId)),
    ];
  }

  const outputOf = (objectId) => outputs.find((output) => OUTPUT_OBJECT_PREFIX + output.id === objectId);
  const noteOf = (objectId) => notes.find((note) => NOTE_OBJECT_PREFIX + note.id === objectId);
  const bookOf = (objectId) => books.find((book) => BOOK_OBJECT_PREFIX + book.id === objectId);
  const sceneOf = (id) => scenes[id] || { count: DEFAULT_PARALLEL, slots: initialSlots[id] || [], widths: {}, viewMode: 'parallel', focusedId: null, stacks: {}, objects: [], companions: {} };
  const slotsOf = (id) => resolveSlots(sceneOf(id).slots, membersOf(id), sceneOf(id).count);
  const sceneIds = membersOf(workspaceId);
  const scene = sceneOf(workspaceId);
  const parallelCount = scene.count;
  const slots = slotsOf(workspaceId);
  const workspace = workspaces.find((item) => item.id === workspaceId) || workspaces[0];
  // 视图模式、当前会话与栈式深入层级都属于工作区现场，随栏位一起保存与恢复。
  const viewMode = scene.viewMode || 'parallel';
  const focusedId = scene.focusedId && sceneIds.includes(scene.focusedId) ? scene.focusedId : slots[0] || null;
  const stacks = scene.stacks || {};

  useEffect(() => {
    window.localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(scenes));
  }, [scenes]);

  function updateScene(patch, id = workspaceId) {
    setScenes((current) => ({ ...current, [id]: { ...sceneOf(id), ...current[id], ...patch } }));
  }

  const setViewMode = (mode) => updateScene({ viewMode: mode });
  const setFocusedId = (id) => updateScene({ focusedId: id });

  /** 调整并排数：多出的会话退出显示但不关闭，当前会话始终保留在显示中。 */
  function changeParallelCount(count) {
    updateScene({ count, slots: resizeSlots(slots, count, focusedId), viewMode: 'parallel' });
  }

  function switchWorkspace(id) {
    setSwitcherOpen(false);
    if (id === workspaceId) return;
    // 各工作区保留自己的视图模式、当前会话与深入层级，切回来时原样恢复。
    setWorkspaceId(id);
  }

  // 从任务、卡片或请求进入时，切到会话所属的工作区并聚焦，其余会话、草稿原样保留。
  useEffect(() => {
    if (!sessionRequest) return;
    // 从对话打开书或笔记：加入当前工作区并聚焦。
    if (sessionRequest.objectId) {
      openObject(sessionRequest.objectId);
      return;
    }
    // 打开成果：成果查看器加入来源任务所在的工作区，应用对象默认聚焦显示。
    if (sessionRequest.outputId) {
      const output = outputs.find((item) => item.id === sessionRequest.outputId);
      if (!output) return;
      const target = workspaceOf(output.taskId);
      const objectId = OUTPUT_OBJECT_PREFIX + output.id;
      const objects = sceneOf(target).objects || [];
      setWorkspaceId(target);
      updateScene({ objects: objects.includes(objectId) ? objects : [...objects, objectId], focusedId: objectId, viewMode: 'focus' }, target);
      return;
    }
    const taskId = sessionRequest.taskId;
    const target = workspaceOf(taskId);
    // 进入现场看的是任务会话本身，收起它之前深入的层级。
    const { [taskId]: _closed, ...restStacks } = sceneOf(target).stacks || {};
    setWorkspaceId(target);
    updateScene({ focusedId: taskId, viewMode: 'focus', stacks: restStacks }, target);
  }, [sessionRequest]);

  useEffect(() => {
    function dismiss(event) {
      if (event.key === 'Escape') {
        setCreating(false);
        setConversationMenuOpen(false);
        setSwitcherOpen(false);
      }
    }
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, []);

  useEffect(() => {
    function dismissOutside(event) {
      if (!pickerRef.current?.contains(event.target)) setConversationMenuOpen(false);
      if (!switcherRef.current?.contains(event.target)) setSwitcherOpen(false);
      if (!openerRef.current?.contains(event.target)) setOpenerOpen(false);
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, []);

  useEffect(() => {
    if (!creating) return;
    const previous = creationTriggerRef.current;
    function trapFocus(event) {
      if (event.key !== 'Tab') return;
      const controls = [...document.querySelectorAll('.creation-dialog button:not(:disabled), .creation-dialog input')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', trapFocus);
    return () => { document.removeEventListener('keydown', trapFocus); if (previous?.isConnected) previous.focus(); };
  }, [creating]);

  /**
   * 深入一层：子会话出现在父会话原来的位置（同一栏或聚焦位），视图模式、其他栏和列宽都不变。
   * 栏位里记录的仍是根会话，所以多层深入与逐层返回都不会改变栏位。
   */
  // keepFocus：在伴随会话里深入时焦点仍留在所属的应用对象上。
  function createStackConversation(rootId, quote, { keepFocus = false } = {}) {
    const normalized = quote.replace(/\s+/g, ' ').trim();
    const childTitle = normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
    updateScene({ stacks: { ...stacks, [rootId]: [...(stacks[rootId] || []), { quote: normalized, title: childTitle }] }, ...(keepFocus ? {} : { focusedId: rootId }) });
    notify('已从选中内容创建栈式会话');
  }

  /**
   * 渲染一个会话面板。独立展示与作为应用对象的伴随会话共用同一份会话状态与深入层级。
   */
  /**
   * 会话的执行配置：智能体 + 实际可用能力（登记 ∩ 项目许可 ∩ 智能体选用，再去掉本会话临时关闭的）。
   * 不属于项目的会话按保守的默认许可，只含只读能力。
   */
  function executionOf(id) {
    const task = tasks.find((item) => item.id === id);
    const agent = agents.find((item) => item.id === (task?.agentId || (task?.projectId === 'research' ? 'research' : 'general'))) || agents[1];
    const project = projects.find((item) => item.id === task?.projectId) || null;
    const paused = pausedCapabilities[id] || [];
    // 会话里默认可用的能力 = 这个项目与智能体下实际可用的全部能力，再去掉本会话临时关闭的。
    const { available, unavailable } = resolveAvailability({ registry: capabilities, project, agent });
    return {
      agentName: agent.name,
      usable: available,
      blocked: unavailable,
      paused,
      onToggle: (capabilityId) => setPausedCapabilities((current) => ({ ...current, [id]: paused.includes(capabilityId) ? paused.filter((item) => item !== capabilityId) : [...paused, capabilityId] })),
    };
  }

  function renderSession(id, { slotLabel = '', companion = false, key } = {}) {
    const task = tasks.find((item) => item.id === id);
    const request = requests.find((item) => item.taskId === id && item.state !== 'done');
    const inStack = Boolean(stacks[id]?.length);
    const parentConversation = getBaseConversation(id);
    const stackNodes = inStack ? stacks[id] : [];
    const currentStackNode = stackNodes[stackNodes.length - 1];
    const stateKey = JSON.stringify([id, ...stackNodes.map((node) => node.quote)]);
    const sessionState = conversationState[stateKey] || { draft: '', messages: [], modelId: defaultModelId, thinkingLevel: 'medium' };
    return (
      <ConversationPanel
        key={key || `${id}-${stackNodes.length}`}
        sessionId={id}
        companion={companion}
        execution={executionOf(id)}
        references={referenceOptions({ outputs, projects, capabilities })}
        onHandToMultivac={onHandToMultivac}
        conversation={getConversation(id)}
        sessionState={sessionState}
        setSessionState={(patch) => setConversationState((current) => ({ ...current, [stateKey]: { draft: '', messages: [], modelId: defaultModelId, thinkingLevel: 'medium', ...(current[stateKey] || {}), ...patch } }))}
        task={task}
        request={request}
        requestControls={request && { resolveRequest, draft: decisionDrafts[request.id] || {}, updateDraft: (patch) => updateDecisionDraft(request.id, patch) }}
        onOpenTask={onOpenTask}
        slotLabel={slotLabel}
        onFocus={() => focusConversation(id)}
        onReturnToParallel={returnToParallel}
        focused={viewMode === 'focus'}
        active={companion ? false : focusedId === id}
        onActivate={() => { if (!companion) setFocusedId(id); }}
        stackPath={inStack ? [parentConversation.title, ...stackNodes.map((node) => node.title)] : []}
        stackSource={inStack ? currentStackNode.quote : ''}
        onBackStack={inStack ? () => backStack(id, { keepFocus: companion }) : null}
        onCreateStack={(quote) => createStackConversation(id, quote, { keepFocus: companion })}
        onCollect={collectToNote}
        notify={notify}
        models={models}
        manageModels={manageModels}
      />
    );
  }

  /** 在当前工作区打开一个应用对象（笔记、书……），应用对象默认聚焦显示。 */
  function openObject(objectId) {
    const objects = scene.objects || [];
    updateScene({ objects: objects.includes(objectId) ? objects : [...objects, objectId], focusedId: objectId, viewMode: 'focus' });
    setOpenerOpen(false);
  }

  function updateNote(noteId, content) {
    setNotes((current) => current.map((note) => note.id === noteId ? { ...note, content, updated: '刚刚' } : note));
  }

  const assistOf = (noteId) => noteAssist[noteId] || { thread: [], suggestions: [] };

  /** 梳理助手：先回一句说明，再给出差异建议；不直接改正文。 */
  function assistNote(noteId, prompt) {
    const note = notes.find((item) => item.id === noteId);
    if (isArrangementIntent(prompt)) {
      setNoteAssist((current) => {
        const assist = current[noteId] || { thread: [], suggestions: [] };
        return { ...current, [noteId]: { ...assist, thread: [...assist.thread, { who: '你', text: prompt }, { who: '梳理助手', handover: prompt, text: '这是在安排工作，交给 Multivac 更合适：它负责安排任务，我只帮你梳理这篇笔记。' }] } };
      });
      return;
    }
    const suggestions = suggestNoteEdits(note, prompt);
    setNoteAssist((current) => {
      const assist = current[noteId] || { thread: [], suggestions: [] };
      return { ...current, [noteId]: { thread: [...assist.thread, { who: '你', text: prompt }, { who: '梳理助手', text: `给出 ${suggestions.length} 条修改建议，逐条接受或拒绝，不会直接改你的正文。` }], suggestions: [...assist.suggestions, ...suggestions] } };
    });
  }

  function settleSuggestion(noteId, suggestionId, accept) {
    const note = notes.find((item) => item.id === noteId);
    const suggestion = assistOf(noteId).suggestions.find((item) => item.id === suggestionId);
    if (accept) {
      const next = applySuggestion(note.content, suggestion);
      if (next === null) {
        setNoteAssist((current) => ({ ...current, [noteId]: { ...current[noteId], suggestions: current[noteId].suggestions.map((item) => item.id === suggestionId ? { ...item, stale: true } : item) } }));
        return;
      }
      updateNote(noteId, next);
    }
    setNoteAssist((current) => ({ ...current, [noteId]: { ...current[noteId], suggestions: current[noteId].suggestions.filter((item) => item.id !== suggestionId) } }));
  }

  /**
   * 收进笔记：优先收进当前打开的笔记，否则收进最近编辑的一篇。
   * 选中内容以引用块追加并注明出处，不打断当前阅读。
   */
  function collectToNote(text, source) {
    const openNote = [...(scene.objects || [])].reverse().map(noteOf).find(Boolean);
    const target = openNote || notes[0];
    if (!target) return;
    updateNote(target.id, appendExcerpt(target.content, text, source));
    notify(`已收进「${target.title}」`);
  }

  const readingOf = (bookId) => ({ chapterIndex: 0, paragraphIndex: 0, furthest: 0, highlights: [], thoughts: [], ...readings[bookId] });
  const bookAssistOf = (bookId) => bookAssist[bookId] || { stack: [{ title: '书伴', thread: [] }], quote: '' };

  function updateReading(bookId, patch) {
    setReadings((current) => ({ ...current, [bookId]: { ...readingOf(bookId), ...patch } }));
  }

  function updateBookAssist(bookId, updater) {
    setBookAssist((current) => ({ ...current, [bookId]: updater(current[bookId] || { stack: [{ title: '书伴', thread: [] }], quote: '' }) }));
  }

  /** 在书伴当前层级追加消息。 */
  function pushBookMessages(bookId, messages) {
    updateBookAssist(bookId, (assist) => ({ ...assist, quote: '', stack: assist.stack.map((level, index) => index === assist.stack.length - 1 ? { ...level, thread: [...level.thread, ...messages] } : level) }));
  }

  /**
   * 书伴回答（示例）：安排类意图提示交给 Multivac；涉及还没读到的章节不剧透；
   * 其余结合你读到的段落与选中内容回答，可以再深入一层。
   */
  function askBook(bookId, question) {
    const book = books.find((item) => item.id === bookId);
    const reading = readingOf(bookId);
    const assist = bookAssistOf(bookId);
    const paragraph = book.chapters[reading.chapterIndex].paragraphs[reading.paragraphIndex];
    const asked = { who: '你', text: assist.quote ? `「${excerptOf(assist.quote, 24)}」${question}` : question };
    if (isArrangementIntent(question)) {
      pushBookMessages(bookId, [asked, { who: '书伴', handover: assist.quote ? `${question}：${assist.quote}` : question, text: '这是在安排工作，交给 Multivac 更合适：它负责安排任务，我只陪你讨论这本书。' }]);
      return;
    }
    const spoiler = spoilerChapter(question, book.chapters, reading.furthest);
    if (spoiler) {
      pushBookMessages(bookId, [asked, { who: '书伴', text: `你还没读到「${spoiler.title}」，先不剧透；读到那里再一起聊。` }]);
      return;
    }
    const focus = assist.quote || paragraph;
    pushBookMessages(bookId, [asked, { who: '书伴', topic: '线性一致性的保证与代价', text: `结合你读到的这段：「${excerptOf(focus, 30)}」——关键在于它给的是什么保证、代价是什么。线性一致性保证的是“读到新值后不会再读到旧值”，代价是每次操作都要协调副本。` }]);
  }

  /** 深入一层：以某条回答为背景开一个子讨论，向上不回写，可逐层返回。 */
  function deepenBook(bookId, topic) {
    updateBookAssist(bookId, (assist) => ({ ...assist, stack: [...assist.stack, { title: topic, thread: [{ who: '书伴', text: `单独展开「${topic}」：这一层的讨论不会打断上一层，聊完可以返回。你想从定义、例子还是代价开始？` }] }] }));
  }

  function backBook(bookId) {
    updateBookAssist(bookId, (assist) => ({ ...assist, stack: assist.stack.length > 1 ? assist.stack.slice(0, -1) : assist.stack }));
  }

  /** 把这本书的划线与想法一次收进笔记。 */
  function collectMarks(book) {
    const reading = readingOf(book.id);
    const lines = [...reading.highlights.map((item) => `划线：${item.text}`), ...reading.thoughts.map((item) => `想法：${item.note}（针对：${excerptOf(item.text, 24)}）`)];
    if (!lines.length) return;
    collectToNote(lines.join('\n'), `《${book.title}》`);
  }

  const scopeOf = (doc) => scopeRules.find((rule) => rule.id === doc.category)?.scope || '未授权使用';

  /** 把文档用于当前聚焦的会话；受资料使用范围约束，未授权的不能用。 */
  function applyDocumentToSession(doc) {
    setOpenerOpen(false);
    if (!focusedId || isOutputObject(focusedId) || isNoteObject(focusedId) || isBookObject(focusedId)) {
      notify('先在工作区聚焦一个会话，再把文档用于它');
      return;
    }
    notify(`已把「${doc.title}」用于「${getConversation(focusedId).title}」，范围：${scopeOf(doc)}`);
  }

  /** 关闭应用对象只是移出工作区，成果本身不受影响；伴随会话照常保留。 */
  function closeObject(objectId) {
    const objects = (scene.objects || []).filter((item) => item !== objectId);
    updateScene({ objects, focusedId: focusedId === objectId ? slots.find((id) => id && id !== objectId) || null : focusedId });
  }

  /** 伴随会话的展开状态按对象记住，缺省展开。 */
  const companionOpen = (objectId) => scene.companions?.[objectId] !== false;
  const toggleCompanion = (objectId) => updateScene({ companions: { ...scene.companions, [objectId]: !companionOpen(objectId) } });

  /** 回到并排：当前会话不在任何一栏时，以第一栏为当前会话。 */
  function returnToParallel() {
    updateScene({ viewMode: 'parallel', focusedId: parallelIds.includes(focusedId) ? focusedId : parallelIds[0] || null });
  }

  /** 返回父会话：去掉最上面一层，父会话回到同一位置。 */
  function backStack(rootId, { keepFocus = false } = {}) {
    const nodes = stacks[rootId] || [];
    const { [rootId]: _closed, ...rest } = stacks;
    updateScene({ stacks: nodes.length > 1 ? { ...stacks, [rootId]: nodes.slice(0, -1) } : rest, ...(keepFocus ? {} : { focusedId: rootId }) });
  }

  function getBaseConversation(id) {
    if (isOutputObject(id)) return { title: outputOf(id)?.title || '成果', category: '成果', messages: [] };
    if (isNoteObject(id)) return { title: noteOf(id)?.title || '笔记', category: '笔记', messages: [] };
    if (isBookObject(id)) return { title: `《${bookOf(id)?.title || '书'}》`, category: '书', messages: [] };
    if (customConversations[id]) return customConversations[id];
    if (conversations[id]) return conversations[id];
    const task = tasks.find((item) => item.id === id) || tasks[0];
    return {
      title: task.session,
      category: '任务会话',
      messages: [
        { who: '任务', text: `目标：${task.title}` },
        { who: 'Coding Agent', text: task.reason },
        { who: 'Coding Agent', text: `下一步：${task.next}` },
      ],
    };
  }

  function getConversation(id) {
    const nodes = stacks[id];
    if (!nodes?.length) return getBaseConversation(id);
    const currentNode = nodes[nodes.length - 1];
    return {
      title: currentNode.title,
      category: '栈式会话 · 承接父会话背景',
      messages: [
        { who: '工作会话', text: '已基于父会话中选中的内容创建独立子会话。这里的讨论会承接原背景，但不会自动改写父会话。' },
        { who: '工作会话', text: `我们先聚焦这段内容本身：“${currentNode.quote}”` },
      ],
    };
  }

  function focusConversation(id) {
    updateScene({ focusedId: id, viewMode: 'focus' });
    setConversationMenuOpen(false);
  }

  /**
   * 由用户指定把会话放进第几栏：原来在这一栏的会话换下来；已在另一栏则两栏互换。
   * 聚焦模式下选栏会切回并排，放好后该会话成为当前会话。
   */
  function assignSlot(id, slot) {
    updateScene({ slots: placeInSlot(slots, id, slot), focusedId: id, viewMode: 'parallel' });
    setConversationMenuOpen(false);
  }

  function openCreation() {
    creationTriggerRef.current = document.activeElement;
    setConversationMenuOpen(false);
    setCreationName('');
    setCreating(true);
  }

  function submitCreation(event) {
    event.preventDefault();
    const name = creationName.trim();
    if (!name) return;

    const id = `custom-${Date.now()}`;
    setCustomConversations((current) => ({
      ...current,
      [id]: {
        title: name,
        category: '普通会话',
        workspaceId,
        messages: [{ who: '工作会话', text: '新会话已创建。你可以在这里开始讨论，或从其他会话选中内容创建栈式子会话。' }],
      },
    }));
    updateScene({ focusedId: id, viewMode: 'focus' });
    setCreating(false);
  }

  // 把当前焦点会话告诉 Multivac 侧栏，侧栏据此解析“这个”。
  useEffect(() => {
    // 焦点在成果查看器时，“这个”指成果，引用来源仍落到产出它的任务会话。
    const output = focusedId && isOutputObject(focusedId) ? outputOf(focusedId) : null;
    const note = focusedId && isNoteObject(focusedId) ? noteOf(focusedId) : null;
    const book = focusedId && isBookObject(focusedId) ? bookOf(focusedId) : null;
    onFocusChange?.(!focusedId ? null : output ? { id: output.taskId, title: `成果「${output.title}」` } : note ? { id: null, title: `笔记「${note.title}」` } : book ? { id: null, title: `《${book.title}》` } : { id: focusedId, title: getConversation(focusedId).title });
  }, [focusedId, JSON.stringify(stacks), customConversations, outputs, notes]);

  const parallelIds = slots.filter(Boolean);
  const visibleIds = viewMode === 'parallel' ? parallelIds : focusedId ? [focusedId] : [];

  return (
    <div className="workspace-page">
      {navigationVisible && <div className="workspace-strip scene-bar">
        <div className="workspace-switcher" ref={switcherRef}>
          <button className="conversation-picker-trigger workspace-switcher-trigger" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen((current) => !current)}><span>工作区</span><strong>{workspace.name}</strong><ChevronDown /></button>
          {switcherOpen && <div className="conversation-menu workspace-menu">
            <div className="conversation-menu-header"><div><strong>切换工作区</strong><span>每个项目自动带一个同名工作区</span></div></div>
            <div className="conversation-menu-list">{workspaces.map((item) => (
              <button key={item.id} className={`workspace-option ${item.id === workspaceId ? 'selected' : ''}`} onClick={() => switchWorkspace(item.id)}>
                <Folder />
                <span className="conversation-menu-name"><strong>{item.name}</strong><small>{item.project ? (item.project.dirs[0] || '无挂载目录') : '不属于任何项目的会话'}</small></span>
                <em>{membersOf(item.id).length} 个会话</em>
                {item.id === workspaceId && <Check />}
              </button>
            ))}</div>
          </div>}
        </div>
        <span className="workspace-project">{!workspace.project ? '不属于任何项目的会话' : workspace.project.dirs[0] ? <>项目目录 <code>{workspace.project.dirs[0]}</code></> : '无挂载目录'}</span>
        <div className="conversation-picker" ref={pickerRef}>
          <button className="conversation-picker-trigger" aria-expanded={conversationMenuOpen} onClick={() => setConversationMenuOpen((current) => !current)}><MessageSquare /><span>会话</span><strong>{visibleIds.length}/{sceneIds.length}</strong><ChevronDown /></button>
          {conversationMenuOpen && <div className="conversation-menu">
            <div className="conversation-menu-header"><div><strong>{workspace.name}</strong><span>并排 {parallelCount} 栏，选择放进哪一栏</span></div><button onClick={openCreation}><Plus />新会话</button></div>
            <div className="conversation-menu-list">{sceneIds.map((id) => {
              const task = tasks.find((item) => item.id === id);
              const title = getBaseConversation(id).title;
              const objectType = isOutputObject(id) ? '成果' : '';
              const slotIndex = slots.indexOf(id);
              const placement = slotIndex >= 0 ? `第 ${slotIndex + 1} 栏` : viewMode === 'focus' && focusedId === id ? '聚焦中' : '未展示';
              return (
                <div key={id} className={`scene-row ${focusedId === id ? 'selected' : ''}`}>
                  <button className="scene-open" title="聚焦查看" onClick={() => focusConversation(id)}><span className="conversation-menu-name"><strong>{objectType && <em className="object-type">{objectType}</em>}{title}</strong><small className={slotIndex >= 0 ? 'placed' : ''}>{placement}</small></span>{task && <StatusBadge status={task.status} />}</button>
                  <div className="slot-picker" role="group" aria-label={`把「${title}」放进`}>
                    {slots.map((_, slot) => (
                      <button key={slot} aria-pressed={slotIndex === slot} aria-label={`把「${title}」放进第 ${slot + 1} 栏`} onClick={() => assignSlot(id, slot)}>第 {slot + 1} 栏</button>
                    ))}
                  </div>
                </div>
              );
            })}</div>
          </div>}
        </div>
 <div className="workspace-opener" ref={openerRef}>
          <button type="button" className="conversation-picker-trigger" aria-expanded={openerOpen} onClick={() => setOpenerOpen((current) => !current)}><FolderOpen /><span>打开…</span></button>
          {openerOpen && (
            <div className="conversation-menu opener-menu">
              <div className="conversation-menu-header"><div><strong>打开工作对象</strong><span>在当前工作区打开，默认聚焦</span></div></div>
              <label className="search-field opener-search"><Search /><input autoFocus value={openerQuery} onChange={(event) => setOpenerQuery(event.target.value)} placeholder="搜索书、笔记、文档" /></label>
              <div className="conversation-menu-list">
                {(() => {
                  const hit = (text) => text.toLowerCase().includes(openerQuery.trim().toLowerCase());
                  const shownBooks = books.filter((book) => hit(book.title));
                  const shownNotes = notes.filter((note) => hit(note.title));
                  const shownDocs = documents.filter((doc) => hit(doc.title));
                  return <>
                    {shownBooks.length > 0 && <p className="opener-group">书架</p>}
                    {shownBooks.map((book) => <button type="button" key={book.id} className="workspace-option" onClick={() => openObject(BOOK_OBJECT_PREFIX + book.id)}><BookOpen /><span className="conversation-menu-name"><strong>《{book.title}》</strong><small>{book.author}</small></span></button>)}
                    {shownNotes.length > 0 && <p className="opener-group">笔记库</p>}
                    {shownNotes.map((note) => <button type="button" key={note.id} className="workspace-option" onClick={() => openObject(NOTE_OBJECT_PREFIX + note.id)}><NotebookPen /><span className="conversation-menu-name"><strong>{note.title}</strong><small>{note.updated}</small></span></button>)}
                    {shownDocs.length > 0 && <p className="opener-group">文档</p>}
                    {shownDocs.map((doc) => {
                      const scope = scopeOf(doc);
                      const blocked = scope === '未授权使用';
                      return (
                        <div key={doc.id} className="opener-document">
                          <FileText />
                          <span className="conversation-menu-name"><strong>{doc.title}</strong><small>{doc.category} · {doc.format} · {blocked ? '未授权使用' : `范围：${scope}`}{doc.parsed ? '' : ' · 不可解析'}</small></span>
                          <span className="opener-document-actions">
                            <IconButton label="交给 Multivac" disabled={blocked} onClick={() => { setOpenerOpen(false); onHandToMultivac(`参考文档「${doc.title}」`, { title: doc.title }); }}><Bot /></IconButton>
                            <IconButton label="用于当前任务" disabled={blocked} onClick={() => applyDocumentToSession(doc)}><ListTodo /></IconButton>
                          </span>
                        </div>
                      );
                    })}
                    {!shownBooks.length && !shownNotes.length && !shownDocs.length && <p className="opener-empty">没有匹配的书、笔记或文档</p>}
                  </>;
                })()}
              </div>
              <div className="opener-footer"><button type="button" className="text-button" onClick={() => { setOpenerOpen(false); notify('已打开本地文件选择（示例），收藏后出现在「文档」里'); }}><Plus />收藏本地文档</button><span>使用范围在 设置 · 资料使用范围</span></div>
            </div>
          )}
        </div>
        <div className="workspace-controls">
          <label className="parallel-count" title="同时并排显示的会话数">
            <span>并排数</span>
            <select aria-label="并排数" value={parallelCount} onChange={(event) => changeParallelCount(Number(event.target.value))}>
              {PARALLEL_OPTIONS.map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <div className={`view-mode-switch ${viewMode}`} role="group" aria-label="工作区视图">
            <button aria-pressed={viewMode === 'parallel'} className={viewMode === 'parallel' ? 'active' : ''} onClick={returnToParallel}><Columns2 />并排</button>
            <button aria-pressed={viewMode === 'focus'} className={viewMode === 'focus' ? 'active' : ''} disabled={!focusedId} onClick={() => setViewMode('focus')}><Maximize2 />聚焦</button>
          </div>
        </div>
      </div>}
      {visibleIds.length ? <ResizableConversations parallel={viewMode === 'parallel'} labels={visibleIds.map((id) => getBaseConversation(id).title)} widths={scene.widths?.[parallelCount]} onWidthsChange={(widths) => updateScene({ widths: { ...scene.widths, [parallelCount]: widths } })}>
        {visibleIds.map((id) => {
          const slotLabel = viewMode === 'parallel' && slots.includes(id) ? `第 ${slots.indexOf(id) + 1} 栏` : '';
          if (isBookObject(id)) {
            const book = bookOf(id);
            const reading = readingOf(book.id);
            return (
              <BookObjectPanel
                key={id}
                book={book}
                reading={reading}
                onReadingChange={(patch) => updateReading(book.id, patch)}
                onHighlight={(text) => updateReading(book.id, { highlights: [...reading.highlights, { chapterId: book.chapters[reading.chapterIndex].id, text }] })}
                onThought={(text, note) => updateReading(book.id, { thoughts: [...reading.thoughts, { chapterId: book.chapters[reading.chapterIndex].id, text, note }] })}
                onAsk={(text) => { updateBookAssist(book.id, (assist) => ({ ...assist, quote: text })); if (!companionOpen(id)) toggleCompanion(id); }}
                onCollect={collectToNote}
                onHandToMultivac={(text) => onHandToMultivac(text, { title: `《${book.title}》` })}
                companion={<BookCompanion book={book} reading={reading} assist={bookAssistOf(book.id)} onAsk={(question) => askBook(book.id, question)} onDeepen={(text) => deepenBook(book.id, text)} onBack={() => backBook(book.id)} onCollectMarks={() => collectMarks(book)} onHandToMultivac={(text) => onHandToMultivac(text, { title: `《${book.title}》` })} />}
                slotLabel={slotLabel}
                focused={viewMode === 'focus'}
                active={focusedId === id}
                onActivate={() => setFocusedId(id)}
                onFocus={() => focusConversation(id)}
                onReturnToParallel={returnToParallel}
                onClose={() => closeObject(id)}
                companionOpen={companionOpen(id)}
                onToggleCompanion={() => toggleCompanion(id)}
              />
            );
          }
          if (isNoteObject(id)) {
            const note = noteOf(id);
            return (
              <NoteObjectPanel
                key={id}
                note={note}
                onChange={(content) => updateNote(note.id, content)}
                assist={assistOf(note.id)}
                onAssist={(prompt) => assistNote(note.id, prompt)}
                onAccept={(suggestionId) => settleSuggestion(note.id, suggestionId, true)}
                onReject={(suggestionId) => settleSuggestion(note.id, suggestionId, false)}
                onHandToMultivac={(text) => onHandToMultivac(text, { title: `笔记「${note.title}」` })}
                slotLabel={slotLabel}
                focused={viewMode === 'focus'}
                active={focusedId === id}
                onActivate={() => setFocusedId(id)}
                onFocus={() => focusConversation(id)}
                onReturnToParallel={returnToParallel}
                onClose={() => closeObject(id)}
                companionOpen={companionOpen(id)}
                onToggleCompanion={() => toggleCompanion(id)}
              />
            );
          }
          if (!isOutputObject(id)) return renderSession(id, { slotLabel });
          const output = outputOf(id);
          return (
            <OutputObjectPanel
              key={id}
              output={output}
              task={tasks.find((item) => item.id === output.taskId)}
              slotLabel={slotLabel}
              focused={viewMode === 'focus'}
              active={focusedId === id}
              onActivate={() => setFocusedId(id)}
              onFocus={() => focusConversation(id)}
              onReturnToParallel={returnToParallel}
              onClose={() => closeObject(id)}
              companionOpen={companionOpen(id)}
              onToggleCompanion={() => toggleCompanion(id)}
              onHandToMultivac={(text) => onHandToMultivac(text, { kind: 'output', outputId: output.id, taskId: output.taskId, title: output.title })}
              onCollect={collectToNote}
              companion={renderSession(output.taskId, { companion: true, key: `${id}-companion` })}
            />
          );
        })}
      </ResizableConversations> : <div className="workspace-empty"><MessageSquare /><h2>{workspace.name}还没有会话</h2><p>这个项目的任务开始后，会话会自动出现在这里。</p><button className="secondary" onClick={openCreation}><Plus />新会话</button></div>}

      {creating && <div className="creation-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false); }}><form className="creation-dialog" role="dialog" aria-modal="true" aria-labelledby="creation-title" onSubmit={submitCreation}><div className="creation-header"><div><span>{workspace.name}</span><h2 id="creation-title">创建新会话</h2></div><IconButton type="button" label="关闭" onClick={() => setCreating(false)}><X /></IconButton></div><label><span>会话名称</span><input autoFocus value={creationName} onChange={(event) => setCreationName(event.target.value)} placeholder="例如：梳理导航结构" /></label><p>{workspace.project ? `新会话属于项目“${workspace.project.name}”，使用它的目录与权限。` : '新会话不属于任何项目，之后可以再归入项目。'}</p><div className="creation-actions"><button type="button" className="secondary" onClick={() => setCreating(false)}>取消</button><button type="submit" className="primary" disabled={!creationName.trim()}>创建</button></div></form></div>}
    </div>
  );
}

function RunTrace({ trace }) {
  const [open, setOpen] = useState(Boolean(trace.defaultOpen || trace.status === 'running'));
  useEffect(() => {
    if (trace.status === 'running') setOpen(true);
  }, [trace.status]);
  const summary = trace.status === 'running' ? '思考中' : trace.status === 'cancelled' ? '已停止' : trace.duration || '处理完成';
  return <details className={`run-trace ${trace.status || 'done'}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{summary}</span>{trace.capabilities?.length > 0 && <span className="trace-capabilities">用了：{trace.capabilities.join(' · ')}</span>}<ChevronRight className="disclosure-chevron" /></summary>
    <div className="run-trace-content">{trace.entries.map((entry, index) => {
      if (entry.kind === 'thought') return <p className="run-trace-thought" key={`${trace.id}-thought-${index}`}>{entry.text}</p>;
      const Icon = entry.status === 'running' ? LoaderCircle : entry.tool === 'edit' ? Pencil : entry.tool === 'run' ? Terminal : FileText;
      return <div className={`run-trace-tool ${entry.status || 'done'}`} key={entry.id || `${trace.id}-tool-${index}`}><Icon className={entry.status === 'running' ? 'status-spinner' : ''} /><span>{entry.action}</span></div>;
    })}</div>
  </details>;
}

function ToolResult({ message }) {
  const [copyState, setCopyState] = useState('');
  useEffect(() => {
    if (!copyState) return;
    const timer = window.setTimeout(() => setCopyState(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const Icon = message.status === 'error' ? CircleAlert : message.status === 'cancelled' ? CircleStop : message.status === 'running' ? LoaderCircle : CheckCircle2;
  return <details className={`tool-result ${message.status || 'done'}`} open={message.status === 'error' ? true : undefined}>
    <summary><Icon className={message.status === 'running' ? 'status-spinner' : ''} /><span><strong>{message.summary || '工具执行记录'}</strong>{message.detail && <small>{message.detail}</small>}</span><ChevronRight className="disclosure-chevron" /></summary>
    <div className="tool-result-body"><div className="tool-result-heading"><span>执行记录</span><IconButton label={copyState || '复制执行记录'} onClick={async () => { try { await navigator.clipboard.writeText(message.text); setCopyState('已复制'); } catch { setCopyState('复制失败，请选择文本复制'); } }}>{copyState === '已复制' ? <Check /> : <Copy />}</IconButton></div><pre>{message.text}</pre></div>
  </details>;
}

function ConversationPanel({ onCollect, sessionId, execution, references = [], companion = false, slotLabel = '', onHandToMultivac, conversation, sessionState, setSessionState, task, request, requestControls, onOpenTask, onFocus, onReturnToParallel, focused, active, onActivate, stackPath = [], stackSource, onBackStack, onCreateStack, notify, models, manageModels }) {
  const { draft, messages, modelId, thinkingLevel } = sessionState;
  const [selection, setSelection] = useState(null);
  const [quote, setQuote] = useState('');
  const panelRef = useRef(null);
  const messagesRef = useRef(null);
  const composerRef = useRef(null);
  // 工作区会话里调用 Skill 在当前会话执行，只列出本会话实际可用的 Skill。
  const picker = useComposerPicker({
    draft,
    setDraft: (value) => setSessionState({ draft: value }),
    textareaRef: composerRef,
    skills: (execution?.usable || []).filter((item) => item.kind === 'skill' && !execution.paused.includes(item.id)),
    references,
  });
  const focusComposerOnActivate = useRef(false);
  const [runFeedback, setRunFeedback] = useState({ phase: 'idle', message: '' });
  const timers = useRef([]);
  const sessionMessagesRef = useRef(messages);

  // 平行视图里只有当前会话展开完整输入区；其余会话有未发送内容时保持展开，避免藏起草稿。
  const composerCollapsed = !active && !focused && !draft.trim() && !quote;

  useEffect(() => {
    if (!active || !focusComposerOnActivate.current) return;
    focusComposerOnActivate.current = false;
    composerRef.current?.focus();
  }, [active]);
  const activeTraceId = useRef(null);
  const running = activeRunPhases.has(runFeedback.phase);

  function clearRunTimers() {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  }

  function later(delay, callback) {
    const timer = window.setTimeout(callback, delay);
    timers.current.push(timer);
  }

  function commitMessages(updater) {
    const next = updater(sessionMessagesRef.current);
    sessionMessagesRef.current = next;
    setSessionState({ messages: next });
  }

  function updateTrace(id, updater) {
    commitMessages((current) => current.map((message) => message.id === id ? updater(message) : message));
  }

  function finishRun(traceId) {
    const model = models.find((item) => item.id === modelId);
    commitMessages((current) => [...current.map((message) => message.id === traceId ? {
      ...message,
      status: 'done',
      duration: `用时 ${Math.max(1, Math.round((Date.now() - message.startedAt) / 1000))} 秒`,
      entries: message.entries.map((entry) => entry.kind === 'tool' && entry.status === 'running' ? { ...entry, status: 'done' } : entry),
    } : message), { who: 'Coding Agent', text: `已完成这一轮处理。我会使用 ${model?.name || '当前模型'} 在这个会话的上下文中继续推进。` }]);
    activeTraceId.current = null;
    setRunFeedback({ phase: 'succeeded', message: '处理完成' });
    later(1800, () => setRunFeedback({ phase: 'idle', message: '' }));
  }

  function startRun(prompt, traceId, steering) {
    clearRunTimers();
    if (activeTraceId.current) updateTrace(activeTraceId.current, (trace) => ({ ...trace, status: 'cancelled', duration: '已停止', entries: [...trace.entries, { kind: 'thought', text: '收到补充指令，本轮过程已停止。' }] }));
    activeTraceId.current = traceId;
    setRunFeedback(steering ? { phase: 'processing', message: '已补充指令，继续处理' } : { phase: 'accepted', message: '消息已接收' });
    later(800, () => {
      updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { kind: 'thought', text: '已结合当前会话定位需要处理的上下文。' }] }));
      setRunFeedback({ phase: 'processing', message: '工作会话正在处理' });
    });
    if (/文件|代码|修改|检查|运行|测试|命令/u.test(prompt)) {
      const toolId = `${traceId}-tool`;
      later(1800, () => {
        updateTrace(traceId, (trace) => ({ ...trace, capabilities: [...new Set([...(trace.capabilities || []), '文件与命令'])], entries: [...trace.entries, { id: toolId, kind: 'tool', tool: /运行|测试|命令/u.test(prompt) ? 'run' : 'edit', action: /运行|测试|命令/u.test(prompt) ? '运行工作区检查' : '检查相关文件', status: 'running' }] }));
        setRunFeedback({ phase: 'tool', message: '正在使用工作区工具' });
      });
      later(2800, () => {
        updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries.map((entry) => entry.id === toolId ? { ...entry, status: 'done' } : entry), { kind: 'thought', text: '工具结果已经纳入本轮回复。' }] }));
        setRunFeedback({ phase: 'processing', message: '工具执行完成，继续处理' });
      });
      later(4000, () => finishRun(traceId));
    } else {
      later(1900, () => updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { kind: 'thought', text: '处理重点已经整理完成。' }] })));
      later(2800, () => finishRun(traceId));
    }
  }

  function send() {
    const prompt = draft.trim();
    if (!prompt) return;
    const traceId = crypto.randomUUID();
    followLatest();
    const model = models.find((item) => item.id === modelId) || models[0];
    const run = { model: model.name, thinking: effectiveThinking(thinkingLevel, model) };
    // 在工作区会话里调用 Skill 直接在当前会话执行，轨迹注明用到的 Skill。
    // 作为伴随会话时只讨论这份成果；安排新工作的意图提示交给 Multivac，不在这里执行。
    if (companion && isArrangementIntent(prompt)) {
      const nextMessages = [...sessionMessagesRef.current, { who: '你', text: prompt, quote }, { who: '伴随会话', handover: quote ? `${prompt}：${quote}` : prompt, text: '这是在安排新工作，交给 Multivac 更合适：它负责安排任务，这里只讨论这份成果。' }];
      sessionMessagesRef.current = nextMessages;
      setSessionState({ draft: '', messages: nextMessages });
      setQuote('');
      return;
    }
    const skill = prompt.match(/^\/(\S+)/u)?.[1];
    const nextMessages = [...sessionMessagesRef.current, { who: '你', text: prompt, quote }, { id: traceId, who: 'trace', trace: true, status: 'running', startedAt: Date.now(), capabilities: skill ? [`${skill} Skill`] : [], entries: [...runSettingsEntry(run), { kind: 'thought', text: running ? '正在吸收补充指令，并调整当前工作。' : '正在理解这条指令，并规划本轮处理。' }] }];
    sessionMessagesRef.current = nextMessages;
    setSessionState({ draft: '', messages: nextMessages });
    setQuote('');
    startRun(prompt, traceId, running);
  }

  function stopRun() {
    clearRunTimers();
    if (activeTraceId.current) {
      updateTrace(activeTraceId.current, (trace) => ({ ...trace, status: 'cancelled', duration: '已停止', entries: [...trace.entries, { kind: 'thought', text: '已按要求停止处理。' }] }));
      activeTraceId.current = null;
    }
    setRunFeedback({ phase: 'cancelled', message: '处理已取消' });
    later(1800, () => setRunFeedback({ phase: 'idle', message: '' }));
  }

  useEffect(() => () => clearRunTimers(), []);

  useEffect(() => {
    sessionMessagesRef.current = messages;
  }, [messages]);

  const { handleScroll, followLatest } = useStickToBottom(
    messagesRef,
    [messages, runFeedback.phase],
  );

  // 就地回答请求不切换当前会话：否则输入区随激活展开，按钮在点击落下前就被挪开。
  function activateUnlessRequest(event) {
    if (!event.target.closest('.inline-request')) onActivate();
  }

  function captureSelection() {
    const current = window.getSelection();
    const text = current?.toString().replace(/\s+/g, ' ').trim();
    if (!text || !current.rangeCount) {
      setSelection(null);
      return;
    }
    const range = current.getRangeAt(0);
    if (!panelRef.current?.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    const toolbarWidth = 330;
    setSelection({
      text,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - toolbarWidth - 12)),
      top: Math.min(rect.bottom + 8, window.innerHeight - 48),
    });
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function quoteSelection() {
    setQuote(selection.text);
    clearSelection();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  return (
    <section ref={panelRef} className={`conversation-panel ${focused ? 'focused' : ''} ${active ? 'active' : ''}`} onMouseDown={activateUnlessRequest} onFocus={activateUnlessRequest}>
      <header className="conversation-header">
        <div className="conversation-title">
          {onBackStack && <IconButton label="返回父会话" onClick={onBackStack}><ArrowLeft /></IconButton>}
          <div>{stackPath.length > 0 && <div className="conversation-path">栈式路径 · {stackPath.join(' / ')}</div>}<h2>{slotLabel && <span className="slot-tag">{slotLabel}</span>}{conversation.title}</h2>{execution && <SessionCapabilities execution={execution} />}{task && <button className="conversation-task-link" onClick={() => onOpenTask(task.id, 'tasks')}><ListTodo /><span>{task.title}</span><ChevronRight /></button>}</div>
        </div>
        {/* 伴随会话的放大、关闭由所属应用对象统一控制。 */}
        {companion ? <span className="companion-label">伴随会话</span> : <div className="conversation-tools">{focused ? <button className="return-parallel" onClick={onReturnToParallel}><Columns2 />返回平行视图</button> : <IconButton label="放大会话" onClick={onFocus}><Maximize2 /></IconButton>}</div>}
      </header>
      {stackSource && <div className="stack-source"><SquareStack /><div><span>来自父会话的选中内容</span><p>{stackSource}</p></div></div>}
      <div ref={messagesRef} className="conversation-messages" onScroll={handleScroll} onMouseUp={captureSelection}>
        {[...conversation.messages, ...messages].map((message, index, all) => {
          if (message.trace) return <RunTrace key={message.id} trace={message} />;
          if (message.tool) return <ToolResult key={index} message={message} />;
          const speaker = message.who === 'Coding Agent' ? 'Multivac' : message.who;
          // 连续同一发言人只在第一条标名字，长会话里不再每条都重复一遍。
          const previous = all[index - 1];
          const repeated = previous && !previous.trace && !previous.tool &&
            (previous.who === 'Coding Agent' ? 'Multivac' : previous.who) === speaker;
          if (message.handover) return <HandoverHint key={index} text={message.text} onHandOver={() => onHandToMultivac?.(message.handover, { sessionId, title: conversation.title })} />;
          return <div key={index} className={`work-message ${message.who === '你' ? 'user-message' : ''} ${message.who === '任务' ? 'goal-message' : ''} ${repeated ? 'continued' : ''}`}>{!repeated && <div>{speaker}</div>}{message.quote && <blockquote className="message-quote"><Quote />{message.quote}</blockquote>}<p><MessageText text={message.text} /></p></div>;
        })}
      </div>
      {selection && <div className="selection-toolbar" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()}>
        <button onClick={quoteSelection}><Quote />引用</button>
        {onCollect && <button onClick={() => { onCollect(selection.text, conversation.title); clearSelection(); }}><NotebookPen />收进笔记</button>}
        <button onClick={() => { onCreateStack?.(selection.text); clearSelection(); }}><SquareStack />深入一层</button>
        {/* 把选中内容连同来源会话交给侧栏里的 Multivac，当前会话保持原样。 */}
        <button onClick={() => { onHandToMultivac?.(selection.text, { sessionId, title: conversation.title }); clearSelection(); }}><Bot />交给 Multivac</button>
        <IconButton label="关闭" onClick={clearSelection}><X /></IconButton>
      </div>}
      {request
        ? <InlineRequest request={request} {...requestControls} />
        : task && <div className="session-progress"><StatusBadge status={task.status} /><span title={task.reason}>{task.reason}</span></div>}
      {composerCollapsed ? (
        <div className="work-composer collapsed">
          <button
            type="button"
            className="composer-collapsed-trigger"
            aria-label={`在「${conversation.title}」中继续`}
            // 阻止默认聚焦：按钮会在展开时卸载，浏览器默认把焦点交给它会落到 body 上，
            // 覆盖掉我们随后对输入框的聚焦。激活仍由外层 section 的 mousedown 触发。
            onMouseDown={(event) => { event.preventDefault(); focusComposerOnActivate.current = true; }}
            onFocus={() => { focusComposerOnActivate.current = true; }}
          >
            继续当前工作…
          </button>
          <RunStatus feedback={runFeedback} stop={stopRun} compact />
        </div>
      ) : <div className="work-composer">{quote && <div className="composer-quote"><Quote /><div><span>引用选中内容</span><p>{quote}</p></div><IconButton label="移除引用" onClick={() => setQuote('')}><X /></IconButton></div>}{picker.popup}<textarea ref={composerRef} aria-label={`发送到${conversation.title}`} value={draft} onChange={(event) => setSessionState({ draft: event.target.value })} placeholder={quote ? '基于这段内容继续讨论…' : companion ? '讨论这份成果…（安排新工作请交给 Multivac）' : '继续当前工作…（/ 调用 Skill，@ 引用）'} onKeyDown={(event) => { if (picker.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} /><div><div className="work-composer-tools"><ModelSelector models={models} modelId={modelId} setModelId={(value) => setSessionState({ modelId: value })} thinkingLevel={thinkingLevel} setThinkingLevel={(value) => setSessionState({ thinkingLevel: value })} manageModels={manageModels} compact /><IconButton label="@ 引用文件、成果或资源" onClick={picker.startReference}><AtSign /></IconButton></div><RunStatus feedback={runFeedback} stop={stopRun} compact /><IconButton label={running ? '补充指令' : '发送'} disabled={!draft.trim()} className="send-button" onClick={send}><ArrowRight /></IconButton></div></div>}
    </section>
  );
}

const requestTone = { 澄清: 'red', 验收: 'blue', 外发授权: 'amber', 工具授权: 'amber' };

/**
 * 就地请求：请求所属会话正好在现场时，直接在会话底部回答，不移动焦点。
 * 与 Inbox 是同一条记录、共用同一份草稿，任一处处理后两处同时消失。
 */
function InlineRequest({ request, resolveRequest, draft, updateDraft }) {
  const choice = draft.choice || '';
  const answer = draft.answer || '';
  // 需要补充文字的选项（指定范围、要求修改）先展开输入，再提交。
  const writing = (request.type === '澄清' && choice === 'custom') || (request.type === '验收' && choice === 'revise');

  function submit(event) {
    event.preventDefault();
    if (canSubmitDecision(request.type, choice, answer)) resolveRequest(request.id, choice, answer);
  }

  return (
    <div className="inline-request" role="region" aria-label={`${request.type}请求`}>
      <div className="inline-request-head">
        <span className={`request-type ${requestTone[request.type]}`}>{request.type}</span>
        <strong>{request.title}</strong>
        <span>{request.impact} · 与 Inbox 同步</span>
      </div>
      {request.capability && <p className="grant-capability">{request.capability} · {EFFECT_LABELS[request.effect]}</p>}
      {writing ? (
        <form className="inline-request-form" onSubmit={submit}>
          <input autoFocus aria-label={choice === 'custom' ? '范围说明' : '修改意见'} value={answer} onChange={(event) => updateDraft({ answer: event.target.value })} placeholder={choice === 'custom' ? '例如：只引用笔记中的公开资料摘要' : '需要修改的具体意见…'} />
          <button type="button" className="secondary" onClick={() => updateDraft({ choice: '' })}>返回</button>
          <button type="submit" className="primary" disabled={!canSubmitDecision(request.type, choice, answer)}>{choice === 'custom' ? '确认范围' : '提交意见'}</button>
        </form>
      ) : (
        <div className="inline-request-actions">
          {request.type === '澄清' && <>
            <button className="secondary" onClick={() => updateDraft({ choice: 'custom' })}>指定其他范围</button>
            <button className="secondary" onClick={() => resolveRequest(request.id, 'deny')}>不使用</button>
            <button className="primary" onClick={() => resolveRequest(request.id, 'allow')}><Check />允许本次使用</button>
          </>}
          {request.type === '验收' && <>
            <button className="secondary" onClick={() => updateDraft({ choice: 'revise' })}>要求修改</button>
            <button className="primary" onClick={() => resolveRequest(request.id, 'accept')}><Check />接受成果</button>
          </>}
          {request.type === '工具授权' && <>
            <button className="secondary danger" onClick={() => resolveRequest(request.id, 'deny')}>拒绝</button>
            <button className="secondary" onClick={() => resolveRequest(request.id, 'once')}>仅这一次</button>
            <button className="secondary" onClick={() => resolveRequest(request.id, 'task')}>本任务内允许</button>
            <button className="primary" onClick={() => resolveRequest(request.id, 'project')}>本项目内始终允许</button>
          </>}
          {request.type === '外发授权' && <>
            <button className="secondary danger" onClick={() => resolveRequest(request.id, 'deny')}>拒绝外发</button>
            <button className="primary" onClick={() => resolveRequest(request.id, 'allow')}><Send />允许本次发布</button>
          </>}
        </div>
      )}
    </div>
  );
}

/**
 * 成果抽屉：日常层的取回入口。看一眼、拿来用；细看进工作区，完整视图在管理模式的成果页。
 * 待验收只给出去 Inbox 的链接，验收动作不在这里重复一套。
 */
/**
 * 会话标题栏的执行配置行：“智能体 · 能力：…”，点开可查看，并对这个会话临时关闭某项能力。
 * Multivac 的输入框不显示这一行：协调者不直接调用外部能力。
 */
function SessionCapabilities({ execution }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const active = execution.usable.filter((capability) => !execution.paused.includes(capability.id));
  const names = active.map((capability) => capability.name);
  const label = names.length ? `${names.slice(0, 2).join('、')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : '无';

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [open]);

  return (
    <div className="session-capabilities" ref={root}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}><UserCog />{execution.agentName} · 能力：{label}<ChevronDown /></button>
      {open && (
        <div className="session-capabilities-menu" role="dialog" aria-label="本会话的能力">
          <p>本会话临时关闭的能力不影响项目边界和智能体配置。</p>
          <ul>
            {execution.usable.map((capability) => (
              <li key={capability.id}><label><input type="checkbox" checked={!execution.paused.includes(capability.id)} onChange={() => execution.onToggle(capability.id)} /><span>{capability.name}</span><small>{capability.kind === 'skill' ? 'Skill' : EFFECT_LABELS[capabilityEffect(capability)]}</small></label></li>
            ))}
            {execution.blocked.map(({ capability, reason }) => <li key={capability.id} className="blocked"><span>{capability.name}</span><small>{reason}</small></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * 页面里的文字选区：选中内容后在旁边出现操作条（交给 Multivac、收进笔记……）。
 * 只认 containerRef 里面的选区。
 */
function useTextSelection(containerRef) {
  const [selection, setSelection] = useState(null);

  function capture() {
    const current = window.getSelection();
    const text = current?.toString().replace(/\s+/g, ' ').trim();
    if (!text || !current.rangeCount || !containerRef.current?.contains(current.getRangeAt(0).commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const rect = current.getRangeAt(0).getBoundingClientRect();
    setSelection({ text, left: Math.max(12, Math.min(rect.left, window.innerWidth - 320)), top: Math.min(rect.bottom + 8, window.innerHeight - 48) });
  }

  function clear() {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  return { selection, capture, clear };
}

/**
 * 应用对象的外壳：主视图 + 可收起的伴随会话，外加放大 / 返回并排 / 关闭。
 * 成果、笔记、书共用；伴随会话的展开状态由工作区按对象记住。
 */
function ObjectShell({ kind, icon: Icon, title, meta, slotLabel, focused, active, onActivate, onFocus, onReturnToParallel, onClose, companionLabel, companionOpen, onToggleCompanion, main, companion, toolbar }) {
  return (
    <section className={`object-panel ${active ? 'active' : ''} ${companionOpen ? 'with-companion' : ''}`} onMouseDown={onActivate} aria-label={`${kind}：${title}`}>
      <header className="conversation-header object-header">
        <div className="conversation-title">
          <span className="file-icon"><Icon /></span>
          <div>
            <h2>{slotLabel && <span className="slot-tag">{slotLabel}</span>}<em className="object-type">{kind}</em>{title}</h2>
            <span className="object-meta">{meta}</span>
          </div>
        </div>
        <div className="conversation-tools">
          <button className={`companion-toggle ${companionOpen ? 'active' : ''}`} aria-pressed={companionOpen} onClick={onToggleCompanion}><MessageSquare />{companionLabel}</button>
          {focused ? <button className="return-parallel" onClick={onReturnToParallel}><Columns2 />返回平行视图</button> : <IconButton label={`放大${kind}`} onClick={onFocus}><Maximize2 /></IconButton>}
          <IconButton label={`关闭${kind}`} onClick={onClose}><X /></IconButton>
        </div>
      </header>
      <div className="object-body">
        {main}
        {companionOpen && <div className="object-companion">{companion}</div>}
      </div>
      {toolbar}
    </section>
  );
}

/** 选区操作条：交给 Multivac、收进笔记等，按调用方传入的动作渲染。 */
function SelectionToolbar({ selection, actions, onClose }) {
  if (!selection) return null;
  return (
    <div className="selection-toolbar" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()}>
      {actions.map(({ label, icon: Icon, onClick }) => <button key={label} onClick={() => onClick(selection.text)}><Icon />{label}</button>)}
      <IconButton label="关闭" onClick={onClose}><X /></IconButton>
    </div>
  );
}

/**
 * 成果查看器：第一种应用对象。主视图是成果本身，伴随会话是产出它的任务会话，可收起。
 * 选中成果里的内容可以交给 Multivac（来源记为这份成果），或收进笔记。
 */
function OutputObjectPanel({ output, task, companion, onHandToMultivac, onCollect, ...shell }) {
  const viewerRef = useRef(null);
  const { selection, capture, clear } = useTextSelection(viewerRef);
  const act = (handler) => (text) => { handler(text); clear(); };
  return (
    <ObjectShell
      {...shell}
      kind="成果"
      icon={output.icon}
      title={output.title}
      meta={`${output.type} · ${output.updated}${task ? ` · 来源任务：${task.title}` : ''}`}
      companionLabel="伴随会话"
      companion={companion}
      main={(
        <article ref={viewerRef} className="object-viewer" onMouseUp={capture}>
          <div className="preview-document">
            <div className="document-kicker">MULTIVAC / WORK PRODUCT</div>
            <h1>{output.title}</h1>
            <p className="document-lead">{output.summary}</p>
            <h2>本次结论</h2>
            <p>原型需要完整表现用户如何从协调层进入具体工作，又如何在不丢失现场的前提下返回。关键不是同时展示多少任务，而是让状态、阻塞和下一步容易判断。</p>
            <h2>验证结果</h2>
            <ul>{output.checks.map((check) => <li key={check}>{check}</li>)}</ul>
          </div>
        </article>
      )}
      toolbar={<SelectionToolbar selection={selection} onClose={clear} actions={[
        { label: '收进笔记', icon: NotebookPen, onClick: act((text) => onCollect(text, `成果「${output.title}」`)) },
        { label: '交给 Multivac', icon: Bot, onClick: act(onHandToMultivac) },
      ]} />}
    />
  );
}

/**
 * 笔记对象：Markdown 编辑器 + 梳理助手（伴随会话）。
 * 你的内容默认只提建议：助手的修改以差异形式给出，逐条接受或拒绝，不直接改正文。
 */
function NoteObjectPanel({ note, onChange, assist, onAssist, onAccept, onReject, onHandToMultivac, ...shell }) {
  const editorRef = useRef(null);
  const [picked, setPicked] = useState('');

  // textarea 里的选区用 selectionStart / End 读取，选中后在编辑器上方给出操作。
  function captureEditorSelection() {
    const editor = editorRef.current;
    setPicked(editor ? editor.value.slice(editor.selectionStart, editor.selectionEnd).trim() : '');
  }

  return (
    <ObjectShell
      {...shell}
      kind="笔记"
      icon={NotebookPen}
      title={note.title}
      meta={`Markdown · ${note.updated}`}
      companionLabel="梳理助手"
      companion={<NoteAssistant note={note} assist={assist} onAssist={onAssist} onAccept={onAccept} onReject={onReject} onHandToMultivac={onHandToMultivac} />}
      main={(
        <div className="note-editor-wrap">
          {picked && <div className="note-selection-bar"><span>已选中 {picked.length} 字</span><button type="button" className="inline-link" onMouseDown={(event) => event.preventDefault()} onClick={() => { onHandToMultivac(picked); setPicked(''); }}>交给 Multivac<ArrowRight /></button></div>}
          <textarea ref={editorRef} className="note-editor" aria-label={`编辑笔记：${note.title}`} value={note.content} onChange={(event) => onChange(event.target.value)} onSelect={captureEditorSelection} spellCheck={false} />
        </div>
      )}
    />
  );
}

/**
 * 书对象：阅读器 + 书伴。阅读器记住读到哪一章哪一段；选中文字可以划线、写想法、问书伴、
 * 收进笔记或交给 Multivac。划线与想法可以一键收进笔记。
 */
function BookObjectPanel({ book, reading, onReadingChange, onHighlight, onThought, onAsk, onCollect, onHandToMultivac, companion, ...shell }) {
  const readerRef = useRef(null);
  const { selection, capture, clear } = useTextSelection(readerRef);
  const [thought, setThought] = useState(null);
  const chapter = book.chapters[reading.chapterIndex];
  const highlights = (reading.highlights || []).filter((item) => item.chapterId === chapter.id).map((item) => item.text);
  const thoughts = (reading.thoughts || []).filter((item) => item.chapterId === chapter.id);
  const act = (handler) => (text) => { handler(text); clear(); };

  // 滚动时记下最上方可见的一段，书伴据此知道你读到哪。
  function trackPosition() {
    const reader = readerRef.current;
    const paragraphs = [...reader.querySelectorAll('[data-paragraph]')];
    const top = reader.getBoundingClientRect().top;
    const current = paragraphs.find((element) => element.getBoundingClientRect().bottom > top + 24);
    if (current) onReadingChange({ paragraphIndex: Number(current.dataset.paragraph) });
  }

  function goChapter(index) {
    onReadingChange({ chapterIndex: index, paragraphIndex: 0, furthest: Math.max(reading.furthest, index) });
    readerRef.current.scrollTop = 0;
  }

  // 划线用 <mark> 包住命中的片段，只在展示层处理，不改原文。
  function renderParagraph(text) {
    const hit = highlights.find((item) => text.includes(item));
    if (!hit) return text;
    const [before, ...rest] = text.split(hit);
    return <>{before}<mark>{hit}</mark>{rest.join(hit)}</>;
  }

  return (
    <ObjectShell
      {...shell}
      kind="书"
      icon={BookOpen}
      title={`《${book.title}》`}
      meta={`${book.author} · 读到${chapterLabel(chapter)}第 ${reading.paragraphIndex + 1} 段`}
      companionLabel="书伴"
      companion={companion}
      main={(
        <div className="book-reader-wrap">
          <nav className="book-nav" aria-label="章节">
            <button type="button" className="text-button" disabled={reading.chapterIndex === 0} onClick={() => goChapter(reading.chapterIndex - 1)}><ArrowLeft />上一章</button>
            <strong>{chapter.title}</strong>
            <button type="button" className="text-button" disabled={reading.chapterIndex === book.chapters.length - 1} onClick={() => goChapter(reading.chapterIndex + 1)}>下一章<ArrowRight /></button>
          </nav>
          {thought && (
            <div className="book-thought">
              <q>{excerptOf(thought.text, 60)}</q>
              <textarea autoFocus aria-label="写下想法" value={thought.note} onChange={(event) => setThought({ ...thought, note: event.target.value })} placeholder="这段让你想到什么…" />
              <div><button type="button" className="secondary" onClick={() => setThought(null)}>取消</button><button type="button" className="primary" disabled={!thought.note.trim()} onClick={() => { onThought(thought.text, thought.note.trim()); setThought(null); }}>保存想法</button></div>
            </div>
          )}
          <article ref={readerRef} className="book-reader" onScroll={trackPosition} onMouseUp={capture}>
            {chapter.paragraphs.map((text, index) => (
              <p key={index} data-paragraph={index} className={index === reading.paragraphIndex ? 'current' : ''}>
                {renderParagraph(text)}
                {thoughts.filter((item) => text.includes(item.text)).map((item, key) => <span key={key} className="book-thought-note" title={item.text}><Pencil />{item.note}</span>)}
              </p>
            ))}
          </article>
        </div>
      )}
      toolbar={<SelectionToolbar selection={selection} onClose={clear} actions={[
        { label: '划线', icon: Highlighter, onClick: act(onHighlight) },
        { label: '写想法', icon: Pencil, onClick: act((text) => setThought({ text, note: '' })) },
        { label: '问书伴', icon: MessageSquare, onClick: act(onAsk) },
        { label: '收进笔记', icon: NotebookPen, onClick: act((text) => onCollect(text, `《${book.title}》${chapter.title}`)) },
        { label: '交给 Multivac', icon: Bot, onClick: act(onHandToMultivac) },
      ]} />}
    />
  );
}

/** 章节短标签，如“第 9 章”。 */
const chapterLabel = (chapter) => chapter.title.match(/^第 \S+ 章/u)?.[0] || chapter.title;

/**
 * 书伴：知道你读到哪、选中了什么，默认不剧透；长期保留，深入讨论以栈式展开。
 * 只讨论这本书，说出安排类意图时提示交给 Multivac。
 */
function BookCompanion({ book, reading, assist, onAsk, onDeepen, onBack, onCollectMarks, onHandToMultivac }) {
  const [draft, setDraft] = useState('');
  const chapter = book.chapters[reading.chapterIndex];
  const level = assist.stack[assist.stack.length - 1];
  const marks = (reading.highlights || []).length + (reading.thoughts || []).length;
  useEffect(() => {
    if (assist.quote) setDraft((current) => current || '这段怎么理解？');
  }, [assist.quote]);
  const send = () => {
    if (!draft.trim()) return;
    onAsk(draft.trim());
    setDraft('');
  };
  return (
    <div className="note-assistant book-companion">
      <div className="companion-status">
        <span>读到：{chapterLabel(chapter)}第 {reading.paragraphIndex + 1} 段{assist.quote ? ` · 选中「${excerptOf(assist.quote, 16)}」` : ''}</span>
        {marks > 0 && <button type="button" className="inline-link" onClick={onCollectMarks}>划线与想法收进笔记（{marks}）</button>}
      </div>
      {assist.stack.length > 1 && <div className="companion-path"><IconButton label="返回上一层" onClick={onBack}><ArrowLeft /></IconButton><span>{assist.stack.map((item) => item.title).join(' / ')}</span></div>}
      <div className="note-assistant-thread">
        {assist.stack.length === 1 && <p className="assistant-line">我是《{book.title}》的书伴：知道你读到哪、选中了什么，不会剧透后面的章节。上次聊过的都还在。</p>}
        {level.thread.map((message, index) => (
          message.handover ? (
            <HandoverHint key={index} text={message.text} onHandOver={() => onHandToMultivac(message.handover)} />
          ) : (
            <div key={index} className={message.who === '你' ? 'user-line' : 'assistant-line'}>
              <p>{message.text}</p>
              {message.topic && <button type="button" className="inline-link" onClick={() => onDeepen(message.topic)}><SquareStack />深入一层</button>}
            </div>
          )
        ))}
      </div>
      <div className="work-composer note-assistant-composer">
        {assist.quote && <div className="composer-quote"><Quote /><div><span>选中内容</span><p>{assist.quote}</p></div></div>}
        <textarea aria-label={`和书伴讨论：${book.title}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="讨论这本书…（安排工作请交给 Multivac）" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      </div>
    </div>
  );
}

/** 分工提示：伴随会话只讨论当前对象，说出安排类意图时提示改为交给 Multivac。 */
function HandoverHint({ text, onHandOver }) {
  return <div className="handover-hint"><p>{text}</p><button type="button" className="secondary" onClick={onHandOver}><Bot />交给 Multivac</button></div>;
}

/** 梳理助手：只讨论这篇笔记，把修改以差异建议给出。 */
function NoteAssistant({ note, assist, onAssist, onAccept, onReject, onHandToMultivac }) {
  const [draft, setDraft] = useState('');
  const send = (text) => {
    if (!text.trim()) return;
    onAssist(text.trim());
    setDraft('');
  };
  return (
    <div className="note-assistant">
      <div className="note-assistant-thread">
        <p className="assistant-line">我是这篇笔记的梳理助手：整理结构、润色、补关联。修改都会以建议给出，由你逐条决定。</p>
        {assist.thread.map((message, index) => message.handover
          ? <HandoverHint key={index} text={message.text} onHandOver={() => onHandToMultivac(message.handover)} />
          : <p key={index} className={message.who === '你' ? 'user-line' : 'assistant-line'}>{message.text}</p>)}
        {assist.suggestions.map((suggestion) => (
          <div key={suggestion.id} className="note-suggestion">
            <span className="note-suggestion-reason">{suggestion.reason}</span>
            {suggestion.before && <pre className="diff-before">{suggestion.before}</pre>}
            <pre className="diff-after">{suggestion.after}</pre>
            {suggestion.stale && <small>正文里对应的内容已经被你改过，这条建议不再适用。</small>}
            <div><button type="button" className="secondary" onClick={() => onReject(suggestion.id)}>拒绝</button><button type="button" className="primary" disabled={suggestion.stale} onClick={() => onAccept(suggestion.id)}><Check />接受</button></div>
          </div>
        ))}
      </div>
      <div className="note-assistant-quick">{['整理结构', '润色', '补关联'].map((text) => <button key={text} type="button" onClick={() => send(text)}>{text}</button>)}</div>
      <div className="work-composer note-assistant-composer">
        <textarea aria-label={`和梳理助手讨论：${note.title}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="讨论这篇笔记：整理结构、润色、补关联…（安排工作请交给 Multivac）" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(draft); } }} />
      </div>
    </div>
  );
}

function OutputsDrawer({ items, close, onPreview, onHandOver, onEnterScene, onOpenInbox, onExpand }) {
  const [expandedId, setExpandedId] = useState(null);

  function togglePreview(item) {
    const next = expandedId === item.id ? null : item.id;
    setExpandedId(next);
    if (next) onPreview(item.id);
  }

  return (
    <div className="outputs-drawer">
      <header className="inbox-drawer-header"><h2 id="outputs-drawer-title">成果</h2><span>最近 {items.length} 份</span><IconButton label="关闭成果" onClick={close}><X /></IconButton></header>
      <ul className="outputs-drawer-list">
        {items.map((item) => {
          const Icon = item.icon;
          const expanded = expandedId === item.id;
          return (
            <li key={item.id} className={expanded ? 'expanded' : ''}>
              <div className="outputs-drawer-item">
                <span className="file-icon"><Icon /></span>
                <div className="outputs-drawer-main">
                  <strong>{item.title}{item.unviewed && <span className="unviewed-mark" role="img" aria-label="还没打开过" title="还没打开过" />}</strong>
                  <p>{item.type} · {item.taskTitle} · {item.updated}</p>
                  {item.awaitingAcceptance && <p className="outputs-drawer-review"><span className="request-type blue">待验收</span><button className="inline-link" onClick={() => onOpenInbox(item.taskId)}>去 Inbox 验收<ArrowRight /></button></p>}
                </div>
              </div>
              {expanded && (
                <div className="outputs-drawer-preview">
                  <p>{item.summary}</p>
                  <ul>{item.checks.map((check) => <li key={check}><Check />{check}</li>)}</ul>
                </div>
              )}
              <div className="outputs-drawer-actions">
                <button className="text-button" aria-expanded={expanded} onClick={() => togglePreview(item)}><Eye />{expanded ? '收起预览' : '快速预览'}</button>
                <button className="text-button" onClick={() => onHandOver(item)}><Bot />交给 Multivac</button>
                <button className="text-button" onClick={() => onEnterScene(item)}><Columns2 />进入现场</button>
              </div>
            </li>
          );
        })}
      </ul>
      {onExpand && <footer className="outputs-drawer-footer"><button className="inline-link" onClick={() => onExpand(expandedId)}>展开到成果页<ArrowRight /></button></footer>}
    </div>
  );
}

function OutputsView({ outputs, viewedIds, tasks, selectedOutputId, setSelectedOutputId, onOpenTask, resolveRequest, requests, notify }) {
  const selected = outputs.find((output) => output.id === selectedOutputId) || outputs[0];
  const task = tasks.find((item) => item.id === selected.taskId);
  const reviewRequest = requests.find((request) => request.taskId === selected.taskId && request.type === '验收' && request.state !== 'done');
  return (
    <div className="page-column">
      <PageIntro eyebrow="独立产物" title="成果" description="无需翻找聊天记录，直接查看、验收并继续使用工作输出。" actions={<button className="secondary"><Plus />创建后续任务</button>} />
      <div className="master-detail outputs-layout">
        <section className="output-list">{outputs.map((output) => { const Icon = output.icon; return <button key={output.id} className={`output-row ${selected.id === output.id ? 'selected' : ''}`} onClick={() => setSelectedOutputId(output.id)}><span className="file-icon"><Icon /></span><div><strong>{output.title}</strong><p>{output.type} · {output.updated}{!viewedIds.has(output.id) && <span className="new-mark">新</span>}</p></div><ChevronRight /></button>; })}</section>
        <article className="output-preview">
          <div className="preview-header"><div><span>{selected.type}</span><h2>{selected.title}</h2><p>{selected.updated}</p></div><IconButton label="更多"><MoreHorizontal /></IconButton></div>
          <div className="preview-document"><div className="document-kicker">MULTIVAC / WORK PRODUCT</div><h1>{selected.title}</h1><p className="document-lead">{selected.summary}</p><h2>本次结论</h2><p>原型需要完整表现用户如何从协调层进入具体工作，又如何在不丢失现场的前提下返回。关键不是同时展示多少任务，而是让状态、阻塞和下一步容易判断。</p><h2>体验重点</h2><ul><li>后台进度不自动抢焦点</li><li>需要判断的事项集中处理</li><li>任务、会话与成果可以互相定位</li></ul></div>
          <div className="output-meta"><button onClick={() => onOpenTask(task.id, 'tasks')}><ListTodo /><span><small>来源任务</small><strong>{task.title}</strong></span><ArrowRight /></button><button onClick={() => onOpenTask(task.id, 'workspace')}><MessageSquare /><span><small>工作会话</small><strong>{task.session}</strong></span><ArrowRight /></button></div>
          <div className="verification"><h3>验证结果</h3>{selected.checks.map((check) => <span key={check}><Check />{check}</span>)}</div>
          <div className="preview-actions"><button className="secondary" onClick={() => notify('成果已加入资料库，范围保持为当前项目')}><Library />加入资料库</button>{reviewRequest && <><button className="secondary" onClick={() => onOpenTask(task.id, 'inbox')}>要求修改</button><button className="primary" onClick={() => resolveRequest(reviewRequest.id, 'accept')}><Check />接受成果</button></>}</div>
        </article>
      </div>
    </div>
  );
}
/** 设置：低频配置集中在一页，分区之间用分段切换，不再各占一级导航。 */
function SettingsView({ section, setSection, children }) {
  return (
    <div className="page-column settings-page">
      <PageIntro eyebrow="低频配置" title="设置" description="项目、能力、智能体、模型、资料使用范围与记忆。资料内容在工作区「打开…」中浏览。" actions={
        <div className="segmented settings-tabs" role="tablist" aria-label="设置分区">
          {settingsSections.map((item) => { const Icon = item.icon; return <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><Icon />{item.label}</button>; })}
        </div>
      } />
      {children}
    </div>
  );
}

/**
 * 项目设置：挂载目录、资料范围与默认约束。
 * 新项目日常通过 Multivac 一句话创建，这里只查看和调整已有项目。
 */
function ProjectSettings({ projects, setProjects, tasks, capabilities }) {
  const [selectedId, setSelectedId] = useState(projects[0]?.id);
  const [newDir, setNewDir] = useState('');
  const project = projects.find((item) => item.id === selectedId) || projects[0];
  const services = capabilities.filter((item) => item.kind !== 'skill');
  const bundledSkills = capabilities.filter((item) => item.kind === 'skill' && item.projectId === project.id);
  const globalSkills = capabilities.filter((item) => item.kind === 'skill' && !item.projectId);

  function updateProject(patch) {
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, ...patch } : item));
  }

  function mountDir(event) {
    event.preventDefault();
    const dir = newDir.trim();
    if (!dir || project.dirs.includes(dir)) return;
    updateProject({ dirs: [...project.dirs, dir] });
    setNewDir('');
  }

  return (
    <div className="master-detail project-settings">
      <section className="document-list" aria-label="项目列表">
        {projects.map((item) => (
          <button key={item.id} className={project.id === item.id ? 'selected' : ''} onClick={() => setSelectedId(item.id)}>
            <Folder />
            <div><strong>{item.name}</strong><p>{item.dirs.length ? `${item.dirs.length} 个挂载目录` : '无挂载目录'} · {tasks.filter((task) => task.projectId === item.id).length} 个任务</p></div>
            <ChevronRight />
          </button>
        ))}
        <p className="project-settings-hint">新项目对 Multivac 说一句即可，例如“把 ~/code/notes 作为项目”。项目自动带一个同名工作区。</p>
      </section>
      <aside className="detail-panel project-detail">
        <h2>{project.name}</h2>
        <section className="detail-section">
          <h3>挂载目录</h3>
          {project.dirs.length ? <ul className="mounted-dirs">{project.dirs.map((dir) => <li key={dir}><Folder /><code>{dir}</code><IconButton label={`卸载 ${dir}`} onClick={() => updateProject({ dirs: project.dirs.filter((item) => item !== dir) })}><X /></IconButton></li>)}</ul> : <p className="muted-line">没有挂载目录：适合学习、研究类项目，任务不修改本地文件。</p>}
          <form className="mount-dir-form" onSubmit={mountDir}><input aria-label="要挂载的目录" value={newDir} onChange={(event) => setNewDir(event.target.value)} placeholder="例如 ~/code/multivac/docs" /><button type="submit" className="secondary" disabled={!newDir.trim()}><Plus />挂载</button></form>
        </section>
        <section className="detail-section">
          <h3>资料范围</h3>
          <div className="scope-selector"><ShieldCheck /><div><strong>{project.scope}</strong><p>新任务默认使用这个范围，可在确认卡上逐项调整。</p></div></div>
        </section>
        <section className="detail-section">
          <h3>默认约束</h3>
          <p className="project-constraint">{project.constraint}</p>
        </section>
        <section className="detail-section">
          <h3>能力边界</h3>
          <p className="muted-line">登记过的能力在本项目默认可用，这里只划边界：最多能做到哪一档、哪些不用、用哪个账号。</p>
          <EffectCapPicker label="本项目的效果上限" value={project.effectCap} onChange={(effectCap) => updateProject({ effectCap })} />
          <h4>排除的服务</h4>
          <ul className="boundary-list">
            {services.map((service) => {
              const excluded = (project.excluded || []).includes(service.id);
              return (
                <li key={service.id}>
                  <span><strong>{service.name}</strong><small>{service.kind === 'builtin' ? '内置' : 'MCP'} · {EFFECT_LABELS[capabilityEffect(service)]}</small></span>
                  <button type="button" className={`toggle-chip ${excluded ? 'active' : ''}`} aria-pressed={excluded} onClick={() => updateProject({ excluded: excluded ? project.excluded.filter((id) => id !== service.id) : [...(project.excluded || []), service.id] })}>{excluded ? '已排除' : '排除'}</button>
                </li>
              );
            })}
          </ul>
          <h4>账号绑定</h4>
          <ul className="boundary-list">
            {services.filter((service) => SERVICE_ACCOUNTS[service.id]).map((service) => (
              <li key={service.id}>
                <span><strong>{service.name}</strong><small>本项目使用的账号</small></span>
                <select aria-label={`${service.name} 在本项目使用的账号`} value={project.accounts?.[service.id] || ''} onChange={(event) => updateProject({ accounts: { ...project.accounts, [service.id]: event.target.value } })}>
                  <option value="">跟随全局默认</option>
                  {SERVICE_ACCOUNTS[service.id].map((account) => <option key={account} value={account}>{account}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <h4>项目自带的 Skill</h4>
          {bundledSkills.length ? <ul className="boundary-list">{bundledSkills.map((skill) => <li key={skill.id}><span><strong>{skill.name}</strong><small>{skill.description}</small></span></li>)}</ul> : <p className="muted-line">这个项目没有自带 Skill。挂载目录里如果有 SKILL.md，首次识别时会请你确认启用。</p>}
          <h4>在本项目中隐藏的 Skill</h4>
          <ul className="boundary-list">
            {globalSkills.map((skill) => {
              const hidden = (project.hiddenSkills || []).includes(skill.id);
              return (
                <li key={skill.id}>
                  <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                  <button type="button" className={`toggle-chip ${hidden ? 'active' : ''}`} aria-pressed={hidden} onClick={() => updateProject({ hiddenSkills: hidden ? project.hiddenSkills.filter((id) => id !== skill.id) : [...(project.hiddenSkills || []), skill.id] })}>{hidden ? '已隐藏' : '隐藏'}</button>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="detail-section">
          <h3>实际可用预览</h3>
          <AvailabilityPreview availability={resolveAvailability({ registry: capabilities, project, agent: null })} onRelease={(capability) => updateProject(releaseForProject(project, capability, capabilities))} />
        </section>
      </aside>
    </div>
  );
}

/**
 * 设置 · 能力：低频的配置处，不提醒任何事。服务断开只在这里显示；
 * 只有影响正在运行的任务时，运行指示才变琥珀。拆成“服务与工具 / Skill / 授权记录”三页。
 */
function CapabilitySettings({ capabilities, setCapabilities, projects, agents, grants, setGrants, notify }) {
  const [tab, setTab] = useState('services');
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(null);
  const [config, setConfig] = useState('');
  const servers = capabilities.filter((item) => item.kind !== 'skill');
  const skills = capabilities.filter((item) => item.kind === 'skill');
  const [skillId, setSkillId] = useState(skills[0]?.id);
  const skill = skills.find((item) => item.id === skillId) || skills[0];
  // 某项能力在哪些项目里不可用、原因是什么（能力默认可用，只列例外）。
  const unavailableIn = (id) => projects.map((project) => ({ project, entry: resolveAvailability({ registry: capabilities, project, agent: null }).unavailable.find(({ capability }) => capability.id === id) })).filter(({ entry }) => entry);
  const usedBy = (id) => agents.filter((agent) => (agent.requiredServices || []).includes(id) || (agent.preferredSkills || []).includes(id)).map((agent) => agent.name);

  function updateCapability(id, patch) {
    setCapabilities((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function testConnection(server) {
    const ok = server.id !== 'calendar' || server.status === 'connected';
    updateCapability(server.id, ok ? { status: 'connected', lastError: '' } : { lastError: '连接失败：进程已退出（exit 1）' });
    notify(ok ? `${server.name} 连接正常` : `${server.name} 仍无法连接`);
  }

  /** 粘贴标准 MCP 配置：登记后各项目默认可用，不需要的项目可以排除。 */
  function importConfig(event) {
    event.preventDefault();
    let names = [];
    try {
      names = Object.keys(JSON.parse(config).mcpServers || {});
    } catch {
      notify('配置不是有效的 JSON');
      return;
    }
    if (!names.length) return;
    setCapabilities((current) => [...current, ...names.filter((name) => !current.some((item) => item.id === `mcp-${name}`)).map((name) => ({ id: `mcp-${name}`, kind: 'mcp', name, transport: '本地 stdio', status: 'disconnected', credential: '待配置', lastUsed: '从未使用', lastError: '', tools: [] }))]);
    setAdding(null);
    setConfig('');
    notify(`已登记 ${names.length} 个 MCP 服务，连接成功后各项目默认可用`);
  }

  function importSkill() {
    setCapabilities((current) => current.some((item) => item.id === 'skill-weekly') ? current : [...current, { id: 'skill-weekly', kind: 'skill', name: '周报', description: '汇总本周完成的任务与成果，生成周报草稿。', trigger: '每周五需要汇总本周工作时', source: '导入', uses: ['builtin-files'], lastUsed: '从未使用', skillMd: '---\nname: 周报\ndescription: 汇总本周完成的任务与成果\n---\n\n1. 按项目汇总本周完成的任务\n2. 列出新成果与待决事项' }]);
    setSkillId('skill-weekly');
    setAdding(null);
    notify('已导入“周报”，各项目默认可用');
  }

  const services = (
    <>
      <section className="capability-group" aria-labelledby="mcp-title">
        <div className="capability-group-head"><h3 id="mcp-title">服务与工具</h3><span>登记即默认可用；工具可用不等于资料已获授权</span></div>
        {servers.map((server) => {
          const effect = capabilityEffect(server);
          const expanded = openId === server.id;
          const exceptions = unavailableIn(server.id);
          return (
            <article key={server.id} className="capability-row">
              <div className="capability-main">
                <span className={`status-dot ${server.kind === 'builtin' || server.status === 'connected' ? 'ok' : 'down'}`} />
                <div>
                  <strong>{server.name}</strong>
                  <small>{server.kind === 'builtin' ? '内置' : `MCP · ${server.transport}`} · {server.tools.length} 个工具 · 最高{EFFECT_LABELS[effect]}{server.credential ? ` · 凭据${server.credential}` : ''}</small>
                  <small>{exceptions.length ? exceptions.map(({ project, entry }) => `${project.name}：${entry.reason}`).join('；') : '各项目均可用'}{server.lastUsed ? ` · 最近使用 ${server.lastUsed}` : ''}</small>
                  {server.lastError && <small className="capability-error">{server.lastError}</small>}
                </div>
                <div className="capability-actions">
                  <button type="button" className="secondary" aria-expanded={expanded} onClick={() => setOpenId(expanded ? null : server.id)}>工具</button>
                  {server.kind === 'mcp' && <button type="button" className="secondary" onClick={() => testConnection(server)}><RefreshCw />测试连接</button>}
                </div>
              </div>
              {expanded && (
                <ul className="tool-effects">
                  {server.tools.map((tool) => (
                    <li key={tool.name}>
                      <code>{tool.name}</code>
                      {tool.effect ? <span>{EFFECT_LABELS[tool.effect]}</span> : (
                        <label><span>未标注，暂按外部副作用</span><select aria-label={`${tool.name} 的效果等级`} value={toolEffect(tool)} onChange={(event) => updateCapability(server.id, { tools: server.tools.map((item) => item.name === tool.name ? { ...item, effect: event.target.value } : item) })}>{EFFECT_ORDER.map((level) => <option key={level} value={level}>{EFFECT_LABELS[level]}</option>)}</select></label>
                      )}
                    </li>
                  ))}
                  {!server.tools.length && <li><span>连接成功后读取工具列表。</span></li>}
                </ul>
              )}
            </article>
          );
        })}
      </section>
      <section className="capability-group" aria-labelledby="add-title">
        <div className="capability-group-head"><h3 id="add-title">添加服务</h3><span>显式接入，不自动扫描本地目录</span></div>
        <div className="capability-add">
          <p>最顺手的方式是直接对 Multivac 说，例如“接入 GitHub”，会给出接入确认卡。</p>
          <button type="button" className="secondary" onClick={() => setAdding('config')}><Plug />粘贴标准 MCP 配置</button>
          <button type="button" className="secondary" onClick={() => setAdding('import-mcp')}><Download />从 Claude Code / Codex 导入</button>
        </div>
        {adding === 'config' && (
          <form className="capability-config" onSubmit={importConfig}>
            <textarea aria-label="MCP 配置" value={config} onChange={(event) => setConfig(event.target.value)} placeholder={'{ "mcpServers": { "notion": { "command": "npx", "args": ["notion-mcp"] } } }'} />
            <div><button type="button" className="secondary" onClick={() => setAdding(null)}>取消</button><button type="submit" className="primary" disabled={!config.trim()}>登记</button></div>
          </form>
        )}
        {adding === 'import-mcp' && (
          <div className="capability-config">
            <p>在 ~/.claude 中发现 1 个 MCP 服务：filesystem。导入后需要连接成功才可用。</p>
            <div><button type="button" className="secondary" onClick={() => setAdding(null)}>取消</button><button type="button" className="primary" onClick={() => { setCapabilities((current) => current.some((item) => item.id === 'mcp-filesystem') ? current : [...current, { id: 'mcp-filesystem', kind: 'mcp', name: 'filesystem', transport: '本地 stdio', status: 'disconnected', credential: '无需凭据', lastUsed: '从未使用', lastError: '', tools: [] }]); setAdding(null); notify('已导入 filesystem，连接成功后各项目默认可用'); }}>导入</button></div>
          </div>
        )}
      </section>
    </>
  );

  // Skill 页：列表 + 详情。不标效果等级，写清什么时候会用、会用到哪些服务、在哪里不可用。
  const skillPage = skill ? (
    <div className="skill-page">
      <section className="capability-group skill-list" aria-label="Skill 列表">
        {skills.map((item) => (
          <button type="button" key={item.id} className={item.id === skill.id ? 'selected' : ''} onClick={() => setSkillId(item.id)}>
            <Sparkles /><span><strong>{item.name}</strong><small>{item.source}{item.projectId ? ` · ${projects.find((project) => project.id === item.projectId)?.name}` : ''}</small></span>
          </button>
        ))}
        <div className="capability-add">
          <button type="button" className="secondary" onClick={() => setAdding('import-skill')}><Download />导入 Skill</button>
        </div>
        {adding === 'import-skill' && (
          <div className="capability-config">
            <p>在 ~/.claude/skills 中发现 1 个 Skill：周报。导入后各项目默认可用。</p>
            <div><button type="button" className="secondary" onClick={() => setAdding(null)}>取消</button><button type="button" className="primary" onClick={importSkill}>导入</button></div>
          </div>
        )}
      </section>
      <article className="capability-group skill-detail" aria-labelledby="skill-title">
        <div className="capability-group-head"><h3 id="skill-title">{skill.name}</h3><span>{skill.source} · 最近使用 {skill.lastUsed}</span></div>
        <dl>
          <div><dt>做什么</dt><dd>{skill.description}</dd></div>
          <div><dt>什么时候用</dt><dd>{skill.trigger}<small>只常驻这段描述，需要时再加载全文。</small></dd></div>
          <div><dt>会用到</dt><dd>{(skill.uses || []).length ? skill.uses.map((id) => {
            const service = capabilities.find((item) => item.id === id);
            return <span key={id} className="capability-chip">{service?.name || id}{service && <small>{EFFECT_LABELS[capabilityEffect(service)]}</small>}</span>;
          }) : '不需要其他服务'}</dd></div>
          <div><dt>常用于</dt><dd>{usedBy(skill.id).join('、') || '—'}</dd></div>
          <div><dt>可用范围</dt><dd>{skill.projectId ? `项目自带，只在「${projects.find((project) => project.id === skill.projectId)?.name}」中出现。` : '全局登记，各项目默认可用。'}
            {unavailableIn(skill.id).map(({ project, entry }) => <small key={project.id} className="skill-unavailable">在「{project.name}」中不可用：{entry.reason}</small>)}
          </dd></div>
        </dl>
        <div className="skill-md"><span>SKILL.md 预览</span><pre>{skill.skillMd}</pre></div>
      </article>
    </div>
  ) : <p className="muted-line">还没有 Skill。可以导入，或对 Multivac 说“以后写周报都按这个流程”沉淀成 Skill。</p>;

  const grantPage = (
    <section className="capability-group" aria-labelledby="grant-title">
      <div className="capability-group-head"><h3 id="grant-title">授权记录</h3><span>由程序校验，不靠模型记忆</span></div>
      {grants.length ? grants.map((grant) => (
        <article key={grant.id} className="capability-row">
          <div className="capability-main">
            <ShieldCheck className="capability-icon" />
            <div><strong>{grant.capability}</strong><small>{grant.scope} · {grant.target} · {grant.at}</small></div>
            <div className="capability-actions"><button type="button" className="secondary danger" onClick={() => setGrants((current) => current.filter((item) => item.id !== grant.id))}>撤销</button></div>
          </div>
        </article>
      )) : <p className="capability-empty">还没有记住的授权。在就地授权卡或 Inbox 里选“本任务内允许 / 本项目内始终允许”后会出现在这里。</p>}
    </section>
  );

  return (
    <div className="capability-settings">
      <div className="segmented capability-tabs" role="tablist" aria-label="能力分页">
        {[['services', '服务与工具'], ['skills', 'Skill'], ['grants', '授权记录']].map(([id, label]) => <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setAdding(null); }}>{label}</button>)}
      </div>
      {tab === 'services' && services}
      {tab === 'skills' && skillPage}
      {tab === 'grants' && grantPage}
    </div>
  );
}

// 协调者的内部工具：只操作产品自身，不直接写文件或调用有外部副作用的工具。
const COORDINATOR_TOOLS = [
  ['待办', '创建与调整待办、“先做这个”、暂停、调整并发'],
  ['运行', '查询运行状态、停止任务启动的进程'],
  ['Inbox', '列出需要你处理的事，在对话里直接回答'],
  ['成果', '查找与取回成果'],
  ['工作区', '打开工作对象、整理现场'],
  ['项目与能力', '一句话创建项目、给出接入确认卡'],
];

/**
 * 设置 · 智能体：列表 + 详情。智能体是一套执行配置，不是需要你指派的角色；
 * 首版只有协调者与两个预置配置，新建通过对话完成（预填 Multivac 输入框）。
 */
function AgentSettings({ agents, setAgents, capabilities, models, projects, setProjects, tasks, coordinatorModel, onDraftToMultivac }) {
  const [agentId, setAgentId] = useState('general');
  const [previewProjectId, setPreviewProjectId] = useState(projects[0]?.id || '');
  const agent = agents.find((item) => item.id === agentId) || agents[0];
  const previewProject = projects.find((item) => item.id === previewProjectId) || null;
  const nameOf = (id) => capabilities.find((item) => item.id === id)?.name || id;
  // 最近任务：显式选了这个智能体的，或按项目默认落到它的。
  const recentTasks = tasks.filter((task) => (task.agentId || (task.projectId === 'research' ? 'research' : 'general')) === agent.id).slice(-3).reverse();

  function updateAgent(patch) {
    setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, ...patch } : item));
  }

  function toggleIn(field, id) {
    const list = agent[field] || [];
    updateAgent({ [field]: list.includes(id) ? list.filter((item) => item !== id) : [...list, id] });
  }

  const skills = capabilities.filter((item) => item.kind === 'skill');
  const services = capabilities.filter((item) => item.kind !== 'skill');

  const detail = agent.fixed ? (
    <article className="capability-group agent-detail" aria-labelledby="agent-title">
      <div className="capability-group-head"><h3 id="agent-title">{agent.name}</h3><span>固定配置</span></div>
      <section>
        <h4>为什么不能配置</h4>
        <p>协调者负责理解你的意图、安排工作和回答进展。它只用内部工具和只读查询，所有有副作用的动作都转交任务会话执行，这样每个动作都挂在某个任务上：可追溯、可暂停、可验收，状态可信。开放配置会让这条边界变模糊。</p>
      </section>
      <section>
        <h4>所用模型</h4>
        <p>跟随 Multivac 对话当前选择的模型：{coordinatorModel}。在对话输入区的模型选择器里切换。</p>
      </section>
      <section>
        <h4>内部工具</h4>
        <ul className="coordinator-tools">{COORDINATOR_TOOLS.map(([name, purpose]) => <li key={name}><strong>{name}</strong><span>{purpose}</span></li>)}</ul>
      </section>
    </article>
  ) : (
    <article className="capability-group agent-detail" aria-labelledby="agent-title">
      <div className="capability-group-head"><h3 id="agent-title">{agent.name}</h3><span>{agent.description}</span></div>
      <section>
        <h4>最近任务</h4>
        {recentTasks.length ? <ul className="agent-recent">{recentTasks.map((task) => <li key={task.id}><StatusBadge status={task.status} /><span>{task.title}</span></li>)}</ul> : <p className="muted-line">还没有用它执行过任务。Multivac 会按任务类型自动选择它，也可以在任务确认卡上手动选。</p>}
      </section>
      <section>
        <h4>模型与推理</h4>
        <ModelSelector models={models} modelId={agent.modelId} setModelId={(modelId) => updateAgent({ modelId })} thinkingLevel={agent.thinking} setThinkingLevel={(thinking) => updateAgent({ thinking })} manageModels={() => {}} />
      </section>
      <section>
        <h4>指令</h4>
        <textarea className="agent-instructions" aria-label={`${agent.name} 的指令`} value={agent.instructions || ''} onChange={(event) => updateAgent({ instructions: event.target.value })} placeholder="这类工作的约定，例如“结论和证据分开写”。项目里的 AGENTS.md 会另外自动注入。" />
      </section>
      <section>
        <h4>常用 Skill</h4>
        <p className="muted-line">能力默认都可用，这里只标出这类工作常用的，Multivac 会优先匹配。</p>
        <div className="agent-picks">{skills.map((skill) => <button type="button" key={skill.id} aria-pressed={(agent.preferredSkills || []).includes(skill.id)} className={(agent.preferredSkills || []).includes(skill.id) ? 'active' : ''} onClick={() => toggleIn('preferredSkills', skill.id)}>{skill.name}</button>)}</div>
        {!(agent.preferredSkills || []).length && <p className="muted-line">还没有常用 Skill。任务里反复用到的 Skill 会建议加入这里。</p>}
      </section>
      <section>
        <h4>需要的服务</h4>
        <div className="agent-picks">{services.map((service) => <button type="button" key={service.id} aria-pressed={(agent.requiredServices || []).includes(service.id)} className={(agent.requiredServices || []).includes(service.id) ? 'active' : ''} onClick={() => toggleIn('requiredServices', service.id)}>{service.name}</button>)}</div>
        {!(agent.requiredServices || []).length && <p className="muted-line">没有必需的服务：任务照样可以用项目里可用的能力，缺少时会在确认卡上提示。</p>}
      </section>
      <section>
        <h4>效果上限</h4>
        <EffectCapPicker label={`${agent.name} 的效果上限`} value={agent.effectCap} onChange={(effectCap) => updateAgent({ effectCap })} />
      </section>
      <section>
        <h4>实际可用预览</h4>
        <label className="preview-project"><span>在项目中</span><select value={previewProjectId} onChange={(event) => setPreviewProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}<option value="">不属于任何项目</option></select></label>
        {/* 项目边界下可用、却因本智能体上限不可用的，放开项目无济于事，单独说明。 */}
        <AvailabilityPreview availability={resolveAvailability({ registry: capabilities, project: previewProject, agent })} agentLimited={resolveAvailability({ registry: capabilities, project: previewProject, agent: null }).available.map((capability) => capability.id)} onRelease={previewProject ? (capability) => setProjects((current) => current.map((project) => project.id === previewProject.id ? releaseForProject(project, capability, capabilities) : project)) : null} />
      </section>
    </article>
  );

  return (
    <div className="agent-page">
      <section className="capability-group skill-list" aria-label="智能体列表">
        {agents.map((item) => (
          <button type="button" key={item.id} className={item.id === agent.id ? 'selected' : ''} onClick={() => setAgentId(item.id)}>
            <UserCog /><span><strong>{item.name}</strong><small>{item.fixed ? '固定配置' : `${models.find((model) => model.id === item.modelId)?.name || '—'} · 上限${EFFECT_LABELS[item.effectCap]}`}</small></span>
          </button>
        ))}
        <div className="capability-add">
          <button type="button" className="secondary" onClick={() => onDraftToMultivac('新建一个智能体：用途是……，常用 Skill……，需要的服务……，最高只到……')}><Plus />新建智能体</button>
          <p>通过对话新建，例如“以后写周报都用这个模型和模板”。</p>
        </div>
      </section>
      {detail}
    </div>
  );
}

/**
 * 资料使用范围：按资料类别定规则，任务与记忆只能在此范围内使用，不能扩大；
 * 资料内容本身不在这里浏览，到工作区「打开…」中打开。
 */
function ScopeSettings({ rules, setRules, documents, books, notes, notify }) {
  const countOf = (rule) => rule.source === '书' ? books.length : rule.source === '笔记' ? notes.length : documents.filter((doc) => doc.category === rule.id).length;
  const update = (id, scope) => {
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, scope } : rule));
    notify(`「${id}」的使用范围改为：${scope}`);
  };
  return (
    <div className="memory-layout scope-settings">
      <div className="memory-note"><ShieldCheck /><div><strong>按类别决定资料能被哪些项目和任务使用</strong><p>任务上可以就地收窄；记忆和任务都不能扩大这里的范围。</p></div></div>
      <div className="scope-rules">
        {rules.map((rule) => (
          <div key={rule.id} className="scope-rule">
            <div><strong>{rule.id}</strong><small>{rule.source} · {countOf(rule)} 项</small></div>
            <select aria-label={`${rule.id}的使用范围`} value={rule.scope} onChange={(event) => update(rule.id, event.target.value)}>
              {SCOPE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </select>
          </div>
        ))}
      </div>
      <p className="scope-hint"><FolderOpen />书、文档和笔记的浏览、收藏本地文档、交给 Multivac、用于当前任务，都在工作区的「打开…」里。</p>
    </div>
  );
}

function ModelSettings({ models, setModels, defaultModelId, setDefaultModelId, notify }) {
  const [selectedId, setSelectedId] = useState(defaultModelId);
  const selected = models.find((model) => model.id === selectedId) || models[0];
  const [draft, setDraft] = useState(selected);
  const [adding, setAdding] = useState(false);
  const [newModel, setNewModel] = useState({ name: '', provider: 'openai-compatible', modelId: '', endpoint: '' });
  const [check, setCheck] = useState(null);
  // 切换模型的那一帧草稿还属于上一个模型，表单一律以当前模型为准，避免闪现错误的来源。
  const form = draft.id === selected.id ? draft : selected;
  // 草稿按保存后的判断即时预览：与会话启动、恢复、可用性检查用的是同一个判断。
  const draftReasoning = resolveReasoning(form);

  useEffect(() => { setDraft(selected); setCheck(null); }, [selectedId, selected]);

  function save(event) {
    event.preventDefault();
    setModels((current) => current.map((model) => model.id === selected.id ? { ...model, ...form } : model));
    notify(`模型配置已保存 · 推理${draftReasoning.supported ? '支持' : '不支持'}（${draftReasoning.source}）`);
  }

  /** 可用性检查：连通结果与推理能力都按已保存的配置判断。 */
  function runCheck() {
    const reasoning = resolveReasoning(selected);
    setCheck(selected.configured
      ? { ok: true, text: `连通正常 · 推理${reasoning.supported ? '支持' : '不支持'}（${reasoning.source}）` }
      : { ok: false, text: '尚未完成认证，无法检查连通' });
  }

  function addModel(event) {
    event.preventDefault();
    if (!newModel.name.trim() || !newModel.modelId.trim()) return;
    const profile = {
      id: `model-${Date.now()}`,
      name: newModel.name.trim(),
      provider: newModel.provider,
      modelId: newModel.modelId.trim(),
      endpoint: newModel.endpoint.trim(),
      configured: false,
      description: '新添加的模型配置，完成认证后即可用于会话。',
      // 新模型默认不在 Pi 目录，推理能力为“自动”，可在详情里手动指定。
      catalog: null,
      reasoning: 'auto',
    };
    setModels((current) => [...current, profile]);
    setSelectedId(profile.id);
    setAdding(false);
    setNewModel({ name: '', provider: 'openai-compatible', modelId: '', endpoint: '' });
    notify('模型已添加，请继续完成认证配置');
  }

  return (
    <div className="models-page">
      <div className="model-management">
        <section className="model-list" aria-label="模型配置列表">
          <div className="model-list-heading"><span>模型配置 · <strong>{models.filter((model) => model.configured).length}/{models.length} 可用</strong></span><IconButton label="添加模型" onClick={() => setAdding(true)}><Plus /></IconButton></div>
          {models.map((model) => <button key={model.id} className={selected.id === model.id ? 'selected' : ''} onClick={() => setSelectedId(model.id)}><span className={`model-status-dot ${model.configured ? 'configured' : ''}`} /><span><strong>{model.name}</strong><small>{model.provider} / {model.modelId}</small></span>{model.id === defaultModelId && <em>默认</em>}<ChevronRight /></button>)}
        </section>
        <form className="model-detail" onSubmit={save}>
          <div className="model-detail-header"><div><span className={`model-availability ${form.configured ? 'configured' : ''}`}>{form.configured ? '可用' : '未配置'}</span><h2>{form.name}</h2><p>{form.description}</p></div><button type="button" className="secondary" disabled={selected.id === defaultModelId || !form.configured} onClick={() => { setDefaultModelId(selected.id); notify('默认模型已更新'); }}>{selected.id === defaultModelId ? '当前默认' : '设为默认'}</button></div>
          <div className="model-form-grid">
            <label><span>显示名称</span><input value={form.name} onChange={(event) => setDraft({ ...form, name: event.target.value })} /></label>
            <label><span>提供方</span><select value={form.provider} onChange={(event) => setDraft({ ...form, provider: event.target.value })}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI 兼容</option><option value="google">Google</option></select></label>
            <label className="wide"><span>模型 ID</span><input value={form.modelId} onChange={(event) => setDraft({ ...form, modelId: event.target.value })} /></label>
            <label className="wide"><span>API 端点</span><input value={form.endpoint} onChange={(event) => setDraft({ ...form, endpoint: event.target.value })} placeholder="https://…/v1" /></label>
            <label className="wide"><span>API Key</span><input type="password" placeholder={form.configured ? '已配置，不显示现有值' : '输入后完成认证'} /><small>原型不会保存或发送输入的密钥。</small></label>
          </div>
          <section className="reasoning-capability" aria-labelledby="reasoning-title">
            <div className="reasoning-head"><strong id="reasoning-title">推理能力</strong><span className="reasoning-source">来源：{draftReasoning.source}</span></div>
            <div className="segmented reasoning-modes" role="radiogroup" aria-labelledby="reasoning-title">
              {REASONING_MODES.map((mode) => <button type="button" key={mode.value} role="radio" aria-checked={draftReasoning.mode === mode.value} className={draftReasoning.mode === mode.value ? 'active' : ''} onClick={() => setDraft({ ...form, reasoning: mode.value })}>{mode.label}</button>)}
            </div>
            <div className="reasoning-levels"><span>{draftReasoning.supported ? '可选推理等级' : '推理等级只能选'}</span>{draftReasoning.levels.map((level) => <em key={level}>{thinkingLabels[level] || level}</em>)}</div>
            {draftReasoning.mode === 'auto' && !form.catalog && <p className="reasoning-hint">该模型不在 Pi 模型目录中，自动模式按 Pi 默认视为不支持推理。如果确认它支持（例如自建地址的 Responses 模型），请选择“支持”。</p>}
            <p className="reasoning-note">这个设置只决定能不能开启推理，不保证模型一定返回可展示的思考内容。已开着的会话在下一次发送时按新设置生效。</p>
          </section>
          <label className="model-auth-toggle"><input type="checkbox" checked={form.configured} onChange={(event) => setDraft({ ...form, configured: event.target.checked })} /><span><strong>认证与连通检查通过</strong><small>关闭后，该模型不会出现在会话的可用模型列表中。</small></span></label>
          <div className="model-detail-actions">{check && <span className={`model-check ${check.ok ? 'ok' : 'failed'}`} role="status">{check.ok ? <CheckCircle2 /> : <CircleAlert />}{check.text}</span>}<button type="button" className="secondary" onClick={runCheck}>检查可用性</button><button type="button" className="secondary" onClick={() => setDraft(selected)}>放弃修改</button><button type="submit" className="primary"><Check />保存配置</button></div>
        </form>
      </div>
      {adding && <div className="creation-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(false); }}><form className="creation-dialog" role="dialog" aria-modal="true" aria-labelledby="add-model-title" onSubmit={addModel}><div className="creation-header"><div><span>模型配置</span><h2 id="add-model-title">添加模型</h2></div><IconButton type="button" label="关闭" onClick={() => setAdding(false)}><X /></IconButton></div><label><span>显示名称</span><input autoFocus value={newModel.name} onChange={(event) => setNewModel({ ...newModel, name: event.target.value })} placeholder="例如：团队主力模型" /></label><label><span>提供方</span><select value={newModel.provider} onChange={(event) => setNewModel({ ...newModel, provider: event.target.value })}><option value="openai-compatible">OpenAI 兼容</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google</option></select></label><label><span>模型 ID</span><input value={newModel.modelId} onChange={(event) => setNewModel({ ...newModel, modelId: event.target.value })} placeholder="例如：gpt-4.1-mini" /></label><label><span>API 端点</span><input value={newModel.endpoint} onChange={(event) => setNewModel({ ...newModel, endpoint: event.target.value })} placeholder="可选" /></label><div className="creation-actions"><button type="button" className="secondary" onClick={() => setAdding(false)}>取消</button><button type="submit" className="primary" disabled={!newModel.name.trim() || !newModel.modelId.trim()}>继续配置</button></div></form></div>}
    </div>
  );
}

function MemorySettings({ notify }) {
  const [memories, setMemories] = useState([
    { id: 'pref', text: '需求与讨论整理在未指定格式时，默认生成可直接查看的 HTML。', scope: '全局', source: '2026-09-08 的明确偏好' },
    { id: 'stack', text: '栈式深入向下承接背景，向上不自动回写。', scope: 'Multivac 项目', source: 'MVP 讨论共识' },
    { id: 'quality', text: '成果质量不下降是评估注意力改善的前提。', scope: 'Multivac 项目', source: 'mvp.html' },
  ]);
  return <div className="memory-layout"><div className="memory-note"><ShieldCheck /><div><strong>记忆不能绕过资料权限</strong><p>从受限资料提炼的信息仍保留原使用范围。</p></div></div><div className="memory-list">{memories.map((memory) => <article key={memory.id}><div className="memory-icon"><Sparkles /></div><div><p>{memory.text}</p><div className="memory-meta"><span>{memory.scope}</span><span>{memory.source}</span></div></div><div className="memory-actions"><IconButton label="编辑" onClick={() => notify('已进入记忆编辑模拟')}><Settings2 /></IconButton><IconButton label="删除" onClick={() => setMemories((current) => current.filter((item) => item.id !== memory.id))}><X /></IconButton></div></article>)}</div></div>;
}

function EmptyState({ icon: Icon, title, description }) {
  return <div className="empty-state"><Icon /><h2>{title}</h2><p>{description}</p></div>;
}

createRoot(document.getElementById('root')).render(<App />);
