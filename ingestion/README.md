# ingestion/

Example scripts that load data into Infino **before** the app runs.
Ingestion is a run-once (or cron-owned) step and every application's
pipeline is different — these scripts are patterns to copy, not a
framework. They use the plain REST API with zero dependencies; the
Node SDK (`@infino-ai/infino`) works equally well.

## load-license-data.mjs

Loads the FlexLM license-analytics demo dataset (four CSVs) into an
Infino Cloud database:

```sh
INFINO_API_KEY=inf_... node load-license-data.mjs \
  --data-dir /path/to/csvs \
  --database flexlm-demo
```

Tables created: `license_events`, `license_utilization`,
`license_inventory`, `license_pricing`.

Notes:

- Appends are batched to stay under the service's 5 MiB request cap.
- Time columns are stored twice — ISO-8601 string and epoch-ms `i64` —
  because the table schema has no timestamp scalar type.
- The script is idempotent at table granularity: tables that already
  exist are skipped, so a partial run can be resumed by dropping only
  the incomplete table.
- Data files stay outside the repo (`data/` is gitignored).
