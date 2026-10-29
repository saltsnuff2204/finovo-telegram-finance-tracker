"use client";

import { useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Check, ChevronDown, FileSpreadsheet, Info, RotateCcw, ShieldCheck, Upload, X } from "lucide-react";
import {
  mapStatementRows,
  MAX_IMPORT_ENTRIES,
  MAX_STATEMENT_BYTES,
  parseStatementFile,
  setStatementHeaderRow,
  suggestMapping,
  type ImportEntry,
  type StatementGrid,
  type StatementMapping,
} from "@/lib/bank-import";

type CategoryPreset = { id: number; name: string; type: "income" | "expense" };
type ImportResponse = {
  rows: { sourceKey: string; duplicate: boolean; possibleCreditDuplicate: boolean; possibleExistingDuplicate: boolean }[];
  imported: number;
  duplicates: number;
};
type ColumnKey = "dateColumn" | "amountColumn" | "debitColumn" | "creditColumn" | "descriptionColumn" | "directionColumn" | "currencyColumn" | "categoryColumn" | "referenceColumn";

const currencies = ["KZT", "RUB", "USD", "EUR"];
const fieldClass = "w-full rounded-xl border border-white/10 bg-[#25252b] px-3 py-2.5 text-xs text-zinc-100 outline-none focus:border-violet-400/70";
const ownTransferPattern = /(?:между\s+(?:(?:своими|собственными)\s+)?(?:счетами|счётами|картами)|(?:со\s+своего|на\s+сво(?:й|ю))\s+(?:счет|счёт|карту)|own\s+(?:account|card)|self[ -]?transfer|internal\s+transfer)/i;

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }).format(amount);
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Qyzylorda", day: "2-digit", month: "short", year: "numeric" }).format(date);
}
function scopedSourceKey(accountLabel: string, entryKey: string) {
  const normalized = accountLabel.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim();
  const hash = (seed: number) => {
    let value = seed >>> 0;
    for (let index = 0; index < normalized.length; index++) {
      value ^= normalized.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, "0");
  };
  return `a1_${hash(0x811c9dc5)}${hash(0x79d8af27)}_${entryKey}`;
}
async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch { /* An empty or non-JSON response. */ }
  return `Ошибка ${response.status}. Попробуйте ещё раз.`;
}

