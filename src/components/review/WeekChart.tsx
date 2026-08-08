"use client";

import { format } from "date-fns";
import { keyToDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const BAND = 46;
const BAR_W = 20;
const TOP = 26;
const BASE = 104;
const LABEL_Y = 124;
const PLOT = BASE - TOP;

interface Day {
  dateLocal: string;
  done: number;
}

/** Rounded data-end at the top, square on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h);
  const bottom = y + h;
  return [
    `M${x} ${bottom}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `L${x + w - r} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `L${x + w} ${bottom}`,
    "Z",
  ].join(" ");
}

export function WeekChart({ week, className }: { week: Day[]; className?: string }) {
  const days = week.slice(-7);
  if (!days.length) return null;

  const max = Math.max(1, ...days.map((d) => d.done));
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const width = days.length * BAND;

  return (
    <figure className={cn("m-0", className)}>
      <svg
        viewBox={`0 0 ${width} 136`}
        width="100%"
        height="136"
        role="img"
        aria-label={`Tasks completed each day: ${days
          .map((d) => `${format(keyToDate(d.dateLocal), "EEEE")} ${d.done}`)
          .join(", ")}`}
        className="block overflow-visible"
      >
        {days.map((day, i) => {
          const x = i * BAND + (BAND - BAR_W) / 2;
          const h = day.done > 0 ? Math.max(4, (day.done / max) * PLOT) : 0;
          const y = BASE - h;
          const isToday = day.dateLocal === todayKey;
          const date = keyToDate(day.dateLocal);

          return (
            <g key={day.dateLocal}>
              <title>{`${format(date, "EEEE")}: ${day.done} done`}</title>

              <rect
                x={x}
                y={TOP}
                width={BAR_W}
                height={PLOT}
                rx={4}
                fill="var(--bg-sunken)"
              />

              {h > 0 ? (
                <path d={barPath(x, y, BAR_W, h)} fill="var(--accent)" />
              ) : null}

              {day.done > 0 ? (
                <text
                  x={x + BAR_W / 2}
                  y={y - 8}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="11"
                  fontWeight="500"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {day.done}
                </text>
              ) : null}

              {isToday ? (
                <rect
                  x={x + BAR_W / 2 - 13}
                  y={LABEL_Y - 11}
                  width={26}
                  height={16}
                  rx={8}
                  fill="var(--accent-soft)"
                />
              ) : null}
              <text
                x={x + BAR_W / 2}
                y={LABEL_Y}
                textAnchor="middle"
                fill={isToday ? "var(--text)" : "var(--text-faint)"}
                fontSize="11"
                fontWeight={isToday ? 600 : 400}
              >
                {format(date, "EEEEE")}
              </text>
            </g>
          );
        })}

        <line x1="0" y1={BASE} x2={width} y2={BASE} stroke="var(--border)" strokeWidth="1" />
      </svg>

      <figcaption className="sr-only">
        <table>
          <caption>Tasks completed per day this week</caption>
          <tbody>
            {days.map((d) => (
              <tr key={d.dateLocal}>
                <th scope="row">{format(keyToDate(d.dateLocal), "EEEE")}</th>
                <td>{d.done}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
