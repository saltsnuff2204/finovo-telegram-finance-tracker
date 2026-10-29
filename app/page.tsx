"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, Bell, CalendarDays, ChevronLeft, ChevronRight, Clock3, CreditCard, FileSpreadsheet, HandCoins, Home, Plus, Settings2, Target, Trash2, X } from "lucide-react";
import { StatementImportModal } from "@/components/statement-import";

type Transaction = { id: number; type: "income" | "expense"; amount: number; currency: string; category: string; note: string; happenedAt: string };
type Obligation = { id: number; kind: "debt" | "goal" | "credit"; title: string; amount: number; currentAmount: number; currency: string; monthlyPayment?: number | null; totalMonths?: number | null; paidMonths?: number | null; nextPaymentDate?: string | null; dueDate?: string | null; paymentDay?: number | null };
type CategoryPreset = { id: number; name: string; type: "income" | "expense"; icon?: string | null; color?: string | null };
type CurrencyTotals = { currency: string; income: number; expense: number; balance: number };
type AnalyticsData = { month: string; totals: CurrencyTotals; totalsByCurrency: CurrencyTotals[]; categories: { category: string; amount: number }[] };
type Dashboard = AnalyticsData & { user: { first_name: string }; recent: Transaction[]; obligations: Obligation[] };

declare global {
  interface Window { Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void; HapticFeedback?: { impactOccurred(style: string): void } } } }
}

