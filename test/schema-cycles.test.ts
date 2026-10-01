import { describe, expect, it } from "vitest";
import {
  column,
  createColumnRef,
  defineTable,
  nullableColumn,
  schemaScript,
  sqlType,
  tableIndex,
  type GraphTable,
  type InlineExportOptions,
} from "../src/index.js";

const dialects: ReadonlyArray<InlineExportOptions> = [
  { dialect: "tsql" },
  { dialect: "pgsql", schemaMap: [{ from: "dbo", to: "public" }] },
  { dialect: "mysql", mysqlFlavor: "oracle" },
  { dialect: "mysql", mysqlFlavor: "mariadb" },
  { dialect: "sqlite" },
];
function pair() {
  const tables = new Map<string, GraphTable>();
  const make = (name: string, target: string) =>
    defineTable({
      schema: "dbo",
      name,
      columns: {
        Id: column(sqlType.int32, { primaryKey: true }),
        RefId: nullableColumn(sqlType.int32, {
          references: () => tables.get(target)!.$metadata.columns.Id!,
        }),
      },
    });
  const a = make("CycleA", "CycleB"),
    b = make("CycleB", "CycleA");
  tables.set("CycleA", a);
  tables.set("CycleB", b);
  return [a, b] as const;
}

describe("schema creation with cyclic foreign keys", () => {
  it.each(dialects)(
    "preserves both constraints and creates tables before deferred FKs: %j",
    (options) => {
      const [a, b] = pair();
      const sql = schemaScript([a, b]).create().toSql(options);
      expect((sql.match(/CREATE TABLE /g) ?? []).length).toBe(2);
      expect((sql.match(/FOREIGN KEY /g) ?? []).length).toBe(2);
      expect(sql).toContain("CycleA");
      expect(sql).toContain("CycleB");
      if (options.dialect === "sqlite") {
        expect(sql).not.toContain("ALTER TABLE");
        expect(sql).toBe(a.$script.create().toSql(options) + b.$script.create().toSql(options));
      } else {
        const statements = sql.split(";").filter(Boolean);
        expect(statements).toHaveLength(4);
        expect(statements[0]).toMatch(/^CREATE TABLE /);
        expect(statements[1]).toMatch(/^CREATE TABLE /);
        expect(statements.slice(0, 2).join(";")).not.toContain("FOREIGN KEY");
        expect(statements[2]).toMatch(/^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY /);
        expect(statements[3]).toMatch(/^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY /);
      }
      expect(schemaScript([b, a]).create().toSql(options)).toContain("FOREIGN KEY");
      expect(schemaScript([a, b]).create().toSql(options)).toBe(sql);
    },
  );

  it("preserves composite FKs and creates unique indexes before adding constraints", () => {
    const parent = defineTable({
      schema: "dbo",
      name: "Parent",
      columns: {
        X: column(sqlType.int32),
        Y: column(sqlType.int32),
      },
      indexes: (t) => [
        tableIndex([t.$metadata.columns.X!, t.$metadata.columns.Y!], { unique: true }),
      ],
    });
    const child = defineTable({
      schema: "dbo",
      name: "Child",
      columns: {
        X: column(sqlType.int32, { references: parent.X }),
        Y: column(sqlType.int32, { references: parent.Y }),
      },
    });
    const sql = schemaScript([child, parent]).create().toSql("pgsql");
    expect(sql.indexOf("CREATE UNIQUE INDEX")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    expect(sql).toContain('FOREIGN KEY ("X","Y") REFERENCES "dbo"."Parent"("X","Y")');
  });

  it("supports self references and empty schemas", () => {
    const self = defineTable({
      schema: "dbo",
      name: "Self",
      columns: {
        Id: column(sqlType.int32, { primaryKey: true }),
        Parent: nullableColumn(sqlType.int32, {
          references: () =>
            createColumnRef("Id", "Self", false, { database: null, schema: "dbo", table: "Self" }),
        }),
      },
    });
    expect(schemaScript([self]).create().toSql("tsql")).toContain(
      "ALTER TABLE [dbo].[Self] ADD CONSTRAINT",
    );
    expect(schemaScript([]).create().toSql("tsql")).toBe("");
  });

  it("groups mixed-case FK targets and resolves columns to canonical names", () => {
    const parent = defineTable({
      schema: "dbo",
      name: "Parent",
      columns: {
        X: column(sqlType.int32),
        Y: column(sqlType.int32),
      },
    });
    const child = defineTable({
      schema: "dbo",
      name: "Child",
      columns: {
        X: column(sqlType.int32, {
          references: createColumnRef("x", "parent", false, {
            database: null,
            schema: "DBO",
            table: "parent",
          }),
        }),
        Y: column(sqlType.int32, { references: parent.Y }),
      },
    });
    const sql = schemaScript([child, parent]).create().toSql("pgsql");
    expect((sql.match(/FOREIGN KEY/g) ?? []).length).toBe(1);
    expect(sql).toContain('FOREIGN KEY ("X","Y") REFERENCES "dbo"."Parent"("X","Y")');
  });

  it("rejects duplicate inputs, missing FK targets, missing columns, and physical-name collisions", () => {
    const [a, b] = pair();
    expect(() => schemaScript([a, a()])).toThrow("Duplicate schema table");
    expect(() => schemaScript([a]).create().toSql("tsql")).toThrow("not included in the schema");
    const missing = defineTable({
      schema: "dbo",
      name: "MissingColumn",
      columns: {
        Ref: column(sqlType.int32, {
          references: createColumnRef("Absent", "CycleB", false, {
            database: null,
            schema: "dbo",
            table: "CycleB",
          }),
        }),
      },
    });
    // Include both cyclic targets so the failure is the missing column.
    expect(() => schemaScript([a, b, missing]).create().toSql("tsql")).toThrow("CycleB.Absent");
    const other = defineTable({
      schema: "other",
      name: "CycleA",
      columns: { Id: column(sqlType.int32) },
    });
    expect(() => schemaScript([a, b, other]).create().toSql("sqlite")).toThrow(
      "Duplicate physical",
    );
    expect(() =>
      schemaScript([a, b, other])
        .create()
        .toSql({ dialect: "pgsql", schemaMap: [{ from: "other", to: "dbo" }] }),
    ).toThrow("Duplicate physical");
  });

  it("rejects nonphysical FK references and null input", () => {
    const invalid = defineTable({
      schema: "dbo",
      name: "Invalid",
      columns: {
        Ref: column(sqlType.int32, { references: createColumnRef("Id", "Unknown", false) }),
      },
    });
    expect(() => schemaScript([invalid]).create().toSql("tsql")).toThrow("physical table column");
    expect(() => schemaScript(null as unknown as GraphTable[])).toThrow("cannot be null");
    expect(() => schemaScript([null as unknown as GraphTable])).toThrow("cannot contain null");
  });
});
