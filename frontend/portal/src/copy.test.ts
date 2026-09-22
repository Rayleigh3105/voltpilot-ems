import ts from 'typescript';
import { STANDORT_ZUERST_SATZ, STANDORT_ZUERST_TITEL, steuerGeldWoerter } from './anlegeNurMessen';
import { GELD_BLEIBT, STARTSEITE_UNTERNEHMEN, STEUERUNG_BLEIBT } from './standortVorschlag';
import { STEUERN_EINSTIEG_AKTION, STEUERN_EINSTIEG_SATZ } from './steuernAssistent';
import { everydayArticles } from './help/content/alltag';
import { plantArticles } from './help/content/anlage';
import { KORREKTUR_VORSPANN } from './anlageUmziehen';
import {
  GESAMTWERT,
  SUMMENWERT,
  SUMMENWERT_VERBOTENE_WOERTER,
  UEMS_BEWERTUNG_ABDECKUNG,
  UEMS_BEWERTUNG_SAETZE,
  UEMS_BEWERTUNG_URTEILE,
  UEMS_EINSTUFUNGEN,
  UEMS_NORMGRENZE,
} from './glossar';
import { budgetFreiText, folgenSaetze } from './datenquelle';
import { rechteSeed } from './test/rollenFixtures';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUENDE, KENNZEICHEN, TAGESDAUER, VORGESEHEN, ZUSTAENDE } from './uemsErgebnis';
import { UEMS_FUEHREND, UEMS_LEBENSZYKLUS, UEMS_MESSSTELLE, UEMS_QUELLE, UEMS_VERGLEICH } from './glossar';
import {
  BERECHNET_AUS,
  FILTER,
  FILTER_OHNE_TREFFER,
  KEIN_ORT,
  KEINE_DATENQUELLE,
  LADEFEHLER,
  OHNE_FILTER,
  SPALTEN,
  TITEL as MESSSTELLEN_TITEL,
  VERGLEICHSQUELLE,
  ZUSTAND_HEUTE,
  leerzustand as messstellenLeer,
} from './messstellen';
import { ahrenbergRegister, leeresRegister } from './test/messstellenRegisterFixtures';
import * as QB from './quelleBinden';
import { JETZT as QB_JETZT, kanaeleK3, quellenMs01 } from './test/quelleBindenFixtures';
import { erkenne as kennzahlKennzeichen, KENNZEICHEN as KENNZAHL_KENNZEICHEN, SAETZE as KENNZAHL_SAETZE, VERBOTENE_WOERTER as KENNZAHL_VERBOTEN } from './uemsKennzahl';
import { archiviertAmText, KNOPF_ARCHIVIEREN, KNOPF_LOESCHEN, KNOPF_WIEDERHERSTELLEN } from './ortArchiv';
import { UEMS_BEREICH, UEMS_GEBAEUDE, UEMS_STANDORT, UEMS_UNTERNEHMEN } from './glossar';
import { UEMS_ROLLEN_STANDORT, UEMS_ROLLEN_UNTERNEHMEN, UEMS_ROLLE_UNTERSTUETZER } from './glossar';
import { ARTEN as RECHTE_ARTEN, KONTEN as RECHTE_KONTEN, ROLLE_KUNDENWORT, TEXTE as RECHTE_TEXTE, UMFANG_KUNDENWORT } from './rechte';
import { STAND_AM, bannerTitel } from './standAm';
import { KENNZEICHEN as BERICHT_KENNZEICHEN, SAETZE as BERICHT_SAETZE, VERBOTENE_WOERTER as BERICHT_VERBOTEN } from './uemsBericht';
import { FLAECHE as STEUERUNG_FLAECHE, flaechenSatz as steuerungFlaechenSatz, KUNDENWORT as GEMEINSAME_STEUERUNG, platzhalter as steuerungPlatzhalter, SAETZE as STEUERUNG_SAETZE, satz as steuerungSatz } from './uemsGemeinsameSteuerung';
import * as KK from './kennzahlKarte';
import * as BS from './berichtSeite';
import { berichtAm, detailAm, entwurfAm, heutigeWerteAm, nameHeuteAm, standAm, vergleichAm } from './test/berichtFixtures';
import * as BD from './berichtDialoge';
import { UEMS_BERICHTE, UEMS_BERICHTSSTAND, UEMS_DATENSTAND, UEMS_ENTWURF, UEMS_PRUEFSUMME, UEMS_QUELLENVERZEICHNIS } from './glossar';
import { UEMS_BERECHNUNG, UEMS_BEZUGSGROESSE, UEMS_KENNZAHLEN, UEMS_MENGE, UEMS_RECHENFORM } from './glossar';
import {
  UEMS_DATENLAGE,
  UEMS_ENERGIEBILANZ,
  UEMS_ERHALTEN,
  UEMS_EREIGNIS_AM,
  UEMS_EREIGNIS_SEIT,
  UEMS_EREIGNIS_VON_BIS,
  UEMS_KEINE_WERTE_AM,
  UEMS_KEINE_WERTE_IM,
  UEMS_KEINE_WERTE_VON_BIS,
  UEMS_MANUELL_ABGELESEN,
  UEMS_NICHT_VERORTET,
  UEMS_VERLAUF,
  UEMS_VERLAUF_EREIGNISSE,
  UEMS_VERLAUF_PROZENT,
  UEMS_VERLAUF_WAHL,
  UEMS_WERTE,
  UEMS_WOCHE_OHNE_ZAHL,
  UEMS_ZEITRAEUME,
} from './glossar';
import * as OF from './uemsOberflaechen';
import * as VG from './uemsVergleich';
import {
  UEMS_VERGLEICH_KEIN_DELTA,
  UEMS_VERGLEICH_NICHT_ABRUFBAR,
  UEMS_VERGLEICH_NUR_EINE_REIHE,
  UEMS_VERGLEICH_WEITERE,
} from './glossar';
import { GRUENDE_OHNE_VERGLEICH } from './uemsBericht';
import { ms12November, ms12Oktober, ms12Vorjahr } from './test/vergleichFixtures';
import * as VL from './uemsVerlauf';
import * as EB from './anlageEnergiebilanz';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';
import {
  DIE_DATENQUELLE,
  NEBENGROESSEN_SATZ,
  NEBENGROESSEN_TITEL,
  QUELLE_AB_ZEIGEN,
  QUELLE_GILT_AB,
  QUELLE_GILT_SEIT,
  QUELLE_OHNE_RECHT,
  QUELLE_ZUORDNEN,
  VERSION_FRUEHERE,
  VERSION_NEUESTE,
} from './uemsWerteKarte';
import {
  fassungenVon as kennzahlFassungen,
  KZ as KENNZAHL_IDS,
  kennzahlenDerWelt,
  kennzahlWerteAntwort,
  kennzahlWertVersionenAntwort,
} from './test/kennzahlWerteFixtures';

/**
 * Portal v3 · M7 — the copy guard.
 *
 * The customer surface speaks OUTCOMES, never internals (BUILD.md §4.4) and
 * uses the locked D3 dictionary (Gerät / Komponente / Messwert). This test
 * reads the customer-facing source files (`node:fs`, the `migration.test.ts`
 * teardown-guard precedent), strips comments, and fails if a forbidden word
 * has crept back into a rendered string — so a future edit that re-introduces
 * "Entität", "Messpunkt", "MILP" … in a customer view breaks CI here first.
 *
 * SCOPE (explicit, per the M7 gotcha): the technical/installer + admin +
 * flow-editor construction surfaces legitimately use operator vocabulary, so
 * they are excluded by path. Comments are stripped, so a German docstring
 * explaining the v2 entity model never trips the guard — only VISIBLE strings
 * are scanned.
 */

/** The portal source root (vitest runs in the `frontend/portal` root). */
const SRC = join(process.cwd(), 'src');

/**
 * Path fragments that are NOT the plain-customer surface, so they are allowed
 * to use operator vocabulary:
 *  - `pages/admin/` — the Portal-Admin console (DO-NOT-TOUCH).
 *  - `EntitaetenSection` — the installer/technical panel (M7 gates it behind
 *    `showTechnicalLayer()`; it is only ever rendered for a platform-admin).
 *  - `entities.ts` / `entitiesApi.ts` / `entityLabel` internals kept out only
 *    where they carry raw catalog vocabulary (`entities.ts`, `entitiesApi.ts`).
 *  - `channels.ts` — the raw-channel fallback (per the M7 gotcha).
 *  - `flows/` — the flow-graph editor is a power-user CONSTRUCTION surface; its
 *    validator/model messages reference entity IDs inherently (like the
 *    installer panel). Sweeping it is out of M7 scope.
 */
const EXCLUDED = [
  '/pages/admin/',
  // Die REINEN Schichten der Admin-Konsole. Sie liegen in `src/`, weil dort
  // die reinen Module wohnen - sie sind aber ausschließlich Zulieferer von
  // `pages/admin/*` und sprechen deshalb legitim Betreiber-Vokabular („Broker",
  // „Rollout", „Manifest"). Damit diese Ausnahme keine Lücke wird, PRÜFT der
  // Test unten, dass keine Kundenfläche sie importiert.
  '/adminEdgeUpdates.ts',
  '/adminFleet.ts',
  '/adminPulse.ts',
  '/onboardingFunnel.ts',
  '/adminVorlagen.ts',
  '/adminKomponentenFlotte.ts',
  '/adminGeraet.ts',
  // Die reine Schicht der Admin-Seite „Geräte & Updates" (`pages/admin/BoxVersions`,
  // einziger Importeur) — sie spricht legitim Betreiber-Vokabular (Release, Version).
  '/boxVersions.ts',
  // Anlagen-Zentrale Stufe 3 (PR 3a): der Nachfolger der aufgelösten
  // Installateur-Ansicht. Er spricht legitim Betreiber-Vokabular („Entität",
  // „Messpunkt") und wird - wie die Plattform-Sicht - NUR hinter dem EINEN Tor
  // gerendert; der Test unten prüft dieses Tor, statt es zu glauben.
  '/components/TechnischeKarten.tsx',
  // UEMS AP-15 IP-24: die reine Schicht des Betreiber-Blatts „Gemeinsame Steuerung“ (einziger Importeur
  // `pages/admin/GemeinsameSteuerungBetreiberBlatt`) — Betreiber-Vokabular (Messpunkt, plan_id, Epoche).
  '/adminGemeinsameSteuerung.ts',
  '/entities.ts',
  '/entitiesApi.ts',
  '/channels.ts',
  '/flows/',
];

/**
 * Forbidden vocabulary in the customer surface (M7). Each is unambiguous German
 * jargon or an internal acronym — never legitimate customer copy.
 *
 * Deliberately NOT blanket-forbidden here (documented, not an oversight):
 *  - `Optimizer` — the German customer copy says „Optimierung"; „Optimizer"
 *    survives only as the admin Plattform PAGE name (`nav.ts`, adminOnly).
 *  - `Modul` — „Module" is legitimate customer copy for Solarmodule (Technik
 *    „N Module"); the value-module jargon is guarded in `moduleSurface.test.ts`.
 *  - `Quelle` as an entity noun — not regex-separable from the legitimate
 *    „Energiequelle" / „Quelle: Marktstammdaten"; the entity noun was already
 *    removed from the customer model in M6.
 */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /Entität/, why: 'D3: „Komponente" statt „Entität"' },
  { re: /Messpunkt/, why: 'D3: „Messwert"/„Messgerät" statt „Messpunkt"' },
  { re: /Mess-Einheit/, why: 'D3: keine „Mess-Einheit" in der Kundensicht' },
  { re: /Anlagenteil/, why: 'D3: „Komponente" statt „Anlagenteil"' },
  { re: /Flow-Dokument/, why: 'Ergebnissprache: kein „Flow-Dokument"' },
  { re: /\bMILP\b/, why: 'Ergebnissprache: kein „MILP" (sag „Optimierungsmodell")' },
  // Fahrplan-"Warum" (vp-fahrplan-why-design): the λ number is customer-named
  // "Wert gespeicherter Energie" - solver vocabulary never reaches customers.
  { re: /Schattenpreis/, why: 'Fahrplan-Warum: „Wert gespeicherter Energie" statt „Schattenpreis"' },
  { re: /\bDual(werte?|s)?\b/, why: 'Fahrplan-Warum: keine „Duals" in der Kundensicht' },
  { re: /\bBroker\b/, why: 'Ergebnissprache: kein „Broker"' },
  { re: /\bAngefragt\b/i, why: 'M3: kein „Angefragt" — jedes Profil ist ein direkter Schalter' },
  { re: /in Vorbereitung/, why: 'M3: kein „in Vorbereitung"' },
  { re: /VoltPilot richtet ein/, why: 'M3: keine „VoltPilot richtet ein"-Anfragewand' },
  // Naming Set A (Einheitsmodell, Captain-Entscheid E1): die Kapsel heißt
  // „Regeln", der Knopf „＋ Neue Regel". „Automation" war das technischere Wort
  // für dieselbe Sache und ist aus der Kundensicht verschwunden. Die
  // WORTGRENZE ist load-bearing: Bezeichner wie `AutomationRow` oder
  // „Geräte-Automatik" (ein eigener Cockpit-Block, kein Regel-Wort) bleiben
  // unberührt.
  { re: /\bAutomation(en)?\b/, why: 'Set A: „Regel" statt „Automation"' },
  // Anwendungs-Programm Stufe 0 (Captain-Vokabular 24.08.2026): das Kundenwort
  // für eine Anwendung ist „Anwendung", nie „Modus" oder „Modus-Profil". Die
  // CODE-Ids bleiben (`ModeKind`, `ModusContainer`, die Route `/profiles`, die
  // Spalte `profile`, die `vp-modus-*`-Klassen) - sie sind kein Kundentext, und
  // dieser Wächter liest nur SICHTBARE Zeichenketten.
  { re: /Modus-Profil/, why: 'Stufe 0: „Anwendung" statt „Modus-Profil"' },
  { re: /\bModi\b/, why: 'Stufe 0: „Anwendungen" statt „Modi"' },
  { re: /\bModus\b/, why: 'Stufe 0: „Betriebsmodell" statt „Modus" (Geräte-Betriebsart siehe GERAETE_MODUS)' },
  // Steuerung Stufe 8 (Captain 25.08.2026, §7): „Anwendung" ist KEIN Kundenwort
  // mehr - es bleibt das interne Modell (Katalog, `AnwendungDef`, die Route
  // `/profiles`, der Java-Dienst). Das Kundenwort für das Schaltbare ist
  // „Betriebsmodell"; wo es um etwas anderes ging, sagt der Satz seither, was
  // gemeint ist („Steuerung", „Ihre Regeln"). Die WORTGRENZE ist load-bearing:
  // Bezeichner wie `anwendungLabel` oder `AnwendungKlasse` bleiben unberührt,
  // und der Wächter liest ohnehin nur SICHTBARE Zeichenketten.
  { re: /\bAnwendung(en)?\b/, why: 'Stufe 8: „Betriebsmodell" statt „Anwendung"' },
];

/**
 * UEMS · AP-00 IP-4 — die INTERNEN Wörter, die in keinem Kundentext stehen.
 *
 * Die Kundenwörter des Unternehmens-Energiemanagements sind entschieden und
 * wohnen byte-verbatim in `docs/fachmodell/glossar.md` (die Pflegeregel steht
 * in `docs/fachmodell/README.md`); als Konstanten stehen sie in `glossar.ts`.
 * Diese Liste ist die andere Hälfte: sie verbietet die WERKSTATT-Wörter, mit
 * denen dieselben Dinge im Code, in der Datenbank und in den Verträgen heißen.
 *
 * ⚠ Warum eine ZWEITE Liste statt `FORBIDDEN` zu erweitern: `FORBIDDEN` läuft
 * über den ganzen kommentarfreien QUELLTEXT. Das trägt bei deutschen Wörtern
 * („Entität", „Messpunkt"), die als Bezeichner nicht vorkommen — englische
 * Werkstatt-Wörter sind aber genau die Bezeichner dieses Codes (`Device`,
 * `Site`, `Channel`, `Entity`). Diese Liste läuft deshalb nur über die
 * EXTRAHIERTEN sichtbaren Texte (`visibleTexts()`): Zeichenketten und
 * JSX-Text, nie ein Typname und nie ein Importpfad.
 *
 * Die Muster sind bewusst GROSS-/KLEINSCHREIBUNGS-EMPFINDLICH, wo das Wort
 * auch klein als Kennung vorkommt (`Edge` vs. die Beispiel-Kennung
 * „edge-k7m2xqp", `Slot` vs. `plan.slots`): ein deutscher Kundensatz schreibt
 * das Substantiv groß, eine Kennung nicht.
 */
const FORBIDDEN_INTERN: Array<{ re: RegExp; why: string }> = [
  // AP-02 IP-15: der archivierte Knoten heißt beim Kunden „Archiviert am …“, nie Grabstein/Tombstone.
  { re: /\b(Grabstein\w*|Tombstones?)\b/, why: 'UEMS: „Archiviert am …“ statt „Grabstein“/„Tombstone“' },
  { re: /\bTenant\w*/, why: 'UEMS: „Kundenbereich" (bzw. „Unternehmen") statt „Tenant"' },
  { re: /\bSites?\b/, why: 'UEMS: „Anlage" oder „Standort" statt „Site"' },
  { re: /\bStandort-ID\b/i, why: 'UEMS: der Standort trägt einen NAMEN, keine „Standort-ID"' },
  { re: /\bEntit(y|ies)\b/i, why: 'UEMS: „Komponente" statt „Entity"' },
  { re: /\bChannels?\b/i, why: 'UEMS: „Messkanal"/„Messwert" statt „Channel"' },
  { re: /\bpoint[_-]?key\b/i, why: 'UEMS: „Messwert" statt „point_key"' },
  { re: /\bDevices?\b/i, why: 'UEMS: „Gerät" oder „VoltPilot-Box" statt „Device"' },
  { re: /\bRollups?\b/i, why: 'UEMS: „Verdichtung" statt „Rollup"' },
  { re: /\bBuckets?\b/i, why: 'UEMS: „Zeitraster" statt „Bucket"' },
  { re: /\bRetention\b/i, why: 'UEMS: „Aufbewahrung" statt „Retention"' },
  { re: /\bIngest\w*/i, why: 'UEMS: „Datenannahme" statt „Ingest"' },
  { re: /\bWriter\b/i, why: 'UEMS: „Datenannahme" statt „Writer"' },
  { re: /\bRead-Model\b/i, why: 'UEMS: kein „Read-Model" in der Kundensicht' },
  { re: /\bEdge\b/, why: 'UEMS: „VoltPilot-Box" statt „Edge"' },
  { re: /\bSlots?\b/, why: 'UEMS: „Steckplatz" (Karte) bzw. „Viertelstunde" (Zeit) statt „Slot"' },
  { re: /\b(un)?claim\w*/i, why: 'UEMS: „anmelden"/„abmelden" statt „Claim"/„Unclaim"' },
  // AP-04 IP-5: das Register spricht Messstelle · Quelle · führend · Vergleich — nie die Werkstatt-Wörter dafür.
  { re: /\b(Primär|Sekundär|Haupt|Leit|Zweit)quellen?\b/, why: 'UEMS AP-04: „führende Quelle" bzw. „Vergleichsquelle"' },
  { re: /\bReferenzquellen?\b/, why: 'UEMS AP-04: „Vergleichsquelle" statt „Referenzquelle"' },
  { re: /\bQuellen?bindung(en)?\b/, why: 'UEMS AP-04: „Quelle" statt „Quellenbindung" (Vertragswort)' },
  { re: /\bMe(ß|ss-)[Ss]tellen?\b/, why: 'UEMS AP-04: „Messstelle" (ss, ein Wort)' },
  { re: /\bfuehrend\w*/i, why: 'UEMS AP-04: „führend" mit Umlaut' },
];

/**
 * Die dokumentierte Ausnahme zu „Edge": der ADMIN-Menüpunkt „Edge-Updates".
 *
 * Sie folgt dem Präzedenzfall „Optimizer" darüber: das Wort überlebt allein
 * als NAME einer Plattform-Seite (`nav.ts`, `adminOnly: true`), die kein Kunde
 * je sieht. Jeder andere Satz mit „Edge" fällt weiterhin durch.
 */
const ADMIN_EDGE_UPDATES = /\bEdge-Updates\b/g;

/**
 * Die dokumentierte Ausnahme zu „Slot": der ZEIT-Slot des Fahrplans.
 *
 * ⚠ Das ist ALTBESTAND, kein Freibrief. Das UEMS-Wort „Slot" meint den
 * STECKPLATZ einer Energiekarte (AP-05); die drei Sätze unten meinen die
 * Viertelstunde und sind älter als diese Regel. Sie stehen namentlich hier,
 * damit ein NEUER „Slot" — in beiden Bedeutungen — durchfällt, statt dass das
 * Wort still ganz erlaubt bleibt. Die Stellen sind im PR gelistet
 * (`control.ts`, `regeln/folgen.ts`, `optimizer.ts`).
 */
