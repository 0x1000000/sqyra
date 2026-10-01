import type { InlineExportOptions } from "sqyra";
import { defineIntegrationTables, recreateTables } from "../tables.js";
import type { Scenario } from "./types.js";
import { verifyCyclicSchema } from "./cyclic-schema.js";

export const createTablesScenario: Scenario = {
  source: "ScCreateTables",
  async run(context) {
    const tables = defineIntegrationTables(context.dialect);
    const options: InlineExportOptions = {
      dialect: context.database.dialect,
      ...(context.database.mysqlFlavor === undefined
        ? {}
        : { mysqlFlavor: context.database.mysqlFlavor }),
      ...(context.database.schemaMap === undefined
        ? {}
        : { schemaMap: context.database.schemaMap }),
    };
    await recreateTables(tables.ordered, context.database, options);
    await verifyCyclicSchema(context, options);
  },
};
