// Build-time switches, like the phone's BuildProfile fields. They only decide
// what the workbench shows; sync, storage and AI logic stay the same.
// `npm run build -- --mode hosted` reads apps/web/.env.hosted. Deployment values
// (filing number, privacy page) are passed in at build time, never committed.

/** The public build: web and `/v1` share one origin behind Nginx (#71). */
export const HOSTED = import.meta.env?.VITE_HOSTED === 'true';

/** `false` hides every AI entry, like the phone's `AI_ENTRY` (AGENTS.md 7.2). */
export const AI_ENTRY = import.meta.env?.VITE_AI_ENTRY !== 'false';

/** ICP filing number shown in the page footer, e.g. 粤ICP备…号. */
export const ICP_RECORD = (import.meta.env?.VITE_ICP_RECORD ?? '').trim();

/** Address of the privacy policy page; empty hides the links. */
export const PRIVACY_URL = (import.meta.env?.VITE_PRIVACY_URL ?? '').trim();

export const LOCAL_SYNC_API = 'http://127.0.0.1:8787';

/**
 * The hosted build talks to its own origin, so the pairing QR code carries a
 * full https address and the device token is stored under it.
 * @param {boolean} hosted
 * @param {string | undefined} configured VITE_SYNC_API_BASE
 * @param {string | undefined} origin location.origin
 * @returns {string}
 */
export function resolveApiBase(hosted, configured, origin) {
  if (hosted && origin) return origin;
  return configured ?? LOCAL_SYNC_API;
}
