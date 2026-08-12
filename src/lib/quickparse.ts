/**
 * Natural-language quick-add parser.
 *
 * Pulls `#project`, `@tag`, `!priority` and "every ..." recurrence phrases
 * out of free text, then hands whatever remains to chrono-node for date/time
 * extraction. Whatever is left after all of that becomes the task title.
 */
import * as chrono from "chrono-node";
import { tzOffset } from "@date-fns/tz";
import type { Priority, RecurrenceRule, TaskDraft } from "@/lib/types";
import { clamp, isoFromLocal, localDateKey } from "@/lib/utils";

export interface QuickAddMatch {
  due?: string;
  project?: string;
  tags: string[];
  priority?: string;
  recurrence?: string;
}

export interface QuickAddResult {
  draft: TaskDraft;
  matchedText: QuickAddMatch;
}

const TAG_RE = /@([A-Za-z0-9][\w-]*)/g;
const PROJECT_RE = /#"([^"]+)"|#([A-Za-z0-9][\w-]*)/g;
const PRIORITY_RE = /!(p[123]|high|med(?:ium)?|low)\b/gi;
/** "… by Friday" / "before June 3" / "until Monday" → deadline (dueKind "by") */
const DEADLINE_PREFIX_RE = /(\b(?:due\s+by|by|before|until)\s+)$/i;

const PRIORITY_MAP: Record<string, Priority> = {
  p1: 3,
  p2: 2,
  p3: 1,
  high: 3,
  med: 2,
  medium: 2,
  low: 1,
};

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const WEEKDAY_ALT = Object.keys(WEEKDAY_MAP)
  .sort((a, b) => b.length - a.length)
  .join("|");

const RECUR_SEP = String.raw`(?:\s*,\s*|\s+and\s+|\s*&\s*)`;

const RECUR_MONTHLY_DAY_RE = new RegExp(
  String.raw`\bevery\s+(?:(\d+)\s+)?months?\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b`,
  "i"
);
const RECUR_WEEKDAY_LIST_RE = new RegExp(
  String.raw`\bevery\s+((?:${WEEKDAY_ALT})(?:${RECUR_SEP}(?:${WEEKDAY_ALT}))*)\b`,
  "i"
);
const RECUR_INTERVAL_RE = /\bevery\s+(?:(\d+)\s+)?(day|week|month|year)s?\b/i;

interface RecurrenceMatch {
  rule: RecurrenceRule;
  match: string;
  index: number;
}

function extractRecurrence(text: string): RecurrenceMatch | null {
  let m = RECUR_MONTHLY_DAY_RE.exec(text);
  if (m) {
    const interval = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
    const byMonthDay = clamp(parseInt(m[2], 10), 1, 31);
    return { rule: { freq: "monthly", interval, byMonthDay }, match: m[0], index: m.index };
  }

  m = RECUR_WEEKDAY_LIST_RE.exec(text);
  if (m) {
    const days = [
      ...new Set(
        m[1]
          .toLowerCase()
          .split(/,|and|&/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => WEEKDAY_MAP[s])
          .filter((n): n is number => n !== undefined)
      ),
    ].sort((a, b) => a - b);
    if (days.length) {
      return { rule: { freq: "weekly", byWeekday: days }, match: m[0], index: m.index };
    }
  }

  m = RECUR_INTERVAL_RE.exec(text);
  if (m) {
    const interval = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
    const unit = m[2].toLowerCase();
    const freq: RecurrenceRule["freq"] =
      unit === "day" ? "daily" : unit === "week" ? "weekly" : unit === "month" ? "monthly" : "yearly";
    return { rule: { freq, interval }, match: m[0], index: m.index };
  }

  return null;
}

function cleanTitle(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/^[,\s]+/, "").replace(/[,\s]+$/, "");
  t = t.replace(/,\s*,/g, ",").trim();
  return t;
}

export function parseQuickAdd(input: string, tz: string): QuickAddResult {
  let text = input;
  const matchedText: QuickAddMatch = { tags: [] };

  text = text.replace(TAG_RE, (_m, tag: string) => {
    matchedText.tags.push(tag);
    return " ";
  });

  text = text.replace(PROJECT_RE, (_m, quoted: string | undefined, word: string | undefined) => {
    const name = (quoted ?? word ?? "").trim();
    if (name && matchedText.project === undefined) matchedText.project = name;
    return " ";
  });

  let priority: Priority | undefined;
  text = text.replace(PRIORITY_RE, (_m, token: string) => {
    const norm = token.toLowerCase();
    if (priority === undefined) {
      priority = PRIORITY_MAP[norm];
      matchedText.priority = norm;
    }
    return " ";
  });

  let recurrence: RecurrenceRule | undefined;
  const recur = extractRecurrence(text);
  if (recur) {
    recurrence = recur.rule;
    matchedText.recurrence = recur.match.trim();
    text = text.slice(0, recur.index) + " " + text.slice(recur.index + recur.match.length);
  }

  let dueAt: string | undefined;
  let allDay: boolean | undefined;
  let dueKind: "on" | "by" | undefined;

  const refInstant = new Date();
  const offsetMinutes = tzOffset(tz, refInstant);
  const results = chrono.parse(text, { instant: refInstant, timezone: offsetMinutes }, { forwardDate: true });
  if (results.length) {
    const result = results[0];
    const preceding = text.slice(0, result.index);
    const deadline = DEADLINE_PREFIX_RE.exec(preceding);
    if (deadline || /^(?:by|before|until)\b/i.test(result.text)) dueKind = "by";
    const startIdx = deadline ? result.index - deadline[1].length : result.index;
    matchedText.due = text.slice(startIdx, result.index + result.text.length).trim();
    text = text.slice(0, startIdx) + " " + text.slice(result.index + result.text.length);

    const parsedDate = result.date();
    if (result.start.isCertain("hour")) {
      dueAt = parsedDate.toISOString();
      allDay = false;
    } else {
      const dateKey = localDateKey(parsedDate, tz);
      dueAt = isoFromLocal(dateKey, "00:00", tz);
      allDay = true;
    }
  }

  const title = cleanTitle(text);

  const draft: TaskDraft = { title };
  if (dueAt) draft.dueAt = dueAt;
  if (dueAt && dueKind === "by") draft.dueKind = "by";
  if (allDay !== undefined) draft.allDay = allDay;
  if (priority !== undefined) draft.priority = priority;
  if (matchedText.tags.length) draft.tags = [...matchedText.tags];
  if (recurrence) draft.recurrence = recurrence;

  return { draft, matchedText };
}
