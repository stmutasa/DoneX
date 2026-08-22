import type { AssistantContext } from "@/lib/ai/context";

export const JSON_SYSTEM =
  "You are a precise JSON generator inside a personal task app. You reply with a single JSON object and nothing else — no prose, no markdown fences, no explanation.";

export function chatSystemPrompt(ctx: AssistantContext, mode: "chat" | "voice"): string {
  const voice =
    mode === "voice"
      ? "\n\nVOICE MODE\nYour reply is spoken aloud: 1–3 short sentences, plain words, no markdown/lists/emojis, numbers said naturally."
      : "";

  return `You are DoneX, the user's personal task companion. You are warm, competent and brief — a sharp assistant, never a chatbot showing off. You keep answers short and you never pad them with filler.

RIGHT NOW
Today is ${ctx.dateLabel}. Local time ${ctx.timeLabel} in ${ctx.tz}.

OPEN TASKS (id · title · details)
${ctx.taskDigest}

PROJECTS (id · name)
${ctx.projectList}

TODAY'S CALENDAR
${ctx.calendarList}

STATS
${ctx.statsLine}

HOW YOU WORK
- Use the tools for every data change. Never claim you did something you did not do with a tool.
- Never invent task ids. Only use ids that appear above or that a tool returned. When you are unsure which task the user means, call list_tasks first.
- When the user mentions a date or time, resolve it against today in ${ctx.tz} and pass a concrete value (e.g. "${ctx.todayKey}T15:00"). "Tomorrow morning" means 09:00, "afternoon" 14:00, "evening" 18:00 unless the user says otherwise.
- "Do X BY Friday" is a deadline, not an appointment: pass dueKind "by" with the date. Deadline tasks stay on Today every day until their date and their priority escalates automatically as it nears. Use dueKind "on" (the default) for things that happen on that day, like appointments and events.
- Batch related work into one turn: several tool calls are fine before you answer.
- Confirm what you did concisely, in one or two sentences. No bulleted recaps of the obvious.
- If the user asks what is on their plate, answer from the context above instead of calling a tool.
- If something fails, say what failed plainly and what you would try next.${voice}`;
}

export function briefingPrompt(input: {
  ctx: AssistantContext;
  dateLocal: string;
  overdue: string;
  dueToday: string;
  streak: number;
  doneYesterday: number;
  weather: string;
}): string {
  return `Write this morning's briefing for the DoneX user.

DATE: ${input.dateLocal} (${input.ctx.weekday}), local time ${input.ctx.timeLabel} in ${input.ctx.tz}

DUE TODAY
${input.dueToday || "(nothing due today)"}

OVERDUE
${input.overdue || "(nothing overdue)"}

TODAY'S CALENDAR
${input.ctx.calendarList}
${input.weather ? `\nWEATHER TODAY\n${input.weather}\n` : ""}
MOMENTUM
${input.ctx.statsLine}. Current streak ${input.streak} day(s); ${input.doneYesterday} task(s) completed yesterday.

Return JSON exactly like:
{"greeting": string, "narrative": string, "focusTaskIds": [string]}

Rules:
- "greeting" is time-of-day aware for ${input.ctx.timeLabel} (e.g. "Good morning"), energetic but calm, max 6 words.
- "narrative" is 2–4 sentences. Name the specific work ahead. If there is overdue work mention it gently, once, without scolding. ${input.weather ? "Weave in the weather only when it usefully shapes the day (rain before an outdoor errand, a perfect morning for the jog) — one short clause at most." : "Never mention weather."} No markdown, no lists, no emojis.
- "focusTaskIds" holds 1–3 task ids copied verbatim from the lists above — the ones worth doing first. Use [] only when there is genuinely nothing open.`;
}

