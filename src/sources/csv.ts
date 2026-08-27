import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { RawParticipant } from "../protocol/participant.js";

export interface CsvSourceOptions {
  /** Column holding the username. Default: "username". */
  usernameColumn?: string;
  /**
   * If the CSV has no header row, set this to treat the first column as the
   * username. Default false (a header row is expected).
   */
  noHeader?: boolean;
}

/**
 * Read participants from a CSV file. Each data row becomes one RawParticipant
 * with a stable, provenance-preserving source_id ("row_<n>", 1-based over data
 * rows). Normalization and dedup happen later in freezeParticipants, so this
 * stays a thin ingestion layer.
 */
export function readCsvParticipants(
  path: string,
  options: CsvSourceOptions = {},
): RawParticipant[] {
  const text = readFileSync(path, "utf8");
  return parseCsvParticipants(text, options);
}

export function parseCsvParticipants(
  text: string,
  options: CsvSourceOptions = {},
): RawParticipant[] {
  const usernameColumn = options.usernameColumn ?? "username";

  if (options.noHeader) {
    const rows = parse(text, {
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
    return rows.map((row, i) => ({
      username: row[0] ?? "",
      source: "csv",
      source_id: `row_${i + 1}`,
    }));
  }

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return records.map((rec, i) => {
    if (!(usernameColumn in rec)) {
      throw new Error(
        `CSV row ${i + 1} has no "${usernameColumn}" column (found: ${Object.keys(
          rec,
        ).join(", ")})`,
      );
    }
    return {
      username: rec[usernameColumn] ?? "",
      source: "csv",
      source_id: `row_${i + 1}`,
    };
  });
}
