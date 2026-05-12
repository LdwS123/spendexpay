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
    <div className="min-h-screen bg-[#070d18] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <span className="text-2xl font-bold text-white tracking-tight">
            Spendex <span className="text-[#00e5b4]">Pay</span>
          </span>
          <p className="mt-2 text-sm text-white/40">Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Error banner */}
          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Email */}
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium text-white/50 mb-1.5"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#00e5b4]/60 focus:ring-1 focus:ring-[#00e5b4]/30 transition-colors"
              placeholder="you@example.com"
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-xs font-medium text-white/50 mb-1.5"
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
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#00e5b4]/60 focus:ring-1 focus:ring-[#00e5b4]/30 transition-colors"
              placeholder="••••••••"
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 rounded-lg bg-[#00e5b4] hover:bg-[#00e5b4]/90 disabled:opacity-50 disabled:cursor-not-allowed text-[#070d18] font-semibold text-sm px-4 py-2.5 transition-opacity"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-white/20">
          Don&apos;t have an account?{" "}
          <a
            href="mailto:support@spendexai.com"
            className="text-[#00e5b4]/60 hover:text-[#00e5b4] transition-colors"
          >
            Contact us
          </a>
        </p>
      </div>
    </div>
  );
}
