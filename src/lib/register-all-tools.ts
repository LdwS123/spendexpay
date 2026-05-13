// Shared tool registration helper used by both the stdio entry point
// (src/index.ts) and the HTTP entry point (src/http-server.ts).
//
// Keeping all `registerXxxTool` calls in one place guarantees the two
// transports expose the exact same surface area to MCP clients — there is
// no chance of one transport silently shipping with a different set of
// tools than the other.
//
// Registration order is identical to the original src/index.ts so any MCP
// client that lists tools sees the same ordering (PRIMARY, then
// INTROSPECTION, then LEGACY fallback).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { loadWidgetHtml } from "./widgets.js";

// Primary surface — universal tools agents should reach for first.
import { registerPayForServiceTool } from "../tools/pay-for-service.js";
import { registerSubscribeService } from "../tools/subscribe-service.js";
import { registerCancelSubscriptionTool } from "../tools/cancel-subscription.js";
import { registerListSubscriptionsTool } from "../tools/list-subscriptions.js";
import { registerFetchProductPreviewTool } from "../tools/fetch-product-preview.js";
import { registerGetProductVariantsTool } from "../tools/get-product-variants.js";
import { registerSearchProductsTool } from "../tools/search-products.js";
import { registerSignupToServiceTool } from "../tools/signup-to-service.js";
import {
  registerRequestConsentTool,
  CONSENT_DIALOG_RESOURCE_URI,
} from "../tools/request-consent.js";
import { registerSubmitConsentDecisionTool } from "../tools/submit-consent.js";
import { registerCheckConsentStatusTool } from "../tools/check-consent-status.js";
import { registerGetVerificationEmailTool } from "../tools/get-verification-email.js";
import { registerGetSmsCodeTool } from "../tools/get-sms-code.js";
import { registerCompleteSignupTool } from "../tools/complete-signup.js";
import { registerGrantOAuthToServiceTool } from "../tools/grant-oauth-to-service.js";
import { registerPrepareCheckoutTool } from "../tools/prepare-checkout.js";
import { registerPrepareAmazonCheckoutTool } from "../tools/prepare-amazon-checkout.js";
import { registerCompletePurchaseTool } from "../tools/complete-purchase.js";

// Introspection — agent self-monitoring.
import { registerCheckBalanceTool } from "../tools/check-balance.js";
import { registerCheckRulesTool } from "../tools/check-rules.js";
import { registerListServicesTool } from "../tools/list-services.js";
import { registerCheckAnomaliesTool } from "../tools/check-anomalies.js";
import { registerClassifyPurchaseIntentTool } from "../tools/classify-purchase-intent.js";

// Legacy fallbacks — kept for backwards compatibility. Prefer pay_for_service.
import { registerDeployVercelTool } from "../tools/deploy-vercel.js";
import { registerDeployRailwayTool } from "../tools/deploy-railway.js";
import { registerDeployFlyioTool } from "../tools/deploy-flyio.js";
import { registerDeployRenderTool } from "../tools/deploy-render.js";
import { registerDeployNetlifyTool } from "../tools/deploy-netlify.js";
import { registerDeployCloudflareTool } from "../tools/deploy-cloudflare.js";
import { registerRunModalTool } from "../tools/run-modal.js";
import { registerRunReplicateTool } from "../tools/run-replicate.js";
import { registerRunHuggingFaceInferenceTool } from "../tools/run-huggingface-inference.js";
import { registerSubscribeServiceTool } from "../tools/subscribe-service.js";
import { registerTopUpServiceTool } from "../tools/top-up-service.js";
import { registerGenerateGammaTool } from "../tools/generate-gamma.js";
import { registerProvisionSupabaseProjectTool } from "../tools/provision-supabase-project.js";

/**
 * Register every Spendex Pay tool + MCP App resource on the given server.
 *
 * Order matches src/index.ts: PRIMARY → INTROSPECTION → LEGACY → resources.
 * Both transports call this helper, so any new tool added here is
 * automatically available via stdio AND HTTP without further wiring.
 */
