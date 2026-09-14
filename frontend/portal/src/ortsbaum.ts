import type {
  Nutzung,
  OrtAnlegen,
  OrtBearbeiten,
  OrtFehler,
  OrtFlaeche,
  OrtsbaumAmStichtag,
  OrtsbaumBereich,
  OrtsbaumGebaeude,
} from './api';
import {
  NAME_HOECHSTENS,
  KURZZEICHEN_HOECHSTENS,
  NOTIZ_HOECHSTENS,
  nutzungWort,
  SATZ_KURZZEICHEN_FEHLT,
  SATZ_KURZZEICHEN_ZU_LANG,
  SATZ_NAME_FEHLT,
  SATZ_NAME_ZU_LANG,
  SATZ_NOTIZ_ZU_LANG,
} from './standorte';
import {
  eintrag,
  FLAECHE_SATZ,
  m2Text,
  nameBelegt,
  nameBelegtSatz,
  type EintragGrund,
  type Ort,
  type Ortsbaum,
} from './uemsOrtsbaum';

/**
 * Der Ortsbaum „Standort › Gebäude“ und die Dialoge für Gebäude und Bereich
 * (UEMS AP-02 IP-7, Mockups T3/T4/T5, Leerzustand L1) als reine Schicht: aus
 * der Antwort von `GET /api/v1/standorte/{id}/orte` wird der Baum, aus dem
 * Formular die Anfrage. Die Komponenten rendern nur.
 *
 * Wie beim Standort (`standorte.ts`) ist jede Regel die des Servers: Sätze
 * Zeichen für Zeichen gleich (`OrtFelder`, `OrtService`), die Namensregel und
 * „woran darf was hängen“ werden AUFGERUFEN (`nameBelegt`, `eintrag` aus
 * `uemsOrtsbaum.ts`), nie nachgebaut.
 *
 * ⚠ Die Datenlage je Knoten („liefert“) kennt die Antwort nicht. Die Zeile trägt
 * an ihrer Stelle die Messstellen-Zahl — der Platz, an dem sie später steht.
 * ⚠ Eine vorhandene Fläche ändern (Verlauf, „rückwirkend“) ist IP-8 (T7); hier
 * nur die ERSTE Fläche: beim Anlegen oder als „Fläche eintragen“.
 */

// ───────────────────────────────────────────────────────────── Wörter

export const TITEL_GEBAEUDE = 'Gebäude';
export const DIREKT_AM_STANDORT = 'Direkt am Standort';

/** L1 (§5.9): Standort ohne Gebäude und ohne Bereiche. */
export const LEER_SATZ = 'Gebäude sind optional — Messstellen dürfen direkt am Standort hängen.';
export const KNOPF_GEBAEUDE_ANLEGEN = 'Gebäude anlegen';
export const KNOPF_BEREICH_ANLEGEN = 'Bereich anlegen';
export const KNOPF_BEREICH_DIREKT = 'Bereich direkt am Standort anlegen';

/** §5.9: Gebäude ohne Fläche — ein Hinweis mit Weg, kein Fehler. */
export const FLAECHE_FEHLT = 'für kWh/m² fehlt die Fläche';
export const KNOPF_FLAECHE_EINTRAGEN = 'Fläche eintragen';

/** Der Satz des Vertrags zu einem Bereich an einem falschen Ziel (`ziel_art_unzulaessig`). */
export const SATZ_BEREICH_ZIEL = 'Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.';
export const SATZ_GEBAEUDE_ZIEL = 'Ein Gebäude kann nur an einem Standort hängen.';

export const BAUJAHR_FRUEHESTENS = 1800;

/** `OrtFelder.baujahr`: „Das Baujahr liegt zwischen 1800 und 2026.“ */
export function baujahrSatz(laufendesJahr: number): string {
  return `Das Baujahr liegt zwischen ${BAUJAHR_FRUEHESTENS} und ${laufendesJahr}.`;
}

// ───────────────────────────────────────────────────────────── Baum (T3, L1)

export type KnotenArt = 'gebaeude' | 'bereich' | 'direkt';

