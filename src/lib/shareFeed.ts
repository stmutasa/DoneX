/**
 * A read-only snapshot of what is still on your plate, in a shape another
 * assistant can read: Markdown for a chat window, JSON for anything else.
 *
 * It answers one question — "what do I still need to do?" — so it carries
 * open work only, grouped by when it is wanted rather than by where it
 * lives. Shared tasks join the same buckets, marked, but only the ones that
 * are actually yours to do: the same line the morning digest draws, so a
 * link handed to a chat window never becomes a way around it.
 *
 * Pure: give it tasks and a clock and it returns the same answer every time.
 */
import type { SessionRole, Task } from "@/lib/types";
import { addDaysToDateKey, localDateKey } from "@/lib/utils";

/** How far out "this week" reaches before everything becomes "later". */
const WEEK_DAYS = 7;
/** Notes are context, not the task — enough to be useful, not a wall. */
const NOTES_LIMIT = 400;

export type Bucket = "overdue" | "today" | "week" | "later" | "someday";

export const BUCKET_TITLES: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "Next 7 days",
  later: "Later",
  someday: "No date",
};

export interface FeedTask {
  title: string;
  /** "Mon 14 Sep" · "Today" · null when undated */
  due: string | null;
  dueAt: string | null;
  allDay: boolean;
  priority: number;
  project: string | null;
  tags: string[];
  notes: string;
  /** null for your own list; otherwise who the shared task is for */
  shared: "you" | "either" | null;
}

export interface FeedGroup {
  bucket: Bucket;
  title: string;
  tasks: FeedTask[];
}

export interface ShareFeed {
  generatedAt: string;
  timezone: string;
  owner: string;
  counts: { open: number; overdue: number; today: number };
  groups: FeedGroup[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-09-14" → "Mon 14 Sep". Date-key arithmetic only, so tz-safe. */
export function dateKeyLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[at.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

function bucketOf(dueKey: string | null, todayKey: string): Bucket {
  if (!dueKey) return "someday";
  if (dueKey < todayKey) return "overdue";
  if (dueKey === todayKey) return "today";
  return dueKey <= addDaysToDateKey(todayKey, WEEK_DAYS) ? "week" : "later";
}

function label(dueKey: string | null, todayKey: string): string | null {
  if (!dueKey) return null;
  if (dueKey === todayKey) return "Today";
  if (dueKey === addDaysToDateKey(todayKey, 1)) return "Tomorrow";
  return dateKeyLabel(dueKey);
}

function trim(notes: string): string {
  const clean = (notes ?? "").trim().replace(/\s*\n\s*\n\s*/g, "\n").replace(/\r/g, "");
  return clean.length > NOTES_LIMIT ? `${clean.slice(0, NOTES_LIMIT).trimEnd()}…` : clean;
}

/**
 * Everything still open and actually yours, bucketed by when it's wanted.
 *
 * `joint` is filtered here rather than by the caller so the privacy rule
 * lives with the thing that publishes: tasks the other person has taken on
 * never reach the feed at all.
 */
export function buildFeed(args: {
  tasks: Task[];
  joint: Task[];
  projectNames: Map<string, string>;
  tz: string;
  now: Date;
  owner: string;
  role?: SessionRole;
}): ShareFeed {
  const { tasks, joint, projectNames, tz, now, owner } = args;
  const role: SessionRole = args.role ?? "owner";
  const todayKey = localDateKey(now, tz);

  const open = (t: Task) => t.status !== "done" && !t.parentId;
  const mine = tasks.filter((t) => t.space === "personal" && open(t));
  // Yours and the unclaimed — never the ones they have taken on.
  const ours = joint.filter(
    (t) => open(t) && (t.assignedTo === role || t.assignedTo === null),
  );

  const toFeed = (t: Task, shared: FeedTask["shared"]): FeedTask => {
    const dueKey = t.dueAt ? localDateKey(t.dueAt, tz) : null;
    return {
      title: t.title,
      due: label(dueKey, todayKey),
      dueAt: t.dueAt,
      allDay: t.allDay,
      priority: t.priority,
      project: t.projectId ? (projectNames.get(t.projectId) ?? null) : null,
      tags: t.tags,
      notes: trim(t.notes),
      shared,
    };
  };

  const all = [
    ...mine.map((t) => ({ task: t, feed: toFeed(t, null) })),
    ...ours.map((t) => ({ task: t, feed: toFeed(t, t.assignedTo === null ? "either" : "you") })),
  ];

  const groups: FeedGroup[] = (Object.keys(BUCKET_TITLES) as Bucket[]).map((bucket) => ({
    bucket,
    title: BUCKET_TITLES[bucket],
    tasks: all
      .filter(
        ({ task }) => bucketOf(task.dueAt ? localDateKey(task.dueAt, tz) : null, todayKey) === bucket,
      )
      .sort(
        (a, b) =>
          (a.task.dueAt ?? "9999").localeCompare(b.task.dueAt ?? "9999") ||
          b.task.priority - a.task.priority ||
          a.task.title.localeCompare(b.task.title),
      )
      .map(({ feed }) => feed),
  })).filter((g) => g.tasks.length > 0);

  const count = (bucket: Bucket) =>
    groups.find((g) => g.bucket === bucket)?.tasks.length ?? 0;

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    owner,
    counts: { open: all.length, overdue: count("overdue"), today: count("today") },
    groups,
  };
}

const PRIORITY_WORD: Record<number, string> = { 3: "High", 2: "Medium", 1: "Low" };

/** The same feed as Markdown — what a chat window actually reads. */
export function renderMarkdown(feed: ShareFeed): string {
  const when = `${dateKeyLabel(feed.generatedAt.slice(0, 10))} ${feed.generatedAt.slice(11, 16)} UTC`;
  const out: string[] = [
    `# ${feed.owner ? `${feed.owner}'s` : "My"} open tasks`,
    "",
    `Live from DoneX · read-only · generated ${when} · times below are ${feed.timezone}.`,
    `**${feed.counts.open} open**, ${feed.counts.overdue} overdue, ${feed.counts.today} due today.`,
  ];

  if (feed.groups.length === 0) {
    out.push("", "Nothing open. The list is clear.");
    return `${out.join("\n")}\n`;
  }

  for (const group of feed.groups) {
    out.push("", `## ${group.title} (${group.tasks.length})`, "");
    for (const t of group.tasks) {
      const meta = [
        t.due,
        PRIORITY_WORD[t.priority],
        t.project,
        t.shared === "either" ? "shared — either of us" : t.shared === "you" ? "shared — mine" : null,
        ...t.tags.map((tag) => `#${tag}`),
      ].filter(Boolean);
      out.push(`- **${t.title}**${meta.length ? ` — ${meta.join(" · ")}` : ""}`);
      if (t.notes) {
        for (const line of t.notes.split("\n")) out.push(`  > ${line}`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}
