/** CSV (Excel-compatible, BOM so Bengali opens correctly) + download/share helpers. */

type Cell = string | number | null | undefined;

export function toCsv(rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Share via the device share sheet when possible (mobile), else download. */
export async function deliverBlob(blob: Blob, filename: string, title?: string) {
  const file = new File([blob], filename, { type: blob.type });
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title ?? filename });
      return;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
    }
  }
  downloadBlob(blob, filename);
}

export function exportCsv(filename: string, rows: Cell[][], title?: string) {
  return deliverBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), filename, title);
}


type ExcelSheet = { name: string; rows: Cell[][] };

/** Creates a real multi-sheet Excel 2003 XML workbook (opens directly in Excel). */
export function exportExcelWorkbook(filename: string, sheets: ExcelSheet[], title?: string) {
  const xml = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#0F766E" ss:Pattern="Solid"/></Style><Style ss:ID="Money"><NumberFormat ss:Format="&quot;৳&quot;#,##0.00"/></Style></Styles>
${sheets.map((sheet) => `<Worksheet ss:Name="${xml(sheet.name.slice(0,31))}"><Table>${sheet.rows.map((row, index) => `<Row>${row.map((cell) => {
    if (cell === null || cell === undefined) return "<Cell/>";
    const numeric = typeof cell === "number" && Number.isFinite(cell);
    const style = index === 0 ? ' ss:StyleID="Header"' : "";
    return `<Cell${style}><Data ss:Type="${numeric ? "Number" : "String"}">${xml(cell)}</Data></Cell>`;
  }).join("")}</Row>`).join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`).join("")}
</Workbook>`;
  return deliverBlob(new Blob(["\\uFEFF", workbook], { type: "application/vnd.ms-excel;charset=utf-8" }), filename.replace(/\.xlsx$/i, ".xls"), title);
}
