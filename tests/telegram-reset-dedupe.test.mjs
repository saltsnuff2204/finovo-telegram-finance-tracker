import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  insertTelegramTransactionSql,
  preserveTelegramUpdatesSql,
  recordTelegramUpdateSql,
} from "../lib/telegram-dedupe.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE transactions (
    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL, category TEXT NOT NULL,
    note TEXT NOT NULL, telegram_update_id INTEGER UNIQUE,
    happened_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  // Exercise the generated migration, not a second handwritten receipt schema.
  db.exec(readFileSync(new URL("../drizzle/0004_free_revanche.sql", import.meta.url), "utf8"));
  return db;
}

function deliver(db, userId, updateId) {
  db.exec("BEGIN");
  try {
    const inserted = db.prepare(insertTelegramTransactionSql).run(
      userId, "expense", 100, "KZT", "Тест", "", updateId, 1000, 1000, updateId,
    ).changes;
    db.prepare(recordTelegramUpdateSql).run(updateId, userId, 1000, updateId, userId);
    db.exec("COMMIT");
    return inserted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reset(db, userId) {
  db.exec("BEGIN");
  try {
    db.prepare(preserveTelegramUpdatesSql).run(userId);
    db.prepare("DELETE FROM transactions WHERE user_id = ?").run(userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("a Telegram webhook retry cannot restore an operation after reset", () => {
  const db = database();
  try {
    assert.equal(deliver(db, "101", 8001), 1);
    assert.equal(deliver(db, "101", 8001), 0);
    reset(db, "101");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM telegram_update_receipts").get().count, 1);
    assert.equal(deliver(db, "101", 8001), 0);
    assert.equal(deliver(db, "101", 8002), 1);
  } finally {
    db.close();
  }
});

test("reset backfills pre-migration Telegram IDs for one user only", () => {
  const db = database();
  try {
    const legacy = db.prepare(`INSERT INTO transactions
      (user_id, type, amount, currency, category, note, telegram_update_id, happened_at, created_at)
      VALUES (?, 'income', 50, 'KZT', 'Тест', '', ?, 1000, 1000)`);
    legacy.run("101", 9001);
    legacy.run("202", 9002);
    reset(db, "101");
    assert.deepEqual(db.prepare("SELECT update_id, user_id FROM telegram_update_receipts").all().map((row) => ({ ...row })), [
      { update_id: 9001, user_id: "101" },
    ]);
    assert.deepEqual(db.prepare("SELECT user_id, telegram_update_id FROM transactions").all().map((row) => ({ ...row })), [
      { user_id: "202", telegram_update_id: 9002 },
    ]);
    assert.equal(deliver(db, "101", 9001), 0);
    assert.equal(deliver(db, "202", 9002), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM telegram_update_receipts").get().count, 2);
  } finally {
    db.close();
  }
});
