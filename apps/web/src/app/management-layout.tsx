import { createContext, useContext, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { MANAGEMENT_NAV, type ManagementPageEntry, type ManagementPageId } from './management-nav.js';

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

/** 当前管理页页头里主要操作位的挂载点；页头渲染出来之前为 null。 */
const PageActionsSlotContext = createContext<HTMLElement | null>(null);

/**
 * 页头的主要操作位：页面内容在任意位置写 `<ManagementPageActions>`，其中的按钮渲染到本页页头右侧
 * （如“新建项目…”“添加模型”）。按钮的状态与回调仍留在页面组件里，不需要把状态提到外壳。
 */
export function ManagementPageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * 管理页的稳定容器：统一的页头（标题与主要操作位，下方一条分隔线，不放眉题与说明），
 * 正文宽度按注册表里声明的 width 决定。页内不放返回按钮：
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
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  return (
    <main
      ref={ref}
      className="management-page"
      data-page={page.id}
      aria-labelledby={titleId}
      tabIndex={-1}
      hidden={hidden}
    >
      <header className="management-page-header">
        <h1 id={titleId}>{page.label}</h1>
        <div className="management-page-actions" ref={setActionsSlot} />
      </header>

      <div className="management-page-body" data-width={page.width}>
        <PageActionsSlotContext.Provider value={actionsSlot}>{children}</PageActionsSlotContext.Provider>
      </div>
    </main>
  );
}
