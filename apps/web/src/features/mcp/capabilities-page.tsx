import { WebSettingsPanel } from '../web-access/web-settings-panel.js';
import { useEffect, useState, type ComponentProps } from 'react';
import { Globe, Layers, Plug } from 'lucide-react';
import { SkillsPage } from '../skills/skills-page.js';
import { McpPage } from './mcp-page.js';

/** 各个页签始终保留各自草稿；隐藏页签不向管理页头挂载操作按钮。 */
export function CapabilitiesPage(props: ComponentProps<typeof SkillsPage>) {
  const [tab, setTab] = useState<'mcp' | 'skill' | 'web'>('mcp');
  const [webDirty, setWebDirty] = useState(false), [webBusy, setWebBusy] = useState(false);
  const [skillDirty, setSkillDirty] = useState(false), [mcpDirty, setMcpDirty] = useState(false);
  const [skillBusy, setSkillBusy] = useState(false), [mcpBusy, setMcpBusy] = useState(false);
  useEffect(() => props.onDirtyChange(skillDirty || mcpDirty || webDirty), [skillDirty, mcpDirty, webDirty, props.onDirtyChange]);
  useEffect(() => props.onBusyChange(skillBusy || mcpBusy || webBusy), [skillBusy, mcpBusy, webBusy, props.onBusyChange]);
  const busy = skillBusy || mcpBusy || webBusy;
  // 页签沿用应用的分段控件，与页内列表 + 详情布局左对齐。
  return <div className="capabilities-page"><nav className="segmented capability-tabs" aria-label="能力类型">
    <button type="button" className={tab === 'mcp' ? 'active' : ''} aria-pressed={tab === 'mcp'} disabled={busy} onClick={() => setTab('mcp')}><Plug aria-hidden="true" />服务与工具</button>
    <button type="button" className={tab === 'skill' ? 'active' : ''} aria-pressed={tab === 'skill'} disabled={busy} onClick={() => setTab('skill')}><Layers aria-hidden="true" />Skill</button>
    <button type="button" className={tab === 'web' ? 'active' : ''} aria-pressed={tab === 'web'} disabled={busy} onClick={() => setTab('web')}><Globe aria-hidden="true" />网页</button>
  </nav>
    <div hidden={tab !== 'web'}><WebSettingsPanel {...props} active={props.active && tab === 'web'} onDirtyChange={setWebDirty} onBusyChange={setWebBusy} /></div>
    <div hidden={tab !== 'mcp'}><McpPage {...props} active={props.active && tab === 'mcp'} onDirtyChange={setMcpDirty} onBusyChange={setMcpBusy} /></div>
    <div hidden={tab !== 'skill'}><SkillsPage {...props} active={props.active && tab === 'skill'} onDirtyChange={setSkillDirty} onBusyChange={setSkillBusy} /></div>
  </div>;
}
