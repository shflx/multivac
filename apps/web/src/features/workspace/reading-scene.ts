import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const Path = Type.String({ maxLength: 4096, pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000]*$' });
const PositionSchema = Type.Object({
  path: Type.Union([Path, Type.Null()]), scrollTop: Type.Number({ minimum: 0, maximum: 100000000 }), scrollLeft: Type.Number({ minimum: 0, maximum: 100000000 }),
  positioned: Type.Boolean(), query: Type.String({ maxLength: 200 }), findOpen: Type.Boolean(),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), section: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
export type ReadingPosition = Static<typeof PositionSchema>;
const SceneSchema = Type.Object({
  version: Type.Literal(1), root: Type.String(), position: PositionSchema, hidden: Type.Boolean(),
  view: Type.Union([Type.Literal('auto'), Type.Literal('original'), Type.Literal('discussion')]),
  directoryOpen: Type.Boolean(), expandedDirs: Type.Array(Path, { maxItems: 200 }), search: Type.String({ maxLength: 200 }), chooser: Type.Boolean(),
  recent: Type.Array(Path, { maxItems: 20 }), history: Type.Array(PositionSchema, { maxItems: 40 }), future: Type.Array(PositionSchema, { maxItems: 40 }),
  notice: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
export type ReadingScene = Static<typeof SceneSchema>;

export function emptyReading(root: string): ReadingScene {
  return { version: 1, root, position: { path: null, scrollTop: 0, scrollLeft: 0, positioned: false, query: '', findOpen: false }, hidden: true, view: 'auto', directoryOpen: true, expandedDirs: [], search: '', chooser: true, recent: [], history: [], future: [] };
}

export function readingStorageKey(workspaceId: string, sessionId: string): string {
  return `multivac.reading.v1:${JSON.stringify([workspaceId, sessionId])}`;
}

export function restoreReading(raw: string | null, root: string): ReadingScene {
  try {
    if (!raw || raw.length > 1024 * 1024) return emptyReading(root);
    const value: unknown = JSON.parse(raw);
    if (!Check(SceneSchema, value)) return emptyReading(root);
    return value.root === root ? value : { ...emptyReading(root), notice: '工作目录已变化，旧阅读位置已重置，请重新选择文件。' };
  } catch { return emptyReading(root); }
}

/** 导航只替换位置，目录偏好与最近文件不会随历史回滚。 */
export function openReading(scene: ReadingScene, path: string, target: { line?: number; section?: string } = {}): ReadingScene {
  if (scene.position.path === path && !target.line && !target.section) return { ...scene, hidden: false, chooser: false };
  return { ...scene, hidden: false, chooser: false,
    position: { path, scrollTop: 0, scrollLeft: 0, positioned: false, query: '', findOpen: false, ...target },
    recent: [path, ...scene.recent.filter((item) => item !== path)].slice(0, 20),
    history: scene.position.path ? [...scene.history, scene.position].slice(-40) : scene.history, future: [],
  };
}

export function navigateReading(scene: ReadingScene, direction: 'previous' | 'forward'): ReadingScene {
  if (direction === 'previous') {
    const position = scene.history.at(-1);
    return position ? { ...scene, position, chooser: false, history: scene.history.slice(0, -1), future: [scene.position, ...scene.future].slice(0, 40) } : scene;
  }
  const position = scene.future[0];
  return position ? { ...scene, position, chooser: false, history: [...scene.history, scene.position].slice(-40), future: scene.future.slice(1) } : scene;
}
