import { describe, expect, it } from 'vitest';
import { NBSP } from './format';
import type { LiveSnapshot } from './live';
import {
  FLOW_CONFLICT_MIN_STREAK,
  feedInFullCause,
  feedInLimitReached,
  flowConflict,
  flowConflictCandidate,
  flowConflictLine,
  flowConflictView,
  stepFlowConflict,
  type FlowConflictInput,
} from './flowConflict';

/**
 * Der Flussabgleich (Scout `vp-verkauf-praemisse-s8` §3): eine register-
 * bestätigte, aber nicht fließende Batterie-Order darf nicht als „bestätigt/
 * planmäßig" durchgehen. Der ANKER dieser Suite sind die echten Pilsting-Zahlen
 * vom 10.08.2026 - commanded −30 (entladen), gemessener Batteriefluss +3,3
 * (laden), Einspeisung 30,0 kW an einer gepflegten 30-kW-Grenze.
 *
 * Vorzeichen sind der gefährlichste Teil, deshalb stehen sie zuerst.
 */

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  // Standard: eine ganz normale, konfliktfreie Entladung. `battKw` ist absichtlich
  // NICHT der Prüfwert - der Abgleich leitet ihn aus pv/load/grid ab (die
  // GEZEIGTEN Kanäle), damit ein fehlender Kanal echt zu „nicht vergleichen" führt.
  return { pvKw: 1, loadKw: 7.1, gridKw: 0, battKw: -6.1, socPct: 78, socAt: null, ...over };
}

function input(over: Partial<FlowConflictInput> = {}): FlowConflictInput {
  return {
    commandedKw: -6.1,
    snapshot: snap(),
    snapshotFresh: true,
    executionMode: null,
    maxFeedInKw: null,
    ...over,
  };
}

/** Der Pilsting-Vektor: commanded −30, gemessener Fluss +3,3 (laden). */
function pilsting(over: Partial<FlowConflictInput> = {}): FlowConflictInput {
  return input({
    commandedKw: -30,
    // battery = grid − load + pv = −30 − 6,3 + 39,6 = +3,3 (laden); Einspeisung 30,0.
    snapshot: snap({ pvKw: 39.6, loadKw: 6.3, gridKw: -30, battKw: 3.3, socPct: 12 }),
    ...over,
  });
}

/**
 * Der PAUSEN-Vektor (Live-Lage Pilsting/Herzogau 24.08.2026): commanded ≈ 0
 * (Pause), gemessen +10,0 kW LADEN an der vollen 30-kW-Einspeisegrenze.
 * PV 46,3 − Haus 5,1 − Netz 31,2 (Einspeisung) ⇒ Batterie +10,0.
 */
function pause(over: Partial<FlowConflictInput> = {}): FlowConflictInput {
  return input({
    commandedKw: 0,
    // battery = grid − load + pv = −31,2 − 5,1 + 46,3 = +10,0 (laden).
    snapshot: snap({ pvKw: 46.3, loadKw: 5.1, gridKw: -31.2, battKw: 10, socPct: 55 }),
    maxFeedInKw: 30,
    ...over,
  });
}

