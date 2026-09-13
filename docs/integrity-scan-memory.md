# Integrity scan memory regression

The hourly bot-timing scan used to retain up to 20,000 full action arrays, then
retain another array of deltas per user. The concurrently dispatched chip-dump
scan retained up to 50,000 player/winner rows before aggregation. On September
13, 2026, worker heap failures at 15:00:29 and 16:00:29 UTC immediately preceded
the dispatcher's bot-timing connection failures. The container's V8 heap limit
was 259 MiB; its container memory limit was 512 MiB.

Both handlers now fold each page into sufficient statistics immediately. Timing
retains per-user count and moments; chip attribution retains per-user and
per-counterparty totals. Memory grows with distinct users/pairs and one fetched
page, rather than every hand's JSON. The existing 20,000/50,000 row ceilings,
windows, filters, attribution, thresholds, deduplication, dry-run behavior and
flag-only writes remain. ID provides a deterministic secondary ordering when
creation timestamps match. A failed read, including the ceiling probe, produces
a failed scan before any findings are written.

Timing variance uses exact squared sums for integer millisecond deltas so strict
50/100/150 ms boundaries do not drift below a threshold. Fractional timestamps
use centered running moments without rounding the observations. Intra-hand
boundaries, timestamp aliases and the 90-second delta ceiling are preserved.

`npm run test:integrity-memory` is a blocking CI check. It generates independently
parsed pages for concurrent scans of 20,000 timing hands and 50,000 chip hands.
The timing action array is 12,531 bytes, within the 5,980-byte average /
22,013-byte maximum observed in a read-only sample of 200 recent production
hands. This is a stress fixture, not a reconstruction of the entire production
window. It compares all findings with the frozen pre-change aggregation:

- The retained implementation succeeds with a larger heap to establish the
  expected results, and must reproduce heap exhaustion with a 259 MiB heap.
- The streamed implementation must complete with that same 259 MiB limit,
  preserve both full row counts and the complete findings digest, and remain
  below 150 MiB sampled peak heap.
- Local September 13 results: 383 MiB sampled heap for the retained oracle;
  100 MiB for streaming; 50 timing users and 1,500 chip-pair findings matched.

Unit and handler tests additionally cover strict severity/count boundaries,
shuffled integer and fractional timestamps, split pots, aliases, duplicate
winners, partial read failure, page ceilings, dry runs and open-flag deduplication.

This proves the retained allocation defect and its correction. It does not
attribute every other concurrently dispatched handler's memory. Production
closure requires the deployed revision to match, both scheduled scans to
complete, and no new worker heap crash or restart during that hourly batch.
