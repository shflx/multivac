import { useEffect, useState, type ComponentProps } from 'react';
import { SkillsPage } from '../skills/skills-page.js';
import { McpPage } from './mcp-page.js';

/** 两个页签始终保留各自草稿；隐藏页签不向管理页头挂载操作按钮。 */
export function CapabilitiesPage(props: ComponentProps<typeof SkillsPage>) {
  const [tab, setTab] = useState<'mcp' | 'skill'>('mcp');
  const [skillDirty, setSkillDirty] = useState(false), [mcpDirty, setMcpDirty] = useState(false);
  const [skillBusy, setSkillBusy] = useState(false), [mcpBusy, setMcpBusy] = useState(false);
  useEffect(() => props.onDirtyChange(skillDirty || mcpDirty), [skillDirty, mcpDirty, props.onDirtyChange]);
  useEffect(() => props.onBusyChange(skillBusy || mcpBusy), [skillBusy, mcpBusy, props.onBusyChange]);
  return <div className="capabilities-page"><nav className="capability-tabs" aria-label="能力类型"><button type="button" aria-pressed={tab === 'mcp'} disabled={skillBusy || mcpBusy} onClick={() => setTab('mcp')}>服务与工具</button><button type="button" aria-pressed={tab === 'skill'} disabled={skillBusy || mcpBusy} onClick={() => setTab('skill')}>Skill</button></nav>
    <div hidden={tab !== 'mcp'}><McpPage {...props} active={props.active && tab === 'mcp'} onDirtyChange={setMcpDirty} onBusyChange={setMcpBusy} /></div>
    <div hidden={tab !== 'skill'}><SkillsPage {...props} active={props.active && tab === 'skill'} onDirtyChange={setSkillDirty} onBusyChange={setSkillBusy} /></div>
  </div>;
}
