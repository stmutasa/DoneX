"use client";

import { useEffect, useState } from "react";
import { projectsApi } from "@/lib/api";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FieldLabel, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import {
  DEFAULT_PROJECT_COLOR,
  DEFAULT_PROJECT_ICON,
  PROJECT_COLORS,
  PROJECT_ICONS,
} from "./projectMeta";

export function ProjectSheet({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  onSaved?: (project: Project) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>(DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setIcon(project?.icon || DEFAULT_PROJECT_ICON);
    setColor(project?.color || DEFAULT_PROJECT_COLOR);
  }, [open, project]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the project a name");
      return;
    }
    setSaving(true);
    try {
      const res = project
        ? await projectsApi.update(project.id, { name: trimmed, icon, color })
        : await projectsApi.create({ name: trimmed, icon, color });
      onSaved?.(res.project);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save project");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={project ? "Edit project" : "New project"}
      footer={
        <div className="flex gap-2">
          <Button block onClick={onClose}>
            Cancel
          </Button>
          <Button block variant="primary" loading={saving} onClick={submit}>
            {project ? "Save" : "Create"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 pt-1">
        <Input
          label="Name"
          value={name}
          autoFocus
          placeholder="Home, Work, Reading…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <div>
          <FieldLabel>Icon</FieldLabel>
          <div className="grid grid-cols-8 gap-1.5">
            {PROJECT_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Icon ${emoji}`}
                onClick={() => setIcon(emoji)}
                className={cn(
                  "grid h-11 place-items-center rounded-xl border text-lg transition-colors",
                  icon === emoji ? "border-accent bg-accent-soft" : "border-stroke bg-sunken",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel>Colour</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {PROJECT_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`Colour ${hex}`}
                onClick={() => setColor(hex)}
                className={cn(
                  "h-9 w-9 rounded-full border-2 border-transparent transition-transform active:scale-95",
                  color === hex && "ring-2 ring-accent ring-offset-2 ring-offset-elev",
                )}
                style={{ background: hex }}
              />
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
