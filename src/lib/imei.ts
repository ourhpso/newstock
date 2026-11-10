/** Extract a 15-digit IMEI from scanned text (barcodes may include prefixes). */
export function extractImei(raw: string): string {
  const m = raw.replace(/\s/g, "").match(/\d{15}/);
  return m ? m[0] : raw.replace(/\D/g, "");
}

/** IMEI must be 15 digits and pass the Luhn checksum. */
export function isValidImeiFormat(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
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
  new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });

export const formatDate = (value: string | number | Date) =>
  new Date(value).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium" });

export const money = (n: number | string | null | undefined) =>
  "৳" + formatNumber(n, 2);
