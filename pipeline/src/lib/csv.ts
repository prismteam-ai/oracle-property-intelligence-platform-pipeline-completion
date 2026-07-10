/**
 * Minimal dependency-free RFC 4180 CSV parser.
 *
 * Handles quoted fields, embedded commas/newlines, and escaped quotes ("").
 * Returns an array of objects keyed by the header row. Adequate for the
 * moderate-size municipal CSV exports we ingest (permits, assessor extracts);
 * for very large files switch the caller to DuckDB's read_csv_auto.
 */

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      // Handle CRLF: swallow the \n after \r.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      // Ignore blank lines produced by trailing newlines.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Flush the final field/row if the file didn't end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) obj[header[c]!] = r[c] ?? "";
    return obj;
  });
}
