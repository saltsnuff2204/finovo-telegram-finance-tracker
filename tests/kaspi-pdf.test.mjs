import assert from "node:assert/strict";
import test from "node:test";
import { parseKaspiGoldPdfPages } from "../lib/kaspi-pdf.ts";
import { mapStatementRows, setStatementHeaderRow, suggestMapping } from "../lib/bank-import.ts";

// These are invented values and labels. No bank statement or extracted private
// transaction text is checked into the test suite.
function syntheticPage({ title = "Kaspi Gold", closing = "+ 102 000,00 ₸", images = [] } = {}) {
  const items = [
    { text: "ВЫПИСКА", x: 43, y: 785 },
    { text: title, x: 43, y: 765 },
    { text: "Доступно на 01.10.26", x: 43, y: 516 },
    { text: "+ 100 000,00 ₸", x: 240, y: 516 },
    { text: "Пополнения", x: 43, y: 501 },
    { text: "+ 5 000,00 ₸", x: 240, y: 501 },
    { text: "Переводы", x: 43, y: 453 },
    { text: "- 2 000,00 ₸", x: 240, y: 453 },
    { text: "Покупки", x: 43, y: 421 },
    { text: "- 1 000,00 ₸", x: 240, y: 421 },
    { text: "Разное", x: 43, y: 389 },
    { text: "+ 0,00 ₸", x: 240, y: 389 },
    { text: "Доступно на 12.10.26", x: 43, y: 373 },
    { text: closing, x: 240, y: 373 },
    { text: "Дата", x: 59, y: 334 },
    { text: "Сумма", x: 134, y: 334 },
    { text: "Операция", x: 243, y: 334 },
    { text: "Детали", x: 400, y: 334 },
    { text: "01.10.26", x: 52, y: 318 },
    { text: "+ 5 000,00 ₸", x: 145, y: 318 },
    { text: "Пополнение", x: 257, y: 318 },
    { text: "Тестовое пополнение", x: 311, y: 318 },
    { text: "02.10.26", x: 52, y: 302 },
    { text: "- 2 000,00 ₸", x: 145, y: 302 },
    { text: "Перевод", x: 257, y: 302 },
    { text: "Тестовый перевод", x: 311, y: 302 },
    { text: "03.10.26", x: 52, y: 286 },
    { text: "- 1 000,00 ₸", x: 145, y: 286 },
    { text: "Покупка", x: 257, y: 286 },
    { text: "Тестовый магазин", x: 311, y: 286 },
  ];
  return { width: 595.28, height: 841.89, items, images };
}

test("Kaspi Gold PDF rows use the same checked import mapping as CSV/XLSX", () => {
  const parsed = parseKaspiGoldPdfPages([syntheticPage()]);
  assert.deepEqual(parsed.rawRows[0], ["Дата операции", "Сумма", "Операция", "Описание"]);
  assert.equal(parsed.rawRows.length, 4);
  assert.deepEqual(parsed.pendingRowIndices, []);

  const grid = setStatementHeaderRow({
    filename: "synthetic.pdf", rawRows: parsed.rawRows, headers: [], rows: [],
    headerRowIndex: -1, warnings: parsed.warnings,
  }, 0);
  const result = mapStatementRows(grid, suggestMapping(grid));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map(({ type, amount, currency }) => [type, amount, currency]), [
    ["income", 5000, "KZT"],
    ["expense", 2000, "KZT"],
    ["expense", 1000, "KZT"],
  ]);
});

test("Kaspi Gold PDF parser refuses a scan with no transaction text", () => {
  assert.throws(() => parseKaspiGoldPdfPages([{
    width: 595.28, height: 841.89, items: [],
    images: [{ x: 0, y: 0, width: 595.28, height: 841.89 }],
  }]), Error);
});

test("Kaspi Gold PDF parser flags a pending transaction by its row badge", () => {
  const parsed = parseKaspiGoldPdfPages([syntheticPage({
    images: [{ x: 298, y: 302, width: 10, height: 10 }],
  })]);
  assert.deepEqual(parsed.pendingRowIndices, [1]);
});

test("Kaspi Gold PDF parser refuses a different bank's page", () => {
  assert.throws(() => parseKaspiGoldPdfPages([syntheticPage({ title: "Другой банк" })]), Error);
});

test("Kaspi Gold PDF parser refuses unreconciled summary totals", () => {
  assert.throws(() => parseKaspiGoldPdfPages([syntheticPage({ closing: "+ 999 999,00 ₸" })]), Error);
});

test("Kaspi Gold PDF parser refuses a missing operation table", () => {
  const page = syntheticPage();
  page.items = page.items.filter(({ y }) => y > 340);
  assert.throws(() => parseKaspiGoldPdfPages([page]), Error);
});

test("Kaspi Gold PDF parser refuses an amount with no matching transaction date", () => {
  const page = syntheticPage();
  page.items.push({ text: "- 100,00 ₸", x: 145, y: 270 });
  assert.throws(() => parseKaspiGoldPdfPages([page]), Error);
});

test("Kaspi Gold PDF parser refuses an unknown operation type", () => {
  const page = syntheticPage();
  page.items.find((item) => item.text === "Покупка").text = "Неизвестно";
  assert.throws(() => parseKaspiGoldPdfPages([page]), Error);
});
