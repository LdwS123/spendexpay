/**
 * Merchant playbook registry — Computer-Use checkout instructions.
 *
 * Each playbook is a deterministic, browser-automatable script that walks an
 * agent (Claude Code computer-use, ChatGPT Operator, Browser Use, …) through a
 * specific merchant's checkout flow: add to cart, navigate to checkout, fill
 * the payment form with the Spendex virtual card, confirm the order, capture
 * the order ID. Spendex itself never moves money in these flows — the real
 * charge is captured later by Stripe Issuing when the merchant authorizes
 * against the virtual card, and our issuing webhook approves or declines
 * against the user's spending rules.
 *
 * The whole point of the registry is to amortize the cost of "agent figures
 * out where to click" across all users. Curated CSS selectors + URL sequences
 * cut token spend dramatically vs letting the agent re-explore Amazon every
 * single run. When a merchant isn't curated, we fall back to a generic
 * playbook + a warning so the agent knows to extract selectors itself.
 *
 * Adding a new merchant = add a `MerchantPlaybook` to the array below. No
 * other code change is required. See docs/merchant-playbooks.md for selector
 * patterns and gotcha conventions.
 */

export interface PlaybookStep {
  step: number;
  action:
    | "navigate"
    | "click"
    | "type"
    | "select"
    | "wait"
    | "verify"
    | "extract"
    | "report";
  target_url?: string;
  selector?: string;
  // Value to type/select. May contain {placeholders} like {card_number},
  // {card_exp_month}, {card_exp_year}, {card_cvc}, {cardholder}, {email},
  // {password}, {billing_zip}, {product_url}, {quantity}. The
  // prepare_checkout tool substitutes these before rendering the playbook.
  value?: string;
  wait_ms?: number;
  // Human-readable description shown verbatim in the rendered playbook so
  // the agent always has a fallback when selectors break.
  description: string;
  // Known issues / A-B test variants / gotchas specific to this step.
  gotchas?: string[];
  // True if this step depends on the playbook having been issued credentials
  // (i.e. login_strategy === "spendex_managed"). Skipped for guest / user
  // checkouts.
  requires_login?: boolean;
}

export interface MerchantPlaybook {
  merchant_id: string;
  display_name: string;
  domains: string[];
  // "full" — checkout is fully scripted, login + payment + confirmation
  // covered. "card_only" — agent must log in manually (or use guest), we
  // only script the card form. "manual" — no automation; instructions are
  // generic and the agent must explore.
  supported: "full" | "card_only" | "manual";
  // How the playbook expects authentication to happen at checkout time.
  login_strategy: "spendex_managed" | "user_existing" | "guest_checkout";
  steps: PlaybookStep[];
  known_issues: string[];
  fallback_instructions: string;
}

/**
 * Static registry. Order doesn't matter — lookups are by merchant_id or
 * domain match. To add a merchant, append a new entry below.
 */
