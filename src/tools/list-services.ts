import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Public information — no auth required.
//
// Two categories:
//   - First-class: Spendex has a dedicated MCP tool that handles the charge
//     AND drives the service API directly (e.g. `deploy_to_vercel`).
//   - Card-accepted: services where the Spendex virtual card works as a normal
//     payment method, even though we don't yet expose a service-specific tool.
//     The agent can either ask the user to paste the card details or use
//     `subscribe_to_service` / `add_service_credits` once that surface is
//     wired up end-to-end.
const FIRST_CLASS_SERVICES = [
  "Vercel",
  "Netlify",
  "Railway",
  "Fly.io",
  "Render",
  "Cloudflare",
  "Modal",
  "Replicate",
  "Hugging Face",
  "Gamma",
  "Supabase",
] as const;

const CARD_ACCEPTED_SERVICES = [
  "OpenAI",
  "Anthropic API",
  "GitHub Pro",
  "AWS",
  "GCP",
  "Azure",
  "DigitalOcean",
  "Linode",
  "Heroku",
  "PlanetScale",
  "Neon",
  "Upstash",
  "Cursor",
  "Windsurf",
  "Codex",
] as const;

function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function registerListServicesTool(server: McpServer): void {
  server.tool(
    "list_supported_services",
    "List the developer services Spendex Pay can charge for, split into " +
    "first-class (dedicated MCP tool drives the API end-to-end) and " +
    "card-accepted (the Spendex virtual card works as a normal payment " +
    "method at checkout). Public information — no auth required. Use when " +
    "the agent is unsure whether a given merchant is supported before " +
    "calling `pay_for_service` or `signup_to_service`.",
    {},
    async () => {
      const firstClass = FIRST_CLASS_SERVICES.join(", ");
      const cardAccepted = CARD_ACCEPTED_SERVICES.join(", ");
      return textResponse(
        `Spendex Pay works as a payment method on the following services.\n\n` +
        `First-class (dedicated MCP tool — no card details needed): ${firstClass}.\n\n` +
        `Card-accepted (Spendex virtual card works at checkout): ${cardAccepted}.\n\n` +
        `Generic flows: use \`subscribe_to_service\` for recurring plans and ` +
        `\`add_service_credits\` for one-off top-ups. Full list and limits at ` +
        `spendexai.com/services.`
      );
    }
  );
}
