import { describe, expect, it, vi } from "vitest";
import {
  AmbiguousForeignKeyBehavior,
  AmbiguousJoinPathBehavior,
  column,
  defineTable,
  nullableColumn,
  sqlType,
  tablesGraph,
  toSql,
  type GraphTable,
  type GraphForeignKeyRelationship,
  type TablesGraphJoinOptions,
} from "../src/index.js";

function ring(count: number): GraphTable[] {
  const tables: GraphTable[] = [];
  for (let i = 0; i < count; i++)
    tables.push(
      defineTable({
        schema: "dbo",
        name: `Cycle${i}`,
        columns: {
          Id: column(sqlType.int32, { primaryKey: true }),
          RefId: nullableColumn(sqlType.int32, {
            references: () => tables[(i + 1) % count]!.$metadata.columns.Id!,
          }),
        },
      }),
    );
  return tables;
}

describe("cyclic graph join safety", () => {
  it("keeps forward FK selection by default and can reject mutual relationships", () => {
    const [a, b] = ring(2) as [GraphTable, GraphTable];
    const graph = tablesGraph([a, b]);
    expect(toSql(graph.toJoinTables(a("a"), b("b")), "tsql")).toContain("[a].[RefId]=[b].[Id]");
    expect(toSql(graph.toJoinTables(b("b"), a("a")), "tsql")).toContain("[b].[RefId]=[a].[Id]");
    const fail = { ambiguousForeignKeyBehavior: AmbiguousForeignKeyBehavior.Fail };
    expect(graph.tryToJoinTables(a, b, fail)).toBe(null);
    expect(graph.tryToJoinTables([a, b], fail)).toBe(null);
    expect(() => graph.toJoinTables(a, b, fail)).toThrow("No join path");
    // Opposing FK relationships do not constitute two different table paths.
    expect(
      graph.tryToJoinTables(a, b, { ambiguousPathBehavior: AmbiguousJoinPathBehavior.Fail }),
    ).not.toBe(null);
  });

  it("lets a callback select either FK, with canonical tables and immutable column pairs", () => {
    const [a, b] = ring(2) as [GraphTable, GraphTable];
    const graph = tablesGraph([a, b]);
    let candidates: ReadonlyArray<GraphForeignKeyRelationship> = [];
    const options: TablesGraphJoinOptions = {
      ambiguousForeignKeyBehavior: AmbiguousForeignKeyBehavior.Callback,
      ambiguousForeignKeyResolver: (relationships) => {
        candidates = relationships;
        return 1;
      },
    };
    expect(toSql(graph.toJoinTables(a("a"), b("b"), options), "tsql")).toContain(
      "[b].[RefId]=[a].[Id]",
    );
    expect(candidates.map((c) => [c.source, c.target, c.columnPairs])).toEqual([
      [a, b, [{ source: "RefId", target: "Id" }]],
      [b, a, [{ source: "RefId", target: "Id" }]],
    ]);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
    expect(Object.isFrozen(candidates[0]!.columnPairs[0])).toBe(true);
    expect(toSql(graph.toJoinTables([a("a"), b("b")], options), "tsql")).toContain(
      "[b].[RefId]=[a].[Id]",
    );
    expect(
      toSql(
        graph.toJoinTables(a("a"), b("b"), { ...options, ambiguousForeignKeyResolver: () => 0 }),
        "tsql",
      ),
    ).toContain("[a].[RefId]=[b].[Id]");
  });

  it("validates FK callback configuration and indices", () => {
    const [a, b] = ring(2) as [GraphTable, GraphTable];
    const graph = tablesGraph([a, b]);
    expect(() =>
      graph.toJoinTables(a, b, {
        ambiguousForeignKeyBehavior: "bad",
      } as unknown as TablesGraphJoinOptions),
    ).toThrow("Invalid ambiguous foreign key");
    expect(() =>
      graph.toJoinTables(a, b, {
        ambiguousForeignKeyBehavior: AmbiguousForeignKeyBehavior.Callback,
      }),
    ).toThrow("resolver is required");
    for (const index of [-1, 2, NaN, 0.5])
      expect(() =>
        graph.toJoinTables(a, b, {
          ambiguousForeignKeyBehavior: AmbiguousForeignKeyBehavior.Callback,
          ambiguousForeignKeyResolver: () => index,
        }),
      ).toThrow("invalid candidate index");
  });

  it("terminates navigation, handles equal routes, and builds a spanning join tree", () => {
    const tables = ring(4);
    const graph = tablesGraph(tables);
    expect([...graph.getAllReferences(tables[0]!)]).toEqual([
      tables[1],
      tables[2],
      tables[3],
      tables[0],
    ]);
    expect([...graph.getAllReferencedBy(tables[0]!)]).toEqual([
      tables[3],
      tables[2],
      tables[1],
      tables[0],
    ]);
    expect(
      graph.tryToJoinTables(tables[0]!, tables[2]!, {
        ambiguousPathBehavior: AmbiguousJoinPathBehavior.Fail,
      }),
    ).toBe(null);
    const resolver = vi.fn(() => 1);
    expect(
      toSql(
        graph.toJoinTables(tables[0]!, tables[2]!, {
          ambiguousPathBehavior: AmbiguousJoinPathBehavior.Callback,
          ambiguousPathResolver: resolver,
        }),
        "tsql",
      ),
    ).toContain("[dbo].[Cycle3]");
    expect(resolver.mock.calls.length).toBe(1);
    expect((toSql(graph.toJoinTables(tables), "tsql").match(/ JOIN /g) ?? []).length).toBe(3);
  });

  it("reconstructs a long cyclic path without recursion", () => {
    const tables = ring(600);
    const graph = tablesGraph(tables);
    let joined = graph.toJoinTables(tables[0]!, tables[300]!);
    let joins = 0;
    while (joined.kind === "ExprJoinedTable") {
      joins++;
      joined = joined.left;
    }
    expect(joins).toBe(300);
  });

  it("stops a large cyclic search with a clear work-limit error, not a stack overflow", () => {
    const tables = ring(16_000);
    const graph = tablesGraph(tables);
    expect(() => graph.tryToJoinTables(tables[0]!, tables[8_000]!)).toThrow(
      "work limit (10,000 steps)",
    );
    expect(() => graph.toJoinTables(tables[0]!, tables[8_000]!)).toThrow(
      "work limit (10,000 steps)",
    );
    // A failed request does not use up the budget for later requests.
    expect(graph.tryToJoinTables(tables[0]!, tables[1]!)).not.toBe(null);
  });

  it("bounds candidate enumeration without handing a partial list to the callback", () => {
    const root = defineTable({
      schema: "dbo",
      name: "Root",
      columns: { Id: column(sqlType.int32) },
    });
    let previous: GraphTable[] = [root];
    const all: GraphTable[] = [root];
    for (let layer = 0; layer < 12; layer++) {
      const parents = previous;
      previous = [0, 1].map((i) =>
        defineTable({
          schema: "dbo",
          name: `Layer${layer}_${i}`,
          columns: {
            Id: column(sqlType.int32),
            ParentId: column(sqlType.int32, {
              references: parents.map((t) => t.$metadata.columns.Id!),
            }),
          },
        }),
      );
      all.push(...previous);
    }
    const graph = tablesGraph(all);
    const resolver = vi.fn(() => 0);
    expect(() =>
      graph.toJoinTables(root, previous[0]!, {
        ambiguousPathBehavior: AmbiguousJoinPathBehavior.Callback,
        ambiguousPathResolver: resolver,
      }),
    ).toThrow("work limit");
    expect(resolver).not.toHaveBeenCalled();
    expect(graph.tryToJoinTables(root, previous[0]!)).not.toBe(null);
    expect(
      graph.tryToJoinTables(root, previous[0]!, {
        ambiguousPathBehavior: AmbiguousJoinPathBehavior.Fail,
      }),
    ).toBe(null);
  });

  it("shares the budget across checkpoints and across multi-table join searches", () => {
    const tables = ring(900);
    const graph = tablesGraph(tables);
    expect(graph.tryToJoinTables(tables[0]!, tables[1]!)).not.toBe(null);
    expect(() => graph.toJoinTables(tables[0]!, tables[899]!, tables.slice(1, 899))).toThrow(
      "work limit",
    );
    expect(() => graph.toJoinTables(tables)).toThrow("work limit");
  });
});