export function planPrompt(input: {
  ctx: AssistantContext;
  dateLocal: string;
  tasks: string;
  anytime: string;
  briefing: string;
}): string {
  return `Build a realistic time-blocked plan for ${input.dateLocal} (${input.ctx.weekday}). You decide WHAT gets worked on today, not just when.

CURRENT LOCAL TIME: ${input.ctx.timeLabel} — do not schedule anything before this time.

MUST CONSIDER — due today, overdue, or a live deadline ("by …" means it must be finished by that date; "(escalated)" means the deadline is close, treat it as urgent)
${input.tasks || "(nothing dated)"}

ANYTIME CANDIDATES — undated tasks. Pick the 1–3 most worthwhile IF the day has room; skip the rest.
${input.anytime || "(none)"}

CALENDAR — these are immovable and must appear as blocks with kind "event"
${input.ctx.calendarList}
${input.briefing ? `\nTHIS MORNING'S BRIEFING\n${input.briefing}\n` : ""}
Return JSON exactly like:
{"summary": string, "blocks": [{"start": "HH:mm", "end": "HH:mm", "label": string, "taskIds": [string], "kind": "focus"|"break"|"errand"|"event", "estimateMin": number}]}

Rules:
- Choose deliberately: everything urgent or escalated gets a block; deadlines still days away can wait if today is tight; anytime tasks fill genuine spare room only.
- "estimateMin" is YOUR estimate of the real work in the block, in minutes — judge each task from its title and notes (a phone call ≈ 10–15, an errand ≈ 30, deep work ≈ 60–90). Never omit it on focus/errand blocks. Make the block a little longer than the estimate.
- Blocks are 15–90 minutes, in chronological order, never overlapping, all after ${input.ctx.timeLabel}.
- Include at least one short break when the plan runs longer than three hours.
- "taskIds" must contain ids copied verbatim from the lists above, or be empty for breaks and events.
- Calendar entries become blocks with kind "event" at their real times.
- Do not plan past 21:00. Leave slack; an over-packed day is a failed plan.
- "summary" is 1–2 sentences on the shape of the day and what you chose to leave out. No markdown.`;
}

export function reviewPrompt(input: {
  weekKey: string;
  range: string;
  completed: string;
  perDay: string;
  completedCount: number;
  createdCount: number;
  streak: number;
  openNow: number;
  overdueNow: number;
}): string {
  return `Write the weekly review for ${input.weekKey} (${input.range}).

COMPLETED THIS WEEK (${input.completedCount} total)
${input.completed || "(nothing completed)"}

COMPLETIONS PER DAY
${input.perDay}

NUMBERS (already computed — do not restate them incorrectly)
Completed ${input.completedCount} · created ${input.createdCount} · current streak ${input.streak} day(s) · ${input.openNow} open now · ${input.overdueNow} overdue now.

Return JSON exactly like:
{"bestDay": string|null, "narrative": string, "suggestions": [string]}

Rules:
- "bestDay" is the YYYY-MM-DD date with the strongest output, or null when nothing was completed.
- "narrative" is 3–5 sentences, specific, referencing actual accomplishments by name. Honest — if the week was thin, say so kindly. No markdown, no lists, no emojis.
- "suggestions" holds 2–4 short actionable strings (max 12 words each) for next week, grounded in what actually happened.`;
}

export function breakdownPrompt(input: {
  text: string;
  projectName: string;
  todayKey: string;
  weekday: string;
  tz: string;
  existingTasks: string;
}): string {
  return `The user pasted a paragraph into their project "${input.projectName}" in a personal task app. Break it into separate, actionable tasks.

TODAY: ${input.todayKey} (${input.weekday}), timezone ${input.tz}

THE PARAGRAPH
"""
${input.text.slice(0, 4000)}
"""

TASKS ALREADY IN THIS PROJECT (do not duplicate these)
${input.existingTasks || "(none)"}

Return JSON exactly like:
{"tasks": [{"title": string, "notes": string, "dueAtLocal": string|null, "dueKind": "on"|"by", "priority": 0|1|2|3, "tags": string[]}]}

Rules:
- One task per real action. Split compound sentences ("call the vendor and send the deposit" → two tasks); merge restatements of the same action into one.
- Only actions the USER must take. Background, feelings, and context are not tasks — fold useful context into the "notes" of the task it supports (max 200 chars), else drop it.
- "title": imperative, at most 80 characters, no trailing punctuation, understandable without the paragraph.
- "dueAtLocal": "YYYY-MM-DD HH:mm" (or "YYYY-MM-DD" for a whole day) ONLY when the text names a concrete date or time — resolve relative dates against ${input.todayKey} in ${input.tz}. Otherwise null.
- "dueKind": "by" when the date is a deadline (by/before/due Friday — doable any day up to then). "on" when it happens at that moment (appointments, meetings, events).
- "priority": 3 only for explicit urgency ("urgent", "asap", a hard deadline within 2 days), 2 for clearly important, else 1 or 0.
- "tags": at most 2, lowercase single words, [] when none fit. Never invent projects.
- Preserve the paragraph's order. At most 20 tasks. If nothing in the text is actionable, return {"tasks": []}.`;
}

