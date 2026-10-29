import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  username: text("username"),
  baseCurrency: text("base_currency").notNull().default("KZT"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ["income", "expense"] }).notNull().default("expense"),
    icon: text("icon").notNull().default("circle"),
    color: text("color").notNull().default("#8b5cf6"),
  },
  (table) => [
    index("categories_user_idx").on(table.userId),
    uniqueIndex("categories_user_type_name_idx").on(table.userId, table.type, table.name),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    type: text("type", { enum: ["income", "expense"] }).notNull(),
    amount: real("amount").notNull(),
    currency: text("currency").notNull().default("KZT"),
    category: text("category").notNull(),
    note: text("note").notNull().default(""),
    importFingerprint: text("import_fingerprint"),
    telegramUpdateId: integer("telegram_update_id"),
    creditInstallmentId: integer("credit_installment_id"),
    happenedAt: integer("happened_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("transactions_user_date_idx").on(table.userId, table.happenedAt),
    index("transactions_user_type_idx").on(table.userId, table.type),
    uniqueIndex("transactions_telegram_update_idx").on(table.telegramUpdateId),
    uniqueIndex("transactions_credit_installment_idx").on(table.creditInstallmentId),
    uniqueIndex("transactions_user_import_fingerprint_idx").on(table.userId, table.importFingerprint),
  ],
);

// Telegram may retry a webhook after its transaction has been deleted by a
// financial reset. Keep only the update ID outside the resettable ledger.
export const telegramUpdateReceipts = sqliteTable("telegram_update_receipts", {
  updateId: integer("update_id").primaryKey(),
  userId: text("user_id").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }).notNull(),
});

export const obligations = sqliteTable(
  "obligations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["debt", "goal", "credit"] }).notNull(),
    title: text("title").notNull(),
    amount: real("amount").notNull(),
    currentAmount: real("current_amount").notNull().default(0),
    currency: text("currency").notNull().default("KZT"),
    dueDate: integer("due_date", { mode: "timestamp" }),
    monthlyPayment: real("monthly_payment"),
    totalMonths: integer("total_months"),
    paidMonths: integer("paid_months"),
    paymentDay: integer("payment_day"),
    nextPaymentDate: integer("next_payment_date", { mode: "timestamp" }),
    status: text("status", { enum: ["active", "done"] }).notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("obligations_user_kind_idx").on(table.userId, table.kind)],
);

export const creditInstallments = sqliteTable(
  "credit_installments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    obligationId: integer("obligation_id").notNull(),
    userId: text("user_id").notNull(),
    installmentNumber: integer("installment_number").notNull(),
    amount: real("amount").notNull(),
    currency: text("currency").notNull(),
    dueAt: integer("due_at", { mode: "timestamp" }).notNull(),
    postedAt: integer("posted_at", { mode: "timestamp" }),
    reminder7At: integer("reminder_7_at", { mode: "timestamp" }),
    reminder3At: integer("reminder_3_at", { mode: "timestamp" }),
    reminder1At: integer("reminder_1_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("credit_installments_obligation_number_idx").on(table.obligationId, table.installmentNumber),
    index("credit_installments_due_idx").on(table.dueAt, table.postedAt),
    index("credit_installments_user_idx").on(table.userId),
  ],
);
