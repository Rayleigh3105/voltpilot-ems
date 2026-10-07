/**
 * Die energetische Bewertung als Ergebnis (Konzept Auswerten a1 §6.7, Captain-Freigabe 06.10.2026) — rein.
 *
 * Die Seite zeigt ihr Ergebnis statt ihrer Rohdaten: welche Bereiche wesentlich sind (mit Anteil, Menge und
 * Verantwortlichen), welche nicht und wo eine Einstufung vom Vorschlag abweicht. Die Kriterien stehen in Worten; die
 * Kürzel K1 bis K8 bleiben in Bericht, Prüfsumme und Kriterien-Dialog (§10.10). Zahlen und Urteile kommen fertig aus der
 * Rangliste (über die Datengrundlage, Befund 2), die Einstufungen aus ihren Fassungen; hier wird nur gewählt, gezählt und
 * in Sätze gesetzt. Eine Einstufung trifft immer eine Person — ein Vorschlag ohne Messwerte ist keiner.
 *
 * Wächter Q5 (`test/oberflaechenArithmetik.json`): die Menge der wesentlichen Bereiche summiert der Zwilling der
 * Bewertung (`uemsBewertung.menge`, B3), ihren Anteil und den des Rests am Hauptzähler bildet `uemsBewertung.prozent`
 * (KR4); wie viel zugeordnet ist, sagt die Route (`abdeckung_prozent`). Zahlen dienen hier nur Anzeige und Balkenbreite.
 */
import type {
  Bericht,
  BerichtDetail,
  BerichtEntwurf,
  BerichtStandKurz,
  BewertungKriterienFassung,
  BewertungKriterienWerte,
  BewertungRangliste,
  BewertungRanglisteEinsatz,
  BewertungUmfang,
  Energieeinsatz,
  EnergieeinsatzEinstufungFassung,
  EnergieTraeger,
  Messbedarf,
} from './api';
import { laeuft, tag, verantwortlichText, OHNE_VERANTWORTLICH } from './bewertung';
import { bewertungWaehlen, bewertungJahr } from './bewertungStand';
import { tagText } from './bewertungFrist';
import { iso } from './bezugsPeriode';
import {
  UEMS_BEWERTUNG_SAETZE,
  UEMS_EINSTUFUNGEN,
  UEMS_NICHT_WESENTLICHE_BEREICHE,
  UEMS_NOCH_NICHT_EINGESTUFT,
  UEMS_NOCH_OHNE_WERTE,
  UEMS_WESENTLICHE_BEREICHE,
} from './glossar';
import { dez, dezVergleich } from './dez';
import { prozessSummeHinweisSatz } from './kostenstellenUebersicht';
import { MEDIEN_WAEHLBAR } from './uemsMessstelle';
import { menge as mengeDerBereiche, prozent as anteilAmGanzen, STARTWERTE } from './uemsBewertung';
import { KWH, PROZENT, VOLLSTAENDIG, VOR_EINHEIT, zahl as zahlText, zahlMitStellen } from './uemsErgebnis';

// ------------------------------------------------------------------ Zahlen

const NBSP = '\u00a0';
const zahl = (n: number, stellen = 0) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
/** Eine Schwelle wie eingegeben: `10` → „10“, `7.5` → „7,5“. */
const schwelle = (wert: string | number) => {
  const n = Number(wert);
  return zahl(n, Number.isInteger(n) ? 0 : 1);
};
/** „40,6 %“ (eine Nachkommastelle) bzw. „68 %“ (ganze Zahl im Antwortsatz und in den Kacheln). */
export const prozent = (n: number, stellen = 1) => `${zahl(n, stellen)}${NBSP}%`;
/** „1.017.050 kWh“, „1.240,0 m³“ — wie AP-08 E11: kWh über Monate ganzzahlig, m³ mit einer Stelle. */
export const mengeText = (n: number, einheit: string | null) =>
  `${zahl(n, einheit === 'kWh' ? 0 : 1)}${einheit ? `${NBSP}${einheit}` : ''}`;

