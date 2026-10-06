/**
 * Die Seite eines Energieeinsatzes unter „Verbrauch“ (Konzept Auswerten a1 §6.8): Was braucht der Bereich, und warum
 * ist er wesentlich? Reine Ableitungen für `pages/EnergieeinsatzSeite.tsx` — Antwortsatz, Verbrauch des letzten vollen
 * Monats mit Vorjahr und zwölf Monaten Verlauf, die Zähler mit ihrer Monatsmenge und die Kriterien der Einstufung in
 * Worten. Gelesen wird die Rangliste (der Monat, derselbe Monat ein Jahr früher, die zwölf Monate bis zu ihm) und
 * `letzter_monat` je Messstelle; die Zahlen bildet der Server, die Monatssumme der Zähler der Zwilling der Bewertung
 * (`uemsBewertung.menge`, dieselbe Regel wie die Menge der Rangliste) — Wächter Q5.
 */
import type {
  BewertungRangliste,
  BewertungRanglisteEinsatz,
  Energieeinsatz,
  EnergieeinsatzEinstufungFassung,
  EnergieeinsatzMessstelle,
} from './api';
import { dez, dezVergleich } from './dez';
import { UEMS_BEWERTUNG_URTEILE } from './glossar';
import { menge as mengeAusZaehlern } from './uemsBewertung';
import { KWH, MIT_ERSATZWERT, PROZENT, UNVOLLSTAENDIG, zahl as zahlText } from './uemsErgebnis';
import { anteilText, kwhText, kwhZahl, monatPlus, monatWort, prozentGanz, vollstaendigeMenge, vorjahrVergleich, type VorjahrVergleich } from './verbrauch';

/** Ein Dezimaltext der Route als Zahl — NUR zur Anzeige (`toLocaleString`) und für die Geometrie der Linie. */
const zahl = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Eine Monatsmenge der Werte-Route (Zahl) als Dezimaltext für den Zwilling; was keiner ist, bleibt `null`. */
const alsText = (n: number | null): string | null => {
  if (n === null) return null;
  const t = String(n);
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
};
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
  /** Nur zur Anzeige; die Menge selbst ist der Dezimaltext der Rangliste. */
  menge: number | null;
  /** Die Einheit der Rangliste (ein Gas-Einsatz misst in m³, nie still „kWh“). */
  einheit: string;
  zustand: string | null;
  /** Vollständig oder mit Ersatzwert (Ersatz ist Teil der Menge). */
  vollstaendig: boolean;
  /** Der Anteil am Strom als Dezimaltext der Rangliste. */
  anteil: string | null;
  vorjahr: VorjahrVergleich | null;
  /** Die zwölf Monate bis `monat`; `null`, wenn die Monatsmengen der Zähler den Bereich nicht genau ergeben. */
  verlauf: { monat: string; wert: number | null }[] | null;
}

const zeile = (r: BewertungRangliste | null, id: string): BewertungRanglisteEinsatz | null =>
  r ? [...r.einsaetze, ...r.weitere_traeger].find((x) => x.id === id) ?? null : null;

/** Die Zähler eines Einsatzes als Eingang des Zwillings — mit der Menge, die `menge` je Zähler liefert. */
const zaehlerEingang = (z: BewertungRanglisteEinsatz, menge: (m: BewertungRanglisteEinsatz['messstellen'][number]) => string | null) =>
  z.messstellen.map((m) => ({ kennung: m.kennzeichen, traeger: z.traeger, art: 'gemessen' as const, direkt: true, archiviert: false, wert: menge(m), ersatz: '0' }));

/**
 * Die zwölf Monatswerte des Bereichs aus den Monatsmengen seiner Zähler — summiert vom Zwilling, nur wenn die Zähler
 * zusammen genau die Menge des Bereichs ergeben (ein Zähler, der nur anteilig zählt, hätte sonst eine zu große Linie).
 * Ein Monat, in dem ein Zähler fehlt oder unvollständig ist, bleibt eine Lücke — nie eine Teilsumme.
 */
