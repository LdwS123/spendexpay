"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  isPushSupported,
  getCurrentSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  PushError,
} from "@/lib/use-push-notifications";

// ─── types ────────────────────────────────────────────────────────────────────

type DefaultMode =
  | "always_ask"
  | "auto_below_threshold"
  | "auto_for_trusted_services"
  | "never_auto";

type SaveState = "idle" | "saving" | "saved" | "error";

interface PreferencesResponse {
  user_id?: string;
  default_mode?: DefaultMode | null;
  threshold_usd?: number | null;
  trusted_services?: string[] | null;
  telegram_chat_id?: string | null;
  email_enabled?: boolean | null;
  telegram_enabled?: boolean | null;
  push_enabled?: boolean | null;
  table_missing?: boolean;
  error?: string;
}

// Trusted-services catalog: same shape as the Managed Accounts service list.
const SERVICE_CHOICES: { id: string; label: string }[] = [
  { id: "vercel", label: "Vercel" },
  { id: "modal", label: "Modal" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "railway", label: "Railway" },
  { id: "flyio", label: "Fly.io" },
  { id: "render", label: "Render" },
  { id: "netlify", label: "Netlify" },
  { id: "github", label: "GitHub" },
];

// ─── page ─────────────────────────────────────────────────────────────────────