export interface Knoten {
  /** React-Schlüssel: die ID, beim Zweig „direkt am Standort“ `direkt`. */
  schluessel: string;
  art: KnotenArt;
  /** `null` beim Zweig „direkt am Standort“ — er ist kein eigenes Objekt. */
  id: string | null;
  name: string;
  kurzzeichen: string | null;
  /** „Produktion · Montage · 3 100 m² · 2019“ — Fehlendes bleibt weg, eine unbekannte Fläche ist keine 0. */
  zeile: string;
  /**
   * Platzhalter der Datenlage: heute die Zahl der Messstellen im Knoten und
   * seinen Bereichen („5 Messstellen“); `null`, wenn eine Zahl unbekannt ist.
   */
  datenlage: string | null;
  /** Nur Gebäude: am Stichtag ohne Fläche (§5.9 „für kWh/m² fehlt die Fläche“). */
  flaecheFehlt: boolean;
  archiviert: boolean;
  /** Woran ein Bereich hängt — für den Dialog „Bereich bearbeiten“. */
  eltern: { art: 'gebaeude' | 'standort'; name: string } | null;
  quelle: OrtsbaumGebaeude | OrtsbaumBereich | null;
  kinder: Knoten[];
}

export interface OrtsbaumSicht {
  /** L1: keine Gebäude und keine Bereiche — nur dann der Leerzustand. */
  leer: boolean;
  /** Die Gebäude nach Kurzzeichen, jedes mit seinen Bereichen; zuletzt „Direkt am Standort“. */
  knoten: Knoten[];
}

function nachKurzzeichen<T extends { kurzzeichen: string }>(a: T, b: T): number {
  return a.kurzzeichen.localeCompare(b.kurzzeichen, 'de-DE', { numeric: true });
}

/** „1 Messstelle“, „5 Messstellen“ — Zahl und Wort mit geschütztem Leerzeichen. */
export function messstellenText(n: number): string {
  return `${n.toLocaleString('de-DE')}\u00a0${n === 1 ? 'Messstelle' : 'Messstellen'}`;
}

/** Die Summe, wenn JEDE Zahl bekannt ist — sonst `null` (unbekannt ist keine 0). */
function summe(zahlen: (number | null)[]): number | null {
  return zahlen.some((z) => z == null) ? null : (zahlen as number[]).reduce((a, b) => a + b, 0);
}

function zeileAus(nutzung: Nutzung[] | null, flaecheM2: number | null, baujahr: number | null): string {
  const teile = (nutzung ?? []).map(nutzungWort);
  if (flaecheM2 != null) teile.push(m2Text(flaecheM2));
  if (baujahr != null) teile.push(String(baujahr));
  return teile.join(' · ');
}

function bereichKnoten(b: OrtsbaumBereich, eltern: Knoten['eltern']): Knoten {
  return {
    schluessel: b.id,
    art: 'bereich',
    id: b.id,
    name: b.name,
    kurzzeichen: b.kurzzeichen,
    zeile: zeileAus(b.nutzung, b.flaecheM2, null),
    datenlage: b.messstellenZahl == null ? null : messstellenText(b.messstellenZahl),
    flaecheFehlt: false,
    archiviert: b.zustand === 'archiviert',
    eltern,
    quelle: b,
    kinder: [],
  };
}

/**
 * Aus der flachen Antwort wird der Baum (T3): Gebäude nach Kurzzeichen, darunter
 * ihre Bereiche, am Ende der Zweig „Direkt am Standort“ — ein gültiger Ort, kein
 * „nicht zugeordnet“ (AP-00 E3). Den Zweig gibt es nur, wenn dort etwas hängt.
 * Die Messstellen eines Gebäudes zählen die seiner Bereiche mit.
 */
