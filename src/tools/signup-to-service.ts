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
  getAutoSignupAllowedServices,
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
import { findPlaybook } from "../lib/merchant-playbooks.js";

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

/**
 * Build the agent-facing READY TO SIGN UP response for the *passwordless*
 * (magic-link) branch. When the merchant's playbook has
 * `supports_magic_link: true`, this is strictly better than the password
 * flow: the agent requests a link from the service, polls our alias inbox
 * via `get_verification_email`, and navigates to the captured URL — the
 * user never leaves chat, no password is ever typed.
 */
function formatSignupReadyMagicLink(params: {
  service: string;
  managedAccountId: string;
  emailAlias: string;
  card: { number: string; expMonth: number; expYear: number; cvc: string };
}): string {
  const { service, managedAccountId, emailAlias, card } = params;
  const signupUrl = `https://${service}.com/signup`;
  const grouped = formatPanWithSpaces(card.number);
  const expiry = formatExpiry(card.expMonth, card.expYear);

  return (
    `READY TO SIGN UP (magic-link / passwordless)\n` +
    `\n` +
    `Service: ${service}\n` +
    `Spendex managed account ID: ${managedAccountId}\n` +
    `\n` +
    `This merchant supports passwordless signup. DO NOT type a password.\n` +
    `\n` +
    `1. Open ${signupUrl} and enter this email:\n` +
    `   Email: ${emailAlias}\n` +
    `2. Click the "Send magic link" / "Email me a link" button.\n` +
    `3. Poll get_verification_email({managed_account_id: "${managedAccountId}"}) ` +
    `until the magic-link email arrives — Spendex catches inbound mail to the alias.\n` +
    `4. Extract the magic-link URL from the email body and navigate to it.\n` +
    `\n` +
    `After verification, add this card to the billing section:\n` +
    `Card number: ${grouped}\n` +
    `Expiry: ${expiry}\n` +
    `CVC: ${card.cvc}\n` +
    `\n` +
    `When done, call complete_signup({managed_account_id: "${managedAccountId}", external_account_id: "<id from service>"})`
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
    "**Creates a brand-new account at any merchant on behalf of the user.** " +
    "TRIGGER PHRASES (case-insensitive, multi-language): \"sign me up to X\", " +
    "\"create an account at X\", \"register me on X\", \"set up X for me\", " +
    "\"get me access to X\", and the French/Spanish/German equivalents: " +
    "\"inscris-moi sur X\", \"crée-moi un compte X\", \"abonne-moi à X\" " +
    "(when the user does NOT have an account yet — otherwise use " +
    "`pay_for_service` for the recurring charge), \"créame una cuenta\", " +
    "\"meld mich an\". The agent should infer intent from natural language. " +
    "What it does: returns a Spendex-managed email alias " +
    "(`signup-<hash>@mail.spendexai.com`), an auto-generated 24-char password " +
    "stored AES-256-GCM-encrypted, and the user's virtual card. The agent " +
    "uses these via Computer Use (or via the merchant's API) to fill the " +
    "signup form — the user NEVER sees the password, NEVER receives an " +
    "email at their personal inbox, NEVER leaves the chat. " +
    "Safety: refuses unless the user has explicitly whitelisted the service " +
    "in `/dashboard/consents/preferences` (`auto_signup_allowed_services`) " +
    "OR `request_user_consent` returned an explicit approval — because " +
    "creating an account binds the user to the merchant's Terms of Service. " +
    "DO NOT call this if the user already has an account — call " +
    "`pay_for_service` directly. " +
    "Typical flow: `request_user_consent` → `signup_to_service` → run signup " +
    "form via Computer Use → `get_verification_email` → `complete_signup` → " +
    "`pay_for_service`.",
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
        // Before refusing, consult the per-service allowlist on
        // `user_consent_preferences.auto_signup_allowed_services`. A user can
        // whitelist specific trusted services (e.g. "openai", "vercel") so
        // future signups to those services bypass the consent prompt while
        // every other service still requires an explicit opt-in.
        //
        // The allowlist is NOT an override of an explicit
        // `allow_auto_signup = false` (handled above) — only of the "never
        // configured" (null) case.
        let allowedServices: string[] = [];
        try {
          allowedServices = await getAutoSignupAllowedServices(user.id);
        } catch (err) {
          // Treat a lookup failure as an empty allowlist — we'd rather fall
          // back to the consent prompt than crash the whole signup call.
          console.error(
            `[signup_to_service] allowlist lookup failed for user ${user.id}: ` +
            `${errorMessage(err, "unknown error")}. Falling back to refusal.`
          );
        }

        if (!allowedServices.includes(input.service)) {
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
            `service's Terms of Service.\n` +
            `\n` +
            `To allow Spendex to sign up to ${input.service} automatically in the future, add it to your\n` +
            `auto_signup_allowed_services in /dashboard/consents/preferences.`
          );
        }
        // Service is whitelisted — fall through to the happy path below.
        console.error(
          `[signup_to_service] service=${input.service} matched user ${user.id} allowlist; bypassing consent prompt.`
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

      // BEFORE generating a password, check whether this merchant supports
      // passwordless (magic-link) signup. When it does, the agent never types
      // a password — it asks the service to email a link, polls our alias
      // inbox via get_verification_email, and navigates to the captured URL.
      // The password column on managed_accounts stays empty in that branch.
      const playbook = findPlaybook(input.service);
      const useMagicLink = playbook?.supports_magic_link === true;
      if (useMagicLink) {
        console.error(
          `[signup_to_service] using magic-link branch for service=${input.service}`
        );
      }

      // Generate credentials. 12-char hex is 48 bits of entropy → collision-
      // free in practice across millions of aliases per user. A password is
      // still generated on the magic-link branch as a fallback in case the
      // service later asks the user to set one — it is never surfaced to the
      // agent unless the password branch is taken.
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

      if (useMagicLink) {
        return textResponse(
          formatSignupReadyMagicLink({
            service: input.service,
            managedAccountId: managed.id,
            emailAlias,
            card: cardDetails,
          })
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
