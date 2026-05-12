/*
 * Spendex Pay — Service Worker for Web Push notifications
 *
 * Registered by `useSubscribeToPush` in src/lib/use-push-notifications.ts.
 * The browser keeps this script alive (separately from the main page) so
 * the OS can wake it to display a notification when a push arrives — even
 * when the dashboard tab is closed.
 *
 * The script intentionally has no build step: it ships verbatim from
 * /public/sw.js so the browser can serve it from the root scope ('/'),
 * which lets it manage notifications for every dashboard route.
 */

// -----------------------------------------------------------------------------
// `install` / `activate` — claim every existing client immediately so push
// notifications work on the same page that just subscribed.
// -----------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  // Skip the default "waiting" state — there's nothing to migrate, this is the
  // first SW for this origin (we don't ship any other ones).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// -----------------------------------------------------------------------------
// `push` — fired when the push server (web-push lib on our backend) delivers
// a payload. We expect JSON with { title, body, action_url }.
// -----------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  // Defensive parse: bad payloads must not crash the SW (browsers will retry
  // forever otherwise). Fall back to a generic prompt so the user still sees
  // *something* and can come to the dashboard.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    // eslint-disable-next-line no-console
    console.error("[sw] push payload was not valid JSON");
  }

  const title = data.title || "Spendex needs your input";
  const body =
    data.body || "Your agent is waiting on a decision. Tap to review.";
  const actionUrl = data.action_url || "/dashboard/consents";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/badge-72.png",
      // Stash the URL on the notification so `notificationclick` knows where
      // to open. We also set `tag` to "spendex-consent" so a second push
      // arriving while the first is still on screen replaces it instead of
      // stacking — a user looking at one consent doesn't need ten copies.
      data: actionUrl,
      tag: "spendex-consent",
      requireInteraction: true,
      actions: [
        { action: "approve", title: "Approve" },
        { action: "decline", title: "Decline" },
      ],
    })
  );
});

// -----------------------------------------------------------------------------
// `notificationclick` — bring the dashboard to the foreground and route to
// the consent's detail page. If a dashboard tab is already open we focus
// it; otherwise we open a new one.
// -----------------------------------------------------------------------------

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (typeof event.notification.data === "string" && event.notification.data) ||
    "/dashboard/consents";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer focusing an existing dashboard tab to avoid stacking tabs on
      // every notification. Match by origin only — the path doesn't matter,
      // we'll navigate it below.
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          const targetUrl = new URL(url, self.location.origin);
          if (clientUrl.origin === targetUrl.origin && "focus" in client) {
            await client.focus();
            if ("navigate" in client) {
              await client.navigate(url);
            }
            return;
          }
        } catch (_err) {
          // Bad URL on the client — fall through to opening a new window.
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});
