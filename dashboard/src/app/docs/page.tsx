import type { Metadata } from "next";
import Link from "next/link";
import Footer from "../components/Footer";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How to install Spendex Pay in Claude Code, Cursor, Codex and any MCP-compatible agent. MCP tool reference, consent flow, spending rules and security.",
  alternates: { canonical: "/docs" },
  openGraph: {
    title: "Docs — Spendex Pay",
    description:
      "Install Spendex Pay in your AI agent. MCP tools, consent flow, spending rules and security model.",
    url: "/docs",
    type: "article",
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
            className="text-sm text-white transition-colors"
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

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const sections = [
  { id: "getting-started", label: "Getting started" },
  { id: "install", label: "Install in your agent" },
  { id: "modes", label: "How the wallet pays" },
  { id: "consent", label: "Consent inline" },
  { id: "tools", label: "MCP tools" },
  { id: "rules", label: "Rules" },
  { id: "security", label: "Security" },
  { id: "faq", label: "FAQ" },
];

function Sidebar() {
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-24">
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
          Documentation
        </p>
        <nav className="flex flex-col gap-1.5 border-l border-white/8 pl-4">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="group relative -ml-4 border-l border-transparent pl-4 py-1 text-sm text-white/50 transition-colors hover:text-white hover:border-[#00e5b4]/60"
            >
              {s.label}
            </a>
          ))}
        </nav>

        <div className="mt-10 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
            Need help?
          </p>
          <p className="mt-2 text-xs leading-relaxed text-white/50">
            Email us at support@spendexai.com — we usually reply within a few hours.
          </p>
        </div>
      </div>
    </aside>
  );
}

// ─── Headings ────────────────────────────────────────────────────────────────

function SectionHeading({ id, kicker, title }: { id: string; kicker?: string; title: string }) {
  return (
    <div className="mb-8 scroll-mt-24" id={id}>
      {kicker ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
          {kicker}
        </p>
      ) : null}
      <h2 className="text-3xl font-bold text-white sm:text-4xl">
        <span className="inline-block border-b-2 border-[#00e5b4]/60 pb-1">
          {title}
        </span>
      </h2>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-10 mb-3 text-lg font-semibold text-white">{children}</h3>
  );
}

// ─── Inline code ─────────────────────────────────────────────────────────────

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[0.85em] text-[#00e5b4]">
      {children}
    </code>
  );
}

// ─── Agent install card ─────────────────────────────────────────────────────

