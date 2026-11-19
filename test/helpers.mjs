import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

/** D1 method/result shapes backed by real SQLite, never a network connection. */
export class SQLiteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(schema);
    this.failBatchAt = null;
  }

  prepare(sql) {
    return new SQLiteStatement(this, sql);
  }

  async batch(statements) {
    const failAt = this.failBatchAt;
    this.failBatchAt = null;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map((statement, index) => {
        if (index === failAt) throw new Error("Simulated database failure");
        return statement.execute();
      });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.sqlite.close();
  }
}

class SQLiteStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SQLiteStatement(this.db, this.sql, values);
  }

  execute() {
    const statement = this.db.sqlite.prepare(this.sql);
    if (statement.columns().length) {
      return { success: true, results: statement.all(...this.values), meta: { changes: 0 } };
    }
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async run() {
    return this.execute();
  }

  async all() {
    return this.execute();
  }

  async first(column) {
    const row = this.db.sqlite.prepare(this.sql).get(...this.values);
    return row ? (column === undefined ? row : row[column]) : null;
  }
}

export function createTestDb() {
  return new SQLiteD1();
}
