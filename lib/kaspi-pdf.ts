/**
 * Strict, browser-side reader for the text-based Kaspi Gold statement layout.
 * Unknown layouts fail closed: silently losing a transaction is worse than
 * asking the user to use another export format.
 */

export type PdfTextItem = { text: string; x: number; y: number };
export type PdfImage = { x: number; y: number; width: number; height: number };
export type PdfPageData = {
  width: number;
  height: number;
  items: PdfTextItem[];
  images: PdfImage[];
};

export type KaspiPdfResult = {
  rawRows: string[][];
  /** Zero-based indices in the operation rows, excluding rawRows' header. */
  pendingRowIndices: number[];
  warnings: string[];
};

const HEADER = ["Дата операции", "Сумма", "Операция", "Описание"];
const DATE = /^\d{2}\.\d{2}\.\d{2}$/;
const MONEY = /^([+-])\s*(\d+(?:[\s\u00a0\u202f]\d{3})*),([0-9]{2})\s*₸$/;
const PDF_ERROR = "Не удалось безопасно разобрать эту PDF-выписку Kaspi Gold. Попробуйте выгрузить её заново или использовать CSV/Excel.";

function normalized(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function moneyCents(value: string): number | null {
  const match = normalized(value).match(MONEY);
  if (!match) return null;
  const whole = match[2].replace(/\s/g, "");
  const cents = Number(whole) * 100 + Number(match[3]);
  return Number.isSafeInteger(cents) ? (match[1] === "-" ? -cents : cents) : null;
}

function sameLine(items: PdfTextItem[], y: number): PdfTextItem[] {
  return items.filter((item) => item.text.trim() && Math.abs(item.y - y) < 1.8).sort((a, b) => a.x - b.x);
}

function cell(line: PdfTextItem[], minX: number, maxX: number): string {
  return normalized(line.filter((item) => item.x >= minX && item.x < maxX).map((item) => item.text).join(" "));
}

function summaryAmount(page: PdfPageData, label: string): number | null {
  const heading = page.items.find((item) => normalized(item.text) === label && item.x >= 35 && item.x < 180);
  if (!heading) return null;
  const amount = cell(sameLine(page.items, heading.y), 200, 310);
  return moneyCents(amount);
}

function isPendingImage(image: PdfImage, rowY: number): boolean {
  return image.x >= 295 && image.x <= 302
    && image.width >= 8 && image.width <= 12
    && image.height >= 8 && image.height <= 12
    && Math.abs(image.y - rowY) < 2.5;
}

export function parseKaspiGoldPdfPages(pages: PdfPageData[]): KaspiPdfResult {
  if (!pages.length || pages.length > 30 || pages.some((page) =>
    Math.abs(page.width - 595.28) > 3 || Math.abs(page.height - 841.89) > 3)) {
    throw new Error(PDF_ERROR);
  }
  if (pages.every((page) => page.items.every((item) => !item.text.trim()))) {
    throw new Error("В PDF нет текстового слоя. Для скана пока нужен другой формат выписки — CSV или Excel.");
  }
  const statementIndex = pages.findIndex((page) => {
    const text = page.items.map((item) => item.text).join(" ");
    return page.items.some((item) => normalized(item.text).toUpperCase() === "ВЫПИСКА")
      && /Kaspi\s+Gold/i.test(text);
  });
  if (statementIndex < 0) throw new Error("Поддерживается текстовая PDF-выписка Kaspi Gold. Для другого банка пока используйте CSV или Excel.");
  const statement = pages[statementIndex];
  const headers = [
    ["Дата", 40, 100], ["Сумма", 100, 199], ["Операция", 199, 298], ["Детали", 298, 580],
  ] as const;
  const headerItems = headers.map(([label, minX, maxX]) => statement.items.find((item) =>
    normalized(item.text) === label && item.x >= minX && item.x < maxX));
  if (headerItems.some((item) => !item)
    || headerItems.some((item) => Math.abs((item?.y ?? 0) - (headerItems[0]?.y ?? 0)) > 2)) {
    throw new Error(PDF_ERROR);
  }
  const headerY = headerItems[0]!.y;
  const rawRows = [HEADER];
  const pendingRowIndices: number[] = [];
  const totals = new Map<string, number>();
  let operationCount = 0;

  for (let pageIndex = statementIndex; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const dates = page.items.filter((item) => DATE.test(normalized(item.text))
      && item.x >= 40 && item.x < 100 && (pageIndex !== statementIndex || item.y < headerY - 5))
      .sort((a, b) => b.y - a.y);
    const uniqueDates: PdfTextItem[] = [];
    for (const date of dates) {
      if (uniqueDates.some((seen) => Math.abs(seen.y - date.y) < 1.8)) throw new Error(PDF_ERROR);
      uniqueDates.push(date);
    }
    for (const date of uniqueDates) {
      const line = sameLine(page.items, date.y);
      const dateText = cell(line, 40, 100);
      const amount = cell(line, 100, 199);
      const operation = cell(line, 199, 298);
      const details = cell(line, 298, 580);
      const cents = moneyCents(amount);
      if (!DATE.test(dateText) || cents === null || cents === 0 || !/^(Пополнение|Покупка|Перевод|Разное|Снятие)$/.test(operation)
        || !details) throw new Error(PDF_ERROR);
      rawRows.push([dateText, amount, operation, `${operation} · ${details}`]);
      operationCount++;
      totals.set(operation, (totals.get(operation) ?? 0) + cents);
      if (page.images.some((image) => isPendingImage(image, date.y))) pendingRowIndices.push(operationCount - 1);
      if (operationCount > 500) throw new Error("В PDF больше 500 операций. Выгрузите меньший период.");
    }
    // A signed amount in the transaction column without a matching date is
    // likely a damaged or changed table row; the summary is above its header.
    const unexplainedAmounts = page.items.filter((item) => item.x >= 100 && item.x < 199
      && moneyCents(item.text) !== null
      && (pageIndex !== statementIndex || item.y < headerY - 5)
      && !uniqueDates.some((date) => Math.abs(date.y - item.y) < 1.8));
    if (unexplainedAmounts.length) throw new Error(PDF_ERROR);
  }
  if (operationCount === 0) throw new Error("В PDF не нашлось операций Kaspi Gold. Возможно, это справка без выписки.");

  // This Kaspi layout prints a short operations summary. Reconciliation
  // catches lost lines and sign/column mistakes before anything reaches UI.
  const summary: Array<[string, string]> = [
    ["Пополнения", "Пополнение"], ["Переводы", "Перевод"],
    ["Покупки", "Покупка"], ["Разное", "Разное"],
  ];
  for (const [label, operation] of summary) {
    const expected = summaryAmount(statement, label);
    if (expected === null || expected !== (totals.get(operation) ?? 0)) throw new Error(PDF_ERROR);
  }
  const balances = statement.items.filter((item) => /^Доступно на \d{2}\.\d{2}\.\d{2}$/.test(normalized(item.text))
    && item.x >= 35 && item.x < 180).sort((a, b) => b.y - a.y);
  if (balances.length !== 2) throw new Error(PDF_ERROR);
  const opening = moneyCents(cell(sameLine(statement.items, balances[0].y), 200, 310));
  const closing = moneyCents(cell(sameLine(statement.items, balances[1].y), 200, 310));
  const net = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  if (opening === null || closing === null || opening + net !== closing) throw new Error(PDF_ERROR);

  const warnings = ["В PDF нет времени операций: будет сохранена дата без точного времени."];
  warnings.push("Проверьте пополнения и переводы между своими счетами: банк не указывает, какие из них являются вашим доходом или расходом.");
  if (pendingRowIndices.length) warnings.push(`${pendingRowIndices.length} операций ещё ожидают подтверждения банком и выключены по умолчанию.`);
  return { rawRows, pendingRowIndices, warnings };
}

type Matrix = [number, number, number, number, number, number];
function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

export async function parseKaspiGoldPdfFile(file: File): Promise<KaspiPdfResult> {
  // Lazy loading keeps the normal Mini App bundle small. The version-matched
  // worker is served verbatim from public/; Vite's dev transform must not
  // inject its browser HMR client into a Web Worker.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | undefined;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const document = await loadingTask.promise;
    if (document.numPages > 30) throw new Error("В PDF слишком много страниц. Выгрузите меньший период.");
    const pages: PdfPageData[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      if (page.rotate !== 0) throw new Error(PDF_ERROR);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items.flatMap((item) =>
        "str" in item ? [{ text: item.str, x: item.transform[4], y: item.transform[5] }] : []);
      const ops = await page.getOperatorList();
      const images: PdfImage[] = [];
      const stack: Matrix[] = [];
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      for (let opIndex = 0; opIndex < ops.fnArray.length; opIndex++) {
        const fn = ops.fnArray[opIndex];
        if (fn === pdfjs.OPS.save) stack.push([...ctm]);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (fn === pdfjs.OPS.transform) {
          const args = ops.argsArray[opIndex];
          if (Array.isArray(args) && args.length === 6 && args.every((value) => typeof value === "number")) {
            ctm = multiply(ctm, args as Matrix);
          }
        } else if (fn === pdfjs.OPS.paintImageXObject) {
          images.push({ x: ctm[4], y: ctm[5], width: Math.hypot(ctm[0], ctm[1]), height: Math.hypot(ctm[2], ctm[3]) });
        }
      }
      pages.push({ width: viewport.width, height: viewport.height, items, images });
      page.cleanup();
    }
    return parseKaspiGoldPdfPages(pages);
  } catch (error) {
    if (error instanceof Error && /PasswordException/i.test(error.name)) throw new Error("PDF защищён паролем. Выгрузите выписку без пароля.");
    if (error instanceof Error && (/PDF|Kaspi|операц|скан|CSV|Excel|парол/.test(error.message))) throw error;
    throw new Error("Не удалось открыть PDF. Проверьте, что это обычная выписка Kaspi Gold без пароля.");
  } finally {
    await loadingTask?.destroy();
  }
}
