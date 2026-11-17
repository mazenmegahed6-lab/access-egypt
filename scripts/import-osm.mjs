// scripts/import-osm.mjs — import real named shops/places across Egypt from OpenStreetMap into PostGIS.
// Usage:  npm i pg
//   DATABASE_URL=postgres://... ONLY=cairo node scripts/import-osm.mjs     (Greater Cairo + Giza)
//   ONLY=alex  -> Alexandria      |      ONLY=all (or leave out) -> all of Egypt (takes hours)
// Data © OpenStreetMap contributors (ODbL). Keep the credit in the app.
import pg from "pg";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const ssl = process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl });
let SAMPLE = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EGYPT = [21.7, 24.7, 31.7, 36.9];            // [south, west, north, east]
const PRESETS = { cairo: [29.75, 30.85, 30.25, 31.70], alex: [30.95, 29.60, 31.40, 30.20] };
function tiles(box, step) {
  const [s, w, n, e] = box, out = [];
  for (let la = s; la < n; la += step)
    for (let lo = w; lo < e; lo += step) out.push([la, lo, Math.min(la + step, n), Math.min(lo + step, e)]);
  return out;
}

const query = ([s, w, n, e]) => `[out:json][timeout:180];
(
  nwr["name"]["amenity"~"^(pharmacy|cafe|restaurant|fast_food|bank|clinic|hospital|doctors|dentist)$"](${s},${w},${n},${e});
  nwr["name"]["shop"](${s},${w},${n},${e});
);
out center tags;`;

const SHOP = {
  mall: "mall", department_store: "mall", supermarket: "supermarket", convenience: "supermarket",
  greengrocer: "supermarket", bakery: "bakery", pastry: "bakery", chemist: "pharmacy",
  clothes: "clothes", boutique: "clothes", fashion: "clothes", fabric: "clothes", shoes: "shoes", bag: "shoes",
  jewelry: "jewelry", electronics: "electronics", mobile_phone: "electronics", computer: "electronics",
  appliance: "electronics", books: "books", stationery: "books", furniture: "furniture", doityourself: "furniture",
  hardware: "furniture", optician: "optician", hairdresser: "beauty", beauty: "beauty", cosmetics: "beauty",
  sports: "sports", toys: "toys", butcher: "butcher",
};
function category(t) {
  const a = t.amenity;
  if (a === "pharmacy") return "pharmacy";
  if (a === "cafe") return "cafe";
  if (a === "restaurant" || a === "fast_food") return "restaurant";
  if (a === "bank") return "bank";
  if (["clinic", "hospital", "doctors", "dentist"].includes(a)) return "clinic";
  return SHOP[t.shop] || "shop";
}
// Real OSM wheelchair tags are kept as-is; wheelchair=limited is left unknown on purpose.
function features(t) {
  const f = [];
  if (t.wheelchair === "yes" || t.wheelchair === "designated") f.push(["step_free", "yes"]);
  if (t.wheelchair === "no") f.push(["step_free", "no"]);
  if (t["toilets:wheelchair"] === "yes") f.push(["restroom", "yes"]);
  if (t["toilets:wheelchair"] === "no") f.push(["restroom", "no"]);
  if (t.ramp === "yes" || t["ramp:wheelchair"] === "yes") f.push(["ramp", "yes"]);
  if (t.door === "automatic") f.push(["auto_door", "yes"]);
  return f;
}

