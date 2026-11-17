"use client";
/**
 * app/page.tsx — Accessible Egypt
 * Shows every place in the map view (zoomed out = clusters with counts, zoomed in = individual places).
 * Deps: npm i maplibre-gl pg   |   layout.tsx: import "maplibre-gl/dist/maplibre-gl.css";
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

type Lang = "ar" | "en";
type FeatureKey = "step_free" | "ramp" | "elevator" | "ground_floor" | "restroom" | "parking" | "auto_door" | "wide_aisles" | "low_counter";
type Venue = {
  id: string; name_ar: string; name_en: string; category: string; lat: number; lng: number;
  address_ar: string; address_en: string; phone?: string | null; hours?: unknown;
  confidence: 0 | 1 | 2 | 3; features: Partial<Record<FeatureKey, "yes" | "no">>;
};
type Cluster = { lat: number; lng: number; count: number };
type Viewport = { w: number; s: number; e: number; n: number; z: number; clat: number; clng: number };

const T = {
  ar: {
    title: "الوصول للجميع", search: "ابحث باسم المكان أو المنطقة (مثال: معادي)", locate: "حدد موقعي", area: "المنطقة / المحافظة",
    egypt: "كل مصر", filters: "مواصفات الوصول", results: "مكان", none: "لا توجد أماكن هنا. حرّك الخريطة أو أزل بعض الفلاتر.",
    zoomIn: "قرّب الخريطة لرؤية كل مكان", nearest: "الأقرب إلى مركز الخريطة", loading: "جارٍ التحميل…",
    verified: ["مستورد", "بلاغ مستخدم", "مؤكد من المجتمع", "تم التدقيق"], call: "اتصل", lang: "English", map: "الخريطة", list: "القائمة",
    geoFail: "تعذر تحديد موقعك. اختر المنطقة يدويًا.", loadFail: "تعذر تحميل الأماكن. تحقق من الاتصال وأعد المحاولة.",
    dir: "الاتجاهات", gmaps: "افتح في خرائط جوجل", route: "المسار", walk: "مشيًا", km: "كم", min: "دقيقة",
    routeFail: "تعذر حساب المسار. جرّب خرائط جوجل.", locating: "جارٍ تحديد موقعك…", clear: "إلغاء المسار",
    routeNote: "قد يتضمن المسار سلالم أو أرصفة غير مناسبة. راجع ملاحظات الوصول قبل الذهاب.",
    cat: "الفئة", allCat: "كل الفئات", close: "إغلاق", skip: "تخطَّ إلى النتائج",
    footer: "تفاصيل الوصول المعروضة بيانات عينة لمشروع طلابي · الخرائط © مساهمو OpenStreetMap",
  },
  en: {
    title: "Access For All", search: "Search a place name or area (e.g. Maadi)", locate: "Use my location", area: "Area / governorate",
    egypt: "All of Egypt", filters: "Access features", results: "places", none: "No places here. Move the map or remove a filter.",
    zoomIn: "Zoom in to see each place", nearest: "Nearest to the map centre", loading: "Loading…",
    verified: ["Imported", "User report", "Community confirmed", "Audited"], call: "Call", lang: "العربية", map: "Map", list: "List",
    geoFail: "Couldn't get your location. Pick an area instead.", loadFail: "Couldn't load places. Check your connection and try again.",
    dir: "Directions", gmaps: "Open in Google Maps", route: "Route", walk: "walking", km: "km", min: "min",
    routeFail: "Couldn't calculate the route. Try Google Maps.", locating: "Finding your location…", clear: "Clear route",
    routeNote: "The route may include stairs or uneven pavement. Check the access notes before you go.",
    cat: "Category", allCat: "All categories", close: "Close", skip: "Skip to results",
    footer: "Accessibility details shown are sample data for a student project · Map © OpenStreetMap contributors",
  },
} as const;

const FEATURES: { key: FeatureKey; ar: string; en: string; icon: string }[] = [
  { key: "step_free", ar: "مدخل بدون درجات", en: "Step-free entrance", icon: "⬌" },
  { key: "ramp", ar: "منحدر / رامب", en: "Ramp", icon: "◢" },
  { key: "elevator", ar: "مصعد واسع", en: "Wide elevator", icon: "⇕" },
  { key: "ground_floor", ar: "دور أرضي", en: "Ground floor", icon: "▁" },
  { key: "restroom", ar: "دورة مياه مجهزة", en: "Accessible restroom", icon: "♿" },
  { key: "parking", ar: "موقف سيارات مجهز", en: "Accessible parking", icon: "P" },
  { key: "auto_door", ar: "باب أوتوماتيك", en: "Automatic door", icon: "⇥" },
  { key: "wide_aisles", ar: "ممرات واسعة", en: "Wide aisles", icon: "↔" },
  { key: "low_counter", ar: "كاونتر منخفض", en: "Lowered counter", icon: "▃" },
];

const CATS: Record<string, [string, string]> = {
  pharmacy: ["صيدلية", "Pharmacy"], supermarket: ["سوبرماركت", "Supermarket"], mall: ["مول", "Mall"],
  bakery: ["مخبز", "Bakery"], clothes: ["ملابس", "Clothes"], shoes: ["أحذية", "Shoes"],
  jewelry: ["مجوهرات", "Jewellery"], electronics: ["إلكترونيات", "Electronics"], books: ["مكتبة", "Books"],
  furniture: ["أثاث", "Furniture"], optician: ["نظارات", "Optician"], beauty: ["تجميل", "Beauty"],
  sports: ["رياضة", "Sports"], toys: ["ألعاب", "Toys"], butcher: ["جزارة", "Butcher"], shop: ["متجر", "Shop"],
  cafe: ["كافيه", "Café"], restaurant: ["مطعم", "Restaurant"], bank: ["بنك", "Bank"], clinic: ["عيادة", "Clinic"],
};

// Areas: all governorate capitals + main neighbourhoods.  c = [lng, lat]
const AREAS: { id: string; ar: string; en: string; c: [number, number]; alias?: string[] }[] = [
  { id: "cairo", ar: "القاهرة", en: "Cairo", c: [31.2357, 30.0444] },
  { id: "giza", ar: "الجيزة", en: "Giza", c: [31.2089, 30.0131] },
  { id: "alex", ar: "الإسكندرية", en: "Alexandria", c: [29.9187, 31.2001], alias: ["اسكندرية"] },
  { id: "maadi", ar: "المعادي", en: "Maadi", c: [31.2569, 29.9602], alias: ["معادي"] },
  { id: "downtown", ar: "وسط البلد", en: "Downtown", c: [31.2357, 30.0444], alias: ["باب اللوق", "bab el louk"] },
  { id: "nasrcity", ar: "مدينة نصر", en: "Nasr City", c: [31.33, 30.0728] },
  { id: "newcairo", ar: "القاهرة الجديدة", en: "New Cairo", c: [31.43, 30.029], alias: ["التجمع", "التجمع الخامس"] },
  { id: "heliopolis", ar: "مصر الجديدة", en: "Heliopolis", c: [31.3240, 30.091] },
  { id: "zamalek", ar: "الزمالك", en: "Zamalek", c: [31.22, 30.062] },
  { id: "mohandessin", ar: "المهندسين", en: "Mohandessin", c: [31.2, 30.056] },
  { id: "dokki", ar: "الدقي", en: "Dokki", c: [31.212, 30.038] },
  { id: "zayed", ar: "الشيخ زايد", en: "Sheikh Zayed", c: [30.971, 30.018] },
  { id: "october", ar: "6 أكتوبر", en: "6th of October", c: [30.92, 29.95] },
  { id: "smouha", ar: "سموحة", en: "Smouha", c: [29.95, 31.219] },
  { id: "raml", ar: "الرمل", en: "Raml", c: [29.915, 31.199] },
  { id: "qalyubia", ar: "بنها (القليوبية)", en: "Benha (Qalyubia)", c: [31.185, 30.466] },
  { id: "sharqia", ar: "الزقازيق (الشرقية)", en: "Zagazig (Sharqia)", c: [31.502, 30.5877] },
  { id: "mansoura", ar: "المنصورة (الدقهلية)", en: "Mansoura (Dakahlia)", c: [31.3807, 31.0364], alias: ["المنصورة"] },
  { id: "tanta", ar: "طنطا (الغربية)", en: "Tanta (Gharbia)", c: [31.0004, 30.7865], alias: ["طنطا"] },
  { id: "shebin", ar: "شبين الكوم (المنوفية)", en: "Shebin El Kom (Monufia)", c: [30.9876, 30.5972] },
  { id: "damanhur", ar: "دمنهور (البحيرة)", en: "Damanhur (Beheira)", c: [30.4682, 31.0341] },
  { id: "kafr", ar: "كفر الشيخ", en: "Kafr El Sheikh", c: [30.9388, 31.1107] },
  { id: "damietta", ar: "دمياط", en: "Damietta", c: [31.8133, 31.4165] },
  { id: "portsaid", ar: "بورسعيد", en: "Port Said", c: [32.3019, 31.2653] },
  { id: "ismailia", ar: "الإسماعيلية", en: "Ismailia", c: [32.2715, 30.5965] },
  { id: "suez", ar: "السويس", en: "Suez", c: [32.5498, 29.9668] },
  { id: "arish", ar: "العريش (شمال سيناء)", en: "Arish (North Sinai)", c: [33.7984, 31.1316] },
  { id: "sharm", ar: "شرم الشيخ (جنوب سيناء)", en: "Sharm El Sheikh (South Sinai)", c: [34.33, 27.9158] },
  { id: "hurghada", ar: "الغردقة (البحر الأحمر)", en: "Hurghada (Red Sea)", c: [33.8116, 27.2579], alias: ["الغردقة"] },
  { id: "fayoum", ar: "الفيوم", en: "Fayoum", c: [30.8428, 29.3084] },
  { id: "benisuef", ar: "بني سويف", en: "Beni Suef", c: [31.0994, 29.0661] },
  { id: "minya", ar: "المنيا", en: "Minya", c: [30.7503, 28.1099] },
  { id: "asyut", ar: "أسيوط", en: "Asyut", c: [31.1837, 27.1809] },
  { id: "sohag", ar: "سوهاج", en: "Sohag", c: [31.6957, 26.5591] },
  { id: "qena", ar: "قنا", en: "Qena", c: [32.716, 26.1551] },
  { id: "luxor", ar: "الأقصر", en: "Luxor", c: [32.6396, 25.6872] },
  { id: "aswan", ar: "أسوان", en: "Aswan", c: [32.8998, 24.0889] },
  { id: "matrouh", ar: "مرسى مطروح", en: "Marsa Matrouh", c: [27.2373, 31.3543] },
  { id: "newvalley", ar: "الخارجة (الوادي الجديد)", en: "Kharga (New Valley)", c: [30.5586, 25.439] },
];
const EGYPT_VIEW = { c: [30.8, 26.8] as [number, number], z: 5.2 };

/** Normalise Arabic/Latin so "المعادي" and "معادي" match. */
const norm = (s: string) =>
  s.toLowerCase().trim().replace(/[\u064B-\u065F\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ");
const findArea = (q: string) => {
  const n = norm(q);
  if (n.length < 2) return null;
  return AREAS.find((a) => [a.ar, a.en, ...(a.alias || [])].some((x) => norm(x) === n)) || null;
};

export default function Home() {
  const [lang, setLang] = useState<Lang>("ar");
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("egypt");
  const [cat, setCat] = useState("all");
  const [active, setActive] = useState<Set<FeatureKey>>(new Set());
  const [vp, setVp] = useState<Viewport | null>(null);
  const [items, setItems] = useState<Venue[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [mode, setMode] = useState<"clusters" | "points">("clusters");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Venue | null>(null);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"list" | "map">("list");
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [route, setRoute] = useState<{ km: number; min: number } | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const t = T[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

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

  // ---- Map ----
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const fitKey = useRef("");

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current, center: EGYPT_VIEW.c, zoom: EGYPT_VIEW.z,
      style: {
        version: 8,
        sources: { osm: { type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    const sync = () => {
      const b = m.getBounds(), c = m.getCenter();
      setVp({ w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth(), z: m.getZoom(), clat: c.lat, clng: c.lng });
    };
    m.on("load", sync);
    m.on("moveend", sync);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  // Go to an area typed in the search box (e.g. "Maadi" / "معادي")
  useEffect(() => {
    const a = findArea(query);
    if (a) map.current?.flyTo({ center: a.c, zoom: 12.5 });
  }, [query]);

  // Load what's in view (debounced). Text search (not an area name) looks across all of Egypt.
  useEffect(() => {
    if (!vp) return;
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const q = findArea(query) ? "" : query;
        const qs = new URLSearchParams({
          bbox: `${vp.w},${vp.s},${vp.e},${vp.n}`, z: String(Math.floor(vp.z)), lat: String(vp.clat), lng: String(vp.clng),
          q, features: [...active].join(","), category: cat === "all" ? "" : cat,
        });
        const res = await fetch(`/api/venues?${qs}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error();
        const j = await res.json();
        setItems(j.items); setClusters(j.clusters); setMode(j.mode); setTotal(j.total); setNotice("");
      } catch (e: any) {
        if (e?.name !== "AbortError") setNotice(t.loadFail);
      } finally { setLoading(false); }
    }, 350);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [vp, query, active, cat, t.loadFail]);

  // After a name search, zoom the map to the matches (once per search)
  useEffect(() => {
    if (!query || findArea(query)) { fitKey.current = ""; return; }
    if (mode !== "points" || !items.length || fitKey.current === query) return;
    fitKey.current = query;
    const b = new maplibregl.LngLatBounds([items[0].lng, items[0].lat], [items[0].lng, items[0].lat]);
    items.forEach((v) => b.extend([v.lng, v.lat]));
    map.current?.fitBounds(b, { padding: 60, maxZoom: 15 });
  }, [items, mode, query]);

  // Markers: clusters when zoomed out, individual places when zoomed in
  useEffect(() => {
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const m = map.current;
    if (!m) return;
    if (mode === "clusters") {
      clusters.forEach((cl) => {
        const el = document.createElement("button");
        el.type = "button";
        const size = 34 + Math.min(28, Math.log10(Math.max(cl.count, 1)) * 10);
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;border:3px solid #fff;background:#0B3D91;color:#fff;font-weight:700;font-size:13px;box-shadow:0 2px 8px #0006`;
        el.textContent = cl.count >= 1000 ? `${Math.round(cl.count / 100) / 10}k` : String(cl.count);
        el.setAttribute("aria-label", `${cl.count} ${t.results}`);
        el.onclick = () => m.easeTo({ center: [cl.lng, cl.lat], zoom: Math.min(m.getZoom() + 2.5, 12.5) });
        markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([cl.lng, cl.lat]).addTo(m));
      });
    } else {
      items.forEach((v) => {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("aria-label", lang === "ar" ? v.name_ar : v.name_en);
        el.className = "h-11 w-11 rounded-full border-[3px] border-white bg-[#0B3D91] text-white text-lg font-bold shadow-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FFC400]";
        el.textContent = "♿";
        el.onclick = () => setSelected(v);
        markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([v.lng, v.lat]).addTo(m));
      });
    }
  }, [items, clusters, mode, lang, t.results]);

  useEffect(() => { if (view === "map") setTimeout(() => map.current?.resize(), 50); }, [view]);

  // ---- Location + directions ----
  const locate = useCallback(() => {
    if (!navigator.geolocation) return setNotice(t.geoFail);
    navigator.geolocation.getCurrentPosition(
      (p) => { const me: [number, number] = [p.coords.longitude, p.coords.latitude]; setUserPos(me); setNotice(""); map.current?.flyTo({ center: me, zoom: 14 }); },
      () => setNotice(t.geoFail), { enableHighAccuracy: true, timeout: 8000 });
  }, [t.geoFail]);

  const pickArea = (id: string) => {
    setArea(id);
    if (id === "egypt") return void map.current?.flyTo({ center: EGYPT_VIEW.c, zoom: EGYPT_VIEW.z });
    const a = AREAS.find((x) => x.id === id)!;
    map.current?.flyTo({ center: a.c, zoom: 12.5 });
  };

  const clearRoute = useCallback(() => {
    const m = map.current;
    if (m?.getLayer("route-line")) m.removeLayer("route-line");
    if (m?.getSource("route")) m.removeSource("route");
    setRoute(null);
  }, []);
  useEffect(() => { clearRoute(); }, [selected?.id, clearRoute]);

  const gmaps = (v: Venue) =>
    `https://www.google.com/maps/dir/?api=1${userPos ? `&origin=${userPos[1]},${userPos[0]}` : ""}&destination=${v.lat},${v.lng}&travelmode=walking`;

  const getDirections = async (v: Venue) => {
    setRouteBusy(true); setNotice(t.locating);
    try {
      const me: [number, number] = userPos ?? await new Promise<[number, number]>((res, rej) =>
        navigator.geolocation
          ? navigator.geolocation.getCurrentPosition((p) => res([p.coords.longitude, p.coords.latitude]), rej, { enableHighAccuracy: true, timeout: 10000 })
          : rej(new Error("no geolocation")));
      setUserPos(me);
      const r = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${me[0]},${me[1]};${v.lng},${v.lat}?overview=full&geometries=geojson`);
      const rt = (await r.json()).routes?.[0];
      if (!rt) throw new Error("no route");
      const coords: [number, number][] = rt.geometry.coordinates;
      const m = map.current!;
      const data: any = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource("route", { type: "geojson", data });
        m.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#0B3D91", "line-width": 6 } });
      }
      const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
      coords.forEach((c) => b.extend(c));
      b.extend(me);
      m.fitBounds(b, { padding: 70 });
      setRoute({ km: rt.distance / 1000, min: Math.round(rt.duration / 60) });
      setNotice("");
    } catch { setNotice(t.routeFail); }
    setRouteBusy(false);
  };

  useEffect(() => {
    if (!map.current || !userPos) return;
    userMarker.current?.remove();
    const el = document.createElement("div");
    el.className = "h-5 w-5 rounded-full border-4 border-white bg-[#1A73E8] shadow-lg";
    userMarker.current = new maplibregl.Marker({ element: el }).setLngLat(userPos).addTo(map.current);
  }, [userPos]);

  const name = (v: Venue) => (lang === "ar" ? v.name_ar : v.name_en);
  const addr = (v: Venue) => (lang === "ar" ? v.address_ar : v.address_en);
  const catLabel = (c: string) => (CATS[c] ? CATS[c][lang === "ar" ? 0 : 1] : c);
  const hoursText = (v: Venue) => (typeof v.hours === "string" ? v.hours : "");
  const shownList = items.slice(0, 150);

  return (
    <div dir={dir} lang={lang} className="min-h-screen bg-white text-[#0A0A0A] text-[18px] leading-relaxed"
         style={{ fontFamily: lang === "ar" ? "'IBM Plex Sans Arabic', system-ui" : "'IBM Plex Sans', system-ui" }}>
      <a href="#results" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-[#FFC400] focus:p-3">{t.skip}</a>

      <header className="bg-[#0B3D91] text-white px-4 py-3 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <button onClick={() => setLang(lang === "ar" ? "en" : "ar")}
          className="min-h-[48px] min-w-[48px] px-4 rounded-lg bg-white text-[#0B3D91] font-bold focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]"
          lang={lang === "ar" ? "en" : "ar"}>{t.lang}</button>
      </header>

      <main className="mx-auto max-w-7xl p-4 grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <section aria-label={t.filters} className="space-y-4">
          <form role="search" onSubmit={(e) => e.preventDefault()} className="space-y-3">
            <label htmlFor="q" className="sr-only">{t.search}</label>
            <input id="q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search}
              inputMode="search" autoComplete="off"
              className="w-full min-h-[52px] rounded-lg border-2 border-[#0A0A0A] px-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]" />
            <div className="flex gap-2">
              <label htmlFor="area" className="sr-only">{t.area}</label>
              <select id="area" value={area} onChange={(e) => pickArea(e.target.value)}
                className="flex-1 min-w-0 min-h-[52px] rounded-lg border-2 border-[#0A0A0A] px-3 bg-white">
                <option value="egypt">{t.egypt}</option>
                {AREAS.map((a) => <option key={a.id} value={a.id}>{lang === "ar" ? a.ar : a.en}</option>)}
              </select>
              <button type="button" onClick={locate}
                className="min-h-[52px] px-4 rounded-lg bg-[#0A0A0A] text-white font-semibold focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]">{t.locate}</button>
            </div>
          </form>

          <div>
            <label htmlFor="cat" className="sr-only">{t.cat}</label>
            <select id="cat" value={cat} onChange={(e) => setCat(e.target.value)}
              className="w-full min-h-[52px] rounded-lg border-2 border-[#0A0A0A] px-3 bg-white">
              <option value="all">{t.allCat}</option>
              {Object.keys(CATS).map((k) => <option key={k} value={k}>{CATS[k][lang === "ar" ? 0 : 1]}</option>)}
            </select>
          </div>

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
                className={`flex-1 min-h-[48px] rounded-lg border-2 font-semibold ${view === v ? "bg-[#0A0A0A] text-white" : "border-[#0A0A0A]"}`}>{t[v]}</button>
            ))}
          </div>

          <p role="status" aria-live="polite" className="font-semibold">
            {loading ? t.loading : <>{total.toLocaleString()}{mode === "points" && total >= 600 ? "+" : ""} {t.results}{mode === "clusters" && total > 0 ? ` · ${t.zoomIn}` : ""}</>}
            {notice && <span className="block text-[#8A1C00]">{notice}</span>}
          </p>
          {mode === "clusters" && items.length > 0 && <p className="text-sm">{t.nearest}</p>}

          <ul id="results" className={`space-y-3 ${view === "map" ? "hidden lg:block" : ""}`}>
            {!loading && shownList.length === 0 && <li className="p-4 border-2 border-dashed border-[#0A0A0A] rounded-lg">{t.none}</li>}
            {shownList.map((v) => (
              <li key={v.id}>
                <button onClick={() => { setSelected(v); if (window.innerWidth < 1024) setView("map"); map.current?.flyTo({ center: [v.lng, v.lat], zoom: 16 }); }}
                  className="w-full text-start p-4 rounded-lg border-2 border-[#0A0A0A] hover:bg-[#F2F6FF] focus-visible:outline focus-visible:outline-4 focus-visible:outline-[#FFC400]">
                  <span className="block font-bold">{name(v)}</span>
                  <span className="inline-block text-sm bg-[#F2F6FF] border border-[#B9C6E0] rounded px-2">{catLabel(v.category)}</span>
                  <span className="block text-[#333]">{addr(v)}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {FEATURES.filter((f) => v.features[f.key]).map((f) => {
                      const s = v.features[f.key];
                      return (
                        <span key={f.key} className={`px-2 py-0.5 rounded text-sm font-semibold ${s === "yes" ? "bg-[#0B6B2E] text-white" : "bg-[#8A1C00] text-white"}`}>
                          {lang === "ar" ? f.ar : f.en}: {s === "yes" ? "✓" : "✗"}
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
            <aside aria-live="polite" className="absolute bottom-3 inset-x-3 max-h-[65%] overflow-auto bg-white border-2 border-[#0A0A0A] rounded-lg p-4 shadow-xl">
              <div className="flex justify-between gap-2">
                <h2 className="font-bold text-xl">{name(selected)}</h2>
                <button onClick={() => { setSelected(null); clearRoute(); }} aria-label={t.close} className="min-h-[44px] min-w-[44px] text-2xl">×</button>
              </div>
              <p>{addr(selected)}{hoursText(selected) ? ` · ${hoursText(selected)}` : ""}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FEATURES.filter((f) => selected.features[f.key]).map((f) => (
                  <span key={f.key} className={`px-2 py-0.5 rounded text-sm font-semibold ${selected.features[f.key] === "yes" ? "bg-[#0B6B2E] text-white" : "bg-[#8A1C00] text-white"}`}>
                    {lang === "ar" ? f.ar : f.en}: {selected.features[f.key] === "yes" ? "✓" : "✗"}
                  </span>
                ))}
              </div>
              {route && <p className="mt-2 font-semibold">{t.route}: {route.km.toFixed(1)} {t.km} · ~{route.min} {t.min} {t.walk}</p>}
              {route && <p className="text-sm">{t.routeNote}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => getDirections(selected)} disabled={routeBusy}
                  className="min-h-[48px] px-4 py-2 rounded-lg bg-[#0B3D91] text-white font-semibold disabled:opacity-60">{routeBusy ? t.locating : t.dir}</button>
                <a href={gmaps(selected)} target="_blank" rel="noopener noreferrer"
                  className="min-h-[48px] px-4 py-2 rounded-lg border-2 border-[#0A0A0A] font-semibold">{t.gmaps}</a>
                {selected.phone && <a href={`tel:${selected.phone}`} className="min-h-[48px] px-4 py-2 rounded-lg border-2 border-[#0A0A0A] font-semibold">{t.call} {selected.phone}</a>}
                {route && <button onClick={clearRoute} className="min-h-[48px] px-4 py-2 rounded-lg border-2 border-[#0A0A0A] font-semibold">{t.clear}</button>}
              </div>
            </aside>
          )}
        </section>
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-6 text-sm">{t.footer}</footer>
    </div>
  );
}
