export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStringArray(value: unknown): string[] {
  return asArray(value)
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

/**
 * Repair the two ways model JSON actually breaks in practice:
 *  - raw control characters inside string values (models echoing multi-line
 *    text) — escaped in place;
 *  - output truncated mid-structure by a token cap — cut back to the last
 *    fully-closed value and close the open brackets, so a list that ran out
 *    of budget still yields every complete entry.
 * Returns null when nothing parseable can be recovered.
 */
export function salvageJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const src = text.slice(start);

  // Single scan: escape control chars inside strings, track the bracket
  // stack, and checkpoint every position where a value just closed.
  let out = "";
  const stack: string[] = [];
  const checkpoints: { at: number; closers: string }[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out += ch;
    } else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      out += ch;
      checkpoints.push({ at: out.length, closers: [...stack].reverse().join("") });
    } else {
      out += ch;
    }
  }

  const cleaned = asRecord(safeJsonParse(out));
  if (cleaned) return cleaned;

  // Truncated: rewind to recent checkpoints and close what is still open.
  for (let c = checkpoints.length - 1; c >= 0 && c >= checkpoints.length - 6; c--) {
    const { at, closers } = checkpoints[c];
    const candidate = out.slice(0, at).replace(/,\s*$/, "") + closers;
    const parsed = asRecord(safeJsonParse(candidate));
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Pull a JSON object out of a model reply: strips markdown fences and any
 * prose around the payload by slicing from the first "{" to the last "}",
 * then falls back to salvage for control characters and truncation.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const direct = asRecord(safeJsonParse(text));
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = asRecord(safeJsonParse(text.slice(start, end + 1)));
    if (sliced) return sliced;
  }
  return salvageJson(text);
}
