export const PREVIEW_URL_KEY = 'cw:preview-url';
export const DRAFT_PREVIEW_SESSION = 'draft';

export function previewSessionKey(sessionId: string | null | undefined): string {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : DRAFT_PREVIEW_SESSION;
}

export function previewUrlStorageKey(sessionId: string | null | undefined): string {
  return `${PREVIEW_URL_KEY}:${previewSessionKey(sessionId)}`;
}

/**
 * Turn address-bar input into an absolute http(s) URL.
 * Accepts bare hosts like `baidu.com` or `localhost:5173`.
 */
export function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Only treat as absolute if it already has a scheme with `://`
  // (avoids misreading `localhost:5173` as scheme `localhost`).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  const host = trimmed.split('/')[0]?.split(':')[0]?.toLowerCase() ?? '';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
  return `${loopback ? 'http' : 'https'}://${trimmed}`;
}

/**
 * Safe to load in the preview WebView / pop-out window.
 * Any http(s) URL with a host is allowed.
 */
export function isPreviewableUrl(raw: string): boolean {
  try {
    const u = new URL(normalizePreviewUrl(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return Boolean(u.hostname);
  } catch {
    return false;
  }
}

export interface ElementSelection {
  url: string;
  viewport: { width: number; height: number };
  domPath: string;
  tagName: string;
  textContent: string;
  attributes: {
    id: string | null;
    class: string | null;
    role: string | null;
    name: string | null;
    ariaLabel: string | null;
  };
  outerHtmlSnippet: string;
  styleSummary: Record<string, string>;
}

export function isElementSelection(v: unknown): v is ElementSelection {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.url !== 'string' ||
    typeof o.domPath !== 'string' ||
    typeof o.tagName !== 'string' ||
    typeof o.textContent !== 'string' ||
    typeof o.outerHtmlSnippet !== 'string'
  ) {
    return false;
  }
  const vp = o.viewport;
  if (!vp || typeof vp !== 'object') return false;
  const vpc = vp as Record<string, unknown>;
  if (typeof vpc.width !== 'number' || typeof vpc.height !== 'number') return false;
  const attrs = o.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  const styles = o.styleSummary;
  if (!styles || typeof styles !== 'object') return false;
  return true;
}

export function formatElementContext(sel: ElementSelection): string {
  const lines = [
    `[Page Element]`,
    `URL: ${sel.url}`,
    `Path: ${sel.domPath}`,
    `Tag: ${sel.tagName}`,
  ];
  if (sel.textContent) lines.push(`Text: "${sel.textContent.slice(0, 200)}"`);
  const attrs = Object.entries(sel.attributes)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
  if (attrs) lines.push(`Attributes: ${attrs}`);
  const styles = Object.entries(sel.styleSummary)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (styles) lines.push(`Styles: ${styles}`);
  lines.push(`HTML: ${sel.outerHtmlSnippet.slice(0, 500)}`);
  return lines.join('\n');
}

export function newPreviewInstanceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
