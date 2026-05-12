import type { Metadata } from "next";
import Link from "next/link";
import Footer from "./components/Footer";

export const metadata: Metadata = {
  title: "The wallet for your AI agent",
  description:
    "Install Spendex Pay once in Claude Code, Cursor or ChatGPT. Your AI agents sign up for any service and pay for it — within the rules you set.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Spendex Pay — The wallet for your AI agent",
    description:
      "Install once. Your AI agents sign up and pay for any service — within the rules you set.",
    url: "/",
    type: "website",
  },
};

// ─── Navbar ──────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-white/5 bg-[#070d18]/80 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-lg font-bold tracking-tight text-white">
          Spendex <span className="text-[#00e5b4]">Pay</span>
        </Link>

        <div className="flex items-center gap-6">
          <Link
            href="/docs"
            className="text-sm text-white/50 transition-colors hover:text-white"
          >
            Docs
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/50 transition-colors hover:text-white"
          >
            GitHub
          </a>
          <Link
            href="/login"
            className="rounded-lg bg-[#00e5b4] px-4 py-1.5 text-sm font-semibold text-[#070d18] transition-opacity hover:opacity-90"
          >
            Get started →
          </Link>
        </div>
      </nav>
    </header>
  );
}

// ─── Virtual Card ────────────────────────────────────────────────────────────

