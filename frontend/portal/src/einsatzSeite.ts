/**
 * Die Seite eines Energieeinsatzes unter „Verbrauch“ (Konzept Auswerten a1 §6.8): Was braucht der Bereich, und warum
 * ist er wesentlich? Reine Ableitungen für `pages/EnergieeinsatzSeite.tsx` — Antwortsatz, Verbrauch des letzten vollen
 * Monats mit Vorjahr und zwölf Monaten Verlauf, die Zähler mit ihrer Monatsmenge und die Kriterien der Einstufung in
 * Worten. Gelesen wird die Rangliste (der Monat, derselbe Monat ein Jahr früher, die zwölf Monate bis zu ihm) und
 * `letzter_monat` je Messstelle; die Zahlen bildet der Server.
 */
import type {
  BewertungRangliste,
  BewertungRanglisteEinsatz,
  Energieeinsatz,
  EnergieeinsatzEinstufungFassung,
  EnergieeinsatzMessstelle,
} from './api';
import { anteilText, kwhText, kwhZahl, monatPlus, monatWort, vorjahrVergleich, type VorjahrVergleich } from './verbrauch';

const zahl = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const prozentGanz = (n: number) => `${Math.round(n).toLocaleString('de-DE')}\u00a0%`;
const tag = (iso: string) => {
  const [j, m, t] = iso.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
};

/** Die freigegebene Einstufung, die heute gilt — sie zitiert die Seite; ohne keine. */
export const geltendeEinstufung = (fassungen: readonly EnergieeinsatzEinstufungFassung[]) =>
  fassungen.find((f) => f.freigabe_status === 'freigegeben' && !f.gueltig_bis) ?? null;

/** Die Statuszeile: „Wesentlicher Bereich · seit 06.11.2026“; ein beendeter Einsatz sagt das zuerst. */
export function einsatzStatus(e: Energieeinsatz, gilt: EnergieeinsatzEinstufungFassung | null): { text: string; seit: string | null; ton: 'wesentlich' | 'neutral' | 'beendet' } {
  if (e.beendet_am || e.gueltig_bis) {
    const bis = e.gueltig_bis ?? e.beendet_am ?? '';
    return { text: 'Beendet', seit: bis ? `am ${tag(bis)}` : null, ton: 'beendet' };
  }
  if (!gilt) return { text: 'Noch nicht eingestuft', seit: null, ton: 'neutral' };
  return gilt.einstufung === 'wesentlich'
    ? { text: 'Wesentlicher Bereich', seit: gilt.gueltig_ab ? `seit ${tag(gilt.gueltig_ab)}` : null, ton: 'wesentlich' }
    : { text: 'Nicht wesentlich', seit: gilt.gueltig_ab ? `seit ${tag(gilt.gueltig_ab)}` : null, ton: 'neutral' };
}

export interface EinsatzVerbrauch {
  monat: string;
  menge: number | null;
  vollstaendig: boolean;
  anteil: number | null;
  vorjahr: VorjahrVergleich | null;
  /** Die zwölf Monate bis `monat`; `null`, wenn die Monatsmengen der Zähler den Bereich nicht genau ergeben. */
  verlauf: { monat: string; wert: number | null }[] | null;
}

const zeile = (r: BewertungRangliste | null, id: string): BewertungRanglisteEinsatz | null =>
  r ? [...r.einsaetze, ...r.weitere_traeger].find((x) => x.id === id) ?? null : null;

/**
 * Der Verbrauch des Bereichs im Monat `monat` aus drei Abrufen der Rangliste. Der Verlauf summiert die Monatsmengen
 * seiner Zähler nur, wenn sie zusammen genau die Menge des Bereichs ergeben (ein Zähler, der nur anteilig zählt, hätte
 * sonst eine zu große Linie).
 */
export function einsatzVerbrauch(
  id: string,
  monat: string,
  imMonat: BewertungRangliste | null,
  vorjahr: BewertungRangliste | null,
  zwoelf: BewertungRangliste | null,
): EinsatzVerbrauch {
  const m = zeile(imMonat, id);
  const menge = zahl(m?.menge);
  const vollstaendig = m?.zustand === 'vollständig';
  const vj = zeile(vorjahr, id);
  let verlauf: EinsatzVerbrauch['verlauf'] = null;
  const z = zeile(zwoelf, id);
  if (z && z.messstellen.length > 0 && z.messstellen.every((x) => x.monatswerte)) {
    const summe = z.messstellen.reduce((a, x) => a + (zahl(x.menge) ?? Number.NaN), 0);
    const genau = zahl(z.menge) !== null && Math.abs(summe - (zahl(z.menge) ?? 0)) < 0.5;
    if (genau) {
      const monate = Array.from({ length: 12 }, (_, i) => monatPlus(monat, i - 11));
      verlauf = monate.map((mo) => {
        let wert: number | null = 0;
        for (const x of z.messstellen) {
          const w = x.monatswerte?.werte.find((v) => v.von.slice(0, 7) === mo)?.menge ?? null;
          wert = wert === null || w === null ? null : wert + w;
        }
        return { monat: mo, wert };
      });
    }
  }
  return {
    monat,
    menge,
    vollstaendig,
    anteil: zahl(m?.anteil_prozent),
    vorjahr: vollstaendig && vorjahr ? vorjahrVergleich(menge, zahl(vj?.menge)) : null,
    verlauf,
  };
}

