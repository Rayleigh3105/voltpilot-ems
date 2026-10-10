/**
 * Die Messen-Ansicht des Reiters Geräte (UEMS SZ-1 A, Captain 04.10.2026) - rein.
 *
 * An einer Anlage, die nicht an „Steuern & Optimieren“ teilnimmt, sagt die
 * Steuerung nur, was gemessen wird: keine Plakette, kein Plan, keine
 * Reihenfolge, keine Vorschläge (Steuern-Regel #779). Jede Zahl ist eine
 * Messung von jetzt - die jüngste Telemetrie bzw. die gemessene Leistung des
 * Geräts, nie ein Fahrplanwert. Fehlt sie, steht kein Wert da: unbekannt ist
 * keine Null. Die Geräte stehen als ruhige Liste; Antippen öffnet das
 * Geräte-Blatt mit Messwerten und Steuerart (der Weg bleibt).
 */
import type { GeraetBild, JetztWerte, SpeicherBild } from './bild';
import { SPEICHER } from './bild';
import { fKw, fPct, uhrMin, type Raster } from './zeit';

export interface MessTeil {
  /** Gerät oder `null` = der Rest des gemessenen Verbrauchs. */
  id: string | null;
  label: string;
  kw: number;
}

export interface MessZeile {
  /** Gerät, oder `SPEICHER` für den Speicher. */
  id: string;
  name: string;
  symbol: string;
  satz: string;
  /** Gemessene Leistung jetzt; `null` = nicht gemessen. */
  kw: number | null;
  gemessen: boolean;
}

export interface MessBild {
  eye: string;
  satz: string;
  zusatz: string[];
  /** Der gemessene Verbrauch jetzt, nach Geräten (größte zuerst) und Rest; leer = keine Leiste. */
  teile: MessTeil[];
  zeilen: MessZeile[];
}

const SCHWELLE = 0.05;

/** Die gemessene Leistung eines Geräts jetzt - nur, wenn es wirklich gemessen wird. */
export function messKw(g: GeraetBild): number | null {
  return g.gemessen && g.jetztKw != null ? g.jetztKw : null;
}

export function messBild(input: {
  raster: Raster;
  /** Die jüngste Telemetrie (≤ 20 Minuten), sonst `null`. */
  jetzt: JetztWerte | null;
  geraete: GeraetBild[];
  speicher: SpeicherBild | null;
}): MessBild {
  const { raster: r, jetzt: live, geraete } = input;
  const netz = live?.netz ?? null;
  const pv = live?.pv ?? null;
  let netzSatz: string | null = null;
  if (netz != null) {
    if (netz > SCHWELLE) netzSatz = `bezieht ${fKw(netz)} aus dem Netz`;
    else if (netz < -SCHWELLE) netzSatz = `speist ${fKw(-netz)} ins Netz ein`;
    else netzSatz = 'bezieht gerade keinen Strom aus dem Netz';
  }
  const pvKw = pv != null && pv > SCHWELLE ? fKw(pv) : null;
  let satz: string;
  if (netzSatz && pvKw) satz = `Die Anlage ${netzSatz}, die PV liefert ${pvKw}.`;
  else if (netzSatz) satz = `Die Anlage ${netzSatz}.`;
  else if (pvKw) satz = `Die PV liefert ${pvKw}.`;
  else satz = 'Für jetzt liegt noch kein Messwert vor.';

  const verbraucher = geraete
    .filter((g) => !g.eintrag.ladepunkt)
    .map((g) => ({ g, kw: messKw(g) }))
    .filter((x): x is { g: GeraetBild; kw: number } => x.kw != null && x.kw > SCHWELLE)
    .sort((a, b) => b.kw - a.kw);
  const zusatz: string[] = [];
  const groesste = verbraucher.slice(0, 2).map((x) => `${x.g.name} ${fKw(x.kw)}`);
  if (groesste.length) zusatz.push(`${groesste.length > 1 ? 'Größte Verbraucher' : 'Größter Verbraucher'} gerade: ${groesste.join(' · ')}.`);
  for (const g of geraete) {
    const lp = g.ladepunkt;
    if (!g.eintrag.ladepunkt) continue;
    if (lp && !lp.angesteckt) zusatz.push(`${g.name}: kein Auto angesteckt.`);
    else if (lp?.laedt && messKw(g) != null) zusatz.push(`${g.name}: lädt mit ${fKw(messKw(g) ?? 0)}.`);
  }

  // Die Leiste teilt nur den gemessenen Verbrauch der Anlage auf; ohne ihn keine Leiste.
  const teile: MessTeil[] = [];
  const last = live?.last ?? null;
  if (last != null && last > SCHWELLE) {
    let summe = 0;
    for (const x of verbraucher) {
      teile.push({ id: x.g.id, label: x.g.kurz, kw: x.kw });
      summe += x.kw;
    }
    for (const g of geraete) {
      const kw = messKw(g);
      if (!g.eintrag.ladepunkt || kw == null || kw <= SCHWELLE) continue;
      teile.push({ id: g.id, label: g.kurz, kw });
      summe += kw;
    }
    if (last - summe > SCHWELLE) teile.push({ id: null, label: 'Rest', kw: last - summe });
  }

  const zeilen: MessZeile[] = geraete.map((g) => {
    const kw = messKw(g);
    const lp = g.ladepunkt;
    let zustand: string;
    if (g.eintrag.ladepunkt) zustand = lp ? (lp.angesteckt ? (lp.laedt ? 'lädt' : 'Auto angesteckt') : 'kein Auto angesteckt') : 'meldet sich nicht';
    else zustand = g.typLabel;
    return {
      id: g.id,
      name: g.name,
      symbol: g.symbol,
      satz: `${g.gemessen ? 'gemessen' : 'ohne eigene Messung'} · ${zustand}`,
      kw,
      gemessen: g.gemessen,
    };
  });
  const sp = input.speicher;
  if (sp) {
    const bat = live?.bat ?? null;
    const soc = live?.soc ?? null;
    const was = bat == null ? null : bat > SCHWELLE ? 'lädt' : bat < -SCHWELLE ? 'gibt ab' : 'ruht';
    zeilen.unshift({
      id: SPEICHER,
      name: sp.name,
      symbol: 'battery',
      satz: [bat != null || soc != null ? 'gemessen' : 'ohne Messwert', was, soc != null ? `Ladestand ${fPct(soc)}` : null].filter(Boolean).join(' · '),
      kw: bat != null ? Math.abs(bat) : null,
      gemessen: bat != null || soc != null,
    });
  }

  return { eye: `Jetzt · ${uhrMin(r.jetztMin)} · gemessen`, satz, zusatz, teile, zeilen };
}
