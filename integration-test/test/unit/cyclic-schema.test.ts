import { expect, it } from "vitest";
import { SqliteAdapter } from "../../src/adapters/sqlite.js";
import { createContext } from "../../src/context.js";
import { verifyCyclicSchema } from "../../src/scenarios/cyclic-schema.js";
import type { IntegrationParameterization } from "../../src/types.js";

it.each<IntegrationParameterization>(["none", "literal-fallback", "throw-on-limit"])(
  "creates mutual SQLite FKs, joins valid rows, rejects missing targets in both directions, and cleans up: %s",
  async (mode) => {
    const database = new SqliteAdapter();
    await database.open();
    try {
      const context = createContext(database, mode);
      // Repeat to verify cleanup with FK enforcement enabled.
      await verifyCyclicSchema(context, { dialect: "sqlite" });
      await verifyCyclicSchema(context, { dialect: "sqlite" });
      const remaining = await database.execute({
        sql: "SELECT name FROM sqlite_master WHERE name IN ('SqyraCycleA','SqyraCycleB')",
        parameters: [],
      });
      expect(remaining.rows).toEqual([]);
    } finally {
      await database.close();
    }
  },
);
