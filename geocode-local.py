#!/usr/bin/env python3
"""
Geocode properties directly from local machine:
1. Fetch pending rows from DB via /api/query
2. Call Nominatim directly (no Worker timeout issue)
3. Update DB via /api/query

Respects Nominatim 1 req/sec rate limit.
"""
import json, time, sys, urllib.request, urllib.parse

WORKER = "https://sorha-aana-worker.neptechpal355.workers.dev"
NOM    = "https://nominatim.openstreetmap.org/search"
BATCH  = 20   # how many rows to fetch per round
DELAY  = 1.2  # seconds between Nominatim calls (> 1 req/sec)

def worker_query(sql, params=None):
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        WORKER + "/api/query",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "curl/7.68.0"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def nominatim(query, params="&countrycodes=np"):
    url = NOM + "?q=" + urllib.parse.quote(query) + "&format=json&limit=1" + params
    req = urllib.request.Request(url, headers={"User-Agent": "sorha-geocode-local/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"  Nominatim error: {e}", file=sys.stderr)
    return None

def geocode(address, city, district):
    """Try 3 tiers: full address, city+district, district only"""
    parts = [p for p in [address, city, district] if p]
    full  = ", ".join(parts) + " Nepal"
    result = nominatim(full)
    if result:
        return result

    time.sleep(DELAY)
    if city:
        city_parts = [p for p in [city, district] if p]
        result = nominatim(", ".join(city_parts) + " Nepal")
        if result:
            return result
        time.sleep(DELAY)

    if district:
        result = nominatim(district + " Nepal")
        if result:
            return result
        time.sleep(DELAY)

    return None

def update_db(table, row_id, lat, lng):
    sql = f"UPDATE {table} SET latitude = {lat}, longitude = {lng} WHERE id = {row_id}"
    worker_query(sql)

def get_status():
    req = urllib.request.Request(WORKER + "/api/geocode/status", headers={"User-Agent": "curl/7.68.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def main():
    total_ok = 0
    total_fail = 0
    round_num = 0

    while True:
        round_num += 1

        # Fetch pending sellers
        sellers_sql = """
            SELECT s.id, s.property_address, s.city,
                   d.name as district, m.name as municipality
            FROM sellers s
            LEFT JOIN districts d ON s.district_id = d.id
            LEFT JOIN municipalities m ON s.municipal_id = m.id
            WHERE s.latitude IS NULL
            ORDER BY s.id LIMIT %d
        """ % BATCH
        rentals_sql = """
            SELECT ro.id, ro.address as property_address, ro.city,
                   d.name as district, m.name as municipality
            FROM rental_owners ro
            LEFT JOIN districts d ON ro.district_id = d.id
            LEFT JOIN municipalities m ON ro.municipal_id = m.id
            WHERE ro.latitude IS NULL
            ORDER BY ro.id LIMIT %d
        """ % BATCH

        rows = []
        try:
            sellers = worker_query(sellers_sql).get("data", [])
            rows += [("sellers", r) for r in sellers]
            if len(sellers) < BATCH:
                rentals = worker_query(rentals_sql).get("data", [])
                rows += [("rental_owners", r) for r in rentals[:BATCH - len(sellers)]]
        except Exception as e:
            print(f"Round {round_num}: DB fetch error: {e}")
            time.sleep(15)
            continue

        if not rows:
            print(f"Round {round_num}: No more pending rows. Done!", flush=True)
            break

        ok = 0
        fail = 0
        for table, row in rows:
            rid  = row["id"]
            addr = row.get("property_address") or ""
            city = row.get("municipality") or row.get("city") or ""
            dist = row.get("district") or ""

            result = geocode(addr, city, dist)
            time.sleep(DELAY)  # Nominatim rate limit between properties

            if result:
                lat, lng = result
                try:
                    update_db(table, rid, lat, lng)
                    ok += 1
                    total_ok += 1
                except Exception as e:
                    print(f"  DB update error for {table}:{rid}: {e}")
                    fail += 1
                    total_fail += 1
            else:
                # Mark as attempted-failed (0,0) sentinel
                try:
                    update_db(table, rid, 0, 0)
                except Exception:
                    pass
                fail += 1
                total_fail += 1

        print(f"Round {round_num}: +{ok} ok, +{fail} fail | Total: {total_ok} ok, {total_fail} fail", flush=True)

        if round_num % 5 == 0:
            try:
                st = get_status()
                print(f"  DB status: {st['total_geocoded']} geocoded, {st['total_pending']} pending", flush=True)
            except Exception:
                pass

    print(f"\n=== DONE ===  Total: {total_ok} ok, {total_fail} fail", flush=True)
    try:
        st = get_status()
        print(f"Final DB status: {st['total_geocoded']} geocoded, {st['total_pending']} pending", flush=True)
    except Exception:
        pass

if __name__ == "__main__":
    main()
