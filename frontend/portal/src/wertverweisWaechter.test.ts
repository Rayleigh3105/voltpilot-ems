import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Wertverweis-Wächter** (Alerting Scheibe 2, Konzept `vp-alerting-konzept-m1` §6.3: „Die
 * gemeinsamen Bausteine, die Werte zeigen … bekommen ein Feld `wert` …; ein Wächter-Test … wird
 * rot, wenn eine Fläche einen dieser Bausteine ohne `wert` nutzt und nicht mit Grund in seiner
 * Liste steht; die Liste schrumpft Scheibe für Scheibe.").
 *
 * Diese Scheibe migriert GENAU eine Fläche: die vier Live-Kreise von „Dieser Moment" im
 * Cockpit (`EnergieBuehne.tsx`, Baustein `MomentWert`) - jeder trägt jetzt `onUeberwachen`
 * (öffnet das Blatt „Überwachen" für seine Wertart) und `ueberwacht` (die Marke). Jede andere
 * Fläche, die den gemeinsamen Kachel-Baustein (`components/kacheln/Kachel.tsx` /
 * `CockpitKacheln.tsx`) nutzt, bleibt unmigriert und MUSS deshalb unten einzeln und begründet in
 * `AUSNAHMEN` stehen - eine neue, nicht eingetragene Fläche mit demselben Baustein macht den
 * ersten Fall rot.
 *
 * ⚠ ER LIEST DEN ROHEN TEXT (Muster `keineSeitenleisten.test.ts`): eine Datei, die den Baustein
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

/** Die Definitions-Dateien des Bausteins selbst - sie "nutzen" ihn nicht, sie SIND er. */
const BAUSTEIN_DEFINITIONEN = new Set(['src/components/kacheln/Kachel.tsx', 'src/components/kacheln/CockpitKacheln.tsx']);

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
  // Messen: die Messstellen-Liste (Leit-, Ablese- und Stand-Kacheln).
  'src/components/MessstelleKacheln.tsx',
  // Messstellen-Seite: die Monatsbalken (eine Skala, kein Momentanwert).
  'src/components/MonatsBalken.tsx',
  // Unternehmen/Standort-Übersicht: das Portfolio-Kachelraster (Leitkennzahl, Datenlage, Trend).
  'src/components/PortfolioKacheln.tsx',
  // Fahrplan: der Strompreis-Streifen.
  'src/components/StrompreisStrip.tsx',
  // Messstellen-Seite: die „Werte"-Sektion (Karte, Liste, Verlauf, Vergleich - eigener Glossar-Eintrag `werte`).
  'src/components/WerteSektion.tsx',
];

describe('Wertverweis-Wächter (Alerting Scheibe 2, Konzept §6.3)', () => {
  it('jede Fläche mit dem Kachel-Baustein ist migriert oder begründet in AUSNAHMEN eingetragen', () => {
    const treffer = ALLE
      .filter((f) => !BAUSTEIN_DEFINITIONEN.has(kurz(f)))
      .filter((f) => KACHEL_IMPORT.test(readFileSync(f, 'utf8')))
      .map(kurz)
      .filter((f) => !AUSNAHMEN.includes(f));
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
});
