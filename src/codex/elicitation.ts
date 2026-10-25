import type { CodexUserInputAnswer, CodexUserInputRequest } from "./backend.js";

/** A bounded, non-secret subset with lossless JSON types. Unknown schema
 * keywords are rejected, not silently ignored. Native auth stays out of IM. */
export type ElicitationField = {
  type: "string" | "number" | "integer" | "boolean";
  enum?: string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
};
export type McpForm = { request: CodexUserInputRequest; fields: Record<string, ElicitationField>; required: string[] };
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const text = (v: unknown, max = 1200): v is string => typeof v === "string" && !!v.trim() && v.length <= max;

export function parseMcpForm(params: Record<string, unknown>, fallbackTurnId?: string): McpForm | undefined {
  const turnId = params.turnId ?? fallbackTurnId, schema = object(params.requestedSchema), properties = object(schema?.properties);
  if (!["form", "openai/form"].includes(String(params.mode)) || !text(params.threadId) || !text(turnId)
    || !text(params.serverName, 200) || !text(params.message) || !schema || schema.type !== "object" || !properties
    || Object.keys(properties).length < 1 || Object.keys(properties).length > 10
    || Object.keys(schema).some(k => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(k))
    || schema.additionalProperties !== undefined && schema.additionalProperties !== false) return;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(k => typeof k !== "string" || !Object.hasOwn(properties, k))) return;
  const fields: Record<string, ElicitationField> = Object.create(null), questions: CodexUserInputRequest["questions"] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const field = object(raw);
    if (!text(name, 100) || /password|passcode|secret|token|api.?key|credential|verification|\botp\b|密码|验证码|密钥/i.test([name, field?.title, field?.description].join(" "))
      || ["__proto__", "constructor", "prototype"].includes(name) || !field
      || !["string", "number", "integer", "boolean"].includes(String(field.type))
      || Object.keys(field).some(k => !["type", "title", "description", "enum", "minLength", "maxLength", "minimum", "maximum"].includes(k))
      || field.title !== undefined && !text(field.title, 100) || field.description !== undefined && !text(field.description)) return;
    if (field.enum !== undefined && (field.type !== "string" || !Array.isArray(field.enum) || !field.enum.length
      || field.enum.length > 32 || field.enum.some(x => !text(x, 2000)))) return;
    for (const key of ["minLength", "maxLength", "minimum", "maximum"]) if (field[key] !== undefined
      && (typeof field[key] !== "number" || !Number.isFinite(field[key])
        || (key.endsWith("Length") && (field.type !== "string" || !Number.isSafeInteger(field[key]) || Number(field[key]) < 0))
        || (!key.endsWith("Length") && !["number", "integer"].includes(String(field.type))))) return;
    const valueSchema = Object.fromEntries(Object.entries(field).filter(([k]) => !["title", "description"].includes(k))) as ElicitationField;
    if ((valueSchema.minLength ?? 0) > Math.min(valueSchema.maxLength ?? 2000, 2000)
      || (valueSchema.minimum ?? -Infinity) > (valueSchema.maximum ?? Infinity)) return;
    fields[name] = valueSchema;
    const choices = field.type === "boolean" ? ["true", "false"] : field.enum as string[] | undefined;
    questions.push({ id: name, header: String(field.title ?? name),
      question: `${params.serverName}：${params.message}\n\n${field.title ?? name}${required.includes(name) ? "（必填）" : "（可跳过）"}\n${field.description ?? ""}\n类型：${field.type}。${field.type === "string"
        ? `长度：${valueSchema.minLength ?? 0}–${Math.min(valueSchema.maxLength ?? 2000, 2000)} 字符。`
        : field.type !== "boolean" ? `范围：${valueSchema.minimum ?? "不限"} 至 ${valueSchema.maximum ?? "不限"}。` : ""}填写完毕后提交本次表单；跳过必填项将拒绝本次请求。`,
      valueSchema, ...(choices ? { options: choices.map(label => ({ label, description: "" })) } : {}) });
  }
  return { request: { threadId: params.threadId, turnId, itemId: "mcp-form", autoResolutionMs: null, questions }, fields, required: required as string[] };
}

export function elicitationValue(schema: ElicitationField, raw: string): string | number | boolean {
  if (schema.type === "string") {
    if (schema.enum && !schema.enum.includes(raw) || raw.length < (schema.minLength ?? 0) || raw.length > Math.min(schema.maxLength ?? 2000, 2000)) throw new Error("文本不符合表单长度或选项要求");
    return raw;
  }
  if (schema.type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error("请选择 true 或 false");
    return raw === "true";
  }
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value)
    || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error("数字不符合表单类型或范围要求");
  return value;
}

export function mcpFormResponse(form: McpForm, answers: CodexUserInputAnswer): Record<string, unknown> {
  const content: Record<string, unknown> = Object.create(null);
  for (const [name, field] of Object.entries(form.fields)) {
    const raw = answers[name]?.answers[0];
    if (raw === undefined) { if (form.required.includes(name)) return { action: "decline", content: null, _meta: null }; continue; }
    content[name] = elicitationValue(field, raw);
  }
  return { action: "accept", content, _meta: null };
}

export function safeElicitationUrl(params: Record<string, unknown>): string | undefined {
  // Query/fragment URLs may carry a challenge or bearer credential. Never
  // persist or publish them into a group as an ordinary notification.
  if (params.mode !== "url" || typeof params.url !== "string" || params.url.length > 2000) return;
  try { const u = new URL(params.url); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash
    && !/token|secret|callback|challenge|verify|code\//i.test(u.pathname) ? u.href : undefined; } catch { return; }
}
