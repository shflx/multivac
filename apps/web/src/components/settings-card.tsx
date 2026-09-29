import { useId, type ReactNode } from 'react';

interface SettingsCardProps {
  title?: string;
  /** 卡片说明：写这组设置的作用范围与共同规则。 */
  description?: ReactNode;
  children: ReactNode;
}

/**
 * 设置卡片（按原型 SettingsCard）：白底描边卡片，可选标题与说明，里面一般是若干 SettingsRow。
 * 有标题时卡片以标题命名，读屏可按区域跳转。
 */
export function SettingsCard({ title, description, children }: SettingsCardProps) {
  const titleId = useId();
  return (
    <section className="settings-card" aria-labelledby={title ? titleId : undefined}>
      {(title || description) && (
        <header>
          {title && <h2 id={titleId}>{title}</h2>}
          {description && <p>{description}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

interface SettingsRowProps {
  label: ReactNode;
  hint?: ReactNode;
  /** 名称与说明的 id：控件经 aria-labelledby / aria-describedby 引用它们。 */
  labelId?: string;
  hintId?: string;
  /** 保存失败等原因：写在这一行下方（role="alert"）；控件可经 errorId 用 aria-describedby 关联。 */
  error?: string;
  errorId?: string;
  /** 右侧控件区；“已保存”标记（SavedMark）放在控件前面，与原型一致显示在控件左侧。 */
  children: ReactNode;
}

/**
 * 设置行（按原型 SettingsRow）：左边是名称与说明，右边是控件；宽度不够时控件折到说明下方。
 */
export function SettingsRow({ label, hint, labelId, hintId, error, errorId, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <strong id={labelId}>{label}</strong>
        {hint && <small id={hintId}>{hint}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
      {error && (
        <p className="form-error settings-row-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