export function registerAllTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // PRIMARY: the universal surface. Registered first so MCP clients listing
  // tools encounter them at the top of the list. pay_for_service and
  // signup_to_service replace the per-merchant tools below for any new
  // integration. The consent + email helpers complete the auto-signup flow.
  // ---------------------------------------------------------------------------
  registerPayForServiceTool(server);
  // Recurring charges sit right after pay_for_service in the PRIMARY surface
  // so the universal one-shot + recurring pair show up together when agents
  // list tools. cancel + list complete the lifecycle.
  registerSubscribeService(server);
  registerCancelSubscriptionTool(server);
  registerListSubscriptionsTool(server);
  registerFetchProductPreviewTool(server);
  // get_product_variants sits directly after fetch_product_preview so a
  // shopping agent calls them as a natural pair: preview to confirm the
  // product, then variants to surface color/size/storage choices before
  // request_user_consent.
  registerGetProductVariantsTool(server);
  // search_products: discovery step that runs BEFORE fetch_product_preview
  // when the user describes what they want but has not pasted a URL. Sits
  // here in PRIMARY so MCP clients see the natural product-shopping flow
  // (search -> preview -> consent -> pay) in source order.
  registerSearchProductsTool(server);
  registerSignupToServiceTool(server);
  registerRequestConsentTool(server);
  registerSubmitConsentDecisionTool(server);
  registerCheckConsentStatusTool(server);
  registerGetVerificationEmailTool(server);
  // get_sms_code is the SMS counterpart to get_verification_email. Same
  // shape (server-side poll, returns the latest unconsumed code) but reads
  // from the Twilio inbound-SMS pipeline (virtual_phones / sms_messages).
  registerGetSmsCodeTool(server);
  registerCompleteSignupTool(server);
  // grant_oauth_to_service sits next to complete_signup because it lives on
  // the same canonical "agent signs the user up at a new service" path —
  // just the OAuth branch instead of the email/password branch. Pre-auth
  // broker (src/lib/oauth-broker/) is currently stubbed; tool is registered
  // so MCP clients can discover it and start integrating against the surface.
  registerGrantOAuthToServiceTool(server);
  // Merchant-specific Computer-Use playbooks + the post-checkout reporter that
  // closes the loop. Live in PRIMARY because they sit on the canonical
  // "agent shops at a non-API merchant" flow that v0.2 expects. The universal
  // `prepare_checkout` is registered BEFORE the Amazon-only legacy alias so
  // MCP clients listing tools encounter the generalized surface first.
  registerPrepareCheckoutTool(server);
  registerPrepareAmazonCheckoutTool(server);
  registerCompletePurchaseTool(server);

  // ---------------------------------------------------------------------------
  // INTROSPECTION: state queries an agent runs *before* committing to a charge
  // (balance, rules, supported services). Never moves money on their own.
  // ---------------------------------------------------------------------------
  registerCheckBalanceTool(server);
  registerCheckRulesTool(server);
  registerListServicesTool(server);
  registerCheckAnomaliesTool(server);
  // Smart-rules preview — agents call this to "self-check" a purchase
  // intent (category / urgency / risk score) before committing to
  // pay_for_service. Sits in INTROSPECTION because it never moves money.
  registerClassifyPurchaseIntentTool(server);

  // ---------------------------------------------------------------------------
  // LEGACY FALLBACK: per-merchant tools kept for backwards compatibility.
  // ---------------------------------------------------------------------------
  registerDeployVercelTool(server);
  registerDeployRailwayTool(server);
  registerDeployFlyioTool(server);
  registerDeployRenderTool(server);
  registerDeployNetlifyTool(server);
  registerDeployCloudflareTool(server);
  registerRunModalTool(server);
  registerRunReplicateTool(server);
  registerRunHuggingFaceInferenceTool(server);
  registerSubscribeServiceTool(server);
  registerTopUpServiceTool(server);
  registerGenerateGammaTool(server);
  registerProvisionSupabaseProjectTool(server);

  // ---------------------------------------------------------------------------
  // MCP APP UI RESOURCES: HTML widgets served alongside the tools above. Hosts
  // that implement the MCP Apps surface render these inline in chat; hosts
  // that don't simply ignore the `_meta.ui` field declared on the
  // corresponding tool and fall back to the tool's text output.
  // ---------------------------------------------------------------------------
  const consentDialogHtml = loadWidgetHtml("consent-dialog.html");
  registerAppResource(
    server,
    "Spendex Consent Dialog",
    CONSENT_DIALOG_RESOURCE_URI,
    {
      description:
        "Spendex-branded consent dialog rendered inline when the agent calls " +
        "request_user_consent. Shows the action, service, amount, current " +
        "spending rules, and Approve/Decline buttons.",
    },
    async () => ({
      contents: [
        {
          uri: CONSENT_DIALOG_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: consentDialogHtml,
        },
      ],
    })
  );
}
