export const DEFAULT_MULTIVAC_PORT = 4317;

export function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveServerPort(value: string | undefined): number {
  return Number.parseInt(optionalEnvironmentValue(value) ?? String(DEFAULT_MULTIVAC_PORT), 10);
}
