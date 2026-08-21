/**
 * Die HEBEL des Verbindungstests (Scout `data/vp-geraeteseite-rev-b8` NACHTRAG
 * Punkt 2, Captain-Befund 21.08.2026): „Konkrete Hebel direkt im Dialog
 * anbieten - Logger-Adresse, Leistungsskalierung ×10, Modell-Alternative."
 *
 * Der Vorzustand nannte die Hebel nur im Fließtext („Bitte Seriennummer, Port
 * und Modell prüfen") - anfassen musste sie der Kunde selbst finden. Hier
 * entstehen sie als KLICKBARE Wege.
 *
 * ## Die zwei Regeln, an denen alles hängt
 *
 * **⚠ 1. Ein Hebel entsteht aus BELEGEN, nie aus einer eigenen Diagnose.**
 * Eingang ist ausschließlich (a) was der Server gesagt hat - `errorCode` bzw.
 * der Befund `finding.rule`, beide maschinenlesbar - und (b) was die VORLAGE
 * strukturell hergibt (welche Verbindungsfelder es gibt, ob es Geschwister-
 * Modelle gibt). Es wird NIE aus den gelesenen Zahlen geschlossen, was kaputt
 * ist; das bleibt die Sache der Box, die gelesen hat (dieselbe Grenze, die
 * `komponentenAssistent.overrideFuer` zieht).
 *
 * **⚠ 2. Ein Hebel wird nie angeboten, wenn er strukturell ins Leere ginge.**
 * Kein Feld, das die Vorlage nicht hat; kein Modellwechsel ohne Alternative;
 * keine Skalierung auf einen Wert, der schon eingestellt ist. Ein Knopf, der
 * nichts bewirken kann, ist die Portal-Version einer erfundenen Antwort.
 *
 * Der Skalierungs-Hebel ist bewusst als FRAGE formuliert und erscheint auch bei
 * einem BESTANDENEN Test: der dokumentierte Deye-HV/LV-Fall (30 MW statt 30 kW)
 * verletzt keine Plausibilitätsregel - geprüft wird nur der Ladestand - und
 * käme sonst nie zur Sprache.
 */

import type { ComponentTemplate, TemplateField } from './api';
import type { TestErgebnis } from './komponentenAssistent';

/** Die drei Hebel des NACHTRAGs. */
export type HebelId = 'logger' | 'skalierung' | 'modell';

export interface Hebel {
  id: HebelId;
  titel: string;
  /** Warum GERADE dieser Hebel - aus dem Beleg, nie aus einer Vermutung. */
  satz: string;
  /** Die Beschriftung des Knopfs. */
  aktion: string;
  /**
   * Das Verbindungsfeld, das der Klick anspringt (`assist-<key>`), oder null
   * für den Modellwechsel - der führt eine Ebene zurück.
   */
  feld: string | null;
}

/** Der Kontext, aus dem die Hebel entstehen. */
export interface HebelKontext {
  ergebnis: TestErgebnis | null;
  /** Die gewählte Vorlage - sie sagt, WELCHE Felder es überhaupt gibt. */
  template: ComponentTemplate | null;
  /** Alle geladenen Vorlagen - daraus entstehen die Geschwister-Modelle. */
  templates: ComponentTemplate[] | null;
  /** Die aktuell eingetragene Verbindung (für „schon eingestellt"-Fälle). */
  verbindung: Record<string, unknown>;
}

/** Die Fehlerklassen, bei denen die ADRESSE der erste Verdacht ist. */
const LOGGER_CODES = new Set(['unreachable', 'no_answer', 'timeout', 'fronius_api']);

/** Die Fehlerklassen, bei denen die MODELLWAHL der erste Verdacht ist. */
const MODELL_CODES = new Set(['invalid_response', 'implausible']);

/** Der Skalierungs-Wert, den der Hebel setzt (Dekawatt). */
export const SKALIERUNG_X10 = '10';

/**
 * Die Hebel zu diesem Testergebnis - höchstens drei.
 *
 * **⚠ Die Reihenfolge ist eine Aussage: BELEGTES führt, die FRAGE steht
 * zuletzt.** Erst der Weg zum Gerät (Adresse), dann seine Identität (Modell) -
 * beide hat der Server benannt -, und ganz unten die Skalierung, für die es
 * keinen Beleg gibt. Andersherum stünde eine Vermutung über der Erklärung, die
 * die Box gerade geliefert hat (im Browser-Beweis aufgefallen).
 */
