import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { parseSkillInvocation, skillInvocation, type SkillAvailability } from '@multivac/contracts';
import { skillApi } from './skills-store.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
/** 选择只更新原草稿；身份首行显示为标签，不向用户暴露存储编码。 */
export function useSkillPicker(sessionId: string, draft: string, update: (text: string) => void) {
  const [preferenceError, setPreferenceError] = useState('');
  const [items, setItems] = useState<SkillAvailability[]>([]),
    [index, setIndex] = useState(0),
    [dismissed, setDismissed] = useState(false);
  const selected = parseSkillInvocation(draft),
    text = selected?.text ?? draft;
  const open = !selected && !dismissed && /^\/[^\n]*$/u.test(text);
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
  const query = text
    .slice(1)
    .replace(/^Skill\s*/iu, '')
    .toLowerCase();
  const choices = items
    .filter((i) =>
      `${i.record.name} ${i.record.displayName} ${i.record.description}`.toLowerCase().includes(query),
    )
    .slice(0, 20);
  useEffect(() => {
    setIndex(0);
    setDismissed(false);
  }, [text]);
  const choose = (item: SkillAvailability) => {
    if (item.available) update(skillInvocation(item.record, item.record.displayName));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (!open) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
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
  return {
    text,
    onKeyDown,
    update: (value: string) =>
      update(selected ? skillInvocation(selected.ref, selected.label) + value : value),
    view: (
      <>
        {selected && (
          <div className="composer-context">
            <span>Skill · {selected.label}</span>
            <button type="button" aria-label="移除 Skill" onClick={() => update(selected.text)}>
              ×
            </button>
          </div>
        )}
        {open && (
          <details>
            <summary>调整此会话的 Skill</summary>
            {choices.map((item) => (
              <label key={item.record.skillId} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={!item.closed}
                  onChange={() => {
                    void (async () => {
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
                        refresh();
                      } catch (error) {
                        setPreferenceError((error as Error).message);
                        refresh();
                      }
                    })();
                  }}
                />
                {item.record.displayName}
              </label>
            ))}
            <p>只控制此会话相关性，不改变工具权限。</p>
            {preferenceError && <p role="alert">{preferenceError}</p>}
          </details>
        )}
        {open && (
          <div role="listbox" aria-label="选择 Skill" className="skill-picker">
            {choices.length ? (
              choices.map((item, n) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={n === index}
                  aria-disabled={!item.available}
                  key={item.record.skillId}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <strong>{item.record.displayName}</strong>
                  <span>{item.available ? item.record.description : item.reasons.join('；')}</span>
                </button>
              ))
            ) : (
              <p>没有匹配的 Skill，请先在设置 · 能力导入。</p>
            )}
          </div>
        )}
      </>
    ),
  };
}
