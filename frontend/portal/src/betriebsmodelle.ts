/**
 * **Zone ③ · Betriebsmodelle** (Steuerung Stufe 5, Konzept
 * `vp-steuerung-konzept-b3` §3.4 + §5 Stufe 5).
 *
 * Die Zone beantwortet vier Fragen je Modell — *Was bringt es? Was brauche ich?
 * Läuft es, und seit wann? Was passiert beim Umschalten?* — und stellt genau
 * EINE Entscheidung: **welches Betriebsmodell fährt meinen Speicher.**
 *
 * ⚠ **DIE EXKLUSIVITÄT GEHÖRT DEM SERVER, nicht dieser Datei.** Hier steht nur,
 * wie sie AUSSIEHT (Radio statt unabhängiger Schalter) und was der Kunde vorher
 * liest (die Wechsel-Karte). Erzwungen wird sie beim Schreiben in
 * `SiteProfileService.loeseAb` — das Portal kann sie damit weder umgehen noch
 * erfinden, und ein älterer Server (ohne `exklusivGruppe`) verhält sich hier
 * zeichengleich wie vor dieser Stufe: dann ist jede Karte ein eigener Schalter.
 *
 * ⚠ **DIE GRUPPE IST `speicher`, NICHT „alle vier Betriebsmodelle"** — die
 * argumentierte Abweichung vom Konzept-Wortlaut steht im Katalog-Kopf
 * (`anwendungen/catalog.json`): das Ladepark-Lastmanagement ist SCHUTZ, läuft
 * auf der Box weiter, was auch immer eine Karte sagt, und ist abgeleitet aktiv,
 * sobald eine Säule da ist. Es exklusiv zu machen hieße, eine Wechsel-Karte zu
 * zeigen, deren erste Zeile eine Falschaussage wäre.
 *
 * PURE (der `steuerungArea.ts`/`fahrplanJetzt.ts`-Präzedenzfall): kein React,
 * kein Netzwerk, jede zeitabhängige Funktion nimmt ihr `now`. Die Fläche
 * rendert nur.
 */
import type { EarningsSite } from './api';
import { anwendung, imRegal } from './anwendungen';
import { benefitLine, blockedReason, type SiteProfile } from './profiles';
import type { ActiveMode } from './surface';
import { contributionLine } from './steuerungArea';

// ---------------------------------------------------------------------------
// 1 · Die Voraussetzungs-AMPEL
// ---------------------------------------------------------------------------

/** Die zwei Sorten einer Voraussetzung (Server-Vokabular, Katalog-Daten). */
export type VoraussetzungsArt = 'hardware' | 'einstellung';

export type BehebungsZiel = 'einstellungen' | 'modell' | 'ladepark' | 'voltpilot';

/**
 * Eine Ampel-Zeile: der Chip, sein Urteil, und — nur wenn er FEHLT und es
 * wirklich einen Weg gibt — wohin der Kunde dafür muss.
 */
export interface AmpelZeile {
  label: string;
  met: boolean;
  art: VoraussetzungsArt;
  /** Der Text der Zeile („Speicher" / „Leistungspreis fehlt"). */
  text: string;
  /**
   * Der Direktlink, oder `null`. `null` heißt: es gibt nichts, was ein Klick
   * löst — entweder ist die Voraussetzung erfüllt, oder sie ist ein Fakt über
   * die Anlage (kein Speicher), oder VoltPilot trägt den Wert ein.
   */
  weg: { ziel: Exclude<BehebungsZiel, 'voltpilot'>; label: string } | null;
  /**
   * Der ehrliche Satz statt eines Wegs, wenn VoltPilot den Wert einträgt
   * (Konzept §3.4: „Wir tragen ihn für Sie ein — VoltPilot"). Null sonst.
   */
  durchVoltpilot: string | null;
}

/** Konzept §3.4 wörtlich: admin-conditionale Felder bleiben admin-conditional. */
export const DURCH_VOLTPILOT = 'Wir tragen ihn für Sie ein — VoltPilot.';

/**
 * ⚠ Eine Voraussetzung OHNE `art` (älterer Server) gilt als `hardware` — die
 * vorsichtigere Lesart: sie behauptet nie, ein Klick würde reichen, und sie
 * schiebt die Karte höchstens unter „Nicht möglich", statt einen Weg zu
 * versprechen, den niemand gehen kann.
 */
function artOf(r: { art?: string | null }): VoraussetzungsArt {
  return r.art === 'einstellung' ? 'einstellung' : 'hardware';
}

export function ampel(profile: SiteProfile): AmpelZeile[] {
  return (profile.requirements ?? []).map((r) => {
    const art = artOf(r);
    const ziel = r.behebung?.ziel ?? null;
    const label = r.behebung?.label ?? null;
    return {
      label: r.label,
      met: r.met,
      art,
      text: r.met ? r.label : `${r.label} fehlt`,
      // Ein Weg wird NUR gezeigt, wenn er auch nötig ist: eine erfüllte
      // Voraussetzung braucht keinen Klick.
      weg:
        !r.met && ziel && ziel !== 'voltpilot' && label
          ? { ziel: ziel as Exclude<BehebungsZiel, 'voltpilot'>, label }
          : null,
      durchVoltpilot: !r.met && ziel === 'voltpilot' ? DURCH_VOLTPILOT : null,
    };
  });
}

