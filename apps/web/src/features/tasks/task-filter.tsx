import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';

type TaskFilterOption = { id: string; label: string; icon?: LucideIcon; divider?: boolean; tone?: string };

/** 项目与状态共用原型筛选菜单，支持方向键、首尾跳转与输入定位。 */
export function TaskFilter({ label, name, icon: Icon, value, options, onChange, appearance = 'filter', disabled = false, floating = appearance === 'field' }: {
  label: string; name: string; icon: LucideIcon; value: string;
  options: TaskFilterOption[]; onChange: (id: string) => void;
  appearance?: 'filter' | 'field'; disabled?: boolean; floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const search = useRef({ text: '', at: 0 });
  const listId = useId();
  const selected = options.find((option) => option.id === value) || options[0]!;

  useLayoutEffect(() => {
    if (!open || !floating) return;
    // 表单选择菜单在窗口内定位，避免被可滚动正文裁切，同时保留模态层内的焦点顺序。
    function position() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upward = below < 180 && above > below;
      const width = Math.min(rect.width, window.innerWidth - 32);
      setMenuStyle({
        position: 'fixed', width, left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        top: upward ? 'auto' : rect.bottom + 8,
        bottom: upward ? window.innerHeight - rect.top + 8 : 'auto',
        maxHeight: Math.max(80, Math.min(380, upward ? above : below)),
      });
    }
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open, floating]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus({ preventScroll: true });
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function show(index = options.findIndex((option) => option.id === value)) {
    search.current = { text: '', at: 0 };
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  }

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActiveIndex((index) => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Tab') {
      // 焦点先回到触发器，浏览器随后按正常顺序移至下一个控件。
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - search.current.at < 700 ? search.current.text : '') + event.key.toLowerCase();
      search.current = { text, at: now };
      const index = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
      if (index >= 0) setActiveIndex(index);
    }
  }

  return <div ref={root} className={`task-panel-filter ${appearance} ${appearance === 'filter' && value !== 'all' ? 'active' : ''} ${open ? 'open' : ''}`}>
    <button ref={trigger} type="button" className="task-filter-trigger" disabled={disabled} aria-label={`${name}：${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={(event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); }
    }}><Icon aria-hidden="true" />{appearance === 'filter' && <span className="task-filter-label">{label}</span>}<span className="task-filter-value" title={selected.label}>{selected.label}</span><ChevronDown className="task-filter-chevron" aria-hidden="true" /></button>
    {open && <div id={listId} className={`task-filter-menu ${appearance}`} style={floating ? menuStyle : undefined} role="listbox" aria-label={name} onKeyDown={navigate}>
      <div className="task-filter-menu-heading" role="presentation">选择{label}</div>
      {options.map((option, index) => {
        const OptionIcon = option.icon || Icon;
        return <button type="button" key={option.id} ref={(element) => { optionRefs.current[index] = element; }} role="option" aria-selected={option.id === value} tabIndex={index === activeIndex ? 0 : -1} className={`task-filter-option ${option.id === value ? 'selected' : ''} ${option.divider ? 'divider' : ''}`} onFocus={() => setActiveIndex(index)} onClick={() => choose(option.id)}><OptionIcon className={option.tone || ''} aria-hidden="true" /><span>{option.label}</span>{option.id === value && <Check className="task-filter-check" aria-hidden="true" />}</button>;
      })}
    </div>}
  </div>;
}
