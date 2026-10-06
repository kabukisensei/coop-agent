// The phone companion's service worker (master plan MC3): it keeps the page's
// own files so the home-screen app opens quickly. It never stores anything
// from /api: no message, question or credential is cached on the phone.
// Notices (MC11) arrive empty and show one fixed line.
const CACHE = "coop-companion-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "shared/themes.css", "shared/dialogs.mjs", "shared/markdown.mjs", "shared/attach-note.mjs", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Network first, so a new coop version shows at once; the cache only when offline.
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request)));
});

self.addEventListener("push", (event) => {
  event.waitUntil(self.registration.showNotification("coop", { body: "coop is waiting for you.", tag: "coop", renotify: true, icon: "icon-180.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow("./");
  }));
});
