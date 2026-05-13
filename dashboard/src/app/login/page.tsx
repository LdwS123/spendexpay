"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SpendexMark } from "@/components/SpendexMark";

// ─────────────────────────────────────────────────────────────────────────────
// Sign-in page — premium light aesthetic to match the dashboard shell.
//
// Single centered card on the same #f6f7f9 background the dashboard uses,
// so login → dashboard transition is visually seamless.
//
// Auth surface:
//   1. GitHub (dark CTA) — primary for the dev audience.
//   2. Google (white CTA with multi-color G) — for everyone else.
//   3. Email + password — fallback, below a subtle divider.
//
// Loading state is per-provider so clicking GitHub doesn't grey out Google.
// OAuth errors surfaced by /auth/callback are read from ?error=… and shown
// inline at the top of the form.
// ─────────────────────────────────────────────────────────────────────────────

type Provider = "github" | "google";

function GithubIcon() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.52.12-3.17 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0112 5.8c1.02 0 2.05.14 3.01.4 2.29-1.55 3.3-1.23 3.3-1.23.65 1.65.24 2.87.12 3.17.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z" fill="#34A853" />
      <path d="M5.84 14.1A6.6 6.6 0 015.5 12c0-.73.12-1.44.34-2.1V7.07H2.18A11 11 0 001 12c0 1.78.43 3.46 1.18 4.93l3.66-2.83z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 002.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z" fill="#EA4335" />
    </svg>
  );
}

function SpinIcon() {
  return (
    <svg className="h-[16px] w-[16px] animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"email" | Provider | null>(null);

  // Surface errors handed back by /auth/callback (?error=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) setError(decodeURIComponent(err));
  }, []);

  async function handleOAuth(provider: Provider) {
    setError(null);
    setPending(provider);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    });

    if (oauthError) {
      setError(oauthError.message);
      setPending(null);
    }
    // On success the browser is redirected to the provider; no state to reset.
  }

  async function handleEmailSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending("email");

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setPending(null);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  const anyPending = pending !== null;

  return (
    <main className="min-h-screen bg-[#f6f7f9] text-slate-900 flex flex-col">
      {/* Chrome's autofill ships a blue background that overrides our white
          inputs. Override it back so the page stays on-brand. */}
      <style jsx global>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 1000px white inset !important;
          -webkit-text-fill-color: rgb(15, 23, 42) !important;
          transition: background-color 9999s ease-out;
        }
      `}</style>

      {/* Header strip — wordmark only, like Linear's auth pages */}
      <header className="px-6 py-5 sm:px-10 sm:py-6">
        <div className="flex items-center gap-2.5">
          <SpendexMark size={26} decorative />
          <span className="text-[14px] font-semibold tracking-tight text-spendex-dark">
            Spendex<span className="text-spendex-purple">AI</span>
          </span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-5 pb-16">
        <div className="w-full max-w-[400px]">
          {/* Title block */}
          <div className="mb-7 text-center">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] leading-tight text-spendex-dark">
              Sign in to SpendexAI
            </h1>
            <p className="mt-2 text-[14px] text-slate-500">
              Payments infrastructure for AI agents
            </p>
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {error && (
              <div
                role="alert"
                className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700"
              >
                {error}
              </div>
            )}

            {/* OAuth buttons */}
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => handleOAuth("github")}
                disabled={anyPending}
                className="group relative flex w-full items-center justify-center gap-2.5 rounded-lg bg-spendex-dark px-4 py-2.5 text-[13.5px] font-medium text-white transition-all hover:bg-[#1a1f2c] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spendex-purple focus-visible:ring-offset-2"
              >
                {pending === "github" ? <SpinIcon /> : <GithubIcon />}
                <span>Continue with GitHub</span>
              </button>

              <button
                type="button"
                onClick={() => handleOAuth("google")}
                disabled={anyPending}
                className="group relative flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-[13.5px] font-medium text-spendex-dark transition-all hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spendex-purple focus-visible:ring-offset-2"
              >
                {pending === "google" ? <SpinIcon /> : <GoogleIcon />}
                <span>Continue with Google</span>
              </button>
            </div>

            {/* Divider */}
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" aria-hidden="true" />
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
                or
              </span>
              <div className="h-px flex-1 bg-slate-200" aria-hidden="true" />
            </div>

            {/* Email form */}
            <form onSubmit={handleEmailSubmit} className="space-y-3.5">
              <div>
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-[11.5px] font-medium text-slate-600"
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
                  disabled={anyPending}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-[13.5px] text-slate-900 placeholder-slate-400 transition-all focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/5 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label
                    htmlFor="password"
                    className="text-[11.5px] font-medium text-slate-600"
                  >
                    Password
                  </label>
                  <a
                    href="mailto:support@spendexai.com?subject=Spendex%20password%20reset"
                    className="text-[11.5px] text-slate-500 hover:text-slate-900 transition-colors"
                  >
                    Forgot?
                  </a>
                </div>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={anyPending}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-[13.5px] text-slate-900 placeholder-slate-400 transition-all focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/5 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="••••••••"
                />
              </div>

              <button
                type="submit"
                disabled={anyPending}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-spendex-purple px-4 py-2.5 text-[13.5px] font-semibold text-white transition-all hover:bg-[#5b48ff] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spendex-purple/60 focus-visible:ring-offset-2"
              >
                {pending === "email" ? (
                  <>
                    <SpinIcon />
                    <span>Signing in…</span>
                  </>
                ) : (
                  <span>Sign in</span>
                )}
              </button>
            </form>
          </div>

          {/* Footer */}
          <p className="mt-6 text-center text-[12px] text-slate-500">
            Need access?{" "}
            <a
              href="mailto:support@spendexai.com"
              className="font-medium text-spendex-dark hover:text-spendex-purple transition-colors"
            >
              Contact SpendexAI
            </a>
          </p>

          <p className="mt-3 text-center text-[10.5px] uppercase tracking-[0.14em] text-slate-400">
            Payments infrastructure for AI agents
          </p>
        </div>
      </div>
    </main>
  );
}
