import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { extractImei, isValidImeiFormat, signalFeedback } from "@/lib/imei";
import { cn } from "@/lib/utils";

export type ScanResult = { ok: boolean; message?: string | undefined };

/**
 * Reusable camera + keyboard/manual IMEI scanner. The parent owns the business
 * rule (warehouse intake, issue, sale or return); this component owns barcode
 * normalization, duplicate suppression, camera lifecycle and scan feedback.
 */
export function ImeiScanner({ validate }: { validate: (imei: string) => Promise<ScanResult> }) {
  const { t } = useT();
  const [signal, setSignal] = useState<null | { ok: boolean; text: string }>(null);
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const busy = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const elId = useRef("scan-" + Math.random().toString(36).slice(2)).current;

  async function handle(raw: string) {
    const imei = extractImei(raw);
    if (!imei) {
      setSignal({ ok: false, text: t("imeiWrong") });
      signalFeedback(false);
      return;
    }
    const now = Date.now();
    if (busy.current || (lastRef.current.code === imei && now - lastRef.current.at < 2500)) return;
    lastRef.current = { code: imei, at: now };
    busy.current = true;
    try {
      const res = !isValidImeiFormat(imei)
        ? { ok: false, message: "IMEI format/checksum" }
        : await validateRef.current(imei);
      signalFeedback(res.ok);
      setSignal({
        ok: res.ok,
        text: `${res.ok ? t("imeiOk") : t("imeiWrong")} ${imei}${res.message ? " — " + res.message : ""}`,
      });
    } catch (error) {
      signalFeedback(false);
      setSignal({ ok: false, text: `${t("imeiWrong")} ${imei} — ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      busy.current = false;
    }
  }

  async function stop() {
    const current = scannerRef.current;
    scannerRef.current = null;
    if (current) {
      await current.stop().catch(() => undefined);
      try { current.clear(); } catch { /* The element may already be detached. */ }
    }
    setScanning(false);
  }

  async function start() {
    if (startingRef.current || scannerRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      const s = new Html5Qrcode(elId, {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.PDF_417,
        ],
        verbose: false,
      });
      try {
        await s.start(
          { facingMode: "environment" },
          {
            fps: 12,
            qrbox: (width, height) => ({
              width: Math.max(180, Math.min(320, Math.floor(width * 0.88))),
              height: Math.max(90, Math.min(160, Math.floor(height * 0.5))),
            }),
            aspectRatio: 1.777,
          },
          (text) => void handle(text),
          () => undefined,
        );
        scannerRef.current = { stop: () => s.stop(), clear: () => s.clear() };
        setScanning(true);
        setSignal({ ok: true, text: "Camera ready — barcode scan করুন" });
      } catch (error) {
        try { s.clear(); } catch { /* Camera may never have initialized. */ }
        throw error;
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  useEffect(() => () => {
    const current = scannerRef.current;
    if (current) void current.stop().catch(() => undefined).finally(() => {
      try { current.clear(); } catch { /* Unmount cleanup. */ }
    });
  }, []);

  return (
    <div className="space-y-2">
      <div id={elId} className={cn("min-h-2 overflow-hidden rounded-lg", scanning && "border")} />
      <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
        <Button
          type="button"
          disabled={starting}
          variant={scanning ? "outline" : "default"}
          onClick={() => (scanning ? void stop() : void start().catch((error) => {
            setSignal({ ok: false, text: error instanceof Error ? error.message : String(error) });
          }))}
        >
          {starting ? "Starting camera…" : scanning ? t("stopScan") : t("scan")}
        </Button>
        <form
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) void handle(manual.trim()).then(() => setManual(""));
          }}
        >
          <Input inputMode="numeric" placeholder={t("typeImei")} value={manual} onChange={(e) => setManual(e.target.value)} />
          <Button type="submit" variant="secondary">{t("add")}</Button>
        </form>
      </div>
      {signal && (
        <div
          role="status"
          className={cn(
            "break-words rounded-lg px-4 py-3 text-sm font-semibold transition-colors motion-reduce:animate-none",
            signal.ok ? "bg-success text-success-foreground" : "animate-pulse bg-destructive text-destructive-foreground",
          )}
        >
          {signal.ok ? "● " : "✖ "}
          {signal.text}
        </div>
      )}
    </div>
  );
}
