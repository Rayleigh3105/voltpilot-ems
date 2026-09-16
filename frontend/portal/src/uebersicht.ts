/**
 * Die UNTERNEHMENS- und die STANDORT-ÜBERSICHT, reine Hälfte (UEMS AP-01 IP-6;
 * Konzept `data/vp-uems-ap01-portalaufbau` §4.6, §5.1 Startbild B/C, A7, A13).
 *
 * Die Übersicht IST das Portfolio-Cockpit (Entscheid E2): dieselbe Leiste,
 * dieselbe Anlagen-Tabelle, derselbe Layout-Speicher. Dieses Modul liefert nur,
 * was die Ebene dazu bringt:
 *
 * - die **Kopfzeile** — Name, Standorte, Anlagen, wer steuert, und die Datenlage;
 * - die **Standort-Gruppen** der Anlagen-Tabelle, je Standort mit dem Zustand
 *   BEIDER Funktionen (E6 = C: beide gelten je Standort, die Anlage nimmt teil);
 * - den **Standort-Filter** — die Standort-Übersicht ist dieselbe Seite, auf die
 *   Anlagen eines Standorts beschränkt, keine zweite Seite;
 * - die **Geld-Regel** als Fakt je Anlage.
 *
 * Jeder Zustand und jeder Satz einer Funktion kommt fertig vom Server
 * (`GET /api/v1/funktionen`, Regel `uemsFunktion`); gezählt wird über den
 * Vertrag `uemsZustand`. Reines Modul: keine React-Importe, kein Netzwerk.
 */
import type { FunktionStandort, Funktionen, OverviewSite, StandortAmStichtag } from './api';
import { datenlageAnlagen, flottenAussage, flottenHinweis, type AnlagenZeile } from './portfolioCockpit';
import { FUNKTIONEN, type FunktionCode, type FunktionZustand } from './uemsFunktion';

/** Die Ebene, die das Portfolio-Cockpit gerade zeigt. */
export type UebersichtEbene =
  | {
      art: 'unternehmen';
      /** Der Name des Unternehmens („Kunststoffwerk Ahrenberg GmbH"). */
      name: string;
      /** Die Standorte heute, in der Reihenfolge des Servers. */
      standorte: StandortAmStichtag[];
    }
  | { art: 'standort'; standort: StandortAmStichtag };

export type Ton = 'ok' | 'warn' | 'off';

