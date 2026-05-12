"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // Middleware will handle the redirect on the next request, but pushing
    // here gives an instant response without waiting for a full reload.
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-[#070d18] text-white">
      <div className="grid min-h-screen lg:grid-cols-[1fr_440px]">
        <section className="hidden lg:flex flex-col justify-between border-r border-white/8 px-12 py-10">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00e5b4] text-sm font-black text-[#070d18]">
              S
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight">Spendex</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                Agent finance
              </p>
            </div>
          </div>

          <div className="max-w-xl">
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#00e5b4]">
              Control plane
            </p>
            <h1 className="max-w-lg text-5xl font-semibold leading-[1.04] tracking-[-0.04em]">
              Keep agent payments inside a governed workspace.
            </h1>
            <p className="mt-5 max-w-md text-sm leading-6 text-white/48">
              Manage funding, virtual cards, approval requests, service
              accounts, and audit history from one private dashboard.
            </p>
          </div>

          <div className="grid max-w-lg grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/8 bg-white/8 text-xs">
            {["Consent", "Rules", "Audit"].map((label) => (
              <div key={label} className="bg-[#0a1220] px-4 py-3">
                <p className="font-medium text-white/82">{label}</p>
                <p className="mt-1 text-[11px] text-white/32">Enforced live</p>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center px-5 py-10">
          <div className="w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <span className="text-xl font-semibold tracking-tight">
                Spendex
              </span>
              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/35">
                Agent finance
              </p>
            </div>

            <div className="mb-7">
              <h2 className="text-2xl font-semibold tracking-tight">
                Sign in
              </h2>
              <p className="mt-2 text-sm text-white/42">
                Access your agent payment workspace.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-xs font-medium text-white/52"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-sm text-white placeholder-white/30 transition-colors focus:border-[#00e5b4]/70 focus:outline-none focus:ring-2 focus:ring-[#00e5b4]/20"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-xs font-medium text-white/52"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-sm text-white placeholder-white/22 transition-colors focus:border-[#00e5b4]/70 focus:outline-none focus:ring-2 focus:ring-[#00e5b4]/20"
                  placeholder="Password"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-[#00e5b4] px-4 py-2.5 text-sm font-semibold text-[#070d18] transition-colors hover:bg-[#00c49a] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>
            </form>

            <p className="mt-6 text-xs text-white/30">
              Need access?{" "}
              <a
                href="mailto:support@spendexai.com"
                className="text-[#00e5b4]/80 transition-colors hover:text-[#00e5b4]"
              >
                Contact Spendex
              </a>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
