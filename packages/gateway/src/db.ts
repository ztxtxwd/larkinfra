import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export type EventStatus =
  | "pending"
  | "routed"
  | "acked"
  | "failed"
  | "dropped";

type SqlValue = null | boolean | number | string;

export interface UserRemarkRow {
  user_id: string;
  remark: string;
  updated_at: string;
}

export interface UserTagRow {
  user_id: string;
  tag: string;
  updated_at: string;
}

export interface TraceStore {
  insertHttpRequest(row: {
    traceId: string;
    appId?: string;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    requestSnippet?: string;
    responseSnippet?: string;
  }): Promise<void>;
  insertEvent(row: {
    traceId: string;
    appId: string;
    eventType?: string;
    userId?: string;
    instanceId?: string;
    status: EventStatus;
    payload?: string;
    error?: string;
  }): Promise<void>;
  updateEvent(
    traceId: string,
    patch: {
      instanceId?: string;
      status?: EventStatus;
      routedAt?: boolean;
      ackedAt?: boolean;
      error?: string;
    },
  ): Promise<void>;
  queryEvents(params: {
    userId?: string;
    eventType?: string;
    limit: number;
    offset: number;
  }): Promise<unknown[]>;
  queryHttp(params: {
    path?: string;
    limit: number;
    offset: number;
  }): Promise<unknown[]>;
  listUserRemarks(): Promise<UserRemarkRow[]>;
  getUserRemark(userId: string): Promise<UserRemarkRow | null>;
  upsertUserRemark(userId: string, remark: string): Promise<UserRemarkRow>;
  deleteUserRemark(userId: string): Promise<boolean>;
  listUserTags(): Promise<UserTagRow[]>;
  getUserTag(userId: string): Promise<UserTagRow | null>;
  upsertUserTag(userId: string, tag: string): Promise<UserTagRow>;
  deleteUserTag(userId: string): Promise<boolean>;
  close(): Promise<void>;
}

async function runSql(
  conn: DuckDBConnection,
  sql: string,
  values?: SqlValue[],
) {
  // DuckDBValue is not re-exported; cast at the boundary.
  return conn.run(sql, values as never);
}