const ZEIT_SLOT = /\bVerbrauchs-Slot\b|\bViertelstunden-Slot\b|\bBeleg-Slots\b|\bim Slot\b/g;

/**
 * Die dritte dokumentierte Ausnahme: die SUCHWÖRTER des Hilfe-Handbuchs
 * (`help/content/*.ts`, Feld `keywords`).
 *
 * Sie sind, was ein Mensch TIPPT, nicht was VoltPilot sagt — genau deshalb
 * stehen dort absichtlich die Wörter vom Aufkleber und aus dem Support-Ticket
 * („edge", „VP", „Claim"). Ein Suchwort weniger ist ein unauffindbarer
 * Artikel. Die Ausnahme ist STRUKTURELL an das Feld gebunden: die Fließtexte
 * derselben Datei bleiben unter dem Wächter.
 */
const HILFE_SUCHWOERTER = /keywords:\s*\[[^\]]*\]/g;

/**
 * Die SICHTBAREN Texte einer Quelldatei: Zeichenketten-Inhalte und JSX-Text.
 *
 * `stripComments()` darüber reicht für die deutschen Wörter, nicht für die
 * englischen: `Device`, `Site` und `Channel` sind die Bezeichner dieses Codes.
 * Dieser Abtaster läuft deshalb einmal durch die Datei und gibt NUR heraus,
 * was ein Mensch lesen kann — Kommentare, Typnamen, Importpfade und
 * Platzhalter (`${…}`) fallen dabei weg. Über-Auslassen kann nur einen Treffer
 * VERBERGEN (ein falsches Grün), nie einen erfinden — dieselbe Abwägung wie
 * bei `stripComments()`.
 */
