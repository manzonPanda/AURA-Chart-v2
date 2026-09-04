/*
 * AURA — EMA Reversal Alert service worker.
 *
 * The browser's only job in the alert pipeline is to RECEIVE push messages
 * (server → push service → this worker → OS notification) and to manage its
 * own subscription (frontend/src/services/pushClient.ts). No business logic
 * lives here: the backend decides when an alert is warranted.
 *
 * Deliberately NO fetch handler — the chart's caching/loading behavior is
 * untouched by this worker.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "AURA", body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "AURA";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.direction === "string" && payload.direction
    ? `aura-ema-${payload.direction}`
    : "aura-ema-alert";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      badge: undefined,
      icon: undefined,
      data: payload,
      vibrate: [200, 100, 200],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow("/");
      }),
  );
});