export function StatementImportModal({ presets, authHeaders, onClose, onImported }: {
  presets: CategoryPreset[];
  authHeaders(): Record<string, string>;
  onClose(): void;
  onImported(): void;
}) {
  const [grid, setGrid] = useState<StatementGrid | null>(null);
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [amountMode, setAmountMode] = useState<"signed" | "split">("signed");
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [typeOverrides, setTypeOverrides] = useState<Record<number, ImportEntry["type"]>>({});
  const [categoryChoices, setCategoryChoices] = useState<Record<number, string>>({});
  const [customCategories, setCustomCategories] = useState<Record<number, string>>({});
  const [step, setStep] = useState<"file" | "review" | "done">("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(0);
  const [previewOutdated, setPreviewOutdated] = useState(false);
  const requestRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mapped = useMemo(() => grid && mapping ? mapStatementRows(grid, mapping) : { entries: [] as ImportEntry[], errors: [] as { rowNumber: number; message: string }[], warnings: [] as string[] }, [grid, mapping]);
  const entries = mapped.entries;
  const isPdf = /\.pdf$/i.test(grid?.filename ?? "");
  const pdfRowsMisaligned = Boolean(isPdf && grid && mapping && entries.length !== grid.rows.length);
  const pdfMappingBlocked = isPdf && (mapped.errors.length > 0 || pdfRowsMisaligned);
  const pendingRowIndices = new Set(isPdf && !pdfRowsMisaligned ? grid?.pendingRowIndices ?? [] : []);
  const scopedEntries = useMemo(() => entries.map((entry, index) => ({ ...entry, type: typeOverrides[index] ?? entry.type, sourceKey: scopedSourceKey(sourceLabel, entry.sourceKey) })), [entries, sourceLabel, typeOverrides]);
  const splitAmounts = amountMode === "split";

  function resetReview() {
    requestRef.current += 1;
    setPreview(null);
    setPreviewOutdated(false);
    setExcluded(new Set());
    setTypeOverrides({});
    setCategoryChoices({});
    setCustomCategories({});
    setStep("file");
    setError("");
  }
  function updateMapping(change: Partial<StatementMapping>) {
    if (!mapping || isPdf) return;
    setMapping({ ...mapping, ...change });
    resetReview();
  }
  function updateColumn(key: ColumnKey, value: string) {
    updateMapping({ [key]: value === "" ? null : Number(value) } as Partial<StatementMapping>);
  }
  async function loadFile(file?: File) {
    if (!file) return;
    resetReview();
    setGrid(null);
    setMapping(null);
    if (file.size > MAX_STATEMENT_BYTES) { setError(`Файл больше ${MAX_STATEMENT_BYTES / 1024 / 1024} МБ. Выгрузите выписку за меньший период.`); return; }
    setBusy(true);
    try {
      const nextGrid = await parseStatementFile(file);
      setGrid(nextGrid);
      const suggested = suggestMapping(nextGrid);
      const nextMapping: StatementMapping = /\.pdf$/i.test(file.name) ? {
        ...suggested,
        dateColumn: 0,
        amountColumn: 1,
        debitColumn: null,
        creditColumn: null,
        descriptionColumn: 3,
        directionColumn: null,
        currencyColumn: null,
        categoryColumn: null,
        referenceColumn: null,
        defaultCurrency: "KZT",
        dateOrder: "DMY",
        positiveAmountType: "income",
      } : suggested;
      setMapping(nextMapping);
      setAmountMode(nextMapping.debitColumn != null || nextMapping.creditColumn != null ? "split" : "signed");
      if (!nextGrid.rows.length) setError("В файле не нашлось строк с операциями. Проверьте строку заголовков ниже.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось прочитать файл.");
    } finally { setBusy(false); }
  }
  async function review(keepSelection = false) {
    setError("");
    if (!grid || !mapping) return;
    if (!sourceLabel.trim()) { setError("Назовите счёт или банк, из которого выгружена выписка."); return; }
    if (mapping.dateColumn == null || (splitAmounts ? mapping.debitColumn == null && mapping.creditColumn == null : mapping.amountColumn == null)) {
      setError("Укажите колонку даты и колонку суммы либо списания/пополнения."); return;
    }
    if (pdfMappingBlocked) { setError("PDF разобран не полностью. Исправьте колонки или выберите другую выписку: операции с ошибками нельзя пропускать незаметно."); return; }
    if (entries.length === 0) { setError("Не нашлось корректных операций. Проверьте колонки и формат даты."); return; }
    if (entries.length > MAX_IMPORT_ENTRIES) { setError(`В выписке больше ${MAX_IMPORT_ENTRIES} операций. Выгрузите более короткий период.`); return; }
    const requestId = ++requestRef.current;
    setBusy(true);
    try {
      const response = await fetch("/api/import", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "preview", transactions: scopedEntries }) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as ImportResponse;
      if (requestId !== requestRef.current) return;
      if (result.rows.length !== entries.length) throw new Error("Ответ проверки не совпал с файлом. Попробуйте ещё раз.");
      setPreview(result);
      const suggestedExclusions = result.rows.flatMap((row, index) => row.duplicate || row.possibleCreditDuplicate || row.possibleExistingDuplicate || pendingRowIndices.has(index) || ownTransferPattern.test(entries[index].note) ? [index] : []);
      setExcluded((previous) => new Set(keepSelection ? [...previous, ...suggestedExclusions] : suggestedExclusions));
      setPreviewOutdated(false);
      setStep("review");
    } catch (cause) { if (requestId === requestRef.current) setError(cause instanceof Error ? cause.message : "Не удалось проверить операции."); }
    finally { if (requestId === requestRef.current) setBusy(false); }
  }
  function chosenCategory(index: number, entry: ImportEntry) {
    const choice = categoryChoices[index];
    return choice === "__custom__" ? (customCategories[index] ?? "").trim() : choice ?? entry.category;
  }
  const selectedCount = preview ? entries.filter((entry, index) => !excluded.has(index) && !preview.rows[index]?.duplicate && Boolean(chosenCategory(index, entry))).length : 0;
  const selectedWithoutCategory = preview ? entries.some((entry, index) => !excluded.has(index) && !preview.rows[index]?.duplicate && !chosenCategory(index, entry)) : false;
  async function commit() {
    if (!preview || busy || previewOutdated) return;
    if (pdfMappingBlocked) { setError("PDF разобран не полностью. Вернитесь к файлу и исправьте ошибки перед сохранением."); return; }
    const selected = scopedEntries.flatMap((entry, index) => excluded.has(index) || preview.rows[index]?.duplicate ? [] : [{ ...entry, category: chosenCategory(index, entry) }]);
    if (!selected.length) { setError("Выберите хотя бы одну новую операцию."); return; }
    if (selected.some((entry) => !entry.category || entry.category.length > 40)) { setError("У выбранной операции отсутствует категория или её название длиннее 40 символов."); return; }
    if (selected.length > MAX_IMPORT_ENTRIES) { setError(`За один раз можно добавить не больше ${MAX_IMPORT_ENTRIES} операций.`); return; }
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/import", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "commit", transactions: selected }) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as ImportResponse;
      setSaved(result.imported);
      setStep("done");
      if (result.imported > 0) onImported();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить операции."); }
    finally { setBusy(false); }
  }
  function toggleExcluded(index: number) {
    setExcluded((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="statement-import-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm md:items-center md:p-5" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="flex max-h-[96dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-[30px] border border-white/10 bg-[#17171c] shadow-2xl md:max-h-[min(92dvh,900px)] md:rounded-[28px]">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/8 px-5 py-4 sm:px-7 sm:py-5">
        <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-violet-400/10 text-violet-300"><FileSpreadsheet size={19}/></span><div><h2 id="statement-import-title" className="text-lg font-semibold tracking-tight">Импорт выписки</h2><p className="mt-0.5 text-[11px] leading-4 text-zinc-500">CSV, TSV, Excel или Kaspi Gold PDF · сначала проверка, потом сохранение</p></div></div>
        <button type="button" aria-label="Закрыть импорт" onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-zinc-400 hover:text-white"><X size={18}/></button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-thin sm:px-7">
        {step === "done" ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><span className="grid h-16 w-16 place-items-center rounded-3xl bg-emerald-400/10 text-emerald-300"><Check size={30}/></span><h3 className="mt-5 text-xl font-semibold">{saved ? "Операции добавлены" : "Новых операций нет"}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-zinc-400">{saved ? `Добавлено ${saved} ${saved === 1 ? "операция" : saved < 5 ? "операции" : "операций"}. Они уже учтены в итогах и аналитике.` : "Выбранные строки уже были в учёте. Повторно ничего не записали."}</p></div> : <>
          <div className="rounded-2xl border border-violet-400/15 bg-violet-400/[.055] px-4 py-3 text-[11px] leading-5 text-zinc-300"><ShieldCheck size={16} className="mr-2 inline-block align-[-3px] text-violet-300"/> Файл разбирается на устройстве. На сервер отправятся только операции для проверки и те, что вы подтвердите.</div>
          {step === "file" ? <>
            <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-white/15 bg-white/[.025] px-5 py-7 text-center transition-colors hover:border-violet-400/40 hover:bg-violet-400/[.04]"><Upload size={23} className="text-violet-300"/><span className="mt-3 text-sm font-medium">{busy ? "Читаем выписку…" : grid ? "Выбрать другой файл" : "Выбрать выписку"}</span><span className="mt-1 text-[11px] text-zinc-500">.csv, .tsv, .xlsx, .pdf · до {MAX_STATEMENT_BYTES / 1024 / 1024} МБ</span><input ref={inputRef} type="file" accept=".csv,.tsv,.xlsx,.pdf,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf" className="sr-only" disabled={busy} onChange={(event) => { void loadFile(event.target.files?.[0]); event.target.value = ""; }}/></label>
            {!grid && <p className="mt-3 text-center text-[11px] leading-5 text-zinc-500">PDF пока рассчитан на текстовую выписку Kaspi Gold. Скан или PDF другого банка может не распознаться. CSV/Excel других банков можно настроить через выбор колонок.</p>}
            {grid && mapping && <>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-2"><div><p className="max-w-[240px] truncate text-sm font-medium sm:max-w-lg" title={grid.filename}>{grid.filename}</p><p className="mt-1 text-[11px] text-zinc-500">{grid.rows.filter((row) => row.some((cell) => cell.trim())).length} строк после заголовка · {entries.length} операций распознано{pendingRowIndices.size > 0 ? ` · ${pendingRowIndices.size} ожидают подтверждения` : ""}</p></div><span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-zinc-400">{isPdf ? "Сверено с выпиской" : "Проверьте колонки"}</span></div>
              <label className="mt-4 block rounded-2xl border border-white/8 bg-white/[.025] p-4 text-[11px] font-medium text-zinc-300">Счёт или банк <span className="text-rose-300">*</span><input value={sourceLabel} onChange={(event) => { setSourceLabel(event.target.value); resetReview(); }} maxLength={60} required placeholder="Например, Kaspi Gold" className={`${fieldClass} mt-2`}/><span className="mt-2 block font-normal leading-5 text-zinc-500">Используйте одно название при повторной загрузке выписок этого счёта. Для другого счёта укажите другое название.</span></label>
              {grid.warnings.length > 0 && <div className="mt-3 space-y-1">{grid.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="flex gap-2 text-[11px] leading-5 text-amber-200/80"><Info size={14} className="mt-0.5 shrink-0"/>{warning}</p>)}</div>}
              {mapped.warnings.length > 0 && <div className="mt-3 space-y-1">{mapped.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="flex gap-2 text-[11px] leading-5 text-amber-200/80"><Info size={14} className="mt-0.5 shrink-0"/>{warning}</p>)}</div>}
              {isPdf ? <div className="mt-5 flex gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[.055] px-4 py-3"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-300"/><div><p className="text-xs font-medium text-emerald-200">Формат Kaspi Gold PDF и итоги выписки проверены</p><p className="mt-1 text-[11px] leading-5 text-zinc-400">Дата, сумма, знак операции и валюта определены автоматически. Настройки чтения PDF заблокированы, чтобы не исказить операции. Проверьте фрагмент файла и каждую запись перед сохранением.</p></div></div> : <>
              <div className="mt-5 rounded-2xl border border-white/8 bg-white/[.025] p-4"><label className="block text-[11px] font-medium text-zinc-400">Строка с названиями колонок<select value={grid.headerRowIndex} onChange={(event) => { const next = setStatementHeaderRow(grid, Number(event.target.value)); const suggested = suggestMapping(next); setGrid(next); setMapping(suggested); setAmountMode(suggested.debitColumn != null || suggested.creditColumn != null ? "split" : "signed"); resetReview(); }} className={`${fieldClass} mt-2`}><option value={-1}>Без заголовков — данные с первой строки</option>{grid.rawRows.slice(0, 30).map((row, index) => <option key={index} value={index}>{index + 1}: {row.slice(0, 3).join(" · ").slice(0, 90) || "Пустая строка"}</option>)}</select></label><p className="mt-2 text-[11px] leading-5 text-zinc-500">Если банк поставил название и номер счёта перед таблицей, выберите строку, где начинаются названия полей.</p></div>
              <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
                <section><h3 className="text-sm font-semibold">Основные поля</h3><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><ColumnSelect label="Дата операции" value={mapping.dateColumn} grid={grid} onChange={(value) => updateColumn("dateColumn", value)}/><ColumnSelect label="Описание / получатель" value={mapping.descriptionColumn} grid={grid} onChange={(value) => updateColumn("descriptionColumn", value)}/></div><div className="mt-4 flex rounded-xl border border-white/8 bg-white/[.035] p-1 text-xs"><button type="button" onClick={() => { setAmountMode("signed"); updateMapping({ debitColumn: null, creditColumn: null }); }} className={`flex-1 rounded-lg px-3 py-2 ${!splitAmounts ? "bg-violet-500/25 text-violet-200" : "text-zinc-500"}`}>Одна сумма со знаком</button><button type="button" onClick={() => { setAmountMode("split"); updateMapping({ amountColumn: null }); }} className={`flex-1 rounded-lg px-3 py-2 ${splitAmounts ? "bg-violet-500/25 text-violet-200" : "text-zinc-500"}`}>Списание / пополнение</button></div><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{splitAmounts ? <><ColumnSelect label="Списание" value={mapping.debitColumn} grid={grid} onChange={(value) => updateColumn("debitColumn", value)}/><ColumnSelect label="Пополнение" value={mapping.creditColumn} grid={grid} onChange={(value) => updateColumn("creditColumn", value)}/></> : <ColumnSelect label="Сумма" value={mapping.amountColumn} grid={grid} onChange={(value) => updateColumn("amountColumn", value)}/>}</div></section>
                <section><h3 className="text-sm font-semibold">Как читать выписку</h3><div className="mt-3 grid grid-cols-2 gap-3"><label className="text-[11px] text-zinc-400">Формат даты<select className={`${fieldClass} mt-2`} value={mapping.dateOrder} onChange={(event) => updateMapping({ dateOrder: event.target.value as StatementMapping["dateOrder"] })}><option value="DMY">День / месяц / год</option><option value="MDY">Месяц / день / год</option><option value="YMD">Год / месяц / день</option></select></label><label className="text-[11px] text-zinc-400">Валюта по умолчанию<select className={`${fieldClass} mt-2`} value={mapping.defaultCurrency} onChange={(event) => updateMapping({ defaultCurrency: event.target.value })}>{currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label></div>{!splitAmounts && <label className="mt-3 block text-[11px] text-zinc-400">Положительная сумма — это<select className={`${fieldClass} mt-2`} value={mapping.positiveAmountType} onChange={(event) => updateMapping({ positiveAmountType: event.target.value as StatementMapping["positiveAmountType"] })}><option value="income">Доход</option><option value="expense">Расход</option></select></label>}<details className="mt-4 rounded-xl border border-white/8 bg-white/[.025] px-3 py-2"><summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-zinc-400">Дополнительные колонки<ChevronDown size={14}/></summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><ColumnSelect label="Тип (приход / расход)" value={mapping.directionColumn} grid={grid} onChange={(value) => updateColumn("directionColumn", value)}/><ColumnSelect label="Валюта" value={mapping.currencyColumn} grid={grid} onChange={(value) => updateColumn("currencyColumn", value)}/><ColumnSelect label="Категория банка" value={mapping.categoryColumn} grid={grid} onChange={(value) => updateColumn("categoryColumn", value)}/><ColumnSelect label="Номер операции" value={mapping.referenceColumn} grid={grid} onChange={(value) => updateColumn("referenceColumn", value)}/></div></details></section>
              </div>
              </>}
              <div className="mt-5 overflow-hidden rounded-2xl border border-white/8"><div className="flex items-center justify-between bg-white/[.035] px-4 py-3"><h3 className="text-xs font-medium text-zinc-300">Фрагмент файла</h3><span className="text-[10px] text-zinc-500">Первые 3 строки</span></div><div className="overflow-x-auto"><table className="min-w-full whitespace-nowrap text-left text-[11px]"><thead><tr>{grid.headers.map((header, index) => <th key={index} className="max-w-48 truncate border-b border-white/5 px-3 py-2 font-medium text-zinc-400" title={header}>{header || `Колонка ${index + 1}`}</th>)}</tr></thead><tbody>{grid.rows.slice(0, 3).map((row, index) => <tr key={index} className="border-b border-white/5 last:border-0">{grid.headers.map((_, cellIndex) => <td key={cellIndex} className="max-w-48 truncate px-3 py-2 text-zinc-500" title={row[cellIndex] ?? ""}>{row[cellIndex] || "—"}</td>)}</tr>)}</tbody></table></div></div>
              {mapped.errors.length > 0 && <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/[.045] px-4 py-3"><p className="text-xs font-medium text-amber-200">{pdfMappingBlocked ? `PDF разобран не полностью: ${mapped.errors.length} строк с ошибками. Импорт заблокирован, чтобы не пропустить операции.` : `${mapped.errors.length} строк не распознано — они не попадут в импорт`}</p><div className="mt-2 space-y-1">{mapped.errors.slice(0, 4).map((item, index) => <p key={index} className="text-[11px] text-zinc-400">Строка {item.rowNumber}: {item.message}</p>)}</div></div>}
              {pdfRowsMisaligned && <p className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-300/15 bg-amber-300/[.045] px-4 py-3 text-[11px] leading-5 text-amber-200"><AlertCircle size={14} className="mt-0.5 shrink-0"/> Число распознанных операций не совпадает с числом строк PDF. Импорт заблокирован, чтобы статус ожидающих операций не сместился.</p>}
            </>}
          </> : preview && <>
            <div className="mt-5 flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-base font-semibold">Проверьте операции</h3><p className="mt-1 text-[11px] leading-5 text-zinc-500">Отметьте нужные строки и категории. Похожие на уже внесённые траты, платежи по кредиту и переводы между своими счетами отключены — их можно включить вручную.{pendingRowIndices.size > 0 ? " Операции, ожидающие подтверждения банка, тоже отключены по умолчанию." : ""}{isPdf ? " Типы операций сверены с PDF и не меняются вручную." : ""}</p></div><button type="button" onClick={resetReview} className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-zinc-300"><RotateCcw size={13}/> {isPdf ? "Вернуться к файлу" : "Изменить колонки"}</button></div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center"><SummaryCount label="Распознано" value={entries.length}/><SummaryCount label="Повторы" value={preview.rows.filter((row) => row.duplicate).length}/><SummaryCount label="Выбрано" value={selectedCount} accent/></div>
            {isPdf && grid && grid.warnings.length > 0 && <div className="mt-3 space-y-1">{grid.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="flex items-start gap-2 rounded-xl bg-amber-300/[.05] px-3 py-2 text-[11px] leading-5 text-amber-100/80"><Info size={14} className="mt-0.5 shrink-0"/>{warning}</p>)}</div>}
            {mapped.errors.length > 0 && <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-300/[.05] px-3 py-2 text-[11px] leading-5 text-amber-100/80"><AlertCircle size={14} className="mt-0.5 shrink-0"/> {pdfMappingBlocked ? `PDF содержит ${mapped.errors.length} строк с ошибками. Сохранение заблокировано.` : `${mapped.errors.length} строк не распознано и не будут добавлены.`}</p>}
            {mapped.warnings.length > 0 && <div className="mt-3 space-y-1">{mapped.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="flex items-start gap-2 text-[11px] leading-5 text-amber-100/80"><Info size={14} className="mt-0.5 shrink-0"/>{warning}</p>)}</div>}
            {previewOutdated && <p className="mt-3 flex items-start gap-2 rounded-xl border border-violet-400/20 bg-violet-400/[.08] px-3 py-2 text-[11px] leading-5 text-violet-200"><RotateCcw size={14} className="mt-0.5 shrink-0"/> Тип операции изменён. Обновите проверку повторов перед сохранением.</p>}
            <div className="mt-4 space-y-2">{entries.map((entry, index) => {
              const status = preview.rows[index];
              const transfer = ownTransferPattern.test(entry.note);
              const isExcluded = excluded.has(index) || status.duplicate;
              const effectiveType = scopedEntries[index].type;
              const choice = categoryChoices[index] ?? entry.category;
              const options = [...new Set([entry.category, ...presets.filter((preset) => preset.type === effectiveType).map((preset) => preset.name)])].filter(Boolean);
              return <article key={`${entry.sourceKey}-${index}`} className={`rounded-2xl border p-3.5 transition-colors sm:p-4 ${isExcluded ? "border-white/6 bg-white/[.015] opacity-60" : "border-white/10 bg-white/[.035]"}`}>
                <div className="flex items-start gap-3"><input type="checkbox" aria-label={`Добавить операцию ${index + 1}`} checked={!isExcluded} disabled={status.duplicate} onChange={() => toggleExcluded(index)} className="mt-1 h-4 w-4 shrink-0 accent-violet-500"/><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${effectiveType === "income" ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}>{effectiveType === "income" ? <ArrowDownLeft size={17}/> : <ArrowUpRight size={17}/>}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><p className="max-w-[250px] truncate text-xs font-medium sm:max-w-md" title={entry.note}>{entry.note || (effectiveType === "income" ? "Поступление" : "Списание")}</p><strong className={`whitespace-nowrap text-sm ${effectiveType === "income" ? "text-emerald-300" : "text-zinc-100"}`}>{effectiveType === "income" ? "+" : "−"}{formatMoney(entry.amount, entry.currency)}</strong></div><p className="mt-1 text-[11px] text-zinc-500">{formatDate(entry.happenedAt)} · {entry.currency}</p>{(status.duplicate || status.possibleCreditDuplicate || status.possibleExistingDuplicate || transfer || pendingRowIndices.has(index)) && <div className="mt-2 flex flex-wrap gap-1.5">{status.duplicate && <span className="rounded-full bg-zinc-500/10 px-2 py-1 text-[10px] text-zinc-400">Уже есть в учёте</span>}{status.possibleExistingDuplicate && <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] text-amber-200">Похоже на уже внесённую операцию</span>}{status.possibleCreditDuplicate && <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] text-amber-200">Похож на платёж по кредиту</span>}{transfer && <span className="rounded-full bg-sky-300/10 px-2 py-1 text-[10px] text-sky-200">Похоже на перевод между своими счетами</span>}{pendingRowIndices.has(index) && <span className="rounded-full bg-orange-300/10 px-2 py-1 text-[10px] text-orange-200">Ожидает подтверждения банком</span>}</div>}</div></div>
                {!status.duplicate && <div className="mt-3 grid gap-2 border-t border-white/5 pt-3 sm:grid-cols-[125px_1fr] sm:items-center"><label className="text-[11px] text-zinc-500" htmlFor={`import-type-${index}`}>Тип операции</label><select id={`import-type-${index}`} value={effectiveType} disabled={isPdf} onChange={(event) => { setTypeOverrides((previous) => ({ ...previous, [index]: event.target.value as ImportEntry["type"] })); setPreviewOutdated(true); }} className="min-w-0 rounded-xl border border-white/10 bg-[#25252b] px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-400/70 disabled:opacity-60"><option value="expense">Расход</option><option value="income">Доход</option></select><label className="text-[11px] text-zinc-500" htmlFor={`import-category-${index}`}>Категория</label><select id={`import-category-${index}`} value={choice} onChange={(event) => setCategoryChoices((previous) => ({ ...previous, [index]: event.target.value }))} className="min-w-0 rounded-xl border border-white/10 bg-[#25252b] px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-400/70">{options.map((name) => <option key={name} value={name}>{name}</option>)}<option value="__custom__">Своя категория…</option></select>{choice === "__custom__" && <input aria-label={`Своя категория операции ${index + 1}`} value={customCategories[index] ?? ""} maxLength={40} onChange={(event) => setCustomCategories((previous) => ({ ...previous, [index]: event.target.value }))} placeholder="Название категории" className="min-w-0 rounded-xl border border-white/10 bg-[#25252b] px-3 py-2 text-xs outline-none placeholder:text-zinc-600 focus:border-violet-400/70 sm:col-start-2"/>}</div>}
              </article>;
            })}</div>
            <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-zinc-500"><Info size={14} className="mt-0.5 shrink-0"/> Проверьте знаки сумм и даты. Ошибочные строки можно убрать галочкой; после импорта каждую операцию можно удалить из списка.</p>
          </>}
        </>}
        {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[.08] px-3 py-2.5 text-xs leading-5 text-rose-200"><AlertCircle size={15} className="mt-0.5 shrink-0"/>{error}</p>}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/8 bg-[#17171c] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-7">
        <p className="max-w-[230px] text-[11px] leading-4 text-zinc-500">{step === "file" ? pdfMappingBlocked ? "PDF содержит ошибки — импорт заблокирован" : "Ничего не сохранится без вашего подтверждения" : step === "review" ? pdfMappingBlocked ? "PDF содержит ошибки — сохранение заблокировано" : previewOutdated ? "Нужно обновить проверку" : `${selectedCount} операций будет добавлено` : "Можно загрузить другую выписку"}</p>
        {step === "done" ? <div className="flex gap-2"><button type="button" onClick={() => { setGrid(null); setMapping(null); resetReview(); }} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs text-zinc-300">Ещё файл</button><button type="button" onClick={onClose} className="rounded-xl bg-violet-500 px-4 py-2.5 text-xs font-semibold">Готово</button></div>
          : step === "review" ? previewOutdated
            ? <button type="button" disabled={busy || pdfMappingBlocked} onClick={() => void review(true)} className="shrink-0 rounded-xl bg-violet-500 px-4 py-3 text-xs font-semibold disabled:opacity-50">{busy ? "Проверяем…" : "Обновить проверку"}</button>
            : <button type="button" disabled={busy || pdfMappingBlocked || selectedCount === 0 || selectedWithoutCategory} onClick={() => void commit()} className="shrink-0 rounded-xl bg-violet-500 px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Сохраняем…" : `Добавить ${selectedCount}`}</button>
          : <button type="button" disabled={busy || !grid || !sourceLabel.trim() || entries.length === 0 || entries.length > MAX_IMPORT_ENTRIES || pdfMappingBlocked} onClick={() => void review()} className="shrink-0 rounded-xl bg-violet-500 px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Проверяем…" : "Проверить операции"}</button>}
      </footer>
    </div>
  </div>;
}

function ColumnSelect({ label, value, grid, onChange }: { label: string; value: number | null; grid: StatementGrid; onChange(value: string): void }) {
  return <label className="min-w-0 text-[11px] text-zinc-400">{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value)} className={`${fieldClass} mt-2`}><option value="">Не выбрано</option>{grid.headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header || `Колонка ${index + 1}`} {grid.rows[0]?.[index] ? `(${grid.rows[0][index].slice(0, 20)})` : ""}</option>)}</select></label>;
}
function SummaryCount({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <div className={`rounded-2xl border px-2 py-3 ${accent ? "border-violet-400/20 bg-violet-400/[.08]" : "border-white/8 bg-white/[.025]"}`}><p className={`text-lg font-semibold ${accent ? "text-violet-200" : "text-zinc-200"}`}>{value}</p><p className="mt-0.5 text-[10px] text-zinc-500">{label}</p></div>;
}
