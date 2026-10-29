import { parseAmount, type Currency } from "./validation";

export type ParsedOperation = {
  type: "income" | "expense";
  amount: number;
  currency: Currency;
  category: string;
  note: string;
};

const categoryRules: Array<[string, RegExp]> = [
  ["Продукты", /продукт|магазин|магнум|small|еда|обед|ужин|завтрак/i],
  ["Транспорт", /такси|яндекс|uber|бензин|транспорт|автобус/i],
  ["Кафе", /кофе|кафе|ресторан|бар/i],
  ["Дом", /аренд|квартир|коммунал|ремонт|дом/i],
  ["Здоровье", /аптек|врач|медиц|анализ/i],
  ["Покупки", /одежд|обув|техник|покупк/i],
  ["Развлечения", /кино|игр|подписк|развлеч/i],
  ["Зарплата", /зарплат|аванс/i],
];

export function parseOperation(text: string): ParsedOperation | null {
  if (text.length > 500) return null;
  const cleaned = text.trim().replace(/[\s\u00a0\u202f]+/g, " ");
  const matches = [...cleaned.matchAll(/(?:^|\s)(\d{1,3}(?: \d{3})+|\d{1,12})(?:[.,]\d{1,2})?(?=\s|[₸₽$€]|$)/g)];
  const match = matches.at(-1);
  if (!match || match.index === undefined) return null;
  const rawAmount = match[0].trim();
  const amount = parseAmount(rawAmount.replace(/ (?=\d{3}(?:\D|$))/g, ""));
  if (amount === null) return null;

  const currencyRules: Array<[Currency, RegExp]> = [
    ["KZT", /(?:^|\s)(?:KZT|тенге)(?=\s|$)|₸/i],
    ["RUB", /(?:^|\s)(?:RUB|руб(?:лей|ля|ль)?)(?=\s|$)|₽/i],
    ["USD", /(?:^|\s)(?:USD|доллар(?:ов|а)?)(?=\s|$)|\$/i],
    ["EUR", /(?:^|\s)(?:EUR|евро)(?=\s|$)|€/i],
  ];
  const currencies = currencyRules.filter(([, rule]) => rule.test(cleaned));
  if (currencies.length > 1) return null;
  const currency = currencies[0]?.[0] ?? "KZT";
  const type = /^(?:\+|(?:доход|получил|зарплата|аванс)(?=\s|$))/i.test(cleaned) ? "income" : "expense";
  const category = categoryRules.find(([, rule]) => rule.test(cleaned))?.[0] ?? (type === "income" ? "Доход" : "Другое");
  const amountStart = match.index + match[0].length - match[0].trimStart().length;
  const withoutAmount = cleaned.slice(0, amountStart) + cleaned.slice(amountStart + rawAmount.length);
  const note = withoutAmount
    .replace(/^(\+|-|доход|расход|потратил|получил)\s*/i, "")
    .replace(/(?:^|\s)(?:KZT|RUB|USD|EUR|тенге|руб(?:лей|ля|ль)?|доллар(?:ов|а)?|евро)(?=\s|$)|[₸₽$€]/gi, " ")
    .trim().replace(/\s+/g, " ").slice(0, 160);
  return { type, amount, currency, category, note };
}
