import { useEffect, useState } from 'react';
import { ArtifactContentSchema, type ArtifactVersion } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { MarkdownBody } from '../assistant/markdown-body.js';

export function ArtifactPreview({ versionId }: { versionId: string }) {
  const [value, setValue] = useState<{ version: ArtifactVersion; content: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setValue(null); setError('');
    void fetchJson<{ version: ArtifactVersion; content: string }>(`/api/artifacts/${encodeURIComponent(versionId)}`, undefined, ArtifactContentSchema).then((result) => { if (active) setValue(result); }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : '成果未读取。'); });
    return () => { active = false; };
  }, [versionId]);
  if (error) return <p role="alert" className="proposal-error">{error}</p>;
  if (!value) return <p className="muted">正在读取成果…</p>;
  return <div className="task-artifact-preview"><div className="task-artifact-meta"><strong>{value.version.title}</strong><span>版本 {value.version.version} · {value.version.size} 字节</span></div><ul className="task-artifact-checks">{value.version.checks.map((check) => <li key={check.name} className={check.passed ? 'success' : 'danger'}>{check.name}：{check.passed ? '通过' : '未通过'}</li>)}</ul><MarkdownBody identity={`artifact:${versionId}`} text={value.content} /></div>;
}