// One INSERT per tile (fast even over the internet). Exported so it can be tested.
export async function saveBatch(client, elements, opts = {}) {
  const rows = [];
  for (const el of elements) {
    if (el.type === "relation") continue;
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null || !t.name) continue;
    const isAr = /[\u0600-\u06FF]/.test(t.name);
    const street = t["addr:street"];
    rows.push({
      osm: el.type === "node" ? el.id : -el.id, // ways are stored as negative ids
      ar: t["name:ar"] || (isAr ? t.name : null), en: t["name:en"] || (isAr ? null : t.name),
      cat: category(t), lat, lng,
      aAr: t["addr:street:ar"] || street || null, aEn: t["addr:street:en"] || street || null,
      phone: t.phone || t["contact:phone"] || null, hours: t.opening_hours || null, feats: features(t),
    });
  }
  if (!rows.length) return 0;
  const col = (k) => rows.map((r) => r[k]);
  const { rows: ids } = await client.query(
    `INSERT INTO venues (osm_id,name_ar,name_en,category,location,address_ar,address_en,phone,hours,source)
     SELECT x.osm, x.ar, x.en, x.cat, ST_SetSRID(ST_MakePoint(x.lng,x.lat),4326)::geography, x.a_ar, x.a_en, x.phone,
            CASE WHEN x.hours IS NULL THEN NULL ELSE to_jsonb(x.hours) END, 'osm'
       FROM unnest($1::bigint[],$2::text[],$3::text[],$4::text[],$5::float8[],$6::float8[],$7::text[],$8::text[],$9::text[],$10::text[])
            AS x(osm,ar,en,cat,lat,lng,a_ar,a_en,phone,hours)
     ON CONFLICT (osm_id) DO UPDATE SET name_ar=EXCLUDED.name_ar, name_en=EXCLUDED.name_en, category=EXCLUDED.category
     RETURNING id, osm_id`,
    [col("osm"), col("ar"), col("en"), col("cat"), col("lat"), col("lng"), col("aAr"), col("aEn"), col("phone"), col("hours")]);
  const idOf = new Map(ids.map((r) => [String(r.osm_id), r.id]));
  const av = [], af = [], as = [];
  for (const r of rows) for (const [f, s] of r.feats) { av.push(idOf.get(String(r.osm))); af.push(f); as.push(s); }
  if (av.length)   // DO NOTHING so re-imports never overwrite community answers
    await client.query(
      `INSERT INTO accessibility_attributes (venue_id,feature,state,confidence)
       SELECT v::uuid, f::feature_key, s::feature_state, 0 FROM unnest($1::text[],$2::text[],$3::text[]) AS x(v,f,s)
       ON CONFLICT DO NOTHING`, [av, af, as]);
  // Give the new places sample features right away (needs fill_sample_access from sample-access.sql)
  if (opts.sample) await client.query("SELECT fill_sample_access($1::uuid[])", [ids.map((r) => r.id)]);
  return rows.length;
}

async function fetchTile(tile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "accessible-egypt-importer/1.0 (community accessibility map)", Accept: "*/*" },
        body: "data=" + encodeURIComponent(query(tile)),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 150).replace(/\s+/g, " ")}`);
      const json = JSON.parse(text);
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error("Overpass says: " + json.remark.slice(0, 150));
      return json;
    } catch (err) {
      console.warn(`  [${new URL(url).host}] ${err.cause?.code || ""} ${err.message}`);
      await sleep(8000 * (attempt + 1));
    }
  }
  return null;
}

// Too big or busy? Split the tile into 4 and retry (up to 3 levels).
async function processTile(tile, depth = 0) {
  const json = await fetchTile(tile);
  if (!json) {
    if (depth >= 3) { console.warn("  giving up on tile", tile.join(",")); return 0; }
    const [s, w, n, e] = tile, ms = (s + n) / 2, mw = (w + e) / 2;
    console.log(`  splitting tile ${tile.map((x) => x.toFixed(2)).join(",")} into 4`);
    let sum = 0;
    for (const t of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) sum += await processTile(t, depth + 1);
    return sum;
  }
  if (!json.elements?.length) { await sleep(2000); return 0; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const n = await saveBatch(client, json.elements, { sample: SAMPLE });
    await client.query("COMMIT");
    console.log(`tile ${tile.map((x) => x.toFixed(2)).join(",")}: ${n} places`);
    return n;
  } catch (err) {
    await client.query("ROLLBACK"); console.error("  database error:", err.message); return 0;
  } finally { client.release(); }
}

async function main() {
  try { await pool.query("select 1"); console.log("Database connection OK"); }
  catch (err) { console.error("Cannot connect to the database:", err.message); process.exit(1); }
  if (process.env.SAMPLE !== "0") {
    const { rows } = await pool.query("select to_regproc('fill_sample_access') is not null as ok");
    SAMPLE = rows[0].ok;
    console.log(SAMPLE ? "Sample accessibility features: ON" : "NOTE: run sample-access.sql in Supabase first, so new places get features automatically.");
  }
  const only = process.env.ONLY || "all";
  const box = PRESETS[only] || EGYPT;
  let total = 0;
  for (const tile of tiles(box, PRESETS[only] ? 0.2 : 0.5)) { total += await processTile(tile); await sleep(3000); }
  await pool.end();
  console.log("Done:", total, "places imported");
}
if (process.env.IMPORT_TEST !== "1") await main();