export const MERCHANT_PLAYBOOKS: MerchantPlaybook[] = [
  // ---------------------------------------------------------------------------
  // Amazon — full flow, Spendex-managed account by default. Extracted from
  // the original prepare-amazon-checkout.ts.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "amazon",
    display_name: "Amazon.com",
    domains: ["amazon.com", "amazon.fr", "amazon.de", "amazon.co.uk", "amazon.es", "amazon.it"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://www.amazon.com/ap/signin",
        description:
          "Open Amazon sign-in. If already logged in this redirects to the home page; that's fine.",
        requires_login: true,
        gotchas: [
          "If the page redirects to amazon.fr/.de/.co.uk, force amazon.com via the bottom-of-page 'Change country/region' link — the managed account is bound to amazon.com.",
        ],
      },
      {
        step: 2,
        action: "type",
        selector: "#ap_email",
        value: "{email}",
        description: "Fill the email field with the Spendex-managed account address.",
        requires_login: true,
      },
      {
        step: 3,
        action: "click",
        selector: "#continue",
        description: "Click the 'Continue' button to advance to the password page.",
        requires_login: true,
      },
      {
        step: 4,
        action: "type",
        selector: "#ap_password",
        value: "{password}",
        description: "Fill the password field.",
        requires_login: true,
      },
      {
        step: 5,
        action: "click",
        selector: "#signInSubmit",
        description: "Click the 'Sign in' button.",
        requires_login: true,
        gotchas: [
          "If Amazon presents a 2FA / SMS OTP page (URL contains /ap/mfa or /ap/cvf), ABORT and call request_user_consent({action:'other', service:'amazon', context:'Amazon SMS 2FA challenge'}). Do not guess the code.",
          "If a captcha is shown, ABORT and surface to the user — do not attempt to solve.",
        ],
      },
      {
        step: 6,
        action: "navigate",
        target_url: "{product_url}",
        description: "Navigate to the product detail page.",
      },
      {
        step: 7,
        action: "click",
        selector: '[id*="_name"] [title*="{variant}" i]',
        description:
          "If the product has variants (color/size/style), pick the swatch matching variant_options. Selectors vary per axis: try [id*=\"color_name\"], [id*=\"size_name\"], or aria-label matches.",
        gotchas: [
          "Variant selectors are A/B-tested heavily. If the exact selector misses, fall back to any clickable element whose visible text or aria-label matches the variant value.",
        ],
      },
      {
        step: 8,
        action: "select",
        selector: "#quantity",
        value: "{quantity}",
        description: "Set the quantity dropdown.",
        gotchas: [
          "The #quantity dropdown maxes out at 30. Higher values require the 'Quantity: 30+' link.",
        ],
      },
      {
        step: 9,
        action: "click",
        selector: "#add-to-cart-button",
        description: "Click 'Add to Cart'.",
      },
      {
        step: 10,
        action: "verify",
        selector: "#huc-v2-order-row-confirm-text, #nav-cart-count",
        description:
          "Wait for the 'Added to Cart' banner OR confirm #nav-cart-count incremented by the quantity.",
      },
      {
        step: 11,
        action: "click",
        selector: "#hlb-ptc-btn-native",
        description:
          "Click 'Proceed to checkout'. Falls back to navigating to https://www.amazon.com/gp/cart/view.html and clicking 'Proceed to checkout'.",
      },
      {
        step: 12,
        action: "click",
        selector: 'input[name="addCreditCardNumber"]',
        description:
          "On the payment step, focus the card-number field for the Spendex virtual card.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="addCreditCardNumber"]',
        value: "{card_number}",
        description: "Type the virtual card number.",
      },
      {
        step: 14,
        action: "type",
        selector: 'input[name="addCreditCardName"]',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 15,
        action: "select",
        selector: 'select[name="ccMonth"]',
        value: "{card_exp_month}",
        description: "Select the expiry month.",
      },
      {
        step: 16,
        action: "select",
        selector: 'select[name="ccYear"]',
        value: "{card_exp_year}",
        description: "Select the expiry year.",
      },
      {
        step: 17,
        action: "type",
        selector: 'input[name="addCreditCardVerificationNumber"]',
        value: "{card_cvc}",
        description: "Type the CVV.",
      },
      {
        step: 18,
        action: "click",
        selector: "#placeYourOrder1, button[name='placeYourOrder1'], #submitOrderButtonId button",
        description:
          "Click 'Place your order'. Verify the total is at or below the Stripe Issuing cap before clicking.",
        gotchas: [
          "If the total exceeds the per-authorization cap, ABORT and call request_user_consent with the actual total.",
        ],
      },
      {
        step: 19,
        action: "extract",
        selector: "span#orderId",
        description:
          "Capture the order ID. Falls back to scraping the page text with /Order #\\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/.",
      },
      {
        step: 20,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'amazon', external_order_id, amount_usd, mcp_token}) to close the loop.",
      },
    ],
    known_issues: [
      "Amazon may show a 'Choose a different shipping speed' page. Pick 'Standard' (cheapest) unless the user asked otherwise.",
      "2FA / SMS OTP: ABORT on /ap/mfa or /ap/cvf pages.",
      "Captcha: ABORT, surface to the user.",
      "Buy Now (express) skips the cart entirely — only safe if address + card are already on file.",
      "Region redirects to amazon.fr / .de / .co.uk — managed account is bound to amazon.com only.",
    ],
    fallback_instructions:
      "If any selector fails, find the visually-equivalent element by text content (e.g. button containing 'Place your order'). Amazon's selectors drift across A/B test buckets — always have a text-based fallback ready.",
  },

  // ---------------------------------------------------------------------------
  // Walmart — similar large-retailer flow. Walmart's selectors are more stable
  // than Amazon's but logged-in checkout requires phone OTP, so the default
  // login strategy is guest_checkout.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "walmart",
    display_name: "Walmart.com",
    domains: ["walmart.com"],
    supported: "full",
    login_strategy: "guest_checkout",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "{product_url}",
        description: "Navigate to the Walmart product page.",
      },
      {
        step: 2,
        action: "click",
        selector: '[data-automation-id="variant-picker"] button',
        description:
          "Pick the variant if applicable. Walmart uses [data-automation-id] for most interactive elements.",
      },
      {
        step: 3,
        action: "select",
        selector: 'select[aria-label="Quantity"]',
        value: "{quantity}",
        description: "Set the quantity dropdown.",
      },
      {
        step: 4,
        action: "click",
        selector: 'button[data-automation-id="atc"]',
        description: "Click 'Add to cart'.",
      },
      {
        step: 5,
        action: "navigate",
        target_url: "https://www.walmart.com/cart",
        description: "Navigate to the cart page.",
      },
      {
        step: 6,
        action: "click",
        selector: 'button[data-automation-id="checkout-btn"]',
        description: "Click 'Continue to checkout'.",
      },
      {
        step: 7,
        action: "click",
        selector: 'button[data-testid="continue-as-guest"]',
        description: "Choose 'Continue as guest' to avoid Walmart's phone OTP login.",
        gotchas: [
          "If Walmart forces login (some carts require an account), ABORT and call request_user_consent.",
        ],
      },
      {
        step: 8,
        action: "type",
        selector: 'input[name="cardNumber"]',
        value: "{card_number}",
        description: "Type the virtual card number into Walmart's payment form.",
      },
      {
        step: 9,
        action: "type",
        selector: 'input[name="expiry"]',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="cvv"]',
        value: "{card_cvc}",
        description: "Type the CVV.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="nameOnCard"]',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 12,
        action: "click",
        selector: 'button[data-automation-id="place-order"]',
        description: "Click 'Place order'.",
      },
      {
        step: 13,
        action: "extract",
        selector: '[data-testid="order-number"]',
        description: "Capture the order number from the thank-you page.",
      },
      {
        step: 14,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'walmart', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "Walmart shows a delivery / pickup picker before checkout — default to 'Shipping' unless the user asked otherwise.",
      "Some items require a Walmart+ membership for free shipping; agent should NOT enroll the user.",
    ],
    fallback_instructions:
      "Walmart selectors use [data-automation-id] consistently. If a selector fails, search the DOM for an element whose data-automation-id contains the action keyword (e.g. 'checkout', 'atc', 'place-order').",
  },

  // ---------------------------------------------------------------------------
  // Best Buy — desktop site, account optional. Different selector conventions
  // (mostly className-based with semantic suffixes).
  // ---------------------------------------------------------------------------
  {
    merchant_id: "bestbuy",
    display_name: "Best Buy",
    domains: ["bestbuy.com"],
    supported: "full",
    login_strategy: "guest_checkout",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "{product_url}",
        description: "Navigate to the Best Buy product page.",
      },
      {
        step: 2,
        action: "click",
        selector: ".add-to-cart-button",
        description: "Click 'Add to Cart'.",
        gotchas: [
          "Best Buy sometimes shows a 'Sold out' state instead of the add-to-cart button. Verify before clicking.",
        ],
      },
      {
        step: 3,
        action: "navigate",
        target_url: "https://www.bestbuy.com/cart",
        description: "Navigate to the cart page.",
      },
      {
        step: 4,
        action: "click",
        selector: 'button.btn-primary[data-track="Checkout - Top"]',
        description: "Click the primary 'Checkout' button at the top of the cart.",
      },
      {
        step: 5,
        action: "click",
        selector: '[data-track="Guest Checkout"]',
        description: "Choose guest checkout.",
      },
      {
        step: 6,
        action: "type",
        selector: '#cc-number',
        value: "{card_number}",
        description: "Type the virtual card number.",
      },
      {
        step: 7,
        action: "select",
        selector: '#expirationMonth',
        value: "{card_exp_month}",
        description: "Select the expiry month.",
      },
      {
        step: 8,
        action: "select",
        selector: '#expirationYear',
        value: "{card_exp_year}",
        description: "Select the expiry year.",
      },
      {
        step: 9,
        action: "type",
        selector: '#cvv',
        value: "{card_cvc}",
        description: "Type the CVV.",
      },
      {
        step: 10,
        action: "click",
        selector: 'button.btn-primary[data-track="Place Your Order"]',
        description: "Click 'Place Your Order'.",
      },
      {
        step: 11,
        action: "extract",
        selector: ".order-number",
        description: "Capture the order number from the thank-you page.",
      },
      {
        step: 12,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'bestbuy', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "Best Buy uses Akamai bot detection — driving with headless browsers may trigger a 'Pardon the interruption' page. ABORT if seen.",
      "Apple-specific items sometimes require pickup-only — verify shipping is available before adding to cart.",
    ],
    fallback_instructions:
      "Best Buy mixes data-track attributes with className selectors. If a selector fails, fall back to button text matching ('Checkout', 'Place Your Order', 'Guest').",
  },

  // ---------------------------------------------------------------------------
  // eBay — buy-it-now path only. Auctions are out of scope for autonomous
  // agent purchases because they require bidding strategy.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "ebay",
    display_name: "eBay",
    domains: ["ebay.com", "ebay.fr", "ebay.de", "ebay.co.uk"],
    supported: "card_only",
    login_strategy: "user_existing",
    steps: [
      {
        step: 1,
        action: "verify",
        description:
          "Verify the listing is 'Buy It Now', NOT an auction. Agents must not place bids — if the listing is auction-only, ABORT and call request_user_consent({action:'other', service:'ebay', context:'Auction listing — bidding requires manual strategy'}).",
      },
      {
        step: 2,
        action: "navigate",
        target_url: "{product_url}",
        description: "Navigate to the eBay listing.",
      },
      {
        step: 3,
        action: "click",
        selector: 'a[data-testid="x-bin-action__btn"], #binBtn_btn',
        description: "Click 'Buy It Now'.",
      },
      {
        step: 4,
        action: "verify",
        description:
          "If eBay prompts for login, the user must be already signed in on this browser session — login_strategy is 'user_existing'.",
      },
      {
        step: 5,
        action: "click",
        selector: 'button[aria-label*="payment"], button.payment-method__add-button',
        description: "Click 'Add new card' or the equivalent under payment options.",
      },
      {
        step: 6,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber',
        value: "{card_number}",
        description: "Type the virtual card number.",
      },
      {
        step: 7,
        action: "type",
        selector: 'input[name="expiryDate"], input#expiryDate',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 8,
        action: "type",
        selector: 'input[name="cvv"], input#cvv',
        value: "{card_cvc}",
        description: "Type the CVV.",
      },
      {
        step: 9,
        action: "click",
        selector: 'button[data-testid="confirm-and-pay"], button#confirm-button',
        description: "Click 'Confirm and pay'.",
      },
      {
        step: 10,
        action: "extract",
        selector: '[data-testid="order-confirmation-number"]',
        description: "Capture the order confirmation number.",
      },
      {
        step: 11,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'ebay', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "eBay listings can be auction-only — ALWAYS verify Buy-It-Now is available before proceeding.",
      "Sellers can require contact at purchase (custom auctions) — ABORT if seen.",
      "International sellers may require a verified PayPal account; the virtual card may decline.",
    ],
    fallback_instructions:
      "eBay's checkout iframe is heavily A/B tested. If the curated selectors miss, find the payment form by its labels: 'Card number', 'Expiration date', 'Security code'.",
  },

  // ---------------------------------------------------------------------------
  // Generic Stripe Checkout — covers any merchant using Stripe's hosted
  // checkout page or Stripe Elements. The selectors below are stable across
  // Stripe's product surface.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "generic_stripe_checkout",
    display_name: "Generic Stripe Checkout",
    domains: ["checkout.stripe.com"],
    supported: "card_only",
    login_strategy: "guest_checkout",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "{product_url}",
        description:
          "Navigate to the merchant's Stripe Checkout page. The URL is typically https://checkout.stripe.com/c/pay/... or an embedded element on the merchant site.",
      },
      {
        step: 2,
        action: "type",
        selector: 'input[name="email"], input#email',
        value: "{email}",
        description: "If Stripe Checkout asks for an email, use the Spendex user's email.",
      },
      {
        step: 3,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber, .PaymentElement-input[name="cardNumber"]',
        value: "{card_number}",
        description:
          "Type the virtual card number into Stripe's PaymentElement. May be inside an iframe with src containing 'js.stripe.com'.",
      },
      {
        step: 4,
        action: "type",
        selector: 'input[name="cardExpiry"], input#cardExpiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY into Stripe's expiry field.",
      },
      {
        step: 5,
        action: "type",
        selector: 'input[name="cardCvc"], input#cardCvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 6,
        action: "type",
        selector: 'input[name="billingName"], input#billingName',
        value: "{cardholder}",
        description: "Type the cardholder name if requested.",
      },
      {
        step: 7,
        action: "type",
        selector: 'input[name="billingPostalCode"], input#billingPostalCode',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 8,
        action: "click",
        selector: 'button[data-testid="hosted-payment-submit-button"], button.SubmitButton',
        description: "Click the primary 'Pay' button.",
        gotchas: [
          "Stripe Checkout sometimes triggers 3D Secure (a popup or redirect). If a 3DS challenge appears, ABORT and call request_user_consent({action:'other', service:'<merchant>', context:'3D Secure challenge'}).",
        ],
      },
      {
        step: 9,
        action: "extract",
        description:
          "Capture the receipt or confirmation reference. Stripe Checkout typically redirects to the merchant's success URL — extract whatever order ID is shown.",
      },
      {
        step: 10,
        action: "report",
        description:
          "Call complete_purchase({merchant: '<merchant>', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "Stripe inputs are usually rendered inside iframes — agents must switch frame context before typing.",
      "3D Secure challenges cannot be solved by the agent — surface to the user.",
      "Some merchants disable saving the card by default; this is fine because Spendex uses a one-shot virtual card anyway.",
    ],
    fallback_instructions:
      "Stripe's PaymentElement uses stable input names (cardNumber, cardExpiry, cardCvc). If a curated selector fails, fall back to those name attributes inside any iframe whose src contains 'stripe.com'.",
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort lookup of a curated playbook for a given merchant input.
 *
 * Accepts either a canonical merchant_id ("amazon", "walmart") or any URL
 * string — in which case we match by domain. Returns null when nothing in
 * the registry matches; callers should fall back to the generic playbook.
 */
