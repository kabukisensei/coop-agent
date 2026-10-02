// The window's own files, served over coop://app/ (a privileged standard
// scheme, so ES modules load) with a strict Content-Security-Policy. Only
// files under desktop/renderer with a known type are served.
import { resolve, relative, isAbsolute, extname, sep } from "node:path";

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const APP_ORIGIN = "coop://app";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The file and type for a coop://app/ URL, or null when it is not servable. */
export function resolveAsset(root, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "coop:" || parsed.host !== "app") return null;
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
  if (path.includes("\0") || path.includes("\\")) return null;
  if (path === "/" || path === "") path = "/index.html";
  const file = resolve(root, `.${path}`);
  const rel = relative(resolve(root), file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).some((part) => part.startsWith("."))) return null;
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return null;
  return { file, type };
}

/** True when a frame URL belongs to the window's own pages. */
export function isAppUrl(url) {
  return typeof url === "string" && url.startsWith(`${APP_ORIGIN}/`);
}
