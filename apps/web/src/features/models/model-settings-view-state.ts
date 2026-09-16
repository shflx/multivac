import type { ModelAccessSnapshot, ModelSettingsSnapshot } from '@multivac/contracts';

export function normalizeAccessSnapshot(snapshot: ModelAccessSnapshot, now = Date.now()): ModelAccessSnapshot {
  let changed = false;
  const checks = snapshot.checks.map((check) => {
    if (check.status !== 'expired' && check.status !== 'invalidated' && check.expiresAt !== null &&
      Date.parse(check.expiresAt) <= now) { changed = true; return { ...check, status: 'expired' as const }; }
    return check;
  });
  return changed ? { ...snapshot, checks } : snapshot;
}

export function admitAccessSnapshot(current: ModelAccessSnapshot | null, next: ModelAccessSnapshot, now = Date.now()): ModelAccessSnapshot {
  current = current && normalizeAccessSnapshot(current, now);
  next = normalizeAccessSnapshot(next, now);
  if (current && (current.revision > next.revision || current.accessRevision > next.accessRevision ||
    current.credentialRevision > next.credentialRevision)) return current;
  if (current && current.revision === next.revision && current.accessRevision === next.accessRevision &&
    current.credentialRevision === next.credentialRevision) {
    const previous = current;
    const checks = next.checks.map((check) => previous.checks.find((old) => old.checkId === check.checkId &&
      old.profileId === check.profileId && old.status === 'expired') ?? check);
    if (checks.some((check, index) => check !== next.checks[index])) return { ...next, checks };
  }
  return next;
}

/** 没有凭据版本的模型回执只提供配置；认证始终由完整 access 快照提供。 */
export function mergeModelSettings(current: ModelSettingsSnapshot | null, next: ModelSettingsSnapshot,
  access: ModelAccessSnapshot | null): ModelSettingsSnapshot {
  const config = current && current.revision > next.revision ? current : next;
  if (!access) return config;
  return { ...config, availability: access.revision === config.revision ? access.availability : config.profiles.map((profile) => ({
    profileId: profile.profileId, authenticated: false, available: false, authenticationType: null,
    reason: 'RUNTIME_ERROR' as const, message: '认证状态待刷新。',
  })) };
}
