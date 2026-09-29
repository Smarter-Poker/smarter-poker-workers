/**
 * In-memory stand-in for the PostgREST client, for Phase 6 tests and the
 * zero-write sample harness. It is deliberately strict where production is:
 *
 * - every response is clamped to `maxRows` (PostgREST db-max-rows = 1000);
 * - social_posts rejects a publication_key COLUMN on a non-video_library row
 *   with 23514 (social_posts_managed_library_integrity_check);
 * - social_posts and social_page_posts reject a repeated
 *   metadata->>publication_key with 23505 (the lead's unique expression
 *   indexes uq_social_posts_metadata_publication_key and
 *   uq_social_page_posts_metadata_publication_key).
 *
 * Not a production module: only tests and zz-harness import it.
 */
export type Row = Record<string, unknown>;

export interface FakeError {
  message: string;
  code?: string;
}

export type FakeOp = 'select' | 'insert' | 'delete' | 'count';

export interface FakeCall {
  table: string;
  op: FakeOp;
  filters: string[];
  payload?: Row[];
  range?: [number, number];
  returned: number;
}

interface FailureRule {
  table: string;
  op: FakeOp;
  error: FakeError;
  times: number;
  match?: (call: FakeCall) => boolean;
}

type Result = { data: unknown; error: FakeError | null; count: number | null };

function columnValue(row: Row, column: string): unknown {
  const json = column.match(/^(\w+)->>(\w+)$/);
  if (json) {
    const holder = row[json[1]!];
    if (!holder || typeof holder !== 'object') return null;
    const value = (holder as Row)[json[2]!];
    return value === undefined || value === null ? null : String(value);
  }
  return row[column] === undefined ? null : row[column];
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

const UNIQUE_METADATA_KEY: Record<string, string> = {
  social_posts: 'uq_social_posts_metadata_publication_key',
  social_page_posts: 'uq_social_page_posts_metadata_publication_key',
};

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  readonly calls: FakeCall[] = [];
  private readonly rules: FailureRule[] = [];
  private nextId = 1;

  constructor(readonly maxRows = 1000) {}

  seed(table: string, rows: Row[]): this {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map((row) => ({ ...row }))]);
    return this;
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** Make the next `times` matching operations fail with `error`. */
  fail(table: string, op: FakeOp, error: FakeError, times = Infinity, match?: (call: FakeCall) => boolean): this {
    this.rules.push({ table, op, error, times, match });
    return this;
  }

  inserts(table?: string): Row[] {
    return this.calls.filter((call) => call.op === 'insert' && (!table || call.table === table)).flatMap((call) => call.payload ?? []);
  }

  writes(): FakeCall[] {
    return this.calls.filter((call) => call.op === 'insert' || call.op === 'delete');
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  /** @internal */
  injected(call: FakeCall): FakeError | null {
    for (const rule of this.rules) {
      if (rule.times <= 0 || rule.table !== call.table || rule.op !== call.op) continue;
      if (rule.match && !rule.match(call)) continue;
      rule.times -= 1;
      return rule.error;
    }
    return null;
  }

  /** @internal */
  insertRows(table: string, payload: Row[]): { rows: Row[]; error: FakeError | null } {
    const existing = this.tables.get(table) ?? [];
    const staged: Row[] = [];
    for (const input of payload) {
      const row: Row = { ...input };
      if (table === 'social_posts' && row.publication_key !== undefined && row.publication_key !== null
        && (row.origin_type ?? 'user_upload') !== 'video_library') {
        return {
          rows: [],
          error: {
            code: '23514',
            message: 'new row for relation "social_posts" violates check constraint "social_posts_managed_library_integrity_check"',
          },
        };
      }
      const uniqueIndex = UNIQUE_METADATA_KEY[table];
      const key = columnValue(row, 'metadata->>publication_key');
      if (uniqueIndex && key !== null
        && [...existing, ...staged].some((other) => columnValue(other, 'metadata->>publication_key') === key)) {
        return {
          rows: [],
          error: { code: '23505', message: `duplicate key value violates unique constraint "${uniqueIndex}"` },
        };
      }
      row.id ??= `fake-${table}-${this.nextId++}`;
      row.created_at ??= new Date().toISOString();
      staged.push(row);
    }
    this.tables.set(table, [...existing, ...staged]);
    return { rows: staged, error: null };
  }

  /** @internal */
  deleteRows(table: string, keep: (row: Row) => boolean): Row[] {
    const existing = this.tables.get(table) ?? [];
    const removed = existing.filter((row) => !keep(row));
    this.tables.set(table, existing.filter(keep));
    return removed;
  }
}