describe('flowConflictCandidate · Vorzeichen und die zwei Auslöser', () => {
  it('erkennt den Pilsting-Richtungswiderspruch (commanded −30, gemessen +3,3)', () => {
    const c = flowConflictCandidate(pilsting());
    expect(c).not.toBeNull();
    expect(c?.kind).toBe('direction');
    expect(c?.commandedDir).toBe('entladen');
    expect(c?.measuredDir).toBe('laden');
    expect(c?.commandedKw).toBe(-30);
    expect(c?.measuredKw).toBeCloseTo(3.3, 5);
  });

  it('spiegelt für die Ladeseite (commanded +10, gemessen entlädt)', () => {
    // battery = −5 − 3 + 6 = −2 (entladen), commanded +10 (laden).
    const c = flowConflictCandidate(input({ commandedKw: 10, snapshot: snap({ pvKw: 6, loadKw: 3, gridKw: -5 }) }));
    expect(c?.kind).toBe('direction');
    expect(c?.commandedDir).toBe('laden');
    expect(c?.measuredDir).toBe('entladen');
  });

  it('erkennt einen FEHLBETRAG in derselben Richtung (fließt deutlich weniger)', () => {
    // battery = 0 − 5 + 0 = −5 (entladen, aber schwach), commanded −30.
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0, loadKw: 5, gridKw: 0 }) }));
    expect(c?.kind).toBe('shortfall');
    expect(c?.measuredDir).toBe('entladen');
    expect(c?.measuredKw).toBeCloseTo(-5, 5);
  });

  it('erkennt „fließt gar nicht" als Fehlbetrag (Messung keine Bewegung)', () => {
    // battery = 0 − 0 + 0 = 0 (pausiert), commanded −30.
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0, loadKw: 0, gridKw: 0 }) }));
    expect(c?.kind).toBe('shortfall');
    expect(c?.measuredDir).toBe('pausieren');
  });

  it('eine winzige Gegenbewegung (< 0,5 kW) ist KEIN Richtungswiderspruch, aber ein Fehlbetrag', () => {
    // battery = +0,2 (laden, winzig), commanded −30.
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0.2, loadKw: 0, gridKw: 0 }) }));
    expect(c?.kind).toBe('shortfall');
  });

  it('schweigt, wenn Richtung UND Betrag stimmen (commanded −6,1, gemessen −6,1)', () => {
    expect(flowConflictCandidate(input())).toBeNull();
  });

  it('schweigt bei einem kleinen Fehlbetrag unter der Schwelle (max(2 kW, 50 %))', () => {
    // commanded −30, gemessen −28 → Fehlbetrag 2 ≤ max(2, 15). Kein Konflikt.
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0, loadKw: 28, gridKw: 0 }) }));
    expect(c).toBeNull();
  });

  it('schweigt bei einem winzigen angewiesenen Wert (< 1 kW = Rauschen)', () => {
    const c = flowConflictCandidate(input({ commandedKw: -0.8, snapshot: snap({ pvKw: 0, loadKw: 0, gridKw: 0 }) }));
    expect(c).toBeNull();
  });

  it('schweigt in einem NACHFÜHRUNGS-Modus (inkl. Vollakku-Entlastung)', () => {
    for (const mode of [
      'follow', 'trim', 'absorb', 'idle_follow', 'high_soc_follow', 'high_soc_charge', 'autonomous_discharge',
      'autonomous_charge', 'autonomous_selfconsumption',
    ] as const) {
      expect(flowConflictCandidate(pilsting({ executionMode: mode }))).toBeNull();
    }
    // 'plan'/'fallback' schließen den Abgleich NICHT aus.
    expect(flowConflictCandidate(pilsting({ executionMode: 'plan' }))).not.toBeNull();
    expect(flowConflictCandidate(pilsting({ executionMode: 'fallback' }))).not.toBeNull();
  });

  it('vergleicht NICHT bei fehlendem Kanal (unbekannt ≠ 0)', () => {
    expect(flowConflictCandidate(pilsting({ snapshot: snap({ pvKw: null, loadKw: 6.3, gridKw: -30 }) }))).toBeNull();
    expect(flowConflictCandidate(pilsting({ snapshot: snap({ pvKw: 39.6, loadKw: null, gridKw: -30 }) }))).toBeNull();
    expect(flowConflictCandidate(pilsting({ snapshot: snap({ pvKw: 39.6, loadKw: 6.3, gridKw: null }) }))).toBeNull();
  });

  it('vergleicht NICHT ohne frische Messung oder ohne Sollwert', () => {
    expect(flowConflictCandidate(pilsting({ snapshotFresh: false }))).toBeNull();
    expect(flowConflictCandidate(pilsting({ snapshot: null }))).toBeNull();
    expect(flowConflictCandidate(pilsting({ commandedKw: null }))).toBeNull();
  });
});

