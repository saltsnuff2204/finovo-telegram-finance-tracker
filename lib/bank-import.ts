/**
 * Bank statement reader for the Mini App. The original file never leaves the
 * browser: only reviewed, normalized entries are sent to the import API.
 */

export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ENTRIES = 500;
const MAX_GRID_ROWS = 1000;
const MAX_GRID_COLUMNS = 60;

export type ImportEntry = {
  type: "income" | "expense";
  amount: number;
  currency: string;
  category: string;
  note: string;
  happenedAt: string;
  sourceKey: string;
};

export type StatementGrid = {
  filename: string;
  headers: string[];
  rows: string[][];
  /** All rows, including bank logos, titles, and the selected header. */
  rawRows: string[][];
  /** Zero-based index in rawRows. -1 means there is no header. */
  headerRowIndex: number;
  warnings: string[];
  sheetName?: string;
  /** Kaspi PDF: operation indices (zero-based in rows) not yet confirmed by the bank. */
  pendingRowIndices?: number[];
};

export type StatementMapping = {
  dateColumn: number | null;
  amountColumn: number | null;
  debitColumn: number | null;
  creditColumn: number | null;
  descriptionColumn: number | null;
  currencyColumn: number | null;
  categoryColumn: number | null;
  referenceColumn: number | null;
  directionColumn: number | null;
  defaultCurrency: string;
  dateOrder: "DMY" | "MDY" | "YMD";
  /** Used for a signed amount column when directionColumn is not set. */
  positiveAmountType: "income" | "expense";
};

export type StatementRowError = { rowNumber: number; message: string };
export type StatementMappingResult = { entries: ImportEntry[]; errors: StatementRowError[]; warnings: string[] };

type Cell = string | number | boolean | Date | null | undefined;

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru")
  .replace(/ё/g, "е").replace(/[\s\u00a0\u202f]+/g, " ").trim();

const normalizeHeader = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function cellText(value: Cell): string {
  if (value instanceof Date) {
    // Excel dates represent a wall-clock date, not an instant in UTC.
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`
      + ` ${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}:${String(value.getUTCSeconds()).padStart(2, "0")}`;
  }
  return value == null ? "" : String(value).replace(/\u0000/g, "").trim();
}

function normalizeRows(rows: Cell[][]): string[][] {
  if (rows.length > MAX_GRID_ROWS) throw new Error(`В выписке слишком много строк. Разделите файл на части до ${MAX_IMPORT_ENTRIES} операций.`);
  return rows.map((row) => {
    if (row.length > MAX_GRID_COLUMNS) throw new Error("В выписке слишком много колонок.");
    return row.map(cellText);
  });
}

function headerScore(row: string[]): number {
  const labels = row.map(normalizeHeader).filter(Boolean);
  if (labels.length < 2) return -1;
  const has = (pattern: RegExp) => labels.some((label) => pattern.test(label));
  let score = Math.min(labels.length, 8);
  if (has(/дата|date|день/)) score += 12;
  if (has(/сумма|amount|debit|credit|расход|приход|списан|поступлен|дебет|кредит/)) score += 12;
  if (has(/описание|назначение|детали|контрагент|магазин|merchant|description|details|операция/)) score += 5;
  if (has(/валюта|currency|категория|category|тип|type/)) score += 3;
  if (labels.every((label) => /^\d|^[-+]?\d/.test(label))) score -= 20;
  return score;
}

function bestHeaderRow(rows: string[][]): number {
  let bestIndex = -1;
  // A title or a headerless transaction row may have several filled cells;
  // require at least one recognizable header label before dropping any row.
  let bestScore = 9;
  for (let index = 0; index < Math.min(rows.length, 30); index++) {
    const score = headerScore(rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

export function setStatementHeaderRow(grid: StatementGrid, headerRowIndex: number): StatementGrid {
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < -1 || headerRowIndex >= grid.rawRows.length) {
    throw new Error("Выберите строку с заголовками выписки.");
  }
  const sourceHeader = headerRowIndex < 0 ? [] : grid.rawRows[headerRowIndex];
  const sourceRows = grid.rawRows.slice(headerRowIndex + 1);
  const width = Math.max(sourceHeader.length, ...sourceRows.map((row) => row.length), 0);
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, index) => {
    const text = sourceHeader[index]?.trim() || `Колонка ${index + 1}`;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} (${count})`;
  });
  const rows = sourceRows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  return { ...grid, headerRowIndex, headers, rows };
}

