import { PAGE_SIZE } from './pagedSelect.js';

interface ScanQuery {
  range(from: number, to: number): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

/** Read the existing newest-first, bounded scan without retaining earlier pages.
 * The caller must supply a fresh, totally ordered query for every page and
 * finish all reads before writing findings. A failed final probe is a failed
 * scan, not proof that the ceiling happened to cover the whole window. */
export async function scanPages<T>(
  build: () => ScanQuery,
  max: number,
  onPage: (rows: T[]) => void,
  pageSize = PAGE_SIZE,
): Promise<{ count: number; truncated: boolean; pages: number }> {
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > PAGE_SIZE) {
    throw new Error('scanPages requires a positive row cap and pageSize 1..1000');
  }
  let count = 0;
  let pages = 0;
  while (count < max) {
    const want = Math.min(pageSize, max - count);
    const { data, error } = await build().range(count, count + want - 1);
    pages += 1;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data) || data.length > want) throw new Error('Invalid scan page');
    onPage(data as T[]);
    count += data.length;
    if (data.length < want) return { count, truncated: false, pages };
  }
  const { data, error } = await build().range(max, max);
  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length > 1) throw new Error('Invalid scan ceiling probe');
  return { count, truncated: data.length > 0, pages: pages + 1 };
}