function visibleTexts(code: string): string[] {
  const out: string[] = [];
  const n = code.length;
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Ein regulärer Ausdruck darf Anführungszeichen tragen (`/['"]/`) - er
    // würde den Abtaster sonst mitten im Code eine Zeichenkette öffnen lassen.
    if (c === '/' && /[(=,:[!&|?{};+\n]/.test(prev)) {
      i++;
      let klasse = false;
      while (i < n) {
        const d = code[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') klasse = true;
        else if (d === ']') klasse = false;
        else if (d === '/' && !klasse) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      let buf = '';
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { buf += ' '; i += 2; continue; }
        if (code[i] === '\n') break;
        buf += code[i++];
      }
      i++;
      out.push(buf);
      prev = q;
      continue;
    }
    if (c === '`') {
      i++;
      let buf = '';
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { buf += ' '; i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          let tiefe = 1;
          i += 2;
          while (i < n && tiefe > 0) {
            if (code[i] === '{') tiefe++;
            else if (code[i] === '}') tiefe--;
            i++;
          }
          buf += ' ';
          continue;
        }
        buf += code[i++];
      }
      i++;
      out.push(buf);
      prev = '`';
      continue;
    }
    if (c === '>') {
      // JSX-Text: nur ein echter `>Text<`-Lauf ohne Code-Zeichen. Damit trifft
      // der Abtaster weder `=>` noch `Array<Foo>`.
      let j = i + 1;
      let buf = '';
      while (j < n && !'<{}>`\'"'.includes(code[j])) buf += code[j++];
      if (code[j] === '<' && /[A-Za-zÄÖÜäöüß]/.test(buf) && !/[;=:?]/.test(buf)) out.push(buf);
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/**
 * Ist diese Zeichenkette überhaupt KUNDENTEXT? Ein Importpfad, eine URL, ein
 * Bezeichner in Zeichenketten-Form (`'pointKey'` als Abfrage-Parameter) und
 * ein HTTP-Kopfzeilen-Name (`X-Tenant-Id`) sind Protokoll, kein Satz — sie
 * tragen die Werkstatt-Wörter zu Recht.
 */
function isKundentext(text: string): boolean {
  const t = text.trim();
  if (/^[./]/.test(t)) return false;
  if (/:\/\//.test(t) || /[?&=]/.test(t)) return false;
  // Ein deutscher Kundensatz beginnt gross oder hat Leerzeichen; ein
  // Bezeichner, ein Klassenname (`vp-tech-device`) und ein Praefix
  // (`entity:`) tun beides nicht.
  if (!/\s/.test(t) && !/^[A-ZÄÖÜ]/.test(t)) return false;
  // …und eine Klassen-LISTE hat zwar Leerzeichen, aber kein einziges
  // grosses Wort (`vp-card vp-device-row`).
  if (/^[a-z0-9 _:-]+$/.test(t)) return false;
  if (/^X-[A-Za-z-]+$/.test(t)) return false;
  return /[a-zäöüß]{3}/.test(t);
}

/**
 * Die EINE dokumentierte Ausnahme zu „Modus": die BETRIEBSART EINES GERÄTS.
 *
 * Ein Verbraucher, den eine Regel „auf Modus „eco"" stellt, hat eine
 * Betriebsart - das ist fachlich etwas ANDERES als eine Anwendung der Anlage,
 * und der Kunde liest dort zu Recht das Wort des Geräts. Die Ausnahme ist
 * bewusst an die PHRASE gebunden, nicht an eine Datei: ein neuer Satz, der
 * „Modus" für unsere Anwendungen benutzt, fällt weiterhin durch.
 *
 * Sie wird VOR dem Scan entfernt; der Test darunter beweist, dass sie eng ist.
 */
const GERAETE_MODUS = /auf Modus [„"]/g;

/**
 * Alle dokumentierten Ausnahmen an EINER Stelle — so kann kein Fall des
 * Wächters versehentlich eine davon vergessen (und keiner eine zu viel haben).
 */
function ohneAusnahmen(text: string): string {
  return text
    .replace(GERAETE_MODUS, ' ')
    .replace(ADMIN_EDGE_UPDATES, ' ')
    .replace(ZEIT_SLOT, ' ');
}

/** Every customer-facing portal source file (no tests, no excluded paths). */
/** JEDE Quelldatei - der Wächter über die Ausnahme braucht auch die ausgenommenen. */
function walk(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function customerFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...customerFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    const rel = full.slice(SRC.length).replace(/\\/g, '/');
    if (EXCLUDED.some((frag) => rel.includes(frag))) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip block, JSDoc, JSX and line comments so only VISIBLE code (string
 * literals + JSX text) is scanned; a JSX comment is a block comment wrapped in
 * braces, so the block-comment pass covers it. Over-stripping can only hide a
 * violation (a false negative), never invent one — acceptable for a guard whose
 * job is to catch a re-introduced word in normal copy. URLs (`://`) survive the
 * line-comment strip.
 */
function stripComments(code: string): string {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('copy guard: the customer surface uses the v3 dictionary', () => {
  it('scans a non-empty set of customer files (the walker is wired)', () => {
    // A sanity check so a broken walker cannot make the guard vacuously green.
    expect(customerFiles().length).toBeGreaterThan(20);
  });

  it('contains no forbidden vocabulary in any rendered string', () => {
    const violations: string[] = [];
    for (const file of customerFiles()) {
      const visible = stripComments(readFileSync(file, 'utf8')).replace(GERAETE_MODUS, ' ');
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      for (const { re, why } of FORBIDDEN) {
        const m = re.exec(visible);
        if (m) violations.push(`${rel}: „${m[0]}" — ${why}`);
      }
    }
    expect(violations, `Verbotenes Vokabular in der Kundensicht:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  /**
   * UEMS · AP-00 IP-4 — die WERKSTATT-Wörter erreichen keinen Kundensatz.
   *
   * Derselbe Dateibestand wie oben, nur eine Ebene enger gelesen: nicht der
   * Quelltext, sondern die daraus EXTRAHIERTEN sichtbaren Texte. Das ist der
   * Preis dafür, dass `Device`, `Site` und `Channel` gleichzeitig verboten und
   * die Bezeichner dieses Codes sind.
   */
  it('nennt kein internes Werkstatt-Wort in einem sichtbaren Text (UEMS AP-00 IP-4)', () => {
    const violations: string[] = [];
    for (const file of customerFiles()) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      const quelle = readFileSync(file, 'utf8').replace(HILFE_SUCHWOERTER, ' ');
      for (const text of visibleTexts(quelle)) {
        if (!isKundentext(text)) continue;
        const sauber = ohneAusnahmen(text);
        for (const { re, why } of FORBIDDEN_INTERN) {
          const m = re.exec(sauber);
          if (m) violations.push(`${rel}: „${m[0]}" in „${text.trim().slice(0, 70)}" — ${why}`);
        }
      }
    }
    expect(
      violations,
      `Interne Wörter in der Kundensicht:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Der Wächter über den ABTASTER: er muss wirklich Texte herausgeben und
   * wirklich Code auslassen. Ohne diesen Fall könnte ein kaputter Abtaster den
   * Fall darüber still leer und damit grün machen.
   */
  it('der Abtaster gibt sichtbaren Text heraus und lässt Code aus', () => {
    expect(visibleTexts("const t = 'Ihre Anlage liefert Daten';")).toContain(
      'Ihre Anlage liefert Daten',
    );
    expect(visibleTexts('return <p>Ihr Standort ist eingerichtet</p>;')).toContain(
      'Ihr Standort ist eingerichtet',
    );
    // Bezeichner, Typen, Importpfade und Kommentare kommen NICHT heraus.
    const codeOnly = visibleTexts(
      [
        'import { DeviceDrawer } from "./DeviceDrawers";',
        '// Die Site wird per Channel gelesen.',
        '/** Das Device des Tenants. */',
        'const f = (d: Device): Site[] => d.sites;',
      ].join('\n'),
    );
    expect(codeOnly.filter((t) => isKundentext(t))).toEqual([]);
    // Ein Platzhalter reisst keinen Code in den Text.
    expect(visibleTexts('const t = `Standort ${site.name} ist aktiv`;')[0]).toBe(
      'Standort   ist aktiv',
    );
    // Ein regulaerer Ausdruck mit Anfuehrungszeichen bringt den Abtaster nicht
    // aus dem Tritt (sonst faengt mitten im Code eine Zeichenkette an).
    expect(visibleTexts(`const r = /['"]/; const t = 'Ihr Gerät';`)).toContain('Ihr Gerät');
  });

  /**
   * ⚠ Der EINE Anwendungs-Katalog ist seit Stufe 1 ein KUNDEN-Textwohnort
   * (Label, Nutzen-Satz, Voraussetzungs-Chips samt Sperr-Sätzen, Leer-Zustand,
   * Freischaltungs-Chips) — er liegt aber als JSON und wird vom Datei-Walker
   * oben nicht erfasst. Ohne diesen Fall wäre er ein stilles Loch im
   * Wörterbuch. Die `_comment`-Blöcke sind ausdrücklich AUSGENOMMEN: sie sind
   * Entwickler-Doku, kein Kundentext.
   */
  it('der Anwendungs-Katalog spricht dasselbe Kunden-Wörterbuch', () => {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'src/anwendungen/catalog.json'), 'utf8'),
    ) as { anwendungen: Record<string, unknown>[] };
    expect(catalog.anwendungen.length).toBeGreaterThan(5);
    const violations: string[] = [];
    for (const a of catalog.anwendungen) {
      const id = String(a.id);
      const texte: string[] = [String(a.label), String(a.nutzen)];
      for (const v of a.voraussetzungen as { label: string; blocked_reason: string | null }[]) {
        texte.push(v.label, v.blocked_reason ?? '');
      }
      texte.push(String(a.blocked_reason_immer ?? ''), String(a.leer_zustand ?? ''));
      texte.push(...(a.unlock_chips as string[]));
      for (const t of texte) {
        for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN]) {
          const m = re.exec(ohneAusnahmen(t));
          if (m) violations.push(`anwendungen/catalog.json · ${id}: „${m[0]}" — ${why}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  /**
   * ⚠ Die zwei ANDEREN Kundentext-Wohnorte desselben Katalogs, die der Fall
   * oben nicht anfasst: die PRESET-Sätze (die Karte des Assistenten) und die
   * BAUSTEIN-Labels (jede Zeile des Anpassen-Modus). Ohne sie wäre der Katalog
   * nur zur Hälfte im Wörterbuch — genau die Art Loch, gegen die dieser
   * Wächter existiert.
   */
  it('Preset-Sätze und Baustein-Labels sprechen dasselbe Wörterbuch', () => {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'src/anwendungen/catalog.json'), 'utf8'),
    ) as {
      presets: { id: string; label: string; satz: string }[];
      bausteine: { id: string; label: string }[];
      baustein_vorlagen?: { id: string; label: string; hinweis?: string | null }[];
    };
    expect(catalog.presets.length).toBeGreaterThan(1);
    expect(catalog.bausteine.length).toBeGreaterThan(5);
    const texte: [string, string][] = [
      ...catalog.presets.flatMap((p) => [
        [`preset ${p.id}`, p.label] as [string, string],
        [`preset ${p.id}`, p.satz] as [string, string],
      ]),
      ...catalog.bausteine.map((b) => [`baustein ${b.id}`, b.label] as [string, string]),
      ...(catalog.baustein_vorlagen ?? []).flatMap((v) => [
        [`vorlage ${v.id}`, v.label] as [string, string],
        [`vorlage ${v.id}`, v.hinweis ?? ''] as [string, string],
      ]),
    ];
    const violations: string[] = [];
    for (const [wo, text] of texte) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN]) {
        const m = re.exec(ohneAusnahmen(text));
        if (m) violations.push(`anwendungen/catalog.json · ${wo}: „${m[0]}" — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  /**
   * Der Wächter über die AUSNAHME „Modus": sie darf nur die Geräte-Betriebsart
   * durchlassen. Träte sie eines Tages weiter auf, wäre der Wortwechsel still
   * wirkungslos geworden - genau das fällt hier auf, nicht erst im Portal.
   */
  it('the device-mode carve-out for „Modus" is narrow', () => {
    const scan = (code: string) =>
      FORBIDDEN.filter(({ re }) => re.test(stripComments(code).replace(GERAETE_MODUS, ' ')))
        .map(({ re }) => re.source);
    // Durchgelassen: die Betriebsart EINES GERÄTS.
    expect(scan('const s = `stellt VoltPilot ${n} auf Modus „eco“`;')).toEqual([]);
    // Nicht durchgelassen: unser Anwendungs-Vokabular, in jeder Form.
    expect(scan("const t = 'Modus-Profile';")).toContain('Modus-Profil');
    expect(scan("const t = 'Modus hinzufügen';")).toContain('\\bModus\\b');
    expect(scan("const t = 'Ansichten dieses Modus';")).toContain('\\bModus\\b');
    expect(scan("const t = '2 Modi, ein Speicher';")).toContain('\\bModi\\b');
    // Stufe 8: „Anwendung" ist kein Kundenwort mehr - in keiner Form.
    expect(scan("const t = 'Anwendung hinzufügen';")).toContain('\\bAnwendung(en)?\\b');
    expect(scan("const t = 'Ansichten dieser Anwendung';")).toContain('\\bAnwendung(en)?\\b');
    expect(scan("const t = 'Ihre Anwendungen bleiben an';")).toContain('\\bAnwendung(en)?\\b');
    // ... und die Bezeichner bleiben unberührt (die Wortgrenze trifft sie nicht).
    expect(scan('import { anwendungLabel } from "./anwendungen";')).toEqual([]);
    expect(scan('const d: AnwendungDef | null = anwendung(id);')).toEqual([]);
    // Und Bezeichner bleiben unberührt (der Wächter liest nur sichtbaren Text,
    // die Groß-/Kleinschreibung der Ids trifft die Wortgrenzen nicht).
    expect(scan('const MODUS: Record<string, string> = {};')).toEqual([]);
    expect(scan('const modus = e.mode;')).toEqual([]);
    expect(scan('<div className="vp-modus-head" />')).toEqual([]);
  });

  /**
   * Der Wächter über die Ausnahme: die vier ausgenommenen reinen Schichten
   * dürfen NUR von der Admin-Konsole benutzt werden. Zöge sie eines Tages eine
   * Kundenfläche herein, wäre die Ausnahme still zu einem Loch geworden - und
   * genau das fällt hier auf, nicht erst im Portal.
   */
  it('the admin-only pure layers are really admin-only', () => {
    const adminOnly = [
      'adminEdgeUpdates',
      'adminFleet',
      'adminPulse',
      'onboardingFunnel',
      'adminVorlagen',
      'adminKomponentenFlotte',
      'adminGeraet',
      // `boxVersions` ist die reine Schicht der Admin-Seite „Geräte & Updates";
      // sie darf die anderen Admin-Schichten importieren (nur die Admin-Seite
      // rendert sie), war aber bei ihrer Einführung nicht mit aufgeführt.
      'boxVersions',
      // UEMS AP-15 IP-24: das Betreiber-Blatt der Gemeinsamen Steuerung.
      'adminGemeinsameSteuerung',
    ];
    // PR 1f (Anlagen-Zentrale Stufe 1): die Plattform-Sicht wohnt seither
    // ADDITIV auf der KUNDEN-Geräteseite - hinter dem EINEN Rollen-Tor
    // `showTechnicalLayer()` (das M7-Muster der Installateur-Ansicht). Genau
    // diese zwei Dateien dürfen die reinen Schichten deshalb hereinziehen;
    // damit die Ausnahme kein Loch wird, wird das Tor GEPRÜFT statt geglaubt.
    const GATE = 'showTechnicalLayer(';
    const ADMIN_BLOCK = 'components/AdminGeraetKarten.tsx';
    const rollenGehostet = [
      ADMIN_BLOCK,
      'pages/GeraetSeiteSection.tsx',
      // Geräteseiten Stufe 1: die BOX hat ihre eigene Gattung - und trägt die
      // Plattform-Sicht nach demselben Muster (dasselbe Tor, derselbe Block).
      'pages/BoxSeiteSection.tsx',
    ];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel.includes('.test.')) continue;
      // Die Admin-Konsole selbst und die vier Module untereinander dürfen.
      if (rel.startsWith('pages/admin/') || rel.startsWith('admin/')) continue;
      if (adminOnly.some((m) => rel === `${m}.ts`)) continue;
      const code = readFileSync(file, 'utf8');
      // ⚠ Auf dem KOMMENTAR-freien Text: ein Tor, das nur in einem Kommentar
      // erwähnt wird, ist keines (beim Mutationstest genau so aufgefallen).
      const gated = stripComments(code).includes(GATE);
      for (const m of adminOnly) {
        if (!new RegExp(`from '[^']*\\b${m}'`).test(code)) continue;
        // Der Block SELBST ist die Plattform-Sicht; seine Wirte tragen das Tor.
        if (rel === ADMIN_BLOCK) continue;
        if (rollenGehostet.includes(rel) && gated) continue;
        offenders.push(`${rel} importiert ${m}`);
      }
      // Und wer die Plattform-Sicht RENDERT, muss das Tor tragen.
      if (/from '[^']*\bAdminGeraetKarten'/.test(code) && !gated) {
        offenders.push(`${rel} rendert die Plattform-Sicht OHNE ${GATE})`);
      }
      // Dasselbe für die aufgelöste Installateur-Ansicht (Stufe 3): sie ist
      // vom Copy-Wächter ausgenommen, also darf sie nur hinter dem Tor
      // gerendert werden - sonst wäre die Ausnahme still ein Loch.
      if (/from '[^']*\bTechnischeKarten'/.test(code) && !gated) {
        offenders.push(`${rel} rendert die technische Sicht OHNE ${GATE})`);
      }
      // UEMS AP-15 IP-24: das Betreiber-Blatt (auch lazy geladen) nur hinter dem Tor.
      if (/['/]admin\/GemeinsameSteuerungBetreiberBlatt'/.test(code) && !gated) {
        offenders.push(`${rel} rendert das Betreiber-Blatt OHNE ${GATE})`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('would fail on a re-introduced forbidden word (the guard actually bites)', () => {
    // Every pattern matches its own bare word, so a real regression is caught.
    for (const { re } of FORBIDDEN) {
      const bareWord = re.source.replace(/\\b/g, '');
      expect(re.test(bareWord)).toBe(true);
    }
    // UEMS · AP-00 IP-4: jedes Werkstatt-Wort beisst in einem echten Satz —
    // und der Satz muss den Abtaster UND den Kundentext-Filter passieren.
    const beisst = (satz: string) => {
      const texte = visibleTexts(`const t = '${satz}';`).filter((x) => isKundentext(x));
      expect(texte, satz).not.toEqual([]);
      return FORBIDDEN_INTERN.filter(({ re }) => texte.some((x) => re.test(ohneAusnahmen(x))))
        .map(({ re }) => re.source);
    };
    expect(beisst('Der Tenant wurde gewechselt')).toContain('\\bTenant\\w*');
    expect(beisst('Diese Site liefert keine Daten')).toContain('\\bSites?\\b');
    expect(beisst('Die Standort-ID fehlt noch')).toContain('\\bStandort-ID\\b');
    expect(beisst('Die Entity ist unvollständig')).toContain('\\bEntit(y|ies)\\b');
    expect(beisst('Kein Channel gefunden')).toContain('\\bChannels?\\b');
    expect(beisst('Der point_key ist unbekannt')).toContain('\\bpoint[_-]?key\\b');
    expect(beisst('Das Device meldet sich nicht')).toContain('\\bDevices?\\b');
    expect(beisst('Das Rollup ist noch nicht fertig')).toContain('\\bRollups?\\b');
    expect(beisst('Der Bucket ist zu grob gewählt')).toContain('\\bBuckets?\\b');
    expect(beisst('Die Retention greift ab morgen')).toContain('\\bRetention\\b');
    expect(beisst('Der Ingest hat den Wert verworfen')).toContain('\\bIngest\\w*');
    expect(beisst('Der Writer schreibt gerade nach')).toContain('\\bWriter\\b');
    expect(beisst('Das Read-Model ist veraltet')).toContain('\\bRead-Model\\b');
    expect(beisst('Ihre Edge ist nicht verbunden')).toContain('\\bEdge\\b');
    expect(beisst('Der Slot 3 ist frei')).toContain('\\bSlots?\\b');
    expect(beisst('Der Claim wurde abgelehnt')).toContain('\\b(un)?claim\\w*');
    expect(beisst('Das Gerät ist unclaimed')).toContain('\\b(un)?claim\\w*');
    // …und die zwei dokumentierten Ausnahmen lassen GENAU ihren Fall durch.
    expect(beisst('Edge-Updates')).toEqual([]);
    expect(beisst('statt in diesem Verbrauchs-Slot einzuspeisen')).toEqual([]);
    // Die dritte Ausnahme trifft NUR das Suchwort-Feld, nicht den Fliesstext.
    const hilfe = (code: string) =>
      visibleTexts(code.replace(HILFE_SUCHWOERTER, ' '))
        .filter((t) => isKundentext(t))
        .filter((t) => FORBIDDEN_INTERN.some(({ re }) => re.test(ohneAusnahmen(t))));
    expect(hilfe("const a = { keywords: ['Claim', 'Device'] };")).toEqual([]);
    expect(hilfe("const a = { body: 'Der Claim wurde abgelehnt' };")).not.toEqual([]);
    // Die Ausnahmen sind ENG: ein anderer Satz mit demselben Wort faellt durch.
    expect(beisst('Die Edge bekommt ein Update')).toContain('\\bEdge\\b');
    expect(beisst('Der Slot der Karte ist belegt')).toContain('\\bSlots?\\b');
    // A forbidden word in a normal string literal IS caught…
    expect(stripComments('const x = "Entität";')).toMatch(/Entität/);
    // …while the same word inside a comment is NOT (it is stripped first).
    expect(stripComments('// erklärt die Entität\nconst x = "ok";')).not.toMatch(/Entität/);
    expect(stripComments('/** Entität */\nconst x = "ok";')).not.toMatch(/Entität/);
    // A JSX comment is stripped too.
    expect(stripComments('return <div>{/* Entität */}ok</div>;')).not.toMatch(/Entität/);
  });
});

describe('AP-01 IP-13 · Kundenwörter im Grenze-Schritt', () => {
  it('nennt Anschluss, Übergang und Rechengrundlage ohne interne Felder', () => {
    const quelle = readFileSync(join(SRC, 'components/LadeparkRahmenKarte.tsx'), 'utf8');
    expect(quelle).toContain('Heute ist kein Netzanschluss gebunden. Tragen Sie für den Übergang die vereinbarte Leistung im Dialog ein.');
    expect(quelle).toContain('Grundlast der letzten 7 Tage');
    expect(quelle).toContain('Hausreserve');
    expect(quelle).toContain('Ladebudget');
    expect(quelle.replace(/\.vereinbart_kw/g, '')).not.toMatch(/grid_limit_kw|max_house_load_kw/);
  });
});

describe('AP-06 IP-11 · Datenquelle anlegen spricht mit Kundenwörtern in Sie-Form', () => {
  it('nennt Box, Netzlage, Prüfung und Lesebudget — keine internen Transportwörter', () => {
    const quelle = readFileSync(join(process.cwd(), 'src/components/DatenquelleAnlegen.tsx'), 'utf8');
    for (const wort of ['Datenquelle anlegen', 'Netzlage', 'Zuständige Box', 'Lesebudget', 'Was danach gilt']) {
      expect(quelle).toContain(wort);
    }
    expect(`${budgetFreiText(null)} ${folgenSaetze('Halle 2', 'Box Halle 2').join(' ')}`)
      .toContain('Liegt die Quelle in einem anderen Netz, brauchen Sie eine Box dort oder eine Route der Kunden-IT.');
    expect(quelle).not.toMatch(/\b(?:Gateway-ID|Device-ID|Duty Cycle|Payload|Topic)\b/);
    expect(quelle).not.toMatch(/\b(?:du|dein(?:e|en|em|er|es)?|euch)\b/i);
  });
});

/* ---------------------------------------------------------------------------
 * K4 · Der Klartext-Wächter über den CHART-Beschriftungen
 *
 * Der Wächter oben prüft das gesperrte D3-Vokabular (Gerät/Komponente/
 * Messwert). Eine Achse, eine Legendenzeile und ein Tooltip sind aber ebenso
 * Kundencopy — nur eine Ebene tiefer, und sie standen bis Stufe 1 des
 * Chart-Redesigns unter gar keinem Wächter. Die Ersetzungen selbst leben in
 * `src/chartCopy.ts`; hier wird gemessen, dass sie eingehalten sind.
 * ------------------------------------------------------------------------- */

/** Die Kunden-Chart-Flächen (die Admin-Charts sprechen legitim Betreiber-Vokabular). */
const CHART_FILES = [
  'ScheduleChart.tsx',
  'HistoryChart.tsx',
  'TelemetryChart.tsx',
  'WeatherChart.tsx',
  'PriceHistoryChart.tsx',
  'ForecastQualityChart.tsx',
  'components/VerlaufChart.tsx',
  'components/ErloeseVerlaufChart.tsx',
  'components/PeakHistoryChart.tsx',
  // Das Tagesbild (Stufe 3) - seine Beschriftungen leben in der reinen Regel,
  // also steht die Regel-Datei hier gleichberechtigt neben dem Render.
  'components/Tagesbild.tsx',
  'tagesbild.ts',
];

const CHART_FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bSoC\b/, why: 'K4: „Ladestand" statt „SoC"' },
  { re: /State of Charge/i, why: 'K4: „Ladestand" statt „State of Charge"' },
  { re: /Day-?Ahead/i, why: 'K4: „Börsenpreis" statt „Day-Ahead"' },
  { re: /\bSpot(preis|-Preis)?\b/i, why: 'K4: „Börsenpreis" statt „Spot"' },
  // Das Fallenwort: im Energie-Portal liest sich „Viertel" als VIERTELSTUNDE.
  // Wer ein Tages-Quartil meint, schreibt die Zeitspanne aus.
  { re: /günstigste[sn]? Viertel|teuerste[sn]? Viertel/i, why: 'K4: „Viertel" liest sich als Viertelstunde' },
];

/**
 * Eine Achsen-BESCHRIFTUNG, die nur aus einer Einheit besteht. kW sagt nicht,
 * WAS gemessen wird, und kW (Leistung) neben kWh (Energie) unkommentiert zu
 * mischen ist die häufigste Verwechslung im Energie-Portal — deshalb komponiert
 * `chartCopy.axisName` „Leistung (kW)". Die SCHMALE Fassung darf die Einheit
 * allein tragen (dort ist kein Platz), und die steht immer hinter einem
 * `narrow ?`, also nie in dieser Form.
 */
const BARE_UNIT_AXIS = /name:\s*'(kW|kWh|%|ct\/kWh|EUR\/MWh|°C|W\/m²|€)'/;

describe('K4 · Klartext-Wächter über den Chart-Beschriftungen', () => {
  it('scannt die Chart-Dateien wirklich (der Wächter ist verdrahtet)', () => {
    for (const rel of CHART_FILES) {
      expect(() => readFileSync(join(SRC, rel), 'utf8'), rel).not.toThrow();
    }
  });

  it('nennt kein Fachwort in einer sichtbaren Chart-Beschriftung', () => {
    const violations: string[] = [];
    for (const rel of CHART_FILES) {
      const visible = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      for (const { re, why } of CHART_FORBIDDEN) {
        const m = re.exec(visible);
        if (m) violations.push(`${rel}: „${m[0]}" — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('lässt keine Einheit als Achsennamen allein stehen', () => {
    const violations: string[] = [];
    for (const rel of CHART_FILES) {
      const visible = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const m = BARE_UNIT_AXIS.exec(visible);
      if (m) violations.push(`${rel}: ${m[0]} — K4: die Einheit steht nie allein`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('beisst wirklich (beide Muster gegen ihren eigenen Fall geprüft)', () => {
    expect(CHART_FORBIDDEN.some(({ re }) => re.test("name: 'SoC'"))).toBe(true);
    expect(CHART_FORBIDDEN.some(({ re }) => re.test('das günstigste Viertel'))).toBe(true);
    expect(BARE_UNIT_AXIS.test("name: 'kW',")).toBe(true);
    // …und die zulässigen Formen NICHT: die komponierte Beschriftung und die
    // schmale Fassung, die die Einheit hinter einem `narrow ?` allein trägt.
    expect(BARE_UNIT_AXIS.test("name: 'Leistung (kW)',")).toBe(false);
    expect(BARE_UNIT_AXIS.test("name: narrow ? 'kW' : 'Leistung (kW)',")).toBe(false);
  });
});

/**
 * UEMS · AP-08 IP-8 — die Sätze des Ergebnis-Zustands.
 *
 * Sie wohnen im VERTRAG (`docs/contracts/v2/ergebnis-zustand-vectors.json`)
 * und im Modul `uemsErgebnis.ts`, nicht in einer Fläche — der Dateiwächter
 * oben sieht darum nur die Hälfte. Dieser Abschnitt liest jeden Kundensatz des
 * Vertrags (Zustandswörter, Kennzeichen, Tagesdauer, Raster, Rundungsdifferenz
 * und jeden erwarteten Satz) und prüft ihn gegen beide Wörterbücher und gegen
 * die Werkstatt-Schrift DIESES Vertrags: Schlüssel in snake_case, Umlaute als
 * Umschrift, die englischen Ereignis-Arten, ein ASCII-Minus, ein normales
 * Leerzeichen vor der Einheit oder als Tausendertrenner (E11).
 *
 * ⚠ Bekannt und benannt, NICHT durchgelassen aus Versehen: „Rechteck-Halten“ ist
 * heutiger Wortlaut der Verbrauchsregel und steht als Befund in der Vektor-Datei.
 * „Zuwachs 337.600“ (Punkt, ohne Einheit) spricht seit 1.3 niemand mehr — er lebt
 * nur als frühere Fassung (gespeicherte Zeilen) und wird hier nicht gelesen.
 */
const ERGEBNIS_INTERN: Array<{ re: RegExp; why: string; beispiel: string }> = [
  { re: /\b[a-z]+_[a-z0-9_]+\b/, why: 'IP-8: ein Vertragsschlüssel ist kein Kundenwort', beispiel: '36,0 kWh · keine_werte' },
  {
    re: /\b(vollstaendig|unvollstaendig|Geraetegrenze|Ruecksetzung|Ueberlauf|Luecke|Zaehlung)\b/i,
    why: 'IP-8: Umlaut-Umschrift ist Schlüsselschrift',
    beispiel: '2.304 kWh · vollstaendig',
  },
  {
    re: /\b(device|counter|restart|boundary|overflow|reset|gap|substitute|correction)\b/i,
    why: 'IP-8: die Ereignis-Art ist kein Kundenwort („Gerätegrenze“, „Rücksetzung“ …)',
    beispiel: 'counter reset 09:12',
  },
  { re: /\b(null|undefined|NaN|Infinity)\b/, why: 'IP-8: kein Wert ist „—“', beispiel: 'undefined · keine Werte' },
  { re: /(^|[\s(])-\d/, why: 'E11: Minus ist U+2212, nicht der Bindestrich', beispiel: '-34,2 kW' },
  { re: /\d (kWh|kvarh|kW|%|m³)(?![\w])/, why: 'E11: geschütztes Leerzeichen vor der Einheit', beispiel: '2.304 kWh' },
  { re: /\d \d{3}(?!\d)/, why: 'E11: Tausenderpunkt statt Leerzeichen', beispiel: '1 240 m³' },
];

describe('UEMS AP-08 IP-8 · die Ergebnis-Sätze sprechen das Kunden-Wörterbuch', () => {
  const vertrag = JSON.parse(
    readFileSync(join(process.cwd(), '../../docs/contracts/v2/ergebnis-zustand-vectors.json'), 'utf8'),
  );

  /** Jeder Kundensatz des Vertrags und des Moduls; Platzhalter stehen als „X“. */
  const saetze = (): Array<{ wo: string; text: string }> => {
    const out: Array<{ wo: string; text: string }> = [];
    const ohnePlatz = (t: string) => t.replace(/\{[a-z_]+\}/g, 'X');
    for (const z of ZUSTAENDE) out.push({ wo: 'Zustand', text: z.wort });
    for (const k of KENNZEICHEN) {
      out.push({ wo: `Kennzeichen ${k.schluessel}`, text: ohnePlatz(k.muster) });
      if (k.wort) out.push({ wo: `Wort ${k.schluessel}`, text: k.wort });
    }
    for (const w of VORGESEHEN) out.push({ wo: 'vorgesehen', text: w.wort });
    for (const t of Object.values(TAGESDAUER)) out.push({ wo: 'Tagesdauer', text: t });
    for (const k of vertrag.kennzeichen) out.push({ wo: `Beispiel ${k.schluessel}`, text: k.beispiel });
    out.push({ wo: 'Rundungsdifferenz', text: ohnePlatz(vertrag.rundung.differenz_satz) });
    out.push({ wo: 'Verlauf', text: ohnePlatz(vertrag.satz.abdeckung) });
    // Seit 1.6 (AP-08 IP-11): die Herkunft der Menge am Zustandswort.
    for (const h of Object.values(vertrag.mengen_herkunft.herleitungen)) {
      if (typeof h === 'string') out.push({ wo: 'Herkunft', text: h });
    }
    for (const f of vertrag.cases) {
      const e = f.erwartet;
      for (const t of [e.satz, e.text, e.summe_der_angezeigten, e.differenz]) {
        if (typeof t === 'string') out.push({ wo: `Fall ${f.name}`, text: t });
      }
      for (const feld of e.felder ?? []) out.push({ wo: `Raster ${f.name}`, text: feld.beschriftung });
    }
    // Seit 1.11 (AP-13 IP-1): der Grund einer fehlenden Zahl — jedes Muster und jedes Beispiel.
    for (const g of GRUENDE) out.push({ wo: `Grund ${g.code}`, text: ohnePlatz(g.muster) });
    for (const g of vertrag.grund.saetze) out.push({ wo: `Grund-Beispiel ${g.code}`, text: g.beispiel });
    return out;
  };

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    expect(saetze().length).toBeGreaterThan(150);
  });

  it('kein Kundensatz trägt ein verbotenes, internes oder Werkstatt-Wort', () => {
    const violations: string[] = [];
    for (const { wo, text } of saetze()) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN, ...ERGEBNIS_INTERN]) {
        const m = re.exec(ohneAusnahmen(text));
        if (m) violations.push(`${wo}: „${m[0]}“ in „${text}“ — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('beisst wirklich (jedes Muster gegen seinen eigenen Fall)', () => {
    for (const { re, beispiel } of ERGEBNIS_INTERN) expect(re.test(beispiel), beispiel).toBe(true);
    // …und lässt die richtige Schreibweise durch.
    for (const gut of ['2.304\u00a0kWh · vollständig', '−34,2\u00a0kW', '02:00–03:00 MESZ', '— · keine Werte']) {
      expect(ERGEBNIS_INTERN.filter(({ re }) => re.test(gut)).map(({ why }) => why), gut).toEqual([]);
    }
  });
});

/**
 * UEMS · AP-08 IP-14 — die vorbelegte Begründung eines Korrektur-Vorschlags.
 *
 * Das System schlägt vor, ein Mensch gibt frei (E14). Die Begründung sagt, was
 * das System gesehen hat, und sie wird GESPEICHERT (`messreihe_korrektur`), nie
 * im Portal gebildet — darum wohnt ihr Wortlaut im Vertrag
 * (`docs/contracts/v2/korrektur-vorschlag-vectors.json`), gesprochen von Java
 * `uems/KorrekturVorschlagRegeln`. Dieser Abschnitt liest jedes Muster, jede
 * Notiz an der Erkennung und jeden erwarteten Satz gegen dieselben Wörterbücher
 * wie die Ergebnis-Sätze.
 */
describe('UEMS AP-08 IP-14 · die Vorschlags-Begründung spricht das Kunden-Wörterbuch', () => {
  const vertrag = JSON.parse(
    readFileSync(join(process.cwd(), '../../docs/contracts/v2/korrektur-vorschlag-vectors.json'), 'utf8'),
  );

  const saetze = (): Array<{ wo: string; text: string }> => {
    const out: Array<{ wo: string; text: string }> = [];
    const ohnePlatz = (t: string) => t.replace(/\{[a-z_]+\}/g, 'X');
    for (const [art, muster] of Object.entries(vertrag.begruendung as Record<string, string>)) {
      out.push({ wo: `Muster ${art}`, text: ohnePlatz(muster) });
    }
    for (const [zustand, notiz] of Object.entries(vertrag.erkennung_notiz as Record<string, string>)) {
      out.push({ wo: `Notiz ${zustand}`, text: ohnePlatz(notiz) });
    }
    for (const f of vertrag.cases) out.push({ wo: `Fall ${f.name}`, text: f.satz });
    return out;
  };

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    expect(saetze().length).toBe(13);
  });

  it('kein Vorschlags-Satz trägt ein verbotenes, internes oder Werkstatt-Wort', () => {
    const violations: string[] = [];
    for (const { wo, text } of saetze()) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN, ...ERGEBNIS_INTERN]) {
        const m = re.exec(ohneAusnahmen(text));
        if (m) violations.push(`${wo}: „${m[0]}“ in „${text}“ — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('sagt, was gesehen wurde — nie, was der Mensch tun soll', () => {
    const auftrag = /\b(bitte|müssen|muss|sollten|sollen|freigeben|genehmigen|übernehmen Sie)\b/i;
    for (const { wo, text } of saetze()) expect(auftrag.test(text), `${wo}: ${text}`).toBe(false);
    expect(auftrag.test('Bitte freigeben.')).toBe(true);
  });
});

/**
 * UEMS AP-02 IP-15 — Archivieren, Wiederherstellen, Löschen. „archiviert“ ist ein Wort des
 * Lebenszyklus (Glossar), die Fläche sagt „Archivieren …“, „Archiviert am …“, „Wiederherstellen …“
 * und „Löschen …“; das Werkstatt-Wort für den archivierten Knoten steht in `FORBIDDEN_INTERN`.
 */
describe('UEMS AP-02 IP-15 · Archivieren, Wiederherstellen und Löschen sprechen die Kundenwörter', () => {
  it('„archiviert“ ist ein Lebenszyklus-Wort; Menü und Baum sagen „Archivieren“, „Archiviert am“, „Wiederherstellen“', () => {
    expect(UEMS_LEBENSZYKLUS).toContain('archiviert');
    expect(KNOPF_ARCHIVIEREN).toBe('Archivieren …');
    expect(KNOPF_WIEDERHERSTELLEN).toBe('Wiederherstellen …');
    expect(KNOPF_LOESCHEN).toBe('Löschen …');
    expect(archiviertAmText('2027-06-30')).toBe('Archiviert am 30.06.2027');
  });

  it('die Archiv-Flächen nennen kein „deaktiviert“ und keinen Papierkorb — und der Wächter beißt beim Grabstein', () => {
    const verboten = /\b([Dd]eaktivier\w*|Papierkorb)\b/;
    for (const datei of ['ortArchiv.ts', 'components/OrtMenue.tsx', 'components/ArchivierenDialog.tsx', 'components/Ortsbaum.tsx']) {
      const texte = visibleTexts(readFileSync(join(SRC, datei), 'utf8')).filter(isKundentext);
      expect(texte.length, datei).toBeGreaterThan(0);
      expect(texte.filter((t) => verboten.test(t)), datei).toEqual([]);
    }
    expect(FORBIDDEN_INTERN.some(({ re }) => re.test('Der Grabstein bleibt'))).toBe(true);
  });
});

/**
 * UEMS AP-02 IP-16 — die Demo-Daten des Referenzunternehmens „Kunststoffwerk Ahrenberg GmbH"
 * (`infra/local/seed/ahrenberg.sql`) sind das, was ein Mensch beim ersten Anmelden sieht.
 * Sie sprechen deshalb dieselben Kundenwörter wie jede gebaute Fläche: Standort, Gebäude,
 * Bereich, gültig ab, Stand am, rückwirkend, archiviert — und nie ihre englischen oder
 * internen Zwillinge. Der Wächter liest die Seed-Datei selbst, damit ein „Site"/„Building"
 * in einer Demo-Zeile nicht still an allen Wörterbüchern vorbeiläuft.
 */
describe('UEMS AP-02 IP-16 · die Demo-Daten Ahrenberg sprechen die Kundenwörter', () => {
  const AHRENBERG = join(SRC, '..', '..', '..', 'infra', 'local', 'seed', 'ahrenberg.sql');
  const seed = () => readFileSync(AHRENBERG, 'utf8');

  it('die sieben Wörter der Ortsstruktur stehen im Wörterbuch und auf den Flächen', () => {
    expect(UEMS_UNTERNEHMEN).toBe('Unternehmen');
    expect(UEMS_STANDORT).toBe('Standort');
    expect(UEMS_GEBAEUDE).toBe('Gebäude');
    expect(UEMS_BEREICH).toBe('Bereich');
    expect(STAND_AM).toBe('Stand am');
    expect(bannerTitel('2027-01-15')).toBe('Sie sehen den Stand am 15.01.2027');
    expect(UEMS_LEBENSZYKLUS).toContain('archiviert');
    expect(archiviertAmText('2027-06-30')).toBe('Archiviert am 30.06.2027');
    // „gültig ab" und „rückwirkend" spricht die gebaute Fläche - hier gegen die Quelle geprüft.
    expect(readFileSync(join(SRC, 'components', 'StandortDialog.tsx'), 'utf8')).toContain('Gültig ab');
    expect(readFileSync(join(SRC, 'ortVerschieben.ts'), 'utf8')).toContain('rückwirkend');
  });

  it('die Demo-Daten nennen die Orte mit den Kundenwörtern - kein englischer Zwilling', () => {
    const text = seed();
    expect(text.length).toBeGreaterThan(0);
    for (const wort of ['Standort', 'Gebäude', 'Bereich', 'gültig ab', 'rückwirkend', 'Unternehmen']) {
      expect(text, wort).toContain(wort);
    }
    const verboten = /\b(Site|Sites|Building|Buildings|Zone|Area|Facility|Snapshot|valid from|deleted)\b/;
    for (const zeile of text.split('\n')) {
      expect(verboten.test(zeile), zeile).toBe(false);
    }
  });

  it('beisst wirklich (das Muster gegen seinen eigenen Fall)', () => {
    const verboten = /\b(Site|Sites|Building|Buildings|Zone|Area|Facility|Snapshot|valid from|deleted)\b/;
    expect(verboten.test('-- Building G-1 mit Zone B-1')).toBe(true);
    expect(verboten.test('-- Gebäude G-1 mit Bereich B-1')).toBe(false);
  });
});

/**
 * UEMS AP-03 IP-16 — die Personen der Demo-Daten. Ein Seed schreibt CODES
 * (`kundenadministrator`, `unterstuetzer`, `einrichten_und_bedienen`), die Fläche zeigt
 * KUNDENWÖRTER (Kundenadministrator, Unterstützer, Einrichten und Bedienen). Dieser Wächter
 * hält beide Seiten zusammen: jeder Code, den die Demo-Daten verwenden, muss ein Kundenwort
 * haben — sonst stünde im Portal eine Rolle, die niemand benennen kann. Und die neun Wörter der
 * Rechte-Fläche stehen im Wörterbuch, nicht nur in einer Komponente.
 */
describe('UEMS AP-03 IP-16 · die Personen der Demo-Daten sprechen die Kundenwörter', () => {
  const AHRENBERG = join(SRC, '..', '..', '..', 'infra', 'local', 'seed', 'ahrenberg.sql');
  const seed = () => readFileSync(AHRENBERG, 'utf8');
  /** Die Werte einer Spalte, wie der Seed sie schreibt: `'wort'` in den VALUES-Zeilen. */
  const woerter = (codes: readonly string[]) =>
    codes.filter((c) => seed().includes(`'${c}'`));

  it('die neun Wörter der Rechte-Fläche stehen im Wörterbuch', () => {
    expect(UEMS_ROLLEN_UNTERNEHMEN).toEqual(['Kundenadministrator', 'Energiemanager']);
    expect(UEMS_ROLLEN_STANDORT).toEqual(['Bearbeiter', 'Bedienberechtigt', 'Leser']);
    expect(UEMS_ROLLE_UNTERSTUETZER).toBe('Unterstützer');
    expect(RECHTE_TEXTE.unterstuetzung_beendet).toContain('Unterstützung');
    expect(RECHTE_TEXTE.teilansicht).toContain('Teilansicht');
    expect(RECHTE_TEXTE.zugriff_beendet).toContain('Zugriff');
    // Und alle neun kommen aus EINER Quelle - kein zweites Wort für dieselbe Sache.
    for (const wort of [...UEMS_ROLLEN_UNTERNEHMEN, ...UEMS_ROLLEN_STANDORT, UEMS_ROLLE_UNTERSTUETZER]) {
      expect(Object.values(ROLLE_KUNDENWORT), wort).toContain(wort);
    }
  });

  it('jede Rolle, Kontoart, Art und jeder Umfang der Demo-Daten hat ein Kundenwort', () => {
    const rollen = woerter(Object.keys(ROLLE_KUNDENWORT));
    // Sechs der sieben Rollen kommen vor; `voltpilot_betrieb` wird nie zugewiesen.
    expect(rollen).toEqual([
      'kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer',
    ]);
    for (const rolle of rollen) {
      expect(ROLLE_KUNDENWORT[rolle as keyof typeof ROLLE_KUNDENWORT], rolle).toBeTruthy();
    }
    expect(woerter(RECHTE_KONTEN)).toEqual(['benutzer', 'partner', 'plattform']);
    // Ein Installateur und eine VoltPilot-Unterstützung; einen Notfall kennen die Demo-Daten nicht.
    expect(woerter(RECHTE_ARTEN)).toEqual(['installateur', 'voltpilot']);
    for (const umfang of woerter(Object.keys(UMFANG_KUNDENWORT))) {
      expect(UMFANG_KUNDENWORT[umfang as keyof typeof UMFANG_KUNDENWORT], umfang).toBeTruthy();
    }
  });

  it('die Demo-Daten nennen die Personen-Sachen deutsch - kein englischer Zwilling', () => {
    const verboten = /\b(User|Users|Role|Roles|Permission|Permissions|Grant|Grants|Tenant|Owner|Viewer|Editor)\b/;
    for (const zeile of seed().split('\n')) {
      expect(verboten.test(zeile), zeile).toBe(false);
    }
    expect(verboten.test('-- Role of the User in this Tenant')).toBe(true);
    expect(verboten.test('-- Rolle des Benutzers in diesem Kundenbereich')).toBe(false);
  });

  it('Sabine Rauch steht NICHT in den Demo-Daten - die Referenz streicht sie mit ST-3', () => {
    // Die Zelle AP-03 IP-16 nennt acht Logins; die einzige Quelle trägt sieben Personen.
    // AhrenbergDemoLoginTest hält dieselbe Tatsache auf der Realm-Seite fest.
    // Geprüft werden die DATEN, nicht der Kopfkommentar - der nennt beide und sagt, warum.
    const daten = seed()
      .split('\n')
      .filter((z) => !z.trimStart().startsWith('--'))
      .join('\n');
    expect(daten).not.toContain('Sabine');
    expect(daten).not.toContain('ST-3');
    // Der Kommentar dagegen MUSS es erklären, sonst trägt jemand sie stillschweigend nach.
    expect(seed()).toContain('Sabine Rauch');
  });
});

/**
 * UEMS AP-11 IP-3 — die Sätze der Kennzahl. Ihr Wortlaut steht im Vertrag (`kennzahl-vectors.json`
 * `saetze`, `ergebnis-zustand-vectors.json` `kennzahl_kennzeichen`), gesprochen von `uemsKennzahl.ts`
 * ⟷ `KennzahlRegeln.java`. Dieser Abschnitt liest jeden Satz, jedes Kennzeichen-Muster und jeden
 * erwarteten Kundensatz, jede Anzeige und jedes Kennzeichen der Vektoren gegen die Wörterbücher — und
 * gegen die Wörter, die auf einer Kennzahl-Fläche nie stehen (§4.13). Ein GEERBTER Satz (etwa
 * „enthält verteilt (70 % von MS-07)“) gehört seinem Vertrag (AP-10) und wird hier nur auf Wörter
 * geprüft, nicht auf die Zahlform.
 */
describe('UEMS AP-11 IP-3 · die Kennzahl-Sätze sprechen das Kunden-Wörterbuch', () => {
  const vektoren = JSON.parse(readFileSync(join(process.cwd(), '../../docs/contracts/v2/kennzahl-vectors.json'), 'utf8'));
  const ohnePlatz = (t: string) => t.replace(/\{[a-z_]+\}/g, 'X');

  const saetze = (): Array<{ wo: string; text: string; eigen: boolean }> => {
    const out: Array<{ wo: string; text: string; eigen: boolean }> = [];
    for (const [schluessel, text] of Object.entries(KENNZAHL_SAETZE)) out.push({ wo: `Satz ${schluessel}`, text: ohnePlatz(text), eigen: true });
    for (const k of KENNZAHL_KENNZEICHEN) out.push({ wo: `Kennzeichen ${k.schluessel}`, text: ohnePlatz(k.muster), eigen: k.herkunft !== 'geerbt' });
    for (const fall of vektoren.cases) {
      for (const p of fall.pruefungen) {
        for (const t of [p.ergebnis.kundensatz, p.ergebnis.anzeige]) {
          if (typeof t === 'string') out.push({ wo: `${fall.id} ${p.name}`, text: t, eigen: true });
        }
        for (const t of p.ergebnis.kennzeichen ?? []) {
          out.push({ wo: `${fall.id} Kennzeichen`, text: t, eigen: kennzahlKennzeichen(t)?.herkunft !== 'geerbt' });
        }
      }
    }
    return out;
  };

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    expect(saetze().length).toBeGreaterThan(150);
  });

  it('kein Kennzahl-Satz trägt ein verbotenes, internes oder Werkstatt-Wort', () => {
    const violations: string[] = [];
    for (const { wo, text, eigen } of saetze()) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN, ...(eigen ? ERGEBNIS_INTERN : [])]) {
        const m = re.exec(ohneAusnahmen(text));
        if (m) violations.push(`${wo}: „${m[0]}“ in „${text}“ — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keine Kennzahl spricht von KPI, Metrik, Kenngröße, Dashboard, Widget, Template, Durchschnitt oder Mittel (§4.13)', () => {
    const verboten = new RegExp(`(^|[^\\p{L}])(${KENNZAHL_VERBOTEN.join('|')})([^\\p{L}]|$)`, 'u');
    expect(saetze().filter(({ text }) => verboten.test(text)).map(({ wo, text }) => `${wo}: ${text}`)).toEqual([]);
    // …und der Wächter beißt.
    expect(verboten.test('Durchschnitt je Stück')).toBe(true);
    expect(verboten.test('KPI Halle 2')).toBe(true);
    expect(verboten.test('gewichtet (Summe ÷ Summe)')).toBe(false);
  });
});

/**
 * UEMS AP-12 IP-3 — die Sätze und Kennzeichen des Berichts. Ihr Wortlaut steht im Vertrag
 * (`bericht-vectors.json` `saetze`, `ergebnis-zustand-vectors.json` `bericht_kennzeichen`), gesprochen
 * von `uemsBericht.ts` ⟷ `BerichtRegeln.java`. Dieser Abschnitt liest jede Satzvorlage, jedes
 * Kennzeichen-Muster und jeden erwarteten Kundensatz und Text der Vektoren gegen die Wörterbücher — und
 * gegen die Wörter, die ein Bericht über sich nie sagt (§4.15). Die Kennzeichen der WERTE im Abzug
 * („korrigiert (Version 2)“) gehören ihrem Vertrag; der CSV ist Kundenform, aber keine Fläche.
 */
describe('UEMS AP-12 IP-3 · die Bericht-Sätze sprechen das Kunden-Wörterbuch', () => {
  const vektoren = JSON.parse(readFileSync(join(process.cwd(), '../../docs/contracts/v2/bericht-vectors.json'), 'utf8'));
  const ohnePlatz = (t: string) => t.replace(/\{[a-z_]+\}/g, 'X');

  const saetze = (): Array<{ wo: string; text: string }> => {
    const out: Array<{ wo: string; text: string }> = [];
    for (const [schluessel, text] of Object.entries(BERICHT_SAETZE)) out.push({ wo: `Satz ${schluessel}`, text: ohnePlatz(text) });
    for (const k of BERICHT_KENNZEICHEN) out.push({ wo: `Kennzeichen ${k.schluessel}`, text: ohnePlatz(k.muster) });
    for (const fall of vektoren.cases) {
      for (const p of fall.pruefungen) {
        if (['kanonisch', 'csv_kopf', 'csv_zeile'].includes(p.regel)) continue;
        for (const t of [p.ergebnis.kundensatz, p.ergebnis.text]) {
          if (typeof t === 'string') out.push({ wo: `${fall.id} ${p.name}`, text: t });
        }
      }
    }
    return out;
  };

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    expect(saetze().length).toBeGreaterThan(80);
  });

  it('kein Bericht-Satz trägt ein verbotenes, internes oder Werkstatt-Wort', () => {
    const violations: string[] = [];
    for (const { wo, text } of saetze()) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN, ...ERGEBNIS_INTERN]) {
        const m = re.exec(ohneAusnahmen(text));
        if (m) violations.push(`${wo}: „${m[0]}“ in „${text}“ — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('kein Bericht spricht über sich von Version, Ausgabe, Snapshot, Report oder „Freigabe zurücknehmen“ (§4.15)', () => {
    expect(saetze().filter(({ text }) => BERICHT_VERBOTEN.some((w) => text.includes(w))).map(({ wo, text }) => `${wo}: ${text}`)).toEqual([]);
    // …und der Wächter beißt.
    expect(BERICHT_VERBOTEN.some((w) => 'Snapshot vom 10.11.2026'.includes(w))).toBe(true);
    expect(BERICHT_VERBOTEN.some((w) => 'Berichtsstand Nr. 2 (Revision)'.includes(w))).toBe(false);
  });
});

/**
 * UEMS AP-04 IP-5 — das Messstellen-Register („Unternehmen › Messstellen“, „Standort ›
 * Messstellen“) spricht die vier Kundenwörter Messstelle · Quelle · führend · Vergleich.
 * Sie stehen als Konstanten in `glossar.ts`; die Fläche baut ihre Spalten und Sätze daraus
 * (`messstellen.ts`). Die Werkstatt-Wörter dafür (Primärquelle, Referenzquelle,
 * Quellenbindung, „fuehrend“) stehen in `FORBIDDEN_INTERN` und gelten für jede
 * Kundenfläche; hier wird zusätzlich jeder Satz des Registers gelesen — auch die, die erst
 * zur Laufzeit entstehen (Leerzustände aus den Referenzantworten).
 */
describe('UEMS AP-04 IP-5 · das Messstellen-Register spricht Messstelle · Quelle · führend · Vergleich', () => {
  const saetze = (): string[] => {
    const basis = ahrenbergRegister();
    const leer = leeresRegister();
    const ebenen = [
      { art: 'unternehmen' as const, name: 'Kunststoffwerk Ahrenberg GmbH' },
      { art: 'standort' as const, id: 'st', name: 'Werk Lindach' },
    ];
    const laufzeit = ebenen.flatMap((ebene) =>
      [true, false, null].flatMap((bereichDa) =>
        [OHNE_FILTER, { ...OHNE_FILTER, ohneQuelle: true }, { ...OHNE_FILTER, zustand: 'angehalten' as const }].flatMap(
          (filter) => messstellenLeer({ antwort: leer, basis, filter, ebene, bereichDa })?.satz ?? [],
        ),
      ),
    );
    return [
      MESSSTELLEN_TITEL,
      ...Object.values(SPALTEN),
      ZUSTAND_HEUTE,
      ...Object.values(FILTER),
      VERGLEICHSQUELLE,
      KEINE_DATENQUELLE,
      BERECHNET_AUS,
      KEIN_ORT,
      FILTER_OHNE_TREFFER,
      LADEFEHLER,
      ...laufzeit,
    ];
  };

  it('die Wörter kommen aus dem Glossar: „Quelle (führend)“, „Vergleichsquelle“, „Messstellen“', () => {
    expect(SPALTEN.quelle).toBe(`${UEMS_QUELLE} (${UEMS_FUEHREND})`);
    expect(VERGLEICHSQUELLE).toBe(`${UEMS_VERGLEICH}squelle`);
    expect(MESSSTELLEN_TITEL).toBe(`${UEMS_MESSSTELLE}n`);
    expect(FILTER.ohneQuelle).toContain(UEMS_QUELLE);
  });

  it('liest wirklich die Sätze — und kein Satz trägt ein verbotenes oder Werkstatt-Wort', () => {
    const alle = saetze();
    expect(alle.length).toBeGreaterThan(20);
    expect(alle).toContain('Alle 17 gemessenen Messstellen haben eine Quelle.');
    const violations = alle.flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN].flatMap(({ re, why }) => (re.test(ohneAusnahmen(text)) ? [`„${text}“ — ${why}`] : [])),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('die Fläche und ihr Modul stehen im Bestand des Wächters', () => {
    const dateien = customerFiles().map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(dateien).toContain('messstellen.ts');
    expect(dateien).toContain('pages/MessstellenPage.tsx');
    expect(dateien).toContain('components/EbenenTabs.tsx');
  });

  it('beißt wirklich: Primär-/Referenzquelle, Quellenbindung, „fuehrend“ — nicht die Kundenwörter', () => {
    const beisst = (t: string) => FORBIDDEN_INTERN.some(({ re }) => re.test(t));
    for (const falsch of ['Die Primärquelle von MS-06', 'Referenzquelle wählen', 'Quellenbindung beenden', 'fuehrend seit 12.03.2024', 'Meßstelle MS-01']) {
      expect(beisst(falsch), falsch).toBe(true);
    }
    for (const richtig of ['Quelle (führend)', 'führend seit 18.11.2026 10:40 · davor Z-5a', '1 Vergleichsquelle', 'Keine Datenquelle', 'Messstellen']) {
      expect(beisst(richtig), richtig).toBe(false);
    }
  });
});

/**
 * UEMS AP-04 IP-14 — „Quelle binden“ und die Quelle-Karte sprechen dieselben Wörter wie das Register: Quelle ·
 * führend · Vergleichsquelle. Nie „Quellenbindung“ (das Vertragswort der Werkstatt), nie „Primär-“ oder
 * „Referenzquelle“. Gelesen werden die festen Sätze UND die, die die Fläche aus den Ahrenberg-Fixturen bildet —
 * die Gründe der ausgegrauten Messwerte eingeschlossen, denn genau sie liest der Kunde am häufigsten.
 */
describe('UEMS AP-04 IP-14 · „Quelle binden“ spricht Quelle · führend · Vergleichsquelle (E3)', () => {
  const saetze = (): string[] => {
    const karten = QB.quelleKarte(quellenMs01(), QB_JETZT);
    const gruende = QB.messwertZeilen(
      kanaeleK3(),
      { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' },
      { rolle: 'fuehrend', eigenesKennzeichen: 'MS-01', anteil: true },
    );
    return [
      QB.QUELLE_TITEL,
      QB.QUELLE_BINDEN,
      QB.VERGLEICHSQUELLE,
      QB.VERGLEICHSQUELLE_HINZUFUEGEN,
      QB.ALS_MESSSTELLE_VERWENDEN,
      QB.KEINE_DATENQUELLE,
      QB.KEINE_VERGLEICHSQUELLE,
      QB.OHNE_BEWERTUNG,
      QB.HISTORIE,
      QB.WAS_GESCHIEHT,
      QB.LUECKE,
      ...Object.values(QB.PFLICHT),
      ...Object.values(QB.TITEL),
      ...Object.values(QB.KNOPF),
      ...QB.ZWECKE,
      ...Object.values(QB.ZWECK_SUB),
      QB.keinZielSatz([], 'Ladestand'),
      ...karten.flatMap((k) => [
        k.titel,
        ...k.werte.flatMap((w) => [w.rolle, w.quelle, w.zeitraum, w.anteil, w.ohneWert]),
        ...k.historie.flatMap((h) => [h.wert, h.zeitraum, h.marke]),
        k.leerFuehrend,
        k.leerVergleich,
      ]),
      ...gruende.map((g) => g.grund),
      QB.folgenSatz({
        rolle: 'vergleich',
        kennzeichen: 'MS-01',
        zeitpunkt: QB_JETZT,
        jetzt: QB_JETZT,
        komponente: 'Netzzähler Halle 1',
        messwert: 'Wirkleistung',
        zweck: 'Plausibilität',
        anteil: 'positiv',
        richtung: 'Bezug',
        rueckwirkendAbzeichen: null,
      }),
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  };

  it('die Wörter kommen aus dem Glossar', () => {
    expect(QB.QUELLE_TITEL).toBe(UEMS_QUELLE);
    expect(QB.QUELLE_BINDEN).toBe(`${UEMS_QUELLE} binden`);
    expect(QB.VERGLEICHSQUELLE).toBe(`${UEMS_VERGLEICH}squelle`);
    expect(QB.ALS_MESSSTELLE_VERWENDEN).toBe(`Als ${UEMS_MESSSTELLE} verwenden`);
    expect(QB.quelleKarte(quellenMs01(), QB_JETZT)[1].werte[0].rolle).toBe(UEMS_FUEHREND);
  });

  it('liest wirklich die Sätze — und kein Satz trägt ein verbotenes oder Werkstatt-Wort', () => {
    const alle = saetze();
    expect(alle.length).toBeGreaterThan(40);
    expect(alle).toContain('Beide Werte stehen nebeneinander; bewertet wird nichts.');
    const violations = alle.flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN].flatMap(({ re, why }) => (re.test(ohneAusnahmen(text)) ? [`„${text}“ — ${why}`] : [])),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('die Fläche und ihr Modul stehen im Bestand des Wächters', () => {
    const dateien = customerFiles().map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(dateien).toContain('quelleBinden.ts');
    expect(dateien).toContain('components/QuelleKarte.tsx');
    expect(dateien).toContain('components/QuelleBindenDialog.tsx');
  });

  it('E3: keine Fläche der Quelle bewertet — kein Delta, keine Ampel, kein stiller Ersatz', () => {
    const alle = saetze().join(' | ');
    for (const verboten of ['Abweichung', 'Ampel', 'plausibel', 'Toleranz', 'ersetzt', 'Delta']) {
      expect(alle, verboten).not.toContain(verboten);
    }
  });
});

/**
 * UEMS AP-11 IP-13 — die Welt „Kennzahlen“ spricht die Wörter von §4.13 (E12 = A): „Kennzahl“ gehört nur dem neuen
 * Objekt, „Berechnung“/„Fassung“ der Rechnung, „Version“ dem Wert; in der Kundensicht nie KPI, Metrik, Kenngröße,
 * Dashboard, Widget, Template — und auf einer Kennzahl-Fläche nie Durchschnitt oder Mittel (Q5). Gelesen werden die
 * Quelltexte der Flächen UND die Sätze, die sie zur Laufzeit aus den Vektor-Fixtures bilden.
 */
describe('UEMS AP-11 IP-13 · die Welt „Kennzahlen“ spricht Kennzahl · Berechnung · Fassung · Version (§4.13)', () => {
  const FLAECHEN = [
    'kennzahlKarte.ts',
    'kennzahlAnlegen.ts',
    'kennzahlAendern.ts',
    'pages/KennzahlenPage.tsx',
    // AP-13 IP-7: die Listen-Karte und ihr Lade-Hook (von der Seite und vom Baustein „Kennzahlen“ der Übersicht geteilt).
    'components/KennzahlListe.tsx',
    'pages/KennzahlSeite.tsx',
    'components/KennzahlAnlegenDialog.tsx',
    'components/KennzahlStammdatenDialog.tsx',
  ];
  const verboten = (woerter: string[]) => new RegExp(`(^|[^\\p{L}])(${woerter.join('|')})([^\\p{L}]|$)`, 'u');
  const KUNDENSICHT_VERBOTEN = verboten(['KPI', 'Metrik', 'Kenngröße', 'Kenngrößen', 'Dashboard', 'Widget', 'Template']);
  const MITTEL_VERBOTEN = verboten(['Durchschnitt', 'Durchschnitte', 'Mittel', 'Mittelwert', 'Mittelwerte']);
  const ROLLEN_VERBOTEN = verboten(['Zähler', 'Nenner', 'Dividend', 'Divisor']);
  const da = (t: string | null | undefined): t is string => typeof t === 'string';

  const laufzeit = (): string[] => {
    const jetzt = Date.parse('2026-12-03T09:00:00+01:00');
    const out: string[] = [];
    for (const k of kennzahlenDerWelt()) {
      const art = k.grundperiode!;
      const { von, bis } = KK.anfrage(art, '2026-12-03', KK.ANZAHL_VERLAUF[art]);
      const antwort = kennzahlWerteAntwort(k.id, art, von, bis, jetzt);
      const fassungen = kennzahlFassungen(k.id);
      const kopf = KK.kopf(k);
      out.push(kopf.titel, kopf.unter, ...KK.stammdaten(k).flatMap((s) => [s.name, s.wert]));
      const b = KK.berechnung(k, fassungen, 'Europe/Berlin');
      if (b) out.push(b.satz, b.wer);
      const karte = KK.listenKarte(k, { art: 'geladen', antwort });
      out.push(...[karte.zahl, karte.zustand, karte.periode, karte.unter].filter(da));
      for (const w of antwort.werte) {
        const wk = KK.wertKarte(antwort, w, KK.eingaengeDer(fassungen, w));
        out.push(wk.karte.titel, wk.karte.zahl, ...[wk.karte.zustand, wk.karte.abdeckung, wk.karte.fassung, wk.grund].filter(da));
        const h = KK.herkunftAnzeige(antwort, w);
        if (h) out.push(...[h.eingaenge, h.gebildet, h.fehlt].filter(da), ...h.paare);
      }
      for (const balken of KK.verlauf(antwort)) out.push(balken.kurz, balken.titel);
    }
    const h = KK.kennzahlHistorie(kennzahlWertVersionenAntwort(KENNZAHL_IDS.kz1, 'monat', '2026-10-01', jetzt));
    for (const v of h.versionen) {
      out.push(v.titel, ...[v.etikett, v.vorher?.zahl, v.danach.zahl, v.danach.info, v.gebildet, v.ohneEntscheidung].filter(da));
      for (const e of v.entscheidungen) out.push(e.vorgang, ...[e.fassung?.wer, e.fassung?.warum, e.angelegt?.wer].filter(da));
    }
    out.push(
      KK.TITEL, KK.LADEN, KK.LADEFEHLER, KK.WERTE_FEHLER, KK.LEER, KK.NICHT_GEFUNDEN, KK.ZUR_LISTE, KK.ARCHIVIERT,
      KK.AUSSERHALB_ZUGRIFF, KK.KARTE_VERLAUF, KK.KARTE_HERKUNFT, KK.KARTE_BERECHNUNG, KK.KARTE_STAMMDATEN, KK.FASSUNGEN_TITEL,
      KK.PERIODE_WAHL, KK.OHNE_ZWECK, KK.SEIT_BEGINN, KK.HERKUNFT_FEHLT,
      ...Object.values(KK.PERIODEN_NAME), ...Object.values(KK.GELTUNG_WORT), ...Object.values(KK.FEHLT_WORT),
    );
    return out;
  };

  /** Die sichtbaren Texte der Flächen selbst (Quelltext, ohne Kommentare und Code). */
  const flaechenTexte = (): Array<{ wo: string; text: string }> =>
    FLAECHEN.flatMap((rel) => visibleTexts(readFileSync(join(SRC, rel), 'utf8')).map((text) => ({ wo: rel, text })));

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    const alle = laufzeit();
    expect(alle.length).toBeGreaterThan(150);
    expect(alle).toContain('Menge je Bezugsgröße · MS-12 je BZ-6 · Fassung 1 gilt seit Beginn');
    expect(alle).toContain('Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.');
    expect(flaechenTexte().length).toBeGreaterThan(5);
  });

  it('kein Satz der Welt trägt ein verbotenes oder Werkstatt-Wort', () => {
    const violations = [...laufzeit(), ...flaechenTexte().map((t) => t.text)].flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN].flatMap(({ re, why }) => (re.test(ohneAusnahmen(text)) ? [`„${text}“ — ${why}`] : [])),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('in der ganzen Kundensicht nie KPI, Metrik, Kenngröße, Dashboard, Widget oder Template', () => {
    const violations: string[] = [];
    for (const file of customerFiles()) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      // Der Vertrags-Zwilling trägt die Liste der verbotenen Wörter selbst (`VERBOTENE_WOERTER`) — sie ist kein Kundensatz.
      if (rel === 'uemsKennzahl.ts') continue;
      // Suchwörter der Hilfe sind keine Kundensätze (derselbe Schnitt wie im Werkstatt-Wächter oben).
      for (const text of visibleTexts(readFileSync(file, 'utf8').replace(HILFE_SUCHWOERTER, ' '))) {
        if (isKundentext(text) && KUNDENSICHT_VERBOTEN.test(text)) violations.push(`${rel}: „${text.trim().slice(0, 80)}“`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('auf den Kennzahl-Flächen nie Durchschnitt oder Mittel (Q5) — und nie Zähler oder Nenner als Rolle', () => {
    const texte = [...laufzeit(), ...flaechenTexte().map((t) => t.text)];
    expect(texte.filter((t) => MITTEL_VERBOTEN.test(t))).toEqual([]);
    expect(texte.filter((t) => ROLLEN_VERBOTEN.test(t))).toEqual([]);
  });

  it('„Kennzahl“ steht nur auf Kennzahl-Flächen und in der Navigation', () => {
    // Die Wörter-Quellen (Glossar, Vertrags-Zwilling) und die Navigation dürfen es; jede ANDERE Kundenfläche nicht.
    const erlaubt = new Set([...FLAECHEN, 'nav.ts', 'ebenenNav.ts', 'glossar.ts', 'uemsKennzahl.ts', 'test/kennzahlWerteFixtures.ts', 'test/kennzahlAendernFixtures.ts', 'test/korrekturFixtures.ts']);
    const treffer = new Set<string>();
    for (const file of customerFiles()) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (erlaubt.has(rel)) continue;
      const texte = visibleTexts(readFileSync(file, 'utf8')).filter((t) => isKundentext(t) && /Kennzahl/.test(t));
      if (texte.length > 0) treffer.add(rel);
    }
    expect([...treffer].sort()).toEqual(KENNZAHL_BESTAND);
  });

  it('die Wörter kommen aus dem Glossar: „Kennzahlen“, „Berechnung“, „Menge je Bezugsgröße“', () => {
    expect(KK.TITEL).toBe(UEMS_KENNZAHLEN);
    expect(KK.KARTE_BERECHNUNG).toBe(UEMS_BERECHNUNG);
    expect(UEMS_RECHENFORM.quotient).toBe(`${UEMS_MENGE} je ${UEMS_BEZUGSGROESSE}`);
    expect(UEMS_RECHENFORM).toEqual({ quotient: 'Menge je Bezugsgröße', anteil: 'Teil an Ganzem', zusammenfassung: 'Kennzahlen zusammenfassen' });
  });

  it('die Flächen und ihr Modul stehen im Bestand des Wächters', () => {
    const dateien = customerFiles().map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    for (const rel of FLAECHEN) expect(dateien).toContain(rel);
  });

  /**
   * AP-11 IP-10: der Vorlagen-Katalog ist ein Kundentext-Wohnort (die Karten des Assistenten: Name, Zweck, Hilfesatz und
   * der Satz jeder Erwartung) — er liegt als JSON und wird vom Datei-Walker nicht erfasst. `_comment` ist Entwickler-Doku.
   */
  it('die Kennzahl-Vorlagen sprechen dasselbe Wörterbuch (§4.13)', () => {
    const katalog = JSON.parse(readFileSync(join(SRC, 'kennzahlen/kennzahl-vorlagen.json'), 'utf8')) as {
      vorlagen: { kennung: string; name_vorschlag: string; zweck_vorschlag: string; hilfesatz: string; zaehler_erwartung: { satz: string }; nenner_erwartung: { satz: string } }[];
    };
    expect(katalog.vorlagen.length).toBe(8);
    const texte = katalog.vorlagen.flatMap((v) =>
      [v.name_vorschlag, v.zweck_vorschlag, v.hilfesatz, v.zaehler_erwartung.satz, v.nenner_erwartung.satz].map((text) => ({
        wo: v.kennung,
        text: text.split('{Geltungsbereich}').join('Halle 2'),
      })),
    );
    const violations: string[] = [];
    for (const { wo, text } of texte) {
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN]) {
        if (re.test(ohneAusnahmen(text))) violations.push(`${wo}: „${text}“ — ${why}`);
      }
      for (const re of [KUNDENSICHT_VERBOTEN, MITTEL_VERBOTEN, ROLLEN_VERBOTEN]) {
        if (re.test(text)) violations.push(`${wo}: „${text}“ — §4.13`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('beißt wirklich — und nicht die Kundenwörter', () => {
    for (const falsch of ['KPI Halle 2', 'Kenngröße anlegen', 'Durchschnitt je Stück', 'Mittelwert der Gebäude', 'Zähler je Nenner']) {
      expect([KUNDENSICHT_VERBOTEN, MITTEL_VERBOTEN, ROLLEN_VERBOTEN].some((re) => re.test(falsch)), falsch).toBe(true);
    }
    for (const richtig of ['Kennzahlen zusammenfassen', 'gewichtet (Summe ÷ Summe)', 'Mittelspannung', 'Zählerstand', 'Menge je Bezugsgröße']) {
      expect([KUNDENSICHT_VERBOTEN, MITTEL_VERBOTEN, ROLLEN_VERBOTEN].some((re) => re.test(richtig)), richtig).toBe(false);
    }
  });
});

/**
 * UEMS AP-12 IP-13 — die Welt „Berichte“ spricht die Wörter von §4.15 (E14 = A): Bericht · Berichtsvorlage · Entwurf ·
 * Berichtsstand Nr. n · Revision · Datenstand · Quellenverzeichnis. Ein freigegebener Stand ist nie „Version“,
 * „Ausgabe“, „Snapshot“ oder „Report“ („Version“ gehört dem Wert); „Entwurf“ steht unqualifiziert nur in dieser Welt,
 * anderswo heißt der Entwurf eines Berichts „Berichtsentwurf“ (W7). Gelesen werden die Quelltexte der Flächen UND die
 * Sätze, die sie zur Laufzeit aus den Vektor-Fixtures bilden (B1 Nr. 1/Nr. 2, B10, B16).
 */
describe('UEMS AP-12 IP-13 · die Welt „Berichte“ spricht Bericht · Entwurf · Berichtsstand Nr. n · Datenstand (E14)', () => {
  // AP-12 IP-14: die Dialoge Anlegen, Freigeben, Vergleich und Verwerfen gehören zur Welt.
  const FLAECHEN = [
    'berichtSeite.ts',
    'pages/BerichtePage.tsx',
    'pages/BerichtSeite.tsx',
    'berichtDialoge.ts',
    'components/BerichtAnlegenDialog.tsx',
    'components/BerichtFreigebenDialog.tsx',
    'components/BerichtVergleichDialog.tsx',
    'components/AnstossVerwerfenDialog.tsx',
  ];
  const VERSION_AM_STAND = /(Berichtsstand|Bericht)\s+Version|Version\s+(des|eines)\s+Berichts?|Berichtsversion/u;
  const da = (t: string | null | undefined): t is string => typeof t === 'string';

  const laufzeit = (): string[] => {
    const out: string[] = [];
    const tage = ['2026-11-10T09:00:00+01:00', '2026-11-13T09:00:00+01:00', '2026-11-20T09:00:00+01:00', '2026-12-03T09:00:00+01:00'];
    for (const tag of tage) {
      const jetzt = Date.parse(tag);
      const detail = detailAm(jetzt);
      const karte = BS.listenKarte(berichtAm(jetzt));
      out.push(karte.kennung, karte.titel, karte.unter, ...[karte.stand, karte.archiviert].filter(da));
      out.push(...BS.standWahl(detail).optionen.map((o) => o.label));
      const ansichten: BS.Ansicht[] = [
        { art: 'entwurf', entwurf: entwurfAm(jetzt) },
        ...detail.staende.map((s): BS.Ansicht => ({ art: 'stand', stand: standAm(s.nr, jetzt) })),
      ];
      for (const a of ansichten) {
        const k = BS.seitenKopf(detail, a, jetzt);
        out.push(k.titel, k.vorlage, k.zeile, ...k.abzeichen.map((x) => x.text), ...[k.teilansicht].filter(da));
        const abzug = BS.abzugAus(a.art === 'stand' ? a.stand.abzug : a.entwurf.abzug);
        const heuteName = (kz: string) => nameHeuteAm(jetzt, kz, null);
        for (const teil of BS.abschnitte(abzug, heuteName).abschnitte) {
          out.push(teil.titel);
          if (teil.art === 'kopf' || teil.art === 'qualitaet') out.push(...teil.zeilen.flatMap((z) => [z.name, z.wert]));
          if (teil.art === 'kopf') out.push(teil.anzahl);
          if (teil.art === 'qualitaet') out.push(...teil.korrekturen);
          if (teil.art === 'zusammenfassung') out.push(...teil.kacheln.flatMap((z) => [z.name, z.wert]), ...[teil.zaehlung].filter(da));
          if (teil.art === 'messstellen') out.push(...teil.vergleiche);
          if (teil.art === 'kennzahlen') out.push(...[teil.leer].filter(da));
          if (teil.art === 'tagesverlauf') {
            out.push(...[teil.leer].filter(da));
            for (const z of teil.zeilen) {
              out.push(z.name, ...[z.leer].filter(da));
              out.push(...z.tage.flatMap((t) => [t.label, t.mengeText, t.zustand]));
            }
          }
          if (teil.art === 'messstellen' || teil.art === 'kennzahlen') {
            for (const z of teil.zeilen) {
              out.push(z.name, z.zahl, z.zustand, z.version, ...z.kennzeichenSaetze, ...z.nachweis.herkunft, ...[z.heute].filter(da));
              out.push(z.nachweis.karte.titel, ...[z.nachweis.karte.fassung, z.nachweis.karte.abdeckung].filter(da));
            }
          }
          if (teil.art === 'quellen') out.push(teil.anzahl, ...teil.zeilen.flatMap((q) => [q.name, q.stand, q.heute].filter(da)));
        }
        if (a.art === 'stand') {
          const b = berichtAm(jetzt);
          out.push(BS.heutigerWert({ antwort: heutigeWerteAm('MS-12', jetzt) }, b, a.stand).text);
        }
      }
      for (const v of BS.verlaufDerStaende(detail)) out.push(v.titel, v.zeile, ...[v.anlass, v.ersetzt].filter(da), ...v.anstoesse);
    }
    const spaet = Date.parse('2036-11-02T10:00:00+01:00');
    try {
      heutigeWerteAm('MS-12', spaet);
    } catch (fehler) {
      out.push(BS.heutigerWert({ fehler }, berichtAm(spaet), standAm(1, spaet)).text);
    }
    out.push(
      BS.TITEL, BS.LADEN, BS.LADEFEHLER, BS.LADEFEHLER_SEITE, BS.LADEFEHLER_STAND, BS.LEER, BS.NICHT_GEFUNDEN, BS.ZUR_LISTE,
      BS.ARCHIVIERT, BS.STAND_WAHL, BS.KEIN_STAND, BS.NEU_GEBILDET, BS.PRUEFSUMME_GEPRUEFT, BS.VERLAUF_TITEL, BS.NACHWEIS,
      BS.HEUTIGEN_WERT, BS.HEUTIGER_WERT_LAEDT, BS.HEUTIGER_WERT_FEHLER, BS.KEINE_KENNZAHLEN,
      BS.KEIN_TAGESVERLAUF, BS.RICHTUNGSPAAR_FEHLT, ...Object.values(BS.MENGE_ART_WORT),
      ...BS.ZUSAMMENFASSUNG.map(([, name]) => name), ...Object.values(BS.VERGLEICH_WORT), ...Object.values(BS.GELTUNG_WORT),
      ...Object.values(BS.KOPF_WORT), ...Object.values(BS.QUALITAET_WORT),
    );
    return out;
  };

  const flaechenTexte = (): Array<{ wo: string; text: string }> =>
    FLAECHEN.flatMap((rel) => visibleTexts(readFileSync(join(SRC, rel), 'utf8')).map((text) => ({ wo: rel, text })));

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    const alle = laufzeit();
    expect(alle.length).toBeGreaterThan(300);
    expect(alle).toContain('Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von Ines Kaltenbach');
    expect(alle).toContain('Revision nötig — Korrektur K-2026-0007');
    expect(alle).toContain('heute: Montage Linie M1 (Halle 2)');
    expect(alle).toContain('Tagesverlauf je Messstelle');
    expect(alle).toContain('In diesem Berichtsstand sind keine Tageswerte gespeichert.');
    expect(alle).toContain('Laden');
    expect(alle).toContain('Entladen');
    expect(alle).toContain('Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.');
    expect(flaechenTexte().length).toBeGreaterThan(3);
  });

  it('kein Satz der Welt trägt ein verbotenes oder Werkstatt-Wort', () => {
    const violations = [...laufzeit(), ...flaechenTexte().map((t) => t.text)].flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN].flatMap(({ re, why }) => (re.test(ohneAusnahmen(text)) ? [`„${text}“ — ${why}`] : [])),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('ein Berichtsstand ist nie „Version“, „Ausgabe“, „Snapshot“ oder „Report“ (§4.15, `VERBOTENE_WOERTER` des Vertrags)', () => {
    const texte = [...laufzeit(), ...flaechenTexte().map((t) => t.text)];
    expect(texte.filter((t) => BERICHT_VERBOTEN.some((w) => t.includes(w)))).toEqual([]);
    expect(texte.filter((t) => VERSION_AM_STAND.test(t))).toEqual([]);
  });

  it('„Entwurf“ steht unqualifiziert nur in dieser Welt — anderswo heißt der Entwurf eines Berichts „Berichtsentwurf“ (W7)', () => {
    const violations: string[] = [];
    for (const file of customerFiles()) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (FLAECHEN.includes(rel) || rel === 'uemsBericht.ts' || rel === 'glossar.ts') continue;
      for (const text of visibleTexts(readFileSync(file, 'utf8'))) {
        if (isKundentext(text) && /Bericht/u.test(text) && /(^|[^\p{L}])Entwurf/u.test(text)) violations.push(`${rel}: „${text.trim().slice(0, 80)}“`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('die Wörter kommen aus dem Glossar: Berichte, Berichtsstand, Entwurf, Datenstand, Prüfsumme, Quellenverzeichnis', () => {
    expect(BS.TITEL).toBe(UEMS_BERICHTE);
    expect(BS.STAND_WAHL).toBe(UEMS_BERICHTSSTAND);
    expect(BS.KEIN_STAND).toContain(UEMS_BERICHTSSTAND);
    expect(BS.PRUEFSUMME_GEPRUEFT).toContain(UEMS_PRUEFSUMME);
    expect(BS.KOPF_WORT.datenstand).toBe(UEMS_DATENSTAND);
    expect(BS.standWahl(detailAm(Date.parse('2026-11-20T09:00:00+01:00'))).optionen.at(-1)?.label).toBe(UEMS_ENTWURF);
    const quellen = BS.abschnitte(BS.abzugAus(standAm(1, Date.parse('2026-11-20T09:00:00+01:00')).abzug)).abschnitte.find((a) => a.art === 'quellen');
    expect(quellen?.titel).toBe(UEMS_QUELLENVERZEICHNIS);
  });

  it('die Flächen und ihr Modul stehen im Bestand des Wächters', () => {
    const dateien = customerFiles().map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    for (const rel of FLAECHEN) expect(dateien).toContain(rel);
  });

  it('beißt wirklich — und nicht die Kundenwörter', () => {
    for (const falsch of ['Version des Berichts', 'Berichtsstand Version 2', 'Berichtsversion 1']) expect(VERSION_AM_STAND.test(falsch), falsch).toBe(true);
    for (const richtig of ['Berichtsstand Nr. 2', 'Version 2 · endgültig ab 08.11.2026', 'korrigiert (Version 2)']) expect(VERSION_AM_STAND.test(richtig), richtig).toBe(false);
  });
});

/**
 * Kundenflächen, die „Kennzahl“ HEUTE schon außerhalb der Welt sagen — benannt, damit jede neue Stelle rot wird.
 * Wer eine davon umbenennt (IP-14: „3 · Kennzahl“ der Eigenen Auswertung wird „3 · Zeitbezug“), streicht sie hier.
 */
// Sortiert wie der Vergleich. „alt“ = das ALTE Wort (AP-11 W7, Kachel oder Aggregat — umzubenennen, die Eigene
// Auswertung mit IP-14); „neu“ = das NEUE Objekt, von einer Nachbarfläche aus genannt.
const KENNZAHL_BESTAND: string[] = [
  'berichtDialoge.ts', // neu: „Bericht anlegen“ wählt Kennzahlen ab (AP-12 IP-14, V3)
  'berichtSeite.ts', // neu: die Welt „Berichte“ zitiert Kennzahlen (Abschnitt der Vorlage, AP-12 IP-13)
  'bezugsgroesse.ts', // neu: die Ablehnung „Flächen pflegen Sie am Gebäude …“ nennt den Weg zum Kennzahl-Nenner
  'bezugsgroesseListe.ts', // neu: AP-09 erklärt Zweck und Archivfolgen
  'components/BezugsdatenImportProtokollDialog.tsx', // neu: AP-09 nennt die Folgen einer Import-Rücknahme
  'components/MarktpreiseMobil.tsx', // alt
  'components/PortfolioCockpit.tsx', // alt
  'components/VerlaufExplorer.tsx', // alt
  'components/WidgetGrid.tsx', // alt
  'flaecheAendern.ts', // neu: eine Flächenänderung wirkt auf Kennzahlen
  'help/content/alltag.ts', // alt
  'ortArchiv.ts', // neu: ein Ort mit Kennzahlen wird nicht gelöscht
  'pages/BezugsgroessenPage.tsx', // neu: AP-09 Kennzahl-Nenner
  'pages/DataPages.tsx', // alt
  'portfolioCockpit.ts', // alt
  'test/kennzahlAnlegenFixtures.ts', // neu: die Fixture spiegelt genau diese Ablehnung
  'uemsBericht.ts', // neu: der Bericht-Zwilling (AP-12)
  'uemsEreignis.ts', // neu: „Berechnung einer Kennzahl rückwirkend geändert“ im Änderungsprotokoll
];

/**
 * UEMS AP-13 IP-1 — die Welt „Oberflächen“ spricht die Wörter von §4.14 (E15 = A): Werte · Verlauf · Vergleich ·
 * Energiebilanz · Datenlage · liefert Daten · Verlauf n % · Herkunft · Nachweis · Zeitraum · Zeitzone. Verboten sind die
 * Wörter der Analyse-Werkzeuge; „Abdeckung“ bleibt ein Wort der Bestandsflächen (W7) — `ABDECKUNG_BESTAND` nennt sie,
 * jede NEUE Stelle wird rot. Gelesen werden die Quelltexte der Flächen (heute das reine Modul; IP-2 … IP-13 tragen ihre
 * Dateien in `FLAECHEN` ein), die Sätze, die das Modul zur Laufzeit bildet, die acht Grund-Sätze und die Glossar-Wörter.
 */
const OBERFLAECHEN_VERBOTEN = new RegExp(
  '(^|[^\\p{L}])(Dashboards?|Widgets?|KPIs?|Drilldowns?|Timelines?|Sankey|Charts?|Zeitreihen?|Rollups?|Buckets?|Raster|Provenienz|Aggregat(?:e|en)?|Snapshots?)([^\\p{L}]|$)',
  'u',
);
const BILANZ_URSACHE_VERBOTEN = /(^|[^\p{L}])(Verlust(?:e|en)?|Schwund)([^\p{L}]|$)/iu;

/** Kundenflächen, die „Abdeckung“ HEUTE sagen (Bestand, W7) — sortiert wie der Vergleich. Eine neue Stelle wird rot. */
const ABDECKUNG_BESTAND: string[] = [
  'berichtSeite.ts', // UEMS AP-12 IP-13: „Abdeckung (geringste)“ im Kopf des Berichts — gebaut vor E15, W7-Befund an AP-12
  'help/content/alltag.ts', // Handbuch: „Prüfen Sie Verbindung und Abdeckung“ (Bestand)
  'marktpreise.ts', // Marktpreise-Rückblick: Zeile „Abdeckung“ der gesammelten Preise (Bestand)
];

/**
 * Die Diagramm-Dateien der Oberflächen. Wer eine einhängt, trägt sie HIER ein: IP-4 (Verlauf je Messstelle mit seiner
 * reinen Regel, Kennzahl-Balken samt Ableitung — der offene Punkt aus AP-11), IP-5 (Vergleich als Überlagerung), IP-8
 * (Anteils-Balken der Energiebilanz). Es gelten die Chart-Regeln des Bestands (`CHART_FORBIDDEN`, `BARE_UNIT_AXIS`) UND
 * die Verbote dieser Welt.
 */
const CHART_FILES_OBERFLAECHEN: string[] = [
  // AP-13 IP-4 (= AP-08 IP-10): der Verlauf einer Messstelle — Render und Regel gleichberechtigt, wie beim Tagesbild.
  'components/MessstellenVerlauf.tsx',
  'uemsVerlauf.ts',
  // AP-13 IP-5: der Vergleich legt die zweite Reihe in DASSELBE Bild — reines Modul und Render gehören dazu.
  'uemsVergleich.ts',
  'components/WerteVergleich.tsx',
  // AP-11 IP-13: der Kennzahl-Balken (Funktion `Verlauf` der Kennzahl-Seite) und seine Ableitung `kennzahlKarte.verlauf`.
  'pages/KennzahlSeite.tsx',
  'kennzahlKarte.ts',
  // AP-13 IP-8: die Anteils-Balken der Energiebilanz (kWh je Unterzähler, keine Prozentzahl) — Render und Ableitung.
  'pages/EnergiebilanzSection.tsx',
  'anlageEnergiebilanz.ts',
];

describe('UEMS AP-13 IP-1 · die Welt „Oberflächen“ spricht Werte · Verlauf · Vergleich · Energiebilanz · Datenlage (E15)', () => {
  // AP-13 IP-3: der Abschnitt „Werte“ (Sektion und ihre reine Ableitung).
  // AP-13 IP-7: die Übersichts-Bausteine je Ebene (reines Modul und Render).
  const FLAECHEN = [
    'uemsOberflaechen.ts',
    'uemsWerteKarte.ts',
    'components/WerteSektion.tsx',
    'uemsVerlauf.ts',
    'components/MessstellenVerlauf.tsx',
    // AP-13 IP-5: der Vergleich (reines Modul und Render).
    'uemsVergleich.ts',
    'components/WerteVergleich.tsx',
    'uebersichtBausteine.ts',
    'components/UebersichtBausteine.tsx',
    // AP-13 IP-8: die Energiebilanz je Anlage (reines Modul und Render).
    'anlageEnergiebilanz.ts',
    'pages/EnergiebilanzSection.tsx',
    'netzanschlussListe.ts',
    'pages/StandortNetzanschluessePage.tsx',
    'components/NetzanschlussDialog.tsx',
    'components/NetzanschlussBilanzKopf.tsx',
    // AP-13 IP-9: Kostenstellen und Prozesse nebeneinander (reines Modul und Render).
    'kostenstellenUebersicht.ts',
    'pages/KostenstellenSection.tsx',
    // AP-13 IP-10: die Gebäude-Karte (reines Modul und Render).
    'gebaeudeKarte.ts',
    'components/GebaeudeKarte.tsx',
  ];
  const vertrag = JSON.parse(readFileSync(join(process.cwd(), '../../docs/contracts/v2/ergebnis-zustand-vectors.json'), 'utf8'));
  const faelle = JSON.parse(readFileSync(join(SRC, 'test/oberflaechenFaelle.json'), 'utf8'));
  const rel = (file: string) => file.slice(SRC.length + 1).replace(/\\/g, '/');

  const flaechenTexte = (): Array<{ wo: string; text: string }> =>
    FLAECHEN.flatMap((datei) =>
      visibleTexts(readFileSync(join(SRC, datei), 'utf8'))
        .filter(isKundentext)
        .map((text) => ({ wo: datei, text })),
    );

  const laufzeit = (): Array<{ wo: string; text: string }> => {
    const out: Array<{ wo: string; text: string }> = [];
    const ohnePlatz = (t: string) => t.replace(/\{[a-z_]+\}/g, 'X');
    for (const g of GRUENDE) out.push({ wo: `Grund ${g.code}`, text: ohnePlatz(g.muster) });
    for (const g of vertrag.grund.saetze) out.push({ wo: `Grund-Beispiel ${g.code}`, text: g.beispiel });
    const basis = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' };
    for (const andere of [
      { ...basis, groesse: 'Volumen', einheit: 'm³' },
      { ...basis, richtung: 'Laden / Entladen' },
      { ...basis, einheit: 'MWh' },
      { ...basis, wertart: 'Intervallmenge' },
    ]) {
      out.push({ wo: 'passend', text: OF.passendSatz(OF.passend(basis, andere)) ?? '' });
    }
    out.push({ wo: 'Zone', text: OF.zoneSatz('Europe/Berlin', 'standort', 'Werk Ahrenberg') });
    out.push({ wo: 'Zone', text: OF.zoneSatz('Europe/Vienna', 'unternehmen') });
    out.push({ wo: 'Zone', text: OF.zoneSatz('Europe/Zurich', 'vorgabe') });
    // AP-13 IP-3: der Hinweis zur Version der Adresse, beide Formen.
    out.push({ wo: 'Version', text: VERSION_NEUESTE.replace('{n}', '2') });
    out.push({ wo: 'Version', text: VERSION_FRUEHERE.replace('{n}', '1').replace('{neueste}', '2') });
    for (const w of [UEMS_WERTE, UEMS_VERLAUF, UEMS_VERLAUF_PROZENT, UEMS_ENERGIEBILANZ, UEMS_DATENLAGE, UEMS_NICHT_VERORTET, UEMS_MANUELL_ABGELESEN]) {
      out.push({ wo: 'Glossar', text: w });
    }
    // AP-13 IP-4: der Verlauf — Zeiträume, Lücken- und Ereignis-Sätze, erhalten/erwartet, die Schritt-Wahl, die Woche.
    for (const w of Object.values(UEMS_ZEITRAEUME)) out.push({ wo: 'Verlauf', text: w });
    for (const t of [
      UEMS_KEINE_WERTE_VON_BIS,
      UEMS_KEINE_WERTE_AM,
      UEMS_KEINE_WERTE_IM,
      UEMS_EREIGNIS_VON_BIS,
      UEMS_EREIGNIS_SEIT,
      UEMS_EREIGNIS_AM,
      UEMS_ERHALTEN.singular,
      UEMS_ERHALTEN.plural,
      UEMS_WOCHE_OHNE_ZAHL,
      UEMS_VERLAUF_EREIGNISSE,
      ...Object.values(UEMS_VERLAUF_WAHL).flatMap((w) => Object.values(w)),
    ]) {
      out.push({ wo: 'Verlauf', text: ohnePlatz(t) });
    }
    out.push({ wo: 'Verlauf', text: VL.markerSatz({ art: 'handover', von: '2026-11-04T09:38:00+01:00', bis: '2026-11-04T09:40:00+01:00' }, 'Europe/Berlin') ?? '' });
    // AP-13 IP-5: der Umschalter, die Δ-Zeile in allen Formen, die Gründe und die Sätze der Leiste.
    for (const o of VG.wahlOptionen('monat')) out.push({ wo: 'Vergleich', text: o.label });
    for (const [z, w] of [['tag', '2026-11-03'], ['woche', '2026-W45'], ['monat', '2026-10'], ['jahr', '2025']] as const) {
      out.push({ wo: 'Vergleich', text: VG.periodeTitel(z, w) });
    }
    for (const g of GRUENDE_OHNE_VERGLEICH) out.push({ wo: `Vergleich ${g}`, text: VG.grundSatz(g) ?? '' });
    out.push({ wo: 'Vergleich', text: VG.grundSatz('vor_bestehen', '2026-10-01') ?? '' });
    out.push({ wo: 'Vergleich', text: VG.laufendSatz('monat', '2026-11', '2026-11-20') ?? '' });
    out.push({ wo: 'Vergleich', text: VG.WOCHE_OHNE_DELTA });
    out.push({ wo: 'Vergleich', text: VG.VOLL_SATZ });
    out.push({ wo: 'Vergleich', text: VG.entfernenName({ id: 'x', kennzeichen: 'MS-11', name: 'Spritzguss SG07–SG10' }) });
    for (const t of [UEMS_VERGLEICH, UEMS_VERGLEICH_KEIN_DELTA, UEMS_VERGLEICH_NUR_EINE_REIHE, UEMS_VERGLEICH_WEITERE, UEMS_VERGLEICH_NICHT_ABRUFBAR]) {
      out.push({ wo: 'Vergleich', text: t });
    }
    for (const d of [
      VG.delta({ zeitraum: 'monat', aktuell: ms12November(), vergleich: ms12Oktober(), periode: '2026-10', bestehen: { seit: '2026-10-01', beendet: null } }),
      VG.delta({ zeitraum: 'monat', aktuell: ms12November(), vergleich: ms12Vorjahr(), periode: '2025-11', bestehen: { seit: '2026-10-01', beendet: null } }),
    ]) {
      for (const t of [d?.satz, d?.ohne]) if (t) out.push({ wo: 'Vergleich Δ', text: t });
    }
    // AP-13 IP-6: die Sätze der Ablehnungen je Grund und Feld, die Auskünfte, die Leerzustände und die Nebengrößen.
    for (const g of OF.ABLEHNUNG_GRUENDE) {
      for (const feld of ['von', 'bis', 'raster', 'version']) out.push({ wo: `Ablehnung ${g}`, text: OF.ablehnungSatz(g, feld, 'tag') });
    }
    const keinePassende = OF.vergleichOhnePassende(basis, []);
    for (const t of [
      OF.ZEITRAUM_UNLESBAR_OHNE_GRUND,
      OF.MESSSTELLE_GIBT_ES_NICHT,
      OF.WERT_NICHT_MEHR_GESPEICHERT,
      OF.WERTE_NICHT_ABRUFBAR,
      OF.VERLAUF_NICHT_ABRUFBAR,
      OF.OHNE_HAUPTZAEHLER.titel,
      OF.OHNE_HAUPTZAEHLER.satz,
      OF.OHNE_HAUPTZAEHLER.schritt ?? '',
      keinePassende?.titel ?? '',
      keinePassende?.satz ?? '',
    ]) {
      out.push({ wo: 'Auskunft', text: t });
    }
    for (const t of [QUELLE_GILT_SEIT, QUELLE_GILT_AB, QUELLE_AB_ZEIGEN, QUELLE_ZUORDNEN, QUELLE_OHNE_RECHT, DIE_DATENQUELLE, NEBENGROESSEN_TITEL, NEBENGROESSEN_SATZ]) {
      out.push({ wo: 'Werte', text: ohnePlatz(t) });
    }
    // AP-13 IP-8: die Wörter der Energiebilanz und alles, was sie an O5/O6/O7/O8 und im Vorschlag wirklich sagt.
    for (const t of [
      ...Object.values(EB.ZEILE_WORT),
      ...Object.values(EB.ANTEIL_WORT).filter((w): w is string => w !== null),
      ...Object.values(EB.LIVE_GRUND),
      EB.UNTERZAEHLER_ANZAHL,
      ...Object.values(EB.MESSSTELLEN_ANZAHL),
      EB.KEIN_UNTERZAEHLER,
      EB.HILFE_NEGATIV,
      EB.LIVE_JETZT,
      EB.LIVE_OHNE_ZAHL,
      EB.LIVE_STAND,
      EB.ZONE_SATZ,
      EB.STELLUNG_GEAENDERT,
      EB.HERKUNFT,
      EB.HERKUNFT_EINGAENGE,
      EB.HERKUNFT_FORMEL,
      EB.HERKUNFT_FASSUNG,
      EB.HERKUNFT_BERECHNET_AM,
      EB.HERKUNFT_VERSION,
      EB.HERKUNFT_KORRIGIERT,
      EB.HERKUNFT_ERSATZWERT,
      EB.HERKUNFT_VERTEILT,
      EB.HERKUNFT_UNVOLLSTAENDIG,
      EB.REST_VORSCHLAG,
      EB.REST_ANLEGEN,
      EB.REST_OHNE_RECHT,
      EB.REST_ANGELEGT,
      EB.REST_GAB_ES_SCHON,
      EB.REST_NICHT_ANGELEGT,
      EB.REST_OHNE_HAUPTZAEHLER_SATZ,
    ]) {
      out.push({ wo: 'Energiebilanz', text: ohnePlatz(t) });
    }
    const ctxEB = { heute: '2026-11-05', arten: new Map<string, EB.MessstellenArt>([['MS-10', 'gemessen']]) };
    for (const [siteId, periode, am, b] of [
      [FIXTURE_IDS.an2, 'monat', '2026-10-01', { restVorschlag: true }],
      [FIXTURE_IDS.an1, 'monat', '2026-10-01', {}],
      [FIXTURE_IDS.an2, 'tag', '2026-11-04', { live: 'veraltet' }],
    ] as const) {
      const bild = EB.energiebilanzBild(ahrenbergBilanz(siteId, periode, am, b), ctxEB);
      const texte = [bild.zeitraum, bild.zone, ...bild.hauptzaehler.flatMap((h) => [h.titel, h.live.text, h.vorschlag?.satz ?? '', ...h.abschnitte.flatMap((ab) => ab.tage.flatMap((tag) => tag.zeilen.flatMap((z) => [z.wort, z.zahl, z.zusatz ?? '', ...z.woerter, ...z.saetze, ...z.herkunft.zeilen, ...z.herkunft.eingaenge, ...z.teile.flatMap((x) => [x.name, ...x.woerter])])))])];
      for (const text of texte.filter(Boolean)) out.push({ wo: `Energiebilanz ${periode} ${am}`, text });
    }
    return out;
  };

  it('liest wirklich: die Flächen stehen im Bestand des Wächters, und die Sätze sind da', () => {
    const dateien = customerFiles().map(rel);
    for (const datei of FLAECHEN) expect(dateien).toContain(datei);
    expect(flaechenTexte().length).toBeGreaterThan(3);
    expect(laufzeit().length).toBeGreaterThan(25);
  });

  it('kein Satz der Welt trägt ein verbotenes, internes oder Werkstatt-Wort', () => {
    const violations: string[] = [];
    for (const { wo, text } of [...flaechenTexte(), ...laufzeit()]) {
      const m = OBERFLAECHEN_VERBOTEN.exec(text);
      if (m) violations.push(`${wo}: „${m[2]}“ in „${text}“ — E15: verboten auf den Oberflächen`);
      for (const { re, why } of [...FORBIDDEN, ...FORBIDDEN_INTERN]) {
        if (re.test(ohneAusnahmen(text))) violations.push(`${wo}: „${text}“ — ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('die Energiebilanz behauptet weder Verlust noch Schwund als Ursache', () => {
    const texte = [
      ...flaechenTexte().filter(({ wo }) => wo === 'anlageEnergiebilanz.ts' || wo === 'pages/EnergiebilanzSection.tsx'),
      ...laufzeit().filter(({ wo }) => wo.startsWith('Energiebilanz')),
    ];
    expect(texte.length).toBeGreaterThan(20);
    expect(
      texte.filter(({ text }) => BILANZ_URSACHE_VERBOTEN.test(text)).map(({ wo, text }) => `${wo}: ${text}`),
    ).toEqual([]);
    expect(BILANZ_URSACHE_VERBOTEN.test('10 kWh Verlust')).toBe(true);
    expect(BILANZ_URSACHE_VERBOTEN.test('Schwund: 10 kWh')).toBe(true);
  });

  it('„Abdeckung“ steht nur auf den Flächen des Bestands — die Oberflächen sagen „Verlauf n %“ (W7)', () => {
    const heute = customerFiles()
      .filter((file) => visibleTexts(readFileSync(file, 'utf8')).some((text) => isKundentext(text) && /Abdeckung/u.test(text)))
      .map(rel)
      .sort();
    expect(heute).toEqual(ABDECKUNG_BESTAND);
    expect(laufzeit().filter(({ text }) => /Abdeckung/u.test(text))).toEqual([]);
    for (const datei of FLAECHEN) expect(ABDECKUNG_BESTAND).not.toContain(datei);
  });

  it('die Wörter kommen aus dem Glossar und stehen im Vokabular von E15', () => {
    const kundenwoerter = faelle.vokabulare['kundenwoerter (E15)'] as string[];
    for (const w of [UEMS_WERTE, UEMS_VERLAUF, UEMS_ENERGIEBILANZ, UEMS_DATENLAGE]) expect(kundenwoerter).toContain(w);
    expect(UEMS_VERLAUF_PROZENT).toBe(vertrag.satz.abdeckung);
    expect(UEMS_VERLAUF_PROZENT.startsWith(`${UEMS_VERLAUF} `)).toBe(true);
    for (const w of faelle.vokabulare['verboten (E15)'] as string[]) expect(OBERFLAECHEN_VERBOTEN.test(w), w).toBe(true);
  });

  it('die Chart-Liste der Oberflächen ist verdrahtet: jede Datei lesbar, nirgends doppelt, keine verbotene Beschriftung', () => {
    const violations: string[] = [];
    for (const datei of CHART_FILES_OBERFLAECHEN) {
      expect(CHART_FILES, datei).not.toContain(datei);
      const sichtbar = stripComments(readFileSync(join(SRC, datei), 'utf8'));
      for (const { re, why } of [...CHART_FORBIDDEN, { re: OBERFLAECHEN_VERBOTEN, why: 'E15: verboten auf den Oberflächen' }]) {
        const m = re.exec(sichtbar);
        if (m) violations.push(`${datei}: „${m[0]}“ — ${why}`);
      }
      if (BARE_UNIT_AXIS.test(sichtbar)) violations.push(`${datei}: K4 — die Einheit steht nie allein`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('beißt wirklich — und nicht die Kundenwörter', () => {
    for (const falsch of ['KPI-Übersicht', 'Zeitreihe MS-06', 'Raster Viertelstunde', 'Snapshot vom 10.11.2026', 'Drilldown', 'Aggregate je Standort']) {
      expect(OBERFLAECHEN_VERBOTEN.test(falsch), falsch).toBe(true);
    }
    for (const richtig of ['Verlauf 85 %', 'Werte', 'Energiebilanz', 'Datenlage: 15 von 16 Messstellen liefern Daten', 'Zeitraster', 'Zeiten in Europe/Berlin (Vorgabe)']) {
      expect(OBERFLAECHEN_VERBOTEN.test(richtig), richtig).toBe(false);
    }
  });
});

/**
 * UEMS AP-12 IP-14 — die Dialoge der Welt „Berichte“ (Anlegen, Freigeben, Vergleich, Verwerfen, Banner „Revision nötig“)
 * sprechen dieselben Wörter wie die Seite (E14): was `berichtDialoge.ts` zur Laufzeit sagt, entlang der Zeitachse der
 * Fixtures (20.10. läuft · 10.11. Nr. 1 · 13.11. Revision). Die Quelltexte der Dialoge liest der Abschnitt IP-13 (`FLAECHEN`).
 */
describe('UEMS AP-12 IP-14 · die Berichts-Dialoge sprechen Bericht · Entwurf · Berichtsstand Nr. n (E14)', () => {
  const da = (t: string | null | undefined): t is string => typeof t === 'string';
  const ZONE = 'Europe/Berlin';

  const laufzeit = (): string[] => {
    const out: string[] = [];
    for (const tag of ['2026-10-20T10:00:00+02:00', '2026-11-10T09:00:00+01:00', '2026-11-13T09:00:00+01:00']) {
      const jetzt = Date.parse(tag);
      const detail = detailAm(jetzt);
      const h = BD.seitenHebel(detail, entwurfAm(jetzt), BD.rechteAus(rechteSeed().me), jetzt);
      if (h.freigeben) {
        const v = h.freigeben.vorschau;
        out.push(h.freigeben.knopf, v.knopf, v.festgehalten, ...v.punkte.map((p) => p.text), ...[v.satz, v.ersetzt].filter(da));
      }
      if (h.vergleichen) out.push(h.vergleichen.knopf, BD.vergleichTitel(h.vergleichen.gegen), BD.keineAbweichung(h.vergleichen.gegen));
      const banner = BD.revisionBanner(detail);
      if (banner) out.push(banner.titel, banner.satz, ...banner.anstoesse.flatMap((a) => [a.zeile, a.text]), BD.verwerfenVorspann(banner.nr));
      for (const art of ['monat', 'jahr'] as const) {
        out.push(...BD.zeitraumWahlen(art, jetzt, ZONE).map((z) => z.label));
        out.push(BD.zeitraumVorschau(art, art === 'monat' ? '2026-10' : '2026', ZONE, jetzt).text);
      }
    }
    const revision = Date.parse('2026-11-13T09:00:00+01:00');
    const entwurf = BS.abzugAus(entwurfAm(revision).abzug);
    for (const z of BD.vergleichZeilen(vergleichAm(1, revision).abweichungen, entwurf)) {
      out.push(...[z.name, z.vorher, z.nachher, z.version, z.anlass, z.beleg].filter(da));
    }
    out.push(BD.unveraendert(entwurf, 3), BD.unveraendert(entwurf, 17), BD.abweichungenAnzahl(3), BD.abweichungenAnzahl(1));
    for (const k of BD.vorlageKarten(null, [])) out.push(k.name, k.abschnitte, k.fassung);
    out.push(...['', 'kurz', 'x'.repeat(501)].map(BD.begruendungFehler).filter(da));
    out.push(...Object.values(BD.anlegenPruefen({ vorlage: null, geltungId: null, zeitraum: null, abgewaehlt: [] })).filter(da));
    out.push(
      BD.ANLEGEN_KNOPF, BD.ANLEGEN_TITEL, BD.ANLEGEN, BD.ABBRECHEN, BD.SCHLIESSEN, BD.VORLAGE_TITEL, BD.GELTUNG_TITEL,
      BD.ZEITRAUM_TITEL, BD.KENNZAHLEN_TITEL, BD.KENNZAHLEN_HINWEIS, BD.KENNZAHLEN_KEINE, BD.KENNZAHLEN_LADEFEHLER,
      BD.ARCHIVIERTE_KENNZAHL, BD.VORAUSSETZUNGEN_TITEL, BD.LAEDT, BD.ERNEUT, BD.ENTWURF_LADEFEHLER, BD.ANLEGEN_LADEFEHLER,
      BD.ANLEGEN_FEHLER, BD.BERICHT_OEFFNEN, BD.KEINE_GELTUNG, BD.FREIGEBEN_TITEL, BD.FREIGEBEN_FEHLER, BD.ENTWURF_NEU_LADEN,
      BD.WAS_SIE_FREIGEBEN, BD.VERGLEICHEN, BD.VERGLEICH_QUELLE, BD.VERGLEICH_ENTWURF, BD.VERGLEICH_VERSION,
      BD.VERGLEICH_ANLASS, BD.VERGLEICH_LADEFEHLER, BD.VERWERFEN, BD.BEGRUENDUNG, BD.BEGRUENDUNG_HINWEIS,
      BD.BEGRUENDUNG_BEISPIEL, BD.VERWERFEN_FEHLER,
    );
    return out;
  };

  it('liest wirklich die Sätze (der Wächter ist verdrahtet)', () => {
    const alle = laufzeit();
    expect(alle.length).toBeGreaterThan(80);
    expect(alle).toContain('Revision nötig — Korrektur K-2026-0007');
    expect(alle).toContain('Entwurf aktuell (Datenstand 10.11.2026 08:55)');
    expect(alle).toContain('Der Oktober 2026 ist noch nicht zu Ende — ein Berichtsstand ist ab dem 08.11.2026 möglich (7 Tage nach Monatsende).');
    expect(alle).toContain('Korrektur K-2026-0007 (über die Formel)');
  });

  it('kein Satz der Dialoge trägt ein verbotenes oder Werkstatt-Wort', () => {
    const violations = laufzeit().flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN].flatMap(({ re, why }) => (re.test(ohneAusnahmen(text)) ? [`„${text}“ — ${why}`] : [])),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('ein Berichtsstand ist nie „Version“, „Ausgabe“, „Snapshot“ oder „Report“ — „Version“ steht nur am Wert (§4.15)', () => {
    const texte = laufzeit();
    expect(texte.filter((t) => BERICHT_VERBOTEN.some((w) => t.includes(w)))).toEqual([]);
    expect(texte.filter((t) => /(Berichtsstand|Bericht)\s+Version|Version\s+(des|eines)\s+Berichts?|Berichtsversion/u.test(t))).toEqual([]);
  });
});

/** H-9/E10: keine Alttexte mehr; technische Exportnamen bleiben kompatibel. */
describe('Summenwert: das eine Kundenwort', () => {
  const altwort = new RegExp(`\\b(?:${SUMMENWERT_VERBOTENE_WOERTER.map((w) => w === 'Gesamtwert' ? `${w}(?:e|en|s)?` : w).join('|')})\\b`);
  // AST statt Quelltext: JSX-Text vor einem Ausdruck und Template-Sätze werden vollständig erfasst.
  const texte = (code: string): string[] => {
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node)) {
        out.push(node.head.text + node.templateSpans.map((s) => ` ${s.literal.text}`).join(''));
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) out.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('surface.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    return out.filter((t) => !/^[./]/.test(t)).map((t) => t.trim().replace(/\s+/g, ' '));
  };
  // EXAKTER Satz, Datei und Höchstzahl. Entfernen ist erlaubt; neue/duplizierte Alttexte sind rot.
  const bestand: Record<string, number> = {};

  it('alle Summenwert-Flächen und ihr Hilfeartikel sprechen ohne Steuer- oder Geldwörter', () => {
    const FLAECHEN = [
      'components/SummenwertAssistent.tsx', 'components/GeraetSummenwerte.tsx',
      'components/RolleAendernDialog.tsx', 'components/SummenwertFormelDialog.tsx',
      'components/GesamtwertKarten.tsx', 'components/PvRollenBreakdown.tsx',
      'gesamtwert.ts', 'summenwertQuellen.ts', 'uemsRollen.ts', 'pvRolle.ts',
    ];
    for (const file of FLAECHEN) {
      for (const text of visibleTexts(readFileSync(join(SRC, file), 'utf8'))) {
        // IANA-Zonen sind technische Optionen, kein Geldwort im Kundentext.
        expect(steuerGeldWoerter(text.replace(/Europe\/Berlin/g, '')), `${file}: ${text}`).toEqual([]);
      }
    }
    const hilfe = everydayArticles.find((a) => a.id === 'summenwerte');
    expect(hilfe).toBeDefined();
    expect(steuerGeldWoerter(JSON.stringify(hilfe))).toEqual([]);
  });
  it('Konstante und Wortverbote entsprechen dem Vertrag', () => {
    const v = JSON.parse(readFileSync(join(process.cwd(), '../../docs/contracts/v2/rollen-zuordnung-vectors.json'), 'utf8'));
    expect(SUMMENWERT).toBe(v.kundenwort);
    expect(GESAMTWERT).toBe(SUMMENWERT);
    expect(SUMMENWERT_VERBOTENE_WOERTER).toEqual(v.verbotene_woerter);
    expect(altwort.test(SUMMENWERT)).toBe(false);
    expect(altwort.test('Gesamt-PV')).toBe(false);
    for (const wort of SUMMENWERT_VERBOTENE_WOERTER) expect(altwort.test(wort)).toBe(true);
    expect(texte('<p>Neuer Gesamtwert {name}</p>')).toContain('Neuer Gesamtwert');
    expect(texte('const s = `Ein Gesamtwert ${name} fehlt`;')).toContain('Ein Gesamtwert fehlt');
    expect(texte('// Gesamtwert\nimport { Gesamtwert } from "./Gesamtwert";')).toEqual([]);
  });
  const alteKonstante: Record<string, number> = {
    "kennzahlAnlegen.ts": 8,
    "gesamtwert.ts": 5,
    "glossar.ts": 1,
    "components/GesamtwertDialog.tsx": 3,
    "components/SummenwertAssistent.tsx": 3,
    "pages/MesswerteSection.tsx": 2
  };
  it('lässt den Übergangsbestand nur schrumpfen', () => {
    const gefunden: Record<string, number> = {};
    for (const file of customerFiles().filter((f) => !f.includes('/test/'))) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      const code = readFileSync(file, 'utf8').replace(/export const SUMMENWERT_VERBOTENE_WOERTER = \[[^;]+;/, '');
      expect((stripComments(code).match(/\bGESAMTWERT\b/g) ?? []).length, `${rel}: neue Nutzung des alten Wortexports`)
        .toBeLessThanOrEqual(alteKonstante[rel] ?? 0);
      for (const text of texte(code).filter((t) => altwort.test(t))) {
        const key = `${rel} · ${text}`;
        gefunden[key] = (gefunden[key] ?? 0) + 1;
      }
    }
    const neu = Object.entries(gefunden).filter(([key, n]) => n > (bestand[key] ?? 0));
    expect(neu, JSON.stringify(neu, null, 2)).toEqual([]);
  });
});


describe('AP-08 IP-16 · Ersatzwerte und Korrekturen', () => {
  const dateien = ['korrekturen.ts', 'components/ErsatzwertDialog.tsx', 'components/KorrekturenDialog.tsx', 'components/KorrekturVorschau.tsx'];
  const texte = dateien.flatMap(f => visibleTexts(readFileSync(join(SRC, f), 'utf8')));
  it('spricht in Kundenwörtern und benennt die zweite Person', () => {
    expect(texte.some(t => t.includes('zweite Person'))).toBe(true);
    const falsch = texte.filter(isKundentext).flatMap(t => [...FORBIDDEN, ...FORBIDDEN_INTERN].filter(({ re }) => re.test(ohneAusnahmen(t))).map(({ why }) => `${t}: ${why}`));
    expect(falsch).toEqual([]);
  });
  it('Widerruf und Vorschlag behaupten keine abgeschlossene Neuberechnung', () => {
    expect(texte.some(t => t.includes('weitere Version'))).toBe(true);
    expect(texte.some(t => t.includes('bisherigen Werte bleiben unverändert'))).toBe(true);
    expect(texte.some(t => t.includes('werden neu berechnet'))).toBe(true);
  });
});

describe('AP-14 IP-4 · erste Minute des Messkunden', () => {
  const texte = [
    STANDORT_ZUERST_TITEL,
    STANDORT_ZUERST_SATZ,
    STEUERN_EINSTIEG_SATZ,
    STEUERN_EINSTIEG_AKTION,
    'Legen Sie Ihre Anlage an, um Ihr Gerät zu verbinden und ihre Messwerte zu sehen.',
    'Eine Anlage bündelt Ihr Gerät und seine Messwerte. Danach verbinden Sie Ihr Gerät in wenigen Schritten.',
  ];

  it('spricht auf Kundenflächen ohne Betreiberwörter', () => {
    const falsch = texte.flatMap((text) =>
      [...FORBIDDEN, ...FORBIDDEN_INTERN]
        .filter(({ re }) => re.test(ohneAusnahmen(text)))
        .map(({ why }) => `${text}: ${why}`),
    );
    expect(falsch).toEqual([]);
  });

  it('spricht vor der eigenen Steuerungsseite weder von Steuern noch Geld', () => {
    expect(steuerGeldWoerter(`${STANDORT_ZUERST_TITEL} ${STANDORT_ZUERST_SATZ}`)).toEqual([]);
  });
});

describe('AP-14 IP-14 · Bestandsschutz in der Standort-Vorschau', () => {
  const texte = [STARTSEITE_UNTERNEHMEN, GELD_BLEIBT, STEUERUNG_BLEIBT];

  it('trägt den verbindlichen Wortlaut additiv', () => {
    expect(texte.join(' ')).toBe(
      'Ihre Startseite wird die Unternehmens-Übersicht. Erlöse und Kosten finden Sie weiter im Cockpit jeder Anlage, im Portfolio und unter Erlöse. An Steuerung, Fahrplänen und Freigaben ändert sich nichts.',
    );
  });

  it('enthält weder Betreiberwörter noch Pilot oder Rollout', () => {
    const intern = /\b(?:Pilot|Rollout|Betreiber)\b/i;
    const falsch = texte.flatMap((text) => [
      ...[...FORBIDDEN, ...FORBIDDEN_INTERN]
        .filter(({ re }) => re.test(ohneAusnahmen(text)))
        .map(({ why }) => `${text}: ${why}`),
      ...(intern.test(text) ? [`${text}: internes Einführungswort`] : []),
    ]);
    expect(falsch).toEqual([]);
  });
});

describe('AP-14 IP-15 · Zuordnung korrigieren', () => {
  const artikel = plantArticles.find((a) => a.id === 'standort-zuordnung-korrigieren');

  it('trägt den verbindlichen Satz aus §5.9 additiv', () => {
    expect(KORREKTUR_VORSPANN).toBe(
      'Die Anlage gehört seit ihrem ersten Tag zu einem anderen Standort? Hier ändern Sie das rückwirkend. Steuerung und Messwerte bleiben unberührt.',
    );
  });

  it('erklärt Korrektur, normalen Umzug, Erhalt und den fehlenden Zustand „wieder nicht zugeordnet“', () => {
    const text = artikel?.sections.flatMap((s) => s.paragraphs).join(' ') ?? '';
    expect(text).toContain('tatsächlichen Umzugstag');
    expect(text).toContain('Steuerung und Messwerte bleiben unberührt');
    expect(text).toContain('keinen Zustand „wieder nicht zugeordnet“');
    expect(text).toContain('wird nichts gelöscht');
  });
});

describe('UEMS AP-16 IP-7 · Bewertung: Sprach-Wächter und Kundenwörter (SP1–SP3)', () => {
  /** IP-6/IP-12/IP-18/IP-20/IP-25 tragen hier ihre Kunden-Komponenten ein. */
  const BEWERTUNG_FLAECHEN: string[] = [];
  const VERBOTEN = [
    /(^|[^\p{L}\p{N}])SEU([^\p{L}\p{N}]|$)/iu,
    /(^|[^\p{L}\p{N}])EnPI([^\p{L}\p{N}]|$)/iu,
    /(^|[^\p{L}\p{N}])ISO[-‑– ]wesentlich([^\p{L}\p{N}]|$)/iu,
    /(^|[^\p{L}\p{N}])wesentlich\s+nach\s+ISO([^\p{L}\p{N}]|$)/iu,
    /(^|[^\p{L}\p{N}])automatisch\s+eingestuft([^\p{L}\p{N}]|$)/iu,
    /(^|[^\p{L}\p{N}])ISO([^\p{L}\p{N}]|$)/iu,
  ];
  const verstoesse = (text: string) => {
    const ohneGrenze = text.replaceAll(UEMS_NORMGRENZE, ' ');
    return VERBOTEN.filter((re) => re.test(ohneGrenze));
  };
  const traegtGrenze = (text: string) => text.includes(UEMS_NORMGRENZE);

  it('beißt an jedem verbotenen Wort und lässt die Wortgrenzen heil', () => {
    for (const probe of ['SEU', 'seu', 'EnPI', 'enpi', 'ISO-wesentlich', 'wesentlich nach ISO', 'automatisch eingestuft', 'ISO']) {
      expect(verstoesse(`Bewertung: ${probe}.`), probe).not.toEqual([]);
    }
    expect(verstoesse('Museum und Isolierung bleiben normale Wörter.')).toEqual([]);
    expect(verstoesse(UEMS_NORMGRENZE)).toEqual([]);
  });

  it('verlangt den Grenz-Satz auf jeder Bewertungs-Fläche und prüft die Mechanik am Prüfling', () => {
    for (const datei of BEWERTUNG_FLAECHEN) {
      const text = readFileSync(join(SRC, datei), 'utf8');
      expect(verstoesse(text), datei).toEqual([]);
      expect(traegtGrenze(text), datei).toBe(true);
    }
    expect(traegtGrenze('Bewertung ohne Abgrenzung')).toBe(false);
    expect(traegtGrenze(`Bewertung. ${UEMS_NORMGRENZE}`)).toBe(true);
  });

  it('findet verbotene Wörter auf jeder Kundenfläche', () => {
    const funde = customerFiles().flatMap((file) => {
      const wo = file.slice(SRC.length + 1).replace(/\\/g, '/');
      return visibleTexts(readFileSync(file, 'utf8'))
        .filter(isKundentext)
        .flatMap((text) => verstoesse(text).map((re) => `${wo}: ${re} in „${text}“`));
    });
    expect(funde, funde.join('\n')).toEqual([]);
  });

  it('bildet die geschlossenen Vokabulare mit Kundenwörtern ab', () => {
    expect(UEMS_EINSTUFUNGEN).toEqual({ wesentlich: 'wesentlich', nicht_wesentlich: 'nicht wesentlich', offen: 'offen' });
    expect(UEMS_BEWERTUNG_URTEILE).toEqual({
      ueber_schwelle: 'über Schwelle', unter_schwelle: 'unter Schwelle', nicht_anwendbar: 'nicht anwendbar',
      nicht_belastbar: 'nicht belastbar', erfuellt: 'erfüllt', vorbehalt_datenlage: 'Vorbehalt: Datenlage',
      vorbehalt_ersatzwerte: 'Vorbehalt: Ersatzwerte', unter_zwoelf: 'unter zwölf Monaten', vorlaeufig: 'vorläufig',
    });
    expect(UEMS_BEWERTUNG_ABDECKUNG).toEqual({ gemessen: 'gemessen', geplant: 'geplant', ersatz: 'Ersatz', ungemessen: 'ungemessen' });
  });

  it('erzeugt die 17 Kundensätze aus §5.7 Zeichen für Zeichen', () => {
    const s = UEMS_BEWERTUNG_SAETZE;
    expect([
      s.ranglisteKopf('Oktober', 2026, 185380, 3, 3, 67.8),
      s.restZeile(59640, 32.2, 'Halle 1', 39.2),
      s.nichtBelastbar(80, 67.8),
      s.vorlaeufig(1, 12),
      s.einstufung('Wesentlich', '06.11.2026', 1, 'Ines Kaltenbach', '41,8 % des Stromeinsatzes; größter Einsatz an beiden Hallen.'),
      s.abweichungVorschlag('Wesentlich', 'unter Schwelle', 8.6, 'Querschnitt für Spritzguss und Montage, Leckageverluste vermutet.'),
      s.querschnitt('Spritzguss', 'Druckluft', 70, 'MS-07', 11130),
      s.messbedarf('MB-1', 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1', 'MS-23 Halle 1 Allgemein', 'keine Datenquelle seit 27.11.2026'),
      s.messmittel('Netzzähler Halle 1', 'B', 'MID', '14.06.2023', '31.12.2031', 'Zählerstandsmitteilung 10/2026', '3b1f…9a2e'),
      s.messmittelOffen('Unterzähler Druckluft'),
      s.vergleichsquelle('Dezember', 2026, 1.1, 'Netzleistung am Wechselrichter', 2),
      s.befund(3.4, 2),
      s.stand(2026, 2, '17.11.2026', 1, '09.11.2026', 'Korrektur K-2026-0007'),
      s.frist(2, '17.11.2026', 1),
      s.traegerOhneAnteil('Heizung Verwaltung', 'Gas', 1240, 'm³', 'Oktober', 2026, 'abgelesen'),
      s.leer(),
      s.grenze(),
    ]).toEqual([
      'Stromeinsatz Oktober 2026: 185 380 kWh aus 3 von 3 Anlagen · 67,8 % Energieeinsätzen zugeordnet.',
      '59 640 kWh (32,2 %) sind keinem Energieeinsatz zugeordnet — größter Block: Halle 1 (39,2 % der Anlage).',
      'Der 80-%-Block ist nicht belastbar: nur 67,8 % des Stromeinsatzes sind Energieeinsätzen zugeordnet.',
      'Datengrundlage 1 von 12 Monaten — vorläufig.',
      'Wesentlich · seit 06.11.2026 (Fassung 1) · Ines Kaltenbach: ‚41,8 % des Stromeinsatzes; größter Einsatz an beiden Hallen.‘',
      'Wesentlich — Vorschlag: unter Schwelle (8,6 %). Begründung: ‚Querschnitt für Spritzguss und Montage, Leckageverluste vermutet.‘',
      'Spritzguss bezieht Druckluft: 70 % von MS-07 = 11 130 kWh — in Druckluft gezählt.',
      'Messbedarf MB-1: Lüftung, Beleuchtung und Allgemeinstrom Halle 1 — eingelöst durch MS-23 Halle 1 Allgemein (keine Datenquelle seit 27.11.2026).',
      'Netzzähler Halle 1: Klasse B (MID) · geeicht 14.06.2023, gültig bis 31.12.2031 · Beleg: Zählerstandsmitteilung 10/2026 (Prüfsumme 3b1f…9a2e).',
      'Unterzähler Druckluft: Klasse und Prüfung nicht erhoben.',
      'Vergleich Dezember 2026: 1,1 % Abweichung zur Netzleistung am Wechselrichter (Toleranz 2 %) — passt.',
      'Abweichung zur Vergleichsquelle 3,4 % (Toleranz 2 %) — bitte prüfen.',
      'Bewertung 2026 · Stand Nr. 2 vom 17.11.2026 (ersetzt Nr. 1 vom 09.11.2026 — Anlass: Korrektur K-2026-0007).',
      'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.',
      'Heizung Verwaltung (Gas): 1 240 m³ im Oktober 2026, abgelesen · ohne Anteil — Gas hat keinen gemeinsamen Nenner mit Strom.',
      'Noch keine Energieeinsätze. Legen Sie fest, welche Prozesse Energie einsetzen — die Rangliste entsteht aus den Messwerten.',
      UEMS_NORMGRENZE,
    ]);
  });
});

describe('AP-14 IP-19 · Freigabe: Sprach-Wächter und Release-Notiz (S1–S3)', () => {
  const GRENZ_SATZ = UEMS_NORMGRENZE;
  const NEUTRALE_ISO_NENNUNG = 'Eine Zertifizierung nach ISO 50001 wird nicht versprochen.';
  const RELEASE_NOTIZ = join(SRC, '../../../docs/rollout/release-notiz-vorlage.md');
  const BERICHT_VORLAGEN = join(
    SRC,
    '../../../services/api/src/main/resources/berichte/bericht-vorlagen.json',
  );

  const REGELN = [
    { regel: 'S1', re: /ISO[-‑– ]konform/iu, grund: 'keine Aussage „ISO-konform"' },
    { regel: 'S1', re: /zertifiziert\s+nach/iu, grund: 'keine Aussage „zertifiziert nach"' },
    { regel: 'S1', re: /normkonform/iu, grund: 'keine Aussage „normkonform"' },
    { regel: 'S1', re: /ISO\s*50001/iu, grund: 'ISO 50001 nicht als erreichte Eigenschaft behaupten' },
    { regel: 'S2', re: /(?:^|[^\p{L}\p{N}])Pilot[\p{L}\p{N}-]*/iu, grund: '„Pilot" ist ein Betreiberwort' },
    { regel: 'S2', re: /Betreuungs[-‑– ]Welle/iu, grund: '„Betreuungs-Welle" ist ein Betreiberwort' },
    { regel: 'S2', re: /Betreiber[-‑– ]Liste/iu, grund: '„Betreiber-Liste" ist ein Betreiberwort' },
    { regel: 'S2', re: /(?:^|[^\p{L}\p{N}])Rollout(?:$|[^\p{L}\p{N}])/iu, grund: '„Rollout" ist ein Betreiberwort' },
    { regel: 'S2', re: /Freigabe[-‑– ]Tor/iu, grund: '„Freigabe-Tor" ist ein Betreiberwort' },
    { regel: 'S2', re: /Stufe\s+S(?:\s*\d+)?(?![\p{L}\p{N}])/iu, grund: '„Stufe S" ist ein Betreiberwort' },
    { regel: 'S3', re: /gemeinsam\s+optimiert/iu, grund: 'Boxen werden nicht gemeinsam optimiert' },
    { regel: 'S3', re: /(?:^|[^\p{L}\p{N}])Verbund(?:$|[^\p{L}\p{N}])/iu, grund: 'kein „Verbund" mehrerer Boxen' },
    { regel: 'S3', re: /übergreifend\s+optimiert/iu, grund: 'Boxen werden nicht übergreifend optimiert' },
    // AP-15 W5: der Wächter wird nicht geöffnet — „Steuerungsverbund“ ist Fach- und Vertragswort,
    // auf Kundenflächen heißt es „Gemeinsame Steuerung“. Als Wortteil (auch gebeugt), anders als
    // das freie „Verbund“ oben, das „Stromverbund“ zulässt.
    { regel: 'S3', re: /Steuerungsverb[uü]nd/iu, grund: '„Gemeinsame Steuerung" statt „Steuerungsverbund"' },
  ] as const;

  function freigabeVerstoesse(text: string) {
    const prueftext = [GRENZ_SATZ, NEUTRALE_ISO_NENNUNG].reduce(
      (rest, erlaubterSatz) => rest.replaceAll(erlaubterSatz, ' '),
      text,
    );
    return REGELN.filter(({ re }) => re.test(prueftext));
  }

  function jsonTexte(wert: unknown): string[] {
    if (typeof wert === 'string') return [wert];
    if (Array.isArray(wert)) return wert.flatMap(jsonTexte);
    if (wert && typeof wert === 'object') return Object.values(wert).flatMap(jsonTexte);
    return [];
  }

  function kundenFundstellen() {
    const portal = customerFiles().flatMap((file) => {
      const wo = file.slice(SRC.length + 1).replace(/\\/g, '/');
      return visibleTexts(readFileSync(file, 'utf8'))
        .filter(isKundentext)
        .map((text) => ({ wo, text }));
    });
    const berichte = jsonTexte(JSON.parse(readFileSync(BERICHT_VORLAGEN, 'utf8')))
      .map((text) => ({ wo: 'services/api/src/main/resources/berichte/bericht-vorlagen.json', text }));
    return [
      ...portal,
      ...berichte,
      { wo: 'docs/rollout/release-notiz-vorlage.md', text: readFileSync(RELEASE_NOTIZ, 'utf8') },
    ];
  }

  it('S1 wird an Behauptungen rot und lässt die ausdrückliche Abgrenzung zu', () => {
    for (const probe of [
      'VoltPilot ist ISO-konform.',
      'VoltPilot ist zertifiziert nach einer Energiemanagement-Norm.',
      'VoltPilot arbeitet normkonform.',
      'VoltPilot erfüllt ISO 50001.',
    ]) {
      expect(freigabeVerstoesse(probe).some(({ regel }) => regel === 'S1'), probe).toBe(true);
    }
    expect(freigabeVerstoesse(GRENZ_SATZ)).toEqual([]);
    expect(freigabeVerstoesse(NEUTRALE_ISO_NENNUNG)).toEqual([]);
  });

  it('S2 wird an Betreiberwörtern rot, aber nicht am Produktnamen oder in Admin-Flächen', () => {
    for (const probe of [
      'Dieser Pilot beginnt heute.',
      'Der Pilotnachweis fehlt.',
      'Die nächste Betreuungs-Welle beginnt morgen.',
      'Sie stehen auf der Betreiber-Liste.',
      'Der Rollout ist abgeschlossen.',
      'Das Freigabe-Tor ist offen.',
      'Sie befinden sich in Stufe S3.',
    ]) {
      expect(freigabeVerstoesse(probe).some(({ regel }) => regel === 'S2'), probe).toBe(true);
    }
    expect(freigabeVerstoesse('VoltPilot zeigt Ihre Messwerte.')).toEqual([]);
    expect(freigabeVerstoesse('Die Stufe Standort ist vollständig.')).toEqual([]);
    expect(customerFiles().some((file) => file.includes('/pages/admin/'))).toBe(false);
    expect(customerFiles().some((file) => EXCLUDED.some((frag) => file.includes(frag)))).toBe(false);
    expect(customerFiles().some((file) => file.includes('/help/content/'))).toBe(true);
  });

  it('S3 wird an einer behaupteten Kopplung rot und lässt die festgelegte Einzel-Box-Aussage zu', () => {
    for (const probe of [
      'Ihre Boxen werden gemeinsam optimiert.',
      'Die Anlagen bilden einen Verbund.',
      'Mehrere Anlagen werden übergreifend optimiert.',
      'Ihre Boxen bilden einen Steuerungsverbund.',
      'Die Steuerungsverbünde sind eingerichtet.',
    ]) {
      expect(freigabeVerstoesse(probe).some(({ regel }) => regel === 'S3'), probe).toBe(true);
    }
    expect(freigabeVerstoesse('Jede Box liest ihre Quellen.')).toEqual([]);
    expect(freigabeVerstoesse('Das Verbundnetz gehört zum Stromverbund.')).toEqual([]);
  });

  it('S3: jedes der vier Wörter macht den Wächter allein rot (AP-15 IP-25, Test des Tests)', () => {
    const s3 = (text: string) => freigabeVerstoesse(text).filter(({ regel }) => regel === 'S3');
    for (const [probe, grund] of [
      ['Ihre Boxen werden gemeinsam optimiert.', 'gemeinsam optimiert'],
      ['Die Anlagen bilden einen Verbund.', '„Verbund"'],
      ['Mehrere Anlagen werden übergreifend optimiert.', 'übergreifend optimiert'],
      ['Ihre Boxen bilden einen Steuerungsverbund.', '„Steuerungsverbund"'],
    ] as const) {
      expect(s3(probe).map((r) => r.grund), probe).toHaveLength(1);
      expect(s3(probe)[0].grund, probe).toContain(grund);
    }
  });

  it('die Sätze der Gemeinsamen Steuerung (AP-15 §5.8) bestehen den Wächter — roh und eingesetzt', () => {
    expect(freigabeVerstoesse(GEMEINSAME_STEUERUNG)).toEqual([]);
    expect(freigabeVerstoesse('Gemeinsam gesteuert wird nur hinter demselben Netzanschluss.')).toEqual([]);
    const werte: Record<string, string> = {
      box: 'Halle 1', andere_box: 'Verwaltung', boxen: '2',
      einspeisung_kw: '100', bezug_kw: '550', kw: '77', uhrzeit: '13:10', kwh: '160', ladepark: 'Ladepark Verwaltung',
    };
    const texte = Object.entries(STEUERUNG_SAETZE).flatMap(([schluessel, vorlage]) => [
      vorlage,
      steuerungSatz(schluessel as keyof typeof STEUERUNG_SAETZE, Object.fromEntries(steuerungPlatzhalter(vorlage).map((k) => [k, werte[k]]))),
    ]);
    expect(texte).toHaveLength(32);
    expect(texte.flatMap((t) => freigabeVerstoesse(t).map(({ grund }) => `${grund}: ${t}`))).toEqual([]);
    // …und der Bestands-Scan liest das Modul als Kundenfläche mit.
    expect(customerFiles().some((file) => file.endsWith('/uemsGemeinsameSteuerung.ts'))).toBe(true);
  });

  it('die Sätze der Kundenfläche (AP-15 IP-23) bestehen den Wächter — roh und eingesetzt', () => {
    const werte: Record<string, string> = {
      box: 'Verwaltung', boxen: '2', einspeisung_kw: '60', bezug_kw: '77', geraet: 'PV-Wechselrichter Verwaltung 60 kW',
      summe_kw: '100', verteilbar_kw: '70', kwh: '160', dauer: '9,1 Stunden',
    };
    const texte = Object.entries(STEUERUNG_FLAECHE).flatMap(([schluessel, vorlage]) => [
      vorlage,
      steuerungFlaechenSatz(schluessel as keyof typeof STEUERUNG_FLAECHE, Object.fromEntries(steuerungPlatzhalter(vorlage).map((k) => [k, werte[k]]))),
    ]);
    expect(texte.flatMap((t) => freigabeVerstoesse(t).map(({ grund }) => `${grund}: ${t}`))).toEqual([]);
    // „mindestens“: die kWh der Verlust-Zeile ist eine Untergrenze (IP-22) und steht nie ohne das Wort.
    expect(Object.values(STEUERUNG_FLAECHE).filter((v) => v.includes('{kwh}')).every((v) => v.includes('mindestens {kwh}'))).toBe(true);
  });

  it('findet im Bestand, in Hilfe, Berichts-Texten und Release-Notiz keinen echten Verstoß', () => {
    const violations = kundenFundstellen().flatMap(({ wo, text }) =>
      freigabeVerstoesse(text).map(({ regel, grund }) => `${wo}: ${regel} — ${grund} in „${text.trim().slice(0, 100)}"`),
    );
    expect(violations, `Verbotene Freigabe-Aussagen:\n${violations.join('\n')}`).toEqual([]);
  });

  it('die drei Vorlagen tragen den Grenz-Satz und die sichtbaren Änderungen', () => {
    const vorlage = readFileSync(RELEASE_NOTIZ, 'utf8');
    expect(vorlage.split(GRENZ_SATZ)).toHaveLength(4);
    expect(vorlage).toContain('„Noch nicht zugeordnet“');
    expect(vorlage).toContain('„Standort anlegen“');
    expect(vorlage).toContain('„Messen & Auswerten“');
    expect(vorlage).toMatch(/historischen\s+Prozentwerte\s+für\s+Autarkie\s+und\s+Eigenverbrauch/u);
    expect(vorlage).toContain('Software-Aktualisierung Ihrer Box');
    expect(vorlage.match(/Jede Box liest ihre Quellen\./g)).toHaveLength(3);
  });
});