export async function openTraceStore(dbPath: string): Promise<TraceStore> {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const instance = await DuckDBInstance.create(dbPath);
  const conn: DuckDBConnection = await instance.connect();

  await conn.run(`
    CREATE TABLE IF NOT EXISTS http_requests (
      trace_id VARCHAR,
      app_id VARCHAR,
      method VARCHAR,
      path VARCHAR,
      status_code INTEGER,
      duration_ms DOUBLE,
      request_snippet VARCHAR,
      response_snippet VARCHAR,
      created_at TIMESTAMP DEFAULT current_timestamp
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS events (
      trace_id VARCHAR,
      app_id VARCHAR,
      event_type VARCHAR,
      user_id VARCHAR,
      instance_id VARCHAR,
      status VARCHAR,
      payload VARCHAR,
      error VARCHAR,
      received_at TIMESTAMP DEFAULT current_timestamp,
      routed_at TIMESTAMP,
      acked_at TIMESTAMP
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS user_remarks (
      user_id VARCHAR PRIMARY KEY,
      remark VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT current_timestamp
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS user_tags (
      user_id VARCHAR PRIMARY KEY,
      tag VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT current_timestamp
    )
  `);

  return {
    async insertHttpRequest(row) {
      await runSql(
        conn,
        `INSERT INTO http_requests
          (trace_id, app_id, method, path, status_code, duration_ms, request_snippet, response_snippet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.traceId,
          row.appId ?? null,
          row.method,
          row.path,
          row.statusCode,
          row.durationMs,
          row.requestSnippet ?? null,
          row.responseSnippet ?? null,
        ],
      );
    },
    async insertEvent(row) {
      await runSql(
        conn,
        `INSERT INTO events
          (trace_id, app_id, event_type, user_id, instance_id, status, payload, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.traceId,
          row.appId,
          row.eventType ?? null,
          row.userId ?? null,
          row.instanceId ?? null,
          row.status,
          row.payload ?? null,
          row.error ?? null,
        ],
      );
    },
    async updateEvent(traceId, patch) {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.instanceId !== undefined) {
        sets.push(`instance_id = $${params.length + 1}`);
        params.push(patch.instanceId);
      }
      if (patch.status !== undefined) {
        sets.push(`status = $${params.length + 1}`);
        params.push(patch.status);
      }
      if (patch.error !== undefined) {
        sets.push(`error = $${params.length + 1}`);
        params.push(patch.error);
      }
      if (patch.routedAt) sets.push("routed_at = current_timestamp");
      if (patch.ackedAt) sets.push("acked_at = current_timestamp");
      if (sets.length === 0) return;
      params.push(traceId);
      await runSql(
        conn,
        `UPDATE events SET ${sets.join(", ")} WHERE trace_id = $${params.length}`,
        params,
      );
    },
    async queryEvents(params) {
      const where: string[] = [];
      const args: SqlValue[] = [];
      if (params.userId) {
        where.push(`user_id = $${args.length + 1}`);
        args.push(params.userId);
      }
      if (params.eventType) {
        where.push(`event_type = $${args.length + 1}`);
        args.push(params.eventType);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      args.push(params.limit, params.offset);
      const result = await runSql(
        conn,
        `SELECT * FROM events ${clause} ORDER BY received_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
      );
      return result.getRowObjectsJson();
    },
    async queryHttp(params) {
      const where: string[] = [];
      const args: SqlValue[] = [];
      if (params.path) {
        where.push(`path LIKE $${args.length + 1}`);
        args.push(`%${params.path}%`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      args.push(params.limit, params.offset);
      const result = await runSql(
        conn,
        `SELECT * FROM http_requests ${clause} ORDER BY created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
      );
      return result.getRowObjectsJson();
    },
    async listUserRemarks() {
      const result = await runSql(
        conn,
        `SELECT user_id, remark, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_remarks
         ORDER BY updated_at DESC`,
      );
      return (await result.getRowObjectsJson()) as unknown as UserRemarkRow[];
    },
    async getUserRemark(userId) {
      const result = await runSql(
        conn,
        `SELECT user_id, remark, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_remarks
         WHERE user_id = $1
         LIMIT 1`,
        [userId],
      );
      const rows = (await result.getRowObjectsJson()) as unknown as UserRemarkRow[];
      return rows[0] ?? null;
    },
    async upsertUserRemark(userId, remark) {
      await runSql(conn, `DELETE FROM user_remarks WHERE user_id = $1`, [
        userId,
      ]);
      await runSql(
        conn,
        `INSERT INTO user_remarks (user_id, remark) VALUES ($1, $2)`,
        [userId, remark],
      );
      const result = await runSql(
        conn,
        `SELECT user_id, remark, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_remarks
         WHERE user_id = $1
         LIMIT 1`,
        [userId],
      );
      const rows = (await result.getRowObjectsJson()) as unknown as UserRemarkRow[];
      const row = rows[0];
      if (!row) {
        throw new Error(`failed to upsert remark for ${userId}`);
      }
      return row;
    },
    async deleteUserRemark(userId) {
      const result = await runSql(
        conn,
        `SELECT user_id FROM user_remarks WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const rows = await result.getRowObjectsJson();
      if (rows.length === 0) return false;
      await runSql(conn, `DELETE FROM user_remarks WHERE user_id = $1`, [
        userId,
      ]);
      return true;
    },
    async listUserTags() {
      const result = await runSql(
        conn,
        `SELECT user_id, tag, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_tags
         ORDER BY updated_at DESC`,
      );
      return (await result.getRowObjectsJson()) as unknown as UserTagRow[];
    },
    async getUserTag(userId) {
      const result = await runSql(
        conn,
        `SELECT user_id, tag, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_tags
         WHERE user_id = $1
         LIMIT 1`,
        [userId],
      );
      const rows = (await result.getRowObjectsJson()) as unknown as UserTagRow[];
      return rows[0] ?? null;
    },
    async upsertUserTag(userId, tag) {
      await runSql(conn, `DELETE FROM user_tags WHERE user_id = $1`, [userId]);
      await runSql(conn, `INSERT INTO user_tags (user_id, tag) VALUES ($1, $2)`, [
        userId,
        tag,
      ]);
      const result = await runSql(
        conn,
        `SELECT user_id, tag, CAST(updated_at AS VARCHAR) AS updated_at
         FROM user_tags
         WHERE user_id = $1
         LIMIT 1`,
        [userId],
      );
      const rows = (await result.getRowObjectsJson()) as unknown as UserTagRow[];
      const row = rows[0];
      if (!row) {
        throw new Error(`failed to upsert tag for ${userId}`);
      }
      return row;
    },
    async deleteUserTag(userId) {
      const result = await runSql(
        conn,
        `SELECT user_id FROM user_tags WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const rows = await result.getRowObjectsJson();
      if (rows.length === 0) return false;
      await runSql(conn, `DELETE FROM user_tags WHERE user_id = $1`, [userId]);
      return true;
    },
    async close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
