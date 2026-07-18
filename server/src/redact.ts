// 服务端脱敏复查:规则与 plugin/agent/core.cjs 的 redact() 保持一致(纵深防御的第二道)。
// 只复查内容片段(first_prompt/summary);project 等字段按 spec §4 原样透传。
export function redact(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs]|AKIA)[-_][A-Za-z0-9]{6,}\b/gi, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[cred]@")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token]");
}

/** 就地复查一条上报记录的内容字段。 */
export function redactRecord(r: { first_prompt?: string; summary?: string }): void {
  if (r.first_prompt) r.first_prompt = redact(r.first_prompt);
  if (r.summary) r.summary = redact(r.summary);
}