function verlaufAusZaehlern(z: BewertungRanglisteEinsatz | null, monat: string): EinsatzVerbrauch['verlauf'] {
  if (!z || z.menge === null || z.messstellen.length === 0 || !z.messstellen.every((x) => x.monatswerte)) return null;
  try {
    const ganz = mengeAusZaehlern(zaehlerEingang(z, (m) => m.menge), z.traeger);
    if (ganz.menge === null || ganz.zustand === UNVOLLSTAENDIG || dezVergleich(dez(ganz.menge), dez(z.menge)) !== 0) return null;
    return Array.from({ length: 12 }, (_, i) => monatPlus(monat, i - 11)).map((mo) => {
      const imMonat = mengeAusZaehlern(
        zaehlerEingang(z, (m) => {
          const w = m.monatswerte?.werte.find((v) => v.von.slice(0, 7) === mo);
          return w && vollstaendigeMenge({ menge: alsText(w.menge), zustand: w.zustand }) ? alsText(w.menge) : null;
        }),
        z.traeger,
      );
      return { monat: mo, wert: imMonat.zustand === UNVOLLSTAENDIG ? null : zahl(imMonat.menge) };
    });
  } catch {
    // Ein Träger oder Zähler, den der Zwilling nicht kennt: keine Linie statt einer geratenen.
    return null;
  }
}

/** Der Verbrauch des Bereichs im Monat `monat` aus drei Abrufen der Rangliste (Monat, Vorjahresmonat, zwölf Monate). */
export function einsatzVerbrauch(
  id: string,
  monat: string,
  imMonat: BewertungRangliste | null,
  vorjahr: BewertungRangliste | null,
  zwoelf: BewertungRangliste | null,
): EinsatzVerbrauch {
  const m = zeile(imMonat, id);
  return {
    monat,
    menge: zahl(m?.menge),
    einheit: m?.einheit ?? KWH,
    zustand: m?.zustand ?? null,
    vollstaendig: vollstaendigeMenge(m),
    anteil: m?.anteil_prozent ?? null,
    // Verglichen wird nur Vollständiges mit Vollständigem; ein fehlendes oder unvollständiges Vorjahr sagt das.
    vorjahr: m && vorjahr ? vorjahrVergleich(m, zeile(vorjahr, id)) : null,
    verlauf: verlaufAusZaehlern(zeile(zwoelf, id), monat),
  };
}

/** „88.200 kWh“ bzw. „1.240 m³“: die Menge in der Einheit der Rangliste. */
export const mengeText = (v: Pick<EinsatzVerbrauch, 'menge' | 'einheit'>) =>
  v.menge === null ? null : v.einheit === KWH ? kwhText(v.menge) : `${kwhZahl(v.menge)}\u00a0${v.einheit}`;

