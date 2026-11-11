import { describe, expect, it } from "vitest";
import { extractImei, formatDate, formatDateTime, formatInteger, formatNumber, isValidImeiFormat, money } from "./imei";

describe("IMEI rules", () => {
  it("accepts a valid 15-digit Luhn IMEI", () => {
    expect(isValidImeiFormat("490154203237518")).toBe(true);
  });
  it("rejects a wrong checksum IMEI", () => {
    expect(isValidImeiFormat("490154203237519")).toBe(false);
  });
  it("rejects IMEI with wrong length", () => {
    expect(isValidImeiFormat("49015420323751")).toBe(false);
  });
  it("extracts IMEI from scanned barcode text with a numeric prefix", () => {
    expect(extractImei("IMEI1: 490154203237518")).toBe("490154203237518");
  });
  it("skips a barcode AIM prefix and chooses the valid Luhn IMEI", () => {
    expect(extractImei("]C1490154203237518")).toBe("490154203237518");
  });
  it("does not mistake a 14-digit GTIN prefix for the IMEI", () => {
    expect(extractImei("010123456789012821490154203237518")).toBe("490154203237518");
  });
  it("keeps a deterministic candidate for invalid-checksum feedback", () => {
    expect(extractImei("IMEI: 490154203237519")).toBe("490154203237519");
  });
});


describe("English numeral formatting", () => {
  it("uses Latin digits and grouping for quantities", () => {
    expect(formatInteger(1234567)).toBe("12,34,567");
  });
  it("uses Latin digits and decimal points for amounts", () => {
    expect(formatNumber(1234567.5)).toBe("12,34,567.5");
    expect(money(1234.5)).toBe("৳1,234.5");
  });
  it("uses English date and time digits regardless of UI language", () => {
    expect(formatDate("2026-11-10T00:00:00.000Z")).toMatch(/[0-9]/);
    expect(formatDateTime("2026-11-10T00:00:00.000Z")).toMatch(/[0-9]/);
  });
});