export function ortsbaumSicht(antwort: OrtsbaumAmStichtag): OrtsbaumSicht {
  const standortName = antwort.standort.name;
  const gebaeude = [...antwort.gebaeude].sort(nachKurzzeichen).map((g): Knoten => {
    const kinder = [...g.bereiche]
      .sort(nachKurzzeichen)
      .map((b) => bereichKnoten(b, { art: 'gebaeude', name: g.name }));
    const zahl = summe([g.messstellenZahl, ...g.bereiche.map((b) => b.messstellenZahl)]);
    const archiviert = g.zustand === 'archiviert';
    return {
      schluessel: g.id,
      art: 'gebaeude',
      id: g.id,
      name: g.name,
      kurzzeichen: g.kurzzeichen,
      zeile: zeileAus(g.nutzung, g.flaecheM2, g.baujahr),
      datenlage: zahl == null ? null : messstellenText(zahl),
      flaecheFehlt: g.flaecheM2 == null && !archiviert,
      archiviert,
      eltern: null,
      quelle: g,
      kinder,
    };
  });

  const direkt = antwort.direktAmStandort;
  const direktBereiche = direkt ? [...direkt.bereiche].sort(nachKurzzeichen) : [];
  const knoten = [...gebaeude];
  if (direkt && (direktBereiche.length > 0 || (direkt.messstellenZahl ?? 0) > 0)) {
    const zahl = summe([direkt.messstellenZahl, ...direktBereiche.map((b) => b.messstellenZahl)]);
    knoten.push({
      schluessel: 'direkt',
      art: 'direkt',
      id: null,
      name: DIREKT_AM_STANDORT,
      kurzzeichen: null,
      zeile: '',
      datenlage: zahl == null ? null : messstellenText(zahl),
      flaecheFehlt: false,
      archiviert: false,
      eltern: null,
      quelle: null,
      kinder: direktBereiche.map((b) => bereichKnoten(b, { art: 'standort', name: standortName })),
    });
  }
  return {
    leer: antwort.gebaeude.length === 0 && direktBereiche.length === 0,
    knoten,
  };
}

// ───────────────────────────────────────────────────────────── Vertrag

/** Der neue Knoten, bevor es ihn gibt (wie `OrtService.NEU`). */
const NEU = 'neu';

/**
 * Die Antwort als Baum des Ortsbaum-Vertrags — Schlüssel sind die IDs, wie im
 * Lesemodell des Servers. Archivierte Knoten fehlen: sie geben ihren Namen frei
 * und sind kein Ziel. Jeder Knoten besteht am Stichtag (mehr weiß die Antwort
 * nicht); was an einem früheren „gültig ab“ galt, urteilt der Server.
 */
export function vertragsbaum(antwort: OrtsbaumAmStichtag): Ortsbaum {
  const st = antwort.standort;
  const tag = antwort.stichtag;
  const orte: Ort[] = [
    {
      kennzeichen: st.id,
      art: 'standort',
      name: st.name,
      zeitzone: st.zeitzone,
      intervalle: [{ ab: tag, bis: null, eltern: null }],
    },
  ];
  const bereich = (b: OrtsbaumBereich, eltern: string) => {
    if (b.zustand === 'archiviert') return;
    orte.push({
      kennzeichen: b.id,
      art: 'bereich',
      name: b.name,
      intervalle: [{ ab: b.gueltigAb, bis: b.gueltigBis, eltern }],
    });
  };
  for (const g of antwort.gebaeude) {
    if (g.zustand === 'archiviert') continue;
    orte.push({
      kennzeichen: g.id,
      art: 'gebaeude',
      name: g.name,
      intervalle: [{ ab: g.gueltigAb, bis: g.gueltigBis, eltern: st.id }],
    });
    g.bereiche.forEach((b) => bereich(b, g.id));
  }
  antwort.direktAmStandort?.bereiche.forEach((b) => bereich(b, st.id));
  return { zeitzone: st.zeitzone, orte, anlagen: [], messstellen: [] };
}

export interface ZielUrteil {
  erlaubt: boolean;
  grund: EintragGrund | 'ziel_unbekannt' | null;
  text: string | null;
}

/**
 * Darf ein NEUES Gebäude / ein NEUER Bereich an `elternId` hängen? Die Regel ist
 * `eintrag` des Vertrags mit dem neuen Knoten ohne Intervall — derselbe Aufruf
 * wie `OrtService.anlegen`. Ein Bereich hängt an genau einem Gebäude ODER direkt
 * am Standort; ein Bereich als Ziel ist `ziel_art_unzulaessig` (AP-00 E4). Ein
 * Ziel, das es heute nicht gibt (fehlend, unbekannt, archiviert), ist nie erlaubt.
 */
export function zielPruefen(
  antwort: OrtsbaumAmStichtag,
  art: 'gebaeude' | 'bereich',
  elternId: string | null,
): ZielUrteil {
  const baum = vertragsbaum(antwort);
  if (!elternId || !baum.orte.some((o) => o.kennzeichen === elternId)) {
    return {
      erlaubt: false,
      grund: 'ziel_unbekannt',
      text: art === 'bereich' ? SATZ_BEREICH_ZIEL : SATZ_GEBAEUDE_ZIEL,
    };
  }
  const e = eintrag(
    {
      ...baum,
      orte: [...baum.orte, { kennzeichen: NEU, art, name: '', intervalle: [] }],
    },
    {
      objekt: NEU,
      vorgang: 'verschieben',
      ab: antwort.stichtag,
      eltern: elternId,
      heute: antwort.stichtag,
    },
  );
  return { erlaubt: e.erlaubt, grund: e.grund, text: e.text };
}