function anzahl(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Die Standorte, die zählen — ein archivierter Standort ist keine Ebene mehr. */
function lebendeStandorte(ebene: UebersichtEbene): StandortAmStichtag[] {
  const alle = ebene.art === 'unternehmen' ? ebene.standorte : [ebene.standort];
  return alle.filter((s) => s.zustand !== 'archiviert');
}

// ---------------------------------------------------------------------------
// Der Filter
// ---------------------------------------------------------------------------

/**
 * Die Anlagen dieser Ebene. Am Standort genau die, die ihm HEUTE zugeordnet sind
 * (`StandortAmStichtag.anlagen`) — jede Summe der Seite geht nur über sie, nie
 * über eine Anlage eines anderen Standorts.
 */
export function anlagenDerEbene<T extends { id: string }>(
  sites: readonly T[],
  ebene: UebersichtEbene | null,
): T[] {
  if (ebene?.art !== 'standort') return [...sites];
  const hier = new Set(ebene.standort.anlagen.map((a) => a.id));
  return sites.filter((s) => hier.has(s.id));
}

// ---------------------------------------------------------------------------
// Wer steuert — und wer Geld sehen darf
// ---------------------------------------------------------------------------

/**
 * Die Anlagen, die AKTIV an „Steuern & Optimieren" ihres Standorts teilnehmen;
 * `null` = unbekannt (die Funktionen sind nicht geladen). Eine angehaltene oder
 * nur eingerichtete Teilnahme steuert nicht.
 */
export function steuerndeAnlagen(funktionen: Funktionen | null): Set<string> | null {
  if (!funktionen) return null;
  const out = new Set<string>();
  for (const st of funktionen.standorte) {
    for (const a of st.steuern.anlagen) if (a.teilnahme.zustand === 'aktiv') out.add(a.id);
  }
  return out;
}

/** Teilnahme-Zustände, die schweigen: keine Teilnahme oder eine beendete. */
const STEUERN_STILL: ReadonlySet<FunktionZustand> = new Set<FunktionZustand>(['kein_objekt', 'archiviert']);

/**
 * DIE STEUERN-REGEL (Captain über firstmate 003/004, 15.09.2026: „Von steuern
 * soll beim messen eigentlich noch nicht die rede sein."): ein Standort spricht
 * von „Steuern & Optimieren", sobald mindestens EINE seiner Anlagen teilnimmt —
 * die Ebene ist die Anlage. Ein Standort, an dem keine teilnimmt, schweigt ganz:
 * keine Zeile „Noch nicht eingerichtet", kein Schritt „einrichten".
 *
 * Teilnehmen heißt: im Entwurf, eingerichtet, angehalten oder aktiv — jeder
 * dieser Zustände entsteht erst auf den Anstoß des Kunden. Nur `kein_objekt`
 * und `archiviert` schweigen. Eine angehaltene oder noch nicht gestartete
 * Teilnahme zu verschweigen, nähme ihm den Weg zurück; kollidieren Schweigen und
 * Erreichbarkeit, gewinnt die Erreichbarkeit („Okay ich will aber schon das
 * Messkunden auch zu Kunden werden wo man verbraucher steuern kann.").
 *
 * ⚠ Gezählt wird an den Anlagen, die `GET /funktionen` unter DIESEM Standort
 * nennt — dieselbe Quelle wie die Zeile, die dann erscheint; so steht nie eine
 * Steuern-Zeile ohne Teilnahme da. „reine Messung" in Kopfzeile und
 * Standort-Zahlen bleibt ({@link steuertTeil}): das Wort benennt, was der Kunde
 * ist, nicht was ihm fehlt.
 */
export function steuernSpricht(fs: FunktionStandort): boolean {
  return fs.steuern.anlagen.some((a) => !STEUERN_STILL.has(a.teilnahme.zustand));
}

/**
 * DIE GELD-REGEL als Fakt je Anlage (AP-01 §4.6, Captain-Vorgabe 10.09.2026:
 * „Die Messdatenkunden brauchen keine Geldanzeige.").
 *
 * Eine Anlage darf Geld zeigen, wenn sie aktiv an „Steuern & Optimieren"
 * teilnimmt ODER einen Erzeuger bzw. Speicher hat (`roleCounts.pv`/`storage`).
 * Geld-Bausteine erscheinen auf der Ebene nur, wenn diese Menge nicht leer ist,
 * und zählen nur ihre Anlagen.
 *
 * ⚠ Unbekannt ist nie „erlaubt": ohne `roleCounts` (älteres Backend) zählt keine
 * Rolle, ohne Funktionen keine Teilnahme — im Zweifel zeigt die Übersicht kein
 * Geld, nie einem Messkunden eines.
 */
export function geldAnlagen(sites: readonly OverviewSite[], funktionen: Funktionen | null): Set<string> {
  const steuert = steuerndeAnlagen(funktionen);
  const out = new Set<string>();
  for (const s of sites) {
    const erzeugerOderSpeicher = (s.roleCounts?.pv ?? 0) > 0 || (s.roleCounts?.storage ?? 0) > 0;
    if (erzeugerOderSpeicher || steuert?.has(s.id)) out.add(s.id);
  }
  return out;
}

/** „1 steuert" · „2 steuern" · „reine Messung"; `null`, solange die Funktionen unbekannt sind. */
function steuertTeil(sites: readonly OverviewSite[], funktionen: Funktionen | null): string | null {
  const steuert = steuerndeAnlagen(funktionen);
  if (steuert == null || sites.length === 0) return null;
  const n = sites.filter((s) => steuert.has(s.id)).length;
  if (n === 0) return 'reine Messung';
  return `${n} ${n === 1 ? 'steuert' : 'steuern'}`;
}

// ---------------------------------------------------------------------------
// Die Kopfzeile
// ---------------------------------------------------------------------------

export interface Kopfzeile {
  /** Die Überschrift — der Name des Unternehmens; am Standort `null` (dort trägt der Standort-Kopf ihn). */
  titel: string | null;
  /** „2 Standorte · 3 Anlagen · 1 steuert"; am Standort `null` (Kopf und Funktions-Zeilen sagen es). */
  zahlen: string | null;
  /** „3 von 3 Anlagen liefern Daten" plus die Anlage, die Aufmerksamkeit braucht. */
  datenlage: { text: string; ton: Ton } | null;
}

/**
 * Die Kopfzeile der Ebene (A7: „Kunststoffwerk Ahrenberg GmbH · 2 Standorte ·
 * 3 Anlagen · 1 steuert · … liefern Daten"). `sites` sind die Anlagen DIESER
 * Ebene ({@link anlagenDerEbene}).
 *
 * `mitDatenlage` ist das Auge des Bausteins „Datenlage": blendet der Kunde ihn
 * aus, bleibt nur der Hinweis auf eine Anlage, die sich nicht meldet — der
 * gehört zum Pflicht-Baustein „Flotten-Status" und verschwindet nie.
 */
export function kopfzeile(i: {
  ebene: UebersichtEbene;
  sites: readonly OverviewSite[];
  funktionen: Funktionen | null;
  mitDatenlage: boolean;
  now: Date;
}): Kopfzeile {
  const { ebene, sites, funktionen, now } = i;
  const teile: string[] = [];
  if (ebene.art === 'unternehmen') {
    teile.push(anzahl(lebendeStandorte(ebene).length, 'Standort', 'Standorte'));
    teile.push(anzahl(sites.length, 'Anlage', 'Anlagen'));
    const steuert = steuertTeil(sites, funktionen);
    if (steuert) teile.push(steuert);
  }
  // Am Standort nennt der Standort-Kopf (AP-02) die Zahl der Anlagen, und die
  // Zeile „Steuern & Optimieren" darunter sagt, wer steuert. Nimmt dort keine
  // Anlage teil, fehlt die Zeile ({@link steuernSpricht}) — der Standort schweigt
  // dann über Steuern ganz, auch ohne „reine Messung".

  let datenlage: Kopfzeile['datenlage'] = null;
  if (sites.length > 0) {
    const hinweis = flottenHinweis(sites, now);
    const ton = flottenAussage(sites, now).tone;
    const text = [i.mitDatenlage ? datenlageAnlagen(sites).text : null, hinweis]
      .filter((t): t is string => t != null)
      .join(' · ');
    if (text) datenlage = { text, ton };
  }
  return {
    titel: ebene.art === 'unternehmen' ? ebene.name : null,
    zahlen: teile.length > 0 ? teile.join(' · ') : null,
    datenlage,
  };
}

// ---------------------------------------------------------------------------
// Der Zustand beider Funktionen
// ---------------------------------------------------------------------------

/** Eine Funktion eines Standorts in einer Zeile: Name, Zustand, der Satz des Servers. */
export interface FunktionsZeile {
  funktion: FunktionCode;
  /** „Messen & Auswerten" / „Steuern & Optimieren". */
  label: string;
  zustand: FunktionZustand;
  /** Der Satz: „Läuft mit Werk Ahrenberg – Halle 1", „Noch nicht eingerichtet" … — nie leer. */
  satz: string;
  ton: Ton;
}

const TON: Record<FunktionZustand, Ton> = {
  aktiv: 'ok',
  angehalten: 'warn',
  eingerichtet: 'off',
  entwurf: 'off',
  archiviert: 'off',
  kein_objekt: 'off',
};

/**
 * Der Satz einer Funktion. Der Server spricht ihn fertig; nur „kein Objekt"
 * trägt dort den Funktionsnamen schon mit („Steuern & Optimieren — noch nicht
 * eingerichtet"), den die Zeile ohnehin davor schreibt — dann steht nur der
 * Zustand da, nie der Name zweimal.
 */
function satzVon(funktion: FunktionCode, zustand: FunktionZustand, text: string): string {
  const praefix = `${FUNKTIONEN[funktion]} — `;
  if (zustand === 'kein_objekt' && text.startsWith(praefix)) {
    const rest = text.slice(praefix.length);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return text;
}

/**
 * Die Funktionen eines Standorts, immer in dieser Reihenfolge: „Messen &
 * Auswerten" IMMER — auch „Noch nicht eingerichtet" ist ein benannter Zustand,
 * nie eine Leerstelle —, „Steuern & Optimieren" NUR, wenn eine Anlage des
 * Standorts teilnimmt ({@link steuernSpricht}).
 *
 * ⚠ Das löst die Zusage „immer beide, nie eine Leerstelle" aus PR 771 (E6 = C)
 * BEWUSST ab: an einem Standort, an dem nur gemessen wird, war die Zeile
 * „Steuern & Optimieren · Noch nicht eingerichtet" genau das Aufdrängen, das der
 * Captain ausgeschlossen hat. Die Messen-Zeile trägt, sobald die Funktion
 * angelegt ist, die Datenlage ihrer Messstellen („15 von 16 Messstellen liefern
 * Daten" — seit AP-13 IP-7 die Zählung des Registers).
 */
export function funktionsZeilen(fs: FunktionStandort): FunktionsZeile[] {
  const messenSatz = satzVon('messen', fs.messen.zustand, fs.messen.text);
  const zeilen: FunktionsZeile[] = [
    {
      funktion: 'messen',
      label: FUNKTIONEN.messen,
      zustand: fs.messen.zustand,
      satz: fs.messen.datenlage ? `${messenSatz} · ${fs.messen.datenlage}` : messenSatz,
      ton: TON[fs.messen.zustand],
    },
  ];
  if (steuernSpricht(fs)) {
    zeilen.push({
      funktion: 'steuern',
      label: FUNKTIONEN.steuern,
      zustand: fs.steuern.zustand,
      satz: satzVon('steuern', fs.steuern.zustand, fs.steuern.text),
      ton: TON[fs.steuern.zustand],
    });
  }
  return zeilen;
}

/** Der Satz, wenn die Funktionen gerade nicht abrufbar sind — eine Aussage statt einer Lücke. */
export const FUNKTIONEN_UNBEKANNT = 'Der Zustand der Funktionen ist gerade nicht abrufbar.';

/** Der Satz über Anlagen ohne Standort — Funktionen gelten je Standort (E6 = C). */
export const OHNE_STANDORT_SATZ =
  'Funktionen gelten je Standort — ordnen Sie diese Anlagen einem Standort zu.';

/** Die Funktionen EINES Standorts für die Standort-Übersicht; `null` = nicht abrufbar. */
export function funktionenDesStandorts(
  standortId: string,
  funktionen: Funktionen | null,
): FunktionsZeile[] | null {
  const fs = funktionen?.standorte.find((s) => s.id === standortId);
  return fs ? funktionsZeilen(fs) : null;
}

// ---------------------------------------------------------------------------
// Die Standort-Gruppen der Anlagen-Tabelle
// ---------------------------------------------------------------------------

export interface StandortGruppe {
  key: string;
  /** `null` = die Gruppe „Noch keinem Standort zugeordnet". */
  standortId: string | null;
  name: string;
  kurzzeichen: string | null;
  /** „2 Anlagen · 1 steuert · 2 von 2 Anlagen liefern Daten" */
  zahlen: string;
  ton: Ton;
  /**
   * Die Funktionen des Standorts ({@link funktionsZeilen}: Messen immer, Steuern
   * nur mit teilnehmender Anlage); `null` = nicht abrufbar. Die Gruppe ohne
   * Standort trägt keine Funktion (sie gelten je Standort) und sagt das in
   * {@link OHNE_STANDORT_SATZ}.
   */
  funktionen: FunktionsZeile[] | null;
  zeilen: AnlagenZeile[];
  /** Ein Standort ohne Anlage sagt das, statt eine leere Gruppe zu zeigen. */
  leer: string | null;
}

/**
 * Die Anlagen-Tabelle der Unternehmens-Übersicht, nach Standorten gruppiert — in
 * der Reihenfolge des Servers, die Anlagen darin in der Reihenfolge der Tabelle
 * (Zustand zuerst, dann Name). Anlagen ohne Standort stehen zuletzt in ihrer
 * eigenen, benannten Gruppe; keine Anlage fällt heraus.
 */
export function standortGruppen(i: {
  ebene: UebersichtEbene;
  zeilen: readonly AnlagenZeile[];
  sites: readonly OverviewSite[];
  funktionen: Funktionen | null;
  now: Date;
}): StandortGruppe[] {
  const { zeilen, sites, funktionen, now } = i;
  const vergeben = new Set<string>();
  const gruppe = (
    kopf: Pick<StandortGruppe, 'key' | 'standortId' | 'name' | 'kurzzeichen' | 'funktionen'>,
    ids: Set<string>,
  ): StandortGruppe => {
    const hier = sites.filter((s) => ids.has(s.id));
    for (const s of hier) vergeben.add(s.id);
    const teile = [anzahl(hier.length, 'Anlage', 'Anlagen')];
    const steuert = kopf.standortId != null ? steuertTeil(hier, funktionen) : null;
    if (steuert) teile.push(steuert);
    if (hier.length > 0) teile.push(datenlageAnlagen(hier).text);
    return {
      ...kopf,
      zahlen: teile.join(' · '),
      ton: hier.length > 0 ? flottenAussage(hier, now).tone : 'off',
      zeilen: zeilen.filter((z) => ids.has(z.id)),
      leer: hier.length === 0 ? 'Diesem Standort ist heute keine Anlage zugeordnet.' : null,
    };
  };

  const out = lebendeStandorte(i.ebene).map((st) =>
    gruppe(
      {
        key: st.id,
        standortId: st.id,
        name: st.name,
        kurzzeichen: st.kurzzeichen,
        funktionen: funktionenDesStandorts(st.id, funktionen),
      },
      new Set(st.anlagen.map((a) => a.id)),
    ),
  );
  const ohne = new Set(sites.filter((s) => !vergeben.has(s.id)).map((s) => s.id));
  if (ohne.size > 0) {
    out.push(
      gruppe(
        { key: 'ohne-standort', standortId: null, name: 'Noch keinem Standort zugeordnet', kurzzeichen: null, funktionen: [] },
        ohne,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Die Karte „Funktionen" und der Leerzustand des Standorts (AP-01 IP-8)
// ---------------------------------------------------------------------------

/** Ein Standort in der Karte „Funktionen": der Zustand und der nächste Schritt. */
export interface FunktionenKarteZeile {
  standortId: string;
  /** Der Standort — `null` auf der Standort-Übersicht, die ihn schon im Kopf trägt. */
  name: string | null;
  zustand: FunktionZustand;
  /** Derselbe Satz wie in der Standort-Karte (`funktionsZeilen`). */
  satz: string;
  ton: Ton;
  /**
   * „Werk Ahrenberg – Halle 2 aufnehmen" — der benannte nächste Schritt; die
   * Komponente macht ihn nur mit vorhandenem Assistenten zum Knopf. `null` =
   * es gibt keinen.
   */
  schritt: string | null;
  /** IP-11: Standort-Handlung nur, wenn die Server-Aktionsliste sie erlaubt. */
  steuerungAktion?: 'anhalten' | 'fortsetzen' | null;
  /** Die Anlagen, die der Standort-Übergang tatsächlich betrifft. */
  betroffen?: string[];
}

export interface FunktionenKarteAbschnitt {
  funktion: FunktionCode;
  label: string;
  /** „Läuft an 1 von 2 Standorten" — nur auf der Unternehmens-Übersicht. */
  verbreitung: string | null;
  zeilen: FunktionenKarteZeile[];
}

function undListe(namen: string[]): string {
  return namen.length <= 1 ? namen.join('') : `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/**
 * Der nächste Schritt je Funktion und Standort — aus dem ZUSTAND, nie aus
 * `aktionen`: der Server nennt dort nur starten/anhalten/fortsetzen/beenden
 * (`FunktionService.ANLAGEN_AKTIONEN`/`STANDORT_AKTIONEN`), „einrichten" und
 * „aufnehmen" kommen darin nie vor.
 */
function naechsterSchritt(funktion: FunktionCode, fs: FunktionStandort): string | null {
  // Ohne Anlage gibt es nichts zu messen und nichts zu steuern; den Schritt nennt
  // der Leerzustand der Standort-Übersicht.
  if (fs.steuern.anlagen.length === 0) return null;
  if (funktion === 'messen') {
    return fs.messen.zustand === 'kein_objekt' ? `${FUNKTIONEN.messen} für ${fs.name} einrichten` : null;
  }
  // Kein „Steuern & Optimieren für … einrichten" mehr: ein Standort ohne
  // teilnehmende Anlage schweigt ({@link steuernSpricht}) und steht gar nicht in
  // der Karte. Wo eine teilnimmt, spricht der Standort — dort heißt der Schritt
  // für die übrigen Anlagen „aufnehmen".
  const offen = fs.steuern.anlagen.filter((a) => a.teilnahme.zustand === 'kein_objekt').map((a) => a.name);
  return offen.length > 0 ? `${undListe(offen)} aufnehmen` : null;
}

/**
 * Die Karte „Funktionen" (AP-01 E5 = A, E6 = C): je Funktion, je Standort der
 * Ebene der Zustand und der nächste Schritt. `null` = die Funktionen sind nicht
 * abrufbar — die Karte sagt das, statt leer zu stehen.
 *
 * „Steuern & Optimieren" nennt nur die Standorte, an denen eine Anlage
 * teilnimmt ({@link steuernSpricht}); gibt es keinen, entfällt der Abschnitt
 * ganz — samt „Läuft an 0 von 2 Standorten".
 */
export function funktionenKarte(
  ebene: UebersichtEbene,
  funktionen: Funktionen | null,
): FunktionenKarteAbschnitt[] | null {
  if (!funktionen) return null;
  const standorte = lebendeStandorte(ebene)
    .map((st) => funktionen.standorte.find((f) => f.id === st.id))
    .filter((f): f is FunktionStandort => f != null);
  const imUnternehmen = ebene.art === 'unternehmen';
  return (['messen', 'steuern'] as const).flatMap((funktion) => {
    const hier = funktion === 'steuern' ? standorte.filter(steuernSpricht) : standorte;
    if (funktion === 'steuern' && hier.length === 0) return [];
    const label = FUNKTIONEN[funktion];
    const text = funktionen.unternehmen[funktion].text;
    const rest = text?.startsWith(`${label} `) ? text.slice(label.length + 1) : text;
    return [
      {
        funktion,
        label,
        verbreitung: imUnternehmen && rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null,
        zeilen: hier.map((fs) => {
          const z = funktionsZeilen(fs).find((x) => x.funktion === funktion)!;
          const steuerungAktion = funktion === 'steuern'
            ? fs.steuern.aktionen.includes('anhalten')
              ? 'anhalten'
              : fs.steuern.aktionen.includes('fortsetzen')
                ? 'fortsetzen'
                : null
            : null;
          return {
            standortId: fs.id,
            name: imUnternehmen ? fs.name : null,
            zustand: z.zustand,
            satz: z.satz,
            ton: z.ton,
            schritt: naechsterSchritt(funktion, fs),
            ...(funktion === 'steuern' ? {
              steuerungAktion,
              betroffen: steuerungAktion === null ? [] : fs.steuern.anlagen
                .filter((a) => a.teilnahme.aktionen.includes(steuerungAktion))
                .map((a) => a.name),
            } : {}),
          };
        }),
      },
    ];
  });
}

/** Der Leerzustand der Standort-Übersicht (Konzept AP-01 §5.5). */
export interface StandortLeerzustand {
  titel: string;
  satz: string;
  /** Benannt, kein Knopf — wie in der Karte „Funktionen". */
  schritt: string;
}

/**
 * Ein Standort, dem heute keine Anlage zugeordnet ist — `null`, sobald eine da
 * ist. Gezählt wird am Lese-Modell der Standorte (heute zugeordnet), nicht an
 * den Zeilen der Übersicht.
 */
export function standortLeerzustand(standort: StandortAmStichtag): StandortLeerzustand | null {
  if (standort.anlagen.length > 0) return null;
  return {
    titel: `${standort.name} ist angelegt — noch ohne Anlage`,
    satz: 'Messwerte kommen über eine Anlage: an ihr verbinden Sie die Box und binden die Zähler an.',
    schritt: 'Eine Anlage anlegen oder eine bestehende Anlage diesem Standort zuordnen (in der Anlage unter Einstellungen)',
  };
}
