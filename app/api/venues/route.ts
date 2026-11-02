// app/api/venues/route.ts — GET /api/venues?lat&lng&r&q&features=a,b
// npm i pg   |   env: DATABASE_URL
import { NextResponse } from "next/server";
import { Pool } from "pg";

const ssl = process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined;
const pool = (globalThis as any).__pool ?? ((globalThis as any).__pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl }));
const FEATURES = ["step_free", "ramp", "elevator", "ground_floor", "restroom", "parking", "auto_door", "wide_aisles", "low_counter"];

// Same Arabic normalisation as the client, so "المعادي" and "معادي" match the same rows.
const norm = (s: string) =>
  s.toLowerCase().trim().replace(/[\u064B-\u065F\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NextResponse.json({ error: "lat/lng required" }, { status: 400 });
  const radius = Math.min(Number(p.get("r")) || 5000, 25000);                 // cap at 25 km
  const q = norm(p.get("q") || "");
  const wanted = (p.get("features") || "").split(",").filter((f) => FEATURES.includes(f)); // whitelist

  const { rows } = await pool.query(
    `SELECT v.id, v.name_ar, v.name_en, v.category, v.address_ar, v.address_en, v.phone, v.hours,
            ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lng,
            ST_Distance(v.location, ST_MakePoint($2,$1)::geography) AS distance_m,
            COALESCE((SELECT max(confidence) FROM accessibility_attributes a WHERE a.venue_id = v.id), 0) AS confidence,
            COALESCE((SELECT jsonb_object_agg(a.feature, a.state) FROM accessibility_attributes a
                      WHERE a.venue_id = v.id AND a.state <> 'unknown'), '{}') AS features
       FROM venues v
      WHERE ST_DWithin(v.location, ST_MakePoint($2,$1)::geography, $3)
        AND ($4 = '' OR translate(lower(coalesce(v.name_ar,'')||' '||coalesce(v.name_en,'')||' '||
                 coalesce(v.address_ar,'')||' '||coalesce(v.address_en,'')), 'أإآىة', 'ااايه') LIKE '%'||$4||'%')
        AND (SELECT count(*) FROM accessibility_attributes a
              WHERE a.venue_id = v.id AND a.feature::text = ANY($5::text[]) AND a.state = 'yes') = cardinality($5::text[])
      ORDER BY distance_m
      LIMIT 200`,
    [lat, lng, radius, q, wanted]
  );
  return NextResponse.json(
    rows.map((r: any) => ({ ...r, confidence: Number(r.confidence), distance_m: Math.round(r.distance_m),
                       name_ar: r.name_ar ?? r.name_en, name_en: r.name_en ?? r.name_ar,
                       address_ar: r.address_ar ?? "", address_en: r.address_en ?? "" }))
  );
}
