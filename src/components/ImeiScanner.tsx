import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { extractImei, isValidImeiFormat, signalFeedback } from "@/lib/imei";
import { cn } from "@/lib/utils";

export type ScanResult = { ok: boolean; message?: string | undefined };

const BARCODE_FORMATS = [
  "Code128", "Code39", "EAN13", "EAN8", "ITF", "UPCA", "UPCE",
  "DataMatrix", "QRCode", "PDF417",
] as const;

type WasmReader = typeof import("zxing-wasm/reader");
type NativeBarcode = { rawValue?: string };
type NativeDetector = {
  detect: (source: HTMLVideoElement | ImageBitmap) => Promise<NativeBarcode[]>;
};
type NativeDetectorConstructor = {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};
type CameraCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
};
type AdvancedCameraConstraint = MediaTrackConstraintSet & {
  focusMode?: string;
  exposureMode?: string;
  whiteBalanceMode?: string;
  torch?: boolean;
  zoom?: number;
};

const READER_OPTIONS = {
  formats: [...BARCODE_FORMATS],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 8,
};

let wasmReaderPromise: Promise<WasmReader> | null = null;
function loadWasmReader() {
  wasmReaderPromise ??= import("zxing-wasm/reader");
  return wasmReaderPromise;
}

/**
 * Hybrid camera scanner: native BarcodeDetector for low-latency frames and
 * ZXing-C++ WebAssembly as the broad-format, hard-case fallback. Camera frames
 * are processed locally; only the extracted IMEI is passed to the parent.
 */
