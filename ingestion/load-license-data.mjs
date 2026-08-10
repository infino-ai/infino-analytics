// Load the FlexLM license-analytics demo tables into an Infino Cloud database.
//
// Usage:
//   INFINO_API_KEY=inf_... node load-license-data.mjs \
//     --data-dir /path/to/csvs [--database flexlm-demo] [--host https://api.platform.infino.ws]
//
// Expects four CSVs in --data-dir: license_events.csv, license_utilization.csv,
// license_inventory.csv, license_pricing.csv.
//
// Zero dependencies: creates the database and tables over the REST API and
// appends rows in batched JSON envelopes (target ≤ 3 MiB per request; the
// service caps request bodies at 5 MiB).
//
// This is an example, not a framework: ingestion pipelines are owned by the
// application. Adapt the schema/map pairs below to your own data.
//
// Timestamps: the hosted schema has no timestamp scalar type, so time columns
// are stored twice — the ISO-8601 string (sortable; substring bucketing) and
// epoch milliseconds as i64 (numeric ranges; to_timestamp_millis).

import { readFileSync } from "node:fs";

const HOST = argValue("--host") ?? "https://api.platform.infino.ws";
const DATABASE = argValue("--database") ?? "flexlm-demo";
const DATA_DIR = argValue("--data-dir");
const API_KEY = process.env.INFINO_API_KEY;
if (!API_KEY) {
  console.error("INFINO_API_KEY is not set");
  process.exit(1);
}
if (!DATA_DIR) {
  console.error("--data-dir is required (directory holding the four CSVs)");
  process.exit(1);
}

const BATCH_BYTES_TARGET = 3 * 1024 * 1024;
const MAX_RETRIES = 8;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --- minimal RFC-4180 CSV ----------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// --- field converters ----------------------------------------------------------

// "$16,640/seat" -> 16640 ; "$1,300,000" -> 1300000
const money = (s) => Number(String(s).replace(/[$,\s]/g, "").replace(/\/.*$/, "")) || 0;
// "$16,640/seat" -> "seat" ; no suffix -> ""
const priceUnit = (s) => (String(s).match(/\/(\w+)/)?.[1] ?? "");
const bool = (s) => String(s).toLowerCase() === "true";
const int = (s) => parseInt(s, 10) || 0;
const num = (s) => Number(s) || 0;
const epochMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

// --- table definitions -----------------------------------------------------------