export function hebel(ctx: HebelKontext): Hebel[] {
  const { ergebnis, template } = ctx;
  if (!ergebnis || !template) return [];
  const out: Hebel[] = [];
  const code = ergebnis.errorCode ?? null;
  const regel = ergebnis.befund?.rule ?? null;
  const felder = template.transportSchema ?? [];

  // --- 1. Logger-Adresse ---------------------------------------------------
  // Der Beleg: das Gerät war nicht erreichbar, ODER es hat geantwortet und der
  // ganze Registerblock stand auf 0 - so antwortet ein Logger, der den
  // Wechselrichter selbst nicht erreicht.
  if (ergebnis.zustand === 'fehlgeschlagen'
      && ((code && LOGGER_CODES.has(code)) || regel === 'no_answer')) {
    const ziel = feld(felder, 'serial') ?? feld(felder, 'ip');
    if (ziel) {
      out.push({
        id: 'logger',
        titel: `${ziel.label} prüfen`,
        satz:
          ziel.key === 'serial'
            ? 'Die häufigste Verwechslung: hier gehört die Seriennummer des DATENLOGGERS hin, nicht die des Wechselrichters.'
            : 'Antwortet unter dieser Adresse wirklich Ihr Datenlogger? Er steht im WLAN-Namen und auf seiner Statusseite.',
        aktion: 'Angabe korrigieren',
        feld: ziel.key,
      });
    }
  }

  // --- 2. Modell-Alternative ----------------------------------------------
  // Der Beleg: die Antwort passte nicht zum Rahmen, oder ein Messwert lag
  // ausserhalb des physikalisch Möglichen - beides zeigt auf die Modellwahl.
  if (ergebnis.zustand === 'fehlgeschlagen'
      && ((code && MODELL_CODES.has(code)) || regel === 'out_of_range')) {
    if (geschwister(ctx).length > 0) {
      out.push({
        id: 'modell',
        titel: 'Ein anderes Modell probieren',
        satz:
          `Die Registerlage unterscheidet sich zwischen den Baureihen. Steht Ihr Gerät nicht `
          + `im Katalog, ist der nächste Verwandte oft die richtige Wahl - ${template.brandLabel} `
          + 'hat weitere Modelle.',
        aktion: 'Modell wechseln',
        feld: null,
      });
    }
  }

  // --- 3. Leistungsskalierung ×10 (die FRAGE, deshalb zuletzt) -------------
  // ⚠ Es gibt hier KEINEN Beleg vom Server - deshalb ist der Satz eine FRAGE,
  // und der Hebel erscheint nur, wo die Vorlage diese Einstellung wirklich hat.
  // Er steht auch neben einem BESTANDENEN Test: eine Leistung um Faktor 10
  // daneben verletzt keine Plausibilitätsregel (geprüft wird der Ladestand) und
  // käme sonst nie zur Sprache.
  const skala = feld(felder, 'power_scale');
  if (skala && ergebnis.messwerte.length > 0
      && String(ctx.verbindung.power_scale ?? '') !== SKALIERUNG_X10) {
    out.push({
      id: 'skalierung',
      titel: 'Leistungen um Faktor 10 daneben?',
      satz:
        'Hochvolt-Geräte melden ihre Leistung in Dekawatt. Erkennt VoltPilot das nicht, stehen '
        + 'oben Werte, die zehnmal zu groß oder zu klein sind - dann hilft die manuelle '
        + 'Einstellung „Dekawatt (×10)".',
      aktion: 'Auf ×10 stellen',
      feld: skala.key,
    });
  }

  return out;
}

/**
 * Die Modelle DERSELBEN Marke, die als Alternative in Frage kommen.
 *
 * ⚠ Über Marken hinweg wird NICHTS vorgeschlagen: ein Fronius ist keine
 * Alternative für einen Deye, und ein Vorschlag, der das behauptet, wäre
 * schlimmer als keine Liste. Die gewählte Vorlage selbst fällt heraus.
 */
export function geschwister(ctx: HebelKontext): ComponentTemplate[] {
  const { template, templates } = ctx;
  if (!template) return [];
  return (templates ?? [])
    .filter((t) => t.brand === template.brand && t.templateRef !== template.templateRef)
    .sort((a, b) => a.modelLabel.localeCompare(b.modelLabel, 'de'));
}

/** Der Satz über der Hebel-Liste - er sagt, was sie SIND. */
export const HEBEL_INTRO = 'Das können Sie jetzt versuchen:';

/**
 * ⚠ Der Satz, der die Hebel ehrlich einordnet: keiner von ihnen ist eine
 * Diagnose. Ohne ihn liest sich eine Liste von Knöpfen wie „VoltPilot weiß, was
 * kaputt ist" - und dann wirkt jeder erfolglose Versuch wie ein zweiter Fehler.
 */
export const HEBEL_HINWEIS =
  'Nach jeder Änderung erneut „Verbindung testen" - Sie sehen dann sofort, was ankommt.';

function feld(felder: TemplateField[], key: string): TemplateField | undefined {
  return felder.find((f) => f.key === key);
}
