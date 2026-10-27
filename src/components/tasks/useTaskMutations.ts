"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { matchKey, tasksApi, type TaskCreateInput } from "@/lib/api";
import type { Task, TaskPatch } from "@/lib/types";
import { dueLabel } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";

type CompleteResult = Awaited<ReturnType<typeof tasksApi.complete>>;

/** How long a tick waits for the lists to refetch before letting go anyway. */
const REFETCH_WAIT_MS = 5000;

export function useTaskMutations() {
  const { mutate } = useSWRConfig();
  const toast = useToast();

  const refetch = useCallback(
    () =>
      mutate(matchKey("/api/tasks", "/api/stats", "/api/tags", "/api/projects")).then(
        () => undefined,
        () => undefined,
      ),
    [mutate],
  );

  const revalidate = useCallback(() => {
    void refetch();
  }, [refetch]);

  const complete = useCallback(
    async (
      task: Task,
      done: boolean,
      /** Sees the server's answer, e.g. that a repeating task moved on and stays open. */
      onResult?: (res: CompleteResult) => void,
    ): Promise<boolean> => {
      let res: CompleteResult;
      try {
        // The due the row showed: if the task has moved on since (an earlier
        // tap, another device), the server refuses rather than skip a repeat.
        res = await tasksApi.complete(task.id, done, task.dueAt);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update task");
        return false;
      }
      // A refused tick (changed=false) gets no toast; the refetch shows it as it is.
      if (res.changed && done && res.recurred) {
        const next = res.task.dueAt ? dueLabel(res.task.dueAt, res.task.allDay) : "scheduled";
        toast.success(`Next: ${next}`);
      }
      // Resolve only once the lists hold the new state, so the row can't be
      // tapped again while it still shows the old due.
      await Promise.race([
        refetch(),
        new Promise<void>((resolve) => window.setTimeout(resolve, REFETCH_WAIT_MS)),
      ]);
      onResult?.(res);
      return true;
    },
    [refetch, toast],
  );

  const save = useCallback(
    async (id: string, patch: TaskPatch): Promise<Task | null> => {
      try {
        const { task } = await tasksApi.update(id, patch);
        revalidate();
        return task;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save task");
        return null;
      }
    },
    [revalidate, toast],
  );

  const create = useCallback(
    async (input: TaskCreateInput): Promise<Task | null> => {
      try {
        const { task } = await tasksApi.create(input);
        revalidate();
        return task;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not add task");
        return null;
      }
    },
    [revalidate, toast],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await tasksApi.remove(id);
        revalidate();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete task");
        return false;
      }
    },
    [revalidate, toast],
  );

  return { complete, save, create, remove, revalidate };
}