function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

export async function parseStatementFile(file: File): Promise<StatementGrid> {
  if (!file || file.size === 0) throw new Error("Выберите непустой файл выписки.");
  if (file.size > MAX_STATEMENT_BYTES) throw new Error("Файл больше 2 МБ. Выгрузите меньший период выписки.");
  const extension = file.name.toLocaleLowerCase("en").split(".").at(-1);
  let rawRows: string[][];
  let sheetName: string | undefined;
  let pendingRowIndices: number[] | undefined;
  const warnings: string[] = [];

  if (extension === "xlsx") {
    try {
      // Loaded only when the user selects Excel, keeping the normal app light.
      const { default: readExcelFile } = await import("read-excel-file/browser");
      const sheets = await readExcelFile(file);
      if (!sheets.length) throw new Error("В книге нет листов.");
      const candidates = sheets.map((sheet) => ({
        sheet: sheet.sheet,
        // The library's declaration uses `typeof Date`; runtime cells are Date instances.
        rows: normalizeRows(sheet.data as unknown as Cell[][]),
      }));
      candidates.sort((a, b) => {
        const aIndex = bestHeaderRow(a.rows);
        const bIndex = bestHeaderRow(b.rows);
        return (headerScore(b.rows[bIndex] ?? []) + Math.min(b.rows.length, 10))
          - (headerScore(a.rows[aIndex] ?? []) + Math.min(a.rows.length, 10));
      });
      rawRows = candidates[0].rows;
      sheetName = candidates[0].sheet;
      if (sheets.length > 1) warnings.push(`Выбран лист «${sheetName}» из ${sheets.length}. Проверьте предпросмотр.`);
    } catch (error) {
      if (error instanceof Error && /слишком много/.test(error.message)) throw error;
      throw new Error("Не удалось прочитать XLSX. Проверьте, что это обычная таблица Excel без пароля.");
    }
  } else if (extension === "csv" || extension === "tsv" || extension === "txt") {
    const text = decodeText(await file.arrayBuffer());
    const { default: Papa } = await import("papaparse");
    const parsed = Papa.parse<string[]>(text, {
      delimiter: extension === "tsv" ? "\t" : "",
      delimitersToGuess: [";", ",", "\t", "|"],
      skipEmptyLines: false,
    });
    const serious = parsed.errors.filter((error) => error.code !== "UndetectableDelimiter");
    if (serious.length) throw new Error(`Не удалось разобрать CSV: ${serious[0].message}`);
    rawRows = normalizeRows(parsed.data);
    if (parsed.meta.delimiter === "," && text.includes(";")) {
      warnings.push("Проверьте разделение на колонки: в файле встречаются и запятые, и точки с запятой.");
    }
  } else if (extension === "pdf") {
    const { parseKaspiGoldPdfFile } = await import("./kaspi-pdf");
    const parsed = await parseKaspiGoldPdfFile(file);
    rawRows = normalizeRows(parsed.rawRows);
    pendingRowIndices = parsed.pendingRowIndices;
    warnings.push(...parsed.warnings);
  } else if (extension === "xls") {
    throw new Error("Старый XLS пока не поддерживается. Используйте XLSX, CSV или PDF Kaspi Gold.");
  } else {
    throw new Error("Выберите выписку в формате CSV, TSV, XLSX или PDF Kaspi Gold.");
  }

  if (!rawRows.some((row) => row.some((cell) => cell.trim()))) throw new Error("Файл не содержит данных.");
  const grid: StatementGrid = {
    filename: file.name, headers: [], rows: [], rawRows,
    headerRowIndex: -1, warnings, sheetName, pendingRowIndices,
  };
  return setStatementHeaderRow(grid, extension === "pdf" ? 0 : bestHeaderRow(rawRows));
}