export interface BereichZiel {
  id: string;
  art: 'gebaeude' | 'standort';
  /** T5: „Gebäude Halle 2“ · „Direkt am Standort Werk Ahrenberg“. */
  label: string;
  sub: string;
}

/**
 * Die Zielliste „Hängt an“ (T5): die Gebäude des Standorts nach Kurzzeichen, am
 * Ende der Standort selbst. Sie enthält NIE einen Bereich (§5.10) — jedes Ziel
 * ist durch `zielPruefen` gegangen, die Liste baut die Regel nicht nach.
 */
export function bereichZiele(antwort: OrtsbaumAmStichtag): BereichZiel[] {
  const kandidaten: BereichZiel[] = [
    ...[...antwort.gebaeude].sort(nachKurzzeichen).map((g) => ({
      id: g.id,
      art: 'gebaeude' as const,
      label: `Gebäude ${g.name}`,
      sub: 'Bereich innerhalb des Gebäudes',
    })),
    {
      id: antwort.standort.id,
      art: 'standort' as const,
      label: `${DIREKT_AM_STANDORT} ${antwort.standort.name}`,
      sub: 'z. B. Außenfläche oder Zählerplatz',
    },
  ];
  return kandidaten.filter((z) => zielPruefen(antwort, 'bereich', z.id).erlaubt);
}

// ───────────────────────────────────────────────────────────── Dialog (T4, T5)

export type OrtDialogArt = 'gebaeude' | 'bereich';
export type OrtFassung = 'anlegen' | 'bearbeiten';

export function ortDialogTitel(art: OrtDialogArt, fassung: OrtFassung): string {
  return `${art === 'gebaeude' ? 'Gebäude' : 'Bereich'} ${fassung === 'anlegen' ? 'anlegen' : 'bearbeiten'}`;
}

export function ortDialogSenden(art: OrtDialogArt, fassung: OrtFassung): string {
  return fassung === 'anlegen' ? ortDialogTitel(art, fassung) : 'Speichern';
}

/**
 * Die Zeile unter dem Titel. T4: „Am Standort Werk Ahrenberg (ST-1). Nur der Name
 * ist Pflicht.“ — ohne „Kurzzeichen G-2 wird vergeben“: für Gebäude und Bereiche
 * gibt es keinen Vorschlag des Servers, und geraten wird es nicht. T5: der Satz des
 * Bereichs.
 */
export function ortDialogVorspann(art: OrtDialogArt, standort: { name: string; kurzzeichen: string }): string {
  return art === 'gebaeude'
    ? `Am Standort ${standort.name} (${standort.kurzzeichen}). Nur der Name ist Pflicht.`
    : 'Ein räumlicher Teil eines Gebäudes oder des Standorts — nicht verschachtelt.';
}

/** T4: die Zeitzone ist kein Feld, sie kommt vom Standort. */
export function zeitzoneSatz(zeitzone: string): string {
  return `Zeitzone: ${zeitzone} — vom Standort geerbt, kein eigenes Feld.`;
}

export interface OrtFormular {
  name: string;
  kurzzeichen: string;
  /** Nur Bereich anlegen: das Gebäude oder der Standort selbst. */
  elternId: string | null;
  /** In der Reihenfolge der Auswahl — die erste ist die Hauptnutzung (E4). */
  nutzung: Nutzung[];
  /** Die erste Fläche in m², wie getippt. */
  flaeche: string;
  /** ISO-Tag: beim Anlegen der erste Tag des Knotens und seiner Fläche, sonst der der Fläche. */
  gueltigAb: string;
  baujahr: string;
  notiz: string;
}

export const ORT_FELDER = [
  'name',
  'kurzzeichen',
  'elternId',
  'nutzung',
  'flaeche',
  'gueltigAb',
  'baujahr',
  'notiz',
] as const;
export type OrtFeld = (typeof ORT_FELDER)[number];
export type OrtFeldFehler = Partial<Record<OrtFeld, string>>;