/** „Spritzguss brauchte im September 2026 88.200 kWh – 44 % des Stroms, so viel wie im Vorjahr.“ */
export function einsatzAntwort(e: Pick<Energieeinsatz, 'name' | 'traeger' | 'keine_werte'>, v: EinsatzVerbrauch): string {
  const wann = monatWort(v.monat);
  const menge = mengeText(v);
  if (menge === null) {
    return e.traeger === 'Strom'
      ? `${e.name}: Für ${wann} liegen keine Werte vor.`
      : `${e.name}: ${e.traeger} wird noch nicht gemessen – für ${wann} gibt es keine Menge.`;
  }
  const teile = [`${e.name} brauchte im ${wann} ${menge}`];
  const rest: string[] = [];
  if (v.anteil !== null && e.traeger === 'Strom') rest.push(`${prozentGanz(v.anteil)} des Stroms`);
  if (v.vorjahr?.richtung === 'gleich') rest.push('so viel wie im Vorjahr');
  else if (v.vorjahr?.richtung === 'rauf' || v.vorjahr?.richtung === 'runter') {
    rest.push(`${v.vorjahr.text.replace(/^[▲▼] /, '').replace(' ggü. Vorjahr', '')} ${v.vorjahr.richtung === 'rauf' ? 'mehr' : 'weniger'} als im Vorjahr`);
  }
  if (rest.length > 0) teile.push(rest.join(', '));
  const zusatz = v.vollstaendig ? (v.zustand === MIT_ERSATZWERT ? ` (${MIT_ERSATZWERT})` : '') : ` (${UNVOLLSTAENDIG})`;
  // Ein Gedankenstrich steht nie am Zeilenanfang: davor ein geschütztes Leerzeichen.
  return `${teile.join('\u00a0– ')}${zusatz}.`;
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

/**
 * Ein Kriterium in Worten. `offen`: die Regel ließ es für diese Datengrundlage nicht prüfen (K2 „nicht belastbar“,
 * solange zu wenig Strom einem Bereich zugeordnet ist; K3 „nicht anwendbar“ ohne zwölf Monate; K1 ohne vollständigen
 * Hauptzähler-Wert) — das ist kein „nicht erfüllt“.
 */
export interface KriteriumZeile {
  stand: 'erfuellt' | 'nicht_erfuellt' | 'offen';
  text: string;
  /** Die Schwelle („ab 10 %“), bei `offen` der Grund. */
  zusatz: string | null;
  /** Für Vorleser: „erfüllt“, „nicht erfüllt“ oder das Wort der Regel („nicht belastbar“, „nicht anwendbar“). */
  urteil: string;
}

/** Ein Schwellenwert der Kriterien-Fassung, wie vereinbart (ungerundet): „10 %“, „100.000 kWh“. */
const schwelle = (wert: string, einheit: string) => zahlText(wert, einheit, einheit === KWH ? 'jahr' : null, 'vereinbart');

function stand(urteil: string, text: string, ab: string | null, offen: string): KriteriumZeile {
  if (urteil === 'ueber_schwelle') return { stand: 'erfuellt', text, zusatz: ab, urteil: 'erfüllt' };
  if (urteil === 'unter_schwelle') return { stand: 'nicht_erfuellt', text, zusatz: ab, urteil: 'nicht erfüllt' };
  const wort = UEMS_BEWERTUNG_URTEILE[urteil as keyof typeof UEMS_BEWERTUNG_URTEILE] ?? urteil;
  return { stand: 'offen', text, zusatz: `${wort} – ${offen}`, urteil: wort };
}

/**
 * „Warum wesentlich“ in Worten statt K1 bis K3 (Konzept a1 §6.7/§6.8): je Kriterium der Wert über der Datengrundlage
 * und die Schwelle — oder, wo die Regel es nicht prüfen ließ, warum. `null`, wenn die Datengrundlage noch keine Menge
 * für den Bereich hat — dann lässt sich nichts prüfen, und die Seite sagt das.
 */
export function kriterienInWorten(r: BewertungRangliste | null, rang: BewertungRanglisteEinsatz | null): KriteriumZeile[] | null {
  if (!r || !rang || rang.menge === null || rang.traeger !== 'Strom') return null;
  const w = r.kriterien.werte;
  const menge = zahl(rang.menge);
  const zeitraum = r.monate === 12 ? 'im Jahr' : `in ${r.monate} Monaten`;
  const k2 = `zu den größten Bereichen, die zusammen ${schwelle(w.K2, PROZENT)} ausmachen`;
  const zugeordnet = r.abdeckung_prozent === null ? null : prozentGanz(r.abdeckung_prozent);
  return [
    stand(
      rang.urteil.K1,
      rang.anteil_prozent === null ? 'Anteil am Strom unbekannt' : `${anteilText(rang.anteil_prozent)} des Stroms`,
      `ab ${schwelle(w.K1, PROZENT)}`,
      'ohne vollständigen Hauptzähler-Wert gibt es keinen Anteil am Strom',
    ),
    stand(
      rang.urteil.K2,
      rang.urteil.K2 === 'ueber_schwelle' ? `gehört ${k2}` : rang.urteil.K2 === 'unter_schwelle' ? `gehört nicht ${k2}` : `Rangfolge ${k2}`,
      null,
      `erst ab ${schwelle(w.K8, PROZENT)} zugeordnetem Strom${zugeordnet ? ` (jetzt ${zugeordnet})` : ''}`,
    ),
    stand(
      rang.urteil.K3,
      `${menge === null ? '–' : kwhText(menge)} ${zeitraum}`,
      `ab ${schwelle(w.K3, KWH)}`,
      'die Schwelle gilt für zwölf Monate',
    ),
  ];
}

/** Die Zeile unter dem Zitat einer Einstufung: „Ines Kaltenbach · eingestuft als wesentlich am 06.11.2026“. */
export function einstufungVon(f: EnergieeinsatzEinstufungFassung): string {
  const wie = f.einstufung === 'wesentlich' ? 'wesentlich' : 'nicht wesentlich';
  const wann = f.gueltig_ab ?? f.vorgeschlagen_ab;
  return `${f.akteur.name} · eingestuft als ${wie}${wann ? ` am ${tag(wann)}` : ''}`;
}
