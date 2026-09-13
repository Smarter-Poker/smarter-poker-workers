# Worker deployments retain accepted jobs

The September 13 16:45 UTC trivia theme backfill lost its worker connection at
16:46:15.699, when Docker replaced the worker container. Its execution row was
later swept to `killed`, without a completion record. The next two-hour run
completed 50 themes with no errors, which restored the signal but did not repair
the shutdown defect.

The existing signal handler flushed Sentry and exited immediately. It did not
close the listener, await accepted handlers, or retain the detached completion
PATCH. A normal deployment could therefore discard a running job and leave its
audit row looking abandoned. The old behavior is reproduced with a real Hono
HTTP request and SIGTERM: exit zero, broken connection, no job or receipt file.

The server now stops admitting requests on the first shutdown signal, closes its
listener, and awaits both accepted handler promises and their completion writes.
Tracking promises separately from connections preserves work after a dispatcher
disconnects. Repeated signals cannot start another shutdown or exit early.
Normal request latency stays unchanged. Existing reminder cancellation and
durable reminder retry semantics are preserved.

The application drain has a nine-minute deadline; a hung job or failed shutdown
exits unsuccessfully. Both deployment paths give Docker ten minutes explicitly,
so an older compose file on the host cannot impose the old ten-second default.
The source compose file also specifies this grace. No host configuration is
replaced by deployment.

Validation: seven focused tests exercise real child processes, HTTP, signals and
filesystem receipts, including the predecessor failure, normal completion,
disconnected dispatchers, repeated signals, hung work, rejected work and failed
telemetry flush. The complete 56-file / 389-test worker suite and the production
TypeScript/esbuild build pass. Production release and a natural later deployment
must still be checked before claiming live drain behavior.
