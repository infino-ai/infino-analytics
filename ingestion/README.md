# ingestion/

Example scripts that load data into Infino **before** the app runs.
Ingestion is a run-once (or cron-owned) step and every application's
pipeline is different, so these are patterns to copy, not a framework.
They use the plain REST API with zero dependencies; the published SDKs
work equally well.

## bulk_upload.py

Chunked bulk upload of any NDJSON file (one JSON object per line),
Python standard library only:

```sh
INFINO_API_KEY=inf_... python3 bulk_upload.py \
  --database my-db --table events --file data.ndjson
```

- Infers the table schema (`utf8` / `i64` / `f64` / `bool`, nullability)
  from the first 200 rows and creates the table.
- Batches rows by payload size (default 3.2 MB), flushing before a row
  would push a batch over the limit.
- Retries while the database activates (HTTP 503) and verifies the final
  row count over SQL.

Notes that apply to any loader you write:

- Store time columns twice: an ISO-8601 string for readability and
  epoch-ms `i64` for range filters (the table schema has no timestamp
  scalar type). Declare the ISO column as `source.time_column` in specs
  so dashboards can inject time ranges.
- Appended rows become queryable within a few seconds; verify counts
  with a short retry loop rather than immediately.
- Keep data files outside the repo (`data/` is gitignored).
