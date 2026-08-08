"use client";

import type { RecurrenceRule } from "@/lib/types";
import { WEEKDAY_INITIALS, WEEKDAY_NAMES, describeRecurrence } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/Segmented";
import { FieldLabel } from "@/components/ui/Field";
import { IconMinus, IconPlusSmall } from "./stepper-icons";

type Freq = RecurrenceRule["freq"] | "none";

const UNIT: Record<RecurrenceRule["freq"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

export function RecurrenceBuilder({
  value,
  onChange,
}: {
  value: RecurrenceRule | null;
  onChange: (next: RecurrenceRule | null) => void;
}) {
  const freq: Freq = value?.freq ?? "none";
  const interval = Math.max(1, value?.interval ?? 1);

  const setFreq = (next: Freq) => {
    if (next === "none") {
      onChange(null);
      return;
    }
    const base: RecurrenceRule = { freq: next, interval };
    if (next === "weekly") base.byWeekday = value?.byWeekday?.length ? value.byWeekday : [new Date().getDay()];
    if (next === "monthly") base.byMonthDay = value?.byMonthDay ?? new Date().getDate();
    onChange(base);
  };

  const patch = (p: Partial<RecurrenceRule>) => {
    if (!value) return;
    onChange({ ...value, ...p });
  };

  const toggleWeekday = (day: number) => {
    if (!value) return;
    const current = value.byWeekday ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    patch({ byWeekday: next.length ? next.sort((a, b) => a - b) : [day] });
  };

  return (
    <div>
      <FieldLabel>Repeat</FieldLabel>
      <Segmented
        size="sm"
        ariaLabel="Repeat frequency"
        value={freq}
        onChange={setFreq}
        options={[
          { value: "none", label: "None" },
          { value: "daily", label: "Daily" },
          { value: "weekly", label: "Weekly" },
          { value: "monthly", label: "Monthly" },
          { value: "yearly", label: "Yearly" },
        ]}
      />

      {value ? (
        <div className="mt-3 space-y-3 rounded-2xl border border-stroke bg-sunken p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] text-muted">Every</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Decrease interval"
                onClick={() => patch({ interval: Math.max(1, interval - 1) })}
                className="grid h-9 w-9 place-items-center rounded-xl border border-stroke bg-elev text-muted active:scale-95"
              >
                <IconMinus />
              </button>
              <span className="w-14 text-center text-[15px] font-medium tabular-nums text-ink">
                {interval} {UNIT[value.freq]}
                {interval > 1 ? "s" : ""}
              </span>
              <button
                type="button"
                aria-label="Increase interval"
                onClick={() => patch({ interval: Math.min(60, interval + 1) })}
                className="grid h-9 w-9 place-items-center rounded-xl border border-stroke bg-elev text-muted active:scale-95"
              >
                <IconPlusSmall />
              </button>
            </div>
          </div>

          {value.freq === "weekly" ? (
            <div className="flex justify-between gap-1">
              {WEEKDAY_INITIALS.map((initial, day) => {
                const on = (value.byWeekday ?? []).includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={WEEKDAY_NAMES[day]}
                    aria-pressed={on}
                    onClick={() => toggleWeekday(day)}
                    className={cn(
                      "h-10 flex-1 rounded-xl border text-[13px] font-medium transition-colors",
                      on
                        ? "border-transparent bg-sunrise text-on-accent"
                        : "border-stroke bg-elev text-muted",
                    )}
                  >
                    {initial}
                  </button>
                );
              })}
            </div>
          ) : null}

          {value.freq === "monthly" ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] text-muted">Day of month</span>
              <input
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                value={value.byMonthDay ?? 1}
                onChange={(e) =>
                  patch({ byMonthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })
                }
                className="h-10 w-20 rounded-xl border border-stroke bg-elev px-3 text-center text-[15px] tabular-nums text-ink outline-none"
              />
            </div>
          ) : null}

          <p className="text-[13px] text-accent">{describeRecurrence(value)}</p>
        </div>
      ) : null}
    </div>
  );
}
