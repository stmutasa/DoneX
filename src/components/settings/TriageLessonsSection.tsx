"use client";

import useSWR from "swr";
import { fetcher, inboxApi } from "@/lib/api";
import type { TriageFeedback } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { IconButton } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { IconX } from "@/components/ui/icons";
import { SettingsCard } from "./common";

/** Every rule the user has taught the inbox triage, with the ability to
 *  unlearn one. Rendered only once at least one lesson exists. */
export function TriageLessonsSection() {
  const toast = useToast();
  const { data, mutate } = useSWR<{ lessons: TriageFeedback[] }>("/api/inbox/feedback", fetcher);
  const lessons = data?.lessons ?? [];

  if (lessons.length === 0) return null;

  const remove = async (lesson: TriageFeedback) => {
    try {
      await inboxApi.removeLesson(lesson.id);
      await mutate();
      toast.success("Lesson forgotten");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove that");
    }
  };

  return (
    <SettingsCard
      id="triage-lessons"
      title="Triage lessons"
      description="Rules you've taught the inbox triage. It follows these over its defaults."
    >
      <ul className="space-y-2">
        {lessons.map((lesson) => (
          <li
            key={lesson.id}
            className="flex items-start gap-2.5 rounded-2xl border border-stroke bg-sunken px-3.5 py-3"
          >
            <span
              className={
                lesson.kind === "should_have_kept"
                  ? "mt-1 inline-block rounded-full bg-ok/12 px-2 py-0.5 text-[11px] font-semibold text-ok"
                  : "mt-1 inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent"
              }
            >
              {lesson.kind === "should_have_kept" ? "KEEP" : "DISMISS"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] leading-snug text-ink">“{lesson.reason}”</span>
              <span className="mt-0.5 line-clamp-1 block text-[12px] text-faint">
                about: {lesson.content} · {relativeTime(lesson.createdAt)}
              </span>
            </span>
            <IconButton label="Forget this lesson" size="sm" onClick={() => remove(lesson)}>
              <IconX className="h-4 w-4" />
            </IconButton>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