describe('flowConflictCandidate · der PAUSEN-Fall (commanded ≈ 0, fließt aber)', () => {
  it('erkennt Pause + deutliches Laden (commanded 0, gemessen +10,0)', () => {
    const c = flowConflictCandidate(pause());
    expect(c?.kind).toBe('pause');
    expect(c?.commandedDir).toBe('pausieren');
    expect(c?.measuredDir).toBe('laden');
    expect(c?.measuredKw).toBeCloseTo(10, 5);
  });

  it('erkennt Pause + Entladen', () => {
    // battery = 0 − 8 + 0 = −8 (entladen), commanded 0.
    const c = flowConflictCandidate(pause({ snapshot: snap({ pvKw: 0, loadKw: 8, gridKw: 0 }) }));
    expect(c?.kind).toBe('pause');
    expect(c?.measuredDir).toBe('entladen');
  });

  it('schweigt bei kleinem Fluss unter 2 kW (Ausgleichs-Rauschen während der Pause)', () => {
    // battery = 0 − 0 + 1,5 = +1,5 kW (< FLOW_CONFLICT_MIN_PAUSE_FLOW_KW).
    expect(
      flowConflictCandidate(pause({ snapshot: snap({ pvKw: 1.5, loadKw: 0, gridKw: 0 }) })),
    ).toBeNull();
  });

  it('behandelt einen Sollwert zwischen 0,05 und 1 kW weder als Pause noch als Order', () => {
    // commandedDir laden (> 0,05), aber |commanded| < 1 → Rauschen, kein Kandidat.
    expect(flowConflictCandidate(pause({ commandedKw: 0.4 }))).toBeNull();
  });

  it('schweigt in einem NACHFÜHRUNGS-Modus auch bei Pause', () => {
    for (const mode of [
      'follow', 'trim', 'absorb', 'idle_follow', 'high_soc_follow', 'high_soc_charge', 'autonomous_discharge',
      'autonomous_charge', 'autonomous_selfconsumption',
    ] as const) {
      expect(flowConflictCandidate(pause({ executionMode: mode }))).toBeNull();
    }
  });

  it('vergleicht auch im Pausen-Fall NICHT bei fehlendem Kanal oder unfrischer Messung', () => {
    expect(flowConflictCandidate(pause({ snapshot: snap({ pvKw: null }) }))).toBeNull();
    expect(flowConflictCandidate(pause({ snapshotFresh: false }))).toBeNull();
  });
});

describe('flowConflict · die drei Pilsting-Pausenlagen', () => {
  it('Pause + an der Kappe ladend → INFO (grün), freundlicher Satz ohne „im Blick behalten"', () => {
    const v = flowConflict(pause(), FLOW_CONFLICT_MIN_STREAK);
    expect(v?.severity).toBe('info');
    expect(v?.text).toBe(
      `Der Speicher pausiert planmäßig – nimmt aber gerade 10,0${NBSP}kW Überschuss auf, ` +
        `weil Ihre Einspeisegrenze (30${NBSP}kW) erreicht ist. Dieser Strom wäre sonst verloren.`,
    );
    expect(v?.text).not.toContain('Bitte im Blick behalten');
  });

  it('Pause + ladend OHNE gepflegte Grenze → WARN (bernstein), ursachenfrei', () => {
    const v = flowConflict(pause({ maxFeedInKw: null }), FLOW_CONFLICT_MIN_STREAK);
    expect(v?.severity).toBe('warn');
    expect(v?.text).toBe(
      `Pause angewiesen – der Speicher lädt aber 10,0${NBSP}kW (Messung). Bitte im Blick behalten.`,
    );
    expect(v?.text).not.toContain('Einspeisegrenze');
  });

  it('Pause + ladend, Grenze aber NICHT erreicht (75) → WARN', () => {
    const v = flowConflict(pause({ maxFeedInKw: 75 }), FLOW_CONFLICT_MIN_STREAK);
    expect(v?.severity).toBe('warn');
    expect(v?.text).toContain('Pause angewiesen');
  });

  it('Pause + ENTLADEN → WARN, nie Info (auch MIT gepflegter Grenze)', () => {
    const v = flowConflict(
      pause({ snapshot: snap({ pvKw: 0, loadKw: 8, gridKw: 0 }), maxFeedInKw: 30 }),
      FLOW_CONFLICT_MIN_STREAK,
    );
    expect(v?.severity).toBe('warn');
    expect(v?.text).toBe(
      `Pause angewiesen – der Speicher entlädt aber 8,0${NBSP}kW (Messung). Bitte im Blick behalten.`,
    );
  });

  it('behauptet auch im Pausen-Fall NICHTS unter der Serien-Schwelle', () => {
    expect(flowConflict(pause(), FLOW_CONFLICT_MIN_STREAK - 1)).toBeNull();
  });

  it('der ORDER-Widerspruch trägt severity warn (unverändert)', () => {
    expect(flowConflict(pilsting({ maxFeedInKw: 30 }), FLOW_CONFLICT_MIN_STREAK)?.severity).toBe(
      'warn',
    );
  });
});

