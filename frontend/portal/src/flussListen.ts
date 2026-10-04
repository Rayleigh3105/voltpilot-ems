/**
 * „Verbrauch im Detail“ und „Erzeugung im Detail“ unter dem Energiefluss
 * (Konzept `docs/konzepte/cockpit-tagesfilm`): die Geräte als sortierte Liste,
 * die größten zuerst. Am Telefon höchstens vier Zeilen (sonst drei und
 * „n weitere“), am Rechner sechs (sonst fünf) - so bleibt es bei beliebig
 * vielen Geräten ruhig. Das ganze Verzeichnis öffnet sich im Blatt.
 *
 * Reine Ableitung aus `verbrauchKomposition` und `pvComposition`; fehlt ein
 * Messwert, steht das Wort bzw. „—“, nie eine erfundene 0.
 */
import type { RollenKanonischerWert } from './api';
import type { PvComposition } from './pvComposition';
import { SUMMENWERT } from './glossar';
import { rollenStand, rollenView, teilSummeText } from './pvRolle';
import type { VerbrauchGruppeId, VerbrauchKomposition } from './verbrauchKomposition';
import { kw, kwh, TOTBAND_KW } from './leitungsplan';

export type ZeilenIcon = 'car' | 'heatpump' | 'plug' | 'home' | 'panel' | 'plus';

export interface ListenZeile {
  key: string;
  name: string;
  /** Leise Unterzeile: „berechnet“, „aus“, „Stand: 13:31 Uhr“ … */
  sub: string | null;
  wert: string;
  /** Sortier- und Balkenwert (kW bzw. kWh), null = nicht gemessen. */
  zahl: number | null;
  /** Anteil an der Summe, 0..1, für den Balken; null = kein Balken. */
  anteil: number | null;
  art: 'normal' | 'rest' | 'still' | 'aus' | 'plan' | 'weitere';
  icon: ZeilenIcon;
  title: string | null;
  /** Im Blatt: Sprung auf die Geräteseite; null = kein Ziel. */
  href?: string | null;
}

export interface Liste {
  titel: string;
  summe: string;
  zeilen: ListenZeile[];
  /** Zahl aller Zeilen vor dem Kürzen. */
  gesamt: number;
  /** Leise Zeilen unter der Liste („Stand 10:15 Uhr“, „aus 2 von 3 Geräten“). */
  fuss?: string[];
}

const GRUPPEN_ICON: Record<VerbrauchGruppeId, ZeilenIcon> = {
  laden: 'car',
  laden_eigen: 'car',
  waerme: 'heatpump',
  sonstiges: 'plug',
};

/** Kürzen: höchstens `max` Zeilen, sonst `max − 1` und eine Zeile „n weitere“. */
export function kuerzen(zeilen: ListenZeile[], max: number, nomen: string, heute: boolean): ListenZeile[] {
  if (zeilen.length <= max) return zeilen;
  const shown = zeilen.slice(0, max - 1);
  const rest = zeilen.slice(max - 1);
  const bekannt = rest.filter((z) => z.zahl != null);
  const summe = bekannt.reduce((s, z) => s + (z.zahl ?? 0), 0);
  return [
    ...shown,
    {
      key: 'weitere',
      name: `${rest.length} weitere ${nomen}`,
      sub: null,
      wert: bekannt.length ? (heute ? kwh(summe) : kw(summe)) : '—',
      zahl: null,
      anteil: null,
      art: 'weitere',
      icon: 'plus',
      title: null,
    },
  ];
}

function sortiere(z: ListenZeile[]): ListenZeile[] {
  // Gemessene nach Größe, dann die ohne Zahl; der Rest („übriger …“) nimmt teil.
  return z.slice().sort((a, b) => (b.zahl ?? -1) - (a.zahl ?? -1));
}

/** Verbrauch im Detail - jetzt (kW) oder heute (kWh). */
export function verbrauchListe(
  k: VerbrauchKomposition | null,
  opts: { heute: boolean; max: number; /** Der Verbrauch des Flusses, falls die Box kein Haus-Mitglied meldet. */ hausKw?: number | null },
): Liste | null {
  if (!k) return null;
  const { heute } = opts;
  const zeilen: ListenZeile[] = [];
  for (const g of k.gruppen) {
    if (g.collapsed) {
      zeilen.push({
        key: `g:${g.id}`,
        name: g.collapsedText ?? g.label,
        sub: 'in der Kachel „Laden“',
        wert: heute ? '—' : g.kw == null ? '—' : kw(g.kw),
        zahl: heute ? null : g.kw,
        anteil: null,
        art: 'normal',
        icon: GRUPPEN_ICON[g.id],
        title: null,
      });
      continue;
    }
    for (const t of g.teile) {
      const zahl = heute ? t.todayKwh : t.kw;
      const aus = !heute && t.kw != null && t.kw <= TOTBAND_KW && !t.aktiv;
      zeilen.push({
        key: t.key,
        name: t.label,
        sub: t.health === 'stale' ? t.note ?? 'meldet sich gerade nicht' : zahl == null ? t.word : aus ? 'aus' : t.note,
        wert: zahl == null ? '—' : heute ? kwh(zahl) : kw(zahl),
        zahl,
        anteil: null,
        art: t.health === 'stale' ? 'still' : aus ? 'aus' : 'normal',
        icon: GRUPPEN_ICON[g.id],
        title: t.title,
        href: t.href,
      });
    }
  }
  const restZahl = heute ? k.rest.todayKwh : k.rest.kw;
  zeilen.push({
    key: 'rest',
    name: 'übriger Haushalt',
    sub: restZahl == null ? k.rest.note ?? 'nicht bestimmbar' : 'berechnet',
    wert: restZahl == null ? '—' : heute ? kwh(restZahl) : kw(restZahl),
    zahl: restZahl,
    anteil: null,
    art: 'rest',
    icon: 'home',
    title: 'Hausverbrauch minus gemessene Geräte',
  });
  const haus = k.hausKw ?? opts.hausKw ?? null;
  const summe = heute ? null : haus;
  const bezug = summe ?? zeilen.reduce((s, z) => s + (z.zahl ?? 0), 0);
  for (const z of zeilen) z.anteil = z.zahl != null && bezug > 0 ? Math.min(1, z.zahl / bezug) : null;
  const sortiert = sortiere(zeilen);
  return {
    titel: 'Verbrauch im Detail',
    summe: heute ? kwh(zeilen.every((z) => z.zahl == null) ? null : bezug) : kw(haus),
    zeilen: kuerzen(sortiert, opts.max, 'Verbraucher', heute),
    gesamt: sortiert.length,
  };
}

