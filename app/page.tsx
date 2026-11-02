"use client";
/**
 * app/page.tsx — Accessible Egypt main screen
 * Deps: npm i maplibre-gl   (OSM raster tiles, no API key; swap style for Mapbox/Google later)
 * Tailwind: v3.3+ (logical utilities ms-/me-/ps-/pe-/text-start work for RTL)
 * Add to app/layout.tsx:  import "maplibre-gl/dist/maplibre-gl.css";
 * Fonts: load "IBM Plex Sans Arabic" + "IBM Plex Sans" with next/font.
 * API: GET /api/venues?lat&lng&r&q&features=a,b  -> Venue[]  (falls back to DEMO data)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

type Lang = "ar" | "en";
type FeatureKey = "step_free" | "ramp" | "elevator" | "ground_floor" | "restroom" | "parking";
type Venue = {
  id: string; name_ar: string; name_en: string; category: string;
  lat: number; lng: number; address_ar: string; address_en: string;
  phone?: string; hours?: string;
  confidence: 0 | 1 | 2 | 3;           // 0 imported · 1 reported · 2 community-confirmed · 3 audited
  features: Partial<Record<FeatureKey, "yes" | "no">>;  // missing = unknown
  distance_m?: number;
};

const T = {
  ar: {
    title: "الوصول للجميع", search: "ابحث عن مكان أو منطقة (مثال: معادي)", locate: "حدد موقعي",
    gov: "المحافظة", filters: "مواصفات الوصول", results: "نتيجة", none: "لا توجد نتائج. جرّب إزالة بعض الفلاتر أو أضف مكانًا.",
    unknown: "غير معروف", verified: ["مستورد", "بلاغ مستخدم", "مؤكد من المجتمع", "تم التدقيق"],
    report: "أبلغ عن مدخل هذا المكان", call: "اتصل", lang: "English", m: "م", map: "الخريطة", list: "القائمة",
    geoFail: "تعذر تحديد موقعك. اختر المحافظة يدويًا.", loadFail: "تعذر تحميل البيانات الحية. نعرض بيانات تجريبية.",
  },
  en: {
    title: "Access For All", search: "Search a place or area (e.g. Maadi)", locate: "Use my location",
    gov: "Governorate", filters: "Access features", results: "results", none: "No results. Try removing a filter or add a place.",
    unknown: "Unknown", verified: ["Imported", "User report", "Community confirmed", "Audited"],
    report: "Report this entrance", call: "Call", lang: "العربية", m: "m", map: "Map", list: "List",
    geoFail: "Couldn't get your location. Pick a governorate instead.", loadFail: "Couldn't load live data. Showing demo data.",
  },
} as const;

const FEATURES: { key: FeatureKey; ar: string; en: string; icon: string }[] = [
  { key: "step_free", ar: "مدخل بدون درجات", en: "Step-free entrance", icon: "⬌" },
  { key: "ramp", ar: "منحدر / رامب", en: "Ramp", icon: "◢" },
  { key: "elevator", ar: "مصعد واسع", en: "Wide elevator", icon: "⇕" },
  { key: "ground_floor", ar: "دور أرضي", en: "Ground floor", icon: "▁" },
  { key: "restroom", ar: "دورة مياه مجهزة", en: "Accessible restroom", icon: "♿" },
  { key: "parking", ar: "موقف سيارات مجهز", en: "Accessible parking", icon: "P" },
];

const GOVS = [
  { id: "cairo", ar: "القاهرة", en: "Cairo", c: [31.2357, 30.0444] },
  { id: "giza", ar: "الجيزة", en: "Giza", c: [31.2089, 30.0131] },
  { id: "alex", ar: "الإسكندرية", en: "Alexandria", c: [29.9187, 31.2001] },
] as const;

// Neighbourhood aliases so Arabic and Latin input hit the same place (normalised form).
const ALIASES: Record<string, string[]> = {
  maadi: ["معادي", "المعادي", "maadi", "el maadi"],
  downtown: ["وسط البلد", "downtown", "bab el louk", "باب اللوق"],
  nasrcity: ["مدينه نصر", "nasr city"],
  newcairo: ["القاهره الجديده", "new cairo", "التجمع"],
  zayed: ["الشيخ زايد", "sheikh zayed"],
};

/** Normalise Arabic/Latin: strip diacritics & tatweel, unify alef/ya/ta-marbuta, Arabic digits -> ASCII. */
const norm = (s: string) =>
  s.toLowerCase().trim()
    .replace(/[\u064B-\u065F\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/\s+/g, " ");

const expandQuery = (q: string): string[] => {
  const n = norm(q);
  if (!n) return [];
  const group = Object.values(ALIASES).find((g) => g.some((a) => norm(a).includes(n) || n.includes(norm(a))));
  return group ? group.map(norm) : [n];
};

const DEMO: Venue[] = [
  { id: "1", name_ar: "صيدلية العزبي", name_en: "El Ezaby Pharmacy", category: "pharmacy", lat: 29.9602, lng: 31.2569,
    address_ar: "شارع 9، المعادي", address_en: "Street 9, Maadi", phone: "19600", hours: "24/7", confidence: 2,
    features: { step_free: "yes", ground_floor: "yes", ramp: "no" } },
  { id: "2", name_ar: "كافيه ريفييرا", name_en: "Riviera Café", category: "cafe", lat: 30.0459, lng: 31.2395,
    address_ar: "باب اللوق، وسط البلد", address_en: "Bab El Louk, Downtown", hours: "10:00–00:00", confidence: 1,
    features: { ramp: "yes", step_free: "yes", restroom: "no" } },
  { id: "3", name_ar: "مركز سيتي ستارز - مدخل 2", name_en: "City Stars – Gate 2", category: "mall", lat: 30.0728, lng: 31.3459,
    address_ar: "مدينة نصر", address_en: "Nasr City", confidence: 3,
    features: { step_free: "yes", elevator: "yes", restroom: "yes", parking: "yes", ground_floor: "yes" } },
];

export default function Home() {
  const [lang, setLang] = useState<Lang>("ar");
  const [query, setQuery] = useState("");
  const [gov, setGov] = useState<string>("cairo");
  const [active, setActive] = useState<Set<FeatureKey>>(new Set());
  const [venues, setVenues] = useState<Venue[]>(DEMO);
  const [center, setCenter] = useState<[number, number]>([31.2357, 30.0444]);
  const [selected, setSelected] = useState<Venue | null>(null);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"list" | "map">("list"); // mobile toggle
  const t = T[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  // Keep <html lang dir> in sync so screen readers switch voices and layout mirrors.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    try { localStorage.setItem("lang", lang); } catch {}
  }, [lang, dir]);
  useEffect(() => {
    try { const s = localStorage.getItem("lang"); if (s === "en" || s === "ar") setLang(s); } catch {}
  }, []);

  const toggleFeature = (k: FeatureKey) =>
    setActive((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // Fetch from API (debounced); fall back to demo data so the template runs standalone.
  useEffect(() => {
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          lat: String(center[1]), lng: String(center[0]), r: "15000",
          q: query, features: [...active].join(","),
        });
        const res = await fetch(`/api/venues?${qs}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error();
        setVenues(await res.json());
        setNotice("");
      } catch (e: any) {
        if (e?.name !== "AbortError") { setVenues(DEMO); setNotice(t.loadFail); }
      }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [center, query, active, t.loadFail]);

  // Client-side filtering too (instant feedback + demo mode). "Unknown" never counts as a match.
  const shown = useMemo(() => {
    const terms = expandQuery(query);
    return venues.filter((v) => {
      const okFeat = [...active].every((k) => v.features[k] === "yes");
      const hay = norm(`${v.name_ar} ${v.name_en} ${v.address_ar} ${v.address_en}`);
      const okQ = !terms.length || terms.some((x) => hay.includes(x));
      return okFeat && okQ;
    });
  }, [venues, active, query]);

  const locate = useCallback(() => {
    if (!navigator.geolocation) return setNotice(t.geoFail);
    navigator.geolocation.getCurrentPosition(
      (p) => { setCenter([p.coords.longitude, p.coords.latitude]); setNotice(""); },
      () => setNotice(t.geoFail),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, [t.geoFail]);

  const pickGov = (id: string) => {
    setGov(id);
    const g = GOVS.find((x) => x.id === id)!;
    setCenter([g.c[0], g.c[1]]);
  };

  // ---- Map ----
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    map.current = new maplibregl.Map({
      container: mapEl.current,
      center, zoom: 13,
      style: {
        version: 8,
        sources: { osm: { type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    return () => { map.current?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { map.current?.flyTo({ center, zoom: 13 }); }, [center]);

  useEffect(() => {
    markers.current.forEach((m) => m.remove());
    markers.current = shown.map((v) => {
      const el = document.createElement("button");
      el.type = "button";
      el.setAttribute("aria-label", lang === "ar" ? v.name_ar : v.name_en);
      el.className =
        "h-11 w-11 rounded-full border-[3px] border-white bg-[#0B3D91] text-white text-lg font-bold shadow-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FFC400]";
      el.textContent = "♿";
      el.onclick = () => setSelected(v);
      return new maplibregl.Marker({ element: el }).setLngLat([v.lng, v.lat]).addTo(map.current!);
    });
  }, [shown, lang]);

  useEffect(() => { if (view === "map") setTimeout(() => map.current?.resize(), 50); }, [view]);

  const name = (v: Venue) => (lang === "ar" ? v.name_ar : v.name_en);
  const addr = (v: Venue) => (lang === "ar" ? v.address_ar : v.address_en);

  return (
    <div dir={dir} lang={lang} className="min-h-screen bg-white text-[#0A0A0A] text-[18px] leading-relaxed"
         style={{ fontFamily: lang === "ar" ? "'IBM Plex Sans Arabic', system-ui" : "'IBM Plex Sans', system-ui" }}>
      <a href="#results" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-[#FFC400] focus:p-3">
        {lang === "ar" ? "تخطَّ إلى النتائج" : "Skip to results"}
      </a>

      <header className="bg-[#0B3D91] text-white px-4 py-3 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <button onClick={() => setLang(lang === "ar" ? "en" : "ar")}
          className="min-h-[48px] min-w-[48px] px-4 rounded-lg bg-white text-[#0B3D91] font-bold focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]"
          lang={lang === "ar" ? "en" : "ar"}>
          {t.lang}
        </button>
      </header>

      <main className="mx-auto max-w-7xl p-4 grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <section aria-label={t.filters} className="space-y-4">
          <form role="search" onSubmit={(e) => e.preventDefault()} className="space-y-3">
            <label htmlFor="q" className="sr-only">{t.search}</label>
            <input id="q" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={t.search} inputMode="search" autoComplete="off"
              className="w-full min-h-[52px] rounded-lg border-2 border-[#0A0A0A] px-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]" />
            <div className="flex gap-2">
              <label htmlFor="gov" className="sr-only">{t.gov}</label>
              <select id="gov" value={gov} onChange={(e) => pickGov(e.target.value)}
                className="flex-1 min-h-[52px] rounded-lg border-2 border-[#0A0A0A] px-3 bg-white">
                {GOVS.map((g) => <option key={g.id} value={g.id}>{lang === "ar" ? g.ar : g.en}</option>)}
              </select>
              <button type="button" onClick={locate}
                className="min-h-[52px] px-4 rounded-lg bg-[#0A0A0A] text-white font-semibold focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]">
                {t.locate}
              </button>
            </div>
          </form>

          <fieldset>
            <legend className="font-bold mb-2">{t.filters}</legend>
            <div className="flex flex-wrap gap-2">
              {FEATURES.map((f) => {
                const on = active.has(f.key);
                return (
                  <button key={f.key} type="button" aria-pressed={on} onClick={() => toggleFeature(f.key)}
                    className={`min-h-[48px] px-4 rounded-full border-2 font-semibold flex items-center gap-2 focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400] ${
                      on ? "bg-[#0B3D91] text-white border-[#0B3D91]" : "bg-white text-[#0A0A0A] border-[#0A0A0A]"}`}>
                    <span aria-hidden="true">{on ? "✓" : f.icon}</span>{lang === "ar" ? f.ar : f.en}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="lg:hidden flex gap-2" role="group">
            {(["list", "map"] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}
                className={`flex-1 min-h-[48px] rounded-lg border-2 font-semibold ${view === v ? "bg-[#0A0A0A] text-white" : "border-[#0A0A0A]"}`}>
                {t[v]}
              </button>
            ))}
          </div>

          <p role="status" aria-live="polite" className="font-semibold">
            {shown.length} {t.results} {notice && <span className="block text-[#8A1C00]">{notice}</span>}
          </p>

          <ul id="results" className={`space-y-3 ${view === "map" ? "hidden lg:block" : ""}`}>
            {shown.length === 0 && <li className="p-4 border-2 border-dashed border-[#0A0A0A] rounded-lg">{t.none}</li>}
            {shown.map((v) => (
              <li key={v.id}>
                <button onClick={() => { setSelected(v); map.current?.flyTo({ center: [v.lng, v.lat], zoom: 16 }); }}
                  className="w-full text-start p-4 rounded-lg border-2 border-[#0A0A0A] hover:bg-[#F2F6FF] focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]">
                  <span className="block font-bold">{name(v)}</span>
                  <span className="block text-[#333]">{addr(v)}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {FEATURES.map((f) => {
                      const s = v.features[f.key];
                      return (
                        <span key={f.key} className={`px-2 py-0.5 rounded text-sm font-semibold ${
                          s === "yes" ? "bg-[#0B6B2E] text-white" : s === "no" ? "bg-[#8A1C00] text-white" : "bg-[#E6E6E6] text-[#0A0A0A]"}`}>
                          {lang === "ar" ? f.ar : f.en}: {s === "yes" ? "✓" : s === "no" ? "✗" : "?"}
                          <span className="sr-only"> {s ? "" : t.unknown}</span>
                        </span>
                      );
                    })}
                  </span>
                  <span className="mt-1 block text-sm">{t.verified[v.confidence]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label={t.map} className={`${view === "list" ? "hidden lg:block" : ""} relative`}>
          <div ref={mapEl} className="h-[70vh] lg:h-[calc(100vh-7rem)] rounded-lg border-2 border-[#0A0A0A]" />
          {selected && (
            <aside aria-live="polite" className="absolute bottom-3 inset-x-3 bg-white border-2 border-[#0A0A0A] rounded-lg p-4 shadow-xl">
              <div className="flex justify-between gap-2">
                <h2 className="font-bold text-xl">{name(selected)}</h2>
                <button onClick={() => setSelected(null)} aria-label={lang === "ar" ? "إغلاق" : "Close"}
                  className="min-h-[44px] min-w-[44px] text-2xl">×</button>
              </div>
              <p>{addr(selected)}</p>
              {selected.hours && <p>{selected.hours}</p>}
              <div className="mt-3 flex gap-2">
                {selected.phone && <a href={`tel:${selected.phone}`} className="min-h-[48px] px-4 py-2 rounded-lg bg-[#0B3D91] text-white font-semibold">{t.call} {selected.phone}</a>}
                <a href={`/venues/${selected.id}/report`} className="min-h-[48px] px-4 py-2 rounded-lg border-2 border-[#0A0A0A] font-semibold">{t.report}</a>
              </div>
            </aside>
          )}
        </section>
      </main>
    </div>
  );
}
