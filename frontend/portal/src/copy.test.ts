import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KENNZEICHEN, TAGESDAUER, VORGESEHEN, ZUSTAENDE } from './uemsErgebnis';
import { UEMS_LEBENSZYKLUS } from './glossar';
import { erkenne as kennzahlKennzeichen, KENNZEICHEN as KENNZAHL_KENNZEICHEN, SAETZE as KENNZAHL_SAETZE, VERBOTENE_WOERTER as KENNZAHL_VERBOTEN } from './uemsKennzahl';
import { archiviertAmText, KNOPF_ARCHIVIEREN, KNOPF_LOESCHEN, KNOPF_WIEDERHERSTELLEN } from './ortArchiv';
import { KENNZEICHEN as BERICHT_KENNZEICHEN, SAETZE as BERICHT_SAETZE, VERBOTENE_WOERTER as BERICHT_VERBOTEN } from './uemsBericht';

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
