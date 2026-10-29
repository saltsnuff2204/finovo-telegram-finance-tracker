import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { mapStatementRows, parseStatementFile, setStatementHeaderRow, suggestMapping } from "../lib/bank-import.ts";

function file(text, name = "statement.csv") {
  return new File([text], name);
}

function windows1251(text) {
  return Uint8Array.from([...text].map((character) => {
    const code = character.charCodeAt(0);
    if (code < 128) return code;
    if (code >= 0x0410 && code <= 0x042f) return code - 0x0410 + 0xc0;
    if (code >= 0x0430 && code <= 0x044f) return code - 0x0430 + 0xe0;
    if (code === 0x0401) return 0xa8;
    if (code === 0x0451) return 0xb8;
    throw new Error(`No test encoding for ${character}`);
  }));
}

test("Russian CSV detects header, semicolon quoting, signs after currency and local time", async () => {
  const source = [
    "Выписка по счету",
    "Дата операции;Сумма;Описание;Валюта",
    '08.10.2026 09:30;"KZT -1 200,50";"Кофе; обед";KZT',
    "09.10.2026;5 000,00;Зарплата;KZT",
  ].join("\r\n");
  const grid = await parseStatementFile(file(source));
  assert.equal(grid.headerRowIndex, 1);
  const mapping = suggestMapping(grid);
  assert.equal(mapping.dateColumn, 0);
  assert.equal(mapping.amountColumn, 1);
  assert.equal(mapping.descriptionColumn, 2);
  assert.equal(mapping.currencyColumn, 3);
  assert.equal(mapping.positiveAmountType, "income");
  const result = mapStatementRows(grid, mapping);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    type: "expense", amount: 1200.5, currency: "KZT", category: "Другое",
    note: "Кофе; обед", happenedAt: "2026-10-08T04:30:00.000Z",
    sourceKey: result.entries[0].sourceKey,
  });
  assert.equal(result.entries[1].type, "income");
  assert.equal(result.entries[1].category, "Доход");
});

test("Windows-1251 CSV with separate debit and credit columns", async () => {
  const source = [
    "Дата;Расход;Приход;Описание",
    "08.10.2026;1 000,00;;Оплата товаров",
    "09.10.2026;;25 000,00;Зарплата",
  ].join("\n");
  const grid = await parseStatementFile(new File([windows1251(source)], "bank.csv"));
  const mapping = suggestMapping(grid);
  assert.equal(mapping.debitColumn, 1);
  assert.equal(mapping.creditColumn, 2);
  const result = mapStatementRows(grid, mapping);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map((entry) => [entry.type, entry.amount]), [
    ["expense", 1000], ["income", 25000],
  ]);
});

test("headerless CSV keeps its first transaction and supports manual mapping", async () => {
  const grid = await parseStatementFile(file("08.10.2026;Кафе;-1500\n09.10.2026;Зарплата;25000"));
  assert.equal(grid.headerRowIndex, -1);
  assert.equal(grid.rows.length, 2);
  assert.equal(setStatementHeaderRow(grid, 0).rows.length, 1);
  assert.equal(setStatementHeaderRow(grid, -1).rows.length, 2);
  const mapped = mapStatementRows(grid, {
    ...suggestMapping(grid), dateColumn: 0, descriptionColumn: 1, amountColumn: 2,
    positiveAmountType: "income", defaultCurrency: "KZT",
  });
  assert.deepEqual(mapped.errors, []);
  assert.equal(mapped.entries[0].type, "expense");
  assert.equal(mapped.entries[1].type, "income");
});

test("duplicate identical rows get distinct stable source keys", async () => {
  const row = "08.10.2026;-1500;Кофе";
  const grid = await parseStatementFile(file(`Дата;Сумма;Описание\n${row}\n${row}`));
  const mapping = suggestMapping(grid);
  const result = mapStatementRows(grid, mapping);
  assert.deepEqual(result.errors, []);
  assert.notEqual(result.entries[0].sourceKey, result.entries[1].sourceKey);
  const overlap = await parseStatementFile(file(`Дата;Сумма;Описание\n${row}`, "overlap.csv"));
  const second = mapStatementRows(overlap, suggestMapping(overlap));
  assert.equal(second.entries[0].sourceKey, result.entries[0].sourceKey);
  const editedCategory = mapStatementRows(grid, { ...mapping, categoryColumn: null });
  assert.equal(editedCategory.entries[0].sourceKey, result.entries[0].sourceKey);
});

test("rejects an internal minus in an amount and unknown direction", async () => {
  const grid = await parseStatementFile(file([
    "Дата;Сумма;Описание;Тип операции",
    "08.10.2026;1-2;Кофе;Оплата товаров",
    "09.10.2026;$-20;Такси;Оплата",
    "10.10.2026;30;Что-то;Непонятно",
    "11.10.2026;0,123;Проверка дроби;Оплата",
  ].join("\n")));
  const result = mapStatementRows(grid, suggestMapping(grid));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].amount, 20);
  assert.equal(result.entries[0].type, "expense");
  assert.equal(result.errors.length, 3);
});

test("XLSX reads the transaction sheet instead of a cover sheet", async () => {
  const xml = (value) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${value}`);
  const relsNs = "http://schemas.openxmlformats.org/package/2006/relationships";
  const mainNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const documentRels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
  const workbook = `<workbook xmlns="${mainNs}" xmlns:r="${documentRels}"><sheets><sheet name="Титул" sheetId="1" r:id="rId1"/><sheet name="Операции" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const cell = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const sheet1 = `<worksheet xmlns="${mainNs}"><sheetData><row r="1">${cell("A1", "Выписка")}</row></sheetData></worksheet>`;
  const sheet2 = `<worksheet xmlns="${mainNs}"><sheetData>`
    + `<row r="1">${cell("A1", "Дата операции")}${cell("B1", "Сумма")}${cell("C1", "Описание")}</row>`
    + `<row r="2">${cell("A2", "08.10.2026")}<c r="B2"><v>-1250</v></c>${cell("C2", "Кофе")}</row>`
    + `</sheetData></worksheet>`;
  const archive = zipSync({
    "[Content_Types].xml": xml(`<Types xmlns="${contentTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": xml(`<Relationships xmlns="${relsNs}"><Relationship Id="rId1" Type="${documentRels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(workbook),
    "xl/_rels/workbook.xml.rels": xml(`<Relationships xmlns="${relsNs}"><Relationship Id="rId1" Type="${documentRels}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${documentRels}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": xml(sheet1),
    "xl/worksheets/sheet2.xml": xml(sheet2),
  });
  const grid = await parseStatementFile(new File([archive], "statement.xlsx"));
  assert.equal(grid.sheetName, "Операции");
  assert.equal(grid.rows.length, 1);
  const result = mapStatementRows(grid, suggestMapping(grid));
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries[0].amount, 1250);
});