/** Das leere Formular. `elternId`: vorgewählt nur, wenn der Weg das Ziel schon sagt (L1) oder es genau eines gibt. */
export function leeresOrtFormular(
  art: OrtDialogArt,
  antwort: OrtsbaumAmStichtag,
  vorwahl: string | null = null,
): OrtFormular {
  const ziele = art === 'bereich' ? bereichZiele(antwort) : [];
  const elternId =
    art === 'gebaeude'
      ? antwort.standort.id
      : vorwahl && ziele.some((z) => z.id === vorwahl)
        ? vorwahl
        : ziele.length === 1
          ? ziele[0].id
          : null;
  return {
    name: '',
    kurzzeichen: '',
    elternId,
    nutzung: [],
    flaeche: '',
    gueltigAb: antwort.stichtag,
    baujahr: '',
    notiz: '',
  };
}

/** Das Formular eines bestehenden Gebäudes oder Bereichs. */
export function ortFormularAus(knoten: Knoten, antwort: OrtsbaumAmStichtag): OrtFormular {
  const q = knoten.quelle!;
  return {
    name: q.name,
    kurzzeichen: q.kurzzeichen,
    elternId: null,
    nutzung: q.nutzung ?? [],
    flaeche: '',
    gueltigAb: antwort.stichtag,
    baujahr: 'baujahr' in q && q.baujahr != null ? String(q.baujahr) : '',
    notiz: q.notiz ?? '',
  };
}

function zeichen(t: string): number {
  return [...t].length;
}