/** Erzeugung im Detail - nur mit mehr als einer Fläche bzw. einem Gerät. */
export function erzeugungListe(c: PvComposition | null, opts: { max: number }): Liste | null {
  if (!c || c.parts.length + c.unmeasured.length < 2) return null;
  const producing = c.parts.some((p) => p.kw != null && p.kw > TOTBAND_KW);
  const alle = [...c.parts, ...c.unmeasured];
  const zeilen: ListenZeile[] = alle.map((p) => {
    const null0 = p.kw != null && p.kw <= TOTBAND_KW && producing;
    return {
      key: p.key,
      name: p.label,
      sub: p.kw == null ? p.note ?? 'ohne Messung' : null0 ? 'liefert gerade keine Erzeugung' : p.note,
      wert: p.kw == null ? '—' : kw(p.kw),
      zahl: p.kw,
      anteil: p.kw != null && c.totalKw ? Math.min(1, p.kw / c.totalKw) : null,
      art: p.health === 'stale' ? 'still' : null0 ? 'aus' : 'normal',
      icon: 'panel',
      title: p.title,
    };
  });
  const sortiert = sortiere(zeilen);
  return {
    titel: 'Erzeugung im Detail',
    summe: kw(c.totalKw),
    zeilen: kuerzen(sortiert, opts.max, 'Quellen', false),
    gesamt: sortiert.length,
  };
}

/** Für eine Viertelstunde außerhalb von „jetzt“ gibt es keine Aufteilung je Gerät. */
export function ohneAufteilung(titel: string, summe: string, plan: boolean): Liste {
  return {
    titel,
    summe,
    gesamt: 1,
    zeilen: [
      {
        key: 'gesamt',
        name: plan ? (titel.startsWith('Verbrauch') ? 'Verbrauchsprognose' : 'PV-Prognose') : 'Gesamt',
        sub: plan ? 'ohne Aufteilung je Gerät' : 'je Gerät nur für jetzt und heute',
        wert: summe,
        zahl: null,
        anteil: null,
        art: plan ? 'plan' : 'normal',
        icon: titel.startsWith('Verbrauch') ? 'home' : 'panel',
        title: null,
      },
    ],
  };
}

/**
 * Die Aufschlüsselung einer kanonischen Rolle (Summenwert, `GET …/rollen/…`)
 * in derselben Listenform - für das Blatt des Knotens. Ein stummes Gerät hat
 * keinen Wert, nur sein Wort; die Summe ist die des Servers, nie nachgerechnet.
 */
export function rollenListe(wert: RollenKanonischerWert | null | undefined): Liste | null {
  const view = rollenView(wert);
  if (!view || !wert) return null;
  const netz = wert.role === 'grid';
  const titel = wert.role === 'pv' ? 'Erzeugung im Detail' : wert.role === 'grid' ? 'Netz im Detail' : 'Verbrauch im Detail';
  const icon: ZeilenIcon = wert.role === 'pv' ? 'panel' : wert.role === 'grid' ? 'plug' : 'home';
  const bezug = view.zeilen.reduce((s, z) => s + Math.abs(z.kw ?? 0), 0);
  const zeilen: ListenZeile[] = view.zeilen.map((z) => ({
    key: z.entityId,
    name: z.name,
    sub: !z.liefernd ? 'liefert gerade nicht' : netz && z.kw != null ? (z.kw < -TOTBAND_KW ? 'Einspeisung' : z.kw > TOTBAND_KW ? 'Bezug' : null) : null,
    wert: z.kw == null ? '—' : kw(Math.abs(z.kw)),
    zahl: z.kw == null ? null : Math.abs(z.kw),
    anteil: z.kw != null && bezug > 0 ? Math.min(1, Math.abs(z.kw) / bezug) : null,
    art: z.liefernd ? 'normal' : 'still',
    icon,
    title: null,
  }));
  const fuss = [rollenStand(view.stand)];
  const teil = teilSummeText(view);
  if (teil) fuss.push(`Summe ${teil}`);
  if (view.summenwertHinweis) fuss.push(`Ein ${SUMMENWERT} kann mehreren Geräten zugeordnet sein. Er zählt in der Anlagenzahl einmal.`);
  return {
    titel,
    summe: view.summe == null ? '—' : kw(Math.abs(view.summe)),
    zeilen: sortiere(zeilen),
    gesamt: zeilen.length,
    fuss,
  };
}
