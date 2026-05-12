import Link from "next/link";
import type { Metadata } from "next";
import Footer from "@/app/components/Footer";

export const metadata: Metadata = {
  title: "Refund Policy",
  description:
    "How Spendex AI handles refunds for unauthorised charges and third-party service payments.",
};

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

export default function RefundPolicyPage() {
  return (
    <div className="min-h-screen bg-[#070d18] text-white antialiased">
      <Navbar />

      <main className="mx-auto max-w-[700px] px-6 pt-32 pb-20">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#00e5b4]">
          Legal
        </p>
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Refund Policy
        </h1>
        <p className="mt-4 text-sm text-white/40">Last updated: 12 May 2026</p>

        <div className="mt-12 space-y-12 text-[15px] leading-relaxed text-white/70">
          <section>
            <p>
              We want every charge made through Spendex Pay to be one you
              recognise and agreed to. This policy explains how we handle
              refund requests, what to expect in each situation, and how
              quickly we respond.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              1. Unauthorised charges
            </h2>
            <p className="mt-4">
              If a charge appears on your Spendex wallet that you did not
              authorise — whether because your account was compromised,
              because spending rules failed, or because an agent acted
              outside your consent — we will:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                Issue a full refund <strong className="text-white">
                  instantly
                </strong>{" "}
                to your funding source upon confirming the charge is
                unauthorised. In most cases this is done within minutes of
                you reporting the issue.
              </li>
              <li>
                Freeze your virtual card to prevent further unauthorised
                use, and issue a replacement card on request.
              </li>
              <li>
                Open an internal investigation, including a full review of
                audit logs and consent records, and provide you with a
                written report within 7 business days.
              </li>
              <li>
                Where applicable, file a chargeback with the merchant on
                your behalf.
              </li>
            </ul>
            <p className="mt-4">
              You will not be charged any fee for reporting an
              unauthorised transaction. To report one, email{" "}
              <a
                href="mailto:support@spendexai.com"
                className="text-[#00e5b4] underline decoration-[#00e5b4]/40 underline-offset-4 hover:decoration-[#00e5b4]"
              >
                support@spendexai.com
              </a>{" "}
              with the transaction ID and a short description.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              2. Charges on third-party services
            </h2>
            <p className="mt-4">
              When your agent uses Spendex Pay to pay for a third-party
              service (for example a Vercel subscription, a Modal credit
              top-up, or an OpenAI plan), the merchant&apos;s own refund
              policy governs whether and how much can be refunded.
            </p>
            <p className="mt-4">
              We can help in two ways:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                <strong className="text-white">Mediation.</strong> We will
                contact the merchant on your behalf, share the relevant
                transaction and audit records, and pursue a refund through
                the merchant&apos;s normal channels.
              </li>
              <li>
                <strong className="text-white">Chargebacks.</strong> If
                mediation does not succeed and you believe the charge
                qualifies (e.g. service not delivered, product materially
                different from described), we can initiate a chargeback
                through Stripe Issuing. Chargebacks typically take 30 to 90
                days to resolve.
              </li>
            </ul>
            <p className="mt-4">
              We cannot guarantee a refund from the third-party service,
              but we will document every step of the process for you.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              3. Failed signups or partial deliveries
            </h2>
            <p className="mt-4">
              If Spendex was unable to complete a signup that you
              authorised — for example because the third-party service
              rejected the email alias or the signup flow changed — but the
              merchant charged your card anyway, we will refund the
              charge within 7 business days and credit any platform fee we
              applied for that signup.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              4. Service-level agreement
            </h2>
            <p className="mt-4">
              We aim to acknowledge every refund request within 1 business
              day and reach a resolution (either a refund, a denial with
              reasons, or an update on chargeback progress) within 7
              business days. If a case is more complex — typically because
              it depends on a third-party merchant — we will tell you and
              keep you updated at least weekly until it is closed.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              5. How to request a refund
            </h2>
            <p className="mt-4">
              Email{" "}
              <a
                href="mailto:support@spendexai.com"
                className="text-[#00e5b4] underline decoration-[#00e5b4]/40 underline-offset-4 hover:decoration-[#00e5b4]"
              >
                support@spendexai.com
              </a>{" "}
              with:
            </p>
            <ul className="mt-4 list-disc space-y-2 pl-6">
              <li>
                The <strong className="text-white">transaction ID</strong>
                {" "}(visible in your dashboard under Transactions).
              </li>
              <li>The merchant name and amount.</li>
              <li>
                A brief description of why you are requesting a refund
                (unauthorised, service not delivered, duplicate charge,
                etc.).
              </li>
              <li>
                If the charge relates to a third-party service signup, the
                service name and the date of the consent prompt you
                approved (if any).
              </li>
            </ul>
            <p className="mt-4">
              You can also start a refund request directly from any line
              item on your dashboard&apos;s Transactions page.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">
              6. Your statutory rights
            </h2>
            <p className="mt-4">
              This policy is in addition to — not instead of — your
              statutory consumer rights under EU law, including the
              14-day right of withdrawal for distance contracts where it
              applies. Nothing in this policy limits those rights.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold text-white">7. Contact</h2>
            <p className="mt-4">
              Spendex AI ·{" "}
              <a
                href="mailto:support@spendexai.com"
                className="text-[#00e5b4] underline decoration-[#00e5b4]/40 underline-offset-4 hover:decoration-[#00e5b4]"
              >
                support@spendexai.com
              </a>
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
