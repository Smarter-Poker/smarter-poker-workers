/**
 * An in-memory stand-in for the Supabase client, for behavioural tests of the
 * fleet's social engines. TEST-ONLY: nothing the service runs imports it.
 *
 * It speaks the subset of the PostgREST builder those engines use, and it
 * keeps the two properties of the real service that the 2026-09-21
 * recertification found them depending on:
 *
 *   - every read is capped at MAX_ROWS (db-max-rows is 1,000 in production),
 *     with or without .range(), and an unordered read comes back in storage
 *     (insertion) order;
 *   - a GET whose IN list is too long for a URL is refused, as PostgREST
 *     refused 1,000 horse UUIDs (see reactToComments).
 */

export type Row = Record<string, unknown>;

export interface FakeError {
  message: string;
  code?: string;
}

export interface Operation {
  table: string;
  kind: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';
  /** e.g. `eq:post_id`, `in:friend_id`, `not.in:id`, `or` */
  filters: string[];
  inListSizes: number[];
  ranged: boolean;
  values: Row[];
}

interface Result {
  data: unknown;
  error: FakeError | null;
  count: number | null;
  status: number;
}

type Predicate = (row: Row) => boolean;

export const MAX_ROWS = 1000;
/** Past this many ids an IN list no longer fits in a GET URL. */
export const MAX_IN_LIST = 300;

const DEFAULTS: Record<string, Row> = {
  social_posts: { is_deleted: false, visibility: 'public', is_flagged: false, content_type: 'text' },
  social_comments: { parent_id: null, is_deleted: false, is_flagged: false },
};

const UNIQUE: Record<string, string[][]> = {
  friendships: [['user_id', 'friend_id']],
  social_likes: [['post_id', 'user_id', 'reaction_type']],
  content_asset_use: [['asset_key', 'horse_id']],
};

function field(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) {
    const obj = row[json[1] ?? ''];
    return obj && typeof obj === 'object' ? (obj as Row)[json[2] ?? ''] : undefined;
  }
  return row[column];
}