function VirtualCard() {
  return (
    <div className="relative w-full max-w-md">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 rounded-3xl bg-[#00e5b4]/10 blur-3xl"
      />

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#0e1a2d] via-[#0a1322] to-[#070d18] p-7 shadow-2xl shadow-black/50">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-[#00e5b4]/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -left-12 h-48 w-48 rounded-full bg-[#00e5b4]/10 blur-3xl"
        />

        <div className="relative flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
              Spendex Pay
            </p>
            <p className="mt-1 text-xs text-white/30">Virtual card</p>
          </div>
          <div className="flex h-7 w-10 items-center justify-center rounded-md bg-gradient-to-br from-[#00e5b4]/30 to-[#00e5b4]/10 ring-1 ring-[#00e5b4]/30">
            <div className="h-3 w-5 rounded-sm bg-gradient-to-br from-amber-200/80 to-amber-400/40" />
          </div>
        </div>

        <div className="relative mt-10 flex items-center gap-4 font-mono text-xl tracking-[0.25em] text-white">
          <span className="text-white/40">••••</span>
          <span className="text-white/40">••••</span>
          <span className="text-white/40">••••</span>
          <span>4242</span>
        </div>

        <div className="relative mt-6 inline-flex items-center gap-2 rounded-full border border-[#00e5b4]/20 bg-[#00e5b4]/5 px-3 py-1 text-[11px] font-medium text-[#00e5b4]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#00e5b4]" />
          Limits: €10 / tx · €500 / mo
        </div>

        <div className="relative mt-7 flex items-end justify-between">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/30">
              Exp
            </p>
            <p className="mt-1 font-mono text-sm text-white/80">12 / 30</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold tracking-wider text-white/80">
              VISA
            </span>
            <span className="text-[#00e5b4]">→</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MCP Install Preview ─────────────────────────────────────────────────────

function McpInstallPreview() {
  return (
    <div className="w-full max-w-md rounded-xl border border-white/8 bg-black/40 p-5 font-mono text-sm shadow-2xl shadow-black/40">
      <div className="mb-3 flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="ml-3 text-[10px] uppercase tracking-widest text-white/30">
          terminal
        </span>
      </div>
      <div className="flex gap-2">
        <span className="text-white/40">$</span>
        <span className="text-white">claude mcp add spendex</span>
      </div>
      <div className="mt-2 flex gap-2">
        <span className="text-[#00e5b4]">✓</span>
        <span className="text-white/70">Spendex installed</span>
      </div>
      <div className="mt-4 text-[11px] uppercase tracking-widest text-white/30">
        Your agent can now:
      </div>
      <div className="mt-2 flex gap-2">
        <span className="text-[#00e5b4]">✓</span>
        <span className="text-white/70">Sign up to new services</span>
      </div>
      <div className="mt-1.5 flex gap-2">
        <span className="text-[#00e5b4]">✓</span>
        <span className="text-white/70">Pay within your rules</span>
      </div>
      <div className="mt-1.5 flex gap-2">
        <span className="text-[#00e5b4]">✓</span>
        <span className="text-white/70">Never interrupt your flow</span>
      </div>
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-14 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-[600px] w-[600px] rounded-full bg-[#00e5b4]/5 blur-[120px]" />
      </div>

      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#00e5b4]/20 bg-[#00e5b4]/5 px-3.5 py-1 text-xs font-medium text-[#00e5b4]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#00e5b4]" />
        Identity + Wallet · Agent-native
      </div>

      <h1 className="mx-auto max-w-3xl text-5xl font-extrabold leading-[1.08] tracking-tight text-white sm:text-6xl lg:text-7xl">
        The agent that{" "}
        <span className="text-[#00e5b4]">lives in your agents</span>
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-white/50 sm:text-lg">
        Install Spendex once. Your AI agents can sign up for any service —
        Vercel, OpenAI, Modal, GitHub Pro — and pay for them, within the rules
        you set. You manage one relationship. We manage the rest.
      </p>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/login"
          className="rounded-lg bg-[#00e5b4] px-6 py-3 text-sm font-semibold text-[#070d18] shadow-lg shadow-[#00e5b4]/10 transition-opacity hover:opacity-90"
        >
          Start free →
        </Link>
        <Link
          href="/docs"
          className="rounded-lg border border-white/15 px-6 py-3 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
        >
          Read the docs
        </Link>
      </div>

      <div className="mt-16 grid w-full max-w-5xl gap-8 sm:grid-cols-2 sm:items-center sm:justify-items-center">
        <VirtualCard />
        <McpInstallPreview />
      </div>
    </section>
  );
}

// ─── How it works ─────────────────────────────────────────────────────────────

const steps = [
  {
    number: "01",
    title: "Install Spendex in your agent",
    description:
      "One command in Claude Code / Cursor / ChatGPT / OpenClaw. Spendex becomes a tool your agent can call.",
  },
  {
    number: "02",
    title: "Set your funding + rules",
    description:
      "Connect your real card to fund the wallet. Set per-tx caps, monthly budgets, allowed services.",
  },
  {
    number: "03",
    title: "Your agents work autonomously",
    description:
      "When they need to sign up for Vercel, top-up Modal, or upgrade OpenAI plan, they ask you inline (in the same chat), then proceed. No external apps.",
  },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-32">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
        How it works
      </p>
      <h2 className="mb-16 max-w-xl text-3xl font-bold text-white sm:text-4xl">
        One install. All your services.
      </h2>

      <div className="grid gap-px rounded-2xl border border-white/8 bg-white/8 overflow-hidden sm:grid-cols-3">
        {steps.map((step) => (
          <div
            key={step.number}
            className="group relative bg-[#070d18] p-8 transition-colors hover:bg-[#0a1220]"
          >
            <span className="mb-6 block font-mono text-4xl font-bold text-white/8 select-none">
              {step.number}
            </span>
            <h3 className="mb-3 text-base font-semibold text-white">
              {step.title}
            </h3>
            <p className="text-sm leading-relaxed text-white/40">
              {step.description}
            </p>
            <span className="absolute bottom-0 left-0 h-px w-0 bg-[#00e5b4] transition-all duration-300 group-hover:w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Three phases of agent commerce ──────────────────────────────────────────

const phases: {
  era: string;
  title: string;
  description: string;
  badge: string;
  tone: "live" | "soon" | "future";
}[] = [
  {
    era: "Now",
    title: "Dev tools",
    description:
      "Coding agents pay for Vercel, OpenAI, Anthropic, Modal, GitHub, Cloudflare.",
    badge: "Live",
    tone: "live",
  },
  {
    era: "Next",
    title: "Consumer services",
    description:
      "Personal agents pay for Netflix, Uber, Airbnb.",
    badge: "Q3 2026",
    tone: "soon",
  },
  {
    era: "Eventually",
    title: "Agents as employees",
    description:
      "Companies issue Spendex accounts to their AI agents. Budget caps, audit logs, full control.",
    badge: "2027",
    tone: "future",
  },
];

function badgeClass(tone: "live" | "soon" | "future") {
  if (tone === "live") {
    return "rounded-full bg-[#00e5b4]/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#00e5b4]";
  }
  if (tone === "soon") {
    return "rounded-full bg-white/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/70";
  }
  return "rounded-full bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/40";
}

function ThreePhases() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
        Roadmap
      </p>
      <h2 className="mb-3 max-w-xl text-3xl font-bold text-white sm:text-4xl">
        Three phases of agent commerce
      </h2>
      <p className="mb-12 max-w-2xl text-sm leading-relaxed text-white/40">
        Spendex is the connective tissue between agents and the services they
        need. We start with developers, expand into consumer services, and end
        where every agent has its own budget.
      </p>

      <div className="grid gap-6 sm:grid-cols-3">
        {phases.map((p) => (
          <div
            key={p.title}
            className="group relative flex flex-col rounded-2xl border border-white/8 bg-white/[0.02] p-7 transition-colors hover:border-[#00e5b4]/20 hover:bg-[#00e5b4]/[0.03]"
          >
            <div className="mb-5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-white/40">
                {p.era}
              </span>
              <span className={badgeClass(p.tone)}>{p.badge}</span>
            </div>
            <h3 className="mb-3 text-lg font-semibold text-white">{p.title}</h3>
            <p className="text-sm leading-relaxed text-white/50">
              {p.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Services ─────────────────────────────────────────────────────────────────

const nativeServices: { name: string; status: "Live" | "Coming v2" }[] = [
  { name: "Vercel", status: "Coming v2" },
  { name: "Modal", status: "Coming v2" },
  { name: "Anthropic", status: "Coming v2" },
  { name: "Cloudflare", status: "Coming v2" },
];

const cardServices: string[] = [
  "Vercel",
  "Modal",
  "OpenAI",
  "Anthropic API",
  "Replicate",
  "Railway",
  "Fly.io",
  "Render",
  "GitHub Pro",
  "AWS",
  "GCP",
  "Stripe",
  "Linear",
  "Notion",
];

function Services() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-10 py-12">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
          Universal
        </p>
        <h2 className="mb-3 text-3xl font-bold text-white sm:text-4xl">
          Works with every service
        </h2>
        <p className="mb-12 max-w-2xl text-sm leading-relaxed text-white/40">
          Identity + payment for any service your agent uses. Native API
          integrations on top services. Virtual card fallback on everything
          else. Your agent uses whichever works — you don&apos;t have to think
          about it.
        </p>

        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <div className="mb-5 flex items-center gap-2">
              <span className="rounded-full bg-[#00e5b4]/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#00e5b4]">
                Native
              </span>
              <span className="text-xs text-white/40">
                Direct API · OAuth-based
              </span>
            </div>
            <ul className="space-y-2">
              {nativeServices.map((svc) => (
                <li
                  key={svc.name}
                  className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.02] px-4 py-2.5"
                >
                  <span className="text-sm font-medium text-white/80">
                    {svc.name}
                  </span>
                  <span
                    className={
                      svc.status === "Live"
                        ? "rounded-full bg-[#00e5b4]/10 px-2 py-0.5 text-[10px] font-semibold text-[#00e5b4]"
                        : "rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-white/40"
                    }
                  >
                    {svc.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="mb-5 flex items-center gap-2">
              <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                Card
              </span>
              <span className="text-xs text-white/40">
                Anything that accepts VISA
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {cardServices.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-1.5 text-xs text-white/70"
                >
                  {name}
                  <span className="rounded-full bg-[#00e5b4]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[#00e5b4]">
                    Supported
                  </span>
                </span>
              ))}
              <span className="inline-flex items-center rounded-lg border border-dashed border-white/8 bg-transparent px-3 py-1.5 text-xs text-white/30">
                + anything else
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Trust features ───────────────────────────────────────────────────────────

const trustFeatures = [
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-6 w-6"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"
        />
      </svg>
    ),
    title: "Rules that just work",
    description:
      "Set a per-tx cap, monthly budget, and merchant whitelist once. Your agent operates inside that envelope automatically. No approval prompts.",
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-6 w-6"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
        />
      </svg>
    ),
    title: "Receipts you can audit",
    description:
      "Every charge logged with merchant, amount, agent context. Inspect any deploy or top-up after the fact.",
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-6 w-6"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z"
        />
      </svg>
    ),
    title: "Freeze in one click",
    description:
      "If anything looks off, freeze the wallet from your dashboard. Resume anytime.",
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-6 w-6"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
        />
      </svg>
    ),
    title: "Consent inline, not by email",
    description:
      "When your agent needs your input, it asks in the same chat. No phone notifications. No app switching. The wallet only acts when you've said yes.",
  },
];

function BuiltForTrust() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
        Built for trust
      </p>
      <h2 className="mb-16 max-w-md text-3xl font-bold text-white sm:text-4xl">
        Set it once, forget it
      </h2>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {trustFeatures.map((f) => (
          <div
            key={f.title}
            className="group rounded-2xl border border-white/8 bg-white/[0.02] p-7 transition-colors hover:border-[#00e5b4]/20 hover:bg-[#00e5b4]/[0.03]"
          >
            <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#00e5b4]/20 bg-[#00e5b4]/5 text-[#00e5b4]">
              {f.icon}
            </div>
            <h3 className="mb-2 text-base font-semibold text-white">
              {f.title}
            </h3>
            <p className="text-sm leading-relaxed text-white/40">
              {f.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── CTA banner ───────────────────────────────────────────────────────────────

function CtaBanner() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="relative overflow-hidden rounded-2xl border border-[#00e5b4]/15 bg-[#00e5b4]/5 px-10 py-16 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div className="h-64 w-64 rounded-full bg-[#00e5b4]/10 blur-3xl" />
        </div>

        <h2 className="relative mx-auto max-w-2xl text-3xl font-bold text-white sm:text-4xl">
          Install the agent that lives in your agents
        </h2>
        <p className="relative mt-4 text-sm text-white/40">
          Spendex installs in 30 seconds. Try it free.
        </p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-4">
          <Link
            href="/login"
            className="rounded-lg bg-[#00e5b4] px-7 py-3 text-sm font-semibold text-[#070d18] shadow-lg shadow-[#00e5b4]/10 transition-opacity hover:opacity-90"
          >
            Start free →
          </Link>
          <Link
            href="/docs"
            className="rounded-lg border border-white/15 px-7 py-3 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#070d18] text-white antialiased">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <ThreePhases />
        <Services />
        <BuiltForTrust />
        <CtaBanner />
      </main>
      <Footer />
    </div>
  );
}
