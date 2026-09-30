import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { PostgresTransactionManager } from "../../src/adapters/postgres.js";

function createPool(options: {
  failOn?: string;
  rollbackError?: Error;
  beginError?: Error;
  commitError?: Error;
} = {}) {
  const queries: string[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  let checkoutCount = 0;
  let poolQueryCount = 0;
  const client = {
    query: async <Row extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<Row>> => {
      queries.push(text);
      const failure = text === "BEGIN" ? options.beginError
        : text === "COMMIT" ? options.commitError
          : text === "ROLLBACK" ? options.rollbackError
            : text === options.failOn ? new Error(`failed: ${text}`)
              : undefined;
      if (failure) throw failure;
      return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] };
    },
    release: (error?: Error | boolean) => { releases.push(error); },
  };
  const pool = {
    connect: async () => { checkoutCount += 1; return client; },
    query: async () => { poolQueryCount += 1; return { rows: [] }; },
  } as unknown as Pool;

  return { pool, client, queries, releases, get checkoutCount() { return checkoutCount; }, get poolQueryCount() { return poolQueryCount; } };
}

describe("PostgresTransactionManager lifecycle", () => {
  it("routes transactional queries through one checked-out client and releases it on success", async () => {
    const fixture = createPool();
    const transactions = new PostgresTransactionManager(fixture.pool);

    await transactions.run(async () => { await transactions.database.query("SELECT inside"); });
    await transactions.database.query("SELECT outside");

    expect(fixture.queries).toEqual(["BEGIN", "SELECT inside", "COMMIT"]);
    expect(fixture.poolQueryCount).toBe(1);
    expect(fixture.checkoutCount).toBe(1);
    expect(fixture.releases).toEqual([undefined]);
  });

  it("rejects nested runs before checking out another client", async () => {
    const fixture = createPool();
    const transactions = new PostgresTransactionManager(fixture.pool);

    await transactions.run(async () => {
      await expect(transactions.run(async () => undefined)).rejects.toThrow("Nested transactions are not supported.");
    });

    expect(fixture.checkoutCount).toBe(1);
    expect(fixture.queries).toEqual(["BEGIN", "COMMIT"]);
  });

  it("releases after BEGIN failure without running work", async () => {
    const beginError = new Error("begin failed");
    const fixture = createPool({ beginError });
    const work = async () => { throw new Error("work must not run"); };

    await expect(new PostgresTransactionManager(fixture.pool).run(work)).rejects.toBe(beginError);
    expect(fixture.queries).toEqual(["BEGIN"]);
    expect(fixture.releases).toEqual([beginError]);
  });

  it("preserves the work error when rollback succeeds", async () => {
    const fixture = createPool();
    const workError = new Error("work failed");

    await expect(new PostgresTransactionManager(fixture.pool).run(async () => { throw workError; })).rejects.toBe(workError);
    expect(fixture.queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(fixture.releases).toEqual([undefined]);
  });

  it("preserves the work error and exposes rollback failure while discarding the client", async () => {
    const rollbackError = new Error("rollback failed");
    const fixture = createPool({ rollbackError });
    const workError = new Error("work failed");

    await expect(new PostgresTransactionManager(fixture.pool).run(async () => { throw workError; })).rejects.toBe(workError);
    expect((workError as Error & { rollbackError: Error }).rollbackError).toBe(rollbackError);
    expect(fixture.releases).toEqual([rollbackError]);
  });

  it("preserves COMMIT failure, attempts rollback, and discards a client if cleanup fails", async () => {
    const commitError = new Error("commit outcome unknown");
    const rollbackError = new Error("rollback failed");
    const fixture = createPool({ commitError, rollbackError });

    await expect(new PostgresTransactionManager(fixture.pool).run(async () => undefined)).rejects.toBe(commitError);
    expect(fixture.queries).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect((commitError as Error & { rollbackError: Error }).rollbackError).toBe(rollbackError);
    expect(fixture.releases).toEqual([rollbackError]);
  });

  it("releases the client after COMMIT failure when rollback succeeds", async () => {
    const commitError = new Error("commit failed");
    const fixture = createPool({ commitError });

    await expect(new PostgresTransactionManager(fixture.pool).run(async () => undefined)).rejects.toBe(commitError);
    expect(fixture.queries).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(fixture.releases).toEqual([undefined]);
  });
});