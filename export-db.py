#!/usr/bin/env python3
"""
Export all DB tables to CSV files via /api/query endpoint.
Output: exports/ folder with one CSV per table.
"""
import json, urllib.request, csv, os, sys

WORKER = "https://sorha-aana-worker.neptechpal355.workers.dev"
OUT_DIR = "exports"

TABLES = [
    "sellers",
    "rental_owners",
    "buyers",
    "tenants",
    "agents",
    "districts",
    "municipalities",
]

def query(sql):
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        WORKER + "/api/query",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "curl/7.68.0"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def export_table(table):
    print(f"Exporting {table}...", end=" ", flush=True)

    # Get total count
    count_res = query(f"SELECT COUNT(*) as cnt FROM {table}")
    total = count_res["data"][0]["cnt"]
    print(f"({total} rows)", end=" ", flush=True)

    rows = []
    batch = 500
    offset = 0

    while offset < total:
        res = query(f"SELECT * FROM {table} LIMIT {batch} OFFSET {offset}")
        batch_data = res.get("data", [])
        if not batch_data:
            break
        rows.extend(batch_data)
        offset += len(batch_data)
        print(".", end="", flush=True)

    if not rows:
        print(" empty")
        return

    # Write CSV
    out_path = os.path.join(OUT_DIR, f"{table}.csv")
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    print(f" -> {out_path}")

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Exporting to ./{OUT_DIR}/\n")

    for table in TABLES:
        try:
            export_table(table)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)

    print(f"\nDone! Files saved in ./{OUT_DIR}/")

if __name__ == "__main__":
    main()
