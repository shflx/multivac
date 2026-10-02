import type { ArtifactVersion } from '@multivac/contracts';
export interface ArtifactRepository {
  get(versionId: string): ArtifactVersion | null;
  list(taskId: string): ArtifactVersion[];
  save(version: ArtifactVersion): void;
}
