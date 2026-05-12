/**
 * signup_to_service — autonomous account creation.
 *
 * Hands an agent a fresh email alias, a strong password, and the user's
 * virtual card so it can register a brand-new account at any merchant
 * (Vercel, Modal, OpenAI, Anthropic, …) without involving the user.
 *
 * The flow is two-staged. This tool only *prepares* the credentials and
 * persists a `managed_accounts` row in 'pending_signup'. The agent runs the
 * actual signup (likely via Computer Use), optionally polls
 * `get_verification_email` for the verification mail, then closes the loop
 * with `complete_signup`.
 *
 * Output is plain text shaped for an agent — the verbatim "Use these
 * credentials" wording matters: agents copy the literal email/password from
 * the response into the merchant's form.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  createManagedAccount,
  getActiveVirtualCardForUser,
  getAutoSignupAllowance,
  getUserByMcpToken,
  logTransaction,
} from "../lib/db.js";
import {
  encryptSecret,
  generateSecurePassword,
  generateShortHash,
} from "../lib/crypto.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { retrieveCardDetails } from "../lib/stripe-issuing.js";

// Same shape every other tool validates against.
const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;
const EMAIL_DOMAIN = "mail.spendexai.com";

const SignupInput = z.object({
  service: z
    .string()
    .min(1)
    .describe(
      "Merchant or service name (e.g. 'vercel', 'modal', 'openai'). " +
      "Used for logging and to scope future tool calls to this account."
    ),
  user_intent: z
    .string()
    .min(1)
    .describe(
      "Short description of why the account is needed " +
      "(e.g. 'deploy a Next.js app'). Surfaced in the audit log."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatPanWithSpaces(pan: string): string {
  return pan.match(/.{1,4}/g)?.join(" ") ?? pan;
}

function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
}

/**
 * Build the agent-facing READY TO SIGN UP response.
 *
 * Kept as its own function so the (very specific) text shape is easy to
 * regression-test from a unit test — agents key on substrings like
 * "Card number:" and "When done, call complete_signup".
 */
function formatSignupReady(params: {
  service: string;
  managedAccountId: string;
  emailAlias: string;
  password: string;
  card: { number: string; expMonth: number; expYear: number; cvc: string };
}): string {
  const { service, managedAccountId, emailAlias, password, card } = params;
  const signupUrl = `https://${service}.com/signup`;
  const grouped = formatPanWithSpaces(card.number);
  const expiry = formatExpiry(card.expMonth, card.expYear);

  return (
    `READY TO SIGN UP\n` +
    `\n` +
    `Service: ${service}\n` +
    `Spendex managed account ID: ${managedAccountId}\n` +
    `\n` +
    `Use these credentials to sign up at ${signupUrl} :\n` +
    `Email: ${emailAlias}\n` +
    `Password: ${password}\n` +
    `\n` +
    `After verification, add this card to the billing section:\n` +
    `Card number: ${grouped}\n` +
    `Expiry: ${expiry}\n` +
    `CVC: ${card.cvc}\n` +
    `\n` +
    `When done, call complete_signup({managed_account_id: "${managedAccountId}", external_account_id: "<id from service>"})\n` +
    `If the service sends a verification email, call get_verification_email({managed_account_id: "${managedAccountId}"}) — Spendex catches inbound emails to the alias.`
  );
}

// ---------------------------------------------------------------------------
// DEV-mode response
// ---------------------------------------------------------------------------

