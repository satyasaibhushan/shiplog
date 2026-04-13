import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { Commit } from "../types.ts";

interface Props {
  commits: Commit[];
}

interface DayData {
  date: string;
  label: string;
  count: number;
}

export function CommitTimeline({ commits }: Props) {
  const data = useMemo(() => computeTimeline(commits), [commits]);

  if (data.length === 0) return null;

  const maxCount = Math.max(...data.map((d) => d.count));

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart
        data={data}
        margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
        barCategoryGap="15%"
      >
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 9, fill: "#525252" }}
          interval="preserveStartEnd"
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 9, fill: "#525252" }}
          allowDecimals={false}
          width={30}
        />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
          contentStyle={{
            background: "#171717",
            border: "1px solid #2e2e2e",
            borderRadius: 8,
            fontSize: 11,
            padding: "6px 10px",
          }}
          labelStyle={{ color: "#a3a3a3", fontSize: 10, marginBottom: 2 }}
          itemStyle={{ color: "#22d3ee", padding: 0 }}
          formatter={(value) => [`${value} commit${value !== 1 ? "s" : ""}`, ""]}
          labelFormatter={(label) => String(label)}
        />
        <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={24}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={
                entry.count === 0
                  ? "transparent"
                  : `rgba(34, 211, 238, ${0.25 + (entry.count / maxCount) * 0.65})`
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function computeTimeline(commits: Commit[]): DayData[] {
  if (commits.length === 0) return [];

  const countByDate = new Map<string, number>();

  for (const c of commits) {
    const date = c.date.split("T")[0] ?? c.date;
    countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
  }

  // Fill gaps between min and max dates
  const dates = [...countByDate.keys()].sort();
  const start = new Date(dates[0]!);
  const end = new Date(dates[dates.length - 1]!);

  const result: DayData[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const iso = cursor.toISOString().split("T")[0]!;
    const label = cursor.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    result.push({
      date: iso,
      label,
      count: countByDate.get(iso) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}
