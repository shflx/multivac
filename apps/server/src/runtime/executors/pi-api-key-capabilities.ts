// Pi 0.85.1 原生 api_key 登录函数没有字段清单。
// Cloudflare 必填 account/gateway，Bedrock/Vertex 先询问认证方式，不能由单 password 表单完成。
const MULTI_STEP_KEY_PROVIDERS = new Set(['cloudflare-workers-ai', 'cloudflare-ai-gateway', 'amazon-bedrock', 'google-vertex']);
export function supportsSingleApiKeyInput(provider: string): boolean { return !MULTI_STEP_KEY_PROVIDERS.has(provider); }
