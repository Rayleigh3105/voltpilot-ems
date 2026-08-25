/**
 * DIE VORSCHAU-ZEILE der Anlagen-Tabelle (Portfolio Revision 2, Scout
 * `data/vp-portfolio-konzept-r2` §5.2, Captain-Entscheid E1 „A · … mit
 * Vorschau-Zeile").
 *
 * Ein Klick auf eine Zeile klappt darunter auf, was die Anlage GERADE plant,
 * was Strom gerade kostet, was die Steuerung tut und wie es ihr geht — der
 * Betreiber triagiert eine rote Zeile, ohne die Flotte zu verlassen.
 *
 * ⚠ **Es entsteht hier keine einzige neue Aussage.** Jede Zeile ist eine
 * KOMPOSITION bestehender, anderswo geprüfter Ableitungen — der Plan-Satz aus
 * `schedule.planSentence` (derselbe, den die Anlagen-Seite als Mini-Vorschau
 * rendert), das Preis-Fenster aus `preisFenster` (dasselbe, das die
 * Marktpreis-Seite als Band zeichnet), der Steuerungs-Satz aus
 * `control.controlStrip` (derselbe, den Cockpit und Fahrplan-Seite rendern)
 * und der Zustand aus `health.healthChecklist`. Zwei Formulierungen über
 * dieselbe Sache wären zwei Wahrheiten — genau der Befund, gegen den diese
 * Revision gebaut ist.
 *
 * Reines Logikmodul: keine React-Importe, kein Netzwerk, keine Uhr ausser der
 * übergebenen.
 */
import type { ControlStatus, OverviewSite, PlantKind, SchedulePlan } from './api';
import { controlReasonSlot, controlStrip } from './control';
import { ctPerKwh } from './format';
import { healthChecklist, type HealthItem } from './health';
import { ctReihe, fensterFuerSlot, fensterWort, preisFenster } from './preisFenster';
import { planSentence, todaySlots } from './schedule';

/** Eine Zeile der Vorschau: Etikett + Aussage. */
export interface VorschauZeile {
  key: 'plan' | 'preis' | 'steuerung' | 'zustand';
  label: string;
  text: string;
  /** Ein ruhiges Etikett neben der Aussage („Geplant"); null = keines. */
  tag?: string | null;
  ton?: 'ruhig' | 'warn';
}

export interface VorschauInput {
  site: OverviewSite;
  plan: SchedulePlan | null;
  control: ControlStatus | null;
  plantKind: PlantKind;
  now: Date;
}

/**
 * Der Satz „Heute geplant" — die EINE Plan-Ableitung des Hauses. Ohne Plan
 * wird nichts behauptet; die Zeile sagt dann, dass keiner vorliegt.
 */
function planZeile(input: VorschauInput): VorschauZeile {
  const slots = input.plan?.slots ?? [];
  const satz = planSentence(slots, input.plantKind, input.now);
  if (satz == null) {
    return {
      key: 'plan',
      label: 'Heute geplant',
      text: 'Für heute liegt noch kein Fahrplan vor.',
      tag: null,
    };
  }
  return { key: 'plan', label: 'Heute geplant', text: satz, tag: 'Geplant' };
}

/**
 * Der Börsenpreis der LAUFENDEN Viertelstunde plus seine Einordnung — beides
 * aus dem Plan, den die Zeile ohnehin geladen hat (kein zweiter Abruf).
 *
 * ⚠ Die Einordnung („die günstigsten 2½ Stunden") kommt aus derselben
 * `preisFenster`-Entscheidung, die die Marktpreis-Seite als Band zeichnet;
 * ohne Fenster (flacher Tag) steht dort nur der Preis — nie eine erfundene
 * Wertung. Ohne Preis gibt es die Zeile GAR NICHT.
 */
function preisZeile(input: VorschauInput): VorschauZeile | null {
  const slots = todaySlots(input.plan?.slots ?? [], input.now);
  const jetzt = controlReasonSlot(slots, input.now);
  if (jetzt == null || jetzt.priceEurMwh == null) return null;
  const cts = ctReihe(slots.map((s) => s.priceEurMwh));
  const index = slots.indexOf(jetzt);
  const fenster = preisFenster(cts, 15);
  const treffer = index >= 0 ? fensterFuerSlot(fenster, index) : null;
  const wort = treffer ? fensterWort(treffer.art, treffer.bis - treffer.von + 1, 15) : null;
  return {
    key: 'preis',
    label: 'Börsenpreis jetzt',
    text: wort
      ? `${ctPerKwh(Number(jetzt.priceEurMwh))} · ${wort}`
      : ctPerKwh(Number(jetzt.priceEurMwh)),
  };
}

/**
 * Der Steuerungs-Satz — wörtlich `control.controlStrip`, also derselbe, den
 * Cockpit und Fahrplan-Seite sagen. Ohne Rücklesen (204, ältere Box) sagt die
 * Zeile das, statt zu schweigen: der Betreiber muss wissen, ob er nichts sieht
 * oder ob nichts passiert.
 */
function steuerungsZeile(input: VorschauInput): VorschauZeile {
  const erwartet = (input.plan?.slots.length ?? 0) > 0 && input.plan?.deviceId != null;
  const view = controlStrip(input.control, input.now, erwartet);
  if (view == null) {
    return {
      key: 'steuerung',
      label: 'Steuerung',
      text: 'Diese Anlage meldet keinen Sollwert zurück.',
      ton: 'ruhig',
    };
  }
  return {
    key: 'steuerung',
    label: 'Steuerung',
    text: view.sentence,
    ton: view.tone === 'warn' ? 'warn' : 'ruhig',
  };
}

/**
 * Der Zustand in EINEM Satz — die Checkliste des Hauses, zusammengefasst.
 * Warnungen führen (die Checkliste sortiert sie nach vorn); ist alles in
 * Ordnung, sagt sie das ohne Aufzählung.
 */
function zustandsZeile(input: VorschauInput): VorschauZeile {
  const slots = input.plan?.slots ?? [];
  const items: HealthItem[] = healthChecklist({
    deviceCount: input.site.deviceCount,
    onlineCount: input.site.onlineCount,
    waitingCount: input.site.waitingCount,
    hasPlanToday: todaySlots(slots, input.now).length > 0,
    hasAnyPlan: slots.length > 0,
    controlState: null,
    batteryWithoutDevice: input.site.batteryWithoutDevice === true,
    batteryLinked: false,
  });
  const auffaellig = items.filter((i) => i.state !== 'ok');
  if (auffaellig.length === 0) {
    return { key: 'zustand', label: 'Zustand', text: 'Gerät und Fahrplan: in Ordnung.' };
  }
  return {
    key: 'zustand',
    label: 'Zustand',
    text: auffaellig.map((i) => `${i.label}: ${i.detail}`).join(' · '),
    ton: auffaellig.some((i) => i.state === 'warn') ? 'warn' : 'ruhig',
  };
}

/**
 * Die Zeilen der Vorschau in Lese-Reihenfolge. Eine Zeile ohne Aussage
 * erscheint gar nicht — nie ein „—" als Dauerzustand.
 */
export function vorschauZeilen(input: VorschauInput): VorschauZeile[] {
  return [planZeile(input), preisZeile(input), steuerungsZeile(input), zustandsZeile(input)].filter(
    (z): z is VorschauZeile => z != null,
  );
}

/** Der Absprung am Ende der Vorschau. */
export const VORSCHAU_ABSPRUNG = 'Cockpit öffnen';
