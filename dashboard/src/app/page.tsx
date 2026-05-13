import Link from "next/link";
import Footer from "./components/Footer";

// ─── Landing Page ────────────────────────────────────────────────────────────
//
// Single-screen pitch for angels / VCs / early users. The hero alone has to
// land the pain in under 5 seconds:
//   "Your AI agent stops every time it needs to pay for something.
//    Spendex Pay removes that wall."
//
// Five sections, each with one job and one CTA. All CTAs point to /dashboard.
// Dark navy bg (#0D0F14), teal accent (#6D5BFF) reserved for CTAs + check icons.

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#0D0F14] text-white antialiased">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <ConsentDemo />
        <Trust />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

// ─── Navbar ──────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#0D0F14]/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-sm font-bold tracking-tight">
          Spendex <span className="text-[#6D5BFF]">Pay</span>
        </Link>
        <Link
          href="/dashboard"
          className="rounded-full bg-[#6D5BFF] px-4 py-2 text-xs font-semibold text-[#04221b] transition-opacity hover:opacity-90"
        >
          Get access
        </Link>
      </div>
    </header>
  );
}

// ─── Section 1 — Hero ────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="px-6 pb-24 pt-20 sm:pb-32 sm:pt-28 lg:pb-40 lg:pt-36">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-balance text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl xl:text-8xl">
          Your AI agent just stopped. Again.
        </h1>
        <p className="mt-8 max-w-3xl text-pretty text-lg leading-relaxed text-white/55 sm:text-xl">
          Every time it needs a Vercel upgrade, an OpenAI top-up, or to buy
          something on Amazon — it stops and asks you. Spendex Pay is the wallet
          that lets your agent keep shipping.
        </p>

        {/* Side-by-side comparison */}
        <div className="mt-16 grid gap-6 md:grid-cols-2 md:gap-8">
          <ChatColumn
            tone="bad"
            label="Without Spendex"
            user="I need to deploy this to Vercel."
            agentName="Claude"
            agentMessage={[
              "I need to upgrade your Vercel plan to Pro ($20/mo).",
              "Please go to vercel.com, add your card, then let me know when you're done.",
            ]}
            outcome="You sigh, leave the chat, spend 5 minutes pasting card details."
          />
          <ChatColumn
            tone="good"
            label="With Spendex"
            user="I need to deploy this to Vercel."
            agentName="Spendex"
            agentMessage={[
              "Charging $20 to your wallet. Within your rules.",
            ]}
            outcome="Site deployed in 12s. You stay in flow."
          />
        </div>

        <div className="mt-16 flex justify-center sm:justify-start">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-[#6D5BFF] px-8 py-4 text-base font-semibold text-[#04221b] transition-opacity hover:opacity-90 sm:text-lg"
          >
            Get early access
            <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

function ChatColumn({
  tone,
  label,
  user,
  agentName,
  agentMessage,
  outcome,
}: {
  tone: "good" | "bad";
  label: string;
  user: string;
  agentName: string;
  agentMessage: string[];
  outcome: string;
}) {
  const isGood = tone === "good";
  const borderTone = isGood
    ? "border-[#6D5BFF]/30"
    : "border-rose-500/25";
  const badgeTone = isGood
    ? "bg-[#6D5BFF]/10 text-[#6D5BFF]"
    : "bg-rose-500/10 text-rose-300";
  const icon = isGood ? "✓" : "✕";
  const iconTone = isGood ? "text-[#6D5BFF]" : "text-rose-400";

  return (
    <div
      className={`flex flex-col rounded-2xl border ${borderTone} bg-white/[0.02] p-6 sm:p-7`}
    >
      <span
        className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${badgeTone}`}
      >
        <span className={iconTone}>{icon}</span>
        {label}
      </span>

      <div className="mt-6 space-y-4">
        <ChatBubble role="user">{user}</ChatBubble>
        <ChatBubble role="agent" name={agentName} tone={tone}>
          {agentMessage.map((line, i) => (
            <p key={i} className={i === 0 ? "" : "mt-2"}>
              {line}
            </p>
          ))}
        </ChatBubble>
      </div>

      <div className="mt-6 border-t border-white/5 pt-5 text-sm leading-relaxed text-white/45">
        {outcome}
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  name,
  tone,
  children,
}: {
  role: "user" | "agent";
  name?: string;
  tone?: "good" | "bad";
  children: React.ReactNode;
}) {
  if (role === "user") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-white/30">
          You
        </span>
        <div className="rounded-lg rounded-tl-sm bg-white/[0.04] px-4 py-3 text-sm text-white/75">
          {children}
        </div>
      </div>
    );
  }

  const accent =
    tone === "good" ? "text-[#6D5BFF]" : "text-rose-300/90";

  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-[10px] font-medium uppercase tracking-wider ${accent}`}
      >
        {name}
      </span>
      <div className="rounded-lg rounded-tl-sm bg-white/[0.06] px-4 py-3 text-sm leading-relaxed text-white/85">
        {children}
      </div>
    </div>
  );
}

