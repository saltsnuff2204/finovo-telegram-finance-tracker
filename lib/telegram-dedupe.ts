// These statements run inside D1 batches. Receipts contain no financial data
// and deliberately survive an account's financial reset.
export const insertTelegramTransactionSql = `INSERT INTO transactions
  (user_id, type, amount, currency, category, note, telegram_update_id, happened_at, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM telegram_update_receipts WHERE update_id = ?)
  ON CONFLICT(telegram_update_id) DO NOTHING`;

export const recordTelegramUpdateSql = `INSERT INTO telegram_update_receipts (update_id, user_id, processed_at)
  SELECT ?, ?, ? WHERE EXISTS
  (SELECT 1 FROM transactions WHERE telegram_update_id = ? AND user_id = ?)
  ON CONFLICT(update_id) DO NOTHING`;

export const preserveTelegramUpdatesSql = `INSERT INTO telegram_update_receipts (update_id, user_id, processed_at)
  SELECT telegram_update_id, user_id, created_at FROM transactions
  WHERE user_id = ? AND telegram_update_id IS NOT NULL
  ON CONFLICT(update_id) DO NOTHING`;
