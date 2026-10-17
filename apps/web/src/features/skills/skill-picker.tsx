import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CircleAlert, Layers, Search, SearchX, SlidersHorizontal, X } from 'lucide-react';
import { parseSkillInvocation, skillInvocation, type SkillAvailability } from '@multivac/contracts';
import { skillApi } from './skills-store.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import './skill-picker.css';

/**
 * 选择只更新原草稿；身份首行显示为标签，不向用户暴露存储编码。
 * 两种打开方式：草稿以 / 开头时按草稿筛选（选择后替换这段命令）；
 * 点击底栏的 Skill 按钮时在弹层内搜索（选择后保留已输入的正文）。
 */
export function useSkillPicker(
  sessionId: string,
  draft: string,
  update: (text: string) => void,
  focusComposer: () => void = () => {},
) {
  const [preferenceError, setPreferenceError] = useState('');
  const [items, setItems] = useState<SkillAvailability[]>([]),
    [index, setIndex] = useState(0),
    [dismissed, setDismissed] = useState(false),
    [manual, setManual] = useState(false),
    [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null),
    activeRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selected = parseSkillInvocation(draft),
    text = selected?.text ?? draft;
  const typed = !selected && /^\/[^\n]*$/u.test(text);
  const open = !dismissed && (typed || manual);

  const refresh = () => {
    void skillApi<SkillAvailability[]>(`/catalog?sessionId=${encodeURIComponent(sessionId)}`)
      .then(setItems)
      .catch(() => setItems([]));
  };
  useEffect(() => {
    refresh();
  }, [sessionId]);
  useWorkbenchEvents((e) => {
    if (e.type === 'skill.changed' || e.type === 'workbench.connected') refresh();
  });

  const query = (typed ? text.slice(1).replace(/^Skill\s*/iu, '') : search).trim().toLowerCase();
  const choices = items
    .filter((i) =>
      `${i.record.name} ${i.record.displayName} ${i.record.description}`.toLowerCase().includes(query),
    )
    .slice(0, 20);
  useEffect(() => {
    setIndex(0);
    setDismissed(false);
  }, [text, search]);
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, index]);
  useEffect(() => {
    if (manual) searchRef.current?.focus({ preventScroll: true });
  }, [manual]);

  const close = () => {
    if (manual) {
      setManual(false);
      setSearch('');
      focusComposer();
    } else setDismissed(true);
  };
  const choose = (item: SkillAvailability) => {
    if (!item.available) return;
    // 按草稿筛选时替换掉 / 命令；从按钮打开时保留已输入的正文。
    update(skillInvocation(item.record, item.record.displayName) + (typed ? '' : text));
    setManual(false);
    setSearch('');
    focusComposer();
  };
  /** 草稿输入框与弹层搜索框共用的键盘操作；已处理时返回 true。 */
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex(
        (n) => (n + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % Math.max(1, choices.length),
      );
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (choices[index]) choose(choices[index]);
      return true;
    }
    return false;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => (typed && open ? navigate(event) : false);

  async function toggleRelevance(item: SkillAvailability) {
    try {
      const p = await skillApi<{ revision: number; hidden: boolean }>(
        `/preference?skillId=${encodeURIComponent(item.record.skillId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      await skillApi('/preference', {
        commandId: crypto.randomUUID(),
        skillId: item.record.skillId,
        sessionId,
        projectId: null,
        revision: p.revision,
        hidden: !item.closed,
      });
      setPreferenceError('');
    } catch (error) {
      setPreferenceError((error as Error).message);
    }
    refresh();
  }

  const trigger = (
    <button
      type="button"
      className="skill-invoke-button"
      aria-label="选择 Skill"
      aria-expanded={open}
      aria-controls={menuId}
      title="选择 Skill，也可以在输入框开头输入 /"
      onMouseDown={(e) => {
        if (open) e.preventDefault();
      }}
      onClick={() => {
        if (open) close();
        else {
          setDismissed(false);
          setSearch('');
          setManual(true);
        }
      }}
    >
      <Layers aria-hidden="true" />
      <span>Skill</span>
    </button>
  );

  return {
    text,
    onKeyDown,
    trigger,
    update: (value: string) =>
      update(selected ? skillInvocation(selected.ref, selected.label) + value : value),
    view: (
      <>
        {selected && (
          <div className="composer-skill">
            <Layers aria-hidden="true" />
            <span title={selected.label}>Skill · {selected.label}</span>
            <button type="button" aria-label="移除 Skill" title="移除 Skill" onClick={() => update(selected.text)}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}
        {open && (
          <div
            className="skill-picker-menu"
            id={menuId}
            onBlur={(e) => {
              if (manual && !e.currentTarget.contains(e.relatedTarget)) {
                setManual(false);
                setSearch('');
              }
            }}
          >
            <div className="skill-picker-heading">
              <strong>选择 Skill</strong>
              <span>{typed ? '继续输入以筛选' : '仅用于本条消息'}</span>
            </div>
            {!typed && (
              <div className="skill-picker-search">
                <Search aria-hidden="true" />
                <input
                  ref={searchRef}
                  aria-label="搜索 Skill"
                  placeholder="搜索 Skill…"
                  autoComplete="off"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={navigate}
                  aria-controls={`${menuId}-options`}
                />
              </div>
            )}
            <div role="listbox" aria-label="选择 Skill" id={`${menuId}-options`} className="skill-picker-options">
              {choices.map((item, n) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={n === index}
                  aria-disabled={!item.available}
                  key={item.record.skillId}
                  ref={n === index ? activeRef : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setIndex(n)}
                  onClick={() => choose(item)}
                >
                  <span className="skill-option-icon">
                    <Layers aria-hidden="true" />
                  </span>
                  <span className="skill-option-copy">
                    <strong>
                      {item.record.displayName}
                      {item.record.projectId && <em>项目</em>}
                    </strong>
                    <small>{item.available ? item.record.description : item.reasons.join('；')}</small>
                  </span>
                  {!item.available && <CircleAlert className="skill-option-status" aria-label="不可用" />}
                </button>
              ))}
            </div>
            {!choices.length && (
              <div className="skill-picker-empty">
                <SearchX aria-hidden="true" />
                <strong>{query ? '没有匹配的 Skill' : '还没有可用的 Skill'}</strong>
                <span>{query ? '试试其他关键词' : '可在 管理 · 能力 中导入'}</span>
              </div>
            )}
            {items.length > 0 && (
              <details className="skill-picker-manage">
                <summary>
                  <SlidersHorizontal aria-hidden="true" />
                  调整此会话的 Skill
                </summary>
                <div className="skill-picker-relevance">
                  {items.map((item) => (
                    <label key={item.record.skillId}>
                      <input type="checkbox" checked={!item.closed} onChange={() => void toggleRelevance(item)} />
                      <span>{item.record.displayName}</span>
                    </label>
                  ))}
                </div>
                <p>只控制此会话的候选范围，不改变工具权限。</p>
                {preferenceError && <p role="alert">{preferenceError}</p>}
              </details>
            )}
            <div className="skill-picker-footer">
              <span>按需加载正文与资料</span>
              <span className="skill-picker-keys" aria-hidden="true">
                <span><kbd>↑↓</kbd>切换</span>
                <span><kbd>↵</kbd>选择</span>
                <span><kbd>esc</kbd>关闭</span>
              </span>
            </div>
          </div>
        )}
      </>
    ),
  };
}
