"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface DayData {
  date: string;
  amount: number;
}

interface TooltipPayload {
  value: number;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-100 rounded-lg px-3 py-2 shadow-sm text-xs">
      <p className="text-slate-400 mb-0.5">{label}</p>
      <p className="font-semibold text-[#0a1220]">
        {new Intl.NumberFormat("en-IE", {
          style: "currency",
          currency: "EUR",
          minimumFractionDigits: 2,
        }).format(payload[0].value)}
      </p>
    </div>
  );
}

export default function SpendingChart({ data }: { data: DayData[] }) {
  const hasAnyAmount = data.some((d) => d.amount > 0);

  return (
    <div className="bg-white rounded-xl border border-slate-100 p-5">
      <p className="text-sm font-medium text-slate-600 mb-4">
        Spending — last 30 days
      </p>
      {hasAnyAmount ? (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00e5b4" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#00e5b4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#f1f5f9"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `€${v}`}
              width={42}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="amount"
              stroke="#00e5b4"
              strokeWidth={2}
              fill="url(#spendGradient)"
              dot={false}
              activeDot={{ r: 4, fill: "#00e5b4", strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div
          className="flex flex-col items-center justify-center text-center px-6"
          style={{ height: 200 }}
        >
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-50 border border-slate-100">
            <svg
              className="h-4 w-4 text-slate-300"
              fill="none"
              viewBox="0 0 16 16"
              stroke="currentColor"
              strokeWidth={1.6}
              aria-hidden="true"
            >
              <path
                d="M2 12l3.5-4 3 2.5L13 4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
            Your spending chart will appear here as your agent makes purchases.
          </p>
        </div>
      )}
    </div>
  );
}