export default function ConsentPreferencesPage() {
  // ── form state ──────────────────────────────────────────────────────────
  const [mode, setMode] = useState<DefaultMode>("always_ask");
  const [threshold, setThreshold] = useState<string>("50");
  const [trusted, setTrusted] = useState<string[]>([]);
  const [telegramEnabled, setTelegramEnabled] = useState<boolean>(false);
  const [telegramChatId, setTelegramChatId] = useState<string>("");

  // ── push notifications ──────────────────────────────────────────────────
  // `pushEnabled` is the server-side preference (does the user want push?).
  // `pushSubscribedHere` reflects whether THIS browser is the one holding
  // an active PushSubscription. They can disagree: a user can have
  // push_enabled=true server-side after subscribing on their phone, but
  // pushSubscribedHere=false on their laptop until they toggle here.
  const [pushSupported, setPushSupported] = useState<boolean>(false);
  const [pushEnabled, setPushEnabled] = useState<boolean>(false);
  const [pushSubscribedHere, setPushSubscribedHere] = useState<boolean>(false);
  const [pushBusy, setPushBusy] = useState<boolean>(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // ── UI state ────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showTelegramModal, setShowTelegramModal] = useState(false);

  // ── load on mount ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/consent/preferences");
        const body = (await res.json()) as PreferencesResponse;
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        if (body.table_missing) setTableMissing(true);
        if (body.default_mode) setMode(body.default_mode);
        if (body.threshold_usd !== null && body.threshold_usd !== undefined) {
          setThreshold(String(body.threshold_usd));
        }
        if (Array.isArray(body.trusted_services)) {
          setTrusted(body.trusted_services);
        }
        setTelegramEnabled(Boolean(body.telegram_enabled));
        if (body.telegram_chat_id) setTelegramChatId(body.telegram_chat_id);
        setPushEnabled(Boolean(body.push_enabled));
      } catch {
        if (!cancelled) setLoadError("Network error loading preferences.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Detect Push API support and reconcile with the SW registration on mount.
  // Effect runs client-side only; useEffect is the right guard against the
  // SSR pass where `window` is undefined.
  useEffect(() => {
    const supported = isPushSupported();
    setPushSupported(supported);
    if (!supported) return;
    let cancelled = false;
    void getCurrentSubscription().then((sub) => {
      if (!cancelled) setPushSubscribedHere(Boolean(sub));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── derived ─────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (mode === "always_ask")
      return "Your agent will ask before every chargeable action.";
    if (mode === "auto_below_threshold") {
      const n = parseFloat(threshold) || 0;
      return `Your agent will auto-approve charges up to €${n.toFixed(0)}.`;
    }
    if (mode === "auto_for_trusted_services") {
      return trusted.length > 0
        ? `Your agent will auto-approve actions on ${trusted.length} trusted service${trusted.length === 1 ? "" : "s"}.`
        : "Pick at least one trusted service to enable this mode.";
    }
    return "Your agent will never auto-approve. Every action needs your sign-off.";
  }, [mode, threshold, trusted]);

  // ── handlers ────────────────────────────────────────────────────────────
  function toggleTrusted(id: string) {
    setTrusted((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  async function save() {
    setSaveState("saving");
    setSaveError(null);

    const thresholdParsed = parseFloat(threshold);
    const thresholdValue =
      mode === "auto_below_threshold" && Number.isFinite(thresholdParsed)
        ? Math.max(0, thresholdParsed)
        : null;

    try {
      const res = await fetch("/api/consent/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_mode: mode,
          threshold_usd: thresholdValue,
          trusted_services:
            mode === "auto_for_trusted_services" ? trusted : null,
          telegram_enabled: telegramEnabled,
          telegram_chat_id: telegramChatId.trim() || null,
          push_enabled: pushEnabled,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !body.success) {
        setSaveState("error");
        setSaveError(body.error ?? `HTTP ${res.status}`);
        setTimeout(() => setSaveState("idle"), 4000);
        return;
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
      setSaveError("Network error — please try again.");
      setTimeout(() => setSaveState("idle"), 4000);
    }
  }

  async function testTelegram() {
    if (!telegramChatId.trim()) return;
    // Best-effort test ping. The notification infra lives elsewhere; here we
    // just save the preferences first so a downstream test endpoint (if it
    // exists) can look up the chat_id. For now we just toast "saved".
    await save();
  }

  /**
   * Toggle browser push on/off. We split the two transitions so the UI can
   * surface precise errors (permission denied vs server rejected). Note:
   * the user has to click Save afterwards to persist `push_enabled=true`
   * in their preferences — this handler only handles the *browser* side
   * (PushManager subscription + POST to /api/push/subscribe).
   */
  async function togglePush(next: boolean) {
    setPushError(null);
    setPushBusy(true);
    try {
      if (next) {
        await subscribeToPush();
        setPushSubscribedHere(true);
        setPushEnabled(true);
      } else {
        await unsubscribeFromPush();
        setPushSubscribedHere(false);
        setPushEnabled(false);
      }
    } catch (err) {
      if (err instanceof PushError) {
        const friendly =
          err.code === "permission_denied"
            ? "Notifications are blocked. Enable them in your browser's site settings and try again."
            : err.code === "unsupported"
            ? "This browser doesn't support push notifications."
            : err.code === "no_vapid_key"
            ? "Push notifications aren't configured on this server."
            : err.message;
        setPushError(friendly);
      } else {
        setPushError(
          err instanceof Error ? err.message : "Failed to update push setting."
        );
      }
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/consents"
            className="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors inline-flex items-center gap-1"
          >
            ← All consents
          </Link>
          <h1 className="text-lg font-semibold text-[#0a1220] mt-1">
            Consent preferences
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Decide when your agent should ask and when it can act on its own.
          </p>
        </div>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">
        {loadError && (
          <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
            Failed to load preferences: {loadError}
          </div>
        )}

        {tableMissing && (
          <div className="rounded-lg bg-amber-50 border border-amber-100 px-4 py-3 text-xs text-amber-700">
            Consent preferences are not yet provisioned on your account. Your
            changes will be saved as soon as the feature is enabled.
          </div>
        )}

        {/* ── Summary recap ── */}
        <div className="rounded-xl border border-[#00e5b4]/30 bg-gradient-to-br from-[#00e5b4]/10 to-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#00876a] mb-2">
            Current policy
          </p>
          <p className="text-sm leading-relaxed text-[#070d18]">{summary}</p>
        </div>

        {/* ── Default mode ── */}
        <div className="bg-white rounded-xl border border-slate-100 p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-[#0a1220]">Default mode</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Choose how your agent should handle new requests.
            </p>
          </div>

          <ModeRadio
            value="always_ask"
            current={mode}
            disabled={loading}
            onChange={setMode}
            title="Always ask"
            subtitle="Recommended. Confirm every action."
          />

          <ModeRadio
            value="auto_below_threshold"
            current={mode}
            disabled={loading}
            onChange={setMode}
            title="Auto-approve below threshold"
            subtitle="Auto-approve small charges, ask for bigger ones."
          >
            {mode === "auto_below_threshold" && (
              <div className="mt-3 max-w-xs">
                <label className="block text-[11px] font-medium text-slate-500 mb-1.5">
                  Threshold (€)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    €
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    disabled={loading}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg pl-6 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50"
                  />
                </div>
              </div>
            )}
          </ModeRadio>

          <ModeRadio
            value="auto_for_trusted_services"
            current={mode}
            disabled={loading}
            onChange={setMode}
            title="Auto-approve for trusted services"
            subtitle="Only ask when the action is on a service you haven't trusted yet."
          >
            {mode === "auto_for_trusted_services" && (
              <div className="mt-3">
                <p className="text-[11px] font-medium text-slate-500 mb-2">
                  Trusted services
                </p>
                <div className="flex flex-wrap gap-2">
                  {SERVICE_CHOICES.map((s) => {
                    const active = trusted.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={loading}
                        onClick={() => toggleTrusted(s.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          active
                            ? "bg-[#00e5b4] border-[#00e5b4] text-[#070d18]"
                            : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </ModeRadio>

          <ModeRadio
            value="never_auto"
            current={mode}
            disabled={loading}
            onChange={setMode}
            title="Never auto-approve"
            subtitle="Manual confirmation every single time. Most strict."
          />
        </div>

        {/* ── Notifications ── */}
        <div className="bg-white rounded-xl border border-slate-100 p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-[#0a1220]">
              Notification channels
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Where to reach you when a decision is needed.
            </p>
          </div>

          {/* Email — always on */}
          <div className="flex items-start gap-3 rounded-lg border border-slate-100 bg-slate-50/50 px-4 py-3">
            <input
              type="checkbox"
              checked
              disabled
              readOnly
              className="mt-0.5 h-4 w-4 accent-[#00e5b4]"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#0a1220]">Email</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Always on. We email the account address on every consent
                request.
              </p>
            </div>
          </div>

          {/* Browser push */}
          <div className="rounded-lg border border-slate-100 px-4 py-3">
            <div className="flex items-start gap-3">
              <input
                id="push_enabled"
                type="checkbox"
                checked={pushSubscribedHere && pushEnabled}
                disabled={loading || pushBusy || !pushSupported}
                onChange={(e) => togglePush(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#00e5b4]"
              />
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="push_enabled"
                  className="text-sm font-medium text-[#0a1220] cursor-pointer"
                >
                  Browser push notifications
                </label>
                <p className="text-xs text-slate-400 mt-0.5">
                  Get a tap-to-approve banner when the dashboard tab is open or
                  installed as a PWA.
                </p>

                {!pushSupported && (
                  <p className="mt-2 text-[11px] text-amber-600">
                    Your browser doesn&apos;t support push notifications. Use a
                    recent Chrome, Edge, or Firefox. On iOS, add Spendex to your
                    home screen first.
                  </p>
                )}

                {pushSupported && pushSubscribedHere && pushEnabled && (
                  <p className="mt-2 text-[11px] font-medium text-[#00876a]">
                    Push notifications enabled on this browser.
                  </p>
                )}

                {pushBusy && (
                  <p className="mt-2 text-[11px] text-slate-400">
                    Updating push subscription…
                  </p>
                )}

                {pushError && (
                  <p className="mt-2 text-[11px] text-red-600">{pushError}</p>
                )}
              </div>
            </div>
          </div>

          {/* Telegram */}
          <div className="rounded-lg border border-slate-100 px-4 py-3">
            <div className="flex items-start gap-3">
              <input
                id="telegram_enabled"
                type="checkbox"
                checked={telegramEnabled}
                disabled={loading}
                onChange={(e) => setTelegramEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#00e5b4]"
              />
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="telegram_enabled"
                  className="text-sm font-medium text-[#0a1220] cursor-pointer"
                >
                  Telegram
                </label>
                <p className="text-xs text-slate-400 mt-0.5">
                  Get instant decision pings via the Spendex Pay bot.
                </p>

                {telegramEnabled && (
                  <div className="mt-3 space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowTelegramModal(true)}
                      className="text-xs font-semibold text-[#00a882] hover:text-[#00e5b4] transition-colors"
                    >
                      Connect Telegram →
                    </button>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1.5">
                        Telegram chat ID
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          disabled={loading}
                          value={telegramChatId}
                          onChange={(e) => setTelegramChatId(e.target.value)}
                          placeholder="e.g. 1234567890"
                          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#00e5b4] focus:border-[#00e5b4] disabled:bg-slate-50"
                        />
                        <button
                          type="button"
                          disabled={loading || !telegramChatId.trim()}
                          onClick={testTelegram}
                          className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-200 text-[#070d18] hover:border-[#00e5b4] hover:text-[#00876a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Test notification
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Save ── */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={save}
            disabled={loading || saveState === "saving"}
            className={`font-semibold text-sm px-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              saveState === "saved"
                ? "bg-[#00e5b4]/15 text-[#00a882]"
                : saveState === "error"
                ? "bg-red-50 text-red-600 border border-red-200"
                : "bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18]"
            }`}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
              ? "Saved"
              : saveState === "error"
              ? "Save failed"
              : "Save preferences"}
          </button>
          {saveState === "error" && saveError && (
            <p className="text-xs text-red-500">{saveError}</p>
          )}
          {loading && (
            <p className="text-xs text-slate-400">Loading…</p>
          )}
        </div>
      </div>

      {/* ── Telegram modal ── */}
      {showTelegramModal && (
        <TelegramModal onClose={() => setShowTelegramModal(false)} />
      )}
    </main>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface ModeRadioProps {
  value: DefaultMode;
  current: DefaultMode;
  title: string;
  subtitle: string;
  disabled?: boolean;
  onChange: (next: DefaultMode) => void;
  children?: React.ReactNode;
}

function ModeRadio({
  value,
  current,
  title,
  subtitle,
  disabled,
  onChange,
  children,
}: ModeRadioProps) {
  const active = current === value;
  return (
    <label
      className={`block rounded-lg border px-4 py-3 cursor-pointer transition-colors ${
        active
          ? "border-[#00e5b4] bg-[#00e5b4]/5"
          : "border-slate-100 hover:border-slate-200"
      } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="default_mode"
          value={value}
          checked={active}
          disabled={disabled}
          onChange={() => onChange(value)}
          className="mt-1 h-4 w-4 accent-[#00e5b4]"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[#0a1220]">{title}</p>
          <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
          {children}
        </div>
      </div>
    </label>
  );
}

function TelegramModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-100 shadow-lg max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[#0a1220]">
              Connect Telegram
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Get instant consent pings on your phone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <ol className="space-y-3 text-sm text-[#0a1220] list-decimal list-inside">
          <li>
            Open Telegram and start a chat with{" "}
            <a
              href="https://t.me/SpendexPayBot"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[#00876a] underline underline-offset-2"
            >
              @SpendexPayBot
            </a>
            .
          </li>
          <li>
            Send <code className="font-mono bg-slate-100 px-1 rounded">/start</code>.
          </li>
          <li>
            The bot replies with your <strong>chat ID</strong>. Paste it back
            here.
          </li>
        </ol>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18] font-semibold text-sm py-2.5 rounded-lg transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}