const TABLES = [
  {
    name: "license_events",
    file: "license_events.csv",
    schema: [
      { name: "timestamp", type: "utf8", nullable: false },
      { name: "timestamp_ms", type: "i64", nullable: false },
      { name: "license_server", type: "utf8", nullable: false },
      { name: "daemon_name", type: "utf8", nullable: false },
      { name: "event_type", type: "utf8", nullable: false },
      { name: "feature_name", type: "utf8", nullable: false },
      { name: "user_name", type: "utf8", nullable: false },
      { name: "client_host", type: "utf8", nullable: false },
      { name: "licenses", type: "i64", nullable: false },
      { name: "extra_info", type: "utf8", nullable: false },
    ],
    map: (r) => ({
      timestamp: r.timestamp,
      timestamp_ms: epochMs(r.timestamp),
      license_server: r.license_server,
      daemon_name: r.daemon_name,
      event_type: r.event_type,
      feature_name: r.feature_name,
      user_name: r.user_name,
      client_host: r.client_host,
      licenses: int(r.licenses),
      extra_info: r.extra_info ?? "",
    }),
  },
  {
    name: "license_utilization",
    file: "license_utilization.csv",
    schema: [
      { name: "timestamp", type: "utf8", nullable: false },
      { name: "timestamp_ms", type: "i64", nullable: false },
      { name: "feature_name", type: "utf8", nullable: false },
      { name: "vendor_daemon", type: "utf8", nullable: false },
      { name: "seats_total", type: "i64", nullable: false },
      { name: "seats_in_use", type: "i64", nullable: false },
      { name: "utilization_pct", type: "f64", nullable: false },
      { name: "queue_depth", type: "i64", nullable: false },
      { name: "cumulative_checkouts", type: "i64", nullable: false },
      { name: "cumulative_denials", type: "i64", nullable: false },
      { name: "cumulative_queue_events", type: "i64", nullable: false },
    ],
    map: (r) => ({
      timestamp: r.timestamp,
      timestamp_ms: epochMs(r.timestamp),
      feature_name: r.feature_name,
      vendor_daemon: r.vendor_daemon,
      seats_total: int(r.seats_total),
      seats_in_use: int(r.seats_in_use),
      utilization_pct: num(r.utilization_pct),
      queue_depth: int(r.queue_depth),
      cumulative_checkouts: int(r.cumulative_checkouts),
      cumulative_denials: int(r.cumulative_denials),
      cumulative_queue_events: int(r.cumulative_queue_events),
    }),
  },
  {
    name: "license_inventory",
    file: "license_inventory.csv",
    schema: [
      { name: "vendor_name", type: "utf8", nullable: false },
      { name: "feature_name", type: "utf8", nullable: false },
      { name: "version", type: "utf8", nullable: false },
      { name: "seats", type: "i64", nullable: false },
      { name: "expiration", type: "utf8", nullable: false },
      { name: "is_permanent", type: "bool", nullable: false },
      { name: "is_expired", type: "bool", nullable: false },
      { name: "server_hostname", type: "utf8", nullable: false },
      { name: "server_port", type: "i64", nullable: false },
      { name: "daemon_name", type: "utf8", nullable: false },
    ],
    map: (r) => ({
      vendor_name: r.vendor_name,
      feature_name: r.feature_name,
      version: r.version,
      seats: int(r.count),
      expiration: r.expiration,
      is_permanent: bool(r.is_permanent),
      is_expired: bool(r.is_expired),
      server_hostname: r.server_hostname,
      server_port: int(r.server_port),
      daemon_name: r.daemon_name,
    }),
  },
  {
    name: "license_pricing",
    file: "license_pricing.csv",
    schema: [
      { name: "product", type: "utf8", nullable: false },
      { name: "feature_display_name", type: "utf8", nullable: false },
      { name: "license_name", type: "utf8", nullable: false },
      { name: "unit_price_usd", type: "f64", nullable: false },
      { name: "price_unit", type: "utf8", nullable: false },
      { name: "total_price_usd_per_year", type: "f64", nullable: false },
    ],
    map: (r) => ({
      product: r["Product"],
      feature_display_name: r["Feature Name"],
      license_name: r["License Name"], // joins license_events.feature_name
      unit_price_usd: money(r["Unit Price (USD)"]),
      price_unit: priceUnit(r["Unit Price (USD)"]), // "seat" | "token" | ""
      total_price_usd_per_year: money(r["Total Price (USD/yr)"]),
    }),
  },
];

// --- REST client -------------------------------------------------------------------

async function api(path, body, { method = "POST" } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HOST}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 503 && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get("retry-after")) || 3;
      console.log(`  503 (activating) — retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
  }
}

async function appendBatched(table, rows) {
  let batch = [], bytes = 0, sent = 0;
  const flush = async () => {
    if (!batch.length) return;
    await api(`/v1/append/${DATABASE}?table=${encodeURIComponent(table)}`, { data: batch });
    sent += batch.length;
    process.stdout.write(`\r  ${table}: ${sent}/${rows.length}`);
    batch = []; bytes = 0;
  };
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (bytes + size > BATCH_BYTES_TARGET) await flush();
    batch.push(row); bytes += size;
  }
  await flush();
  process.stdout.write("\n");
}

// --- main --------------------------------------------------------------------------

console.log(`target: ${HOST}/${DATABASE}`);

try {
  await api("/v1/databases", { name: DATABASE });
  console.log(`database ${DATABASE} created`);
} catch (e) {
  if (/exists/i.test(String(e))) console.log(`database ${DATABASE} already exists`);
  else throw e;
}

const existing = await api(`/v1/list_tables/${DATABASE}`, {});
const existingNames = new Set(
  Array.isArray(existing) ? existing : existing.tables ?? [],
);

for (const t of TABLES) {
  if (existingNames.has(t.name)) {
    console.log(`${t.name}: already exists, skipping`);
    continue;
  }
  const rows = parseCsv(readFileSync(`${DATA_DIR}/${t.file}`, "utf8")).map(t.map);
  console.log(`${t.name}: creating (${rows.length} rows to load)`);
  await api(`/v1/create_table/${DATABASE}`, { table_name: t.name, schema: t.schema });
  await appendBatched(t.name, rows);
}

for (const t of TABLES) {
  const out = await api(`/v1/query_sql/${DATABASE}`, {
    query: `SELECT COUNT(*) AS n FROM ${t.name}`,
  });
  console.log(`${t.name}: count ->`, JSON.stringify(out).slice(0, 120));
}
console.log("done");
