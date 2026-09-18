# The deployment observer cannot repair releases

The Supabase billing audit observed the workers service calling the removed
`autofix_is_paused` function every two minutes. A missing function failed open
into code that could cancel Vercel builds and invoke a retired autofix publisher.

The existing authenticated deployment observer now only reads Vercel and records
its established operational incidents. Build cancellation, source repair,
autofix coordination reads/writes and external repair notifications are removed.
Normal job schedules, deployment credential-health incidents, durable alert
identities and failed-delivery retries remain. It reports observation, never
certification or release success. Existing incidents are not deleted or resolved
merely because a later deployment is READY.

The tracked workstation `node_modules` symlink is removed; dependencies remain
ignored and installed privately from the lockfile rather than through a shared
workstation path.

Regression coverage includes old queued/running builds, a failing main build,
configured retired publisher credentials, no provider writes, no retired
Supabase calls, and durable failure delivery across retries. The full worker
suite, compiler and production build remain required before publication.