describe('feedInLimitReached', () => {
  it('liefert die Grenze, wenn die gemessene Einspeisung sie (nahezu) erreicht', () => {
    expect(feedInLimitReached(snap({ gridKw: -31.2 }), 30)).toBe(30);
    expect(feedInLimitReached(snap({ gridKw: -29 }), 30)).toBe(30); // genau an der 1-kW-Marge
  });

  it('null, wenn die Einspeisung deutlich darunter liegt', () => {
    expect(feedInLimitReached(snap({ gridKw: -20 }), 30)).toBeNull();
  });

  it('null ohne gepflegte Grenze oder ohne Einspeisung', () => {
    expect(feedInLimitReached(snap({ gridKw: -31.2 }), null)).toBeNull();
    expect(feedInLimitReached(snap({ gridKw: 5 }), 30)).toBeNull();
  });
});

describe('flowConflictLine · der bernstein Beobachtungs-Satz', () => {
  it('nennt den Pilsting-Fall Wort für Wort', () => {
    const line = flowConflictLine(flowConflictCandidate(pilsting())!);
    expect(line).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber nicht (Messung: lädt 3,3${NBSP}kW).`,
    );
  });

  it('formuliert die Ladeseite spiegelbildlich', () => {
    const c = flowConflictCandidate(input({ commandedKw: 10, snapshot: snap({ pvKw: 6, loadKw: 3, gridKw: -5 }) }))!;
    expect(flowConflictLine(c)).toBe(
      `Ladung angewiesen (10,0${NBSP}kW) - der Speicher lädt aber nicht (Messung: entlädt 2,0${NBSP}kW).`,
    );
  });

  it('sagt „deutlich weniger" bei gleicher Richtung mit Fehlbetrag', () => {
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0, loadKw: 5, gridKw: 0 }) }))!;
    expect(flowConflictLine(c)).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber deutlich weniger (Messung: 5,0${NBSP}kW).`,
    );
  });

  it('sagt „keine Bewegung", wenn nichts fließt', () => {
    const c = flowConflictCandidate(input({ commandedKw: -30, snapshot: snap({ pvKw: 0, loadKw: 0, gridKw: 0 }) }))!;
    expect(flowConflictLine(c)).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber nicht (Messung: keine Bewegung).`,
    );
  });
});

describe('feedInFullCause · die Ursache nur, wenn belegbar', () => {
  it('bei gepflegter Grenze UND gemessener Einspeisung an der Grenze', () => {
    expect(feedInFullCause(snap({ gridKw: -30 }), 30)).toBe(
      `Ihr Netzanschluss ist voll (Einspeisegrenze 30${NBSP}kW erreicht).`,
    );
  });

  it('KEINE Ursache, wenn die gepflegte Grenze weit über der Einspeisung liegt (75)', () => {
    expect(feedInFullCause(snap({ gridKw: -30 }), 75)).toBeNull();
  });

  it('KEINE Ursache ohne gepflegte Grenze', () => {
    expect(feedInFullCause(snap({ gridKw: -30 }), null)).toBeNull();
    expect(feedInFullCause(snap({ gridKw: -30 }), undefined)).toBeNull();
  });

  it('KEINE Ursache, wenn gar nicht eingespeist wird (Netzbezug)', () => {
    expect(feedInFullCause(snap({ gridKw: 5 }), 30)).toBeNull();
    expect(feedInFullCause(snap({ gridKw: null }), 30)).toBeNull();
  });

  it('formatiert eine krumme Grenze mit einer Nachkommastelle', () => {
    expect(feedInFullCause(snap({ gridKw: -30 }), 29.5)).toBe(
      `Ihr Netzanschluss ist voll (Einspeisegrenze 29,5${NBSP}kW erreicht).`,
    );
  });
});

describe('stepFlowConflict · Entprellung', () => {
  it('zählt konfliktbehaftete Beobachtungen hoch und deckelt', () => {
    let s = 0;
    s = stepFlowConflict(s, true); // 1
    expect(s).toBe(1);
    s = stepFlowConflict(s, true); // 2
    expect(s).toBe(2);
    s = stepFlowConflict(s, true); // 3 (= Schwelle)
    expect(s).toBe(FLOW_CONFLICT_MIN_STREAK);
    s = stepFlowConflict(s, true); // gedeckelt bei 3
    expect(s).toBe(FLOW_CONFLICT_MIN_STREAK);
  });

  it('setzt bei einer konfliktFREIEN Beobachtung sofort zurück', () => {
    expect(stepFlowConflict(3, false)).toBe(0);
    expect(stepFlowConflict(1, false)).toBe(0);
  });
});

describe('flowConflict · das entprellte Ergebnis (die EINE Ableitung beider Flächen)', () => {
  it('behauptet NICHTS unterhalb der Serien-Schwelle - ein Messversatz gebiert keinen Alarm', () => {
    expect(flowConflict(pilsting(), 0)).toBeNull();
    expect(flowConflict(pilsting(), 1)).toBeNull();
    expect(flowConflict(pilsting(), FLOW_CONFLICT_MIN_STREAK - 1)).toBeNull();
  });

  it('meldet den Pilsting-Konflikt MIT Netzanschluss-voll-Zusatz (Grenze 30 gepflegt)', () => {
    const v = flowConflict(pilsting({ maxFeedInKw: 30 }), FLOW_CONFLICT_MIN_STREAK);
    expect(v).not.toBeNull();
    expect(v?.cause).toBe(`Ihr Netzanschluss ist voll (Einspeisegrenze 30${NBSP}kW erreicht).`);
    expect(v?.text).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber nicht (Messung: lädt 3,3${NBSP}kW). ` +
        `Ihr Netzanschluss ist voll (Einspeisegrenze 30${NBSP}kW erreicht). Bitte im Blick behalten.`,
    );
  });

  it('meldet DIESELBEN Zahlen mit Grenze 75 als Konflikt OHNE Ursachen-Zusatz', () => {
    const v = flowConflict(pilsting({ maxFeedInKw: 75 }), FLOW_CONFLICT_MIN_STREAK);
    expect(v).not.toBeNull();
    expect(v?.cause).toBeNull();
    expect(v?.text).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber nicht (Messung: lädt 3,3${NBSP}kW). ` +
        'Bitte im Blick behalten.',
    );
    expect(v?.text).not.toContain('Netzanschluss');
  });

  it('meldet ohne gepflegte Grenze einen ursachenfreien Satz', () => {
    const v = flowConflict(pilsting({ maxFeedInKw: null }), FLOW_CONFLICT_MIN_STREAK);
    expect(v?.cause).toBeNull();
    expect(v?.text).not.toContain('Netzanschluss');
    expect(v?.text).toContain('Bitte im Blick behalten.');
  });

  it('blendet den Konflikt SOFORT aus, sobald der aktuelle Befund fehlt (eine saubere Messung)', () => {
    // Serie schon bei 3, aber diese Beobachtung ist konfliktfrei → kein Text.
    const clean = input({ commandedKw: -6.1 }); // Richtung + Betrag stimmen
    expect(flowConflict(clean, FLOW_CONFLICT_MIN_STREAK)).toBeNull();
  });

  it('ist die EINE Wahrheit beider Flächen: derselbe Befund entzieht dem Cockpit-Speicherknoten den Haken', () => {
    // Der Cockpit-Haken hängt an `controlView.state === "healthy" && !cockpitFlowConflict`
    // (`AnlagenPage`), wobei `cockpitFlowConflict = flowConflict(...) != null`. Für den
    // Pilsting-Vektor ist das `true` ⇒ `healthy && !true = false` ⇒ kein Haken.
    const cockpitFlowConflict = flowConflict(pilsting({ maxFeedInKw: 30 }), FLOW_CONFLICT_MIN_STREAK) != null;
    expect(cockpitFlowConflict).toBe(true);
    // Eine wirklich fließende Order lässt den Haken (kein Konflikt).
    const clean = input({ commandedKw: -6.1 });
    expect(flowConflict(clean, FLOW_CONFLICT_MIN_STREAK) != null).toBe(false);
  });

  it('flowConflictView fügt Beobachtung + Ursache + Hinweis zu EINEM Text', () => {
    const c = flowConflictCandidate(pilsting())!;
    const v = flowConflictView(c, FLOW_CONFLICT_MIN_STREAK, pilsting({ maxFeedInKw: 30 }));
    expect(v?.observation).toBe(
      `Entladung angewiesen (30,0${NBSP}kW) - der Speicher entlädt aber nicht (Messung: lädt 3,3${NBSP}kW).`,
    );
    expect(v?.text.endsWith('Bitte im Blick behalten.')).toBe(true);
    // Kein Kandidat ⇒ nie ein Ergebnis, egal wie lang die Serie ist.
    expect(flowConflictView(null, 99, pilsting())).toBeNull();
  });
});