export function findPlaybook(merchantOrUrl: string): MerchantPlaybook | null {
  const normalized = merchantOrUrl.trim().toLowerCase();
  if (normalized.length === 0) return null;

  // Direct merchant_id hit.
  const direct = MERCHANT_PLAYBOOKS.find((p) => p.merchant_id === normalized);
  if (direct) return direct;

  // Domain match — extract the hostname from URL-shaped inputs, otherwise
  // treat the whole string as a domain candidate.
  let host = normalized;
  try {
    if (normalized.includes("://")) {
      host = new URL(normalized).hostname.toLowerCase();
    }
  } catch {
    // Fall through — treat as bare domain.
  }
  host = host.replace(/^www\./, "");

  for (const playbook of MERCHANT_PLAYBOOKS) {
    for (const domain of playbook.domains) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        return playbook;
      }
    }
  }
  return null;
}

/**
 * Generic "I don't know this merchant" playbook. Used as a fallback when
 * `findPlaybook` returns null. Lays out the universal sequence: navigate,
 * find the payment form, type the card, confirm.
 *
 * Built dynamically (not stored in `MERCHANT_PLAYBOOKS`) so the
 * display_name reflects whatever the user pointed us at.
 */
export function buildGenericPlaybook(merchantHint: string): MerchantPlaybook {
  return {
    merchant_id: "generic",
    display_name: merchantHint || "Unknown merchant",
    domains: [],
    supported: "manual",
    login_strategy: "guest_checkout",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "{product_url}",
        description:
          "Open the product or checkout URL provided by the user. If only a merchant name was given, search the site for the product first.",
      },
      {
        step: 2,
        action: "click",
        description:
          "Find and click the primary 'Add to cart' or 'Buy now' button. Selectors vary — fall back to button text matching ('Buy', 'Add to cart', 'Checkout', 'Purchase').",
      },
      {
        step: 3,
        action: "navigate",
        description:
          "Navigate to the checkout page. Typically reached by clicking a 'Checkout' or 'Proceed to payment' button after adding to cart.",
      },
      {
        step: 4,
        action: "verify",
        description:
          "Locate the payment form. Look for labels like 'Card number', 'Credit card', 'Payment information'. If the page requires login, use the user's existing session — do NOT create a new account without calling signup_to_service first.",
      },
      {
        step: 5,
        action: "type",
        value: "{card_number}",
        description:
          "Type the virtual card number into the field labelled 'Card number' (or equivalent: 'Credit card number', 'Card #').",
      },
      {
        step: 6,
        action: "type",
        value: "{cardholder}",
        description: "Type the cardholder name in the 'Name on card' field if present.",
      },
      {
        step: 7,
        action: "type",
        value: "{card_exp_month}/{card_exp_year_short}",
        description:
          "Type the expiry as MM/YY into the 'Expiry' / 'Expiration' field. Some sites use two separate dropdowns — select month then year.",
      },
      {
        step: 8,
        action: "type",
        value: "{card_cvc}",
        description:
          "Type the CVV / CVC / CSC (all the same thing) into the 3-digit security code field.",
      },
      {
        step: 9,
        action: "type",
        value: "{billing_zip}",
        description: "Type the billing postal code if requested.",
      },
      {
        step: 10,
        action: "click",
        description:
          "Click the primary submit button ('Place order', 'Pay now', 'Complete purchase'). Verify the order total against the user's per-authorization cap before clicking.",
        gotchas: [
          "If a 3D Secure / SCA challenge appears, ABORT and call request_user_consent.",
          "If a captcha appears, ABORT and surface to the user.",
        ],
      },
      {
        step: 11,
        action: "extract",
        description:
          "Capture whatever order reference / confirmation number the success page shows.",
      },
      {
        step: 12,
        action: "report",
        description:
          "Call complete_purchase({merchant: '<merchant hint>', external_order_id, amount_usd, mcp_token}) to close the loop in the audit log.",
      },
    ],
    known_issues: [
      "Playbook is generic — selectors are not curated for this merchant.",
      "Agent should extract selectors from the live DOM rather than rely on hard-coded values.",
    ],
    fallback_instructions:
      "No curated playbook exists for this merchant. The agent should treat each step as a high-level instruction and discover selectors at runtime by reading the live DOM. Prefer label-based matching ('label[for]', 'aria-label', visible text) over CSS classes which churn frequently.",
  };
}
