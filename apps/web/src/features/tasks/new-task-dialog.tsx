import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, Folder, LoaderCircle, Plus, X } from 'lucide-react';
import type { Task } from '@multivac/contracts';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import { useTasks } from './tasks-provider.js';
import { TaskFilter } from './task-filter.js';
import { TaskIconButton } from './task-icon-button.js';

/** 对齐管理待办的独立创建弹窗，创建仅记录任务，不启动执行。 */
export function NewTaskDialog({ projects, initialProjectId, onClose, onCreated }: {
  projects: { id: string; name: string }[];
  initialProjectId: string;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const { store } = useTasks();
  const [name, setName] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const [projectId, setProjectId] = useState(() => projects.some((project) => project.id === initialProjectId) ? initialProjectId : '');
  const [acceptance, setAcceptance] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const creation = useRef<{ key: string; commandId: string } | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [opener] = useState(() => document.activeElement);
  const fieldId = useId();

  useEffect(() => {
    const element = dialog.current;
    nameInput.current?.focus();
    return () => {
      // StrictMode 的模拟卸载仍保留节点，不提前归还焦点。
      if (element?.isConnected) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  async function submit() {
    if (!store || submitting.current || !name.trim() || !goal.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const input = { title: name.trim(), goal: goal.trim(), scope: scope.trim(), priority,
        projectId: projectId || null,
        acceptance, acceptanceCriteria: acceptance ? '' : '非空文本',
      };
      const key = JSON.stringify(input);
      if (creation.current?.key !== key) creation.current = { key, commandId: crypto.randomUUID() };
      onCreated(await store.create({ ...input, commandId: creation.current.commandId }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '任务创建失败，请重试');
      submitting.current = false;
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // 弹窗内的快捷键不触发管理导航；下拉菜单优先处理自己的 Esc。
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!submitting.current) onClose();
    } else if (event.key === 'Tab') {
      const items = focusableWithin(event.currentTarget);
      const next = wrapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (next !== null) { event.preventDefault(); (items[next] ?? dialog.current)?.focus(); }
    }
  }

  return createPortal(<div className="confirm-scrim task-create-scrim" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => {
    if (event.target === event.currentTarget) { event.preventDefault(); if (!submitting.current) onClose(); }
  }}>
    <form ref={dialog} className="task-create-dialog" role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-title`} aria-describedby={`${fieldId}-description`} aria-busy={busy || undefined} tabIndex={-1} onKeyDown={handleKeyDown} onChange={() => setError('')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header><div><h2 id={`${fieldId}-title`}>创建任务</h2><p id={`${fieldId}-description`}>先记录要做的事，创建后可从任务面板启动。</p></div><TaskIconButton label="关闭创建任务" disabled={busy} onClick={onClose}><X /></TaskIconButton></header>
      <div className="task-create-fields">
        <label className="task-create-field"><span>任务名称 <small>必填</small></span><input ref={nameInput} aria-label="任务名称" required disabled={busy} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：整理本周项目进展" /></label>
        <label className="task-create-field"><span>目标说明 <small>必填</small></span><textarea aria-label="目标说明" required disabled={busy} rows={3} maxLength={2000} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述希望得到的结果，以及需要注意的要求" /></label>
        <div className="task-create-options">
          <TaskFilter label="项目" name="任务所属项目" icon={Folder} floating disabled={busy} value={projectId} onChange={(id) => { setProjectId(id); setError(''); }} options={[{ id: '', label: '不关联项目' }, ...projects.map((project, index) => ({ id: project.id, label: project.name, divider: index === 0 }))]} />
          <TaskFilter label="优先级" name="任务优先级" icon={CircleAlert} floating disabled={busy} value={priority} onChange={(id) => { setPriority(id as Task['priority']); setError(''); }} options={[{ id: 'high', label: '高' }, { id: 'medium', label: '中' }, { id: 'low', label: '低' }]} />
        </div>
        <label className="task-create-field"><span>资料范围 <small>选填</small></span><input aria-label="资料范围" disabled={busy} maxLength={1000} value={scope} onChange={(event) => setScope(event.target.value)} placeholder="例如：当前项目文档、指定参考资料" /></label>
        <label className="task-create-acceptance"><input type="checkbox" disabled={busy} checked={acceptance} onChange={(event) => setAcceptance(event.target.checked)} /><span>完成后需要我验收</span></label>
        {!acceptance && <p className="task-create-hint">无需人工验收时，会检查成果内容非空。</p>}
        {error && <p className="task-create-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim() || !goal.trim()}>{busy ? <LoaderCircle className="spin" /> : <Plus />}创建任务</button></footer>
    </form>
  </div>, document.body);
}