function isNil(v: unknown): boolean {
  return v === null || v === undefined;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (isNil(a)) return 1; // nulls last
  if (isNil(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim().replace(/^\(/, '').replace(/\)$/, '');
  return s ? s.split(',').map((x) => x.trim().replace(/^"|"$/g, '')) : [];
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`);
}

function opPredicate(column: string, op: string, value: unknown): Predicate {
  switch (op) {
    case 'eq':
      return (r) => !isNil(field(r, column)) && String(field(r, column)) === String(value);
    case 'neq':
      return (r) => !isNil(field(r, column)) && String(field(r, column)) !== String(value);
    case 'gt':
      return (r) => !isNil(field(r, column)) && compare(field(r, column), value) > 0;
    case 'gte':
      return (r) => !isNil(field(r, column)) && compare(field(r, column), value) >= 0;
    case 'lt':
      return (r) => !isNil(field(r, column)) && compare(field(r, column), value) < 0;
    case 'lte':
      return (r) => !isNil(field(r, column)) && compare(field(r, column), value) <= 0;
    case 'is':
      if (value === null || value === 'null') return (r) => isNil(field(r, column));
      return (r) => field(r, column) === (value === 'true' ? true : value === 'false' ? false : value);
    case 'in': {
      const list = new Set(parseList(value));
      return (r) => !isNil(field(r, column)) && list.has(String(field(r, column)));
    }
    case 'like': {
      const re = likeToRegex(String(value));
      return (r) => !isNil(field(r, column)) && re.test(String(field(r, column)));
    }
    default:
      throw new Error(`fakeSupabase: unsupported operator ${op}`);
  }
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseCondition(term: string): Predicate {
  const t = term.trim();
  if (t.startsWith('and(') && t.endsWith(')')) {
    const parts = splitTop(t.slice(4, -1)).map(parseCondition);
    return (r) => parts.every((p) => p(r));
  }
  if (t.startsWith('or(') && t.endsWith(')')) {
    const parts = splitTop(t.slice(3, -1)).map(parseCondition);
    return (r) => parts.some((p) => p(r));
  }
  const first = t.indexOf('.');
  const second = t.indexOf('.', first + 1);
  return opPredicate(t.slice(0, first), t.slice(first + 1, second), t.slice(second + 1));
}

function project(row: Row, columns: string): Row {
  if (!columns || columns.trim() === '*') return { ...row };
  const out: Row = {};
  for (const c of columns.split(',').map((x) => x.trim()).filter(Boolean)) out[c] = row[c];
  return out;
}

export class FakeDb {
  readonly tables: Record<string, Row[]> = {};
  readonly log: Operation[] = [];
  private readonly injectors: Array<(op: Operation) => FakeError | null> = [];
  private seq = 0;

  /** The object `getSupabase()` should return. */
  readonly client = {
    from: (table: string) => new FakeQuery(this, table),
    rpc: (name: string, args: Row = {}) => new FakeQuery(this, `rpc:${name}`, 'rpc', [args]),
    channel: (_name: string) => ({ send: async (_msg: unknown) => 'ok' }),
  };

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  /** Seed rows exactly as given (plus table defaults). Storage order is seed order. */
  seed(table: string, rows: Row[]): void {
    for (const r of rows) this.rows(table).push({ ...(DEFAULTS[table] ?? {}), ...r });
  }

  /** Every operation matching `when` fails with `error`. */
  fail(when: (op: Operation) => boolean, error: FakeError = { message: 'simulated outage', code: '57014' }): void {
    this.injectors.push((op) => (when(op) ? error : null));
  }

  writes(table: string, kind: Operation['kind'] = 'insert'): Operation[] {
    return this.log.filter((o) => o.table === table && o.kind === kind);
  }

  nextId(table: string): string {
    this.seq += 1;
    return `${table}-${String(this.seq).padStart(6, '0')}`;
  }

  injected(op: Operation): FakeError | null {
    for (const f of this.injectors) {
      const e = f(op);
      if (e) return e;
    }
    return null;
  }
}

export class FakeQuery implements PromiseLike<Result> {
  private readonly preds: Predicate[] = [];
  private readonly filterNames: string[] = [];
  private readonly inSizes: number[] = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private columns = '*';
  private returning = false;
  private head = false;
  private counted = false;
  private singleMode: 'single' | 'maybe' | null = null;
  private onConflict: string[] = [];
  private ignoreDuplicates = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
    private kind: Operation['kind'] = 'select',
    private values: Row[] = [],
  ) {}

  select(columns = '*', opts: { count?: string; head?: boolean } = {}): this {
    this.columns = columns;
    if (this.kind === 'select') {
      this.counted = Boolean(opts.count);
      this.head = Boolean(opts.head);
    } else {
      this.returning = true;
    }
    return this;
  }

  insert(values: Row | Row[]): this {
    this.kind = 'insert';
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.kind = 'upsert';
    this.values = Array.isArray(values) ? values : [values];
    this.onConflict = (opts.onConflict ?? 'id').split(',').map((s) => s.trim());
    this.ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    return this;
  }

  update(values: Row): this {
    this.kind = 'update';
    this.values = [values];
    return this;
  }

  delete(): this {
    this.kind = 'delete';
    return this;
  }

  private add(name: string, pred: Predicate): this {
    this.filterNames.push(name);
    this.preds.push(pred);
    return this;
  }

  eq(column: string, value: unknown): this { return this.add(`eq:${column}`, opPredicate(column, 'eq', value)); }
  neq(column: string, value: unknown): this { return this.add(`neq:${column}`, opPredicate(column, 'neq', value)); }
  gt(column: string, value: unknown): this { return this.add(`gt:${column}`, opPredicate(column, 'gt', value)); }
  gte(column: string, value: unknown): this { return this.add(`gte:${column}`, opPredicate(column, 'gte', value)); }
  lt(column: string, value: unknown): this { return this.add(`lt:${column}`, opPredicate(column, 'lt', value)); }
  lte(column: string, value: unknown): this { return this.add(`lte:${column}`, opPredicate(column, 'lte', value)); }
  like(column: string, pattern: string): this { return this.add(`like:${column}`, opPredicate(column, 'like', pattern)); }
  is(column: string, value: unknown): this { return this.add(`is:${column}`, opPredicate(column, 'is', value)); }

  in(column: string, values: unknown[]): this {
    this.inSizes.push(values.length);
    return this.add(`in:${column}`, opPredicate(column, 'in', values));
  }

  not(column: string, op: string, value: unknown): this {
    if (op === 'in') this.inSizes.push(parseList(value).length);
    const inner = opPredicate(column, op, value);
    return this.add(`not.${op}:${column}`, (r) => !inner(r));
  }

  or(expression: string): this {
    return this.add('or', parseCondition(`or(${expression})`));
  }

  filter(column: string, op: string, value: unknown): this {
    return this.add(`${op}:${column}`, opPredicate(column, op, value));
  }

  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.orders.push({ column, ascending: opts.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybe';
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.preds.every((p) => p(r)));
  }

  private shape(rows: Row[]): Result {
    if (this.singleMode) {
      if (rows.length > 1) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count: null, status: 406 };
      }
      if (rows.length === 0 && this.singleMode === 'single') {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count: null, status: 406 };
      }
      return { data: rows[0] ?? null, error: null, count: null, status: 200 };
    }
    return { data: rows, error: null, count: null, status: 200 };
  }

  private execute(): Result {
    const op: Operation = {
      table: this.table,
      kind: this.kind,
      filters: [...this.filterNames],
      inListSizes: [...this.inSizes],
      ranged: this.rangeFrom !== null,
      values: this.values.map((v) => ({ ...v })),
    };
    this.db.log.push(op);
    const injected = this.db.injected(op);
    if (injected) return { data: null, error: injected, count: null, status: 500 };
    if (this.inSizes.some((n) => n > MAX_IN_LIST)) {
      return { data: null, error: { message: 'URI Too Long', code: '414' }, count: null, status: 414 };
    }

    if (this.kind === 'rpc') return { data: null, error: null, count: null, status: 200 };

    if (this.kind === 'select') {
      let rows = this.matching();
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => (o.ascending ? 1 : -1) * compare(field(a, o.column), field(b, o.column)));
      }
      const count = rows.length;
      if (this.rangeFrom !== null && this.rangeTo !== null) rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      rows = rows.slice(0, MAX_ROWS).map((r) => project(r, this.columns));
      if (this.head) return { data: null, error: null, count: this.counted ? count : null, status: 200 };
      const shaped = this.shape(rows);
      return { ...shaped, count: this.counted ? count : null };
    }

    if (this.kind === 'insert' || this.kind === 'upsert') {
      const table = this.db.rows(this.table);
      const written: Row[] = [];
      for (const v of this.values) {
        if (this.kind === 'upsert') {
          const existing = table.find((r) => this.onConflict.every((c) => String(r[c]) === String(v[c])));
          if (existing) {
            if (!this.ignoreDuplicates) Object.assign(existing, v);
            continue;
          }
        }
        const row: Row = {
          id: this.db.nextId(this.table),
          created_at: new Date().toISOString(),
          ...(DEFAULTS[this.table] ?? {}),
          ...v,
        };
        for (const cols of UNIQUE[this.table] ?? []) {
          if (table.some((r) => cols.every((c) => String(r[c]) === String(row[c])))) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' }, count: null, status: 409 };
          }
        }
        written.push(row);
      }
      table.push(...written);
      return this.returning ? this.shape(written.map((r) => project(r, this.columns))) : { data: null, error: null, count: null, status: 201 };
    }

    if (this.kind === 'update') {
      const rows = this.matching();
      for (const r of rows) Object.assign(r, this.values[0] ?? {});
      return this.returning ? this.shape(rows.map((r) => project(r, this.columns))) : { data: null, error: null, count: null, status: 204 };
    }

    // delete
    const doomed = new Set(this.matching());
    const table = this.db.rows(this.table);
    const kept = table.filter((r) => !doomed.has(r));
    table.length = 0;
    table.push(...kept);
    return { data: null, error: null, count: null, status: 204 };
  }
}