/** „3 100“ (auch mit geschütztem Leerzeichen) → 3100; alles andere, das keine ganze Zahl > 0 ist → `null`. */
export function flaecheZahl(t: string): number | null {
  const roh = t.replace(/[\s\u00a0\u202f]/g, '');
  if (!/^[0-9]+$/.test(roh)) return null;
  const n = Number(roh);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface OrtPruefung {
  fehler: OrtFeldFehler;
  /** Der Geschwister-Knoten, der den Namen schon trägt — für „oder öffnen Sie …“. */
  belegtVon: { id: string; name: string; kurzzeichen: string } | null;
}

/** Wo der Knoten hängt, für die Namensregel: Gebäude am Standort, Bereich am gewählten oder bisherigen Ziel. */
function elternFuerNamen(art: OrtDialogArt, f: OrtFormular, antwort: OrtsbaumAmStichtag, selbst: Knoten | null) {
  if (art === 'gebaeude') return antwort.standort.id;
  if (!selbst) return f.elternId;
  const g = antwort.gebaeude.find((x) => x.bereiche.some((b) => b.id === selbst.id));
  return g ? g.id : antwort.standort.id;
}

/**
 * Prüft vor dem Senden, was der Server ablehnen würde — mit seinen Sätzen. Die
 * Tages-Regeln eines früheren „gültig ab“ (gab es das Ziel da schon?) urteilt der
 * Server; sein Satz landet dann am Feld „Gültig ab“.
 */
export function ortPruefen(
  art: OrtDialogArt,
  fassung: OrtFassung,
  f: OrtFormular,
  antwort: OrtsbaumAmStichtag,
  selbst: Knoten | null,
): OrtPruefung {
  const fehler: OrtFeldFehler = {};
  let belegtVon: OrtPruefung['belegtVon'] = null;

  if (fassung === 'anlegen' && art === 'bereich') {
    const ziel = zielPruefen(antwort, 'bereich', f.elternId);
    if (!ziel.erlaubt) fehler.elternId = ziel.text ?? SATZ_BEREICH_ZIEL;
  }

  const name = f.name.trim();
  if (!name) fehler.name = SATZ_NAME_FEHLT;
  else if (zeichen(name) > NAME_HOECHSTENS) fehler.name = SATZ_NAME_ZU_LANG;
  else {
    const eltern = elternFuerNamen(art, f, antwort, selbst);
    if (eltern && !fehler.elternId) {
      const traeger = nameBelegt(vertragsbaum(antwort), art, eltern, name, antwort.stichtag, selbst?.id ?? null);
      if (traeger) {
        const q = [
          ...antwort.gebaeude,
          ...antwort.gebaeude.flatMap((g) => g.bereiche),
          ...(antwort.direktAmStandort?.bereiche ?? []),
        ].find((x) => x.id === traeger.kennzeichen);
        const kurzzeichen = q?.kurzzeichen ?? traeger.kennzeichen;
        belegtVon = {
          id: traeger.kennzeichen,
          name: traeger.name,
          kurzzeichen,
        };
        fehler.name = nameBelegtSatz({ ...traeger, kennzeichen: kurzzeichen });
      }
    }
  }

  if (fassung === 'bearbeiten') {
    const kz = f.kurzzeichen.trim();
    if (!kz) fehler.kurzzeichen = SATZ_KURZZEICHEN_FEHLT;
    else if (zeichen(kz) > KURZZEICHEN_HOECHSTENS) fehler.kurzzeichen = SATZ_KURZZEICHEN_ZU_LANG;
  }

  if (f.flaeche.trim() && flaecheZahl(f.flaeche) == null) fehler.flaeche = FLAECHE_SATZ;

  if (art === 'gebaeude' && f.baujahr.trim()) {
    const jahr = Number(antwort.stichtag.slice(0, 4));
    const b = f.baujahr.trim();
    if (!/^[0-9]{4}$/.test(b) || Number(b) < BAUJAHR_FRUEHESTENS || Number(b) > jahr)
      fehler.baujahr = baujahrSatz(jahr);
  }

  if (zeichen(f.notiz.trim()) > NOTIZ_HOECHSTENS) fehler.notiz = SATZ_NOTIZ_ZU_LANG;
  return { fehler, belegtVon };
}

export function ersterOrtFehler(fehler: OrtFeldFehler): OrtFeld | null {
  return ORT_FELDER.find((k) => fehler[k]) ?? null;
}

function leerIstNull(t: string): string | null {
  const x = t.trim();
  return x ? x : null;
}

/** POST …/orte. Ohne Kurzzeichen (der Server vergibt G-n/B-n); „direkt am Standort“ = ohne `elternId`. */
export function ortAnlegenAnfrage(art: OrtDialogArt, f: OrtFormular, antwort: OrtsbaumAmStichtag): OrtAnlegen {
  const body: OrtAnlegen = {
    art,
    name: f.name.trim(),
    gueltigAb: f.gueltigAb,
    nutzung: f.nutzung.length > 0 ? [...f.nutzung] : null,
    notiz: leerIstNull(f.notiz),
    flaecheM2: f.flaeche.trim() ? flaecheZahl(f.flaeche) : null,
  };
  if (art === 'bereich') body.elternId = f.elternId === antwort.standort.id ? null : f.elternId;
  if (art === 'gebaeude') body.baujahr = f.baujahr.trim() ? Number(f.baujahr.trim()) : null;
  return body;
}

/** PUT /orte/{id} — die GANZE Menge; ein Bereich hat kein Baujahr. */
export function ortBearbeitenAnfrage(art: OrtDialogArt, f: OrtFormular): OrtBearbeiten {
  const body: OrtBearbeiten = {
    name: f.name.trim(),
    kurzzeichen: f.kurzzeichen.trim(),
    nutzung: f.nutzung.length > 0 ? [...f.nutzung] : null,
    notiz: leerIstNull(f.notiz),
  };
  if (art === 'gebaeude') body.baujahr = f.baujahr.trim() ? Number(f.baujahr.trim()) : null;
  return body;
}

/** PUT /orte/{id}/flaeche — nur, wenn beim Bearbeiten eine erste Fläche eingetragen wurde. */
export function ortFlaecheAnfrage(f: OrtFormular): OrtFlaeche | null {
  const m2 = f.flaeche.trim() ? flaecheZahl(f.flaeche) : null;
  return m2 == null ? null : { m2, gueltigAb: f.gueltigAb };
}

/**
 * Das Feld des Dialogs zu einer Ablehnung. Die Tages-Gründe (`ziel_gab_es_noch_nicht`,
 * `ziel_archiviert`, `gab_es_noch_nicht`) meinen das Datum, auch wenn der Server
 * `elternId` nennt; `flaecheM2`/`m2` ist das Feld der Fläche.
 */
export function ortFeldAusServer(fehler: OrtFehler): OrtFeld | null {
  if (fehler.code === 'name_belegt') return 'name';
  if (fehler.code === 'kurzzeichen_belegt') return 'kurzzeichen';
  if (['ziel_gab_es_noch_nicht', 'ziel_archiviert', 'gab_es_noch_nicht'].includes(fehler.code)) return 'gueltigAb';
  const feld = (fehler.feld ?? '').replace(/\[\d+\]$/, '');
  if (feld === 'flaecheM2' || feld === 'm2') return 'flaeche';
  return (ORT_FELDER as readonly string[]).includes(feld) ? (feld as OrtFeld) : null;
}
