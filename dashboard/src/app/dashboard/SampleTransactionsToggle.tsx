"use client";

/**
 * Visual-only "Sample transactions" widget shown to users who have a
 * virtual card provisioned but haven't received their first real charge
 * yet. Helps them visualise what the Recent activity table will look
 * like once their agent starts spending.
 *
 * These rows are NOT in the database — they exist purely in this
 * component. Do not wire them to any real data source.
 */

import { useState } from "react";

interface SampleRow {
  service: string;
  description: string;
  amount: string;
  date: string;
}

const SAMPLE_ROWS: SampleRow[] = [
  {
    service: "Vercel",
    description: "Vercel Pro subscription",
    amount: "€20.00",
    date: "Today",
  },
  {
    service: "Modal GPU",
    description: "Modal credits top-up",
    amount: "€50.00",
    date: "Yesterday",
  },
  {
    service: "Amazon",
    description: "AWS infrastructure",
    amount: "€89.00",
    date: "2 days ago",
  },
];

export default function SampleTransactionsToggle() {
  const [shown, setShown] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <div>
          <p className="text-xs font-semibold text-slate-500">
            No transactions yet this month
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Preview what real charges will look like.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          className="text-[11px] font-semibold text-[#00c49a] hover:text-[#00a882] transition-colors"
        >
          {shown ? "Hide examples" : "Show examples"}
        </button>
      </div>

      {shown && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[420px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-5 py-2.5">
                  Service
                </th>
                <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5 hidden sm:table-cell">
                  Description
                </th>
                <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5 hidden md:table-cell">
                  Date
                </th>
                <th className="text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5">
                  Amount
                </th>
                <th className="text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-5 py-2.5">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {SAMPLE_ROWS.map((row, i) => (
                <tr key={i} className="opacity-70">
                  <td className="px-5 py-3.5 font-medium text-[#0a1220]">
                    {row.service}
                  </td>
                  <td className="px-4 py-3.5 text-slate-500 text-xs truncate max-w-[180px] hidden sm:table-cell">
                    {row.description}
                  </td>
                  <td className="px-4 py-3.5 text-slate-400 text-xs hidden md:table-cell">
                    {row.date}
                  </td>
                  <td className="px-4 py-3.5 text-right font-semibold text-[#0a1220]">
                    {row.amount}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-300 inline-block" />
                      Example
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-2.5 bg-slate-50/50 border-t border-slate-100">
            <p className="text-[11px] text-slate-400">
              These are illustrations only — they don&apos;t reflect any real
              charges.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
