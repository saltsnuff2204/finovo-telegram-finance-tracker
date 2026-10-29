import { parseAmount } from "@/lib/validation";

type CalendarDate = { year: number; month: number; day: number };

export type CreditSchedule = {
  amount: number;
  currentAmount: number;
  monthlyPayment: number;
  totalMonths: number;
  paidMonths: number;
  paymentDay: number;
  nextPaymentDate: Date;
  dueDate: Date;
  installments: { installmentNumber: number; dueAt: Date; amount: number }[];
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function calendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== "string" || !/^(20\d\d|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day } : null;
}

function localToday(now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day") };
}

function localMidnight(date: CalendarDate): Date {
  // Asia/Qyzylorda is UTC+5. Store an instant, not a server-local wall-clock value.
  return new Date(Date.UTC(date.year, date.month - 1, date.day, -5));
}

function monthWithPaymentDay(first: CalendarDate, offset: number, paymentDay: number): CalendarDate {
  const firstOfMonth = new Date(Date.UTC(first.year, first.month - 1 + offset, 1));
  const year = firstOfMonth.getUTCFullYear();
  const month = firstOfMonth.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(paymentDay, lastDay) };
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed : null;
}

export function hasCreditScheduleFields(body: Record<string, unknown>): boolean {
  return ["monthlyPayment", "totalMonths", "paidMonths", "nextPaymentDate", "paymentDay"]
    .some((field) => field in body && body[field] !== "" && body[field] !== null);
}

export function buildCreditSchedule(body: Record<string, unknown>, now = new Date()): CreditSchedule | null {
  const monthlyPayment = parseAmount(body.monthlyPayment);
  const totalMonths = integer(body.totalMonths, 1, 360);
  const paidMonths = integer(body.paidMonths ?? 0, 0, 359);
  const first = calendarDate(body.nextPaymentDate);
  const paymentDay = integer(body.paymentDay ?? first?.day, 1, 31);
  if (!monthlyPayment || totalMonths === null || paidMonths === null || !first || paymentDay === null
    || paidMonths >= totalMonths) return null;

  const today = localToday(now);
  if (localMidnight(first).getTime() < localMidnight(today).getTime()) return null;

  const amount = roundMoney(monthlyPayment * totalMonths);
  if (amount > 1_000_000_000_000) return null;
  const installments = Array.from({ length: totalMonths - paidMonths }, (_, index) => {
    const date = index === 0 ? first : monthWithPaymentDay(first, index, paymentDay);
    return { installmentNumber: paidMonths + index + 1, dueAt: localMidnight(date), amount: monthlyPayment };
  });
  const dueDate = installments.at(-1)?.dueAt;
  if (!dueDate || dueDate.getUTCFullYear() > 2100) return null;
  return {
    amount,
    currentAmount: roundMoney(monthlyPayment * paidMonths),
    monthlyPayment,
    totalMonths,
    paidMonths,
    paymentDay,
    nextPaymentDate: installments[0].dueAt,
    dueDate,
    installments,
  };
}
