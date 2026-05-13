import Link from "next/link";
import type { Metadata } from "next";
import Footer from "@/app/components/Footer";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The agreement between you and Spendex AI for use of the Spendex Pay wallet.",
};

function Navbar() {
  return (
    <header className="fixed top-0 inset-x-0 z-40 border-b border-white/5 bg-[#0D0F14]/80 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-lg font-bold tracking-tight text-white">
          Spendex <span className="text-[#6D5BFF]">Pay</span>
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
            className="rounded-lg bg-[#6D5BFF] px-4 py-1.5 text-sm font-semibold text-[#0D0F14] transition-opacity hover:opacity-90"
          >
            Get started →
          </Link>
        </div>
      </nav>
    </header>
  );
}

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-[#0D0F14] text-white antialiased">
      <Navbar />

      <main className="mx-auto max-w-[700px] px-6 pt-32 pb-20">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#6D5BFF]">
          Legal
        </p>
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Terms of Service
        </h1>
        <p className="mt-4 text-sm text-white/40">Last updated: 12 May 2026</p>

        <div className="mt-12 space-y-12 text-[15px] leading-relaxed text-white/70">
          <section>
            <p>
              These Terms of Service (the &ldquo;Terms&rdquo;) form a binding
              agreement between you and Spendex AI (&ldquo;Spendex&rdquo;,
              &ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating a Spendex
              account or using the Spendex Pay wallet, you agree to these
              Terms. If you do not agree, do not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              1. The service
            </h2>
            <p className="mt-4">
              Spendex Pay is an MCP (Model Context Protocol) wallet for AI
              agents. Once installed in a compatible host (Claude Code,
              Cursor, ChatGPT, OpenClaw, Cowork, and similar), Spendex
              provides your agent with two capabilities:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Identity.</strong> The ability
                to sign up for third-party services on your behalf, using
                email aliases we issue.
              </li>
              <li>
                <strong className="text-white">Wallet.</strong> A virtual
                Visa card issued through Stripe Issuing, funded by you,
                governed by the spending rules you configure.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              2. Account creation
            </h2>
            <p className="mt-4">
              You must be at least 18 years old to create a Spendex account.
              You must provide accurate and current information, keep your
              authentication credentials confidential, and notify us
              immediately at{" "}
              <a
                href="mailto:security@spendexai.com"
                className="text-[#6D5BFF] underline decoration-[#6D5BFF]/40 underline-offset-4 hover:decoration-[#6D5BFF]"
              >
                security@spendexai.com
              </a>{" "}
              of any suspected unauthorised access. Each account is for a
              single individual or legal entity; sharing accounts is not
              permitted.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              3. Acceptable use
            </h2>
            <p className="mt-4">
              You agree not to use Spendex Pay to engage in or facilitate any
              of the following:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>Fraud, identity theft, or unauthorised account creation.</li>
              <li>
                Money laundering, terrorist financing, or evasion of
                sanctions imposed by the EU, UN, OFAC, or France.
              </li>
              <li>Gambling, online betting, or lottery services (MCC 7995).</li>
              <li>Adult content or services (MCC 5967).</li>
              <li>
                Purchase of firearms, ammunition, or other regulated weapons
                (MCC 5655, 5681, 5715, 5933).
              </li>
              <li>Cryptocurrency speculation or trading platforms (MCC 6051).</li>
              <li>Cannabis or other controlled substances.</li>
              <li>
                Any activity that violates applicable law, infringes
                intellectual property, or harms third parties.
              </li>
            </ul>
            <p className="mt-4">
              We use Stripe&apos;s real-time authorisation system to enforce
              merchant-category blocks on these classes of transactions.
              Persistent attempts to circumvent these blocks will result in
              account termination.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              4. Payment terms
            </h2>
            <p className="mt-4">
              You fund your Spendex wallet by linking a payment method (debit
              card or bank account). When your agent triggers a charge through
              the virtual card, Spendex debits your funding source and routes
              the payment to the merchant. You authorise these debits in
              advance for amounts up to the limits you configure.
            </p>
            <p className="mt-4">
              Spending rules — per-transaction caps, monthly budgets, merchant
              allowlists — are enforced in real time at the Stripe Issuing
              authorisation layer. A charge that exceeds any rule is declined
              before the merchant sees an approval. We will never auto-charge
              you above the maximum amount you have configured.
            </p>
            <p className="mt-4">
              Currency conversions, if any, are performed by Stripe using
              their then-current exchange rates plus a 1% conversion fee.
              Failed authorisations may temporarily place a hold on your
              funding source; holds typically clear within 5 business days.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              5. Auto-signup feature
            </h2>
            <p className="mt-4">
              <strong className="text-white">
                You explicitly authorise Spendex to create accounts on third-
                party services on your behalf
              </strong>{" "}
              when your AI agent requests it and you confirm the consent
              prompt that Spendex surfaces inline in your agent chat. By
              confirming a consent prompt, you authorise us to: (a) generate
              an email alias of the form{" "}
              <code className="rounded bg-white/10 px-1 py-0.5 text-xs">
                signup-&lt;hash&gt;@mail.spendexai.com
              </code>{" "}
              and use it as the registration address; (b) generate and store a
              password under AES-256-GCM encryption; (c) complete the
              third-party service&apos;s signup flow, including accepting
              their terms of service on your behalf; (d) pay any required
              signup fee using your Spendex virtual card, within the spending
              rules you have configured.
            </p>
            <p className="mt-4">
              <strong className="text-white">
                You remain solely responsible
              </strong>{" "}
              for the terms of service of any third-party service that
              Spendex signs you up for, for the content you generate or store
              on those services, and for any subscription or recurring
              charges those services apply. Spendex is not a party to your
              agreement with the third-party service and does not endorse,
              warrant, or audit them.
            </p>
            <p className="mt-4">
              You can revoke this authorisation at any time from your
              dashboard, on a per-service or global basis. Revocation does
              not retroactively unbind you from agreements you have already
              entered into with third-party services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              6. Limitation of liability
            </h2>
            <p className="mt-4">
              To the maximum extent permitted by law, Spendex AI&apos;s total
              liability to you for any claim arising out of or relating to
              these Terms or the service is limited to the total amount you
              paid to Spendex (excluding pass-through merchant charges) in
              the three months immediately preceding the event that gave
              rise to the claim.
            </p>
            <p className="mt-4">
              Spendex is not liable for indirect, incidental, special,
              consequential, or punitive damages, including lost profits,
              lost data, or business interruption, even if we have been
              advised of the possibility of such damages. Nothing in these
              Terms excludes or limits liability for fraud, gross
              negligence, death, or personal injury, or any other liability
              that cannot be excluded under applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              7. Indemnification
            </h2>
            <p className="mt-4">
              You agree to indemnify and hold harmless Spendex AI, its
              officers, directors, employees, and affiliates from and
              against any claims, liabilities, damages, losses, and
              expenses (including reasonable legal fees) arising from: (a)
              your violation of these Terms; (b) your violation of any law
              or third-party right; (c) misuse of your Spendex account,
              including by an AI agent acting on your behalf; (d) charges
              or disputes you incur with third-party services that Spendex
              signed up to on your behalf.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              8. Termination
            </h2>
            <p className="mt-4">
              You may close your account at any time from your dashboard or
              by emailing{" "}
              <a
                href="mailto:support@spendexai.com"
                className="text-[#6D5BFF] underline decoration-[#6D5BFF]/40 underline-offset-4 hover:decoration-[#6D5BFF]"
              >
                support@spendexai.com
              </a>
              . We may suspend or terminate your account at any time if we
              reasonably believe you have breached these Terms, if a payment
              fails, or if we are required to do so by law. We will give you
              at least 14 days&apos; notice unless immediate termination is
              required to prevent harm or fraud.
            </p>
            <p className="mt-4">
              On termination, your virtual card is cancelled, your service
              credentials are scheduled for deletion in line with our
              Privacy Policy, and any positive wallet balance is refunded to
              your funding source within 10 business days.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              9. Governing law
            </h2>
            <p className="mt-4">
              These Terms are governed by the laws of France, without regard
              to its conflict-of-laws rules. The Rome I Regulation applies
              to consumers in the EU, whose mandatory consumer-protection
              rights are not affected by this choice of law.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              10. Disputes
            </h2>
            <p className="mt-4">
              We prefer to resolve issues directly. Email{" "}
              <a
                href="mailto:legal@spendexai.com"
                className="text-[#6D5BFF] underline decoration-[#6D5BFF]/40 underline-offset-4 hover:decoration-[#6D5BFF]"
              >
                legal@spendexai.com
              </a>{" "}
              first and we will respond within 14 business days. If we
              cannot reach a resolution, any dispute arising out of or in
              connection with these Terms will be finally settled under the
              Rules of Arbitration of the Paris Chamber of Commerce and
              Industry by one or more arbitrators appointed in accordance
              with those rules. The seat of arbitration is Paris, France.
              The language of the arbitration is English.
            </p>
            <p className="mt-4">
              Consumers in the EU retain the right to bring proceedings in
              the courts of the member state where they are habitually
              resident, as required by Article 18 of the Brussels I
              Recast Regulation.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              11. Changes to these Terms
            </h2>
            <p className="mt-4">
              We may update these Terms from time to time. Material changes
              will be communicated by email at least 30 days before they
              take effect. Your continued use of the service after that
              date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              12. Contact
            </h2>
            <p className="mt-4">
              Spendex AI ·{" "}
              <a
                href="mailto:legal@spendexai.com"
                className="text-[#6D5BFF] underline decoration-[#6D5BFF]/40 underline-offset-4 hover:decoration-[#6D5BFF]"
              >
                legal@spendexai.com
              </a>
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
