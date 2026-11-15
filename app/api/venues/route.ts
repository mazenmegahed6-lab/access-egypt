// app/api/venues/route.ts
// GET /api/venues?bbox=w,s,e,n&z=ZOOM&lat=CENTER_LAT&lng=CENTER_LNG&q=&category=&features=a,b
//  - zoomed out  -> mode "clusters": grid counts for the whole visible area + the 60 nearest places for the list
//  - zoomed in   -> mode "points":   up to 600 places in view
//  - q (text)    -> searches ALL of Egypt (up to 300 matches nearest to the map centre)
// npm i pg   |   env: DATABASE_URL
import { NextResponse } from "next/server";
import { Pool } from "pg";

const ssl = process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined;
const pool = (globalThis as any).__pool ?? ((globalThis as any).__pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl }));
const FEATURES = ["step_free", "ramp", "elevator", "ground_floor", "restroom", "parking", "auto_door", "wide_aisles", "low_counter"];
const EGYPT = [24, 21, 37.5, 32]; // w,s,e,n

// Same Arabic normalisation as the client, so "المعادي" and "معادي" match the same rows.
const norm = (s: string) =>
  s.toLowerCase().trim().replace(/[\u064B-\u065F\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

async function handle(req: Request) {
  const p = new URL(req.url).searchParams;
  const parsed = (p.get("bbox") || "").split(",").map(Number);
  const bbox = parsed.length === 4 && parsed.every(Number.isFinite) ? parsed : EGYPT;
  const z = Number(p.get("z")) || 5;
  const clat = Number(p.get("lat")) || (bbox[1] + bbox[3]) / 2;
  const clng = Number(p.get("lng")) || (bbox[0] + bbox[2]) / 2;
  const q = norm(p.get("q") || "");
  const category = (p.get("category") || "").replace(/[^a-z_]/g, "");
  const wanted = (p.get("features") || "").split(",").filter((f) => FEATURES.includes(f)); // whitelist

  // Builds a fresh WHERE clause + parameter list for each query.
  const build = () => {
    const vals: any[] = [], conds: string[] = [];
    const ph = (v: any) => { vals.push(v); return `$${vals.length}`; };
    if (!q) conds.push(`v.location && ST_MakeEnvelope(${ph(bbox[0])},${ph(bbox[1])},${ph(bbox[2])},${ph(bbox[3])},4326)::geography`);
    else conds.push(`translate(lower(coalesce(v.name_ar,'')||' '||coalesce(v.name_en,'')||' '||coalesce(v.address_ar,'')||' '||coalesce(v.address_en,'')), 'أإآىة', 'ااايه') LIKE '%'||${ph(q)}||'%'`);
    if (category) conds.push(`v.category = ${ph(category)}`);
    if (wanted.length)
      conds.push(`v.id IN (SELECT venue_id FROM accessibility_attributes WHERE feature::text = ANY(${ph(wanted)}::text[]) AND state = 'yes' GROUP BY venue_id HAVING count(*) = ${wanted.length})`);
    return { vals, ph, where: "WHERE " + conds.join(" AND ") };
  };

  const items = async (limit: number) => {
    const b = build();
    const cpt = `ST_SetSRID(ST_MakePoint(${b.ph(clng)},${b.ph(clat)}),4326)::geography`;
    const { rows } = await pool.query(
      `SELECT v.id, v.name_ar, v.name_en, v.category, v.address_ar, v.address_en, v.phone, v.hours,
              ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lng,
              COALESCE((SELECT max(confidence) FROM accessibility_attributes a WHERE a.venue_id = v.id), 0) AS confidence,
              COALESCE((SELECT jsonb_object_agg(a.feature, a.state) FROM accessibility_attributes a
                        WHERE a.venue_id = v.id AND a.state <> 'unknown'), '{}') AS features
         FROM venues v ${b.where}
        ORDER BY v.location <-> ${cpt}
        LIMIT ${limit}`, b.vals);
    return rows.map((r: any) => ({ ...r, confidence: Number(r.confidence),
      name_ar: r.name_ar ?? r.name_en, name_en: r.name_en ?? r.name_ar,
      address_ar: r.address_ar ?? "", address_en: r.address_en ?? "" }));
  };

  if (!q && z < 12) {
    const step = 84.4 / Math.pow(2, z);          // ~60 px grid cell at this zoom
    const b = build();
    const { rows } = await pool.query(
      `SELECT ST_Y(ST_Centroid(ST_Collect(v.location::geometry))) AS lat,
              ST_X(ST_Centroid(ST_Collect(v.location::geometry))) AS lng, count(*)::int AS count
         FROM venues v ${b.where}
        GROUP BY ST_SnapToGrid(v.location::geometry, ${step})`, b.vals);
    const total = rows.reduce((s: number, r: any) => s + r.count, 0);
    return NextResponse.json({ mode: "clusters", total, clusters: rows, items: await items(60) });
  }
  const list = await items(q ? 300 : 600);
  return NextResponse.json({ mode: "points", total: list.length, clusters: [], items: list });
}

// Wrapper: show the real database error as JSON instead of a blank "page isn't working".
export async function GET(req: Request) {
  if (!process.env.DATABASE_URL)
    return NextResponse.json({ error: "DATABASE_URL is not set on the server" }, { status: 500 });
  try {
    return await handle(req);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e), code: e?.code ?? null }, { status: 500 });
  }
}