export class FakeQuery implements PromiseLike<Result> {
  private op: FakeOp = 'select';
  private readonly filters: Array<{ label: string; test: (row: Row) => boolean }> = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private payload: Row[] = [];
  private returning = false;
  private head = false;
  private countExact = false;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitRows: number | null = null;
  private single = false;

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (this.op === 'insert' || this.op === 'delete') this.returning = true;
    if (options?.count === 'exact') this.countExact = true;
    if (options?.head) this.head = true;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  private where(label: string, test: (row: Row) => boolean): this {
    this.filters.push({ label, test });
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.where(`${column}=eq.${String(value)}`, (row) => columnValue(row, column) === value);
  }

  neq(column: string, value: unknown): this {
    return this.where(`${column}=neq.${String(value)}`, (row) => columnValue(row, column) !== value);
  }

  gt(column: string, value: unknown): this {
    return this.where(`${column}=gt.${String(value)}`, (row) => compare(columnValue(row, column), value) > 0 && columnValue(row, column) !== null);
  }

  gte(column: string, value: unknown): this {
    return this.where(`${column}=gte.${String(value)}`, (row) => columnValue(row, column) !== null && compare(columnValue(row, column), value) >= 0);
  }

  lte(column: string, value: unknown): this {
    return this.where(`${column}=lte.${String(value)}`, (row) => columnValue(row, column) !== null && compare(columnValue(row, column), value) <= 0);
  }

  in(column: string, values: unknown[]): this {
    return this.where(`${column}=in.(${values.length})`, (row) => values.includes(columnValue(row, column)));
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is' || value !== null) throw new Error(`FakeQuery.not(${operator}) is not supported`);
    return this.where(`${column}=not.is.null`, (row) => columnValue(row, column) !== null);
  }

  is(column: string, value: unknown): this {
    if (value !== null) throw new Error('FakeQuery.is supports null only');
    return this.where(`${column}=is.null`, (row) => columnValue(row, column) === null);
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(rows: number): this {
    this.limitRows = rows;
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private matching(): Row[] {
    return (this.db.tables.get(this.table) ?? []).filter((row) => this.filters.every((filter) => filter.test(row)));
  }

  private execute(): Result {
    const call: FakeCall = {
      table: this.table,
      op: this.op === 'select' && this.head && this.countExact ? 'count' : this.op,
      filters: this.filters.map((filter) => filter.label),
      payload: this.op === 'insert' ? this.payload.map((row) => ({ ...row })) : undefined,
      range: this.rangeFrom !== null && this.rangeTo !== null ? [this.rangeFrom, this.rangeTo] : undefined,
      returned: 0,
    };
    this.db.calls.push(call);
    const injected = this.db.injected(call);
    if (injected) return { data: null, error: injected, count: null };

    if (this.op === 'insert') {
      const { rows, error } = this.db.insertRows(this.table, this.payload);
      if (error) return { data: null, error, count: null };
      call.returned = rows.length;
      if (!this.returning) return { data: null, error: null, count: null };
      const data = rows.map((row) => ({ id: row.id }));
      return { data: this.single ? data[0] ?? null : data, error: null, count: null };
    }
    if (this.op === 'delete') {
      const doomed = new Set(this.matching());
      const removed = this.db.deleteRows(this.table, (row) => !doomed.has(row));
      call.returned = removed.length;
      return { data: this.returning ? removed.map((row) => ({ id: row.id })) : null, error: null, count: null };
    }

    const rows = this.matching();
    if (this.head) return { data: null, error: null, count: this.countExact ? rows.length : null };
    const sorted = this.orders.length === 0
      ? rows
      : [...rows].sort((a, b) => {
        for (const { column, ascending } of this.orders) {
          const diff = compare(columnValue(a, column), columnValue(b, column));
          if (diff !== 0) return ascending ? diff : -diff;
        }
        return 0;
      });
    const offset = this.rangeFrom ?? 0;
    let wanted = this.rangeTo !== null ? this.rangeTo - offset + 1 : sorted.length;
    if (this.limitRows !== null) wanted = Math.min(wanted, this.limitRows);
    wanted = Math.min(wanted, this.db.maxRows);
    const page = sorted.slice(offset, offset + Math.max(0, wanted)).map((row) => ({ ...row }));
    call.returned = page.length;
    if (this.single) {
      if (page.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' }, count: null };
      return { data: page[0] ?? null, error: null, count: null };
    }
    return { data: page, error: null, count: this.countExact ? rows.length : null };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}