function AgentInstall({
  name,
  blurb,
  command,
  configPath,
  configJson,
}: {
  name: string;
  blurb: string;
  command?: string;
  configPath?: string;
  configJson?: string;
}) {
  return (
    <div className="my-5 overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      <div className="border-b border-white/8 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-[#00e5b4]/10 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#00e5b4]">
            agent
          </span>
          <span className="text-base font-semibold text-white">{name}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-white/55">{blurb}</p>
      </div>

      <div className="px-6 py-5">
        {command ? (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/40">
              One command
            </p>
            <div className="overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
              <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
                {command}
              </pre>
            </div>
          </>
        ) : null}

        {configJson ? (
          <>
            <p className={`${command ? "mt-5" : ""} mb-2 text-xs font-semibold uppercase tracking-widest text-white/40`}>
              Or paste into{" "}
              {configPath ? (
                <span className="font-mono normal-case tracking-normal text-white/55">
                  {configPath}
                </span>
              ) : (
                "your MCP config"
              )}
            </p>
            <div className="overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
              <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
                {configJson}
              </pre>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#070d18] text-white antialiased">
      <Navbar />

      <main className="pt-14">
        {/* Page header */}
        <section className="relative border-b border-white/5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="h-[400px] w-[700px] rounded-full bg-[#00e5b4]/5 blur-[120px]" />
          </div>
          <div className="relative mx-auto max-w-6xl px-6 py-16">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#00e5b4]/20 bg-[#00e5b4]/5 px-3 py-1 text-xs font-medium text-[#00e5b4]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00e5b4]" />
              Documentation · v0.1
            </div>
            <h1 className="max-w-2xl text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
              Build agents that <span className="text-[#00e5b4]">work autonomously</span>
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-white/50">
              Spendex Pay is the agent that lives in your agents. Install it in Claude Code, Cursor, ChatGPT, or any MCP host — your agents sign up for the services they need and pay for them, within your rules. You manage one relationship. We manage the rest.
            </p>
          </div>
        </section>

        {/* Body */}
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 py-16 lg:grid-cols-[220px_minmax(0,1fr)]">
          <Sidebar />

          <article className="min-w-0">
            {/* Getting started */}
            <section className="mb-20">
              <SectionHeading id="getting-started" kicker="01" title="Getting started" />
              <p className="text-base leading-relaxed text-white/60">
                Spendex plugs into your agent over MCP. Once installed, your agent gets identity (it can sign up to services on your behalf) and a wallet (a virtual card that pays for them). Three steps to live:
              </p>

              <ol className="mt-6 space-y-4">
                <li className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-sm font-bold text-[#00e5b4]">01</span>
                    <h4 className="text-base font-semibold text-white">Install Spendex MCP</h4>
                  </div>
                  <p className="mt-2 ml-9 text-sm leading-relaxed text-white/50">
                    One command for Claude Code (or paste a JSON config for Cursor, Codex, ChatGPT, etc.):
                  </p>
                  <div className="ml-9 mt-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`claude mcp add spendex`}
                    </pre>
                  </div>
                  <p className="mt-3 ml-9 text-sm leading-relaxed text-white/50">
                    Or paste this into your MCP config manually:
                  </p>
                  <div className="ml-9 mt-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexpay/wallet"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}`}
                    </pre>
                  </div>
                </li>
                <li className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-sm font-bold text-[#00e5b4]">02</span>
                    <h4 className="text-base font-semibold text-white">Add a funding card</h4>
                  </div>
                  <p className="mt-2 ml-9 text-sm leading-relaxed text-white/50">
                    Connect your real card via Stripe from the{" "}
                    <Link href="/dashboard" className="text-[#00e5b4] underline decoration-[#00e5b4]/30 underline-offset-2 hover:decoration-[#00e5b4]">
                      dashboard
                    </Link>
                    . This funds your virtual wallet — your agent draws from the wallet, never from your real card directly.
                  </p>
                </li>
                <li className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-sm font-bold text-[#00e5b4]">03</span>
                    <h4 className="text-base font-semibold text-white">Configure consent + rules</h4>
                  </div>
                  <p className="mt-2 ml-9 text-sm leading-relaxed text-white/50">
                    Choose <InlineCode>always_ask</InlineCode> (safe default), <InlineCode>auto_below_threshold</InlineCode>, or <InlineCode>auto_for_trusted_services</InlineCode>. Add per-transaction caps, monthly budgets, and allowed services. Set it once and forget it.
                  </p>
                </li>
              </ol>

              <div className="my-6 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/[0.03] p-5">
                <p className="text-sm leading-relaxed text-white/70">
                  <span className="font-semibold text-[#00e5b4]">That&apos;s it.</span>{" "}
                  Your agent can now sign up for Vercel, top-up Modal credits, upgrade OpenAI plan — anything — autonomously, within your envelope.
                </p>
              </div>
            </section>

            {/* Install in your agent */}
            <section className="mb-20">
              <SectionHeading id="install" kicker="02" title="Install in your agent" />

              <div className="my-6 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/[0.05] p-5">
                <p className="text-sm leading-relaxed text-white/75">
                  <span className="font-semibold text-[#00e5b4]">Once Spendex is installed,</span>{" "}
                  your agent gets these tools: <InlineCode>pay_for_service</InlineCode>, <InlineCode>signup_to_service</InlineCode>, <InlineCode>request_user_consent</InlineCode>, <InlineCode>submit_consent_decision</InlineCode>, <InlineCode>check_balance</InlineCode>, <InlineCode>check_spending_rules</InlineCode>. The host agent (Claude Code, Cursor, etc.) calls them transparently as needed.
                </p>
              </div>

              <p className="text-base leading-relaxed text-white/60">
                Spendex Pay speaks the Model Context Protocol — so any MCP-compatible agent can host it. Below is the one-liner for the popular agents.
              </p>

              <AgentInstall
                name="Claude Code"
                blurb="The official CLI from Anthropic. Spendex registers as a project- or user-level MCP server."
                command={`claude mcp add spendex`}
                configPath=".claude/settings.json"
                configJson={`{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexpay/wallet"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}`}
              />

              <AgentInstall
                name="Cursor"
                blurb="Open the Cursor settings or drop a project-level config — Cursor picks up MCP servers from .cursor/mcp.json."
                configPath=".cursor/mcp.json"
                configJson={`{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexpay/wallet"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}`}
              />

              <AgentInstall
                name="Codex (OpenAI)"
                blurb="Codex reads MCP servers from its config file. Add Spendex under mcpServers and restart the session."
                configPath="~/.codex/config.json"
                configJson={`{
  "mcpServers": {
    "spendex": {
      "command": "npx",
      "args": ["-y", "@spendexpay/wallet"],
      "env": { "SPENDEX_TOKEN": "spx_..." }
    }
  }
}`}
              />

              <AgentInstall
                name="OpenClaw / generic MCP client"
                blurb="Any MCP-compatible host works the same way — spawn the wallet over stdio with your token in the environment."
                command={`SPENDEX_TOKEN=spx_... npx -y @spendexpay/wallet`}
              />
            </section>

            {/* How the wallet pays */}
            <section className="mb-20">
              <SectionHeading id="modes" kicker="03" title="How the wallet pays" />
              <p className="text-base leading-relaxed text-white/60">
                When your agent asks the wallet to pay for something, the wallet picks the best route automatically. There are two modes — your agent doesn&apos;t need to know which one fired.
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="font-mono text-xs text-[#00e5b4]">native_api</p>
                  <h4 className="mt-2 text-base font-semibold text-white">Native API mode</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    For the top services we integrate (Vercel, Modal, Anthropic — soon), Spendex calls their API directly with your OAuth token. No card details ever leave the wallet, faster settlement, richer receipts.
                  </p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="font-mono text-xs text-[#00e5b4]">card_reveal</p>
                  <h4 className="mt-2 text-base font-semibold text-white">Card reveal mode (universal)</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    For every other service, Spendex exposes the virtual card details to the agent via the <InlineCode>pay_for_service</InlineCode> tool. The agent uses its own capabilities (Computer Use in Claude Code, browser tool in Cursor, etc.) to finalize the payment on the merchant&apos;s checkout.
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/[0.03] p-5">
                <p className="text-sm leading-relaxed text-white/70">
                  <span className="font-semibold text-[#00e5b4]">Either way, you do nothing.</span>{" "}
                  The agent handles the payment. You set the rules once and the wallet enforces them at the card level.
                </p>
              </div>

              <SubHeading>Coverage today</SubHeading>
              <div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
                <table className="w-full text-left">
                  <thead className="border-b border-white/8 bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-widest text-white/40">
                        Service
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-widest text-white/40">
                        Native API
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-widest text-white/40">
                        Virtual card
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    <tr>
                      <td className="px-6 py-3 text-sm font-medium text-white">Vercel</td>
                      <td className="px-6 py-3 text-sm text-white/55">Soon (v2)</td>
                      <td className="px-6 py-3 text-sm text-[#00e5b4]">Available</td>
                    </tr>
                    <tr>
                      <td className="px-6 py-3 text-sm font-medium text-white">Modal</td>
                      <td className="px-6 py-3 text-sm text-white/55">Soon (v2)</td>
                      <td className="px-6 py-3 text-sm text-[#00e5b4]">Available</td>
                    </tr>
                    <tr>
                      <td className="px-6 py-3 text-sm font-medium text-white">
                        OpenAI, Anthropic, Replicate, Fly.io, Railway, Render, GitHub, AWS, GCP, and the rest of the internet
                      </td>
                      <td className="px-6 py-3 text-sm text-white/40">—</td>
                      <td className="px-6 py-3 text-sm text-[#00e5b4]">Available</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-sm leading-relaxed text-white/50">
                When the agent calls <InlineCode>pay_for_service</InlineCode>, the wallet checks for a native integration first and falls back to the virtual card if there isn&apos;t one. The agent never has to choose.
              </p>
            </section>

            {/* Consent inline */}
            <section className="mb-20">
              <SectionHeading id="consent" kicker="04" title="Consent happens in the same chat" />
              <p className="text-base leading-relaxed text-white/60">
                When your agent needs your input, Spendex returns a structured prompt to the host agent. The agent shows the prompt in the conversation. You reply in the same chat. Your agent then calls <InlineCode>submit_consent_decision</InlineCode> with your choice.
              </p>

              <SubHeading>The consent prompt</SubHeading>
              <p className="text-sm leading-relaxed text-white/55">
                Calling <InlineCode>request_user_consent</InlineCode> returns a markdown prompt that the host agent renders inline. Here is the format your user will see:
              </p>
              <div className="mt-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`Spendex needs your approval

Your agent wants to: sign up for Vercel Pro
Estimated cost: $20.00 / month (first charge today: $20.00)
Funding: Spendex wallet · balance $478.20 · monthly budget $500

Choose one:
  A) Approve once — this charge only
  B) Approve + remember — auto-approve Vercel Pro every month
  C) Approve under a cap — auto-approve below $___ / month
  D) Decline

Reply with A, B, C (with an amount), or D.`}
                </pre>
              </div>

              <SubHeading>How the round-trip works</SubHeading>
              <ol className="space-y-3 text-sm leading-relaxed text-white/60">
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Agent calls <InlineCode>request_user_consent</InlineCode> with the action context.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Spendex returns a structured prompt and a <InlineCode>consent_id</InlineCode>.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  The host agent renders the prompt in your conversation.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  You reply with A, B, C (and a cap), or D.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Agent calls <InlineCode>submit_consent_decision</InlineCode> with the <InlineCode>consent_id</InlineCode> and your choice.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Spendex authorizes the payment (or records the decline) and the agent proceeds.
                </li>
              </ol>

              <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-5">
                <p className="text-sm leading-relaxed text-white/60">
                  <span className="font-semibold text-white">Note.</span>{" "}
                  Email and Telegram notifications are opt-in fallbacks for async mode (background tasks, overnight agents). The default is inline consent in your chat.
                </p>
              </div>
            </section>

            {/* MCP tools */}
            <section className="mb-20">
              <SectionHeading id="tools" kicker="05" title="MCP tools reference" />
              <p className="text-base leading-relaxed text-white/60">
                Spendex exposes a small surface area to your agent. The first six are the canonical tools — everything below is legacy.
              </p>

              <SubHeading>pay_for_service — pay for anything</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                The universal payment tool. Your agent calls this when it needs to pay for ANY service. Returns either a native API success or virtual card details to complete the payment.
              </p>
              <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`pay_for_service({
  service: string,
  amount_usd: number,
  description: string,
  mcp_token: string
})`}
                </pre>
              </div>
              <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-white/40">
                Example response
              </p>
              <div className="mt-2 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`APPROVED
Use this card to complete the payment for vercel:
Card number: 4242 4242 4242 4242
Expiry: 12/30
CVC: 123
Billing ZIP: 94103
Amount authorized: $20.00
Rules: per-tx cap $50 · monthly $500
Spendex transaction id: spx_tx_8f3a...`}
                </pre>
              </div>

              <SubHeading>signup_to_service — create accounts on behalf of the user</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                Spendex creates the account (Vercel, OpenAI, Modal, GitHub Pro, …) under the user&apos;s identity, stores the credentials in the wallet, and returns a session the agent can use immediately.
              </p>
              <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`signup_to_service({
  service: string,
  plan?: string,
  mcp_token: string
})`}
                </pre>
              </div>

              <SubHeading>request_user_consent + submit_consent_decision — inline approval</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                These two travel together. The agent calls <InlineCode>request_user_consent</InlineCode> to ask the user inline, then <InlineCode>submit_consent_decision</InlineCode> with the user&apos;s reply to unlock the action.
              </p>
              <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`request_user_consent({
  action: "signup_to_service" | "pay_for_service" | "add_service_credits",
  service: string,
  amount_usd?: number,
  context: string,
  mcp_token: string
}) → { consent_id, prompt }

submit_consent_decision({
  consent_id: string,
  decision: "A" | "B" | "C" | "D",
  cap_usd?: number,
  mcp_token: string
})`}
                </pre>
              </div>

              <SubHeading>check_balance — current wallet state</SubHeading>
              <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`check_balance({ mcp_token: string })
  → { balance_usd, month_to_date_spend_usd, monthly_budget_usd }`}
                </pre>
              </div>

              <SubHeading>check_spending_rules — what is the agent allowed to do</SubHeading>
              <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-4">
                <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-white/80">
{`check_spending_rules({ mcp_token: string })
  → {
      consent_mode: "always_ask" | "auto_below_threshold" | "auto_for_trusted_services",
      per_tx_cap_usd,
      monthly_budget_usd,
      auto_threshold_usd,
      trusted_services: string[]
    }`}
                </pre>
              </div>

              <SubHeading>Legacy fallback tools</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                These shipped in v0.1 before the universal tools existed. They still work but won&apos;t see new features — prefer <InlineCode>pay_for_service</InlineCode>.
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-white/55">
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/30" />
                  <span>
                    <InlineCode>deploy_to_vercel</InlineCode> — pays for and triggers a Vercel deployment.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/30" />
                  <span>
                    <InlineCode>subscribe_to_service</InlineCode> — sets up a recurring charge against the wallet.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/30" />
                  <span>
                    <InlineCode>add_service_credits</InlineCode> — tops up an existing service account (Modal credits, OpenAI balance, etc.).
                  </span>
                </li>
              </ul>
            </section>

            {/* Rules */}
            <section className="mb-20">
              <SectionHeading id="rules" kicker="06" title="Spending rules" />
              <p className="text-base leading-relaxed text-white/60">
                Rules are envelopes you set once. Configure them from the dashboard, then stop thinking about them — every authorization that violates them is declined at the Stripe Issuing level, in real time, before money moves.
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="font-mono text-xs text-[#00e5b4]">max_auto_charge_usd</p>
                  <h4 className="mt-2 text-base font-semibold text-white">Per-transaction cap</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">
                    The most a single charge can be. Anything above is declined at the card level — the merchant sees a decline, your agent sees the error.
                  </p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="font-mono text-xs text-[#00e5b4]">max_amount_per_month</p>
                  <h4 className="mt-2 text-base font-semibold text-white">Monthly budget</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">
                    A hard ceiling across all services for the calendar month. Once hit, every subsequent authorization is declined until the month resets or you raise the cap.
                  </p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="font-mono text-xs text-[#00e5b4]">allowed_merchants</p>
                  <h4 className="mt-2 text-base font-semibold text-white">Merchant allowlist</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">
                    Restrict the card to a specific MCC range (dev tools / cloud) or a named allowlist. Charges from anything else are declined automatically.
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/[0.03] p-5">
                <p className="text-sm leading-relaxed text-white/70">
                  <span className="font-semibold text-[#00e5b4]">Set once, forget.</span>{" "}
                  Limits are wired directly into Stripe Issuing — there&apos;s no application layer to bypass, no daily check-in, no surveillance. The envelope holds itself.
                </p>
              </div>
            </section>

            {/* Security */}
            <section className="mb-20">
              <SectionHeading id="security" kicker="07" title="Security" />

              <div className="my-5 rounded-xl border border-[#00e5b4]/15 bg-[#00e5b4]/[0.03] p-5">
                <p className="text-sm leading-relaxed text-white/70">
                  <span className="font-semibold text-[#00e5b4]">Spendex never holds the funds.</span>{" "}
                  Your funding card (Stripe Customer) is the source. The virtual card and rules sit as a layer between your agent and merchants — your money stays in your account until a real, approved authorization clears.
                </p>
              </div>

              <SubHeading>Card details</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                The full PAN, expiry, and CVC are revealed only via the <Link href="/dashboard/services" className="text-[#00e5b4] underline decoration-[#00e5b4]/30 underline-offset-2 hover:decoration-[#00e5b4]">Services page</Link> behind your authenticated session, using Stripe&apos;s ephemeral-key flow. The numbers never sit in our database in plaintext — we hold a Stripe card ID and your encrypted metadata only.
              </p>

              <SubHeading>Emergency stop</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                One toggle freezes the wallet immediately. Every pending and incoming authorization gets declined by Stripe Issuing until you unfreeze. No restart, no redeployment — flipping the switch in the dashboard takes effect on the very next authorization request.
              </p>

              <SubHeading>Audit log</SubHeading>
              <p className="text-sm leading-relaxed text-white/60">
                Every authorization (approved or declined), every settlement, every webhook event is written to an immutable audit log with the merchant name, amount, and Stripe IDs. If something looks off, you have a full trail — and dispute filing is one click.
              </p>

              <SubHeading>What we never log</SubHeading>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-white/60">
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Raw card numbers, CVCs, or PIN material — anywhere, ever (stdout, stderr, Sentry, analytics).
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Stripe secret keys or webhook signing secrets.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#00e5b4]" />
                  Raw wallet tokens — only their salted hash is stored.
                </li>
              </ul>
            </section>

            {/* FAQ */}
            <section className="mb-20">
              <SectionHeading id="faq" kicker="08" title="FAQ" />

              <div className="divide-y divide-white/8 rounded-2xl border border-white/8 bg-white/[0.02]">
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Where does consent happen?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    In the same chat where your agent is working. Spendex returns a structured prompt. You reply. The agent proceeds. No external apps required.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Do I need to install anything?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    Yes, one command in your agent&apos;s MCP config. After that, your agent has wallet access.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Do I need to add the card to Vercel/Modal/etc.?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    No. Your agent fetches the card details from the wallet when needed and handles the payment itself. You set the rules once and forget about it.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">What if my agent doesn&apos;t have Computer Use?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    For top services (Vercel, Modal, Anthropic), Spendex uses native API integrations — no Computer Use needed. For other services, the agent needs some way to complete a payment form. Most modern coding agents (Claude Code, Cursor with browser tool) can do this.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Will my agent overspend?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    No. Rules are enforced at the Stripe Issuing level — even if your agent goes rogue, charges above your limits are declined by Stripe in under 2 seconds.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">What if the service has no API?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    The wallet falls back to card reveal mode — the agent gets the virtual card details and completes checkout itself. You don&apos;t notice the difference.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Can I freeze the wallet?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    Yes. One click in the dashboard freezes it instantly. Resume anytime.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Is there a fee?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    No. Spendex Pay is free. We make money by understanding agent spending patterns (privacy-respecting aggregated data) and helping merchants reach the agent economy.
                  </p>
                </div>
                <div className="p-6">
                  <h4 className="text-base font-semibold text-white">Does my agent need to know which service?</h4>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    No. The agent just calls &ldquo;pay for this&rdquo; and the wallet figures out native vs card.
                  </p>
                </div>
              </div>
            </section>

            {/* Footer CTA */}
            <section className="mt-20">
              <div className="relative overflow-hidden rounded-2xl border border-[#00e5b4]/15 bg-[#00e5b4]/5 px-10 py-14 text-center">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <div className="h-56 w-56 rounded-full bg-[#00e5b4]/10 blur-3xl" />
                </div>
                <h2 className="relative mx-auto max-w-md text-2xl font-bold text-white sm:text-3xl">
                  Ready to never stop again?
                </h2>
                <p className="relative mt-3 text-sm text-white/50">
                  Install the wallet in your agent in under a minute. Pay only when your agent spends.
                </p>
                <div className="relative mt-6 flex flex-wrap justify-center gap-4">
                  <Link
                    href="/login"
                    className="rounded-lg bg-[#00e5b4] px-6 py-3 text-sm font-semibold text-[#070d18] shadow-lg shadow-[#00e5b4]/10 transition-opacity hover:opacity-90"
                  >
                    Get your wallet →
                  </Link>
                  <a
                    href="#getting-started"
                    className="rounded-lg border border-white/15 px-6 py-3 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
                  >
                    Back to top
                  </a>
                </div>
              </div>
            </section>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
