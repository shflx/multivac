import { McpError, mcpCanonical } from './mcp.js';

/** 有界 JSON Schema 子集。未实现的约束拒绝，不能把忽略约束当作参数通过。 */
export function validateMcpArguments(schema: Record<string, unknown>, value: unknown): void {
  if (Buffer.byteLength(mcpCanonical(value)) > 64000 || Buffer.byteLength(mcpCanonical(schema)) > 64000) invalid();
  let schemas = 0;
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'description', 'title', 'default', 'examples', '$schema'];
  function inspect(rule: unknown, depth: number): void {
    if (++schemas > 256 || depth > 16 || !rule || typeof rule !== 'object' || Array.isArray(rule)) invalid();
    const s = rule as Record<string, unknown>;
    if (Object.keys(s).some(key => !supported.includes(key))) invalid();
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'])
      if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) invalid();
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) invalid();
      for (const field of Object.values(s.properties)) inspect(field, depth + 1);
    }
    for (const key of ['anyOf', 'oneOf']) if (s[key] !== undefined) {
      if (!Array.isArray(s[key]) || !(s[key] as unknown[]).length) invalid();
      for (const alternative of s[key] as unknown[]) inspect(alternative, depth + 1);
    }
    if (s.items !== undefined) inspect(s.items, depth + 1);
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') inspect(s.additionalProperties, depth + 1);
  }
  inspect(schema, 0);
  let visited = 0;
  function check(rule: unknown, input: unknown, depth: number): boolean {
    if (++visited > 1024 || depth > 16 || !rule || typeof rule !== 'object' || Array.isArray(rule)) invalid();
    const s = rule as Record<string, unknown>;
    if (Object.keys(s).some(key => !supported.includes(key))) invalid();
    if (s.anyOf !== undefined) { if (!Array.isArray(s.anyOf) || !s.anyOf.some(item => check(item, input, depth + 1))) return false; }
    if (s.oneOf !== undefined) { if (!Array.isArray(s.oneOf) || s.oneOf.filter(item => check(item, input, depth + 1)).length !== 1) return false; }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.some(item => mcpCanonical(item) === mcpCanonical(input)))) return false;
    if (Object.hasOwn(s, 'const') && mcpCanonical(s.const) !== mcpCanonical(input)) return false;
    const actual = input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input;
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type)))) invalid();
      if (!types.includes(actual) && !(types.includes('integer') && typeof input === 'number' && Number.isInteger(input))) return false;
    }
    if (typeof input === 'string') {
      const length = [...input].length;
      if (s.minLength !== undefined && length < Number(s.minLength) || s.maxLength !== undefined && length > Number(s.maxLength)) return false;
    }
    if (typeof input === 'number' && (s.minimum !== undefined && input < Number(s.minimum) || s.maximum !== undefined && input > Number(s.maximum))) return false;
    if (Array.isArray(input)) {
      if (s.minItems !== undefined && input.length < Number(s.minItems) || s.maxItems !== undefined && input.length > Number(s.maxItems)) return false;
      if (s.items !== undefined && !input.every(item => check(s.items, item, depth + 1))) return false;
    }
    if (actual === 'object') {
      const object = input as Record<string, unknown>;
      if (Object.keys(object).length > 128) return false;
      const properties = s.properties ?? {};
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) invalid();
      const props = properties as Record<string, unknown>;
      if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every(key => typeof key === 'string' && Object.hasOwn(object, key)))) return false;
      for (const [key, field] of Object.entries(object)) {
        if (Object.hasOwn(props, key)) { if (!check(props[key], field, depth + 1)) return false; }
        else if (s.additionalProperties === false) return false;
        else if (s.additionalProperties && typeof s.additionalProperties === 'object' && !check(s.additionalProperties, field, depth + 1)) return false;
      }
    }
    return true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !check(schema, value, 0))
    throw new McpError('invalid-config', 'MCP 工具参数不符合当前 Schema。', 400);
}
function invalid(): never { throw new McpError('invalid-config', 'MCP 参数或 Schema 超过支持范围；未执行。', 400); }
