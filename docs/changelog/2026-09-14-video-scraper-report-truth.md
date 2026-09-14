# Video scraper reports require committed results

The Python scraper previously called a retired World Hub endpoint, while the workers replacement acknowledged even an empty report or a returned database error. Reading that route also counted as a successful daily scrape. A run with failed metadata or video inserts could therefore stay green.

The report route validates run identity, counters and completion freshness, commits one audit row per run UUID, and acknowledges only its exact receipt. Changed replays are refused. Failed creator, insert or metadata results are stored and delivered to the existing operational inbox with the run UUID before returning HTTP 503. Status reads no longer create daily execution records. No SMS or Slack delivery is added.

The Python companion uses the existing private workers hop and its host-local credential. Deploy the worker before installing that companion. Old report bodies without completion evidence are refused; historical reports cannot make a dead job look current. Normal cron logging still records report requests separately from the actual run timestamps retained in their audit proof.

Validation: 26 actual Hono route cases plus five existing response-summary cases, typecheck, targeted lint and production bundle. External database IO is controlled in these tests; production outcome and the upstream metadata failures require separate verification.