function pickColumn(headers: string[], rules: Array<[RegExp, number]>, excluded: number[] = []): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;
  headers.forEach((header, index) => {
    if (excluded.includes(index)) return;
    const label = normalizeHeader(header);
    const score = rules.reduce((total, [pattern, weight]) => total + (pattern.test(label) ? weight : 0), 0);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

const dateRules: Array<[RegExp, number]> = [
  [/дата операции|transaction date|operation date/, 12],
  [/дата|date|время/, 6],
  [/проводки|создания/, 2],
];
const debitRules: Array<[RegExp, number]> = [
  [/расход|списание|списано|дебет|debit|withdrawal|outflow/, 10],
  [/сумма списания|expense amount/, 10],
];
const creditRules: Array<[RegExp, number]> = [
  [/приход|доход|поступление|поступило|зачисление|пополнение|credit|income|deposit|inflow/, 10],
  [/сумма поступления|income amount/, 10],
];

export function suggestMapping(grid: StatementGrid): StatementMapping {
  const headers = grid.headers;
  const dateColumn = pickColumn(headers, dateRules);
  const debitColumn = pickColumn(headers, debitRules, dateColumn == null ? [] : [dateColumn]);
  const creditColumn = pickColumn(headers, creditRules,
    [dateColumn, debitColumn].filter((value): value is number => value !== null));
  const amountColumn = debitColumn !== null && creditColumn !== null ? null : pickColumn(headers, [
    [/сумма|amount|итого|total/, 8],
    [/операции|transaction/, 2],
  ], [dateColumn, debitColumn, creditColumn].filter((value): value is number => value !== null));
  const descriptionColumn = pickColumn(headers, [
    [/описание|назначение|детали|контрагент|получатель|отправитель|магазин|merchant|description|details|memo|комментарий/, 10],
    [/операция|operation|наименование/, 3],
  ], [dateColumn, debitColumn, creditColumn, amountColumn].filter((value): value is number => value !== null));
  const directionColumn = pickColumn(headers, [
    [/тип операции|вид операции|operation type|transaction type|направление|приход расход|дебет кредит|debit credit/, 12],
    [/^(тип|type|вид)$/, 5],
  ], [dateColumn, amountColumn, debitColumn, creditColumn, descriptionColumn]
    .filter((value): value is number => value !== null));
  const currencyColumn = pickColumn(headers, [[/валюта|currency|ccy/, 10]]);
  const categoryColumn = pickColumn(headers, [[/категория|category/, 10]]);
  const referenceColumn = pickColumn(headers, [
    [/transaction id|operation id|reference|референс|rrn|номер операции|номер транзакции|идентификатор/, 10],
    [/^(id|ид|номер)$/, 3],
  ]);
  const dateSample = dateColumn == null ? "" : grid.rows.slice(0, 20).map((row) => row[dateColumn]).find(Boolean) ?? "";
  const dateOrder: StatementMapping["dateOrder"] = /^\s*\d{4}[.\-/]/.test(dateSample) ? "YMD"
    : /^\s*\d{1,2}[.\-/](\d{1,2})/.test(dateSample)
      && Number(dateSample.match(/^\s*\d{1,2}[.\-/](\d{1,2})/)?.[1]) > 12 ? "MDY" : "DMY";
  const sampleAmounts = amountColumn == null ? [] : grid.rows.slice(0, 30)
    .map((row) => parseMoney(row[amountColumn])).filter((value): value is number => value !== null);
  const positiveAmountType = sampleAmounts.some((value) => value < 0) ? "income" : "expense";
  const currencyText = grid.rawRows.slice(0, 30).flat().join(" ");
  const defaultCurrency = detectCurrency(currencyText) ?? "KZT";
  return {
    dateColumn, amountColumn, debitColumn, creditColumn, descriptionColumn, currencyColumn,
    categoryColumn, referenceColumn, directionColumn, defaultCurrency, dateOrder, positiveAmountType,
  };
}

function parseMoney(value: string): number | null {
  let cleaned = value.trim()
    .replace(/(?:KZT|RUB|USD|EUR|тг|тенге|руб(?:ль|ля|лей)?|доллар(?:а|ов)?|евро)/gi, "")
    .replace(/[₸₽$€]/g, "").trim();
  if (!cleaned) return null;
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (/^[-−–]/.test(cleaned)) {
    if (negative) return null;
    negative = true;
    cleaned = cleaned.slice(1).trim();
  } else if (/[-−–]$/.test(cleaned)) {
    if (negative) return null;
    negative = true;
    cleaned = cleaned.slice(0, -1).trim();
  } else if (/^\+/.test(cleaned)) {
    cleaned = cleaned.slice(1).trim();
  }
  if (/[()+−–-]/.test(cleaned)) return null;
  const digits = cleaned.replace(/[\s\u00a0\u202f'’]/g, "");
  if (!/^\d[\d.,]*$/.test(digits)) return null;
  const comma = digits.lastIndexOf(",");
  const dot = digits.lastIndexOf(".");
  const last = Math.max(comma, dot);
  let normalized: string;
  if (last < 0) normalized = digits;
  else {
    const decimals = digits.length - last - 1;
    const separator = digits[last];
    const same = digits.split(separator).length - 1;
    const integerPart = digits.slice(0, last);
    const isThousands = decimals === 3 && (same > 1
      || (same === 1 && integerPart.length <= 3 && !/^0/.test(integerPart)));
    if (isThousands) normalized = digits.replace(/[.,]/g, "");
    else if (decimals <= 2 && decimals >= 1) {
      normalized = digits.slice(0, last).replace(/[.,]/g, "") + "." + digits.slice(last + 1);
    } else return null;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount > 1_000_000_000_000) return null;
  const rounded = Math.round(amount * 100) / 100;
  if (Math.abs(rounded - amount) > 0.000001) return null;
  return (negative ? -1 : 1) * rounded;
}

function detectCurrency(value: string): string | null {
  const text = normalize(value);
  if (/kzt|тенге|(?:^|\s)тг(?:\s|$)|₸/.test(text)) return "KZT";
  if (/rub|руб(?:ль|ля|лей)?|₽/.test(text)) return "RUB";
  if (/usd|доллар(?:а|ов)?|\$/.test(text)) return "USD";
  if (/eur|евро|€/.test(text)) return "EUR";
  return null;
}

function localIso(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  // The app's calendar and analytics use Asia/Qyzylorda (UTC+05:00).
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute, second)).toISOString();
}

function parseDate(value: string, order: StatementMapping["dateOrder"]): string | null {
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100
      ? date.toISOString() : null;
  }
  if (/^\d{5}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial < 36526 || serial > 73415) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return localIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
  }
  const match = text.match(/^(\d{1,4})[.\-/](\d{1,2})[.\-/](\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const yearFirst = match[1].length === 4 || order === "YMD";
  const year = yearFirst ? first : match[3].length === 2 ? 2000 + third : third;
  const month = yearFirst ? second : order === "MDY" ? first : second;
  const day = yearFirst ? third : order === "MDY" ? second : first;
  return localIso(year, month, day, Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0));
}

function parseDirection(value: string): ImportEntry["type"] | null {
  const text = normalize(value);
  if (/расход|списан|платеж|оплат|покупк|дебет|debit|withdrawal|expense|(?:^|\s)out(?:\s|$)/.test(text)) return "expense";
  if (/приход|доход|поступлен|зачислен|пополнен|кредит|credit|deposit|income|(?:^|\s)in(?:\s|$)/.test(text)) return "income";
  return null;
}

function fnv32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function sourceKey(value: string): string {
  return `b1_${fnv32(value, 0x811c9dc5)}${fnv32(value, 0x79d8af27)}`;
}

export function mapStatementRows(grid: StatementGrid, mapping: StatementMapping): StatementMappingResult {
  const errors: StatementRowError[] = [];
  const entries: ImportEntry[] = [];
  const warnings: string[] = [];
  if (mapping.dateColumn === null || (mapping.amountColumn === null
    && mapping.debitColumn === null && mapping.creditColumn === null)) {
    return { entries, warnings, errors: [{ rowNumber: grid.headerRowIndex + 1, message: "Выберите колонку даты и суммы либо прихода/расхода." }] };
  }
  if (mapping.descriptionColumn === null && mapping.referenceColumn === null) {
    warnings.push("Без описания или номера операции повторы сложнее определить. Проверьте предпросмотр.");
  }
  const usedColumns = [mapping.dateColumn, mapping.amountColumn, mapping.debitColumn, mapping.creditColumn,
    mapping.descriptionColumn, mapping.currencyColumn, mapping.categoryColumn, mapping.referenceColumn,
    mapping.directionColumn].filter((value): value is number => value !== null);
  if (usedColumns.some((value) => !Number.isInteger(value) || value < 0 || value >= grid.headers.length)) {
    return { entries, warnings, errors: [{ rowNumber: grid.headerRowIndex + 1, message: "Одна из выбранных колонок отсутствует в файле." }] };
  }
  if (mapping.debitColumn !== null && mapping.creditColumn !== null && mapping.debitColumn === mapping.creditColumn) {
    return { entries, warnings, errors: [{ rowNumber: grid.headerRowIndex + 1, message: "Приход и расход должны быть разными колонками." }] };
  }
  const get = (row: string[], column: number | null) => column === null ? "" : row[column] ?? "";
  const occurrences = new Map<string, number>();
  for (let index = 0; index < grid.rows.length; index++) {
    const row = grid.rows[index];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = grid.headerRowIndex + 2 + index;
    const happenedAt = parseDate(get(row, mapping.dateColumn), mapping.dateOrder);
    const debit = parseMoney(get(row, mapping.debitColumn));
    const credit = parseMoney(get(row, mapping.creditColumn));
    const signed = parseMoney(get(row, mapping.amountColumn));
    const hasDebitCredit = mapping.debitColumn !== null || mapping.creditColumn !== null;
    let amount: number | null;
    let type: ImportEntry["type"];
    if (hasDebitCredit) {
      if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
        errors.push({ rowNumber, message: "В строке одновременно указаны приход и расход." });
        continue;
      }
      if (debit !== null && debit !== 0) { amount = Math.abs(debit); type = "expense"; }
      else if (credit !== null && credit !== 0) { amount = Math.abs(credit); type = "income"; }
      else { amount = null; type = "expense"; }
    } else {
      amount = signed === null ? null : Math.abs(signed);
      const positiveType = mapping.positiveAmountType;
      type = signed !== null && signed < 0
        ? positiveType === "income" ? "expense" : "income" : positiveType;
      if (mapping.directionColumn !== null) {
        const direction = parseDirection(get(row, mapping.directionColumn));
        if (!direction) {
          errors.push({ rowNumber, message: "Не удалось определить приход или расход по колонке типа." });
          continue;
        }
        type = direction;
      }
    }
    // Typical statement footer; it is not a transaction and must not be imported.
    if (!happenedAt && amount === null && /^\s*(итого|total|баланс|остаток)(?:\s|$)/i.test(row.join(" "))) continue;
    if (!happenedAt) { errors.push({ rowNumber, message: "Не удалось прочитать дату." }); continue; }
    if (amount === null || amount === 0) { errors.push({ rowNumber, message: "Не удалось прочитать сумму операции." }); continue; }
    const rawCurrency = get(row, mapping.currencyColumn);
    const currency = rawCurrency ? detectCurrency(rawCurrency) : detectCurrency(get(row, mapping.amountColumn))
      ?? detectCurrency(get(row, mapping.debitColumn)) ?? detectCurrency(get(row, mapping.creditColumn))
      ?? detectCurrency(mapping.defaultCurrency);
    if (!currency) { errors.push({ rowNumber, message: "Валюта не поддерживается. Доступны KZT, RUB, USD и EUR." }); continue; }
    const rawDescription = get(row, mapping.descriptionColumn).replace(/\s+/g, " ").trim();
    const note = rawDescription.slice(0, 160);
    const category = get(row, mapping.categoryColumn).replace(/\s+/g, " ").trim().slice(0, 40)
      || (type === "income" ? "Доход" : "Другое");
    const reference = normalize(get(row, mapping.referenceColumn));
    const identity = reference
      ? ["ref", reference, happenedAt, type, amount.toFixed(2), currency].join("|")
      : ["row", happenedAt, type, amount.toFixed(2), currency,
        mapping.descriptionColumn === null ? row.map(normalize).join("\u001f") : normalize(rawDescription)].join("|");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    entries.push({ type, amount, currency, category, note, happenedAt,
      sourceKey: sourceKey(`${identity}|${occurrence}`) });
    if (entries.length > MAX_IMPORT_ENTRIES) {
      return { entries: [], warnings, errors: [{ rowNumber: 0, message: `За раз можно импортировать не больше ${MAX_IMPORT_ENTRIES} операций. Выгрузите меньший период.` }] };
    }
  }
  return { entries, errors, warnings };
}
