# A failed PokerNews import does not refresh the successful-run clock

The 03:30 and 06:30 UTC runs on September 13 recorded `success` despite an RSS 404 and zero imports. Per-video database failures had the same problem. The handler now returns HTTP 503 and `success: false` for a failed feed, an inconclusive duplicate lookup, a missing video URL, or any refused insert. Its existing cron middleware consequently records a failed run, while the response retains how many items actually committed. A verified duplicate remains a successful no-op.

Author lookup errors retain the database error instead of being mislabeled as missing configuration. An absent PokerNews publisher still refuses publication; this change does not select another account or create one. The RSS deadline releases its timer after normal completion, and the parser also has a socket timeout.

Nine route regressions cover RSS failure/deadline, author errors and absence, inconclusive duplicate reads, partial writes, malformed items, duplicates and successful attribution. Typecheck, targeted lint and the production build pass. Publication identity and the separate video-library reporting gap still require repair.
