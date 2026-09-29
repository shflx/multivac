import type { ReactNode } from 'react';
import { SavedMark, type SavedFlash } from '../../components/saved-mark.js';

/** 模型页里会显示“已保存”的几处：“配置”与“API Key”小节标题旁。 */
export type ModelSavedPart = 'config' | 'key';

/** 详情里带小节标题的一节（配置、API Key、连接检查共用）：标题旁可放“已保存”。 */
export function ModelSection({
  title,
  saved,
  target,
  className,
  children,
}: {
  title: string;
  saved?: SavedFlash<ModelSavedPart>;
  target?: ModelSavedPart;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`detail-section model-section${className ? ` ${className}` : ''}`}>
      <div className="section-title">
        <h3>{title}</h3>
        {saved && target && <SavedMark saved={saved} target={target} />}
      </div>
      {children}
    </section>
  );
}