export function ImeiScanner({ validate }: { validate: (imei: string) => Promise<ScanResult> }) {
  const { t } = useT();
  const [signal, setSignal] = useState<null | { ok: boolean; text: string }>(null);
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const startingRef = useRef(false);
  const frameBusyRef = useRef(false);
  const frameCountRef = useRef(0);
  const busyRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const detectorRef = useRef<NativeDetector | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const elId = useRef("imei-camera-" + Math.random().toString(36).slice(2)).current;

  const handle = useCallback(async (raw: string) => {
    const imei = extractImei(raw);
    if (!imei) {
      setSignal({ ok: false, text: t("imeiWrong") });
      signalFeedback(false);
      return;
    }
    const now = Date.now();
    if (busyRef.current || (lastRef.current.code === imei && now - lastRef.current.at < 2500)) return;
    lastRef.current = { code: imei, at: now };
    busyRef.current = true;
    try {
      const result = !isValidImeiFormat(imei)
        ? { ok: false, message: "IMEI format/checksum" }
        : await validateRef.current(imei);
      signalFeedback(result.ok);
      setSignal({
        ok: result.ok,
        text: `${result.ok ? t("imeiOk") : t("imeiWrong")} ${imei}${result.message ? " — " + result.message : ""}`,
      });
    } catch (error) {
      signalFeedback(false);
      setSignal({
        ok: false,
        text: `${t("imeiWrong")} ${imei} — ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      busyRef.current = false;
    }
  }, [t]);

  const decodeImage = useCallback(async (source: ImageData | Blob) => {
    const { readBarcodes } = await loadWasmReader();
    const results = await readBarcodes(source, READER_OPTIONS);
    const value = results.find((item) => item.text)?.text;
    if (value) await handle(value);
    return Boolean(value);
  }, [handle]);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    trackRef.current = null;
    detectorRef.current = null;
    frameBusyRef.current = false;
    setScanning(false);
    setTorchAvailable(false);
    setTorchOn(false);
  }, []);

  const scanFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (frameBusyRef.current) return;
    frameBusyRef.current = true;
    frameCountRef.current += 1;
    try {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);

      // Native detection is attempted on every frame where the browser supports it.
      if (detectorRef.current) {
        try {
          const nativeResults = await detectorRef.current.detect(video);
          const nativeValue = nativeResults.find((item) => item.rawValue)?.rawValue;
          if (nativeValue) {
            await handle(nativeValue);
            return;
          }
        } catch {
          // A native decoder can fail on a single frame; keep the WASM fallback alive.
        }
      }

      // Run the heavier WASM decoder on a cadence to keep camera preview smooth.
      if (!detectorRef.current || frameCountRef.current % 3 === 0) {
        const frame = context.getImageData(0, 0, width, height);
        if (await decodeImage(frame)) return;

        // Retry a centered, enlarged region for compact labels while preserving
        // the full-frame pass so labels near the edge are never excluded.
        if (frameCountRef.current % 6 === 0) {
          const cropWidth = Math.floor(width * 0.72);
          const cropHeight = Math.floor(height * 0.72);
          const cropX = Math.floor((width - cropWidth) / 2);
          const cropY = Math.floor((height - cropHeight) / 2);
          const retryCanvas = document.createElement("canvas");
          retryCanvas.width = cropWidth * 2;
          retryCanvas.height = cropHeight * 2;
          const retryContext = retryCanvas.getContext("2d", { willReadFrequently: true });
          if (retryContext) {
            retryContext.imageSmoothingEnabled = false;
            retryContext.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, retryCanvas.width, retryCanvas.height);
            const retryImage = retryContext.getImageData(0, 0, retryCanvas.width, retryCanvas.height);
            await decodeImage(retryImage);
          }
        }
      }
    } catch (error) {
      setSignal({ ok: false, text: `Scanner error: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      frameBusyRef.current = false;
    }
  }, [decodeImage, handle]);

  const start = useCallback(async () => {
    if (startingRef.current || streamRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("এই ব্রাউজারে ক্যামেরা সমর্থিত নয়। HTTPS সংযোগ বা আধুনিক ব্রাউজার ব্যবহার করুন।");
      }
      // Warm the WASM module before the first difficult frame; the import is lazy.
      const wasmReady = loadWasmReader();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      trackRef.current = track ?? null;
      if (track) {
        const capabilities = track.getCapabilities() as CameraCapabilities;
        setTorchAvailable(Boolean(capabilities.torch));
        const advanced: AdvancedCameraConstraint[] = [];
        if (capabilities.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
        if (capabilities.focusMode?.includes("single-shot")) advanced.push({ focusMode: "single-shot" });
        if (advanced.length) {
          try { await track.applyConstraints({ advanced }); } catch { /* Optional camera capability. */ }
        }
        if (capabilities.zoom) {
          const initialZoom = Math.max(capabilities.zoom.min, Math.min(1, capabilities.zoom.max));
          setZoom(initialZoom);
        }
      }
      const video = videoRef.current;
      if (!video) throw new Error("ক্যামেরা প্রিভিউ পাওয়া যায়নি।");
      video.srcObject = stream;
      await video.play();
      await wasmReady;

      // Use the native API only for formats the current browser actually supports.
      const Detector = (window as Window & { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
      if (Detector) {
        try {
          const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats() : [...BARCODE_FORMATS];
          const nativeFormats = [...BARCODE_FORMATS].filter((format) => supported.includes(format));
          if (nativeFormats.length) detectorRef.current = new Detector({ formats: nativeFormats });
        } catch {
          detectorRef.current = null;
        }
      }
      setScanning(true);
      setSignal({ ok: true, text: "Camera ready — বারকোডটি ফ্রেমের মধ্যে ধরুন" });

      const tick = async () => {
        if (!streamRef.current) return;
        await scanFrame();
        if (streamRef.current) rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (error) {
      stop();
      setSignal({
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [scanFrame, stop]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as AdvancedCameraConstraint] });
      setTorchOn(next);
    } catch {
      setSignal({ ok: false, text: "এই ক্যামেরায় ফ্ল্যাশ নিয়ন্ত্রণ সমর্থিত নয়।" });
    }
  }, [torchOn]);

  const changeZoom = useCallback(async (value: number) => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as AdvancedCameraConstraint] });
      setZoom(value);
    } catch {
      setSignal({ ok: false, text: "এই ক্যামেরায় zoom নিয়ন্ত্রণ সমর্থিত নয়।" });
    }
  }, []);

  const scanFile = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      setSignal({ ok: true, text: "ছবি বিশ্লেষণ করা হচ্ছে…" });
      const found = await decodeImage(file);
      if (!found) {
        setSignal({ ok: false, text: "ছবিতে কোনো পাঠযোগ্য বারকোড পাওয়া যায়নি। আরও পরিষ্কার ও কাছ থেকে ছবি তুলুন।" });
        signalFeedback(false);
      }
    } catch (error) {
      setSignal({ ok: false, text: `ছবি স্ক্যান করা যায়নি: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [decodeImage]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  return (
    <div className="space-y-2">
      <div className={cn("relative overflow-hidden rounded-lg bg-black", scanning ? "border" : "hidden")}>
        <video
          id={elId}
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="max-h-[420px] min-h-[180px] w-full object-contain"
        />
        <div className="pointer-events-none absolute inset-[15%] rounded-lg border-2 border-emerald-400/90 shadow-[0_0_0_999px_rgba(0,0,0,0.12)]" />
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={starting} variant={scanning ? "outline" : "default"} onClick={() => (scanning ? stop() : void start())}>
          {starting ? "Starting camera…" : scanning ? t("stopScan") : t("scan")}
        </Button>
        {scanning && torchAvailable && (
          <Button type="button" variant="secondary" onClick={() => void toggleTorch()}>
            {torchOn ? "Flash off" : "Flash on"}
          </Button>
        )}
        {scanning && (
          <label className="flex items-center gap-2 rounded-md border px-3 text-sm">
            Zoom
            <input
              aria-label="Camera zoom"
              type="range"
              min={1}
              max={4}
              step={0.1}
              value={zoom}
              onChange={(event) => void changeZoom(Number(event.target.value))}
            />
          </label>
        )}
        <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
          ছবি থেকে স্ক্যান
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => void scanFile(event.target.files?.[0])}
        />
      </div>
      <form
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (manual.trim()) void handle(manual.trim()).then(() => setManual(""));
        }}
      >
        <Input inputMode="numeric" placeholder={t("typeImei")} value={manual} onChange={(event) => setManual(event.target.value)} />
        <Button type="submit" variant="secondary">{t("add")}</Button>
      </form>
      {signal && (
        <div
          role="status"
          aria-live="polite"
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
