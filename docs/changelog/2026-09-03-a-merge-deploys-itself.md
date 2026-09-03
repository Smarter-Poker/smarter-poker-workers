# A merge deploys itself

2026-09-03. The workers VM was found running the 2026-08-31 build while main
carried thirteen newer commits. One of them added `/cron/cron-staleness-watchdog`,
which the Hetzner dispatcher had been calling into a 404 every fifteen minutes
for thirty hours. `release.yml` builds an image on a tag and then asks a human
to run `scripts/deploy-workers.sh` from Dan's Mac; the last tag was August 20.

`auto-deploy-workers.yml` now runs the `--build-on-server` path on every merge
that touches the service, from CI, with the VM's host key pinned and the
`workers-deploy@smarter.poker` key the VM already trusts (repo secrets
`WORKERS_SSH_PRIVATE_KEY`, `WORKERS_HOST`, `WORKERS_HOST_KEY`). The run fails
unless the running container reports the merged sha and `/health` is ok.

The VM was deployed to `e9dbf55` by hand tonight to close the gap; from this
change on, nothing has to remember to.
