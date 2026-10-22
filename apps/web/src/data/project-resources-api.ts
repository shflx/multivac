import { Type } from 'typebox';
import {
  ProjectDirectoryListingSchema,
  ProjectResourceListResponseSchema,
  ProjectResourceResponseSchema,
  type CreateProjectResource,
  type ProjectDirectoryListing,
  type ProjectResource,
  type ProjectResourceListResponse,
  type UpdateProjectResource,
} from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const MessageSchema = Type.Object({ message: Type.String() });

function base(projectId: string, resourceId?: string): string {
  const root = `/api/projects/${encodeURIComponent(projectId)}/resources`;
  return resourceId ? `${root}/${encodeURIComponent(resourceId)}` : root;
}

export function listProjectResources(projectId: string, signal?: AbortSignal): Promise<ProjectResourceListResponse> {
  return fetchJson(base(projectId), signal ? { signal } : undefined, ProjectResourceListResponseSchema);
}

export async function createProjectResource(projectId: string, input: CreateProjectResource): Promise<ProjectResource> {
  const result = await fetchJson(base(projectId), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) }, ProjectResourceResponseSchema);
  return result.resource;
}

export async function updateProjectResource(projectId: string, resourceId: string, input: UpdateProjectResource): Promise<ProjectResource> {
  const result = await fetchJson(base(projectId, resourceId), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(input) }, ProjectResourceResponseSchema);
  return result.resource;
}

export async function removeProjectResource(projectId: string, resourceId: string): Promise<void> {
  await fetchJson(base(projectId, resourceId), { method: 'DELETE' }, Type.Object({ removed: Type.Literal(true) }));
}

/** 浏览项目目录：列出 root 下 path 中的条目；带 query 时在整个目录中按文件名搜索。 */
export function browseProjectDirectory(projectId: string, root: string, path: string, query: string, signal?: AbortSignal): Promise<ProjectDirectoryListing> {
  const params = new URLSearchParams({ root, path, query });
  return fetchJson(`/api/projects/${encodeURIComponent(projectId)}/directory-files?${params}`, signal ? { signal } : undefined, ProjectDirectoryListingSchema);
}

/** 用系统默认程序打开，或在 Finder 中显示；只在本机由用户点击触发。 */
export async function openProjectResource(projectId: string, resourceId: string, action: 'open' | 'reveal'): Promise<string> {
  const result = await fetchJson(`${base(projectId, resourceId)}/${action}`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }, MessageSchema);
  return result.message;
}

/** 读取本机文件为 base64，用于“从本机添加文件”。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? '');
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.readAsDataURL(file);
  });
}