function formatDevResponse(service: string, userIntent: string): string {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const fakeAlias = `signup-devdevdevdev@${EMAIL_DOMAIN}`;
  return (
    `[DEV MODE] signup_to_service called.\n` +
    `Service: ${service}\n` +
    `Intent: ${userIntent}\n` +
    `\n` +
    `READY TO SIGN UP (simulated)\n` +
    `\n` +
    `Spendex managed account ID: ${fakeId}\n` +
    `Email: ${fakeAlias}\n` +
    `Password: Dev!Password-Not-A-Real-Secret-32x\n` +
    `\n` +
    `Card number: 4242 4242 4242 4242\n` +
    `Expiry: 12/30\n` +
    `CVC: 123\n` +
    `\n` +
    `In production this would persist real credentials in managed_accounts and ` +
    `return them to the agent so it can register the account at ${service}.\n` +
    `Set SPENDEX_DEV=false to go live.`
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSignupToServiceTool(server: McpServer): void {
  server.tool(
    "signup_to_service",
    "Provision credentials for a brand-new account at any merchant (Vercel, " +
    "Modal, OpenAI, Anthropic, …) when the user does NOT already have one. " +
    "Returns a Spendex-managed email alias, a strong password, and the " +
    "user's virtual card so the agent can fill the merchant's signup form " +
    "via Computer Use without interrupting the user. " +
    "DO NOT call this if the user already has an account at the service — " +
    "go straight to `pay_for_service` instead. " +
    "Typical flow: `request_user_consent` → `signup_to_service` → run signup " +
    "form → `get_verification_email` → `complete_signup` → `pay_for_service`.",
    SignupInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          formatDevResponse(input.service, input.user_intent)
        );
      }

      // Rate limit before any DB read — prevents both timing probes and DB
      // hammering from a misbehaving agent.
      const rateLimit = checkRateLimit(input.mcp_token);
      if (!rateLimit.allowed) {
        const waitSeconds = Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000);
        return textResponse(
          `Too many requests. Please wait ${waitSeconds} second${waitSeconds === 1 ? "" : "s"} before trying again.`,
          { isError: true }
        );
      }

      if (config.emergencyStop) {
        return textResponse(
          "Spendex Pay is temporarily paused for maintenance. Please try again later.",
          { isError: true }
        );
      }

      if (!MCP_TOKEN_PATTERN.test(input.mcp_token)) {
        return textResponse(
          "Invalid MCP token format. A Spendex token looks like `spx_…` " +
          "(32 hex chars). Get yours at spendexai.com/dashboard/tokens.",
          { isError: true }
        );
      }

      const user = await getUserByMcpToken(input.mcp_token);
      if (!user) {
        return textResponse(
          "Invalid or expired MCP token. Please reconnect at spendexai.com/connect.",
          { isError: true }
        );
      }

      // Auto-signup requires EXPLICIT consent. Creating an account binds the
      // user to a third-party Terms of Service, so we refuse to proceed unless
      // the user has set `allow_auto_signup = true` on a rule.
      //
      //   - true  → user explicitly opted in; proceed.
      //   - false → user explicitly opted out; decline (informational).
      //   - null  → no rule configured; guide the agent to request consent
      //            inline via `request_user_consent`. This is NOT an error —
      //            it's a polite refusal pointing at the right next step.
      let allowance: boolean | null;
      try {
        allowance = await getAutoSignupAllowance(user.id);
      } catch (err) {
        return textResponse(
          `Could not verify auto-signup permission: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }
      if (allowance === false) {
        return textResponse(
          "User has explicitly disabled auto-signup. Ask the user to enable it in their Spendex dashboard rules before retrying."
        );
      }
      if (allowance !== true) {
        return textResponse(
          `AUTO-SIGNUP REQUIRES EXPLICIT CONSENT\n` +
          `\n` +
          `The user hasn't explicitly enabled auto-signup. Before this tool can create\n` +
          `an account on their behalf, you must:\n` +
          `\n` +
          `1. Call request_user_consent with action="signup_to_service", service="${input.service}",\n` +
          `   and explain why an account is needed in the context.\n` +
          `2. After the user approves, retry signup_to_service.\n` +
          `\n` +
          `This is required because creating an account binds the user legally to that\n` +
          `service's Terms of Service.`
        );
      }

      // Retrieve the card BEFORE persisting the managed_accounts row — if we
      // can't surface a usable card, there's no point creating credentials
      // the agent can't actually use to complete the signup.
      const cardRecord = await getActiveVirtualCardForUser(user.id);
      if (!cardRecord) {
        return textResponse(
          "No active virtual card on file. Ask the user to provision one at spendexai.com/dashboard/payments.",
          { isError: true }
        );
      }

      let cardDetails;
      try {
        cardDetails = await retrieveCardDetails(cardRecord.stripe_card_id);
      } catch (err) {
        return textResponse(
          `Could not retrieve card details: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      // Generate credentials. 12-char hex is 48 bits of entropy → collision-
      // free in practice across millions of aliases per user.
      const shortHash = generateShortHash(6);
      const emailAlias = `signup-${shortHash}@${EMAIL_DOMAIN}`;
      const password = generateSecurePassword(32);

      let managed;
      try {
        managed = await createManagedAccount({
          userId: user.id,
          service: input.service,
          emailAlias,
          passwordEncrypted: encryptSecret(password),
        });
      } catch (err) {
        return textResponse(
          `Could not create managed account record: ${errorMessage(err, "unknown error")}. ` +
          `No credentials were issued.`,
          { isError: true }
        );
      }

      // Audit log the intent. We deliberately do not include the password or
      // email alias here — those live in `managed_accounts` only. The audit
      // log is a non-fatal write: a failure to log is unfortunate but the
      // credentials have already been issued, so we cannot roll back.
      try {
        await logTransaction({
          userId: user.id,
          service: input.service,
          status: "success",
          amountUsd: 0,
          description: `Auto-signup initiated: ${input.user_intent}`,
          transactionType: "managed_signup",
          agentId: managed.id,
        });
      } catch (logErr) {
        console.error(
          `[signup_to_service] audit log write failed for managed_account ${managed.id}: ` +
          `${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(
        formatSignupReady({
          service: input.service,
          managedAccountId: managed.id,
          emailAlias,
          password,
          card: cardDetails,
        })
      );
    }
  );
}