// ─── Section 2 — How it works ────────────────────────────────────────────────

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Install Spendex MCP",
      copy: "One command in Claude Code, Cursor, or any MCP-compatible agent.",
      code: "claude mcp add spendex",
    },
    {
      n: "02",
      title: "Set your spending rules",
      copy: "Max per transaction, monthly cap, allowed merchants. Configure once.",
      code: "$50/tx · $500/mo · dev tools only",
    },
    {
      n: "03",
      title: "Your agent ships",
      copy: "Vercel deploys, Modal credits, Amazon orders — all autonomous.",
      code: "→ pay_for_service('vercel', 20)",
    },
  ];

  return (
    <section className="border-t border-white/5 px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/40">
            How it works
          </p>
          <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Three steps. Then your agent never stops again.
          </h2>
        </div>

        <ol className="mt-14 grid gap-6 md:grid-cols-3 md:gap-8">
          {steps.map((s) => (
            <li
              key={s.n}
              className="flex flex-col rounded-2xl border border-white/5 bg-white/[0.02] p-7"
            >
              <span className="text-xs font-mono text-white/30">{s.n}</span>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">
                {s.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-white/55">
                {s.copy}
              </p>
              <code className="mt-6 inline-block rounded-md bg-black/40 px-3 py-2 font-mono text-xs text-[#6D5BFF]/90">
                {s.code}
              </code>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ─── Section 3 — Consent demo ────────────────────────────────────────────────

function ConsentDemo() {
  return (
    <section className="border-t border-white/5 px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/40">
            Inline consent
          </p>
          <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            The agent asks. You approve in one click.
          </h2>
        </div>

        <div className="mt-14 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent p-8 sm:p-12">
          <ConsentWidget />
        </div>

        <p className="mt-8 max-w-2xl text-lg leading-relaxed text-white/55">
          The agent shows you what it&apos;s about to buy. You approve. It pays.
          Audit trail forever.
        </p>
      </div>
    </section>
  );
}

function ConsentWidget() {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-[#0a1320] shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#6D5BFF]" />
          <span className="text-xs font-medium text-white/70">
            Spendex · purchase approval
          </span>
        </div>
        <span className="font-mono text-[10px] text-white/30">#cnsnt_4f2a</span>
      </div>

      <div className="px-5 pt-5">
        <div className="flex gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-white/10 to-white/[0.02] text-3xl">
            {/* simple headphone glyph, no asset dependency */}
            <span aria-hidden>🎧</span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-snug">
              Sony WH-1000XM5
            </h3>
            <p className="mt-1 text-xs text-white/45">
              Wireless noise-cancelling headphones · Amazon
            </p>
            <p className="mt-3 font-mono text-2xl font-bold tracking-tight text-white">
              $348.00
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-[#6D5BFF]/20 bg-[#6D5BFF]/[0.06] px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[#6D5BFF]">✓</span>
            <span className="text-white/80">Within your rules</span>
          </div>
          <p className="mt-1 text-xs text-white/50">
            $309 / $500 monthly cap remaining after this charge
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 border-t border-white/5 p-3">
        <button
          type="button"
          className="rounded-lg border border-white/10 px-4 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/5"
        >
          Decline
        </button>
        <button
          type="button"
          className="rounded-lg bg-[#6D5BFF] px-4 py-2.5 text-sm font-semibold text-[#04221b] transition-opacity hover:opacity-90"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

// ─── Section 4 — Trust ───────────────────────────────────────────────────────

function Trust() {
  const items = [
    {
      icon: "🛡️",
      title: "Stripe Issuing virtual card",
      copy: "Card locked to dev-tool merchants. Card numbers never on the agent's side.",
    },
    {
      icon: "📊",
      title: "Audit log, immutable",
      copy: "Every charge, every consent, every decline recorded forever.",
    },
    {
      icon: "🚨",
      title: "One-click freeze",
      copy: "Instant pause from your dashboard if anything looks off.",
    },
  ];

  return (
    <section className="border-t border-white/5 px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/40">
            Trust & safety
          </p>
          <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Autonomous, but never out of your hands.
          </h2>
        </div>

        <ul className="mt-14 grid gap-6 md:grid-cols-3 md:gap-8">
          {items.map((it) => (
            <li
              key={it.title}
              className="flex flex-col rounded-2xl border border-white/5 bg-white/[0.02] p-7"
            >
              <span className="text-2xl" aria-hidden>
                {it.icon}
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">
                {it.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-white/55">
                {it.copy}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─── Section 5 — Final CTA ───────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="border-t border-white/5 px-6 py-28 sm:py-36">
      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <h2 className="text-balance text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
          Stop interrupting your agents.
        </h2>
        <Link
          href="/dashboard"
          className="mt-10 inline-flex items-center gap-2 rounded-full bg-[#6D5BFF] px-8 py-4 text-base font-semibold text-[#04221b] transition-opacity hover:opacity-90 sm:text-lg"
        >
          Try Spendex Pay
          <span aria-hidden>→</span>
        </Link>
      </div>
    </section>
  );
}
