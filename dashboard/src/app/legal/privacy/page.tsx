import Link from "next/link";
import type { Metadata } from "next";
import Footer from "@/app/components/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Spendex AI collects, uses, and protects your personal data under GDPR.",
};

// ─── Navbar ──────────────────────────────────────────────────────────────────
// Lightweight, mirrors the marketing pages so the user keeps their bearings.

function Navbar() {
  return (
    <header className="fixed top-0 inset-x-0 z-40 border-b border-white/5 bg-[#070d18]/80 backdrop-blur-md">
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

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#070d18] text-white antialiased">
      <Navbar />

      <main className="mx-auto max-w-[700px] px-6 pt-32 pb-20">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
          Legal
        </p>
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Privacy Policy
        </h1>
        <p className="mt-4 text-sm text-white/40">Last updated: 12 May 2026</p>
        <p className="mt-1 text-sm text-white/40">
          Data Controller: Spendex AI
        </p>

        <div className="prose-spendex mt-12 space-y-12 text-[15px] leading-relaxed text-white/70">
          <section>
            <p>
              Spendex AI (&ldquo;Spendex&rdquo;, &ldquo;we&rdquo;,
              &ldquo;us&rdquo;) provides an MCP wallet that lets your AI agents
              sign up for and pay for third-party services on your behalf. This
              policy explains what personal data we process, why we process it,
              and the rights you have under the EU General Data Protection
              Regulation (GDPR). We operate from the European Union, and our
              core infrastructure (Stripe, Supabase) is hosted in EU regions.
            </p>
            <p className="mt-4">
              We do not sell your personal data, and we never will.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              1. What data we collect
            </h2>
            <p className="mt-4">
              To deliver the service, we collect and store the following
              categories of data:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Account data.</strong> Your email
                address and a hashed authentication token. We never store
                passwords in plaintext.
              </li>
              <li>
                <strong className="text-white">Payment method.</strong> The card
                or bank account you use to fund your Spendex wallet. Card
                numbers are tokenised by our PCI-DSS Level 1 payment processor
                (Stripe); we never see or store full card numbers ourselves.
              </li>
              <li>
                <strong className="text-white">Transaction history.</strong>
                {" "}Date, amount, merchant, currency, MCC code, and outcome
                (approved, declined, refunded) of every authorisation made with
                your Spendex virtual card.
              </li>
              <li>
                <strong className="text-white">Managed accounts.</strong> When
                you authorise Spendex to sign up for third-party services (e.g.
                Vercel, Modal, OpenAI), we store the email aliases we created,
                the service name, and an encrypted reference to the credentials
                we hold for you. Credentials are encrypted with AES-256-GCM
                using keys that are never exposed to the host AI agent.
              </li>
              <li>
                <strong className="text-white">Audit logs.</strong> MCP tool
                invocations, consent decisions, and webhook events relating to
                your wallet. These logs are required for fraud investigation,
                dispute resolution, and regulatory reporting.
              </li>
              <li>
                <strong className="text-white">Technical data.</strong> IP
                address, browser type, and timestamps of dashboard logins, used
                strictly for security and abuse detection.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              2. How we use your data
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">To provide the service.</strong>
                {" "}Process payments, enforce your spending rules, sign up to
                services on your behalf when you consent, and surface
                transaction history in your dashboard.
              </li>
              <li>
                <strong className="text-white">Fraud and abuse prevention.</strong>
                {" "}Detect anomalous spending patterns, block sanctioned
                merchants, and stop unauthorised use of your wallet.
              </li>
              <li>
                <strong className="text-white">Legal and accounting
                obligations.</strong> EU and French law require us to retain
                financial records for at least seven years.
              </li>
              <li>
                <strong className="text-white">Service communications.</strong>
                {" "}Send you receipts, consent prompts, security alerts, and
                policy updates. We do not send marketing without a separate
                opt-in.
              </li>
            </ul>
            <p className="mt-4">
              The legal bases we rely on are: performance of our contract with
              you (Art. 6(1)(b) GDPR), compliance with legal obligations (Art.
              6(1)(c)), and our legitimate interest in keeping the service
              secure (Art. 6(1)(f)).
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              3. Third parties we share data with
            </h2>
            <p className="mt-4">
              We only share what is strictly necessary, and only with vetted
              sub-processors bound by data-protection agreements:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Stripe Issuing &amp; Payments
                (Ireland).</strong> Issues your virtual card and processes
                authorisations. EU region.
              </li>
              <li>
                <strong className="text-white">Supabase (EU region).</strong>
                {" "}Our primary database. Stores account, transaction, and
                audit records.
              </li>
              <li>
                <strong className="text-white">Resend.</strong> Sends
                transactional email (receipts, verification, security
                notices).
              </li>
              <li>
                <strong className="text-white">Services you authorise.</strong>
                {" "}When you ask Spendex to sign up for a third-party service,
                we share the minimum identifying data with that service (an
                email alias and the agent-provided context). Their handling of
                your data is governed by their own privacy policy.
              </li>
            </ul>
            <p className="mt-4">
              We do not use your data to train AI models, and we do not share
              it with advertising networks.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              4. Data retention
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Active account data.</strong>
                {" "}Retained while your account is open, then deleted within
                90 days of account closure.
              </li>
              <li>
                <strong className="text-white">Transaction and audit logs.</strong>
                {" "}Retained for seven years to comply with EU accounting and
                anti-money-laundering rules. After that period the records are
                deleted or irreversibly anonymised.
              </li>
              <li>
                <strong className="text-white">Encrypted service credentials.</strong>
                {" "}Deleted within 30 days of you disconnecting a managed
                account.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              5. Your GDPR rights
            </h2>
            <p className="mt-4">
              If you are in the EU/EEA, the United Kingdom, or Switzerland you
              have the right to:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Access</strong> a copy of the
                personal data we hold about you.
              </li>
              <li>
                <strong className="text-white">Rectify</strong> inaccurate or
                outdated information.
              </li>
              <li>
                <strong className="text-white">Erase</strong> your data, subject
                to our legal retention obligations for financial records.
              </li>
              <li>
                <strong className="text-white">Restrict or object</strong> to
                certain types of processing.
              </li>
              <li>
                <strong className="text-white">Port</strong> your data — receive
                it in a structured, machine-readable format.
              </li>
              <li>
                <strong className="text-white">Withdraw consent</strong> at any
                time without affecting the lawfulness of processing before
                withdrawal.
              </li>
              <li>
                <strong className="text-white">Lodge a complaint</strong> with
                your local data-protection authority (in France: the CNIL).
              </li>
            </ul>
            <p className="mt-4">
              To exercise any of these rights, email{" "}
              <a
                href="mailto:privacy@spendexai.com"
                className="text-[#00e5b4] underline decoration-[#00e5b4]/40 underline-offset-4 hover:decoration-[#00e5b4]"
              >
                privacy@spendexai.com
              </a>
              . We respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">6. Cookies</h2>
            <p className="mt-4">
              Spendex uses a single first-party session cookie to keep you
              logged in to the dashboard. We do not use analytics cookies,
              advertising cookies, fingerprinting, or any cross-site tracking
              technology. A small acknowledgement cookie
              (<code className="rounded bg-white/10 px-1 py-0.5 text-xs">spendex-cookies-accepted</code>)
              records that you have seen the cookie notice.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              7. Security
            </h2>
            <p className="mt-4">
              Service credentials are encrypted at rest with AES-256-GCM. All
              traffic to our APIs and dashboard is served over TLS 1.2+. Access
              to production data is restricted to a small number of named
              engineers, logged, and reviewed quarterly.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              8. Changes to this policy
            </h2>
            <p className="mt-4">
              When we materially change this policy we will notify you by email
              at least 14 days before the new version takes effect. Continued
              use of Spendex after that date constitutes acceptance of the
              updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">9. Contact</h2>
            <p className="mt-4">
              Questions about this policy or about how we handle your data:
            </p>
            <p className="mt-4">
              Spendex AI ·{" "}
              <a
                href="mailto:privacy@spendexai.com"
                className="text-[#00e5b4] underline decoration-[#00e5b4]/40 underline-offset-4 hover:decoration-[#00e5b4]"
              >
                privacy@spendexai.com
              </a>
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
