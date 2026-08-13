"""
Bulk ingestion into an Infino Cloud database, with size-based chunking.

A pattern to copy into your own pipeline. Standard library only — no
packages to install.

What it demonstrates:
1. Creating a table with an explicit schema (inferred here from the data)
2. Batching rows into payloads that stay under a size limit
3. Flushing a batch before a row would push it over the limit
4. Retrying while the database activates (HTTP 503)
5. Verifying the loaded row count over SQL

Usage:
    INFINO_API_KEY=... python ingestion/bulk_upload.py \
        --database my-db --table events --file data.ndjson \
        [--schema schema.json] [--host https://api.platform.infino.ws] \
        [--max-bytes 3200000]

Input is NDJSON: one JSON object per line, flat keys. Values may be
strings, numbers, or booleans.

The table schema comes from --schema when given: a JSON array of
{"name", "type", "nullable"} columns, types utf8 | i64 | f64 | bool.
Prefer an explicit schema for production loads. Without one, the schema
is inferred from the first 200 rows, which is convenient but can guess
wrong: a column that is integral in the sample but fractional later, or
one that only appears after the sample, will mis-type. Timestamps are
best stored twice — an ISO-8601 string for readability and epoch
milliseconds (i64) for range filters.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Optional

# Stay safely under the platform's payload limit.
DEFAULT_MAX_PAYLOAD_BYTES = 3.2 * 1024 * 1024
SCHEMA_SAMPLE_ROWS = 200
MAX_503_RETRIES = 10


class InfinoRest:
    """Minimal REST client for the Infino Cloud data-plane endpoints."""

    def __init__(self, host: str, database: str, api_key: str):
        self.host = host.rstrip("/")
        self.database = database
        self.api_key = api_key

    def call(self, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.host}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        for attempt in range(MAX_503_RETRIES + 1):
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(req) as res:
                    text = res.read().decode("utf-8")
                    return json.loads(text) if text else {}
            except urllib.error.HTTPError as err:
                # 503 = the database is activating; brief and worth waiting out.
                if err.code == 503 and attempt < MAX_503_RETRIES:
                    wait = int(err.headers.get("Retry-After") or 3)
                    print(f"  503 (activating) — retrying in {wait}s", flush=True)
                    time.sleep(wait)
                    continue
                detail = err.read().decode("utf-8", "replace")[:300]
                raise RuntimeError(f"POST {path} -> {err.code}: {detail}") from None

    def create_table(self, table: str, schema: List[Dict[str, Any]]) -> None:
        self.call(f"/v1/create_table/{self.database}", {"table_name": table, "schema": schema})

    def append(self, table: str, rows: List[Dict[str, Any]]) -> None:
        self.call(f"/v1/append/{self.database}?table={table}", {"data": rows})

    def count(self, table: str) -> int:
        rows = self.call(f"/v1/query_sql/{self.database}", {"query": f"SELECT COUNT(*) AS n FROM {table}"})
        return int(rows[0]["n"]) if rows else 0


class ChunkedIngester:
    """Batches rows into appends that stay under a payload-size limit,
    flushing automatically before a row would push the batch over."""

    def __init__(self, client: InfinoRest, table: str, max_payload_bytes: float = DEFAULT_MAX_PAYLOAD_BYTES):
        self.client = client
        self.table = table
        self.max_payload_bytes = max_payload_bytes
        self._batch: List[Dict[str, Any]] = []
        self._batch_bytes = 0
        self.total_rows = 0
        self.total_batches = 0
        self.total_bytes = 0

    def add(self, row: Dict[str, Any]) -> None:
        # +1 approximates the JSON array separator.
        size = len(json.dumps(row).encode("utf-8")) + 1
        if self._batch and self._batch_bytes + size > self.max_payload_bytes:
            self.flush()
        self._batch.append(row)
        self._batch_bytes += size

    def flush(self) -> None:
        if not self._batch:
            return
        self.client.append(self.table, self._batch)
        self.total_rows += len(self._batch)
        self.total_batches += 1
        self.total_bytes += self._batch_bytes
        print(
            f"  batch {self.total_batches}: {len(self._batch)} rows "
            f"({self._batch_bytes / 1024:.0f} KiB) — {self.total_rows} total",
            flush=True,
        )
        self._batch = []
        self._batch_bytes = 0


def read_ndjson(path: str) -> Iterator[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as err:
                raise SystemExit(f"{path}:{line_no}: not valid JSON ({err})")


def infer_schema(sample: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Column types from observed values: utf8 / i64 / f64 / bool.
    A column is nullable if any sampled row lacks it or carries null."""
    types: Dict[str, str] = {}
    seen_in: Dict[str, int] = {}
    for row in sample:
        for key, value in row.items():
            seen_in[key] = seen_in.get(key, 0) + 1
            if value is None:
                continue
            if isinstance(value, bool):
                observed = "bool"
            elif isinstance(value, int):
                observed = "i64"
            elif isinstance(value, float):
                observed = "f64"
            else:
                observed = "utf8"
            prior = types.get(key)
            if prior is None or prior == observed:
                types[key] = observed
            elif {prior, observed} == {"i64", "f64"}:
                types[key] = "f64"
            else:
                types[key] = "utf8"
    return [
        {
            "name": key,
            "type": types.get(key, "utf8"),
            "nullable": seen_in[key] < len(sample),
        }
        for key in types
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Chunked bulk upload to Infino Cloud")
    parser.add_argument("--database", required=True)
    parser.add_argument("--table", required=True)
    parser.add_argument("--file", required=True, help="NDJSON file, one row per line")
    parser.add_argument(
        "--schema",
        help="JSON file with the explicit column schema; inferred from the data when omitted",
    )
    parser.add_argument("--host", default="https://api.platform.infino.ws")
    parser.add_argument("--max-bytes", type=float, default=DEFAULT_MAX_PAYLOAD_BYTES)
    args = parser.parse_args()

    api_key = os.environ.get("INFINO_API_KEY")
    if not api_key:
        raise SystemExit("set INFINO_API_KEY")

    client = InfinoRest(args.host, args.database, api_key)

    # Explicit schema when provided; otherwise inferred from a sample.
    if args.schema:
        with open(args.schema, "r", encoding="utf-8") as fh:
            schema = json.load(fh)
        if not isinstance(schema, list) or not all(
            isinstance(c, dict) and "name" in c and "type" in c for c in schema
        ):
            raise SystemExit(f'{args.schema}: expected [{{"name", "type", "nullable"?}}, ...]')
        for col in schema:
            col.setdefault("nullable", False)
        origin = "explicit"
    else:
        sample: List[Dict[str, Any]] = []
        for row in read_ndjson(args.file):
            sample.append(row)
            if len(sample) >= SCHEMA_SAMPLE_ROWS:
                break
        if not sample:
            raise SystemExit(f"{args.file} contains no rows")
        schema = infer_schema(sample)
        origin = f"inferred from first {len(sample)} rows"
    print(f"target: {args.host}/{args.database} · table {args.table}")
    print(
        f"schema ({len(schema)} columns, {origin}): "
        + ", ".join(f"{c['name']}:{c['type']}" for c in schema)
    )
    client.create_table(args.table, schema)

    # Stream the whole file through the chunker.
    started = time.time()
    ingester = ChunkedIngester(client, args.table, args.max_bytes)
    for row in read_ndjson(args.file):
        ingester.add(row)
    ingester.flush()

    took = time.time() - started
    print(
        f"done: {ingester.total_rows} rows in {ingester.total_batches} batches "
        f"({ingester.total_bytes / (1024 * 1024):.1f} MiB) in {took:.1f}s"
    )

    # Appended rows take a few seconds to become queryable.
    for _ in range(10):
        time.sleep(2)
        n = client.count(args.table)
        if n >= ingester.total_rows:
            break
    print(f"verified over SQL: {n} rows in {args.table}")
    if n < ingester.total_rows:
        print("  (count still catching up — appends become queryable within seconds)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
