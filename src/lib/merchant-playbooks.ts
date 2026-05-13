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

  // ---------------------------------------------------------------------------
  // OpenAI billing — top up the prepaid credit balance on platform.openai.com.
  // Login is OAuth-first (Google / GitHub) with a password fallback. The actual
  // card form is Stripe Checkout rendered inside an iframe, so the selectors
  // below mirror the generic_stripe_checkout entry for the payment step.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "openai-billing",
    display_name: "OpenAI Platform Billing",
    domains: ["platform.openai.com"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://platform.openai.com/login",
        description:
          "Open the OpenAI platform login page. If already authenticated, this redirects to /usage or /settings — that's fine.",
        requires_login: true,
      },
      {
        step: 2,
        action: "click",
        selector: 'button[data-provider="google"], button:has-text("Continue with Google")',
        description:
          "Prefer 'Continue with Google' for Spendex-managed accounts — the alias mailbox is Google-backed. Fall back to 'Continue with GitHub' or email + password if the managed account was provisioned with those.",
        requires_login: true,
        gotchas: [
          "OpenAI may show a 'Verify it's you' device challenge after OAuth — ABORT and call request_user_consent({action:'other', service:'openai', context:'OpenAI device verification'}). Do not guess.",
        ],
      },
      {
        step: 3,
        action: "type",
        selector: 'input[type="email"], input[name="username"]',
        value: "{email}",
        description: "If the password fallback is used, fill the email field with the Spendex-managed account address.",
        requires_login: true,
      },
      {
        step: 4,
        action: "type",
        selector: 'input[type="password"], input[name="password"]',
        value: "{password}",
        description: "Fill the password field on the password fallback path.",
        requires_login: true,
      },
      {
        step: 5,
        action: "navigate",
        target_url: "https://platform.openai.com/settings/organization/billing/overview",
        description: "Navigate to the billing overview page for the active organization.",
      },
      {
        step: 6,
        action: "click",
        selector: 'button:has-text("Add to credit balance"), a:has-text("Add credit balance")',
        description:
          "Click the 'Add to credit balance' button. OpenAI renames this button periodically ('Add credits', 'Add to balance') — match by visible text if the selector misses.",
      },
      {
        step: 7,
        action: "type",
        selector: 'input[name="amount"], input[aria-label*="Amount" i]',
        value: "{amount_usd}",
        description:
          "Type the top-up amount in USD. Minimum is $5, maximum varies by trust tier (typically $100 for new accounts).",
        gotchas: [
          "If the entered amount exceeds the account's per-charge cap, OpenAI silently floors it — re-read the field after typing to confirm.",
        ],
      },
      {
        step: 8,
        action: "click",
        selector: 'button:has-text("Continue"), button[data-testid="continue-to-payment"]',
        description: "Click 'Continue' to launch the Stripe checkout iframe.",
      },
      {
        step: 9,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber',
        value: "{card_number}",
        description:
          "Type the Spendex virtual card number into Stripe's PaymentElement. The form lives inside an iframe whose src contains 'js.stripe.com' — switch frame context before typing.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="cardExpiry"], input#cardExpiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="cardCvc"], input#cardCvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 12,
        action: "type",
        selector: 'input[name="billingName"], input#billingName',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="billingPostalCode"], input#billingPostalCode',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 14,
        action: "click",
        selector: 'button[data-testid="hosted-payment-submit-button"], button.SubmitButton',
        description:
          "Click the primary 'Pay' button. Verify the displayed total matches {amount_usd} before clicking.",
        gotchas: [
          "3D Secure on the virtual card is possible — ABORT and surface to user if a 3DS popup appears.",
        ],
      },
      {
        step: 15,
        action: "extract",
        selector: '[data-testid="receipt-amount"], .ReceiptAmount',
        description:
          "Capture the receipt reference and the resulting credit balance. OpenAI usually redirects to /settings/organization/billing/overview with a success banner.",
      },
      {
        step: 16,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'openai-billing', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "Card data is submitted to Stripe inside an iframe — Spendex backend never sees the card number, which is correct but means agents cannot intercept the value post-type.",
      "OpenAI auto-recharge is a separate toggle on the same page — do NOT enable it unless the user explicitly asked, otherwise we'd charge again outside the consent window.",
      "Org-scoped billing: if the managed account belongs to multiple orgs, the wrong org may be selected — verify the org name in the top-left switcher before paying.",
      "Device verification / new-IP challenges trigger ABORT.",
    ],
    fallback_instructions:
      "If selectors break, ask the agent to read the page and find the 'Add to credit balance' / 'Add credits' button manually, then locate the Stripe iframe by `iframe[src*='stripe.com']` and operate inside it. The amount input is the only field outside the iframe.",
  },

  // ---------------------------------------------------------------------------
  // Anthropic Console billing — top up the prepaid balance on
  // console.anthropic.com. Login is Google OAuth (no password option on most
  // workspaces). Payment is Stripe Checkout in an iframe.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "anthropic-console",
    display_name: "Anthropic Console Billing",
    domains: ["console.anthropic.com"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://console.anthropic.com/login",
        description:
          "Open the Anthropic Console login page. If already authenticated this redirects to the workspace dashboard.",
        requires_login: true,
      },
      {
        step: 2,
        action: "click",
        selector: 'button:has-text("Continue with Google"), button[data-provider="google"]',
        description:
          "Click 'Continue with Google'. Anthropic Console authenticates via Google OAuth on most workspaces — there is no email + password form for new accounts.",
        requires_login: true,
        gotchas: [
          "Some legacy workspaces still expose 'Continue with email' — that path uses a magic-link email and cannot be completed by the agent alone. ABORT and call request_user_consent.",
        ],
      },
      {
        step: 3,
        action: "type",
        selector: 'input[type="email"]',
        value: "{email}",
        description: "On the Google OAuth screen, fill the Spendex-managed account email.",
        requires_login: true,
      },
      {
        step: 4,
        action: "type",
        selector: 'input[type="password"]',
        value: "{password}",
        description: "Fill the password on the Google OAuth screen.",
        requires_login: true,
        gotchas: [
          "If Google demands 2FA / device prompt, ABORT and call request_user_consent({action:'other', service:'anthropic-console', context:'Google 2FA challenge'}).",
        ],
      },
      {
        step: 5,
        action: "navigate",
        target_url: "https://console.anthropic.com/settings/billing",
        description: "Navigate to Settings → Billing for the active workspace.",
      },
      {
        step: 6,
        action: "click",
        selector: 'button:has-text("Add credits"), button:has-text("Buy credits")',
        description:
          "Click 'Add credits'. Anthropic occasionally re-labels this 'Buy credits' or 'Top up' — match by visible text if the selector misses.",
      },
      {
        step: 7,
        action: "type",
        selector: 'input[name="amount"], input[aria-label*="Amount" i]',
        value: "{amount_usd}",
        description: "Type the top-up amount in USD.",
      },
      {
        step: 8,
        action: "click",
        selector: 'button:has-text("Continue to payment"), button:has-text("Continue")',
        description: "Click 'Continue to payment' to launch the Stripe Checkout iframe.",
      },
      {
        step: 9,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber',
        value: "{card_number}",
        description:
          "Switch into the Stripe iframe (src contains 'js.stripe.com') and type the virtual card number.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="cardExpiry"], input#cardExpiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="cardCvc"], input#cardCvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 12,
        action: "type",
        selector: 'input[name="billingName"], input#billingName',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="billingPostalCode"], input#billingPostalCode',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 14,
        action: "click",
        selector: 'button[data-testid="hosted-payment-submit-button"], button.SubmitButton',
        description:
          "Click 'Pay'. Verify the displayed total matches {amount_usd} before clicking.",
      },
      {
        step: 15,
        action: "extract",
        description:
          "Capture the confirmation banner / receipt URL. The Console redirects back to /settings/billing with the new balance shown.",
      },
      {
        step: 16,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'anthropic-console', external_order_id, amount_usd, mcp_token}).",
      },
    ],
    known_issues: [
      "Stripe iframe — card data submitted to Stripe, never seen by Spendex backend.",
      "Workspace-scoped billing: the wrong workspace may be selected if the managed account is in multiple orgs — verify before paying.",
      "Magic-link email fallback breaks the automation; only the Google OAuth path is reliable.",
      "Anthropic shows a separate 'Auto-reload' toggle — do NOT enable it without explicit user consent.",
    ],
    fallback_instructions:
      "If selectors break, ask the agent to read the page and find the 'Add credits' button manually, then locate the Stripe iframe by `iframe[src*='stripe.com']` and operate inside it.",
  },

  // ---------------------------------------------------------------------------
  // Vercel — upgrade plan or buy add-on credits. Auth is GitHub OAuth as the
  // primary path (most dev accounts are GitHub-linked). The pricing page lets
  // you upgrade Hobby → Pro, or buy add-on credits on a Pro/Enterprise plan.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "vercel",
    display_name: "Vercel",
    domains: ["vercel.com"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://vercel.com/login",
        description:
          "Open the Vercel login page. If already authenticated this redirects to the dashboard.",
        requires_login: true,
      },
      {
        step: 2,
        action: "click",
        selector: 'button:has-text("Continue with GitHub"), a[href*="github.com/login/oauth"]',
        description:
          "Click 'Continue with GitHub'. GitHub OAuth is the primary auth path for Spendex-managed Vercel accounts. Fall back to 'Continue with Email' (magic link) only if the managed account is email-bound.",
        requires_login: true,
        gotchas: [
          "Magic-link email auth cannot be completed by the agent alone — if the GitHub button is missing, ABORT and call request_user_consent.",
        ],
      },
      {
        step: 3,
        action: "type",
        selector: 'input[name="login"], input#login_field',
        value: "{email}",
        description: "On GitHub's OAuth screen, fill the username/email for the managed GitHub account.",
        requires_login: true,
      },
      {
        step: 4,
        action: "type",
        selector: 'input[name="password"], input#password',
        value: "{password}",
        description: "Fill the GitHub password.",
        requires_login: true,
        gotchas: [
          "If GitHub demands 2FA, ABORT and call request_user_consent({action:'other', service:'vercel', context:'GitHub 2FA for Vercel login'}).",
        ],
      },
      {
        step: 5,
        action: "click",
        selector: 'button:has-text("Authorize"), button[name="authorize"]',
        description: "Click the GitHub 'Authorize' button if Vercel prompts to re-authorize the OAuth app.",
        requires_login: true,
      },
      {
        step: 6,
        action: "navigate",
        target_url: "https://vercel.com/dashboard",
        description: "Land on the dashboard once OAuth completes.",
      },
      {
        step: 7,
        action: "navigate",
        target_url: "https://vercel.com/account/billing",
        description: "Navigate to Account → Billing. From here you can upgrade the plan or buy add-on credits.",
      },
      {
        step: 8,
        action: "click",
        selector: 'a:has-text("Upgrade"), button:has-text("Upgrade to Pro"), a[href*="/pricing"]',
        description:
          "Click 'Upgrade to Pro' to switch the plan, OR click the 'Buy more' button next to the credit / build minutes line item to top up an existing Pro plan. Choose based on {action_intent}.",
        gotchas: [
          "Vercel reshuffles this page between team and personal billing — verify the scope switcher (top-left) before clicking.",
        ],
      },
      {
        step: 9,
        action: "click",
        selector: 'button:has-text("Continue"), button[data-testid="checkout-continue"]',
        description: "Continue to the payment step.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber',
        value: "{card_number}",
        description:
          "Type the Spendex virtual card number. Vercel uses Stripe Elements — the field is inside an iframe whose src contains 'stripe.com'.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="cardExpiry"], input#cardExpiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 12,
        action: "type",
        selector: 'input[name="cardCvc"], input#cardCvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="billingName"], input#billingName',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 14,
        action: "type",
        selector: 'input[name="billingPostalCode"], input#billingPostalCode',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 15,
        action: "click",
        selector: 'button:has-text("Subscribe"), button:has-text("Pay"), button[data-testid="hosted-payment-submit-button"]',
        description:
          "Click the primary submit button ('Subscribe' for plan upgrades, 'Pay' for one-shot credit add-ons). Verify the recurring nature of the charge against the user's consent before clicking.",
        gotchas: [
          "Plan upgrades are recurring — Spendex must record this as a subscription and the issuing rules must allow future authorizations from Vercel.",
        ],
      },
      {
        step: 16,
        action: "extract",
        description:
          "Capture the confirmation banner / invoice URL. Vercel redirects to /account/billing with the new plan or balance reflected.",
      },
      {
        step: 17,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'vercel', external_order_id, amount_usd, mcp_token}). For plan upgrades, also call subscribe_service to register the recurring relationship.",
      },
    ],
    known_issues: [
      "Stripe iframe — card data submitted to Stripe, never seen by Spendex backend.",
      "Plan upgrades are recurring — the agent must call subscribe_service in addition to complete_purchase so the issuing rules permit future authorizations.",
      "Team vs personal billing scope is set by the top-left switcher — wrong scope sends the charge to the wrong account.",
      "GitHub 2FA on the OAuth path triggers ABORT.",
    ],
    fallback_instructions:
      "If selectors break, ask the agent to read the page and find the 'Upgrade' / 'Buy more' button manually, then locate the Stripe iframe by `iframe[src*='stripe.com']` and operate inside it. For plan changes, always verify the billing cadence (monthly/annual) before clicking submit.",
  },

  // ---------------------------------------------------------------------------
  // GitHub Pro — upgrade a personal account from Free to Pro. Login is
  // username/password + 2FA (GitHub does not offer SSO into github.com for
  // personal accounts). Payment is a direct GitHub-hosted form backed by
  // Stripe.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "github-pro",
    display_name: "GitHub Pro",
    domains: ["github.com"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://github.com/login",
        description:
          "Open the GitHub login page. If already authenticated this redirects to the dashboard.",
        requires_login: true,
      },
      {
        step: 2,
        action: "type",
        selector: '#login_field',
        value: "{email}",
        description: "Fill the username or email field with the Spendex-managed GitHub account.",
        requires_login: true,
      },
      {
        step: 3,
        action: "type",
        selector: '#password',
        value: "{password}",
        description: "Fill the password field.",
        requires_login: true,
      },
      {
        step: 4,
        action: "click",
        selector: 'input[type="submit"][name="commit"], button[type="submit"]:has-text("Sign in")',
        description: "Click 'Sign in'.",
        requires_login: true,
        gotchas: [
          "GitHub almost always demands 2FA (TOTP, SMS, or security key) right after the password step. If the managed account has a stored TOTP secret, the agent should fetch the current code via get_verification_email or the TOTP provider; otherwise ABORT and call request_user_consent({action:'other', service:'github', context:'GitHub 2FA challenge'}).",
        ],
      },
      {
        step: 5,
        action: "type",
        selector: 'input[name="otp"], input#otp',
        value: "{totp_code}",
        description:
          "Fill the 2FA TOTP code if the managed account has a stored seed. Otherwise this step is skipped via the ABORT branch above.",
        requires_login: true,
      },
      {
        step: 6,
        action: "navigate",
        target_url: "https://github.com/settings/billing/plans",
        description: "Navigate to Settings → Billing & plans → Plans.",
      },
      {
        step: 7,
        action: "click",
        selector: 'a[href*="/settings/billing/plans/upgrade"], button:has-text("Upgrade")',
        description: "Click 'Upgrade' next to the Pro plan card.",
      },
      {
        step: 8,
        action: "click",
        selector: 'input[name="plan_duration"][value="month"], label:has-text("Monthly")',
        description:
          "Pick monthly or yearly billing based on {billing_cadence}. Default to monthly unless the user said annual.",
      },
      {
        step: 9,
        action: "click",
        selector: 'button:has-text("Continue to billing"), button[type="submit"]',
        description: "Click 'Continue to billing information'.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="payment_method[cardholder_name]"], input#cardholder_name',
        value: "{cardholder}",
        description: "Type the cardholder name on GitHub's payment form.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="number"], input#card-number',
        value: "{card_number}",
        description:
          "Type the virtual card number. GitHub embeds Stripe Elements — the field is inside an iframe with src containing 'stripe.com'.",
      },
      {
        step: 12,
        action: "type",
        selector: 'input[name="exp-date"], input#card-expiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="cvc"], input#card-cvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 14,
        action: "type",
        selector: 'input[name="postal_code"], input#postal_code',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 15,
        action: "click",
        selector: 'button:has-text("Submit"), button[type="submit"]:has-text("Upgrade")',
        description:
          "Click the final 'Submit' / 'Upgrade my account' button. This is a recurring subscription — verify the cadence and amount before clicking.",
        gotchas: [
          "GitHub Pro is recurring; Spendex must record it as a subscription and the issuing rules must allow future authorizations.",
        ],
      },
      {
        step: 16,
        action: "extract",
        description:
          "Capture the confirmation banner. GitHub redirects to /settings/billing/summary with the new plan reflected.",
      },
      {
        step: 17,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'github-pro', external_order_id, amount_usd, mcp_token}) AND subscribe_service so the recurring relationship is registered.",
      },
    ],
    known_issues: [
      "Mandatory 2FA on every login — managed accounts without a stored TOTP seed cannot be driven autonomously.",
      "Stripe iframe — card data submitted to Stripe, never seen by Spendex backend.",
      "GitHub Pro is recurring; missing the subscribe_service call means future renewals will be declined by Stripe Issuing rules.",
      "Org-scoped vs personal billing: only personal accounts can be upgraded to Pro via this flow. Org billing lives under /organizations/{org}/billing/plans.",
    ],
    fallback_instructions:
      "If selectors break, ask the agent to read the page and find the 'Continue to payment' / 'Upgrade my account' button manually. The 2FA step is the single most common failure point — if the TOTP secret isn't available, ABORT cleanly rather than retrying.",
  },

  // ---------------------------------------------------------------------------
  // Cursor Pro — upgrade to the Pro plan on cursor.com. Auth is OAuth, with
  // GitHub and Google as the two primary providers. Payment is Stripe Checkout.
  // ---------------------------------------------------------------------------
  {
    merchant_id: "cursor-pro",
    display_name: "Cursor Pro",
    domains: ["cursor.com", "cursor.sh"],
    supported: "full",
    login_strategy: "spendex_managed",
    steps: [
      {
        step: 1,
        action: "navigate",
        target_url: "https://www.cursor.com/sign-in",
        description:
          "Open the Cursor sign-in page. If already authenticated this redirects to the dashboard.",
        requires_login: true,
      },
      {
        step: 2,
        action: "click",
        selector: 'button:has-text("Continue with GitHub"), button:has-text("Continue with Google")',
        description:
          "Click 'Continue with GitHub' (preferred for dev managed accounts) or 'Continue with Google'. Choose based on which provider the Spendex-managed account was provisioned with.",
        requires_login: true,
        gotchas: [
          "Cursor does not offer email + password auth — only OAuth. If neither GitHub nor Google is bound to the managed account, ABORT and call signup_to_service first.",
        ],
      },
      {
        step: 3,
        action: "type",
        selector: 'input[name="login"], input[type="email"]',
        value: "{email}",
        description: "On the OAuth provider's screen, fill the managed account email/username.",
        requires_login: true,
      },
      {
        step: 4,
        action: "type",
        selector: 'input[name="password"], input[type="password"]',
        value: "{password}",
        description: "Fill the OAuth provider password.",
        requires_login: true,
        gotchas: [
          "Provider 2FA (GitHub TOTP / Google device prompt) triggers ABORT unless a TOTP seed is on file.",
        ],
      },
      {
        step: 5,
        action: "click",
        selector: 'button:has-text("Authorize"), button[name="authorize"]',
        description: "Click 'Authorize' on the OAuth consent screen if Cursor prompts for permissions.",
        requires_login: true,
      },
      {
        step: 6,
        action: "navigate",
        target_url: "https://www.cursor.com/settings",
        description: "Land on the Cursor settings page.",
      },
      {
        step: 7,
        action: "click",
        selector: 'a:has-text("Upgrade to Pro"), button:has-text("Upgrade"), a[href*="/pricing"]',
        description:
          "Click 'Upgrade to Pro'. Cursor sometimes routes this through /pricing — match by visible text if the selector misses.",
      },
      {
        step: 8,
        action: "click",
        selector: 'button:has-text("Get Pro"), button:has-text("Continue"), button[data-testid="checkout-continue"]',
        description: "Confirm the Pro plan selection and continue to Stripe Checkout.",
      },
      {
        step: 9,
        action: "type",
        selector: 'input[name="cardNumber"], input#cardNumber',
        value: "{card_number}",
        description:
          "Switch into the Stripe iframe (src contains 'js.stripe.com') and type the virtual card number.",
      },
      {
        step: 10,
        action: "type",
        selector: 'input[name="cardExpiry"], input#cardExpiry',
        value: "{card_exp_month}/{card_exp_year_short}",
        description: "Type the expiry as MM/YY.",
      },
      {
        step: 11,
        action: "type",
        selector: 'input[name="cardCvc"], input#cardCvc',
        value: "{card_cvc}",
        description: "Type the CVC.",
      },
      {
        step: 12,
        action: "type",
        selector: 'input[name="billingName"], input#billingName',
        value: "{cardholder}",
        description: "Type the cardholder name.",
      },
      {
        step: 13,
        action: "type",
        selector: 'input[name="billingPostalCode"], input#billingPostalCode',
        value: "{billing_zip}",
        description: "Type the billing postal code.",
      },
      {
        step: 14,
        action: "click",
        selector: 'button[data-testid="hosted-payment-submit-button"], button.SubmitButton',
        description:
          "Click 'Subscribe' / 'Pay'. This is a recurring subscription — verify the cadence and amount before clicking.",
        gotchas: [
          "Cursor Pro is recurring; Spendex must record it as a subscription and the issuing rules must allow future authorizations.",
        ],
      },
      {
        step: 15,
        action: "extract",
        description:
          "Capture the confirmation banner. Cursor redirects to /settings with the Pro badge visible.",
      },
      {
        step: 16,
        action: "report",
        description:
          "Call complete_purchase({merchant: 'cursor-pro', external_order_id, amount_usd, mcp_token}) AND subscribe_service so the recurring relationship is registered.",
      },
    ],
    known_issues: [
      "OAuth-only auth — no password fallback. If neither GitHub nor Google is bound to the managed account, signup_to_service must run first.",
      "Stripe iframe — card data submitted to Stripe, never seen by Spendex backend.",
      "Cursor Pro is recurring; missing the subscribe_service call means future renewals will be declined by Stripe Issuing rules.",
      "Cursor occasionally renames 'Upgrade to Pro' → 'Get Pro' → 'Start free trial' depending on the active experiment — match by visible text rather than relying on the CSS class.",
    ],
    fallback_instructions:
      "If selectors break, ask the agent to read the page and find the 'Upgrade' / 'Get Pro' button manually, then locate the Stripe iframe by `iframe[src*='stripe.com']` and operate inside it. The OAuth step is the highest-risk failure point — verify the provider matches the managed account before clicking.",
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
