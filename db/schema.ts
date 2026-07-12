import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const syncStates = sqliteTable("sync_states", {
  codeHash: text("code_hash").primaryKey(),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
