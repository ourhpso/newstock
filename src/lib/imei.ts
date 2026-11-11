/** Extract a 15-digit IMEI from plain text or common barcode payloads.
 * Some scanners prepend AIM identifiers (for example ]C1) or GS1 application
 * identifiers. Search every 15-digit window and prefer a valid Luhn candidate
 * instead of blindly taking the first 15 digits (which may include a prefix).
 */
export function extractImei(raw: string): string {
  const digits = raw.replace(/\\D/g, "");
  if (digits.length <= 15) return digits;
  for (let start = 0; start <= digits.length - 15; start++) {
    const candidate = digits.slice(start, start + 15);
    if (isValidImeiFormat(candidate)) return candidate;
  }
  // Keep a deterministic candidate so the UI can show a useful checksum error.
  return digits.slice(0, 15);
}

/** IMEI must be 15 digits and pass the Luhn checksum. */
export function isValidImeiFormat(imei: string): boolean {
  if (!/^\\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(imei[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function signalFeedback(ok: boolean) {
  if (typeof navigator === "undefined") return;
  if (!ok && "vibrate" in navigator) navigator.vibrate([200, 100, 200]);
}

/** Format every visible numeric value with Latin digits, independent of UI language. */
export function formatNumber(n: number | string | null | undefined, maximumFractionDigits = 2): string {
  const value = Number(n ?? 0);
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-IN", {
    useGrouping: true,
    maximumFractionDigits,
  });
}

export const formatInteger = (n: number | string | null | undefined) => formatNumber(n, 0);

/** Date/time labels also use an English locale so digits never switch with UI language. */
export const formatDateTime = (value: string | number | Date) =>
  (value instanceof Date ? value : new Date(value)).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });

export const formatDate = (value: string | number | Date) =>
  (value instanceof Date ? value : new Date(value)).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium" });

export const money = (n: number | string | null | undefined) =>
  "৳" + formatNumber(n, 2);
