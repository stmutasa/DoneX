"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { matchKey, tasksApi, type TaskCreateInput } from "@/lib/api";
import type { Task, TaskPatch } from "@/lib/types";
import { dueLabel } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";

export function useTaskMutations() {
  const { mutate } = useSWRConfig();
  const toast = useToast();

  const revalidate = useCallback(() => {
    void mutate(matchKey("/api/tasks", "/api/stats", "/api/tags", "/api/projects"));
  }, [mutate]);

  const complete = useCallback(
    async (task: Task, done: boolean): Promise<boolean> => {
      try {
        const res = await tasksApi.complete(task.id, done);
        if (done && res.recurred) {
          const next = res.task.dueAt ? dueLabel(res.task.dueAt, res.task.allDay) : "scheduled";
          toast.success(`Next: ${next}`);
        }
        revalidate();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update task");
        return false;
      }
    },
    [revalidate, toast],
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
