/* ================= Grundlagen der Oberfläche ================= */

/* Symbole im Stil des vorhandenen Satzes (24er Raster, Strich 2, Lucide-Familie). */
const I = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
  pole: '<path d="M12 2v20M2 5h20M3 3v2M7 3v2M17 3v2M21 3v2M19 5l-7 7-7-7"/>',
  house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  heatpump: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="10" cy="12" r="4"/><path d="M10 8v8M6 12h8M17 9h2M17 12h2M17 15h2"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  snow: '<path d="M12 2v20M3.5 7l17 10M3.5 17l17-10"/><path d="M9 3.5 12 6l3-2.5M9 20.5 12 18l3 2.5"/>',
  washer: '<rect x="3" y="2" width="18" height="20" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M7 6h.01M10 6h.01M12 11a2 2 0 0 1 2 2"/>',
  wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  heater: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12M11 6v12M15 6v12M19 6v12M5 21h14"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  factory: '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  euro: '<path d="M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>', chevU: '<path d="m18 15-6-6-6 6"/>', chevL: '<path d="m15 18-6-6 6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', plus: '<path d="M5 12h14M12 5v14"/>', minus: '<path d="M5 12h14"/>', check: '<path d="M20 6 9 17l-5-5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  trend: '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  arrowR: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  door: '<path d="M13 4h3a2 2 0 0 1 2 2v14M2 20h3M13 20h9M10 12v.01"/><path d="M13 4.56v16.157a.5.5 0 0 1-.576.494l-7-1.063A1 1 0 0 1 5 19.157V5.562a1 1 0 0 1 .735-.965l6.53-1.834A.6.6 0 0 1 13 3.36z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  fan: '<path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"/><path d="M12 12v.01"/>',
  bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  snowflake: '<path d="M2 12h20M12 2v20m-8-3 16-14M4 5l16 14"/>',
  dish: '<rect x="3" y="2" width="18" height="20" rx="2"/><path d="M3 7h18M7 4.5h.01M10 4.5h.01M8 12h8M8 16h8"/>',
  sauna: '<path d="M4 21V9l8-6 8 6v12M9 21v-6h6v6M8 12c1-1 1-2 0-3M12 12c1-1 1-2 0-3M16 12c1-1 1-2 0-3"/>',
  sprout: '<path d="M7 20h10M10 20c5.5-2.5.8-6.4 3-10M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8zM14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
};
function ic(n, s, cls) {
  s = s || 20;
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[n] || '') + '</svg>';
}

