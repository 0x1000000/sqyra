import {
  column,
  defineTable,
  nullableColumn,
  schemaScript,
  select,
  sqlType,
  tablesGraph,
  type ColumnRef,
  type InlineExportOptions,
} from "sqyra";
import type { ScenarioContext } from "../types.js";

/** Exercises schema creation and constraint enforcement in ScCreateTables on every dialect. */
export async function verifyCyclicSchema(
  context: ScenarioContext,
  options: InlineExportOptions,
): Promise<void> {
  if (options.dialect === "sqlite")
    await context.database.executeScript("PRAGMA foreign_keys = ON");
  const a = defineTable({
    schema: "dbo",
    name: "SqyraCycleA",
    columns: {
      Id: column(sqlType.int32, { primaryKey: true }),
      RefId: nullableColumn(sqlType.int32, {
        references: (): ColumnRef<"Id", number, false, "SqyraCycleB"> => b.Id,
      }),
    },
  });
  const b = defineTable({
    schema: "dbo",
    name: "SqyraCycleB",
    columns: {
      Id: column(sqlType.int32, { primaryKey: true }),
      RefId: nullableColumn(sqlType.int32, { references: a.Id }),
    },
  });
  const quote = (name: string) =>
    options.dialect === "tsql"
      ? `[${name}]`
      : options.dialect === "mysql"
        ? `\`${name}\``
        : `"${name}"`;
  const schema = context.database.schemaMap?.find((item) => item.from === "dbo")?.to ?? "dbo";
  const prefix =
    options.dialect === "mysql" || options.dialect === "sqlite" || schema === ""
      ? ""
      : `${quote(schema)}.`;
  const aName = `${prefix}${quote("SqyraCycleA")}`;
  const bName = `${prefix}${quote("SqyraCycleB")}`;
  const exec = (sql: string) => context.database.executeScript(sql);
  const cleanup = async () => {
    if (options.dialect === "mysql") {
      await exec("SET FOREIGN_KEY_CHECKS = 0");
      try {
        await exec(b.$script.dropIfExists().toSql(options));
        await exec(a.$script.dropIfExists().toSql(options));
      } finally {
        await exec("SET FOREIGN_KEY_CHECKS = 1");
      }
      return;
    }
    for (const [physical, source, target] of [
      [aName, "SqyraCycleA", "SqyraCycleB"],
      [bName, "SqyraCycleB", "SqyraCycleA"],
    ] as const) {
      const constraint = `FK_${schema}__${source}_to_${schema}__${target}`;
      if (options.dialect === "tsql")
        await exec(
          `IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = '${constraint}' AND parent_object_id = OBJECT_ID('${physical}')) ALTER TABLE ${physical} DROP CONSTRAINT ${quote(constraint)}`,
        );
      else if (options.dialect === "pgsql")
        await exec(
          `ALTER TABLE IF EXISTS ${physical} DROP CONSTRAINT IF EXISTS ${quote(constraint)}`,
        );
    }
    // Remove the data cycle before dropping SQLite tables with FK enforcement enabled.
    if (options.dialect === "sqlite") {
      // A previous interrupted run may have left either table absent.
      const result = await context.database.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('SqyraCycleA','SqyraCycleB')",
        parameters: [],
      });
      for (const row of result.rows)
        await exec(`UPDATE ${quote(String(row.name))} SET ${quote("RefId")} = NULL`);
    }
    await exec(b.$script.dropIfExists().toSql(options));
    await exec(a.$script.dropIfExists().toSql(options));
  };
  await cleanup();
  try {
    await exec(schemaScript([a, b]).create().toSql(options));
    await exec(`INSERT INTO ${aName} (${quote("Id")},${quote("RefId")}) VALUES (1,NULL)`);
    await exec(`INSERT INTO ${bName} (${quote("Id")},${quote("RefId")}) VALUES (2,1)`);
    await exec(`UPDATE ${aName} SET ${quote("RefId")} = 2 WHERE ${quote("Id")} = 1`);
    const graph = tablesGraph([a, b]);
    const left = a("a"),
      right = b("b");
    const rows = await context.query(
      select({ AId: left.Id, BId: right.Id }).from(graph.toJoinTables(left, right)),
    );
    if (rows.length !== 1 || Number(rows[0]!.AId) !== 1 || Number(rows[0]!.BId) !== 2)
      throw new Error("Cyclic-schema join did not return both related rows.");
    for (const physical of [aName, bName]) {
      let rejected = false;
      try {
        await exec(`INSERT INTO ${physical} (${quote("Id")},${quote("RefId")}) VALUES (3,999)`);
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
        const number = error instanceof Error ? Reflect.get(error, "number") : undefined;
        if (
          code !== "23503" &&
          code !== "ER_NO_REFERENCED_ROW_2" &&
          code !== "SQLITE_CONSTRAINT_FOREIGNKEY" &&
          number !== 547
        )
          throw error;
        rejected = true;
      }
      if (!rejected)
        throw new Error(`Cyclic foreign key on ${physical} did not reject a missing target.`);
    }
  } finally {
    await cleanup();
  }
}
