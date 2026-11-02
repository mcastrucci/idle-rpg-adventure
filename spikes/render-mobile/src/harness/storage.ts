/**
 * Per-device convenience store of the latest report per renderer/variant, so the picker page can copy everything
 * at once. Browser storage may be unavailable (private mode, WebView settings): every access is guarded.
 */
import type { Report } from '../metrics/stats.ts';

const KEY = 'render-mobile-spike:reports:v1';

export function loadReports(): Report[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Report[]) : [];
  } catch {
    return [];
  }
}

export function saveReport(report: Report): void {
  try {
    const id = (r: Report): string => `${r.renderer.id}|${r.variant.format}|${r.variant.resolution}`;
    const others = loadReports().filter((r) => id(r) !== id(report));
    localStorage.setItem(KEY, JSON.stringify([...others, report]));
  } catch {
    // Storage unavailable: the on-screen results and the copy button still work.
  }
}

export function clearReports(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Clipboard with a fallback for WebViews / non-secure origins (plain http on a LAN IP). */
export async function copyText(text: string, fallbackEl?: HTMLTextAreaElement): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = fallbackEl ?? document.createElement('textarea');
  const temporary = !fallbackEl;
  if (temporary) {
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
  }
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  if (temporary) ta.remove();
  return ok;
}
