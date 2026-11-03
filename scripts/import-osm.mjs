// scripts/import-osm.mjs — pull named places across Egypt from OpenStreetMap into PostGIS.
// Run once after schema.sql:   npm i pg   &&   DATABASE_URL=postgres://... node scripts/import-osm.mjs
// Optional: ONLY=cairo node scripts/import-osm.mjs   (cairo | alex | all, default all)
// Data © OpenStreetMap contributors (ODbL). Keep the attribution in the app footer/map.
import pg from "pg";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const ssl = process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl });

// Egypt is large, so we query 1°x1° tiles and skip empty ones. [south, west, north, east]
const EGYPT = [22.0, 25.0, 31.7, 36.9];
const PRESETS = {
  cairo: [29.75, 30.85, 30.25, 31.70],
  alex: [30.95, 29.60, 31.40, 30.20],
};
function tiles(box, step = 0.5) {
  const [s, w, n, e] = box, out = [];
  for (let la = s; la < n; la += step)
    for (let lo = w; lo < e; lo += step)
      out.push([la, lo, Math.min(la + step, n), Math.min(lo + step, e)]);
  return out;
}

const query = ([s, w, n, e]) => `[out:json][timeout:180];
(
  nwr["name"]["amenity"~"^(pharmacy|cafe|restaurant|fast_food|bank|clinic|hospital|doctors|dentist)$"](${s},${w},${n},${e});
  nwr["name"]["shop"](${s},${w},${n},${e});
);
out center tags;`;

// Map OpenStreetMap tags to the app's categories (all kinds of shops, no towns or landmarks).
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

// wheelchair=yes -> step_free yes; =no -> step_free no; =limited -> left unknown on purpose.
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

async function save(client, el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return;
  const osmId = el.type === "node" ? el.id : -el.id;   // ways stored as negative ids; relations skipped below
  if (el.type === "relation") return;
  const nameAr = t["name:ar"] || (/[\u0600-\u06FF]/.test(t.name) ? t.name : null);
  const nameEn = t["name:en"] || (/[\u0600-\u06FF]/.test(t.name) ? null : t.name);
  const street = t["addr:street"];
  const { rows } = await client.query(
    `INSERT INTO venues (osm_id,name_ar,name_en,category,location,address_ar,address_en,phone,hours,source)
     VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,$10::jsonb,'osm')
     ON CONFLICT (osm_id) DO UPDATE SET name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,category=EXCLUDED.category
     RETURNING id`,
    [osmId, nameAr, nameEn, category(t), lng, lat,
     t["addr:street:ar"] || street || null, t["addr:street:en"] || street || null,
     t.phone || t["contact:phone"] || null,
     t.opening_hours ? JSON.stringify(t.opening_hours) : null]
  );
  for (const [feature, state] of features(t)) {
    // DO NOTHING so we never overwrite community-verified answers on re-import.
    await client.query(
      `INSERT INTO accessibility_attributes (venue_id,feature,state,confidence)
       VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`, [rows[0].id, feature, state]);
  }
}

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Overpass for one tile. Tries each mirror in turn and prints the REAL reason when one fails.
async function fetchTile(tile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "accessible-egypt-importer/1.0 (community accessibility map)",
          Accept: "*/*",
        },
        body: "data=" + encodeURIComponent(query(tile)),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 150).replace(/\s+/g, " ")}`);
      const json = JSON.parse(text);
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark))
        throw new Error("Overpass says: " + json.remark.slice(0, 150));
      return json;
    } catch (err) {
      console.warn(`  [${new URL(url).host}] ${err.cause?.code || ""} ${err.message}`);
      await sleep(8000 * (attempt + 1));
    }
  }
  return null;
}

// If a tile is too big/busy, split it into 4 smaller tiles and try again (up to 3 levels).
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
  if (!json.elements?.length) { await sleep(3000); return 0; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const el of json.elements) await save(client, el);
    await client.query("COMMIT");
    console.log(`tile ${tile.map((x) => x.toFixed(2)).join(",")}: ${json.elements.length} places`);
    return json.elements.length;
  } catch (err) {
    await client.query("ROLLBACK"); console.error("  database error:", err.message); return 0;
  } finally { client.release(); }
}

// Check the database first so a DB problem isn't mistaken for a network problem.
try { await pool.query("select 1"); console.log("Database connection OK"); }
catch (err) { console.error("Cannot connect to the database:", err.message); process.exit(1); }

const only = process.env.ONLY || "all";
const box = PRESETS[only] || EGYPT;
let total = 0;
for (const tile of tiles(box, PRESETS[only] ? 0.2 : 0.5)) {
  total += await processTile(tile);
  await sleep(4000);   // be polite to the free Overpass servers
}
await pool.end();
console.log("Done:", total, "places imported");