const colors = ["#9b87f5", "#53d5a5", "#ffbd59", "#ff7b86", "#57a8ff", "#b7c1ce"];
function currentMonth() { return todayInQyzylorda().slice(0, 7); }
function shiftMonth(month: string, by: number) { const [year, index] = month.split("-").map(Number); const date = new Date(Date.UTC(year, index - 1 + by, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function monthLabel(month: string) { const [year, index] = month.split("-").map(Number); return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, index - 1, 1))); }
function formatDate(value?: string | null) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Qyzylorda", day: "numeric", month: "long", year: "numeric" }).format(date); }
function formatTimestamp(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Qyzylorda", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date); }
function todayInQyzylorda() { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ""; return `${value("year")}-${value("month")}-${value("day")}`; }
function finalPaymentDate(nextDate: string, remainingMonths: number) { if (!nextDate || remainingMonths < 1) return ""; const [year, month, day] = nextDate.split("-").map(Number); if (!year || !month || !day) return ""; const start = new Date(Date.UTC(year, month - 1 + remainingMonths - 1, 1)); const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate(); return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`; }
const sample: Dashboard = {
  month: currentMonth(), user: { first_name: "Демо" }, totals: { currency: "KZT", income: 0, expense: 0, balance: 0 },
  totalsByCurrency: [{ currency: "KZT", income: 0, expense: 0, balance: 0 }],
  recent: [],
  categories: [],
  obligations: [],
};
const emptyDashboard: Dashboard = { month: currentMonth(), user: { first_name: "Вы" }, totals: { currency: "KZT", income: 0, expense: 0, balance: 0 }, totalsByCurrency: [], recent: [], categories: [], obligations: [] };

function formatMoney(value: number, currency = "KZT") {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
}
function authHeaders() {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return { "content-type": "application/json", "x-telegram-init-data": initData, ...(initData ? {} : { "x-demo-user": "1" }) };
}

export default function HomePage() {
  const [data, setData] = useState<Dashboard>(emptyDashboard);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsMonth, setAnalyticsMonth] = useState(currentMonth);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [presets, setPresets] = useState<CategoryPreset[]>([]);
  const [presetBusy, setPresetBusy] = useState(false);
  const [environment, setEnvironment] = useState<"checking" | "telegram" | "demo" | "outside">("checking");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"home" | "analytics" | "goals" | "debts" | "settings">("home");
  const [modal, setModal] = useState<null | "transaction" | "obligation">(null);
  const [importOpen, setImportOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const [progressItem, setProgressItem] = useState<Obligation | null>(null);
  const [obligationKind, setObligationKind] = useState<"goal" | "debt" | "credit">("goal");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!resetDone) return;
    const timeout = window.setTimeout(() => setResetDone(false), 8000);
    return () => window.clearTimeout(timeout);
  }, [resetDone]);
  async function load() {
    try {
      const response = await fetch("/api/dashboard", { headers: authHeaders() });
      if (!response.ok) throw new Error(response.status === 401 ? "Откройте приложение внутри Telegram" : "Не удалось загрузить данные");
      setData(await response.json());
      setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Проверьте соединение и попробуйте снова"); }
    finally { setLoading(false); }
  }
  async function loadPresets() {
    try {
      const response = await fetch("/api/categories", { headers: authHeaders() });
      if (response.ok) setPresets(await response.json());
    } catch { /* Categories can be loaded later. */ }
  }
  async function refresh() { await Promise.all([load(), loadPresets()]); setRefreshKey((value) => value + 1); }
  async function createPreset(name: string, type: "income" | "expense") {
    setPresetBusy(true);
    try {
      const response = await fetch("/api/categories", { method: "POST", headers: authHeaders(), body: JSON.stringify({ name, type }) });
      if (!response.ok) throw new Error(await apiError(response));
      await loadPresets(); return true;
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Не удалось добавить категорию"); return false; }
    finally { setPresetBusy(false); }
  }
  async function deletePreset(item: CategoryPreset) {
    if (!window.confirm(`Удалить пресет «${item.name}»? Старые операции останутся.`)) return;
    setPresetBusy(true);
    try {
      const response = await fetch(`/api/categories/${item.id}`, { method: "DELETE", headers: authHeaders() });
      if (!response.ok) throw new Error(await apiError(response));
      await loadPresets();
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Не удалось удалить категорию"); }
    finally { setPresetBusy(false); }
  }
  function openObligation(kind: "goal" | "debt" | "credit") { setObligationKind(kind); setModal("obligation"); }
  async function remove(path: string, description: string) {
    if (!window.confirm(`Удалить ${description}? Это действие нельзя отменить.`)) return;
    try {
      const response = await fetch(path, { method: "DELETE", headers: authHeaders() });
      if (!response.ok) throw new Error("Не удалось удалить запись");
      await refresh();
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Не удалось удалить запись"); }
  }
  async function resetAccountData() {
    const response = await fetch("/api/account/reset", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ confirmation: "СБРОСИТЬ" }),
    });
    if (!response.ok) throw new Error(await apiError(response));
    setData((previous) => ({ ...emptyDashboard, month: currentMonth(), user: previous.user }));
    setPresets([]);
    setAnalytics(null);
    await refresh();
    closeResetModal();
    setResetDone(true);
  }
  function closeResetModal() {
    setResetOpen(false);
    requestAnimationFrame(() => resetTriggerRef.current?.focus());
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const telegram = window.Telegram?.WebApp;
      const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
      if (!telegram?.initData && !local) { setEnvironment("outside"); setLoading(false); return; }
      setEnvironment(telegram?.initData ? "telegram" : "demo");
      if (local && !telegram?.initData) setData(sample);
      telegram?.ready(); telegram?.expand(); void load(); void loadPresets();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (environment !== "telegram" && environment !== "demo") return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) setAnalyticsLoading(true); });
    fetch(`/api/analytics?month=${analyticsMonth}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(await apiError(response)); return response.json() as Promise<AnalyticsData>; })
      .then(setAnalytics)
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Не удалось загрузить аналитику"); })
      .finally(() => { if (!controller.signal.aborted) setAnalyticsLoading(false); });
    return () => controller.abort();
  }, [analyticsMonth, refreshKey, environment]);
  const maxCategory = Math.max(...data.categories.map((item) => Number(item.amount)), 1);
  const expenseShare = data.totals.income ? Math.round(data.totals.expense / data.totals.income * 100) : 0;

  if (environment === "checking") return <main className="grid min-h-dvh place-items-center bg-[#0c0c0f] text-sm text-zinc-500">Открываем ваши финансы…</main>;
  if (environment === "outside") return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center bg-[#0c0c0f] px-7 text-white"><div className="mb-8 grid h-16 w-16 place-items-center rounded-3xl bg-violet-500/15 text-violet-300"><CreditCard size={32}/></div><p className="text-sm text-violet-300">Мои финансы</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Всё под рукой. В Telegram.</h1><p className="mt-4 text-sm leading-6 text-zinc-400">Ваши операции и цели доступны только после входа через Telegram. Откройте бота, чтобы начать.</p><a href="https://t.me/finovo_tracker_bot" className="mt-8 rounded-2xl bg-violet-500 px-5 py-4 text-center text-sm font-semibold">Открыть бота</a></main>;

  return <main className="mx-auto min-h-dvh max-w-[1440px] bg-[#0c0c0f] text-white shadow-2xl shadow-black/30 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
    <aside className="hidden border-r border-white/8 bg-[#111115] px-4 py-7 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
      <div className="flex items-center gap-3 px-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-500"><CreditCard size={20}/></span><div><p className="text-sm font-semibold">Мои финансы</p><p className="text-[11px] text-zinc-500">Личный кабинет</p></div></div>
      <div className="mt-10 space-y-1"><SideButton active={tab === "home"} icon={<Home size={18}/>} label="Главная" onClick={() => setTab("home")}/><SideButton active={tab === "analytics"} icon={<BarChart3 size={18}/>} label="Аналитика" onClick={() => setTab("analytics")}/><SideButton active={tab === "goals"} icon={<Target size={18}/>} label="Цели" onClick={() => setTab("goals")}/><SideButton active={tab === "debts"} icon={<HandCoins size={18}/>} label="Долги и кредиты" onClick={() => setTab("debts")}/><SideButton active={tab === "settings"} icon={<Settings2 size={18}/>} label="Настройки" onClick={() => setTab("settings")}/></div>
      <button onClick={() => setModal("transaction")} className="mt-8 flex items-center justify-center gap-2 rounded-2xl bg-violet-500 px-4 py-3.5 text-sm font-semibold hover:bg-violet-400"><Plus size={18}/> Новая операция</button>
      <button onClick={() => setImportOpen(true)} className="mt-2 flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-300 hover:bg-white/10"><FileSpreadsheet size={17}/> Импорт выписки</button>
      <div className="mt-auto rounded-2xl border border-white/8 bg-white/[.025] p-4 text-[11px] leading-5 text-zinc-500"><Bell size={15} className="mb-2 text-violet-300"/> Напоминания о кредитах придут прямо в чат с ботом.</div>
    </aside>
    <div className="min-w-0 pb-28 lg:pb-12">
    <header className="mx-auto flex max-w-[1120px] items-center justify-between px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] md:px-8 lg:border-b lg:border-white/8 lg:pb-6 lg:pt-8">
      <div><p className="text-xs text-zinc-500">Добрый день</p><h1 className="mt-0.5 text-xl font-semibold tracking-tight">{data.user.first_name}</h1></div>
      <button aria-label="Настройки профиля" onClick={() => setTab("settings")} className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-violet-700 text-sm font-bold shadow-lg shadow-violet-500/20">{data.user.first_name.slice(0, 1)}</button>
    </header>
    <div className="mx-auto max-w-[1120px] md:px-4 lg:pt-7">
    {loadError && <div role="alert" className="mx-4 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200"><span>{loadError}</span><button onClick={() => { setLoadError(""); void refresh(); }} className="font-semibold underline">Повторить</button></div>}
    {tab === "home" && <div className="lg:grid lg:grid-cols-2 lg:gap-x-1">
      <section className="mx-4 overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-[#282332] via-[#19171f] to-[#111116] p-5 shadow-xl shadow-black/30 lg:p-7">
        <div className="flex items-center justify-between text-xs text-zinc-400"><span>Итог за {monthLabel(currentMonth())}</span><span>₸ KZT</span></div>
        <p className="mt-3 text-[34px] font-semibold leading-none tracking-[-0.04em]">{formatMoney(data.totals.balance)}</p>
        <div className="mt-6 grid grid-cols-2 gap-3"><Metric icon={<ArrowDownLeft size={16}/>} label="Доходы" value={data.totals.income} positive/><Metric icon={<ArrowUpRight size={16}/>} label="Расходы" value={data.totals.expense}/></div>
      </section>
      <OtherCurrencies totals={data.totalsByCurrency}/>
      <section className="px-4 pt-6 lg:row-start-1 lg:col-start-2 lg:pt-0"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Расходы</h2><button onClick={() => setTab("analytics")} className="text-xs text-violet-300">Подробнее</button></div>
        <div className="rounded-3xl border border-white/8 bg-[#151519] p-4"><div className="flex items-end justify-between"><div><p className="text-xs text-zinc-500">Потрачено</p><p className="mt-1 text-xl font-semibold">{formatMoney(data.totals.expense)}</p></div><span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-xs text-violet-300">{expenseShare}% дохода</span></div>
          <div className="mt-5 space-y-3">{data.categories.slice(0, 4).map((item, index) => <div key={item.category}><div className="mb-1.5 flex justify-between text-xs"><span className="text-zinc-300">{item.category}</span><span className="text-zinc-500">{formatMoney(Number(item.amount))}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full" style={{ width: `${Number(item.amount) / maxCategory * 100}%`, background: colors[index] }}/></div></div>)}</div>
        </div>
      </section>
      <section className="px-4 pt-6 lg:col-span-2"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">Последние операции</h2><button onClick={() => setImportOpen(true)} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-violet-200 hover:bg-violet-400/10"><FileSpreadsheet size={14}/> Импорт выписки</button></div><div className="overflow-hidden rounded-3xl border border-white/8 bg-[#151519]">{data.recent.length ? data.recent.map((item) => <TransactionRow key={item.id} item={item} onDelete={(entry) => remove(`/api/transactions/${entry.id}`, `операцию «${entry.note || entry.category}»`)}/>) : <p className="p-5 text-sm text-zinc-500">Пока нет операций. Добавьте первую.</p>}</div></section>
    </div>}
    {tab === "analytics" && <Analytics data={analytics} month={analyticsMonth} loading={analyticsLoading} onMonthChange={setAnalyticsMonth}/>}
    {tab === "goals" && <Goals items={data.obligations} onAdd={() => openObligation("goal")} onProgress={setProgressItem} onDelete={(item) => remove(`/api/obligations/${item.id}`, `цель «${item.title}»`)}/>}
    {tab === "debts" && <Debts items={data.obligations} onAdd={() => openObligation("credit")} onAddDebt={() => openObligation("debt")} onProgress={setProgressItem} onDelete={(item) => remove(`/api/obligations/${item.id}`, `запись «${item.title}»`)}/>}
    {tab === "settings" && <><Settings name={data.user.first_name} presets={presets} busy={presetBusy} onCreate={createPreset} onDelete={deletePreset}/><section className="mt-4 px-4"><button onClick={() => setImportOpen(true)} className="flex w-full items-center justify-between gap-4 rounded-3xl border border-white/8 bg-[#151519] p-5 text-left transition-colors hover:border-violet-400/30 hover:bg-[#1b1922]"><span className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-violet-400/10 text-violet-300"><FileSpreadsheet size={20}/></span><span><span className="block text-sm font-semibold">Импорт выписки</span><span className="mt-1 block text-[11px] leading-5 text-zinc-500">CSV, TSV, Excel и Kaspi Gold PDF. Проверьте операции перед добавлением.</span></span></span><ChevronRight size={17} className="shrink-0 text-zinc-500"/></button></section><section className="mt-4 px-4"><div className="rounded-3xl border border-rose-400/15 bg-[#151519] p-5"><div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-rose-400/10 text-rose-300"><Trash2 size={19}/></span><div><h3 className="text-sm font-semibold">Сброс данных</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Удалить все финансовые записи и пресеты за один раз. Telegram-профиль останется.</p></div></div>{resetDone && <p role="status" className="mt-4 rounded-2xl bg-emerald-400/10 px-4 py-3 text-xs text-emerald-200">Все финансовые данные удалены.</p>}<button ref={resetTriggerRef} onClick={() => { setResetDone(false); setResetOpen(true); }} className="mt-5 min-h-11 w-full rounded-2xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 sm:w-auto">Сбросить все данные</button></div></section></>}
    </div>
    <nav aria-label="Основная навигация" className="fixed bottom-0 left-1/2 z-30 grid w-full max-w-md -translate-x-1/2 grid-cols-5 items-end border-t border-white/8 bg-[#101014]/95 px-2 pb-[max(.65rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl lg:hidden">
      <NavButton active={tab === "home"} icon={<Home size={20}/>} label="Главная" onClick={() => setTab("home")}/>
      <NavButton active={tab === "analytics"} icon={<BarChart3 size={20}/>} label="Аналитика" onClick={() => setTab("analytics")}/>
      <button aria-label="Добавить операцию" onClick={() => { setModal("transaction"); window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium"); }} className="group -mt-4 flex min-h-11 min-w-0 items-center justify-center text-violet-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300">
        <span className="grid h-14 w-14 place-items-center rounded-full border-[5px] border-[#101014] bg-violet-500 shadow-[0_8px_28px_rgb(139_92_246/45%)] transition-transform group-active:scale-95"><Plus size={24}/></span>
      </button>
      <NavButton active={tab === "goals"} icon={<Target size={20}/>} label="Цели" onClick={() => setTab("goals")}/>
      <NavButton active={tab === "debts"} icon={<HandCoins size={20}/>} label="Долги" onClick={() => setTab("debts")}/>
    </nav>
    {modal && <EntryModal kind={modal} presets={presets} defaultObligationKind={obligationKind} onClose={() => setModal(null)} onSaved={() => { setModal(null); void refresh(); }}/>} {progressItem && <ProgressModal item={progressItem} onClose={() => setProgressItem(null)} onSaved={() => { setProgressItem(null); void refresh(); }}/>} {importOpen && <StatementImportModal presets={presets} authHeaders={authHeaders} onClose={() => setImportOpen(false)} onImported={() => void refresh()}/>} {resetOpen && <ResetDataModal onClose={closeResetModal} onReset={resetAccountData}/>} {loading && <div className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur">Обновляем…</div>}
    </div>
  </main>;
}

function SideButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick(): void }) { return <button aria-current={active ? "page" : undefined} onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm ${active ? "bg-violet-500/15 text-violet-200" : "text-zinc-400 hover:bg-white/5 hover:text-white"}`}>{icon}<span>{label}</span></button>; }

function Metric({ icon, label, value, positive = false }: { icon: React.ReactNode; label: string; value: number; positive?: boolean }) { return <div className="rounded-2xl bg-white/[.055] p-3"><span className={`inline-grid h-7 w-7 place-items-center rounded-full ${positive ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"}`}>{icon}</span><p className="mt-2 text-[11px] text-zinc-500">{label}</p><p className="mt-0.5 text-sm font-medium">{formatMoney(value)}</p></div>; }
function OtherCurrencies({ totals }: { totals: CurrencyTotals[] }) {
  const others = totals.filter((item) => item.currency !== "KZT");
  if (!others.length) return null;
  return <section className="mx-4 mt-3 rounded-2xl border border-white/8 bg-white/[.035] px-4 py-3"><p className="mb-2 text-[11px] text-zinc-500">Другие валюты · отдельно, без пересчёта</p><div className="space-y-1.5">{others.map((item) => <div key={item.currency} className="flex justify-between text-xs"><span className="text-zinc-400">{item.currency}</span><span className="font-medium text-zinc-200">{formatMoney(item.balance, item.currency)}</span></div>)}</div></section>;
}
function TransactionRow({ item, onDelete }: { item: Transaction; onDelete(item: Transaction): void }) { const income = item.type === "income"; return <div className="flex items-center gap-3 border-b border-white/5 p-4 last:border-0"><div className={`grid h-10 w-10 place-items-center rounded-2xl ${income ? "bg-emerald-400/10 text-emerald-300" : "bg-white/5 text-zinc-300"}`}>{income ? <ArrowDownLeft size={19}/> : <ArrowUpRight size={19}/>}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.note || item.category}</p><p className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-zinc-500"><span>{item.category}</span><span>·</span><time dateTime={item.happenedAt}>{formatTimestamp(item.happenedAt)}</time></p></div><div className="shrink-0 text-right"><p className={`text-sm font-medium ${income ? "text-emerald-300" : "text-white"}`}>{income ? "+" : "−"}{formatMoney(item.amount, item.currency)}</p><button onClick={() => onDelete(item)} className="mt-1 text-[10px] text-zinc-600 underline focus-visible:text-zinc-300">Удалить</button></div></div>; }
function Analytics({ data, month, loading, onMonthChange }: { data: AnalyticsData | null; month: string; loading: boolean; onMonthChange(month: string): void }) {
  const selected = data?.month === month ? data : null;
  const categories = selected?.categories ?? [];
  const total = categories.reduce((sum, item) => sum + Number(item.amount), 0);
  const slices = categories.map((item, index) => {
    const before = categories.slice(0, index).reduce((sum, entry) => sum + Number(entry.amount), 0);
    const start = total ? before / total * 100 : 0;
    const end = total ? (before + Number(item.amount)) / total * 100 : 0;
    return `${colors[index % colors.length]} ${start}% ${end}%`;
  });
  const background = slices.length ? `conic-gradient(${slices.join(",")})` : "#25252c";
  return <section className="px-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-semibold">Аналитика</h2><div className="flex items-center gap-1 rounded-2xl border border-white/8 bg-[#19191f] p-1"><button aria-label="Предыдущий месяц" onClick={() => onMonthChange(shiftMonth(month, -1))} className="grid h-9 w-9 place-items-center rounded-xl text-zinc-400 hover:bg-white/5"><ChevronLeft size={17}/></button><span className="min-w-[125px] text-center text-xs font-medium capitalize">{monthLabel(month)}</span><button aria-label="Следующий месяц" onClick={() => onMonthChange(shiftMonth(month, 1))} className="grid h-9 w-9 place-items-center rounded-xl text-zinc-400 hover:bg-white/5"><ChevronRight size={17}/></button></div></div><div className={`grid gap-4 lg:grid-cols-2 ${loading ? "opacity-60" : ""}`}><div className="rounded-3xl border border-white/8 bg-[#151519] p-5 lg:p-7"><p className="flex items-center gap-2 text-xs text-zinc-500"><CalendarDays size={14}/>{monthLabel(month)} · KZT</p><p className="mt-4 text-xs text-zinc-500">Расходы</p><p className="mt-1 text-3xl font-semibold">{formatMoney(selected?.totals.expense ?? 0)}</p><div className="mt-6 grid grid-cols-2 gap-3"><Metric icon={<ArrowDownLeft size={16}/>} label="Доходы" value={selected?.totals.income ?? 0} positive/><Metric icon={<ArrowUpRight size={16}/>} label="Разница" value={selected?.totals.balance ?? 0}/></div><OtherCurrencies totals={selected?.totalsByCurrency ?? []}/></div><div className="rounded-3xl border border-white/8 bg-[#151519] p-5 lg:p-7"><h3 className="font-semibold">По категориям</h3><div className="grid h-56 place-items-center"><div className="relative grid h-40 w-40 place-items-center rounded-full" style={{ background }}><div className="grid h-24 w-24 place-items-center rounded-full bg-[#151519] text-center"><div><p className="text-[10px] text-zinc-500">Категорий</p><p className="text-lg font-semibold">{categories.length}</p></div></div></div></div>{categories.length ? <div className="grid grid-cols-2 gap-2">{categories.map((item, i) => <div key={item.category} className="flex items-center gap-2 text-xs text-zinc-400"><span className="h-2 w-2 rounded-full" style={{ background: colors[i % colors.length] }}/><span className="truncate">{item.category}</span><span className="ml-auto text-zinc-600">{total ? Math.round(Number(item.amount) / total * 100) : 0}%</span></div>)}</div> : <p className="text-center text-xs text-zinc-500">В этом месяце пока нет расходов</p>}</div></div></section>;
}
function amountGroups(items: Obligation[], mode: "goal" | "debt") {
  const groups = new Map<string, { total: number; current: number }>();
  for (const item of items) {
    const value = groups.get(item.currency) ?? { total: 0, current: 0 };
    value.total += Number(item.amount);
    value.current += Number(item.currentAmount);
    groups.set(item.currency, value);
  }
  return [...groups].map(([currency, value]) => mode === "goal"
    ? `${formatMoney(value.current, currency)} из ${formatMoney(value.total, currency)}`
    : formatMoney(value.total - value.current, currency)).join(" · ");
}
type ObligationActions = { items: Obligation[]; onAdd(): void; onProgress(item: Obligation): void; onDelete(item: Obligation): void; onAddDebt?(): void };
function Goals({ items, onAdd, onProgress, onDelete }: ObligationActions) {
  const goals = items.filter((item) => item.kind === "goal");
  return <ObligationScreen title="Цели" subtitle={goals.length ? amountGroups(goals, "goal") : "Копите на важное без лишнего шума"} items={goals} empty="Добавьте первую финансовую цель" onAdd={onAdd} onProgress={onProgress} onDelete={onDelete}/>;
}
function Debts({ items, onAdd, onAddDebt, onProgress, onDelete }: ObligationActions) {
  const debts = items.filter((item) => item.kind === "debt" || item.kind === "credit");
  return <ObligationScreen title="Долги и кредиты" subtitle={debts.length ? `Осталось выплатить ${amountGroups(debts, "debt")}` : "Долги и кредиты в одном месте"} items={debts} empty="Добавьте долг или кредит" onAdd={onAdd} onAddDebt={onAddDebt} onProgress={onProgress} onDelete={onDelete} showType/>;
}
function ObligationScreen({ title, subtitle, items, empty, onAdd, onAddDebt, onProgress, onDelete, showType = false }: ObligationActions & { title: string; subtitle: string; empty: string; showType?: boolean }) {
  return <section className="px-4"><div className="mb-5 flex items-start justify-between"><div><h2 className="text-2xl font-semibold">{title}</h2><p className="mt-1 text-xs leading-5 text-zinc-500">{subtitle}</p></div><button aria-label={`Добавить: ${title}`} onClick={onAdd} className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/8 bg-white/5 text-violet-300 active:scale-95"><Plus size={19}/></button></div>{onAddDebt && <div className="mb-4 flex flex-wrap gap-2"><button onClick={onAdd} className="rounded-xl bg-violet-500 px-4 py-2.5 text-xs font-semibold">Добавить кредит</button><button onClick={onAddDebt} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs text-zinc-300">Добавить долг</button></div>}<div className="grid gap-3 md:grid-cols-2">{items.length ? items.map((item) => <ObligationCard key={item.id} item={item} showType={showType} onProgress={onProgress} onDelete={onDelete}/>) : <button onClick={onAdd} className="flex min-h-36 w-full flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[.02] px-6 text-center"><span className="grid h-11 w-11 place-items-center rounded-full bg-violet-400/10 text-violet-300"><Plus size={20}/></span><span className="mt-3 text-sm font-medium text-zinc-300">{empty}</span><span className="mt-1 text-xs text-zinc-600">Нажмите, чтобы создать запись</span></button>}</div></section>;
}
function ObligationCard({ item, showType, onProgress, onDelete }: { item: Obligation; showType: boolean; onProgress(item: Obligation): void; onDelete(item: Obligation): void }) {
  const scheduled = item.kind === "credit" && item.monthlyPayment != null && item.totalMonths != null && item.paidMonths != null;
  const percent = Math.min(100, Math.max(0, Math.round(scheduled ? Number(item.paidMonths) / Number(item.totalMonths) * 100 : Number(item.currentAmount) / Number(item.amount) * 100)));
  const isCredit = item.kind === "credit";
  return <article className="rounded-3xl border border-white/8 bg-[#151519] p-4 lg:p-6"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-2xl ${isCredit ? "bg-amber-400/10 text-amber-300" : "bg-violet-400/10 text-violet-300"}`}>{isCredit ? <CreditCard size={18}/> : item.kind === "debt" ? <HandCoins size={18}/> : <Target size={18}/>}</span><div className="min-w-0"><h3 className="truncate text-sm font-medium">{item.title}</h3>{showType && <p className="mt-0.5 text-[11px] text-zinc-500">{isCredit ? "Кредит" : "Долг"}</p>}</div></div><span className="text-xs text-zinc-500">{percent}%</span></div>{scheduled ? <><div className="mt-5 flex items-center gap-5"><div className="grid h-[82px] w-[82px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#f8bc6f ${percent}%, rgba(255,255,255,.08) 0)` }}><div className="grid h-[66px] w-[66px] place-items-center rounded-full bg-[#151519] text-center"><div><p className="text-[15px] font-semibold leading-none text-amber-200">{item.paidMonths}/{item.totalMonths}</p><p className="mt-1 text-[9px] text-zinc-500">месяцев</p></div></div></div><div className="min-w-0"><p className="text-[11px] text-zinc-500">Платёж в месяц</p><p className="mt-1 truncate text-lg font-semibold">{formatMoney(Number(item.monthlyPayment), item.currency)}</p><p className="mt-2 text-[11px] text-zinc-500">Осталось {formatMoney(Math.max(0, Number(item.amount) - Number(item.currentAmount)), item.currency)}</p></div></div><div className="mt-5 space-y-2 border-t border-white/6 pt-4 text-xs"><div className="flex items-center justify-between gap-2"><span className="text-zinc-500">Следующий платёж</span><span className="text-zinc-300">{formatDate(item.nextPaymentDate)}</span></div><div className="flex items-center justify-between gap-2"><span className="text-zinc-500">Полное погашение</span><span className="text-zinc-300">{formatDate(item.dueDate)}</span></div></div><p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-300/[.06] px-3 py-2 text-[11px] leading-4 text-amber-100/75"><Bell size={13} className="mt-0.5 shrink-0"/> Напомним за 7, 3 и 1 день. В дату платежа расход добавится автоматически.</p></> : <><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/5"><div className={`h-full rounded-full ${isCredit ? "bg-amber-300" : "bg-violet-400"}`} style={{ width: `${percent}%` }}/></div><div className="mt-2 flex justify-between text-[11px] text-zinc-500"><span>{formatMoney(Number(item.currentAmount), item.currency)}</span><span>{formatMoney(Number(item.amount), item.currency)}</span></div>{item.dueDate && <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500"><CalendarDays size={13}/> Крайний срок: {formatDate(item.dueDate)}</p>}</>}<div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-xs">{scheduled ? <span className="text-zinc-600">Прогресс по графику</span> : <button onClick={() => onProgress(item)} className="font-medium text-violet-300">Обновить сумму</button>}<button onClick={() => onDelete(item)} className="text-zinc-600 underline">Удалить</button></div></article>;
}
function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick(): void }) { return <button aria-current={active ? "page" : undefined} onClick={onClick} className={`flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[11px] focus-visible:outline-2 focus-visible:outline-violet-300 ${active ? "text-violet-300" : "text-zinc-500"}`}>{icon}<span>{label}</span></button>; }
async function apiError(response: Response) {
  try { const body = await response.json() as { error?: unknown }; if (typeof body.error === "string") return body.error; } catch { /* Empty error response. */ }
  return "Не удалось сохранить. Попробуйте ещё раз.";
}
function Settings({ name, presets, busy, onCreate, onDelete }: { name: string; presets: CategoryPreset[]; busy: boolean; onCreate(name: string, type: "income" | "expense"): Promise<boolean>; onDelete(item: CategoryPreset): void }) {
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"income" | "expense">("expense");
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (await onCreate(newName.trim(), newType)) setNewName(""); }
  return <section className="px-4"><h2 className="mb-1 text-2xl font-semibold">Профиль и настройки</h2><p className="mb-5 text-xs text-zinc-500">Сделайте свои категории быстрым выбором</p><div className="grid gap-4 lg:grid-cols-[minmax(0,.7fr)_minmax(0,1.3fr)]"><div className="rounded-3xl border border-white/8 bg-[#151519] p-5"><span className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-violet-700 text-lg font-bold">{name.slice(0, 1).toUpperCase()}</span><h3 className="mt-4 text-lg font-semibold">{name}</h3><p className="mt-1 text-xs leading-5 text-zinc-500">Личные записи доступны только вам внутри Telegram.</p><p className="mt-5 flex items-start gap-2 rounded-2xl bg-white/[.035] p-3 text-[11px] leading-5 text-zinc-400"><Clock3 size={15} className="mt-0.5 shrink-0 text-violet-300"/> Каждая новая операция сохраняется с датой и временем.</p></div><div className="rounded-3xl border border-white/8 bg-[#151519] p-5"><div className="flex items-center gap-2"><Settings2 size={18} className="text-violet-300"/><h3 className="font-semibold">Пресеты категорий</h3></div><p className="mt-2 text-xs leading-5 text-zinc-500">Добавьте часто используемые категории. Они сразу появятся при создании операции.</p><form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-2 sm:flex-row"><select aria-label="Тип категории" value={newType} onChange={(event) => setNewType(event.target.value as "income" | "expense")} className="rounded-2xl border border-white/8 bg-[#24242b] px-4 py-3 text-sm"><option value="expense">Расход</option><option value="income">Доход</option></select><input aria-label="Название категории" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={40} placeholder="Название категории" required className="min-w-0 flex-1 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-zinc-600"/><button disabled={busy} className="rounded-2xl bg-violet-500 px-4 py-3 text-sm font-semibold disabled:opacity-50">Добавить</button></form><div className="mt-6 space-y-5">{(["expense", "income"] as const).map((type) => <div key={type}><p className="mb-2 text-[11px] font-medium uppercase tracking-[.12em] text-zinc-500">{type === "expense" ? "Расходы" : "Доходы"}</p><div className="flex flex-wrap gap-2">{presets.filter((item) => item.type === type).length ? presets.filter((item) => item.type === type).map((item) => <div key={item.id} className="flex items-center gap-2 rounded-full border border-white/8 bg-white/5 py-2 pl-3 pr-2 text-xs text-zinc-300"><span>{item.name}</span><button aria-label={`Удалить пресет ${item.name}`} disabled={busy} onClick={() => onDelete(item)} className="grid h-5 w-5 place-items-center rounded-full text-zinc-600 hover:text-rose-300"><X size={12}/></button></div>) : <p className="text-xs text-zinc-600">Пока нет пресетов</p>}</div></div>)}</div></div></div></section>;
}
function ResetDataModal({ onClose, onReset }: { onClose(): void; onReset(): Promise<void> }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || confirmation !== "СБРОСИТЬ") return;
    setBusy(true);
    setError("");
    try {
      await onReset();
    } catch (cause) {
      setError(cause instanceof TypeError ? "Нет соединения. Проверьте интернет и попробуйте снова." : cause instanceof Error ? cause.message : "Не удалось сбросить данные. Попробуйте ещё раз.");
      setBusy(false);
    }
  }
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div role="dialog" aria-modal="true" aria-labelledby="reset-modal-title" aria-describedby="reset-modal-description" className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm md:items-center md:p-6" onKeyDown={handleKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form onSubmit={(event) => void submit(event)} className="w-full max-h-[92dvh] overflow-y-auto rounded-t-[32px] border border-rose-400/20 bg-[#19191f] p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl md:max-w-lg md:rounded-[28px] md:p-6">
      <div className="flex items-start justify-between gap-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-rose-400/10 text-rose-300"><Trash2 size={20}/></span><button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-white/5 text-zinc-400 disabled:opacity-50"><X size={18}/></button></div>
      <h3 id="reset-modal-title" className="mt-5 text-xl font-semibold">Сбросить все данные?</h3>
      <p id="reset-modal-description" className="mt-3 text-sm leading-6 text-zinc-400">Безвозвратно удалятся все операции — введённые вручную, импортированные и автоматически созданные платежи по кредитам. Также удалятся цели, долги, кредиты, будущие платежи и напоминания, пресеты категорий.</p>
      <p className="mt-3 rounded-2xl border border-rose-400/15 bg-rose-400/[.06] p-4 text-xs leading-5 text-rose-100/80">Telegram-профиль и доступ к боту останутся. Восстановить удалённые данные из приложения нельзя.</p>
      <label htmlFor="reset-confirmation" className="mt-6 block text-xs font-medium text-zinc-300">Для подтверждения введите <span className="font-bold text-rose-200">СБРОСИТЬ</span></label>
      <input id="reset-confirmation" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5 text-sm outline-none focus:border-rose-400/60 disabled:opacity-50"/>
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-rose-300">{error}</p>}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-2xl border border-white/10 px-5 py-3 text-sm text-zinc-300 disabled:opacity-50">Отмена</button><button type="submit" disabled={busy || confirmation !== "СБРОСИТЬ"} className="min-h-11 rounded-2xl bg-rose-500 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? "Удаляем…" : "Удалить все данные"}</button></div>
    </form>
  </div>;
}
function EntryModal({ kind, presets, defaultObligationKind, onClose, onSaved }: { kind: "transaction" | "obligation"; presets: CategoryPreset[]; defaultObligationKind: "goal" | "debt" | "credit"; onClose(): void; onSaved(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [type, setType] = useState<"income" | "expense">("expense");
  const [category, setCategory] = useState(presets.find((item) => item.type === "expense")?.name ?? "__other__");
  const [customCategory, setCustomCategory] = useState("");
  const [savePreset, setSavePreset] = useState(false);
  const [obligationType, setObligationType] = useState(defaultObligationKind);
  const [monthlyPayment, setMonthlyPayment] = useState("");
  const [totalMonths, setTotalMonths] = useState("");
  const [paidMonths, setPaidMonths] = useState("0");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  const available = presets.filter((item) => item.type === type);
  const isCredit = kind === "obligation" && obligationType === "credit";
  const computedFinal = finalPaymentDate(nextPaymentDate, Number(totalMonths) - Number(paidMonths));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const endpoint = kind === "transaction" ? "/api/transactions" : "/api/obligations";
    const payload = kind === "transaction"
      ? { ...values, type, category: category === "__other__" ? customCategory.trim() : category, saveCategoryPreset: category === "__other__" && savePreset }
      : isCredit
        ? { kind: "credit", title: values.title, currency: values.currency, monthlyPayment, totalMonths, paidMonths, nextPaymentDate }
        : { ...values, kind: obligationType };
    try {
      const response = await fetch(endpoint, { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
      if (!response.ok) { setError(await apiError(response)); return; }
      onSaved();
    } catch { setError("Нет соединения. Проверьте интернет и попробуйте снова."); }
    finally { setBusy(false); }
  }
  const obligationOptions = defaultObligationKind === "goal" ? [["goal", "Цель"]] : [["credit", "Кредит"], ["debt", "Долг"]];
  return <div role="dialog" aria-modal="true" aria-labelledby="entry-modal-title" className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 backdrop-blur-sm md:items-center md:p-6" onKeyDown={(event) => event.key === "Escape" && onClose()} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form onSubmit={submit} className="w-full max-h-[92dvh] overflow-y-auto rounded-t-[32px] border border-white/10 bg-[#19191f] p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl md:max-w-lg md:rounded-[28px] md:p-6">
      <div className="mb-5 flex items-center justify-between"><h3 id="entry-modal-title" className="text-lg font-semibold">{kind === "transaction" ? "Новая операция" : defaultObligationKind === "goal" ? "Новая цель" : "Новый долг или кредит"}</h3><button type="button" aria-label="Закрыть" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-white/5"><X size={18}/></button></div>
      {kind === "transaction" ? <>
        <div className="grid grid-cols-2 gap-2"><Select name="type" label="Тип операции" value={type} onChange={(event) => { const next = event.target.value as "income" | "expense"; setType(next); setCategory(presets.find((item) => item.type === next)?.name ?? "__other__"); setSavePreset(false); }} options={[["expense", "Расход"], ["income", "Доход"]]}/><Select name="currency" label="Валюта" options={[["KZT", "₸ KZT"], ["RUB", "₽ RUB"], ["USD", "$ USD"], ["EUR", "€ EUR"]]}/></div>
        <Input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="Сумма" required/>
        <div className="mt-5"><p className="text-xs font-medium text-zinc-400">Категория</p><div className="mt-2 flex flex-wrap gap-2">{available.map((item) => <button key={item.id} type="button" onClick={() => setCategory(item.name)} className={`rounded-full border px-3.5 py-2 text-xs ${category === item.name ? "border-violet-400/60 bg-violet-400/20 text-violet-200" : "border-white/8 bg-white/5 text-zinc-400"}`}>{item.name}</button>)}<button type="button" onClick={() => setCategory("__other__")} className={`rounded-full border px-3.5 py-2 text-xs ${category === "__other__" ? "border-violet-400/60 bg-violet-400/20 text-violet-200" : "border-white/8 bg-white/5 text-zinc-400"}`}>Другое</button></div>
          {category === "__other__" && <><Input name="customCategory" value={customCategory} onChange={(event) => setCustomCategory(event.target.value)} maxLength={48} placeholder="Напишите категорию" required/><label className="mt-3 flex items-center gap-2.5 text-xs text-zinc-400"><input type="checkbox" checked={savePreset} onChange={(event) => setSavePreset(event.target.checked)} className="h-4 w-4 accent-violet-500"/> Добавить пресет?</label></>}
          {!available.length && <p className="mt-2 text-[11px] text-zinc-600">Пресеты можно создать в настройках профиля.</p>}</div>
        <Input name="note" placeholder="Комментарий"/><p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-600"><Clock3 size={13}/> Дата и время запишутся автоматически</p>
      </> : <>
        <div className="grid grid-cols-2 gap-2"><Select name="kind" label="Тип записи" value={obligationType} onChange={(event) => setObligationType(event.target.value as "goal" | "debt" | "credit")} options={obligationOptions}/><Select name="currency" label="Валюта" options={[["KZT", "₸ KZT"], ["RUB", "₽ RUB"], ["USD", "$ USD"], ["EUR", "€ EUR"]]}/></div>
        <Input name="title" placeholder={isCredit ? "Название, например iPhone" : "Название"} maxLength={80} required/>
        {isCredit ? <><div className="mt-4 rounded-2xl border border-amber-300/10 bg-amber-300/[.04] p-4"><p className="text-xs font-medium text-amber-200">График рассрочки</p><p className="mt-1 text-[11px] leading-5 text-zinc-500">Укажите платёж, полный срок и сколько месяцев уже выплачено. Общую сумму и дату погашения посчитаем сами.</p></div><Input name="monthlyPayment" type="number" inputMode="decimal" min="0.01" step="0.01" value={monthlyPayment} onChange={(event) => setMonthlyPayment(event.target.value)} placeholder="Платёж в месяц" required/><div className="grid grid-cols-2 gap-2"><Input name="totalMonths" type="number" inputMode="numeric" min="1" max="360" step="1" value={totalMonths} onChange={(event) => setTotalMonths(event.target.value)} placeholder="Всего месяцев" required/><Input name="paidMonths" type="number" inputMode="numeric" min="0" max={Math.max(0, Number(totalMonths) - 1)} step="1" value={paidMonths} onChange={(event) => setPaidMonths(event.target.value)} placeholder="Уже выплачено" required/></div><label className="mt-4 block text-xs text-zinc-400">Дата следующего платежа<Input name="nextPaymentDate" type="date" min={todayInQyzylorda()} value={nextPaymentDate} onChange={(event) => setNextPaymentDate(event.target.value)} required/></label>{monthlyPayment && totalMonths && <div className="mt-4 rounded-2xl bg-white/[.035] p-4 text-xs"><div className="flex justify-between text-zinc-400"><span>Вся сумма</span><span className="text-zinc-200">{formatMoney(Number(monthlyPayment) * Number(totalMonths))}</span></div><div className="mt-2 flex justify-between text-zinc-400"><span>Выплачено</span><span className="text-zinc-200">{paidMonths || 0}/{totalMonths} мес.</span></div><div className="mt-2 flex justify-between text-zinc-400"><span>Полное погашение</span><span className="text-zinc-200">{computedFinal ? formatDate(computedFinal) : "Укажите дату"}</span></div></div>}<p className="mt-3 flex items-start gap-1.5 text-[11px] leading-4 text-zinc-500"><Bell size={13} className="mt-0.5 shrink-0"/> Напомним за 7, 3 и 1 день до каждого платежа. Даты считаются по Asia/Qyzylorda (UTC+5), расход будет датирован 00:00 дня платежа.</p></> : <><Input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="Общая сумма" required/><Input name="currentAmount" type="number" inputMode="decimal" min="0" step="0.01" placeholder={obligationType === "goal" ? "Уже накоплено" : "Уже выплачено"}/><label className="mt-4 block text-xs text-zinc-400">Крайняя дата (необязательно)<Input name="dueDate" type="date"/></label></>}
      </>}
      {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}<button disabled={busy} className="mt-5 w-full rounded-2xl bg-violet-500 py-3.5 text-sm font-semibold disabled:opacity-50">{busy ? "Сохраняем…" : "Сохранить"}</button>
    </form>
  </div>;
}
function ProgressModal({ item, onClose, onSaved }: { item: Obligation; onClose(): void; onSaved(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const value = new FormData(event.currentTarget).get("currentAmount");
    try {
      const response = await fetch(`/api/obligations/${item.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ currentAmount: value }) });
      if (!response.ok) { setError(await apiError(response)); return; }
      onSaved();
    } catch { setError("Нет соединения. Проверьте интернет и попробуйте снова."); }
    finally { setBusy(false); }
  }
  return <div role="dialog" aria-modal="true" aria-labelledby="progress-modal-title" className="fixed inset-0 z-40 flex items-end bg-black/70 backdrop-blur-sm" onKeyDown={(event) => event.key === "Escape" && onClose()} onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form onSubmit={submit} className="w-full rounded-t-[32px] border-t border-white/10 bg-[#19191f] p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"><div className="mb-4 flex items-center justify-between"><h3 id="progress-modal-title" className="text-lg font-semibold">{item.title}</h3><button type="button" aria-label="Закрыть" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-white/5"><X size={18}/></button></div><p className="mb-3 text-xs text-zinc-400">{item.kind === "goal" ? "Сколько уже накоплено" : "Сколько уже выплачено"} из {formatMoney(Number(item.amount), item.currency)}</p><Input name="currentAmount" type="number" inputMode="decimal" min="0" max={item.amount} step="0.01" defaultValue={Number(item.currentAmount)} placeholder="Текущая сумма" required/>{error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}<button disabled={busy} className="mt-4 w-full rounded-2xl bg-violet-500 py-3.5 text-sm font-semibold disabled:opacity-50">{busy ? "Сохраняем…" : "Сохранить"}</button></form></div>;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} aria-label={props["aria-label"] ?? props.placeholder ?? props.name} className="mt-2 w-full rounded-2xl border border-white/8 bg-white/5 px-4 py-3.5 text-sm outline-none placeholder:text-zinc-600 focus:border-violet-400/60"/>; }
function Select({ name, label, options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { name: string; label: string; options: string[][] }) { return <select name={name} aria-label={label} {...props} className="mt-2 w-full rounded-2xl border border-white/8 bg-[#24242b] px-4 py-3.5 text-sm outline-none focus:border-violet-400/60">{options.map(([value, optionLabel]) => <option key={value} value={value}>{optionLabel}</option>)}</select>; }
