import { Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  PROJECT_NAME_MAX_LENGTH,
  type CreateProjectResponse,
  type ProjectDirectory,
} from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { createProject, previewProject } from '../../data/workspace-api.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { NEW_PROJECT_CARD, PROJECT_EXECUTION_NOTE, ProjectDirectoryRule } from './project-card-fields.js';
import { createProjectInput } from './project-directories.js';

/** 输入停下来多久后向服务端核对名称与目录。 */
const PREVIEW_DELAY_MS = 250;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 核对状态：对应哪一份输入、结果是将使用的目录还是拒绝原因。 */
type PreviewState =
  | { key: string; status: 'checking' }
  | { key: string; status: 'ok'; directory: ProjectDirectory }
  | { key: string; status: 'invalid'; reason: string };

interface NewProjectCardProps {
  /** 新建成功：同名工作区已写回共享的工作区列表。 */
  onCreated: (created: CreateProjectResponse) => void;
  onCancel: () => void;
  /** 打开卡片的元素随之消失（如切换菜单已收起）时，关闭后焦点的去处。 */
  fallbackFocus?: () => HTMLElement | null | undefined;
}

/**
 * 新建项目的确认卡：“新建项目…”的各个入口共用这一张；Multivac 在对话中提出新建项目时，
 * 对话里的确认卡用同样的内容（`project-card-fields.tsx`），只是名称与目录由提议给出、不能在卡上修改。
 *
 * 填写名称与目录（浏览器中输入已有目录的路径；不填则创建托管目录），卡上写明将使用的目录、类型与执行规则，
 * 确认后才创建。名称与目录在输入时交给服务端核对（与新建同一套规则），非法时原因显示在卡上、不能确认；
 * 创建时服务端再校验一次，失败原因同样留在卡上。
 */
export function NewProjectCard({ onCreated, onCancel, fallbackFocus }: NewProjectCardProps) {
  const { upsert } = useWorkspaces();
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = createProjectInput(name, directory);
  const key = JSON.stringify(input);
  const current = preview?.key === key ? preview : null;

  // 名称填写后才核对（托管目录的路径取决于名称）；只采用与当前输入一致的结果。
  // 输入变化后，上一次创建失败的原因不再适用。
  useEffect(() => {
    setError('');
    if (!input.name) return;
    const controller = new AbortController();
    setPreview({ key, status: 'checking' });
    const timer = window.setTimeout(() => {
      previewProject(input, controller.signal).then(
        (result) => setPreview({ key, status: 'ok', directory: result.directory }),
        (cause: unknown) => {
          if (!controller.signal.aborted) setPreview({ key, status: 'invalid', reason: errorText(cause, '无法核对这个目录，请重试。') });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // key 已涵盖输入的全部内容。
  }, [key]);

  async function submit(): Promise<void> {
    setError('');
    setBusy(true);
    try {
      const created = await createProject(input);
      upsert(created.workspace);
      onCreated(created);
    } catch (cause) {
      setError(errorText(cause, '新建项目没有完成，请重试。'));
      setBusy(false);
    }
  }

  // 卡上展示的目录：核对通过后用服务端给出的路径；之前按输入给出类型。
  const shown: { kind: ProjectDirectory['kind']; path: string | null } = current?.status === 'ok'
    ? current.directory
    : { kind: input.directory ? 'mounted' : 'managed', path: input.directory ?? null };

  return (
    <ConfirmCard
      title={NEW_PROJECT_CARD.title}
      description={NEW_PROJECT_CARD.description}
      icon={Folder}
      confirmLabel={NEW_PROJECT_CARD.confirmLabel}
      confirmDisabled={!input.name || current?.status !== 'ok'}
      busy={busy}
      error={error || (current?.status === 'invalid' ? current.reason : '')}
      {...(fallbackFocus ? { fallbackFocus } : {})}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <dl className="confirm-card-fields">
        <div>
          <dt>名称</dt>
          <dd>
            <input
              autoFocus
              aria-label="项目名称"
              value={name}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              placeholder="例如：读书笔记"
              onChange={(event) => setName(event.target.value)}
            />
          </dd>
        </div>
        <div>
          <dt>目录</dt>
          <dd>
            <input
              aria-label="项目目录"
              value={directory}
              placeholder="输入已有目录的绝对路径，如 ~/code/notes；不填则创建托管目录"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setDirectory(event.target.value)}
            />
            <ProjectDirectoryRule
              kind={shown.kind}
              path={shown.path}
              checking={current?.status === 'checking'}
              placeholder="填写名称后给出路径（工作文件根目录的 projects/ 下）"
              live
            />
          </dd>
        </div>
        <div>
          <dt>执行</dt>
          <dd>{PROJECT_EXECUTION_NOTE}</dd>
        </div>
      </dl>
    </ConfirmCard>
  );
}
