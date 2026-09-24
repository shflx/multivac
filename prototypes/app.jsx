import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
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
  FileCode2,
  FileText,
  Folder,
  Inbox,
  LayoutDashboard,
  Library,
  ListTodo,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Orbit,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Quote,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareStack,
  Terminal,
  X,
} from 'lucide-react';
import { ResizableConversations } from './resizable-conversations.jsx';
import { canSubmitDecision, decisionLabel } from './ui-state.js';
import './style.css';

const initialTasks = [
  { id: 'prototype', title: '整理 MVP 原型范围', group: 'Multivac', status: 'running', priority: '高', session: '原型范围梳理', scope: 'mvp.html、需求文档', acceptance: true, reason: '正在整理页面状态和体验脚本', next: '完成交互说明并生成成果' },
  { id: 'recovery', title: '修复会话恢复问题', group: 'Multivac', status: 'running', priority: '高', session: '恢复机制排查', scope: '当前仓库', acceptance: true, reason: '正在运行恢复测试', next: '检查失败用例' },
  { id: 'permissions', title: '梳理授权边界', group: 'Multivac', status: 'running', priority: '中', session: '授权边界梳理', scope: '项目约束与需求文档', acceptance: true, reason: '正在区分验收、外发与资料传输', next: '补齐权限提示文案' },
  { id: 'isolation', title: '验证命令隔离', group: 'Multivac', status: 'running', priority: '中', session: '命令隔离验证', scope: '隔离 PoC', acceptance: false, reason: '正在核对探针结果', next: '汇总验证边界' },
  { id: 'agent-sdk', title: '对比 Agent SDK', group: '研究', status: 'queued', priority: '中', session: 'Agent SDK 对比', scope: '指定调研资料', acceptance: false, reason: '并发名额已满，排队第 1 位', next: '等待执行名额' },
  { id: 'project-doc', title: '更新项目文档', group: 'Multivac', status: 'scheduler-paused', priority: '中', session: '项目文档更新', scope: 'project.html', acceptance: false, reason: '为高优先级任务安全让位', next: '释放名额后自动恢复' },
  { id: 'scope', title: '确认资料使用范围', group: '日常', status: 'clarification', priority: '高', session: '资料范围确认', scope: '待确认', acceptance: true, reason: '需要确认是否可引用个人笔记', next: '等待你的回答' },
  { id: 'review', title: '审阅实现结果', group: 'Multivac', status: 'acceptance', priority: '中', session: '实现审阅', scope: '当前变更', acceptance: true, reason: '自检已通过，等待验收', next: '接受成果或要求修改' },
  { id: 'publish', title: '发布变更说明', group: 'Multivac', status: 'authorization', priority: '低', session: '发布说明', scope: '成果摘要', acceptance: false, reason: '成果已完成，等待外发授权', next: '确认是否发布' },
  { id: 'report', title: '生成技术调研报告', group: '研究', status: 'done', priority: '中', session: '技术调研', scope: '指定公开资料', acceptance: false, reason: '已完成并通过自检', next: '查看成果' },
  { id: 'interrupted', title: '执行中断的代码修改', group: 'Multivac', status: 'recovery', priority: '高', session: '中断恢复', scope: '隔离工作区', acceptance: true, reason: '上次关闭时命令状态不明确', next: '检查现场后决定恢复方式' },
];

const initialRequests = [
  { id: 'scope-request', taskId: 'scope', type: '澄清', title: '是否允许引用个人笔记？', detail: '这份资料能补足背景，但当前只授权了项目文档。其他不依赖该资料的整理工作仍在继续。', age: '8 分钟前', impact: '阻塞 1 个步骤', state: 'new' },
  { id: 'review-request', taskId: 'review', type: '验收', title: '实现结果已准备好审阅', detail: '3 个检查项通过。请确认当前交互是否符合预期，或返回工作会话提出修改。', age: '24 分钟前', impact: '等待完成', state: 'new' },
  { id: 'publish-request', taskId: 'publish', type: '外发授权', title: '是否发布变更说明？', detail: '成果已经完成；发布到外部仓库仍需要单独授权。拒绝不会改变成果状态。', age: '1 小时前', impact: '不阻塞其他任务', state: 'seen' },
];

const outputs = [
  { id: 'mvp-doc', taskId: 'review', title: 'MVP 交互原型说明', type: '文档', updated: '今天 14:32', icon: FileText, summary: '覆盖任务交代、后台推进、介入、验收与恢复的完整体验链路。', checks: ['内容结构检查通过', '关键状态覆盖完整', '未包含真实执行承诺'] },
  { id: 'sdk-report', taskId: 'report', title: 'Coding Agent SDK 调研报告', type: '研究', updated: '昨天 19:10', icon: FileCode2, summary: '对比会话、工具调用、恢复与压缩能力，并保留来源和不确定性。', checks: ['12 个来源已核对', '引用可追溯', '结论边界已标记'] },
  { id: 'recovery-patch', taskId: 'recovery', title: '会话恢复修复候选', type: '代码变更', updated: '进行中', icon: Code2, summary: '恢复状态机的候选修改，当前仍在运行测试。', checks: ['类型检查通过', '单元测试 18/19', '恢复测试仍在运行'] },
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
      { id: 'prototype-turn-1', who: 'trace', trace: true, status: 'done', duration: '用时 24 秒', entries: [
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
      { id: 'recovery-turn-1', who: 'trace', trace: true, status: 'running', entries: [
        { kind: 'thought', text: '先对比恢复记录和运行状态的落盘顺序，再用现有测试复现问题。' },
        { kind: 'tool', tool: 'run', action: '运行 sessions.test.ts', status: 'running' },
      ] },
      { who: 'Coding Agent', text: '已定位到恢复记录先于运行状态落盘，正在验证调整后的顺序。' },
    ],
  },
};

const initialModelProfiles = [
  { id: 'openai-fast', name: 'GPT-4.1 mini', provider: 'openai', modelId: 'gpt-4.1-mini', endpoint: 'https://api.openai.com/v1', configured: true, description: '响应快，适合日常协调和轻量任务。', thinkingLevels: ['off', 'minimal', 'low', 'medium'] },
  { id: 'openai-main', name: 'GPT-5.2', provider: 'openai', modelId: 'gpt-5.2', endpoint: 'https://api.openai.com/v1', configured: true, description: '主力模型，适合复杂分析和编码任务。', thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'anthropic-main', name: 'Claude Sonnet', provider: 'anthropic', modelId: 'claude-sonnet-4-5', endpoint: 'https://api.anthropic.com', configured: true, description: '适合长文档、代码审阅和持续讨论。', thinkingLevels: ['off', 'low', 'medium', 'high'] },
  { id: 'local-coder', name: '本地 Coding 模型', provider: 'openai-compatible', modelId: 'qwen3-coder', endpoint: 'http://127.0.0.1:11434/v1', configured: false, description: '本地模型配置示例，尚未完成认证或连通检查。', thinkingLevels: ['off', 'low', 'medium'] },
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

// 资料库、记忆、模型使用频率低，从一级页降为设置内的分区。
const settingsSections = [
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'library', label: '资料库', icon: Library },
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
};

function IconButton({ label, children, className = '', ...props }) {
  const id = useId();
  const [anchor, setAnchor] = useState(null);
  function show(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ left: Math.max(100, Math.min(window.innerWidth - 100, rect.left + rect.width / 2)), top: rect.bottom + 8 > window.innerHeight - 40 ? rect.top - 38 : rect.bottom + 8 });
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

