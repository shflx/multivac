import type { ReactNode, Ref } from 'react';
import {
  MANAGEMENT_NAV,
  managementGroupLabel,
  type ManagementPageEntry,
  type ManagementPageId,
} from './management-nav.js';

/** 管理导航：按“工作 / 应用 / 设置”分组，只列注册表中已实现的页面。 */
export function ManagementNav({
  current,
  onNavigate,
}: {
  current: ManagementPageId;
  onNavigate: (page: ManagementPageId) => void;
}) {
  return (
    <aside className="management-sidebar" aria-label="管理导航">
      <nav>
        {MANAGEMENT_NAV.map((group) => (
          <div
            key={group.id}
            className="management-nav-group"
            data-group={group.id}
            role="group"
            aria-labelledby={`management-nav-${group.id}`}
          >
            <span id={`management-nav-${group.id}`} className="management-nav-label">{group.label}</span>
            {group.pages.map((page) => {
              const Icon = page.icon;
              const active = page.id === current;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={active ? 'active' : ''}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(page.id)}
                >
                  <Icon aria-hidden="true" />
                  <span>{page.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * 管理页的稳定容器：统一的页头（眉题、标题、说明）。页内不放返回按钮：
 * 离开管理靠 Logo（回首页）、Esc（回到进入前的面板）与 ⌘G 面板跳转。
 * 页面首次打开后保持挂载，切换页面或离开管理只隐藏，不丢失页面内状态。
 */
export function ManagementPageFrame({
  ref,
  page,
  hidden,
  children,
}: {
  ref?: Ref<HTMLElement> | undefined;
  page: ManagementPageEntry;
  hidden: boolean;
  children: ReactNode;
}) {
  const titleId = `${page.id}-page-title`;
  return (
    <main
      ref={ref}
      className="management-page"
      aria-labelledby={titleId}
      tabIndex={-1}
      hidden={hidden}
    >
      <header className="management-page-header">
        <div>
          <span>管理 · {managementGroupLabel(page.group)}</span>
          <h1 id={titleId}>{page.label}</h1>
          <p>{page.description}</p>
        </div>
      </header>

      {children}
    </main>
  );
}
