import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Wertverweis-Wächter** (Alerting Scheibe 2, Konzept `vp-alerting-konzept-m1` §6.3: „Die
 * gemeinsamen Bausteine, die Werte zeigen … bekommen ein Feld `wert` …; ein Wächter-Test … wird
 * rot, wenn eine Fläche einen dieser Bausteine ohne `wert` nutzt und nicht mit Grund in seiner
 * Liste steht; die Liste schrumpft Scheibe für Scheibe.").
 *
 * Scheibe 2 migrierte zunächst GENAU eine Fläche: die vier Live-Kreise von „Dieser Moment" im
 * Cockpit (`EnergieBuehne.tsx`, Baustein `MomentWert`) - jeder trägt `onUeberwachen` (öffnet das
 * Blatt „Überwachen" für seine Wertart) und `ueberwacht` (die Marke). Jede andere Fläche, die den
 * gemeinsamen Kachel-Baustein (`components/kacheln/Kachel.tsx` / `CockpitKacheln.tsx`) nutzt,
 * bleibt unmigriert und MUSS deshalb unten einzeln und begründet in `AUSNAHMEN` stehen - eine
 * neue, nicht eingetragene Fläche mit demselben Baustein macht den ersten Fall rot.
 *
 * Die Nachbesserung 3/3 fügt den ZWEITEN Baustein aus §6.3 hinzu, `WertZeile`
 * (`components/WertZeile.tsx`): das Menü „Überwachen" + die Marke „überwacht" an einem Wert
 * AUSSERHALB der Kachel. Er deckt die Aufbau-Tabelle (`AufbauTabelle.tsx`, Spalte „Wert" der
 * Geräte- und Komponenten-Zeilen) und die Geräteseiten-Bühne (`GeraetBuehne.tsx`, große Zahl und
 * Chips der SELBST definierten Eigenbau-Kanäle). Anders als `Kachel` hat `WertZeile` keinen
 * Zweck außer dieser Verdrahtung - es gibt also keine `AUSNAHMEN`-Liste dafür, nur die Pflicht,
 * dass ein Import ihn auch benutzt (sonst wird der Fall unten rot).
 *
 * Alerting Scheibe 5 (§6.3, §7 Scheibe 5 Punkt 2) schrumpft `AUSNAHMEN` um genau die drei Flächen,
 * die ihr Bau-Inhalt nennt: `MessstelleKacheln.tsx`, `MonatsBalken.tsx`, `WerteSektion.tsx` - jede
 * verdrahtet jetzt selbst einen Wertverweis über `WertZeile` (die Leitkachel bzw. die Karte für
 * `messstelle.menge`, die Monatsbalken für `messstelle.monat_unvollstaendig`). Eine Fläche, die so
 * migriert, braucht in `AUSNAHMEN` keinen Platzhalter mehr: der erste Fall unten lässt jede Fläche
 * durch, die (zusätzlich zum Kachel-Import) auch `WertZeile` importiert - der zweite Fall erzwingt
 * ohnehin schon, dass dieser Import mit `onUeberwachen` verdrahtet ist, also ist das kein
 * Freifahrtschein, nur die Anerkennung einer bereits geprüften Verdrahtung.
 *
 * ⚠ ER LIEST DEN ROHEN TEXT (Muster `keineSeitenleisten.test.ts`): eine Datei, die einen Baustein
 * importiert, trägt ihre Begründung hier, nicht einen Kommentar im eigenen Kopf, den niemand prüft.
 */
const ROOT = process.cwd() + '/';
const SRC = join(ROOT, 'src');

function dateien(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...dateien(full));
    } else if (/\.tsx$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const kurz = (f: string) => f.slice(ROOT.length);

// Der Wächter selbst zitiert den Import-Pfad naturgemäß - er prüft ihn.
const ALLE = dateien(SRC).filter((f) => !f.endsWith('wertverweisWaechter.test.ts'));

/** Der gemeinsame Kachel-Baustein, den §6.3 meint: `Kachel` (das Rahmen-Primitiv) und die
 * fertigen Kachel-Arten des Cockpits (`CockpitKacheln.tsx`), die ihn einwickeln. */
const KACHEL_IMPORT = /from ['"][^'"]*\/kacheln\/(Kachel|CockpitKacheln)['"]/;

/**
 * Der zweite Baustein aus §6.3 ("Kachel, Wert-Zeile, Statuszeile, Diagrammkopf"): `WertZeile`
 * (`components/WertZeile.tsx`) - das Menü ⋯ „Überwachen" und die Marke „überwacht" an einem Wert
 * AUSSERHALB der Kachel. Nachbesserung 3/3 der Scheibe 2 führt ihn ein, weil der Kachel-Wächter
 * die Aufbau-Tabelle und die Geräteseite gar nicht sah: beide zeigen „Wert" mit eigenem Markup,
 * nicht mit `Kachel`/`CockpitKacheln` (§6.3 „Ehrlich: Werte, die eine Fläche mit eigenem Markup
 * zeigt, erreicht der Wächter nicht").
 */
const WERT_ZEILE_IMPORT = /from ['"][^'"]*\/WertZeile['"]/;

/** Die Definitions-Dateien der Bausteine selbst - sie "nutzen" sie nicht, sie SIND sie. */
const BAUSTEIN_DEFINITIONEN = new Set([
  'src/components/kacheln/Kachel.tsx',
  'src/components/kacheln/CockpitKacheln.tsx',
  'src/components/WertZeile.tsx',
]);

/**
 * Jede Fläche mit dem Kachel-Baustein, die diese Scheibe NICHT migriert - einzeln begründet
 * (§6.3). Dieselbe Begründung wie die Aufgabenstellung dieser Scheibe: „Scheibe 2 deckt nur die
 * Cockpit-Live-Kacheln ab; diese Fläche folgt in einer späteren Runde."
 */
const AUSNAHMEN = [
  // Cockpit: die TAGES-Kacheln (Autarkie, Eigenverbrauch, Netz heute, Speicher, Sonne, Handel,
  // Fahrplan, Geld, Strompreis, Lastspitze) - anders als die vier LIVE-Kreise von „Dieser Moment"
  // (die migrierte Fläche, `EnergieBuehne.tsx`) zeigen sie Tagessummen, keine Momentanwerte, und
  // tragen keine eigene Wertart im Katalog.
  'src/pages/AnlagenPage.tsx',
  // Verlauf: die Energiebilanz-Kacheln je Energieeinsatz.
  'src/pages/EnergieeinsatzSeite.tsx',
  // Auswerten: der Kennzahl-Kopf (Zähler, Nenner, Urteil gegen die Bezugsbasis).
  'src/pages/KennzahlSeite.tsx',
  // Auswerten: die Verbrauch-Rangliste und ihre Monatssäulen.
  'src/pages/VerbrauchPage.tsx',
  // Auswerten: die Bezugsbasis-/Vergleichs-Kacheln der Kennzahl-Auswertung.
  'src/components/KennzahlenAuswertung.tsx',
  // Fahrplan/Ladevorgänge: die Ladepunkt-Kachel mit ihren Zeilen je Sitzung.
  'src/components/LadenKachel.tsx',
  // Unternehmen/Standort-Übersicht: das Portfolio-Kachelraster (Leitkennzahl, Datenlage, Trend).
  'src/components/PortfolioKacheln.tsx',
  // Fahrplan: der Strompreis-Streifen.
  'src/components/StrompreisStrip.tsx',
];

describe('Wertverweis-Wächter (Alerting Scheibe 2, Konzept §6.3)', () => {
  it('jede Fläche mit dem Kachel-Baustein ist migriert, begründet in AUSNAHMEN eingetragen, oder verdrahtet selbst einen Wertverweis über WertZeile', () => {
    const treffer = ALLE
      .filter((f) => !BAUSTEIN_DEFINITIONEN.has(kurz(f)))
      .map((f) => [kurz(f), readFileSync(f, 'utf8')] as const)
      .filter(([, quelle]) => KACHEL_IMPORT.test(quelle))
      .filter(([pfad]) => !AUSNAHMEN.includes(pfad))
      // Scheibe 5 (§6.3): ein Kachel-Nutzer mit eigenem Wertverweis braucht keinen AUSNAHMEN-Platz
      // mehr - der zweite Fall unten erzwingt ohnehin, dass dieser Import verdrahtet ist.
      .filter(([, quelle]) => !WERT_ZEILE_IMPORT.test(quelle))
      .map(([pfad]) => pfad);
    expect(treffer).toEqual([]);
  });

  it('AUSNAHMEN nennt keine Datei mehr, die den Baustein gar nicht (mehr) importiert - sonst ist die Liste veraltet statt geschrumpft (§6.3)', () => {
    const nochGenutzt = AUSNAHMEN.filter((f) => KACHEL_IMPORT.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(nochGenutzt).toEqual(AUSNAHMEN);
  });

  it('„Dieser Moment" im Cockpit verdrahtet „Überwachen" an allen vier Live-Kreisen (PV, Verbrauch, Speicher, Netz)', () => {
    const quelle = readFileSync(join(SRC, 'components/EnergieBuehne.tsx'), 'utf8');
    const menu = quelle.match(/onUeberwachen=\{/g) ?? [];
    const marke = quelle.match(/ueberwacht=\{istUeberwacht\(/g) ?? [];
    expect(menu.length).toBe(4);
    expect(marke.length).toBe(4);
  });

  /**
   * Anders als `Kachel` (ein generisches Rahmen-Primitiv, das viele fachfremde Flächen nutzen)
   * hat `WertZeile` keinen Zweck außer „Überwachen" + Marke - es gibt deshalb KEINEN legitimen
   * Import ohne Verdrahtung und damit auch keine `AUSNAHMEN_WERT_ZEILE`-Liste: jede Datei, die
   * den Baustein importiert, muss ihn auch mit `onUeberwachen` aufrufen (sonst wäre der Import
   * totes Gewicht - ein Fund für diesen Wächter, kein Freifahrtschein).
   */
  it('jede Datei, die den Wert-Zeile-Baustein importiert, verdrahtet auch „Überwachen" (kein Import ohne Verdrahtung)', () => {
    const ohneVerdrahtung = ALLE
      .filter((f) => !BAUSTEIN_DEFINITIONEN.has(kurz(f)))
      .map((f) => [kurz(f), readFileSync(f, 'utf8')] as const)
      .filter(([, quelle]) => WERT_ZEILE_IMPORT.test(quelle))
      .filter(([, quelle]) => !/onUeberwachen=\{/.test(quelle))
      .map(([pfad]) => pfad);
    expect(ohneVerdrahtung).toEqual([]);
  });

  it('die Aufbau-Tabelle verdrahtet „Überwachen" an ihrer Wert-Zeile (Geräte- und Komponenten-Zeilen)', () => {
    const quelle = readFileSync(join(SRC, 'components/AufbauTabelle.tsx'), 'utf8');
    expect(quelle.match(/<WertZeile\b/g) ?? []).toHaveLength(2);
    expect(quelle.match(/onUeberwachen=\{\(\) => uk\.oeffnen/g) ?? []).toHaveLength(2);
  });

  it('die Geräteseiten-Bühne verdrahtet „Überwachen" an ihrer Wert-Zeile (große Zahl und Chips der Eigenbau-Kanäle)', () => {
    const quelle = readFileSync(join(SRC, 'components/GeraetBuehne.tsx'), 'utf8');
    expect(quelle.match(/<WertZeile\b/g) ?? []).toHaveLength(2);
    expect(quelle.match(/onUeberwachen=\{\(\) => setUeberwachenZiel/g) ?? []).toHaveLength(2);
  });

  it('die Messstellen-Kacheln verdrahten „Überwachen" an ihrer Leitkachel (Alerting Scheibe 5: messstelle.menge, messstelle.beobachtung)', () => {
    const quelle = readFileSync(join(SRC, 'components/MessstelleKacheln.tsx'), 'utf8');
    expect(quelle.match(/<WertZeile\b/g) ?? []).toHaveLength(2);
    expect(quelle).toMatch(/onUeberwachen=\{ueberwachung\.onUeberwachen\}/);
    expect(quelle).toMatch(/onUeberwachen=\{ueberwachungBeobachtung\.onUeberwachen\}/);
  });

  it('die Monatsbalken verdrahten „Überwachen" an der Vollständigkeit des Monats (Alerting Scheibe 5: messstelle.monat_unvollstaendig)', () => {
    const quelle = readFileSync(join(SRC, 'components/MonatsBalken.tsx'), 'utf8');
    expect(quelle.match(/<WertZeile\b/g) ?? []).toHaveLength(1);
    expect(quelle).toMatch(/onUeberwachen=\{ueberwachung\.onUeberwachen\}/);
  });

  it('die Werte-Sektion verdrahtet „Überwachen" an ihrer Karte (Alerting Scheibe 5: messstelle.menge, über die Monatsbalken auch messstelle.monat_unvollstaendig)', () => {
    const quelle = readFileSync(join(SRC, 'components/WerteSektion.tsx'), 'utf8');
    expect(quelle.match(/<WertZeile\b/g) ?? []).toHaveLength(1);
    expect(quelle).toMatch(/onUeberwachen=\{ueberwachung\.menge\.onUeberwachen\}/);
  });
});