// ---------------------------------------------------------------------------
// 2 · „läuft seit …"
// ---------------------------------------------------------------------------

const TAG_MS = 24 * 3600 * 1000;

function zweistellig(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * „läuft seit 12.08." — bzw. „läuft seit heute, 14:02", wenn es HEUTE
 * eingeschaltet wurde (ein Datum ohne Uhrzeit läse sich dort wie „schon länger").
 *
 * ⚠ **`null` heißt „nicht belegt", nie „läuft nicht":** ein abgeleitet aktives
 * Modell hat gar keine gespeicherte Zeile (jede Bestandsanlage), und ein
 * unlesbarer Stempel ist kein Datum. Die Fläche sagt dann schlicht „läuft".
 */
export function laeuftSeit(seit: string | null | undefined, now: Date): string | null {
  if (!seit) return null;
  const d = new Date(seit);
  if (Number.isNaN(d.getTime())) return null;
  // Eine Zukunfts-Uhrzeit (Uhren-Versatz zwischen Server und Browser) wird
  // NICHT als „seit" ausgegeben - „läuft seit morgen" ist keine Aussage.
  if (d.getTime() > now.getTime() + 60_000) return null;
  const gleicherTag =
    d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (gleicherTag) {
    return `läuft seit heute, ${zweistellig(d.getHours())}:${zweistellig(d.getMinutes())} Uhr`;
  }
  const gestern = new Date(now.getTime() - TAG_MS);
  const istGestern =
    d.getFullYear() === gestern.getFullYear()
    && d.getMonth() === gestern.getMonth()
    && d.getDate() === gestern.getDate();
  if (istGestern) return 'läuft seit gestern';
  return `läuft seit ${zweistellig(d.getDate())}.${zweistellig(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// 3 · Die Karte eines Betriebsmodells
// ---------------------------------------------------------------------------

export interface BetriebsmodellKarte {
  id: string;
  label: string;
  /** EIN Satz aus dem Katalog: was dieses Modell dem Kunden tut. */
  nutzen: string;
  /** Der effektive Zustand — der Radio-Knopf zeigt genau ihn. */
  aktiv: boolean;
  /** Die Exklusivitäts-Gruppe, oder null (dann ist es ein eigener Schalter). */
  gruppe: string | null;
  /** Die Voraussetzungs-Ampel. */
  ampel: AmpelZeile[];
  /**
   * Kann dieses Modell auf DIESER Anlage überhaupt laufen? False, sobald eine
   * HARDWARE-Voraussetzung fehlt — dann steht die Karte eingeklappt unter
   * „Nicht möglich", mit ihrem Grund.
   */
  moeglich: boolean;
  /** Die Labels der fehlenden Hardware — der Grund für „nicht möglich". */
  fehlendeHardware: string[];
  /** „läuft seit 12.08." — null, wo es nicht belegt ist. */
  seit: string | null;
  /** Der LIVE-BELEG: was es bisher gebracht hat. Null ohne echte Zahl. */
  beleg: string | null;
  /** Der ehrliche Satz eines eingeschalteten Modells, das nicht voll läuft. */
  blockedReason: string | null;
}

/**
 * Die Karten der Zone, aus der Server-Antwort. Ein Eintrag, den DIESE
 * Katalog-Kopie nicht kennt (neuerer Server), wird ausgelassen statt ohne
 * Nutzen-Satz gerendert — die `profileRows`-Disziplin.
 */
export function betriebsmodellKarten(
  profiles: SiteProfile[] | null | undefined,
  modes: ActiveMode[],
  earnings: EarningsSite | null | undefined,
  now: Date,
): BetriebsmodellKarte[] {
  const byKind = new Map(modes.map((m) => [String(m.kind), m] as const));
  return (profiles ?? [])
    .filter((p) => imRegal(p.id))
    .map((p) => {
      const zeilen = ampel(p);
      const fehlendeHardware = zeilen.filter((z) => !z.met && z.art === 'hardware')
        .map((z) => z.label);
      const mode = byKind.get(p.id) ?? null;
      return {
        id: p.id,
        label: p.label,
        nutzen: benefitLine(p),
        aktiv: p.active,
        gruppe: p.exklusivGruppe ?? anwendung(p.id)?.exklusiv_gruppe ?? null,
        ampel: zeilen,
        moeglich: fehlendeHardware.length === 0,
        fehlendeHardware,
        seit: p.active ? laeuftSeit(p.seit, now) : null,
        beleg: p.active ? contributionLine(mode, earnings) : null,
        blockedReason: blockedReason(p),
      };
    });
}

export interface BetriebsmodellZone {
  /**
   * Die Karten der EXKLUSIVEN Gruppe — sie bilden mit dem Grundmodus EINE
   * Radiogruppe: es läuft immer genau eines davon, oder keines.
   */
  radio: BetriebsmodellKarte[];
  /**
   * Karten OHNE Gruppe (heute: das Ladepark-Lastmanagement). Sie sind je ein
   * eigener Schalter — ein Modell, das keiner Gruppe angehört, konkurriert mit
   * niemandem und darf deshalb neben jedem anderen laufen.
   */
  eigene: BetriebsmodellKarte[];
  /** Die eingeklappten „Nicht möglich auf dieser Anlage"-Karten. */
  nichtMoeglich: BetriebsmodellKarte[];
  /** Das laufende Modell der Radiogruppe, oder null (= Grundmodus). */
  aktiv: BetriebsmodellKarte | null;
  /**
   * ⚠ **ALTBESTAND:** mehr als EIN Modell derselben Gruppe ist aktiv. Diese
   * Anlage hat ihre Wahl nie getroffen (Multi-Use vor Stufe 5), also wird ihr
   * NICHTS abgeschaltet — sie wird gefragt. Erst der nächste Klick setzt die
   * Exklusivität durch, und dann tut es der Server.
   */
  altbestand: BetriebsmodellKarte[];
}

/**
 * Die Zone: was als Radiogruppe zusammengehört, was ein eigener Schalter ist,
 * was eingeklappt bleibt — und ob diese Anlage ein Altbestand mit zwei aktiven
 * Modellen ist.
 */
export function betriebsmodellZone(
  profiles: SiteProfile[] | null | undefined,
  modes: ActiveMode[],
  earnings: EarningsSite | null | undefined,
  now: Date,
): BetriebsmodellZone {
  const alle = betriebsmodellKarten(profiles, modes, earnings, now);
  const moeglich = alle.filter((k) => k.moeglich);
  const radio = moeglich.filter((k) => k.gruppe != null);
  const eigene = moeglich.filter((k) => k.gruppe == null);
  const nichtMoeglich = alle.filter((k) => !k.moeglich);
  // Die Exklusivität gilt JE GRUPPE, und geprüft wird über ALLE Karten — auch
  // eine „nicht mögliche" kann laufen (ein abgeleitetes Signal fragt nicht nach
  // der Hardware), und ein Altbestand darf nicht daran vorbeigehen.
  const proGruppe = new Map<string, BetriebsmodellKarte[]>();
  for (const k of alle) {
    if (!k.gruppe || !k.aktiv) continue;
    const liste = proGruppe.get(k.gruppe) ?? [];
    liste.push(k);
    proGruppe.set(k.gruppe, liste);
  }
  let aktiv: BetriebsmodellKarte | null = null;
  const altbestand: BetriebsmodellKarte[] = [];
  for (const liste of proGruppe.values()) {
    if (liste.length === 1) {
      if (!aktiv) aktiv = liste[0];
    } else {
      altbestand.push(...liste);
    }
  }
  return { radio, eigene, nichtMoeglich, aktiv, altbestand };
}

// ---------------------------------------------------------------------------
// 4 · Copy der Zone
// ---------------------------------------------------------------------------

/** Der GRUNDMODUS — kein Betriebsmodell ist ein vollwertiger Zustand. */
export const GRUNDMODUS_TITEL = 'Eigenverbrauchs-Fahrplan';

export const GRUNDMODUS_SATZ =
  'Ohne Betriebsmodell fährt Ihr Speicher den Eigenverbrauchs-Fahrplan: '
  + 'möglichst viel eigener Strom im Haus.';

/** Die Überschrift der eingeklappten Nicht-möglich-Liste. */
export function nichtMoeglichTitel(anzahl: number): string {
  return anzahl === 1
    ? 'Nicht möglich auf dieser Anlage: 1 Betriebsmodell'
    : `Nicht möglich auf dieser Anlage: ${anzahl} Betriebsmodelle`;
}

/** Der Grund je eingeklappter Karte — konkret, nie „nicht verfügbar". */
export function nichtMoeglichGrund(karte: BetriebsmodellKarte): string {
  if (karte.fehlendeHardware.length === 0) return '';
  return `${karte.label} — dafür fehlt ${karte.fehlendeHardware.join(' und ')}.`;
}

/**
 * Der ALTBESTANDS-Hinweis. Er fordert eine Wahl, er nimmt sie nicht vorweg:
 * automatisch abzuschalten wäre eine Entscheidung über eine laufende
 * Kundenanlage, die niemand getroffen hat.
 */
export function altbestandSatz(karten: BetriebsmodellKarte[]): string | null {
  if (karten.length < 2) return null;
  const namen = karten.map((k) => k.label).join(' und ');
  return `Auf dieser Anlage laufen zwei Betriebsmodelle zugleich: ${namen}. `
    + 'Seit dieser Version fährt Ihr Speicher immer nur eines. Bis Sie wählen, '
    + 'bleibt beides unverändert — VoltPilot schaltet von sich aus nichts ab.';
}

export const ALTBESTAND_TITEL = 'Bitte wählen Sie ein Betriebsmodell';