/** „Spritzguss brauchte im September 2026 88.200 kWh – 44 % des Stroms, so viel wie im Vorjahr.“ */
export function einsatzAntwort(e: Pick<Energieeinsatz, 'name' | 'traeger' | 'keine_werte'>, v: EinsatzVerbrauch): string {
  const wann = monatWort(v.monat);
  if (v.menge === null) {
    return e.traeger === 'Strom'
      ? `${e.name}: Für ${wann} liegen keine Werte vor.`
      : `${e.name}: ${e.traeger} wird noch nicht gemessen – für ${wann} gibt es keine Menge.`;
  }
  const teile = [`${e.name} brauchte im ${wann} ${kwhText(v.menge)}`];
  const rest: string[] = [];
  if (v.anteil !== null && e.traeger === 'Strom') rest.push(`${prozentGanz(v.anteil)} des Stroms`);
  if (v.vorjahr?.richtung === 'gleich') rest.push('so viel wie im Vorjahr');
  else if (v.vorjahr?.richtung === 'rauf' || v.vorjahr?.richtung === 'runter') {
    rest.push(`${v.vorjahr.text.replace(/^[▲▼] /, '').replace(' ggü. Vorjahr', '')} ${v.vorjahr.richtung === 'rauf' ? 'mehr' : 'weniger'} als im Vorjahr`);
  }
  if (rest.length > 0) teile.push(rest.join(', '));
  // Ein Gedankenstrich steht nie am Zeilenanfang: davor ein geschütztes Leerzeichen.
  return `${teile.join('\u00a0– ')}${v.vollstaendig ? '' : ' (unvollständig)'}.`;
}

export interface ZaehlerZeile {
  id: string;
  name: string;
  kennzeichen: string;
  ort: string | null;
  wert: string | null;
  monat: string | null;
  zustand: string | null;
  ton: 'ok' | 'warn' | 'aus';
}

/** „Gemessen von“: je Messstelle Name, Ort und die Menge des letzten vollen Monats (`letzter_monat`). */
export function zaehlerZeilen(e: Energieeinsatz, ortText: (m: EnergieeinsatzMessstelle) => string): ZaehlerZeile[] {
  return e.messstellen.map((m) => {
    const w = (m.letzter_monat?.werte ?? [])[(m.letzter_monat?.werte.length ?? 0) - 1] ?? null;
    const menge = w?.menge ?? null;
    const zustand = w?.zustand ?? null;
    return {
      id: m.id,
      name: m.name,
      kennzeichen: m.kennzeichen,
      ort: ortText(m) || null,
      wert: menge === null ? null : `${kwhZahl(menge)}\u00a0${m.letzter_monat?.messstelle.einheit ?? 'kWh'}`,
      monat: w ? monatKurzJahr(w.von.slice(0, 7)) : null,
      zustand,
      ton: menge === null ? 'aus' : zustand === 'vollständig' ? 'ok' : 'warn',
    };
  });
}

const KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monatKurzJahr = (monat: string) => `${KURZ[Number(monat.slice(5, 7)) - 1]} ${monat.slice(0, 4)}`;
export { monatKurzJahr };

export interface KriteriumZeile {
  erfuellt: boolean;
  text: string;
  schwelle: string | null;
}

/**
 * „Warum wesentlich“ in Worten statt K1 bis K3 (Konzept a1 §6.7/§6.8): je Kriterium der Wert über der Datengrundlage
 * und die Schwelle. `null`, wenn die Datengrundlage noch keine Menge für den Bereich hat — dann lässt sich nichts
 * prüfen, und die Seite sagt das.
 */
export function kriterienInWorten(r: BewertungRangliste | null, rang: BewertungRanglisteEinsatz | null): KriteriumZeile[] | null {
  if (!r || !rang || rang.menge === null || rang.traeger !== 'Strom') return null;
  const w = r.kriterien.werte;
  const anteil = zahl(rang.anteil_prozent);
  const menge = zahl(rang.menge) ?? 0;
  const ueber = (u: string) => u === 'ueber_schwelle';
  const zeitraum = r.monate === 12 ? 'im Jahr' : `in ${r.monate} Monaten`;
  return [
    {
      erfuellt: ueber(rang.urteil.K1),
      text: anteil === null ? 'Anteil am Strom unbekannt' : `${anteilText(anteil)} des Stroms`,
      schwelle: `ab ${Number(w.K1).toLocaleString('de-DE')}\u00a0%`,
    },
    {
      erfuellt: ueber(rang.urteil.K2),
      text: ueber(rang.urteil.K2)
        ? `gehört zu den größten Bereichen, die zusammen ${Number(w.K2).toLocaleString('de-DE')}\u00a0% ausmachen`
        : `gehört nicht zu den größten Bereichen, die zusammen ${Number(w.K2).toLocaleString('de-DE')}\u00a0% ausmachen`,
      schwelle: null,
    },
    {
      erfuellt: ueber(rang.urteil.K3),
      text: `${kwhText(menge)} ${zeitraum}`,
      schwelle: `ab ${kwhText(Number(w.K3))}`,
    },
  ];
}

/** Die Zeile unter dem Zitat einer Einstufung: „Ines Kaltenbach · eingestuft als wesentlich am 06.11.2026“. */
export function einstufungVon(f: EnergieeinsatzEinstufungFassung): string {
  const wie = f.einstufung === 'wesentlich' ? 'wesentlich' : 'nicht wesentlich';
  const wann = f.gueltig_ab ?? f.vorgeschlagen_ab;
  return `${f.akteur.name} · eingestuft als ${wie}${wann ? ` am ${tag(wann)}` : ''}`;
}
