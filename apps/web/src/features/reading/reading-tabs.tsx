export function ReadingTabs<T extends string>({ label, value, tabs, change }: { label: string; value: T; tabs: { id: T; label: string }[]; change: (id: T) => void }) {
  return <div className="reading-view-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const current = tabs.findIndex(t => t.id === value);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    change(tabs[index]!.id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[index]?.focus();
  }}>{tabs.map(tab => <button key={tab.id} role="tab" aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1} onClick={() => change(tab.id)}>{tab.label}</button>)}</div>;
}
