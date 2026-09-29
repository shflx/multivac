import { Columns2, Orbit } from 'lucide-react';

/**
 * 窄屏时工作区与管理的替代呈现：说明需要在桌面使用，并给出“回到 Multivac”。
 * 它只替换呈现，工作区与管理页仍在下面保持挂载（隐藏），回到宽屏即原样恢复。
 * 说明只写已实现的内容：原型的“处理 Inbox、查看成果，以及读书”尚未实现，不写。
 */
export function DesktopOnlyNotice({
  surface,
  onGoHome,
  goHomeDisabled,
}: {
  surface: '管理' | '工作区';
  onGoHome: () => void;
  goHomeDisabled: boolean;
}) {
  return (
    <section className="desktop-only" aria-labelledby="desktop-only-title">
      <Columns2 aria-hidden="true" />
      <h2 id="desktop-only-title">{surface}请在桌面使用</h2>
      <p>窄屏只保留日常层：和 Multivac 对话。并排、栈式深入和批量管理需要更宽的屏幕。</p>
      <button type="button" className="primary-button" onClick={onGoHome} disabled={goHomeDisabled}>
        <Orbit aria-hidden="true" />
        回到 Multivac
      </button>
    </section>
  );
}