function StatusBadge({ status }) {
  const [label, tone] = statusMeta[status] || [status, 'gray'];
  const Icon = status === 'running' ? LoaderCircle : status === 'done' ? CheckCircle2 : tone === 'red' ? CircleAlert : status.includes('paused') ? Pause : Clock3;
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
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxDetail, setInboxDetail] = useState(false);
  const [decisionDrafts, setDecisionDrafts] = useState({});
  const inboxTrigger = useRef(null);
  const [selectedOutputId, setSelectedOutputId] = useState('mvp-doc');
  const [concurrency, setConcurrency] = useState(4);
  const [settingsSection, setSettingsSection] = useState('models');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [modelProfiles, setModelProfiles] = useState(initialModelProfiles);
  const [defaultModelId, setDefaultModelId] = useState('openai-main');
  const [assistantModelId, setAssistantModelId] = useState('openai-main');
  const [assistantThinking, setAssistantThinking] = useState('high');
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  // 工作区里的 Multivac 侧栏：默认展开，方便在细节中顺手安排工作；折叠状态跨进出工作区保留。
  const [multivacSidebarOpen, setMultivacSidebarOpen] = useState(true);
  const [workspaceFocus, setWorkspaceFocus] = useState(null);

  const openRequests = requests.filter((request) => request.state !== 'done');
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[0];

  const multivac = useMultivacConversation({
    queueHint: () => runningCount >= concurrency
      ? `排队 · 当前并发 ${runningCount}/${concurrency}`
      : `立即开始 · 当前并发 ${runningCount}/${concurrency}`,
    onCreateTask: createTaskFromReceipt,
  });

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
      group: receipt.group,
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
      if (!(event.metaKey || event.ctrlKey) || event.key !== '\\') return;
      if (inboxOpen || managementMode || workSurface !== 'workspace') return;
      event.preventDefault();
      setWorkspaceNavigationVisible((current) => !current);
    }
    window.addEventListener('keydown', toggleWorkspaceNavigation);
    return () => window.removeEventListener('keydown', toggleWorkspaceNavigation);
  }, [inboxOpen, managementMode, workSurface]);

  function navigate(target) {
    setInboxOpen(false);
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

  function openInbox() {
    inboxTrigger.current = document.activeElement;
    setAssistantOpen(false);
    setInboxOpen(true);
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
      if (output) setSelectedOutputId(output.id);
    }
    navigate(target);
  }

  function updateTask(taskId, patch) {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task));
  }

  function doNow(taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === 'running') return;
    const running = tasks.filter((item) => item.status === 'running');
    let pausedTask = null;
    setTasks((current) => {
      let next = current;
      if (running.length >= concurrency) {
        pausedTask = [...running].reverse().find((item) => item.id !== taskId);
        if (pausedTask) {
          next = next.map((item) => item.id === pausedTask.id ? {
            ...item,
            status: 'scheduler-paused',
            reason: `为“${task.title}”安全让位`,
            next: '释放名额后自动恢复',
          } : item);
        }
      }
      return next.map((item) => item.id === taskId ? {
        ...item,
        status: 'running',
        reason: '已按你的要求立即执行',
        next: '正在建立执行上下文',
      } : item);
    });
    notify(pausedTask ? `已暂停“${pausedTask.title}”，让当前任务开始执行` : '任务已开始执行');
  }

  function resolveRequest(requestId, action, answer = '') {
    const request = requests.find((item) => item.id === requestId);
    if (!request || request.state === 'done' || !canSubmitDecision(request.type, action, answer)) return;
    setRequests((current) => current.map((item) => item.id === requestId ? { ...item, state: 'done', resolution: decisionLabel(request.type, action), answer: answer.trim() } : item));
    if (request.type === '澄清') {
      updateTask(request.taskId, { status: 'queued', reason: action === 'deny' ? '按现有资料继续，等待执行名额' : action === 'custom' ? `按补充范围继续：${answer.trim()}` : '资料范围已确认，等待执行名额', next: '获得名额后继续' });
    } else if (request.type === '验收') {
      updateTask(request.taskId, action === 'accept' ? { status: 'done', reason: '成果已验收', next: '可从成果区继续使用' } : { status: 'queued', reason: `修改意见：${answer.trim()}`, next: '根据反馈修改成果' });
    } else {
      updateTask(request.taskId, { status: 'done', reason: action === 'allow' ? '已授权发布并完成' : '成果已完成，外发已拒绝', next: '无需进一步处理' });
    }
    // 决策结果由详情原位呈现，不用通知覆盖用户的阅读现场。
  }

  return (
    <div className={`app-shell ${managementMode ? 'management-mode' : 'work-mode'}`}>
      <LogoArea
        managementMode={managementMode}
        toggleMode={() => {
          setManagementMode((current) => !current);
          setAssistantOpen(false);
        }}
      />

      <Topbar
        page={page}
        tasks={tasks}
        openRequests={openRequests.length}
        runningCount={runningCount}
        concurrency={concurrency}
        onOpenInbox={openInbox}
        assistantOpen={assistantOpen}
        setAssistantOpen={setAssistantOpen}
        managementMode={managementMode}
        workSurface={workSurface}
        onOpenWorkspace={() => setWorkSurface('workspace')}
        onOpenAssistant={() => {
          setWorkSurface('assistant');
        }}
      />

      {managementMode && <Sidebar
        page={page}
        onNavigate={navigate}
        openRequests={openRequests.length}
        runningCount={runningCount}
        concurrency={concurrency}
      />}

      <main className="content">
        <div className="view-surface" hidden={managementMode || workSurface !== 'assistant'}><MultivacConversation conversation={multivac} variant="page" visible={!managementMode && workSurface === 'assistant'} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} /></div>
        <div className="view-surface" hidden={managementMode || workSurface !== 'workspace'}>
          <div className={`workspace-shell ${multivacSidebarOpen ? 'with-sidebar' : ''}`}>
            <WorkspaceView tasks={tasks} selectedTaskId={selectedTaskId} sessionRequest={sessionRequest} onOpenTask={openTask} notify={notify} navigationVisible={workspaceNavigationVisible} models={modelProfiles} defaultModelId={defaultModelId} manageModels={() => navigate('models')} onFocusChange={setWorkspaceFocus} onHandToMultivac={handToMultivac} />
            <MultivacSidebar open={multivacSidebarOpen} setOpen={setMultivacSidebarOpen}>
              <MultivacConversation conversation={multivac} variant="sidebar" visible={!managementMode && workSurface === 'workspace' && multivacSidebarOpen} context={workspaceFocus} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} />
            </MultivacSidebar>
          </div>
        </div>
        {managementMode && page === 'tasks' && (
          <TasksView
            tasks={tasks}
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
        {managementMode && page === 'inbox' && (
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
        {managementMode && page === 'outputs' && (
          <OutputsView
            outputs={outputs}
            tasks={tasks}
            selectedOutputId={selectedOutputId}
            setSelectedOutputId={setSelectedOutputId}
            onOpenTask={openTask}
            resolveRequest={resolveRequest}
            requests={requests}
            notify={notify}
          />
        )}
        {managementMode && page === 'settings' && (
          <SettingsView section={settingsSection} setSection={setSettingsSection}>
            {settingsSection === 'models' && <ModelSettings models={modelProfiles} setModels={setModelProfiles} defaultModelId={defaultModelId} setDefaultModelId={setDefaultModelId} notify={notify} />}
            {settingsSection === 'library' && <LibrarySettings notify={notify} />}
            {settingsSection === 'memory' && <MemorySettings notify={notify} />}
          </SettingsView>
        )}
      </main>

      {managementMode && assistantOpen && <aside className="assistant-drawer"><header><div><Orbit /><span><strong>Multivac</strong><small>与首页是同一个对话</small></span></div><IconButton label="关闭" onClick={() => setAssistantOpen(false)}><X /></IconButton></header><MultivacConversation conversation={multivac} variant="drawer" visible={assistantOpen} models={modelProfiles} modelId={assistantModelId} setModelId={setAssistantModelId} thinkingLevel={assistantThinking} setThinkingLevel={setAssistantThinking} manageModels={() => navigate('models')} onOpenTask={openTask} /></aside>}
      <InboxDrawer open={inboxOpen} close={() => setInboxOpen(false)} trigger={inboxTrigger}>
        <InboxView requests={requests} tasks={tasks} selectedRequestId={selectedRequestId} setSelectedRequestId={setSelectedRequestId} resolveRequest={resolveRequest} onOpenTask={openTask} drafts={decisionDrafts} updateDraft={updateDecisionDraft} compact detailOpen={inboxDetail} setDetailOpen={setInboxDetail} close={() => setInboxOpen(false)} expand={() => navigate('inbox')} />
      </InboxDrawer>
      {toast && <div className="toast" role="status"><CheckCircle2 />{toast}</div>}
    </div>
  );
}

/**
 * 工作区里的 Multivac 侧栏：与首页是同一个对话，可折叠成一条窄轨。
 * 折叠时保留入口，展开状态由 App 持有，进出工作区不丢失。
 */
function MultivacSidebar({ open, setOpen, children }) {
  if (!open) {
    return (
      <aside className="multivac-sidebar collapsed">
        <IconButton label="展开 Multivac" onClick={() => setOpen(true)}><Orbit /></IconButton>
      </aside>
    );
  }
  return (
    <aside className="multivac-sidebar" aria-label="Multivac">
      <header>
        <div><Orbit /><span><strong>Multivac</strong><small>与首页是同一个对话</small></span></div>
        <IconButton label="折叠 Multivac" onClick={() => setOpen(false)}><PanelLeftClose /></IconButton>
      </header>
      {children}
    </aside>
  );
}

function LogoArea({ managementMode, toggleMode }) {
  return (
    <button
      className="logo-area"
      onClick={toggleMode}
      aria-label={managementMode ? '返回工作模式' : '打开管理模式'}
      title={managementMode ? '返回工作模式' : '打开管理模式'}
    >
      <Orbit />
      <strong>Multivac</strong>
      <span className="mode-label">{managementMode ? '管理模式' : '工作模式'}</span>
      <ChevronDown className="mode-chevron" />
    </button>
  );
}

function Sidebar({ page, onNavigate, openRequests, runningCount, concurrency }) {
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
        <div className="capacity nav-label"><span>{runningCount}/{concurrency} 执行中</span><span>{openRequests} 待处理</span></div>
      </div>
    </aside>
  );
}

function Topbar({ page, openRequests, runningCount, concurrency, onOpenInbox, assistantOpen, setAssistantOpen, managementMode, workSurface, onOpenWorkspace, onOpenAssistant }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        {managementMode && <div className="page-identity">
          <span>{managementPageLabel(page)}</span>
          <small>管理模式 / Multivac</small>
        </div>}
      </div>
      <div className="topbar-actions">
        {managementMode && <div className="capacity-control" title="当前任务并发">
          <span className="live-dot" />
          <strong>{runningCount}/{concurrency}</strong>
          <span>执行中</span>
        </div>}
        <button className={`inbox-summary ${managementMode ? '' : 'compact'}`} aria-label={`${openRequests} 项待处理`} onClick={onOpenInbox} title="打开 Inbox">
          <Inbox />
          <strong>{openRequests}</strong>
          {managementMode && <span>项待处理</span>}
        </button>
        {!managementMode && workSurface === 'assistant' && <IconButton label="打开工作区" className="work-surface-toggle" onClick={onOpenWorkspace}><Columns2 /></IconButton>}
        {!managementMode && workSurface === 'workspace' && <IconButton label="返回 Multivac" className="work-surface-toggle" onClick={onOpenAssistant}><Bot /></IconButton>}
        {managementMode && <button className={`assistant-trigger ${assistantOpen ? 'active' : ''}`} aria-label="打开 Multivac" title="打开 Multivac" onClick={() => setAssistantOpen(!assistantOpen)}>
          <Bot /><span>助手</span>
        </button>}
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
  const levels = selected?.thinkingLevels || ['off'];

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
    setModelId(model.id);
    if (!model.thinkingLevels.includes(thinkingLevel)) {
      setThinkingLevel(model.thinkingLevels.includes('medium') ? 'medium' : model.thinkingLevels[0]);
    }
    setOpen(false);
  }

  return (
    <div ref={root} className={`model-selector ${compact ? 'compact' : ''}`}>
      <button className="model-selector-trigger" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={`${selected.provider} / ${selected.modelId}`}><Cpu /><span>{selected.name}</span><small>{thinkingLabels[thinkingLevel] || thinkingLevel}</small><ChevronDown /></button>
      {open && <div className="model-selector-menu"><div className="model-selector-heading"><span>当前会话模型</span><strong>{selected.name}</strong></div><div className="model-options">{models.map((model) => <button key={model.id} className={model.id === selected.id ? 'selected' : ''} onClick={() => chooseModel(model)}><Cpu /><span><strong>{model.name}</strong><small>{model.provider} / {model.modelId}</small></span>{model.configured ? model.id === selected.id && <Check /> : <em>未配置</em>}</button>)}</div><label className="thinking-select"><span>推理等级</span><select value={levels.includes(thinkingLevel) ? thinkingLevel : levels[0]} onChange={(event) => setThinkingLevel(event.target.value)}>{levels.map((level) => <option key={level} value={level}>{thinkingLabels[level] || level}</option>)}</select></label><button className="manage-models-link" onClick={() => { setOpen(false); manageModels(); }}><Settings2 />管理模型配置<ArrowRight /></button></div>}
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

const multivacSeedMessages = [
  { who: 'assistant', text: '下午好。当前有 4 个任务在执行，3 项需要你处理。你可以继续当前工作，我会把需要判断的事项集中起来。' },
  { who: 'user', text: '先把界面原型的核心体验走通，暂时不要扩展真实执行能力。' },
  { id: 'demo-prototype-review', who: 'trace', trace: true, status: 'done', duration: '用时 18 秒', defaultOpen: true, entries: [
    { kind: 'thought', text: '先核对协调助手现有的信息层级，确认工作过程与最终回复需要分开呈现。' },
    { kind: 'tool', tool: 'read', action: '读取 .my-docs/mvp.html', status: 'done' },
    { kind: 'thought', text: '现有工具记录可以直接纳入本轮过程，不需要再增加单条展开层级。' },
    { kind: 'tool', tool: 'read', action: '对照原型交互清单', status: 'done' },
  ] },
  { who: 'assistant', text: '明白。我会优先保持助手会话为主，只在你进入工作台时展示会话集合和任务状态。需要你判断的内容仍集中到 Inbox。' },
];

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
function useMultivacConversation({ onCreateTask, queueHint }) {
  const [messages, setMessages] = useState(multivacSeedMessages);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [runFeedback, setRunFeedback] = useState({ phase: 'idle', message: '' });
  const [focusToken, setFocusToken] = useState(0);
  const timers = useRef([]);
  const activeTraceId = useRef(null);
  // 计时器回调里读取最新的调度与建任务逻辑，避免闭包停在发送那一刻。
  const onCreateTaskRef = useRef(onCreateTask);
  const queueHintRef = useRef(queueHint);
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
    return {
      goal: source ? `把「${source.title}」中${excerpt ? '选中的这段内容' : '当前讨论'}整理成结构化文档` : '把当前讨论整理成结构化文档',
      scope: source ? `「${source.title}」${excerpt ? '选中内容' : '会话内容'} + 项目术语表` : '当前对话',
      source,
      excerpt,
      acceptance: true,
      group: '文档',
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
    if (prompt.includes('整理') || prompt.includes('文档')) {
      setReceipt(buildReceipt(context));
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
    if (/文件|代码|文档|检查|运行|测试/u.test(prompt)) {
      const toolName = /运行|测试|检查/u.test(prompt) ? '运行检查' : '读取工作区资料';
      const toolId = `${traceId}-tool`;
      later(1850, () => {
        updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { id: toolId, kind: 'tool', tool: toolName === '运行检查' ? 'run' : 'read', action: toolName, status: 'running' }] }));
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

  /** context.session 是发送时所在现场的焦点会话，用来解析“这个”。 */
  function send(context = {}) {
    const prompt = draft.trim();
    if (!prompt) return;
    const traceId = crypto.randomUUID();
    const sentQuote = quote;
    setMessages((current) => [...current, { who: 'user', text: prompt, quote: sentQuote }, { id: traceId, who: 'trace', trace: true, status: 'running', startedAt: Date.now(), entries: [{ kind: 'thought', text: running ? '正在吸收补充指令，并重新调整本轮处理重点。' : '正在理解这条指令，并确定需要核对的上下文。' }] }]);
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
  function confirmReceipt(acceptance) {
    if (!receipt) return;
    const created = onCreateTaskRef.current({ ...receipt, acceptance });
    setMessages((current) => [...current, { id: `receipt-${created.taskId}`, kind: 'receipt', receipt: { ...receipt, acceptance, ...created } }]);
    setReceipt(null);
  }

  /** 从工作区带着选中内容交给 Multivac：引用写入输入区，并请求侧栏聚焦。 */
  function handOver(nextQuote) {
    setQuote(nextQuote);
    setFocusToken((current) => current + 1);
  }

  useEffect(() => () => clearRunTimers(), []);

  return {
    messages, draft, setDraft, quote, setQuote, receipt, runFeedback, running, focusToken,
    send, stop, confirmReceipt, dismissReceipt: () => setReceipt(null), handOver,
  };
}

function MessageQuote({ quote }) {
  return (
    <blockquote className="message-quote">
      <Quote />
      <span>{quote.source && <cite>来自「{quote.source.title}」</cite>}{quote.text}</span>
    </blockquote>
  );
}

/**
 * Multivac 对话的呈现层。
 *
 * variant 决定外形：page 是首页整页，sidebar / drawer 是工作区侧栏与管理模式抽屉。
 * 选区、滚动跟随这类纯界面状态每个实例各自持有；对话内容全部来自共享的 conversation。
 */
function MultivacConversation({ conversation, variant = 'page', visible = true, context = null, models, modelId, setModelId, thinkingLevel, setThinkingLevel, manageModels, onOpenTask }) {
  const { messages, draft, setDraft, quote, setQuote, receipt, runFeedback, running } = conversation;
  const [selection, setSelection] = useState(null);
  const messagesRef = useRef(null);
  const composerRef = useRef(null);
  const isPage = variant === 'page';
  const { handleScroll, followLatest } = useStickToBottom(messagesRef, [messages, receipt, runFeedback.phase, visible]);

  // 只有侧栏响应“交给 Multivac”：它是工作区里唯一可见的那个实例。
  useEffect(() => {
    if (variant !== 'sidebar' || !conversation.focusToken) return;
    followLatest();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [conversation.focusToken]);

  function submit() {
    followLatest();
    conversation.send({ session: context });
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
        return (
          <div key={index} className={`chat-row ${message.who}`}>
            <span className="avatar">{message.who === 'assistant' ? <Orbit /> : '你'}</span>
            <div className="chat-content">{message.quote && <MessageQuote quote={message.quote} />}<p>{message.text}</p></div>
          </div>
        );
      })}
      {receipt && <TaskReceipt receipt={receipt} onConfirm={conversation.confirmReceipt} />}
    </div>
  );

  const composer = (
    <div className="assistant-composer">
      <RunStatus feedback={runFeedback} stop={conversation.stop} />
      {quote && <div className="composer-quote"><Quote /><div><span>引用选中内容</span>{quote.source && <small className="quote-source">来自「{quote.source.title}」</small>}<p>{quote.text}</p></div><IconButton label="移除引用" onClick={() => setQuote(null)}><X /></IconButton></div>}
      {!quote && context && <div className="composer-context"><Columns2 /><span>正在看「{context.title}」，可以直接说“这个”</span></div>}
      <textarea ref={composerRef} aria-label="发送给 Multivac" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={quote ? '基于这段内容继续讨论…' : isPage ? '安排工作，或继续讨论…' : '顺手安排工作，当前现场保持不动…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } }} />
      <div className="composer-bar">
        <div><ModelSelector models={models} modelId={modelId} setModelId={setModelId} thinkingLevel={thinkingLevel} setThinkingLevel={setThinkingLevel} manageModels={manageModels} compact={!isPage} />{isPage && <><button className="text-button"><Plus />添加资料</button><button className="text-button"><ShieldCheck />范围：当前会话</button></>}</div>
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

function TaskReceipt({ receipt, onConfirm }) {
  const [acceptance, setAcceptance] = useState(receipt.acceptance);
  return (
    <div className="task-receipt">
      <div className="receipt-title"><CheckCircle2 /><div><strong>准备创建任务</strong><span>请确认我理解得是否正确</span></div></div>
      <dl>
        <div><dt>目标</dt><dd>{receipt.goal}</dd></div>
        {receipt.source && <div><dt>来源</dt><dd className="receipt-source"><strong>「{receipt.source.title}」</strong>{receipt.excerpt && <q>{excerptOf(receipt.excerpt)}</q>}</dd></div>}
        <div><dt>资料</dt><dd>{receipt.scope}</dd></div>
        <div><dt>调度</dt><dd>{receipt.state}</dd></div>
      </dl>
      <label className="checkbox-row"><input type="checkbox" checked={acceptance} onChange={(event) => setAcceptance(event.target.checked)} /><span><Check />完成后需要我验收</span></label>
      <div className="receipt-actions"><button className="secondary">调整</button><button className="primary" onClick={() => onConfirm(acceptance)}>确认并执行</button></div>
    </div>
  );
}

/** 确认后的回执：只留一行结论，后续进展走状态摘要，不再插入对话。 */
function ConfirmedReceipt({ receipt, onOpenTask }) {
  return (
    <div className="task-receipt confirmed">
      <CheckCircle2 />
      <div>
        <strong>已创建：{receipt.title}</strong>
        <span>{receipt.state}{receipt.source ? ` · 来源「${receipt.source.title}」` : ''}{receipt.acceptance ? ' · 完成后需要你验收' : ''}</span>
      </div>
      <button className="inline-link" onClick={() => onOpenTask(receipt.taskId, 'tasks')}>查看待办<ArrowRight /></button>
    </div>
  );
}

function TasksView({ tasks, selectedTask, setSelectedTaskId, concurrency, setConcurrency, updateTask, doNow, onOpenSession, notify }) {
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

  function changeConcurrency(next) {
    const value = Math.max(1, Math.min(8, next));
    setConcurrency(value);
    notify(`任务并发上限已调整为 ${value}`);
  }

  return (
    <div className="page-column">
      <PageIntro eyebrow="任务与调度" title="待办" description="掌握整体工作状态，只在需要时干预顺序和并发。" actions={
        <div className="concurrency-stepper"><span>并发上限</span><IconButton label="减少" onClick={() => changeConcurrency(concurrency - 1)}><span>−</span></IconButton><strong>{concurrency}</strong><IconButton label="增加" onClick={() => changeConcurrency(concurrency + 1)}><Plus /></IconButton></div>
      } />
      <div className="toolbar">
        <div className="segmented">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
        <label className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索待办" /></label>
      </div>
      <div className="master-detail">
        <section className="task-list" aria-label="待办列表">
          {visible.map((task) => (
            <button key={task.id} className={`task-row ${selectedTask.id === task.id ? 'selected' : ''}`} onClick={() => setSelectedTaskId(task.id)}>
              <span className={`task-state-mark ${statusMeta[task.status][1]}`} />
              <div className="task-row-main">
                <div><strong>{task.title}</strong><span className="priority">{task.priority}</span></div>
                <p>{task.group} · {task.reason}</p>
              </div>
              <StatusBadge status={task.status} />
              <ChevronRight />
            </button>
          ))}
        </section>
        <TaskDetail task={selectedTask} updateTask={updateTask} doNow={doNow} onOpenSession={onOpenSession} notify={notify} />
      </div>
    </div>
  );
}

function TaskDetail({ task, updateTask, doNow, onOpenSession, notify }) {
  const canStart = ['queued', 'scheduler-paused', 'paused'].includes(task.status);
  const canPause = task.status === 'running';
  return (
    <aside className="detail-panel">
      <div className="detail-header"><div><StatusBadge status={task.status} /><h2>{task.title}</h2><p>{task.group}</p></div><IconButton label="更多操作"><MoreHorizontal /></IconButton></div>
      <div className="detail-actions">
        {canStart && <button className="primary" onClick={() => doNow(task.id)}><Play />先做这个</button>}
        {canPause && <button className="secondary" onClick={() => { updateTask(task.id, { status: 'paused', reason: '由你主动暂停', next: '等待你手动继续' }); notify('任务已在安全节点暂停'); }}><Pause />暂停</button>}
        {task.status === 'paused' && <button className="primary" onClick={() => doNow(task.id)}><Play />继续</button>}
        <button className="secondary" onClick={() => onOpenSession(task)}><MessageSquare />工作会话</button>
      </div>
      <section className="detail-section"><h3>当前状态</h3><div className="state-callout"><span className={`task-state-mark ${statusMeta[task.status][1]}`} /><div><strong>{task.reason}</strong><p>{task.next}</p></div></div></section>
      <section className="detail-section"><h3>任务信息</h3><dl className="info-list"><div><dt>优先级</dt><dd><select value={task.priority} onChange={(event) => updateTask(task.id, { priority: event.target.value })}><option>高</option><option>中</option><option>低</option></select></dd></div><div><dt>资料范围</dt><dd>{task.scope}</dd></div><div><dt>验收</dt><dd>{task.acceptance ? '完成后需要你验收' : '自检通过后自动完成'}</dd></div><div><dt>工作会话</dt><dd><button className="inline-link" onClick={() => onOpenSession(task)}>{task.session} <ArrowRight /></button></dd></div></dl></section>
      <section className="detail-section"><h3>最近进展</h3><ol className="timeline"><li><span /><div><strong>完成上下文整理</strong><p>14:28</p></div></li><li><span /><div><strong>{task.next}</strong><p>现在</p></div></li></ol></section>
    </aside>
  );
}

function InboxDrawer({ open, close, trigger, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open) dialog.current.showModal();
    else if (dialog.current.open) {
      dialog.current.close();
      if (trigger.current?.isConnected) trigger.current.focus();
    }
  }, [open, trigger]);
  return createPortal(<dialog ref={dialog} className="inbox-drawer" aria-labelledby="inbox-drawer-title" onCancel={(event) => { event.preventDefault(); close(); }}>{children}</dialog>, document.body);
}

function InboxView({ requests, tasks, selectedRequestId, setSelectedRequestId, resolveRequest, onOpenTask, markSeen, drafts, updateDraft, compact = false, detailOpen, setDetailOpen, close, expand }) {
  const open = requests.filter((request) => request.state !== 'done');
  const selected = requests.find((request) => request.id === selectedRequestId) || open[0];
  const unread = requests.some((request) => request.state === 'new');
  function select(id) { setSelectedRequestId(id); if (compact) setDetailOpen(true); }
  return (
    <div className={`page-column ${compact ? 'inbox-compact' : ''}`}>
      {compact ? <header className="inbox-drawer-header">{detailOpen && <IconButton label="返回 Inbox 列表" onClick={() => setDetailOpen(false)}><ArrowLeft /></IconButton>}<h2 id="inbox-drawer-title">Inbox</h2><span>{detailOpen && selected ? `${requests.findIndex((item) => item.id === selected.id) + 1} / ${requests.length}` : `${open.length} 项待处理`}</span><IconButton label="展开到完整 Inbox" onClick={expand}><Maximize2 /></IconButton><IconButton label="关闭 Inbox" onClick={close}><X /></IconButton></header> : <PageIntro eyebrow="集中处理" title="Inbox" description="这里只放需要你判断的事项。后台进度与普通完成不会逐条打断。" actions={<button className="secondary" disabled={!unread} onClick={markSeen}><Check />{unread ? '全部标为已查看' : '已全部查看'}</button>} />}
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
  const scope = request.type === '澄清' ? '个人笔记，仅限本次任务' : request.type === '验收' ? task.scope : '成果摘要，本次外部仓库发布';
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
        {request.type === '外发授权' && <div className="answer-block"><div className="permission-note"><ShieldCheck /><p><strong>仅授权本次发布</strong><br />拒绝外发不影响已完成的成果，也不会扩大后续操作权限。</p></div><div className="button-row"><button className="secondary danger" onClick={() => resolveRequest(request.id, 'deny')}>拒绝外发</button><button className="primary" onClick={() => resolveRequest(request.id, 'allow')}><Send />允许本次发布</button></div></div>}
      </>}
    </aside>
  );
}

function WorkspaceView({ tasks, selectedTaskId, sessionRequest, onOpenTask, notify, navigationVisible, models, defaultModelId, manageModels, onFocusChange, onHandToMultivac }) {
  const defaultWorkspaces = {
    '学习与研究': ['learning', 'agent-sdk', 'prototype', 'report', 'scope'],
    'Multivac 开发': ['prototype', 'recovery', 'permissions', 'isolation', 'project-doc', 'review'],
  };
  const initialWorkspace = defaultWorkspaces['Multivac 开发'].includes(selectedTaskId) ? 'Multivac 开发' : '学习与研究';
  const [workspaceMap, setWorkspaceMap] = useState(defaultWorkspaces);
  const [openWorkspaces, setOpenWorkspaces] = useState(Object.keys(defaultWorkspaces));
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const directoryRef = useRef(null);
  const pickerRef = useRef(null);
  const tabsRef = useRef(null);
  const [tabIndicator, setTabIndicator] = useState(null);
  const [customConversations, setCustomConversations] = useState({});
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [viewMode, setViewMode] = useState('parallel');
  const [stackState, setStackState] = useState(null);
  const [creationMode, setCreationMode] = useState(null);
  const [creationName, setCreationName] = useState('');
  const creationTriggerRef = useRef(null);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [maxParallel, setMaxParallel] = useState(3);
  const initialFocus = defaultWorkspaces[initialWorkspace].includes(selectedTaskId) ? selectedTaskId : defaultWorkspaces[initialWorkspace][0];
  const [focusedId, setFocusedId] = useState(initialFocus);
  const [conversationState, setConversationState] = useState({});
  const conversationIds = workspaceMap[workspace] || [];

  // 从任务详情进入时定位目标，同时保留工作区、草稿和已有会话。
  useEffect(() => {
    if (!sessionRequest) return;
    const taskId = sessionRequest.taskId;
    const target = workspaceMap[workspace].includes(taskId) ? workspace : Object.keys(workspaceMap).find((name) => workspaceMap[name].includes(taskId)) || workspace;
    if (!workspaceMap[target].includes(taskId)) setWorkspaceMap((current) => ({ ...current, [target]: [...current[target], taskId] }));
    setWorkspace(target);
    setOpenWorkspaces((current) => current.includes(target) ? current : [...current, target]);
    setFocusedId(taskId);
    setStackState(null);
    setViewMode('focus');
  }, [sessionRequest]);

  useEffect(() => {
    function dismiss(event) {
      if (event.key === 'Escape') {
        setCreationMode(null);
        setConversationMenuOpen(false);
        setDirectoryOpen(false);
      }
    }
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, []);

  useEffect(() => {
    function dismissOutside(event) {
      if (!directoryRef.current?.contains(event.target)) setDirectoryOpen(false);
      if (!pickerRef.current?.contains(event.target)) setConversationMenuOpen(false);
    }
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, []);

  useEffect(() => {
    if (!tabsRef.current) return;
    const update = () => {
      const active = tabsRef.current.querySelector('[aria-selected="true"]');
      if (active) setTabIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tabsRef.current);
    return () => observer.disconnect();
  }, [workspace, openWorkspaces, navigationVisible]);

  useEffect(() => {
    if (!creationMode) return;
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
  }, [creationMode]);

  function createStackConversation(rootId, quote) {
    const normalized = quote.replace(/\s+/g, ' ').trim();
    const childTitle = normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
    setStackState((current) => current?.rootId === rootId
      ? { ...current, nodes: [...current.nodes, { quote: normalized, title: childTitle }] }
      : { rootId, nodes: [{ quote: normalized, title: childTitle }] });
    setFocusedId(rootId);
    setViewMode('focus');
    notify('已从选中内容创建栈式会话');
  }

  function getBaseConversation(id) {
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
    if (stackState?.rootId !== id) return getBaseConversation(id);
    const currentNode = stackState.nodes[stackState.nodes.length - 1];
    return {
      title: currentNode.title,
      category: '栈式会话 · 承接父会话背景',
      messages: [
        { who: '工作会话', text: '已基于父会话中选中的内容创建独立子会话。这里的讨论会承接原背景，但不会自动改写父会话。' },
        { who: '工作会话', text: `我们先聚焦这段内容本身：“${currentNode.quote}”` },
      ],
    };
  }

  function switchWorkspace(nextWorkspace) {
    setWorkspace(nextWorkspace);
    setOpenWorkspaces((current) => current.includes(nextWorkspace) ? current : [...current, nextWorkspace]);
    setDirectoryOpen(false);
    setFocusedId(workspaceMap[nextWorkspace]?.[0] || null);
    setViewMode('parallel');
    setStackState(null);
    setConversationMenuOpen(false);
  }

  function focusConversation(id) {
    setFocusedId(id);
    setViewMode('focus');
    setConversationMenuOpen(false);
  }

  function openCreation(mode) {
    creationTriggerRef.current = document.activeElement;
    setDirectoryOpen(false);
    setConversationMenuOpen(false);
    setCreationName('');
    setCreationMode(mode);
  }

  function submitCreation(event) {
    event.preventDefault();
    const name = creationName.trim();
    if (!name) return;

    if (creationMode === 'workspace') {
      if (workspaceMap[name]) {
        switchWorkspace(name);
        setCreationMode(null);
        notify('已切换到现有工作区');
        return;
      }
      setWorkspaceMap((current) => ({ ...current, [name]: [] }));
      setWorkspace(name);
      setOpenWorkspaces((current) => [...current, name]);
      setFocusedId(null);
      setViewMode('parallel');
      setStackState(null);
      setCreationMode(null);
      notify(`已创建工作区“${name}”`);
      return;
    }

    const id = `custom-${Date.now()}`;
    setCustomConversations((current) => ({
      ...current,
      [id]: {
        title: name,
        category: '普通会话',
        messages: [{ who: '工作会话', text: '新会话已创建。你可以在这里开始讨论，或从其他会话选中内容创建栈式子会话。' }],
      },
    }));
    setWorkspaceMap((current) => ({ ...current, [workspace]: [...(current[workspace] || []), id] }));
    setFocusedId(id);
    setViewMode('focus');
    setCreationMode(null);
    notify(`已在“${workspace}”中创建会话`);
  }

  function changeMaxParallel(event) {
    const next = Number(event.target.value);
    setMaxParallel(next);
    const nextVisible = conversationIds.slice(0, next);
    if (viewMode === 'parallel' && !nextVisible.includes(focusedId)) setFocusedId(nextVisible[0] || null);
  }

  // 把当前焦点会话告诉 Multivac 侧栏，侧栏据此解析“这个”。
  useEffect(() => {
    onFocusChange?.(focusedId ? { id: focusedId, title: getConversation(focusedId).title } : null);
  }, [focusedId, stackState, customConversations]);

  const parallelIds = conversationIds.slice(0, maxParallel);
  const visibleIds = viewMode === 'parallel' ? parallelIds : focusedId ? [focusedId] : [];

  return (
    <div className="workspace-page">
      {navigationVisible && <div className="workspace-strip">
        <div className="workspace-directory" ref={directoryRef}>
          <IconButton label="全部工作区" aria-expanded={directoryOpen} onClick={() => { setDirectoryOpen((current) => !current); setWorkspaceQuery(''); }}><Folder /></IconButton>
          {directoryOpen && <div className="workspace-directory-menu"><label className="directory-search"><Search /><input autoFocus aria-label="搜索工作区" value={workspaceQuery} onChange={(event) => setWorkspaceQuery(event.target.value)} placeholder="搜索工作区…" /></label><div className="directory-results">{Object.keys(workspaceMap).filter((name) => name.toLowerCase().includes(workspaceQuery.toLowerCase())).map((name) => <button key={name} onClick={() => switchWorkspace(name)}><Folder /><span><strong>{name}</strong><small>{workspaceMap[name].length} 个会话</small></span>{workspace === name && <Check />}</button>)}{!Object.keys(workspaceMap).some((name) => name.toLowerCase().includes(workspaceQuery.toLowerCase())) && <p>没有匹配的工作区</p>}</div><button className="directory-create" onClick={() => openCreation('workspace')}><Plus />新建工作区</button></div>}
        </div>
        <div className="workspace-tabs" ref={tabsRef} role="tablist" aria-label="已打开的工作区">
          {openWorkspaces.map((name) => <div className="workspace-tab-item" key={name}><button role="tab" aria-selected={workspace === name} className={workspace === name ? 'active' : ''} onClick={() => switchWorkspace(name)}>{name}</button><IconButton label={`关闭${name}标签`} disabled={openWorkspaces.length === 1} onClick={() => { const remaining = openWorkspaces.filter((item) => item !== name); setOpenWorkspaces(remaining); if (workspace === name) switchWorkspace(remaining[0]); }}><X /></IconButton></div>)}
          {tabIndicator && <span className="workspace-tab-indicator" style={tabIndicator} />}
        </div>
        <div className="workspace-controls">
          <div className="conversation-picker" ref={pickerRef}>
            <button className="conversation-picker-trigger" aria-expanded={conversationMenuOpen} onClick={() => setConversationMenuOpen((current) => !current)}><MessageSquare /><span>会话</span><strong>{visibleIds.length}/{conversationIds.length}</strong><ChevronDown /></button>
            {conversationMenuOpen && <div className="conversation-menu"><div className="conversation-menu-header"><div><strong>{workspace}</strong><span>{conversationIds.length} 个会话</span></div><button onClick={() => openCreation('conversation')}><Plus />新会话</button></div><div className="conversation-menu-list">{conversationIds.map((id, index) => { const task = tasks.find((item) => item.id === id); return <button key={id} className={focusedId === id ? 'selected' : ''} onClick={() => focusConversation(id)}><span className="conversation-order">{index + 1}</span><span className="conversation-menu-name"><strong>{getBaseConversation(id).title}</strong><small>{index < maxParallel ? '平行展示' : '未展示'}</small></span>{task && <StatusBadge status={task.status} />}<ChevronRight /></button>; })}</div></div>}
          </div>
          <div className={`view-mode-switch ${viewMode}`} role="group" aria-label="工作区视图">
            <button aria-pressed={viewMode === 'parallel'} className={viewMode === 'parallel' ? 'active' : ''} onClick={() => { if (!parallelIds.includes(focusedId)) setFocusedId(parallelIds[0]); setViewMode('parallel'); }}><Columns2 />平行</button>
            <button aria-pressed={viewMode === 'focus'} className={viewMode === 'focus' ? 'active' : ''} disabled={!focusedId} onClick={() => setViewMode('focus')}><Maximize2 />聚焦</button>
          </div>
          {viewMode === 'parallel' && <label className="parallel-limit"><span>最多</span><select aria-label="最大平行会话数" value={maxParallel} onChange={changeMaxParallel}>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
        </div>
      </div>}
      {visibleIds.length ? <ResizableConversations layoutKey={JSON.stringify([workspace, visibleIds])} parallel={viewMode === 'parallel'} labels={visibleIds.map((id) => getBaseConversation(id).title)}>
        {visibleIds.map((id) => {
          const task = tasks.find((item) => item.id === id);
          const inStack = stackState?.rootId === id;
          const parentConversation = getBaseConversation(id);
          const stackNodes = inStack ? stackState.nodes : [];
          const currentStackNode = stackNodes[stackNodes.length - 1];
          const stateKey = JSON.stringify([id, ...stackNodes.map((node) => node.quote)]);
          const sessionState = conversationState[stateKey] || { draft: '', messages: [], modelId: defaultModelId, thinkingLevel: 'medium' };
          return (
            <ConversationPanel
              key={`${id}-${stackNodes.length}`}
              sessionId={id}
              onHandToMultivac={onHandToMultivac}
              conversation={getConversation(id)}
              sessionState={sessionState}
              setSessionState={(patch) => setConversationState((current) => ({ ...current, [stateKey]: { draft: '', messages: [], modelId: defaultModelId, thinkingLevel: 'medium', ...(current[stateKey] || {}), ...patch } }))}
              task={task}
              onOpenTask={onOpenTask}
              onFocus={() => focusConversation(id)}
              onReturnToParallel={() => { if (!parallelIds.includes(focusedId)) setFocusedId(parallelIds[0]); setViewMode('parallel'); }}
              focused={viewMode === 'focus'}
              active={focusedId === id}
              onActivate={() => setFocusedId(id)}
              stackPath={inStack ? [parentConversation.title, ...stackNodes.map((node) => node.title)] : []}
              stackSource={inStack ? currentStackNode.quote : ''}
              onBackStack={inStack ? () => setStackState((current) => current.nodes.length > 1 ? { ...current, nodes: current.nodes.slice(0, -1) } : null) : null}
              onCreateStack={(quote) => createStackConversation(id, quote)}
              notify={notify}
              models={models}
              manageModels={manageModels}
            />
          );
        })}
      </ResizableConversations> : <div className="workspace-empty"><MessageSquare /><h2>{workspace}</h2><p>这个工作区还没有会话。</p><button className="primary" onClick={() => openCreation('conversation')}><Plus />创建首个会话</button></div>}

      {creationMode && <div className="creation-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreationMode(null); }}><form className="creation-dialog" role="dialog" aria-modal="true" aria-labelledby="creation-title" onSubmit={submitCreation}><div className="creation-header"><div><span>{creationMode === 'workspace' ? '工作区' : workspace}</span><h2 id="creation-title">{creationMode === 'workspace' ? '创建工作区' : '创建新会话'}</h2></div><IconButton type="button" label="关闭" onClick={() => setCreationMode(null)}><X /></IconButton></div><label><span>{creationMode === 'workspace' ? '工作区名称' : '会话名称'}</span><input autoFocus value={creationName} onChange={(event) => setCreationName(event.target.value)} placeholder={creationMode === 'workspace' ? '例如：产品设计' : '例如：梳理导航结构'} /></label><p>{creationMode === 'workspace' ? '工作区通过标签组织一组相关会话。' : `新会话会加入“${workspace}”工作区。`}</p><div className="creation-actions"><button type="button" className="secondary" onClick={() => setCreationMode(null)}>取消</button><button type="submit" className="primary" disabled={!creationName.trim()}>创建</button></div></form></div>}
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
    <summary><span>{summary}</span><ChevronRight className="disclosure-chevron" /></summary>
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

function ConversationPanel({ sessionId, onHandToMultivac, conversation, sessionState, setSessionState, task, onOpenTask, onFocus, onReturnToParallel, focused, active, onActivate, stackPath = [], stackSource, onBackStack, onCreateStack, notify, models, manageModels }) {
  const { draft, messages, modelId, thinkingLevel } = sessionState;
  const [selection, setSelection] = useState(null);
  const [quote, setQuote] = useState('');
  const panelRef = useRef(null);
  const messagesRef = useRef(null);
  const composerRef = useRef(null);
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
        updateTrace(traceId, (trace) => ({ ...trace, entries: [...trace.entries, { id: toolId, kind: 'tool', tool: /运行|测试|命令/u.test(prompt) ? 'run' : 'edit', action: /运行|测试|命令/u.test(prompt) ? '运行工作区检查' : '检查相关文件', status: 'running' }] }));
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
    const nextMessages = [...sessionMessagesRef.current, { who: '你', text: prompt, quote }, { id: traceId, who: 'trace', trace: true, status: 'running', startedAt: Date.now(), entries: [{ kind: 'thought', text: running ? '正在吸收补充指令，并调整当前工作。' : '正在理解这条指令，并规划本轮处理。' }] }];
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
    <section ref={panelRef} className={`conversation-panel ${focused ? 'focused' : ''} ${active ? 'active' : ''}`} onMouseDown={onActivate} onFocus={onActivate}>
      <header className="conversation-header">
        <div className="conversation-title">
          {onBackStack && <IconButton label="返回父会话" onClick={onBackStack}><ArrowLeft /></IconButton>}
          <div>{stackPath.length > 0 && <div className="conversation-path">栈式路径 · {stackPath.join(' / ')}</div>}<h2>{conversation.title}</h2>{task && <button className="conversation-task-link" onClick={() => onOpenTask(task.id, 'tasks')}><ListTodo /><span>{task.title}</span><ChevronRight /></button>}</div>
        </div>
        <div className="conversation-tools">{focused ? <button className="return-parallel" onClick={onReturnToParallel}><Columns2 />返回平行视图</button> : <IconButton label="放大会话" onClick={onFocus}><Maximize2 /></IconButton>}</div>
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
          return <div key={index} className={`work-message ${message.who === '你' ? 'user-message' : ''} ${message.who === '任务' ? 'goal-message' : ''} ${repeated ? 'continued' : ''}`}>{!repeated && <div>{speaker}</div>}{message.quote && <blockquote className="message-quote"><Quote />{message.quote}</blockquote>}<p>{message.text}</p></div>;
        })}
      </div>
      {selection && <div className="selection-toolbar" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()}>
        <button onClick={quoteSelection}><Quote />引用</button>
        <button onClick={() => { onCreateStack?.(selection.text); clearSelection(); }}><SquareStack />深入一层</button>
        {/* 把选中内容连同来源会话交给侧栏里的 Multivac，当前会话保持原样。 */}
        <button onClick={() => { onHandToMultivac?.(selection.text, { sessionId, title: conversation.title }); clearSelection(); }}><Bot />交给 Multivac</button>
        <IconButton label="关闭" onClick={clearSelection}><X /></IconButton>
      </div>}
      {task && <div className="session-progress"><StatusBadge status={task.status} /><span title={task.reason}>{task.reason}</span></div>}
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
      ) : <div className="work-composer">{quote && <div className="composer-quote"><Quote /><div><span>引用选中内容</span><p>{quote}</p></div><IconButton label="移除引用" onClick={() => setQuote('')}><X /></IconButton></div>}<textarea ref={composerRef} aria-label={`发送到${conversation.title}`} value={draft} onChange={(event) => setSessionState({ draft: event.target.value })} placeholder={quote ? '基于这段内容继续讨论…' : '继续当前工作…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} /><div><div className="work-composer-tools"><ModelSelector models={models} modelId={modelId} setModelId={(value) => setSessionState({ modelId: value })} thinkingLevel={thinkingLevel} setThinkingLevel={(value) => setSessionState({ thinkingLevel: value })} manageModels={manageModels} compact /><IconButton label="引用资料" onClick={() => notify('原型暂未连接资料选择器')}><Plus /></IconButton></div><RunStatus feedback={runFeedback} stop={stopRun} compact /><IconButton label={running ? '补充指令' : '发送'} disabled={!draft.trim()} className="send-button" onClick={send}><ArrowRight /></IconButton></div></div>}
    </section>
  );
}

function OutputsView({ outputs, tasks, selectedOutputId, setSelectedOutputId, onOpenTask, resolveRequest, requests, notify }) {
  const selected = outputs.find((output) => output.id === selectedOutputId) || outputs[0];
  const task = tasks.find((item) => item.id === selected.taskId);
  const reviewRequest = requests.find((request) => request.taskId === selected.taskId && request.type === '验收' && request.state !== 'done');
  return (
    <div className="page-column">
      <PageIntro eyebrow="独立产物" title="成果" description="无需翻找聊天记录，直接查看、验收并继续使用工作输出。" actions={<button className="secondary"><Plus />创建后续任务</button>} />
      <div className="master-detail outputs-layout">
        <section className="output-list">{outputs.map((output) => { const Icon = output.icon; return <button key={output.id} className={`output-row ${selected.id === output.id ? 'selected' : ''}`} onClick={() => setSelectedOutputId(output.id)}><span className="file-icon"><Icon /></span><div><strong>{output.title}</strong><p>{output.type} · {output.updated}</p></div><ChevronRight /></button>; })}</section>
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
      <PageIntro eyebrow="低频配置" title="设置" description="模型、资料库与记忆。使用范围仍在任务上就地设置。" actions={
        <div className="segmented settings-tabs" role="tablist" aria-label="设置分区">
          {settingsSections.map((item) => { const Icon = item.icon; return <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><Icon />{item.label}</button>; })}
        </div>
      } />
      {children}
    </div>
  );
}

function LibrarySettings({ notify }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('mvp');
  const docs = [
    { id: 'mvp', title: 'mvp.html', category: '产品定义', format: 'HTML', scope: 'Multivac 项目', parsed: true },
    { id: 'requirements', title: 'personal-agent-requirements.html', category: '产品定义', format: 'HTML', scope: 'Multivac 项目', parsed: true },
    { id: 'notes', title: 'distributed-systems-notes.pdf', category: '学习资料', format: 'PDF', scope: '仅指定任务', parsed: true },
    { id: 'archive', title: 'sdk-comparison.pages', category: '研究资料', format: 'Pages', scope: '未授权使用', parsed: false },
  ];
  const item = docs.find((doc) => doc.id === selected);
  return <><div className="toolbar"><label className="search-field wide"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按文件名搜索" /></label><div className="toolbar-actions"><button className="secondary"><Folder />全部分类 <ChevronDown /></button><button className="primary" onClick={() => notify('已打开本地文件选择模拟')}><Plus />收藏本地文档</button></div></div><div className="master-detail"><section className="document-list">{docs.filter((doc) => doc.title.includes(query)).map((doc) => <button key={doc.id} className={selected === doc.id ? 'selected' : ''} onClick={() => setSelected(doc.id)}><FileText /><div><strong>{doc.title}</strong><p>{doc.category} · {doc.format}</p></div><span className={doc.parsed ? 'parse-ok' : 'parse-no'}>{doc.parsed ? '可解析' : '不可解析'}</span><ChevronRight /></button>)}</section><aside className="detail-panel library-detail"><div className="file-large"><FileText /></div><h2>{item.title}</h2><p>{item.category} · {item.format}</p><section className="detail-section"><h3>使用范围</h3><div className="scope-selector"><ShieldCheck /><div><strong>{item.scope}</strong><p>记忆和任务不能扩大此资料的使用范围。</p></div><button className="secondary">调整</button></div></section><section className="detail-section"><h3>可用操作</h3><button className="action-line" onClick={() => notify('已引用到 Multivac')}><Bot />交给 Multivac<ArrowRight /></button><button className="action-line" onClick={() => notify('已选择用于当前任务')}><ListTodo />用于当前任务<ArrowRight /></button><button className="action-line"><Settings2 />重命名或分类<ArrowRight /></button></section></aside></div></>;
}

function ModelSettings({ models, setModels, defaultModelId, setDefaultModelId, notify }) {
  const [selectedId, setSelectedId] = useState(defaultModelId);
  const selected = models.find((model) => model.id === selectedId) || models[0];
  const [draft, setDraft] = useState(selected);
  const [adding, setAdding] = useState(false);
  const [newModel, setNewModel] = useState({ name: '', provider: 'openai-compatible', modelId: '', endpoint: '' });

  useEffect(() => setDraft(selected), [selectedId, selected]);

  function save(event) {
    event.preventDefault();
    setModels((current) => current.map((model) => model.id === selected.id ? { ...model, ...draft } : model));
    notify('模型配置已保存');
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
      thinkingLevels: ['off', 'low', 'medium', 'high'],
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
          <div className="model-detail-header"><div><span className={`model-availability ${draft.configured ? 'configured' : ''}`}>{draft.configured ? '可用' : '未配置'}</span><h2>{draft.name}</h2><p>{draft.description}</p></div><button type="button" className="secondary" disabled={selected.id === defaultModelId || !draft.configured} onClick={() => { setDefaultModelId(selected.id); notify('默认模型已更新'); }}>{selected.id === defaultModelId ? '当前默认' : '设为默认'}</button></div>
          <div className="model-form-grid">
            <label><span>显示名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span>提供方</span><select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI 兼容</option><option value="google">Google</option></select></label>
            <label className="wide"><span>模型 ID</span><input value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} /></label>
            <label className="wide"><span>API 端点</span><input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} placeholder="https://…/v1" /></label>
            <label className="wide"><span>API Key</span><input type="password" placeholder={draft.configured ? '已配置，不显示现有值' : '输入后完成认证'} /><small>原型不会保存或发送输入的密钥。</small></label>
          </div>
          <section className="thinking-capabilities"><div><strong>支持的推理等级</strong><span>运行时会按模型能力调整不可用等级。</span></div><div>{draft.thinkingLevels.map((level) => <span key={level}>{thinkingLabels[level] || level}</span>)}</div></section>
          <label className="model-auth-toggle"><input type="checkbox" checked={draft.configured} onChange={(event) => setDraft({ ...draft, configured: event.target.checked })} /><span><strong>认证与连通检查通过</strong><small>关闭后，该模型不会出现在会话的可用模型列表中。</small></span></label>
          <div className="model-detail-actions"><button type="button" className="secondary" onClick={() => setDraft(selected)}>放弃修改</button><button type="submit" className="primary"><Check />保存配置</button></div>
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