/* ---------- Zahlen und Zeit (Einheit steht immer am Wert) ---------- */
const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const NF2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fKw = (v) => NF1.format(Math.abs(v) < 0.05 ? 0 : v) + ' kW';
const fKwh = (v) => NF1.format(v) + ' kWh';
const fCt = (v) => (v < 0 ? '−' : '') + NF1.format(Math.abs(v)) + ' ct/kWh';
const fEur = (v) => NF2.format(v) + ' €';
const fPct = (v) => NF0.format(v) + ' %';
const fGrad = (v) => NF0.format(v) + ' °C';
const pad = (n) => String(n).padStart(2, '0');
function uhr(t) { const m = ((t % 96) + 96) % 96; return pad(Math.floor(m / 4)) + ':' + pad((m % 4) * 15); }
function uhrTag(t) { return (t >= 96 ? 'morgen ' : '') + uhr(t); }
function dauer(slots) {
  const min = Math.round(slots * 15);
  const h = Math.floor(min / 60); const m = min % 60;
  if (!h) return m + ' Min';
  return h + ' Std' + (m ? ' ' + m + ' Min' : '');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Zustand des Prototyps ---------- */
const JETZT_FAELLE = {
  morgen: { label: '07:40', slot: 30, min: 7 * 60 + 40 },
  mittag: { label: '13:10', slot: 52, min: 13 * 60 + 10 },
  abend: { label: '19:40', slot: 78, min: 19 * 60 + 40 },
  nacht: { label: '23:20', slot: 93, min: 23 * 60 + 20 },
};
const S = {
  fall: 'mittag', now: 52, nowMin: 13 * 60 + 10,
  tab: 'geraete', tag: 0, sel: null, reo: null,
  cfg: null, basis: null, R: null,
  sheet: null, toast: null, toastTimer: 0,
  desk: false,
};
const morgenBekannt = () => S.now >= 52;

function rechneAlles() {
  S.basis = SIM.rechne(S.cfg, { from: 0, morgenBekannt: morgenBekannt() });
  S.R = S.basis;
}
function rechneAbJetzt() {
  S.R = SIM.rechne(S.cfg, { from: S.now, basis: S.basis, morgenBekannt: morgenBekannt() });
}
/* Eine Vorschau mit einer geänderten Konfiguration, ohne sie zu übernehmen. */
function vorschau(cfg) {
  return SIM.rechne(cfg, { from: S.now, basis: S.basis, morgenBekannt: morgenBekannt() });
}
const kopie = (o) => JSON.parse(JSON.stringify(o));

/* ---------- Begriffe ---------- */
const GRUPPEN = { laden: 'Laden', waerme: 'Wärme', haus: 'Haushalt', garten: 'Garten und Pool', betrieb: 'Betrieb', speicher: 'Speicher' };
function geraet(id) { return id === 'sp' ? null : S.cfg.geraete[id]; }
function name(id) { return id === 'sp' ? S.cfg.speicher.name : S.cfg.geraete[id].name; }
function kurz(id) { return id === 'sp' ? 'Speicher' : S.cfg.geraete[id].kurz; }
function icon(id) { return id === 'sp' ? 'battery' : S.cfg.geraete[id].icon; }

/* Drei Zustände je Gerät, benannt nach dem, was passiert. */
function drei(id) {
  const g = geraet(id);
  if (!g) return ['Halten', 'Smart', 'Laden'];
  if (g.fahrzeug) return ['Aus', 'Smart', 'Schnell'];
  if (g.form === 'freigabe') return ['Normal', 'Smart', 'Anheben'];
  return ['Aus', 'Smart', 'Ein'];
}
function eingriff(id, t) {
  t = t == null ? S.now : t;
  return S.cfg.eingriffe.find((e) => e.g === id && t >= e.von && t < e.bis) || null;
}

/* Der Auftrag als kurzer Satz (Karte) und als ganzer Satz (Blatt). */
function auftragKurz(id) {
  if (id === 'sp') return S.cfg.speicher.modell === 'markt' ? 'Marktoptimierung' : 'Eigenverbrauch';
  const { g, a, ziel, aus } = SIM.wirk(S.cfg, id);
  if (aus) return 'Szene: aus';
  let s = '';
  if (a.art === 'sonne') {
    if (g.form === 'freigabe') s = 'Anheben bei Sonne';
    else if (g.fahrzeug) s = a.modus === 'min' ? 'Sonne + Mindestleistung' : 'Nur Sonnenstrom';
    else s = 'Mit Sonnenstrom';
  } else if (a.art === 'guenstig') s = (g.form === 'freigabe' ? 'Anheben unter ' : 'Unter ') + NF1.format(a.grenze) + ' ct';
  else if (a.art === 'zeiten') s = uhr(a.von) + '–' + uhr(a.bis) + (a.tage === 'werktags' ? ' werktags' : '');
  else if (a.art === 'frist') {
    const menge = g.fahrzeug ? '+' + NF0.format(a.kwh) + ' kWh' : (g.form === 'programm' ? 'Programm' : dauer(a.stunden * 4));
    s = menge + ' bis ' + uhr(a.bis) + (a.quelle === 'sonne' ? ', Sonne zuerst' : ', günstig');
  } else if (a.art === 'sofort') s = g.fahrzeug ? 'Sofort laden' : 'Ohne Steuerung';
  if (ziel && ziel.art === 'temp') s += ', bis ' + fGrad(ziel.grad);
  const b = (g.bedingungen || [])[0];
  if (b) s += b.art === 'danach' ? ' · nach ' + kurz(b.geraet) : ' · nur ' + b.text.replace(/^Außentemperatur /, '').replace('läuft', 'an');
  return s;
}

/* ---------- Zustand eines Geräts in einer Viertelstunde ---------- */
function lage(id, t) {
  const R = S.R;
  if (id === 'sp') {
    const k = R.sp.kw[t];
    return { an: Math.abs(k) > 0.05, kw: k, pill: k > 0.05 ? ['on', 'lädt'] : k < -0.05 ? ['on', 'gibt ab'] : ['off', R.sp.soc[t] >= 99.5 ? 'voll' : 'ruht'] };
  }
  const g = geraet(id);
  const kw = R.kw[id][t];
  const w = R.why[id][t] || { k: 'aus' };
  const e = eingriff(id, t);
  let pill;
  if (e) pill = ['hand', e.art === 'aus' ? 'Eingriff: aus' : 'Eingriff: an'];
  else if (kw > 0) pill = ['on', g.form === 'freigabe' ? 'angehoben' : 'läuft'];
  else if (['wartet-sonne', 'frist-wartet', 'teuer', 'danach', 'bedingung', 'zeiten-aus', 'preis-unbekannt'].includes(w.k)) pill = ['wait', 'wartet'];
  else if (['ziel', 'auto-voll', 'fertig'].includes(w.k)) pill = ['done', w.k === 'fertig' ? 'fertig' : 'Ziel erreicht'];
  else if (['regel-aus', 'schutz-pause', 'pause', 'szene'].includes(w.k)) pill = ['lock', w.k === 'schutz-pause' ? 'Pause' : 'gesperrt'];
  else if (w.k === 'kein-auto') pill = ['off', 'kein Auto'];
  else pill = ['off', 'aus'];
  return { an: kw > 0, kw, why: w, pill, e };
}

function srcDominant(s) {
  if (!s) return 'pv';
  const m = Math.max(s.pv, s.sp, s.netz);
  return m === s.pv ? 'pv' : m === s.sp ? 'sp' : 'netz';
}
const SRC_WORT = { pv: 'Sonne', sp: 'Speicher', netz: 'Netz' };
const SRC_FARBE = { pv: 'var(--pv-fill)', sp: 'var(--batt-fill)', netz: 'var(--grid)' };

/* Warum ein Gerät tut, was es tut: ein Satz, nie geraten. */
function warum(id, t, lang) {
  const L = lage(id, t);
  const R = S.R;
  if (id === 'sp') {
    const soc = R.sp.soc[t];
    if (L.kw > 0.05) return 'Lädt mit ' + fKw(L.kw) + ' · Ladestand ' + fPct(soc) + (lang ? '. Er steht in der Reihenfolge auf Platz ' + (S.cfg.reihenfolge.indexOf('sp') + 1) + '.' : '');
    if (L.kw < -0.05) return 'Deckt das Haus mit ' + fKw(-L.kw) + ' · Ladestand ' + fPct(soc);
    return soc >= 99.5 ? 'Voll · der Rest der Sonne geht weiter' : 'Ruht · Ladestand ' + fPct(soc) + (soc <= S.cfg.speicher.reserve * 100 + 0.5 ? ' (Reserve)' : '');
  }
  const g = geraet(id);
  const w = L.why;
  const s = R.src[id][t];
  const mitQuelle = (txt) => {
    if (!s || !L.an) return txt;
    const d = srcDominant(s);
    const teile = ['pv', 'sp', 'netz'].filter((k) => s[k] > 0.05).map((k) => SRC_WORT[k]);
    return txt + (lang ? (/[.!]$/.test(txt) ? ' ' : '. ') + 'Strom aus: ' + teile.join(', ') + '.' : ' · ' + SRC_WORT[d]);
  };
  const reg = (n) => '„' + n + '“';
  switch (w.k) {
    case 'sonne': return lang ? 'Läuft mit Sonnenstrom-Überschuss. Platz ' + w.platz + ' in der Reihenfolge; für ihn war genug übrig.' : 'Sonnenstrom · Platz ' + w.platz;
    case 'sonne-min': return mitQuelle(lang ? 'Lädt mit Mindestleistung; was die Sonne nicht liefert, kommt aus dem Netz.' : 'Mindestleistung, Rest Sonne');
    case 'freigabe': return lang ? 'SG-Ready-Freigabe gesetzt: Die Wärmepumpe darf mehr heizen, solange Überschuss da ist. Ihre Leistung wird nicht gemessen.' : 'Freigabe · Leistung nicht gemessen';
    case 'wartet-sonne': {
      const vor = (w.vor || []).map(kurz);
      if (lang) return 'Wartet auf Sonnenstrom: braucht ' + fKw(w.braucht) + ', frei sind ' + fKw(Math.max(0, w.frei)) + '.' + (vor.length ? ' Vor ihm in der Reihenfolge: ' + vor.join(', ') + '.' : '');
      return SIM.pv(t) < 0.1 ? 'Wartet auf die Sonne' : 'Wartet · braucht ' + fKw(w.braucht) + ', frei ' + fKw(Math.max(0, w.frei));
    }
    case 'guenstig': return mitQuelle('Günstige Stunde: ' + fCt(w.preis) + ' liegt unter ' + fCt(w.grenze));
    case 'teuer': return 'Wartet auf günstigen Strom: jetzt ' + fCt(w.preis) + ', Grenze ' + fCt(w.grenze);
    case 'preis-unbekannt': return 'Börsenpreise für morgen kommen gegen 13 Uhr';
    case 'zeiten': return mitQuelle('Feste Zeit ' + uhr(w.von) + '–' + uhr(w.bis));
    case 'zeiten-aus': return 'Nächste feste Zeit ' + uhr(w.von) + '–' + uhr(w.bis);
    case 'frist': {
      const a = S.cfg.geraete[id].auftrag;
      const ziel = g.fahrzeug ? '+' + NF0.format(a.kwh) + ' kWh bis ' + uhrTag(a.bis) : 'fertig bis ' + uhr(a.bis);
      return mitQuelle((lang ? 'Läuft nach Plan, damit es ' : 'Plan: ') + ziel + (w.vorlaeufig ? ' (vorläufig)' : '') + (lang ? ' klappt.' : ''));
    }
    case 'frist-wartet': return w.start != null ? 'Startet laut Plan ' + uhrTag(w.start) + (w.vorlaeufig && w.start >= 96 ? ' (vorläufig)' : '') : 'Frist ' + uhr(w.bis) + ' · nichts mehr offen';
    case 'fertig': return 'Heute fertig';
    case 'ziel': return 'Ziel erreicht: ' + fGrad(w.ist) + ' (Ziel ' + fGrad(w.grad) + ')';
    case 'auto-voll': return 'Auto hat genug geladen';
    case 'kein-auto': return 'Kein Auto angesteckt';
    case 'bedingung': return 'Wartet: nur wenn ' + w.text.replace(/^Außentemperatur/, 'Außentemperatur').replace('läuft', 'läuft');
    case 'danach': return 'Wartet: ' + w.text.replace('fertig', 'muss erst fertig sein');
    case 'regel-an': return mitQuelle('Regel ' + reg(w.regel) + ' greift');
    case 'regel-aus': return 'Gesperrt durch Regel ' + reg(w.regel);
    case 'eingriff-an': return 'Ihr Eingriff: an bis ' + uhrTag(w.bis) + ', dann wieder Smart';
    case 'eingriff-aus': return 'Ihr Eingriff: aus bis ' + uhrTag(w.bis) + ', dann wieder Smart';
    case 'schutz-pause': return 'Geräteschutz: Mindestpause läuft';
    case 'pause': return 'Automatik pausiert';
    case 'szene': return 'Szene ' + reg(w.name) + ': aus';
    case 'budget': return 'Gekürzt: Netzanschluss ausgelastet (' + fKw(w.budget) + ')';
    case 'selbst': return 'Ohne Steuerung: läuft, wie es selbst will';
    default: return L.an ? mitQuelle('Läuft') : 'Aus';
  }
}

/* Wann ändert sich als Nächstes etwas? („in 25 Min: startet“) */
function naechstes(id, t) {
  const R = S.R;
  const arr = id === 'sp' ? R.sp.kw.map((k) => Math.abs(k) > 0.05) : R.kw[id].map((k) => k > 0);
  const an = arr[t];
  for (let x = t + 1; x < SIM.N; x++) {
    if (arr[x] !== an) return { t: x, an: arr[x] };
  }
  return null;
}
function inZeit(x) {
  const diff = x * 15 - S.nowMin;
  if (diff <= 0) return 'gleich';
  if (diff < 60) return 'in ' + diff + ' Min';
  return 'um ' + uhrTag(x);
}

/* ---------- Haptik: nur als Zugabe, nie als einzige Information ---------- */
function tick() { try { if (navigator.vibrate && matchMedia('(pointer:coarse)').matches) navigator.vibrate(8); } catch (e) { /* ohne */ } }

/* ---------- Rückmeldung ---------- */
function toast(text) {
  S.toast = text;
  clearTimeout(S.toastTimer);
  const host = document.getElementById('toast-host');
  if (host) host.innerHTML = '<div class="toast" role="status">' + ic('check', 18) + '<span>' + text + '</span></div>';
  S.toastTimer = setTimeout(() => { S.toast = null; const h = document.getElementById('toast-host'); if (h) h.innerHTML = ''; }, 3600);
}

/* ---------- Blatt (am Telefon unten, im Rechner ebenso im Rahmen) ---------- */
let blattFokus = null;
function blattAuf(sheet) {
  if (!S.sheet) blattFokus = document.activeElement;
  S.sheet = sheet;
  renderBlatt();
  const host = document.getElementById('sheet-host');
  requestAnimationFrame(() => {
    host.classList.add('open');
    const f = host.querySelector('.sh-head button, .sh-body button, .sh-body input');
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 60);
  });
}
function blattZu() {
  const host = document.getElementById('sheet-host');
  host.classList.remove('open');
  S.sheet = null;
  setTimeout(() => { if (!S.sheet) host.innerHTML = ''; }, 320);
  if (blattFokus && blattFokus.isConnected) blattFokus.focus({ preventScroll: true });
}