const ZAHLWORT = ['keine', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
/** „eine Einstufung“, aber „ein Bereich“: die Eins richtet sich nach dem Wort. */
const zahlwort = (n: number, maennlich = false) => (n === 1 && maennlich ? 'ein' : (ZAHLWORT[n] ?? String(n)));
const gross = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
/** Ein Prozent-Dezimaltext der Route oder des Zwillings: „49.96“ → „50“ (ganze Zahl in Satz und Kachel). */
const ganzeProzent = (p: string) => zahlMitStellen(p, 0, PROZENT).replace(`${VOR_EINHEIT}${PROZENT}`, '');
/** Absteigend nach Menge (Vergleich der gelieferten Beträge, keine Rechnung); ohne Menge am Ende. */
const nachMenge = (a: string | null, b: string | null) =>
  a === null || b === null ? (a === null ? (b === null ? 0 : 1) : -1) : dezVergleich(dez(b), dez(a));
/** „Spritzguss, Montage und Verwaltung“. */
export const aufzaehlung = (teile: readonly string[]) =>
  teile.length < 2 ? (teile[0] ?? '') : `${teile.slice(0, -1).join(', ')} und ${teile[teile.length - 1]}`;

// ------------------------------------------------------------------ Einstufung und Vorschlag

type Einstufung = EnergieeinsatzEinstufungFassung['einstufung'] | 'offen';

/** Die geltende Fassung: freigegeben und nicht beendet. Eine beantragte gilt noch nicht. */
export const geltendeEinstufung = (f: readonly EnergieeinsatzEinstufungFassung[] | undefined) =>
  f?.find((x) => x.freigabe_status === 'freigegeben' && !x.gueltig_bis) ?? null;
export const wartendeEinstufung = (f: readonly EnergieeinsatzEinstufungFassung[] | undefined) =>
  f?.find((x) => x.freigabe_status === 'beantragt') ?? null;

export interface VorschlagBild {
  wesentlich: boolean;
  /** „im 80-%-Block“, „8,6 % des Stroms, ab 10 %“, „166.880 kWh im Jahr, ab 100.000“. */
  grund: string | null;
}

/**
 * Der Vorschlag einer Zeile — nur, wenn er auf Messwerten beruht: ohne Menge sind alle Kriterien „nicht anwendbar“ und
 * die Route sagt „unter Schwelle“; das ist kein Vorschlag, und eine Einstufung weicht davon nicht ab.
 */
export function vorschlagBild(
  r: Pick<BewertungRanglisteEinsatz, 'menge' | 'urteil' | 'vorschlag' | 'anteil_prozent'> | undefined,
  k?: BewertungKriterienWerte | null,
): VorschlagBild | null {
  if (!r || r.menge === null) return null;
  const { K1, K2, K3 } = r.urteil;
  if (![K1, K2, K3].some((u) => u === 'ueber_schwelle' || u === 'unter_schwelle')) return null;
  if (r.vorschlag !== 'ueber_schwelle') return { wesentlich: false, grund: null };
  if (K1 === 'ueber_schwelle' && r.anteil_prozent !== null)
    return { wesentlich: true, grund: `${prozent(Number(r.anteil_prozent))} des Stroms${k ? `, ab ${schwelle(k.K1)}${NBSP}%` : ''}` };
  if (K2 === 'ueber_schwelle') return { wesentlich: true, grund: k ? `im ${schwelle(k.K2)}-%-Block` : 'unter den größten Bereichen' };
  if (K3 === 'ueber_schwelle')
    return { wesentlich: true, grund: `${mengeText(Number(r.menge), 'kWh')} im Jahr${k ? `, ab ${zahl(Number(k.K3))}` : ''}` };
  return { wesentlich: true, grund: null };
}

/** Der Vorschlag oben im Einstufen-Dialog (§6.11): ein Satz mit Grund, ohne Kürzel. */
export function vorschlagSatz(r: Pick<BewertungRanglisteEinsatz, 'menge' | 'urteil' | 'vorschlag' | 'anteil_prozent'>): string {
  const v = vorschlagBild(r);
  if (!v) return 'Noch kein Vorschlag - für den Zeitraum fehlen Messwerte. Sie können trotzdem begründet einstufen.';
  return v.wesentlich
    ? `VoltPilot schlägt „wesentlich“ vor${v.grund ? `: ${v.grund}` : ''}.`
    : 'VoltPilot schlägt „nicht wesentlich“ vor - kein Kriterium trifft zu.';
}

/** Vorbehalte der Datenlage in Worten (statt „K5 · Vorbehalt: Datenlage“). */
export function vorbehaltSaetze(r: Pick<BewertungRanglisteEinsatz, 'urteil' | 'datenlage_prozent' | 'ersatz_prozent' | 'menge'>): string[] {
  if (r.menge === null) return [];
  const s: string[] = [];
  if (r.urteil.K5 !== 'erfuellt')
    s.push(`Vorbehalt: Daten liegen nur für ${r.datenlage_prozent !== null ? prozent(Number(r.datenlage_prozent)) : 'einen Teil'} des Zeitraums vor.`);
  if (r.urteil.K6 !== 'erfuellt')
    s.push(`Vorbehalt: ${r.ersatz_prozent !== null ? prozent(Number(r.ersatz_prozent)) : 'ein Teil'} der Menge sind Ersatzwerte.`);
  return s;
}

/** Die Gründe einer Einstufung in Worten (statt „K1 · K2 · K3 · K4“). */
export const GRUND_WOERTER: Record<'K1' | 'K2' | 'K3' | 'K4', string> = {
  K1: 'Anteil am Strom über der Schwelle',
  K2: 'unter den größten Bereichen',
  K3: 'Jahresmenge über der Schwelle',
  K4: 'begründete Einschätzung einer Person',
};
export const gruendeText = (grund: readonly string[]) =>
  aufzaehlung(grund.map((g) => GRUND_WOERTER[g as keyof typeof GRUND_WOERTER] ?? g));

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monatText = (ym: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONATE[Number(m[2]) - 1]} ${m[1]}` : ym;
};
/** „2026-10“ → „Oktober 2026“, „2027-11/2028-10“ → „November 2027 bis Oktober 2028“. */
export const zeitraumText = (z: string | null | undefined): string | null => {
  if (!z) return null;
  const [von, bis] = z.split('/');
  return bis && bis !== von ? `${monatText(von)} bis ${monatText(bis)}` : monatText(von);
};

const einstufungWort = (e: Einstufung) => UEMS_EINSTUFUNGEN[e];
const vorschlagWort = (v: VorschlagBild) => (v.wesentlich ? UEMS_EINSTUFUNGEN.wesentlich : UEMS_EINSTUFUNGEN.nicht_wesentlich);

// ------------------------------------------------------------------ Bereiche

/** Ein Teil der leisen Zeile unter einer Reihe; `breit` steht nur am Rechner (Konzept: Einstufung mit Fassung). */
export interface ZeilenTeil {
  text: string;
  breit?: boolean;
}

export interface BereichReihe {
  id: string;
  kennzeichen: string;
  name: string;
  einstufung: Einstufung;
  /** Rechts in der Reihe: „40,6 %“, bei Trägern ohne Anteil die Menge („1.240 m³“), ohne Wert „–“. */
  wert: string;
  /** Unter dem Balken rechts: „1.017.050 kWh“; ohne Anteil oder ohne Menge kein Balken. */
  menge: string | null;
  /** Breite des Balkens in % des größten Bereichs (Strom). */
  balken: number | null;
  teile: ZeilenTeil[];
  /** R16: eine Summe dieses Bereichs enthält einen Anteil eines anderen Prozesses - ein Satz je Fall, unter der Reihe. */
  hinweise: string[];
  abweichung: boolean;
  wartet: boolean;
}

export type GruppenSchluessel = 'wesentlich' | 'nicht_wesentlich' | 'offen' | 'ohne_werte';

export interface BereichGruppe {
  key: GruppenSchluessel;
  titel: string;
  reihen: BereichReihe[];
}

const GRUPPEN: { key: GruppenSchluessel; titel: string }[] = [
  { key: 'wesentlich', titel: UEMS_WESENTLICHE_BEREICHE },
  { key: 'nicht_wesentlich', titel: UEMS_NICHT_WESENTLICHE_BEREICHE },
  { key: 'offen', titel: UEMS_NOCH_NICHT_EINGESTUFT },
  { key: 'ohne_werte', titel: UEMS_NOCH_OHNE_WERTE },
];

/** Warum ein Bereich noch ohne Werte ist: ein Träger ohne Anteil sagt es selbst; Zähler, die sich nicht anlegen lassen, auch. */
function ohneWerteGrund(traeger: EnergieTraeger): string {
  if (traeger === 'Strom') return 'noch kein Zähler liefert Werte';
  const anlegbar = (MEDIEN_WAEHLBAR as readonly string[]).includes(traeger);
  return `${traeger} zählt im Umfang ohne Anteil am Strom${anlegbar ? '' : `; ${traeger}zähler lassen sich noch nicht anlegen`}`;
}

export interface ErgebnisEingabe {
  einsaetze: readonly Energieeinsatz[];
  rangliste: BewertungRangliste | null;
  einstufungen: Readonly<Record<string, EnergieeinsatzEinstufungFassung[]>>;
  umfang: BewertungUmfang | null;
  /** „April 2028 bis März 2029“ — die Datengrundlage (Befund 2). */
  zeitraum: string;
  /** Alle Messbedarfe; `null`, wenn sie nicht gelesen werden konnten (dann keine Kachel und keine Marke). */
  messbedarfe: readonly Messbedarf[] | null;
}

export interface KachelBild {
  wert: string | null;
  einheit: string | null;
  /** Leise Zeile am Telefon bzw. am Rechner (das Konzept zeigt am Rechner mehr Platz, andere Sätze). */
  sub: string | null;
  subBreit: string | null;
  marke: { text: string; ton: 'ok' | 'warn' } | null;
}

export interface Ergebnis {
  /** Keine laufenden Bereiche: die Seite sagt erst, wozu, dann der Knopf (§6.13). */
  leer: boolean;
  antwort: string;
  /** Am Rechner im Antwortsatz: „Drei Einstufungen weichen begründet vom Vorschlag ab.“ */
  zusatz: string | null;
  formal: string;
  /** Wie verlässlich die Zahlen sind — vor der Liste, nie als Fußnote (Copy-Regel 4). */
  vertrauen: string | null;
  kacheln: {
    wesentlich: KachelBild;
    anteil: KachelBild;
    rest: KachelBild;
    bedarfe: KachelBild | null;
  };
  gruppen: BereichGruppe[];
}

const bereicheWort = (n: number) => (n === 1 ? 'Bereich' : 'Bereichen');

export function bewertungErgebnis(e: ErgebnisEingabe): Ergebnis {
  const r = e.rangliste;
  const kriterien = r?.kriterien.werte ?? null;
  const zeilen = new Map<string, BewertungRanglisteEinsatz>();
  for (const z of [...(r?.einsaetze ?? []), ...(r?.weitere_traeger ?? [])]) zeilen.set(z.id, z);
  const laufend = e.einsaetze.filter(laeuft);
  const offeneBedarfe = new Set((e.messbedarfe ?? []).filter((b) => b.zustand === 'offen').map((b) => b.energieeinsatz_id));
  const groesste = Math.max(0, ...laufend.map((x) => zeilen.get(x.id)).filter((z) => z?.traeger === 'Strom' && z.menge !== null).map((z) => Number(z!.menge)));
  const mitWerten = laufend.some((x) => zeilen.get(x.id)?.menge != null);

  const reihen = laufend.map((einsatz) => {
    const z = zeilen.get(einsatz.id);
    const f = geltendeEinstufung(e.einstufungen[einsatz.id]);
    const wartet = wartendeEinstufung(e.einstufungen[einsatz.id]) !== null;
    const einstufung: Einstufung = f ? f.einstufung : 'offen';
    const menge = z?.menge != null ? Number(z.menge) : null;
    const strom = einsatz.traeger === 'Strom';
    const anteil = strom && z?.anteil_prozent != null ? z.anteil_prozent : null;
    const vorschlag = kriterien ? vorschlagBild(z, kriterien) : null;
    const abweichung = !!f && !!vorschlag && vorschlag.wesentlich !== (f.einstufung === 'wesentlich');
    const ohneWerte = menge === null && einsatz.keine_werte;
    const teile: ZeilenTeil[] = [];
    if (abweichung && f && vorschlag) {
      teile.push({
        text: `Vorschlag „${vorschlagWort(vorschlag)}“${vorschlag.grund ? ` (${vorschlag.grund})` : ''} · eingestuft als ${einstufungWort(f.einstufung)}${f.gueltig_ab ? ` am ${tag(f.gueltig_ab)}` : ''}: „${f.begruendung}“`,
      });
    } else if (ohneWerte) {
      teile.push({ text: einstufung === 'offen' ? 'noch nicht eingestuft' : einstufungWort(einstufung) }, { text: ohneWerteGrund(einsatz.traeger) });
    } else {
      if (einstufung === 'offen')
        teile.push({ text: vorschlag ? `Vorschlag „${vorschlagWort(vorschlag)}“${vorschlag.grund ? ` (${vorschlag.grund})` : ''}` : 'noch kein Vorschlag - es fehlen Messwerte' });
      const wer = verantwortlichText(einsatz.verantwortlich);
      teile.push({ text: wer === OHNE_VERANTWORTLICH ? 'noch ohne verantwortliche Person' : `verantwortlich ${wer}` });
      if (f) teile.push({ text: `Einstufung Fassung ${f.fassung}${f.gueltig_ab ? ` seit ${tag(f.gueltig_ab)}` : ''}`, breit: true });
      if (!strom && menge !== null) teile.push({ text: `ohne Anteil - ${einsatz.traeger} hat keinen gemeinsamen Maßstab mit Strom` });
      if (menge === null && mitWerten) teile.push({ text: `keine Messwerte für ${e.zeitraum}` });
    }
    if (wartet) teile.push({ text: 'neue Einstufung wartet auf Bestätigung' });
    if (offeneBedarfe.has(einsatz.id)) teile.push({ text: 'Messbedarf offen' });
    const reihe: BereichReihe = {
      id: einsatz.id,
      kennzeichen: einsatz.kennzeichen,
      name: einsatz.name,
      einstufung,
      wert: anteil !== null ? zahlMitStellen(anteil, 1, PROZENT) : !strom && menge !== null ? mengeText(menge, z?.einheit ?? null) : '–',
      menge: anteil !== null && menge !== null ? mengeText(menge, 'kWh') : null,
      balken: anteil !== null && menge !== null && groesste > 0 ? Math.round((menge / groesste) * 1000) / 10 : null,
      teile,
      hinweise: (z?.prozess_summe_hinweise ?? []).map(prozessSummeHinweisSatz),
      abweichung,
      wartet,
    };
    // Wesentlich eingestuft ist wesentlich — auch ohne Werte (sonst zählte die Antwort ihn, die Karte nicht).
    const gruppe: GruppenSchluessel = ohneWerte && einstufung !== 'wesentlich' ? 'ohne_werte' : einstufung;
    return { reihe, gruppe, menge, mengeText: z?.menge ?? null, strom };
  });

  // Wie die Rangliste: Strom vor den Trägern ohne Anteil (m³ ist kein kWh), die größte Menge zuerst, ohne Menge nach
  // dem Kennzeichen.
  const nr = (kz: string) => Number(kz.replace(/\D/g, '')) || 0;
  reihen.sort((a, b) => (a.strom === b.strom ? 0 : a.strom ? -1 : 1) || nachMenge(a.mengeText, b.mengeText) || nr(a.reihe.kennzeichen) - nr(b.reihe.kennzeichen));
  const gruppen = GRUPPEN.map((g) => ({ ...g, reihen: reihen.filter((x) => x.gruppe === g.key).map((x) => x.reihe) })).filter((g) => g.reihen.length > 0);

  const n = laufend.length;
  const wesentliche = reihen.filter((x) => x.reihe.einstufung === 'wesentlich');
  const w = wesentliche.length;
  const eingestuft = reihen.filter((x) => x.reihe.einstufung !== 'offen').length;
  const abweichend = reihen.filter((x) => x.reihe.abweichung).length;
  const vorgeschlagen = reihen.filter((x) => kriterien && vorschlagBild(zeilen.get(x.reihe.id), kriterien)?.wesentlich).length;

  // Menge und Anteil der wesentlichen Bereiche — nur, wenn jeder wesentliche Strom-Bereich eine Menge hat. Die Summe
  // bildet der Zwilling (B3, nie eine Summe gerundeter Anteile), den Anteil am Hauptzähler ebenso (KR4).
  const wesentlichStrom = wesentliche.filter((x) => x.strom);
  const zusammen =
    wesentlichStrom.length > 0
      ? mengeDerBereiche(
          wesentlichStrom.map((x) => ({ kennung: x.reihe.kennzeichen, traeger: 'Strom', art: 'gemessen' as const, direkt: true, archiviert: false, wert: x.mengeText, ersatz: '0' })),
          'Strom',
        )
      : null;
  const mengeSumme = zusammen?.zustand === VOLLSTAENDIG ? zusammen.menge : null;
  const anteilSumme = mengeSumme !== null && r?.nenner.wert != null ? anteilAmGanzen(dez(mengeSumme), dez(r.nenner.wert)) : null;
  const ohneMenge = wesentlichStrom.filter((x) => x.mengeText === null).map((x) => x.reihe.name);

  let antwort: string;
  let zusatz: string | null = null;
  if (n === 0) {
    antwort = 'Noch keine Bereiche festgelegt.';
  } else if (eingestuft === 0) {
    antwort = n === 1 ? 'Der Bereich ist noch nicht eingestuft.' : `Noch ist keiner der ${n} Bereiche eingestuft.`;
    if (vorgeschlagen > 0) zusatz = `VoltPilot schlägt ${vorgeschlagen} davon als wesentlich vor.`;
  } else {
    antwort =
      w === 0
        ? `Keiner der ${n} Bereiche ist als wesentlich eingestuft.`
        : `${w} von ${n} ${bereicheWort(n)} ${w === 1 ? 'ist' : 'sind'} wesentlich${anteilSumme !== null ? ` - zusammen ${zahlMitStellen(anteilSumme, 0, PROZENT)} des Stroms` : ''}.`;
    const saetze: string[] = [];
    if (abweichend > 0)
      saetze.push(`${gross(zahlwort(abweichend))} ${abweichend === 1 ? 'Einstufung weicht' : 'Einstufungen weichen'} begründet vom Vorschlag ab.`);
    const offen = reihen.filter((x) => x.reihe.einstufung === 'offen').length;
    if (offen > 0) saetze.push(`${gross(zahlwort(offen, true))} ${offen === 1 ? 'Bereich ist' : 'Bereiche sind'} noch nicht eingestuft.`);
    zusatz = saetze.length ? saetze.join(' ') : null;
  }

  // Der sachliche Untertitel: Zeitraum, woher der Strom gezählt ist, welche Träger ohne Anteil daneben stehen.
  const formal = [`Datengrundlage ${e.zeitraum}`];
  const mitNenner = (r?.anlagen ?? []).filter((a) => a.nenner !== null).map((a) => a.name);
  if (mitNenner.length > 0) formal.push(mitNenner.length <= 2 ? `Strom aus ${aufzaehlung(mitNenner)}` : `Strom aus ${mitNenner.length} Anlagen`);
  const ohneAnteil = (e.umfang?.traeger ?? []).filter((t) => !t.mit_anteil).map((t) => t.name);
  if (ohneAnteil.length > 0) formal.push(`${aufzaehlung(ohneAnteil)} ohne Anteil`);

  // Ergeben die Bereiche mehr als der Hauptzähler (Doppelzählung), ist der Rest negativ — nie „0 % · ausreichend“.
  const restNegativ = !!r?.rest && r.rest.startsWith('-');
  // Wie verlässlich: fehlende Werte zuerst, dann eine Doppelzählung, dann eine zu kurze Datengrundlage.
  let vertrauen: string | null = null;
  if (n > 0 && r) {
    if (!mitWerten) {
      vertrauen = `Für ${e.zeitraum} liegen noch keine Messwerte vor - darum fehlen Anteile und Mengen. Die Einstufungen gelten, wie sie festgelegt sind.`;
    } else if (r.nenner.wert === null) {
      vertrauen = `Werte des Hauptzählers liegen nur für ${r.nenner.anlagen} Anlagen vollständig vor - darum fehlen die Anteile am Strom.`;
    } else if (restNegativ) {
      vertrauen = 'Die Bereiche ergeben mehr Strom, als der Hauptzähler gemessen hat - vermutlich ist ein Zähler doppelt zugeordnet; die Anteile sind darum zu groß.';
    } else if (r.urteil.K7 !== 'erfuellt') {
      vertrauen = `${r.urteil.K7 === 'vorlaeufig' ? 'Vorläufig: d' : 'D'}ie Datengrundlage umfasst ${r.monate} ${r.monate === 1 ? 'Monat' : 'Monate'}; belastbar ist der Vorschlag ab ${r.kriterien.werte.K7} Monaten.`;
    }
  }

  // Der Anteil des Rests vom Zwilling (KR4); wie viel zugeordnet ist, sagt die Route — mit einer Stelle, damit „20 %“ neben
  // „belastbar ab 80 %“ nicht wie 80 % zugeordnet aussieht (79,6 % sind es nicht).
  const restProzent = r && r.rest !== null && r.nenner.wert !== null && !restNegativ ? anteilAmGanzen(dez(r.rest), dez(r.nenner.wert)) : null;
  const zugeordnet = r?.abdeckung_prozent ?? null;
  const k8 = r?.urteil.K8;
  const offeneListe = (e.messbedarfe ?? []).filter((b) => b.zustand === 'offen' && laufend.some((x) => x.id === b.energieeinsatz_id));
  const namen = wesentliche.map((x) => x.reihe.name);

  return {
    leer: n === 0,
    antwort,
    zusatz,
    formal: formal.join(' · '),
    vertrauen,
    kacheln: {
      wesentlich: {
        wert: String(w),
        einheit: `von ${n}`,
        sub: anteilSumme !== null ? `${zahlMitStellen(anteilSumme, 0, PROZENT)} des Stroms` : namen.length ? aufzaehlung(namen) : null,
        subBreit: namen.length ? namen.join(', ') : null,
        marke: null,
      },
      anteil: {
        wert: anteilSumme !== null ? ganzeProzent(anteilSumme) : null,
        einheit: anteilSumme !== null ? '%' : null,
        sub:
          mengeSumme !== null
            ? `${zahlText(mengeSumme, KWH, 'jahr')} ${r?.monate === 12 ? 'im Jahr' : r?.monate === 1 ? 'in einem Monat' : `in ${r?.monate ?? 0} Monaten`}`
            : wesentlichStrom.length === 0
              ? 'noch kein Bereich als wesentlich eingestuft'
              : ohneMenge.length < wesentlichStrom.length
                ? `${aufzaehlung(ohneMenge)} noch ohne Messwerte`
                : 'noch ohne Messwerte',
        subBreit: null,
        marke: null,
      },
      rest: restNegativ
        ? {
            wert: null,
            einheit: null,
            sub: 'Die Bereiche ergeben mehr als der Hauptzähler - Zuordnung prüfen.',
            subBreit: null,
            marke: { text: 'passt nicht', ton: 'warn' },
          }
        : {
            wert: restProzent !== null ? ganzeProzent(restProzent) : null,
            einheit: restProzent !== null ? '%' : null,
            sub:
              restProzent !== null && kriterien
                ? `${zugeordnet !== null ? `${zahlMitStellen(zugeordnet, 1, PROZENT)} zugeordnet, ` : ''}belastbar ab ${schwelle(kriterien.K8)}${NBSP}%`
                : 'Ohne vollständige Werte des Hauptzählers kein Anteil.',
            subBreit: restProzent !== null ? null : 'Ohne vollständige Werte des Hauptzählers kein Anteil.',
            marke:
              restProzent === null ? null : k8 === 'ueber_schwelle' ? { text: 'ausreichend', ton: 'ok' } : k8 === 'unter_schwelle' ? { text: 'zu wenig', ton: 'warn' } : null,
          },
      bedarfe:
        e.messbedarfe === null
          ? null
          : {
              wert: String(offeneListe.length),
              einheit: null,
              sub: offeneListe.length ? offeneListe.map((b) => b.wortlaut).join(' · ') : 'Kein Zähler geplant.',
              subBreit: null,
              marke: null,
            },
    },
    gruppen,
  };
}

// ------------------------------------------------------------------ Statuszeile

export interface StatusBild {
  ton: 'ok' | 'warn' | 'off';
  satz: string;
  sub: string | null;
  /** Fällig: die Zeile wird zur Hinweiskarte mit dem Schritt „Neuen Stand freigeben“ (Wiedervorlage). */
  faellig: boolean;
  /** Fällig: wer verantwortlich ist (S6). */
  hinweis: string | null;
}

/** „Gilt · Stand Nr. 1 vom 30.04.2029“ und „nächste Überprüfung bis 30.04.2030“ — oder warum (noch) nichts gilt. */
export function statusZeile(berichte: readonly Bericht[] | null): StatusBild {
  const b = bewertungWaehlen(berichte);
  if (!b) return { ton: 'off', satz: 'Noch keine Bewertung festgestellt', sub: null, faellig: false, hinweis: null };
  const u = b.ueberpruefung;
  if (!u) return { ton: 'off', satz: 'Noch kein Stand freigegeben', sub: 'Der Entwurf wartet auf die erste Freigabe.', faellig: false, hinweis: null };
  const stand = `Stand Nr.${NBSP}${u.stand_nr} vom ${tag(u.stand_vom)}`;
  if (u.ueberpruefung_faellig) {
    const namen = u.verantwortliche.map((v) => `${v.name} (${v.einsaetze.join(', ')})`).join(' · ');
    return {
      ton: 'warn',
      satz: u.faellig_seit_tagen === 0 || !u.faellig_am ? 'Überprüfung heute fällig' : `Überprüfung fällig seit ${tag(u.faellig_am)}`,
      sub: `${stand} - prüfen Sie den Entwurf und geben Sie einen neuen Stand frei.`,
      faellig: true,
      hinweis: namen ? UEMS_BEWERTUNG_SAETZE.fristHinweis(namen) : null,
    };
  }
  return { ton: 'ok', satz: `Gilt · ${stand}`, sub: u.faellig_am ? `nächste Überprüfung bis ${tag(u.faellig_am)}` : null, faellig: false, hinweis: null };
}

/** Das Beispiel aus der eigenen Firma im Aufklapper „Was ist die energetische Bewertung?“. */
export function bewertungBeispiel(berichte: readonly Bericht[] | null): string | null {
  const b = bewertungWaehlen(berichte);
  const u = b?.ueberpruefung;
  if (!b || !u) return null;
  return `Bei Ihnen: Bewertung ${bewertungJahr(b)}, Stand Nr.${NBSP}${u.stand_nr} vom ${tag(u.stand_vom)} - ${u.wesentliche_einsaetze} ${u.wesentliche_einsaetze === 1 ? 'Bereich' : 'Bereiche'} wesentlich.`;
}

// ------------------------------------------------------------------ Kriterien in Worten

export const KRITERIEN_BEREITS_ENTSCHIEDEN =
  'Über die beantragten Kriterien hat inzwischen eine andere Person entschieden - hier steht der neue Stand.';

export const KRITERIEN_EINLEITUNG =
  'VoltPilot schlägt einen Bereich als wesentlich vor, wenn eines davon zutrifft. Entscheiden und begründen tut immer eine Person.';

/** Die Kriterien als Sätze (§6.7); ohne Kürzel. */
export function kriterienSaetze(f: Pick<BewertungKriterienFassung, 'werte' | 'gueltig_ab' | 'herkunft'>): { saetze: string[]; fussnote: string } {
  const w = f.werte;
  return {
    saetze: [
      `Er braucht mindestens ${schwelle(w.K1)}${NBSP}% des Stroms.`,
      `Er gehört zu den größten Bereichen, die zusammen ${schwelle(w.K2)}${NBSP}% ausmachen.`,
      `Er braucht mindestens ${zahl(Number(w.K3))}${NBSP}kWh im Jahr.`,
      'Eine Person schätzt ihn begründet als wesentlich ein.',
    ],
    fussnote: `Belastbar ist der Vorschlag mit mindestens ${w.K7} vollen Monaten, ${schwelle(w.K5)}${NBSP}% Daten und höchstens ${schwelle(w.K6)}${NBSP}% Ersatzwerten. ${
      f.gueltig_ab ? `Kriterien seit ${tag(f.gueltig_ab)}.` : 'Es gelten die Startwerte von VoltPilot.'
    }`,
  };
}

/**
 * Die Felder des Kriterien-Dialogs: Wort und Kürzel (§10.10 — nur dort steht das Kürzel), der Startwert als Hinweis in
 * Worten. `mindest_monate` gehört zum Kriterium der vollen Monate.
 */
export const KRITERIEN_FELDER: Record<keyof BewertungKriterienWerte, { wort: string; kuerzel: string; einheit: string }> = {
  K1: { wort: 'Anteil am Strom, ab dem VoltPilot vorschlägt', kuerzel: 'K1', einheit: '%' },
  K2: { wort: 'Größte Bereiche, die zusammen so viel ausmachen', kuerzel: 'K2', einheit: '%' },
  K3: { wort: 'Jahresmenge, ab der VoltPilot vorschlägt', kuerzel: 'K3', einheit: 'kWh' },
  K5: { wort: 'Daten mindestens', kuerzel: 'K5', einheit: '%' },
  K6: { wort: 'Ersatzwerte höchstens', kuerzel: 'K6', einheit: '%' },
  K7: { wort: 'Volle Monate für einen belastbaren Vorschlag', kuerzel: 'K7', einheit: 'Monate' },
  K8: { wort: 'Zugeordnet mindestens, damit die Rangfolge belastbar ist', kuerzel: 'K8', einheit: '%' },
  mindest_monate: { wort: 'Vorläufig unter so vielen Monaten', kuerzel: 'K7', einheit: 'Monate' },
};
export const KRITERIEN_REIHENFOLGE = ['K1', 'K2', 'K3', 'K5', 'K6', 'K7', 'K8', 'mindest_monate'] as const;

export const kriterienFeldLabel = (k: keyof BewertungKriterienWerte) => `${KRITERIEN_FELDER[k].wort} (${KRITERIEN_FELDER[k].kuerzel})`;
const wertMitEinheit = (k: keyof BewertungKriterienWerte, wert: string | number | null) =>
  wert === null || wert === undefined ? '–' : `${k === 'K3' ? zahl(Number(wert)) : schwelle(wert)}${NBSP}${KRITERIEN_FELDER[k].einheit}`;
export const kriterienStartwert = (k: keyof BewertungKriterienWerte) => `Startwert von VoltPilot: ${wertMitEinheit(k, STARTWERTE[k])}`;

/** Was eine beantragte Fassung ändert, in Worten: „Anteil am Strom, ab dem VoltPilot vorschlägt: 10 % → 8 %“. */
export function kriterienAenderungen(alt: BewertungKriterienWerte, neu: BewertungKriterienWerte): string[] {
  return KRITERIEN_REIHENFOLGE.filter((k) => dezVergleich(dez(String(alt[k])), dez(String(neu[k]))) !== 0).map(
    (k) => `${KRITERIEN_FELDER[k].wort}: ${wertMitEinheit(k, alt[k])} → ${wertMitEinheit(k, neu[k])}`,
  );
}

/** Befund 6: die Meldung nach dem Speichern sagt, ob die Fassung gilt oder auf eine zweite Person wartet. */
export function kriterienMeldung(f: Pick<BewertungKriterienFassung, 'fassung' | 'freigabe_status'>, anstoss: string | null): string {
  if (f.freigabe_status === 'beantragt')
    return `Die neuen Kriterien (Fassung ${f.fassung}) warten auf die Freigabe durch eine zweite Person. Bis dahin gelten die bisherigen.`;
  if (f.freigabe_status === 'abgelehnt') return `Die beantragten Kriterien (Fassung ${f.fassung}) sind abgelehnt. Es gelten weiter die bisherigen.`;
  return `Die neuen Kriterien gelten ab sofort für den Vorschlag (Fassung ${f.fassung}). Keine Einstufung ändert sich dadurch.${anstoss ? ` ${anstoss}` : ''}`;
}

/**
 * Der Antrag einer zweiten Person (Vier-Augen): wer, wann, warum — und wer entscheiden darf. `created_at` ist ein
 * Zeitpunkt (oft mit `Z`): der Tag gilt in der Zone des Unternehmens, nicht in UTC (00:30 Uhr in Berlin ist schon heute).
 */
export function kriterienAntrag(
  f: Pick<BewertungKriterienFassung, 'akteur' | 'created_at' | 'begruendung'>,
  ich: { sub: string | null; darf: boolean },
  zone = 'Europe/Berlin',
): { satz: string; wer: string | null; darfEntscheiden: boolean } {
  const von = f.akteur?.name ?? 'einer Person';
  const am = f.created_at ? ` am ${datumsblock(f.created_at, zone).voll}` : '';
  const satz = `Beantragt von ${von}${am}${f.begruendung ? `: „${f.begruendung}“` : '.'}`;
  const selbst = !!f.akteur?.sub && f.akteur.sub === ich.sub;
  return {
    satz,
    darfEntscheiden: ich.darf && !selbst,
    wer: selbst
      ? 'Freigeben oder ablehnen kann eine zweite Person, die Kriterien ändern darf.'
      : !ich.darf
        ? 'Freigeben oder ablehnen dürfen Kundenadministratoren und Energiemanager - nicht die Person, die sie beantragt hat.'
        : null,
  };
}

// ------------------------------------------------------------------ Umfang

export interface UmfangZeilen {
  gespeichert: boolean;
  standorte: string;
  traeger: string;
  traegerNotiz: string | null;
  /** „Anlage Werk Lindach: Umbau bis Juni“ — jeder Ausschluss mit seiner Begründung. */
  ausschluesse: string[];
  gilt: string;
}

const AUSSCHLUSS_ART = { standort: 'Standort', anlage: 'Anlage', prozess: 'Prozess' } as const;

const anlagenWort = (n: number) => `${n}${NBSP}${n === 1 ? 'Anlage' : 'Anlagen'}`;

/** Der Umfang in drei Zeilen (§6.7): Standorte, Energieträger, seit wann und von wem; Ausschlüsse mit Begründung. */
export function umfangZeilen(u: BewertungUmfang, namen: ReadonlyMap<string, string> = new Map()): UmfangZeilen {
  const gespeichert = u.fassung !== null;
  const ohne = u.traeger.filter((t) => !t.mit_anteil).map((t) => t.name);
  return {
    gespeichert,
    standorte: u.standorte.map((s) => `${s.name} (${anlagenWort(s.anzahl_anlagen_im_umfang)})`).join(' · '),
    traeger: u.traeger.map((t) => `${t.name} ${t.mit_anteil ? 'mit' : 'ohne'} Anteil`).join(' · '),
    traegerNotiz: ohne.length
      ? `${aufzaehlung(ohne)} ${ohne.length === 1 ? 'hat' : 'haben'} keinen gemeinsamen Maßstab mit Strom und ${ohne.length === 1 ? 'steht' : 'stehen'} daneben.`
      : null,
    ausschluesse: u.ausschluesse.map((a) => `${AUSSCHLUSS_ART[a.art]}${namen.get(a.verweis) ? ` ${namen.get(a.verweis)}` : ''}: ${a.begruendung}`),
    gilt: gespeichert
      ? `${u.gueltig_ab && u.gueltig_ab > u.am ? 'ab' : 'seit'} ${tag(u.gueltig_ab)}${u.akteur ? ` · festgelegt von ${u.akteur.name}` : ''}`
      : 'noch nicht festgelegt - Vorschlag: alle Standorte, Strom',
  };
}

// ------------------------------------------------------------------ Bewertungsstand

export const FRUEHERE_STAENDE = 'Frühere Stände';
export const FRUEHERE_AUSBLENDEN = 'Frühere Stände ausblenden';
export const FRUEHERE_BEWERTUNGEN = 'Frühere Bewertungen in den Nachweisen';
/** Ohne ersetzte Stände führt der Kopf nur zu früheren Bewertungen (Berichte) — dann heißt er auch so. */
export const FRUEHERE_BEWERTUNGEN_KURZ = 'Frühere Bewertungen';
export const KEINE_BEWERTUNG_SATZ =
  'Noch keine Bewertung festgestellt. Legen Sie eine an - der Entwurf entsteht aus Umfang, Bereichen, Einstufungen und Messwerten; freigegeben gilt er als Stand Nr.\u00a01.';

/** Ein Zeitpunkt als Datumsblock in der Zone der Bewertung: „30.04.“ über „2029“. */
const datumsblock = (zeit: string, zone: string) => {
  const voll = tagText(iso(Date.parse(zeit), zone).slice(0, 10));
  return { tag: voll.slice(0, 6), jahr: voll.slice(6), voll };
};

/** Der gültige Stand (§6.7): „Stand 1 · 30.04.2029 · gilt · freigegeben von Ines Kaltenbach · PDF · CSV“. */
export function standBild(detail: BerichtDetail, s: BerichtStandKurz) {
  const d = datumsblock(s.freigegeben_am, detail.bericht.zeitzone);
  const anlass = s.anlass_anstoss_id === null ? null : detail.anstoesse.find((a) => a.id === s.anlass_anstoss_id)?.anlass_text ?? null;
  return {
    wort: `Stand ${s.nr}`,
    tag: d.tag,
    jahr: d.jahr,
    satz: `Stand Nr. ${s.nr} vom ${d.voll}`,
    titel: s.ersetzt_durch_nr === null
      ? `gilt · freigegeben von ${s.freigegeben_von.name}`
      : `ersetzt durch Stand Nr. ${s.ersetzt_durch_nr} · freigegeben von ${s.freigegeben_von.name}`,
    anlass: anlass ? `Anlass: ${anlass}` : null,
    dateien: (['pdf', 'csv'] as const).map((format) => ({
      format,
      text: format.toUpperCase(),
      datei: `bericht-${detail.bericht.kennung}-nr${s.nr}.${format}`,
    })),
  };
}

/** Der Entwurf (§6.7): „Neuer Stand mit den Zahlen bis März 2029“ — mit dem Tag seines Datenstands. */
export function entwurfBild(b: Pick<Bericht, 'zeitraum' | 'zeitzone'>, e: Pick<BerichtEntwurf, 'datenstand'>, mitStand: boolean) {
  const d = datumsblock(e.datenstand, b.zeitzone);
  const bis = zeitraumText(b.zeitraum.split('/').pop() ?? b.zeitraum);
  return {
    tag: d.tag,
    jahr: d.jahr,
    satz: `Entwurf mit Datenstand ${d.voll}`,
    titel: `${mitStand ? 'Neuer Stand' : 'Erster Stand'} mit den Zahlen bis ${bis}`,
    warum: mitStand
      ? 'Freigeben, wenn sich etwas geändert hat - die Unterschiede zeigt der Entwurf.'
      : 'Mit der ersten Freigabe gilt die Bewertung; danach überprüfen Sie sie einmal im Jahr.',
  };
}