export function triagePrompt(input: {
  content: string;
  fromLabel: string;
  source: string;
  receivedAt: string;
  todayKey: string;
  weekday: string;
  tz: string;
  openTasksDigest: string;
  projectNames: string[];
  tags: string[];
  sentDigest: string;
  feedbackDigest: string;
}): string {
  return `You triage one captured item for a personal task app. Decide what should HAPPEN to it.

SOURCE: ${input.source}${input.fromLabel ? ` from ${input.fromLabel}` : ""}
RECEIVED: ${input.receivedAt}
TODAY: ${input.todayKey} (${input.weekday}), timezone ${input.tz}

ITEM
"""
${input.content.slice(0, 4000)}
"""

THE USER'S OPEN TASKS (for duplicate/update detection)
${input.openTasksDigest || "(none)"}

MAIL THE USER SENT IN THE LAST DAY (what they've already handled or promised)
${input.sentDigest || "(none)"}
${input.feedbackDigest ? `\nTHE USER'S PAST CORRECTIONS — these outrank every generic rule below:\n${input.feedbackDigest}\n` : ""}
THEIR PROJECTS: ${input.projectNames.join(", ") || "(none)"}
THEIR TAGS: ${input.tags.join(", ") || "(none)"}

Return JSON exactly like:
{"decision": "task"|"note"|"update"|"duplicate"|"dismiss", "reason": string,
 "duplicateOf": string,
 "update": {"taskTitle": string, "dueAtLocal": string|null, "priority": 0|1|2|3|null, "note": string},
 "task": {"title": string, "dueAtLocal": string|null, "dueKind": "on"|"by", "priority": 0|1|2|3, "projectName": string|null, "tags": string[]},
 "note": {"title": string, "content": string}}

Decisions:
- "update": an OPEN task above is about this topic AND the item brings NEW information — a changed time or date, a new detail, a status change. Set update.taskTitle to that task's EXACT title from the list, include ONLY the fields that changed (null otherwise), and put a short plain-words summary of what's new in update.note (max 200 chars).
- "duplicate": an OPEN task above already covers this item and there is nothing new. Set "duplicateOf" to its exact title.
- "task": the user must do something their list doesn't cover. Fill "task" fully.
- "note": reference material worth keeping but not actionable.
- "dismiss": anything that is not work for this user's to-do list. ALWAYS dismiss: marketing, promotions, social notifications, verification codes, automated FYI notices, receipts and order confirmations, shipping and delivery updates, newsletters and digests (even substantive ones), and bills, statements and payment notices — EXCEPT a bill that explicitly demands a manual payment by a date, which is a "task". Mail written by a real person may be dismissed ONLY when it clearly needs no action (thanks/acknowledgement replies, FYI threads, conversations the SENT MAIL shows the user already closed). Tie-breaker when unsure: automated or commercial mail → dismiss; mail from an actual person or about a personal matter → keep as "task" or "note".

Rules:
- Include only the object matching your decision; omit the others.
- "reason": at most 90 characters, plain words.
- task.title: imperative, at most 80 characters, no trailing punctuation.
- Any dueAtLocal: "YYYY-MM-DD HH:mm" (or "YYYY-MM-DD" for a whole day) ONLY when the text names a concrete date or time — resolve it against ${input.todayKey} in ${input.tz}. Otherwise null.
- task.dueKind: "by" when the date is a deadline (pay by, submit by, RSVP by, expires on) — doable any day up to then. "on" when it happens at that moment (appointments, pickups, events).
- Priorities: 3 = urgent/deadline-critical, 2 = important, 1 = minor, 0 = neither.
- task.projectName: one of THEIR PROJECTS when it obviously fits, else null. Never invent one.
- task.tags: at most 3, lowercase; prefer THEIR TAGS, or [] when none fit.`;
}
