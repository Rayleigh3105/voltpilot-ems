import { describe, expect, it } from 'vitest';
import {
  ANBINDEN_EINSTIEG,
  aktivierenFolgen,
  ausfallSchutz,
  budgetBand,
  chargerName,
  chargerView,
  connectorName,
  failsafeSum,
  grenzeFehler,
  idleLine,
  ladevorgangRows,
  ladeZustand,
  asPolicy,
  asStorage,
  BOOST_INTRO,
  boostbar,
  boostFolgen,
  kombinationsStreifen,
  POLICY_DEFAULT,
  POLICY_LABEL,
  PV_UEBERSCHUSS_OHNE_PV,
  sonnenDeckung,
  surplusLine,
  turnIn,
  ueberschussVerfuegbar,
  type ChargePoint,
  type ChargingBudget,
} from './ladepunkte';

/**
 * Das Beispiel-Szenario der abgenommenen Mockups, 13:24 Uhr: 277 kW Anschluss,
 * 10 % Sicherheitsabstand, 167 kW Gebäude → 82,3 kW Ladebudget, drei Säulen à
 * zwei Steckern, zwei laden, einer wartet.
 */
const budget: ChargingBudget = {
  deviceId: 'd1',
  enabled: true,
  controlEnabled: true,
  gridLimitKw: 277,
  effLimitKw: 277,
  marginPct: 10,
  minPowerKw: 30,
  budgetKw: 82.3,
  allocatedKw: 82,
  measuredKw: 79,
  siteLoadKw: 167,
  siteGridKw: 246,
  budgetMode: 'gemessen',
  budgetNote: 'Das Budget folgt der Messung am Netzanschluss.',
  budgetBlind: false,
  safeDefaultKw: 15,
  safeDefaultHolds: true,
  safeWorstCaseKw: 270,
  maxHouseLoadKw: 180,
  connectorCount: 6,
};

const saeule = (over: Partial<ChargePoint> = {}): ChargePoint => ({
  deviceId: 'd1',
  chargePointId: 'saeule-1',
  label: 'Hof Nord',
  priority: false,
  connected: true,
  ready: true,
  connectors: [],
  ...over,
});

describe('budgetBand', () => {
  it('zeigt die Bühne der Mockups mit Grenze, Segmenten und Kernaussage', () => {
    const band = budgetBand(budget)!;
    expect(band.limitKw).toBe(277);
    expect(band.headline).toBe('246 kW von 277 kW');
    expect(band.segments.map((s) => s.id)).toEqual(['gebaeude', 'laden', 'abstand', 'frei']);
    // Der Sicherheitsabstand ist schraffiert UND beschriftet (K10).
    expect(band.segments.find((s) => s.id === 'abstand')).toMatchObject({
      hatched: true,
      label: 'Sicherheitsabstand',
    });
    expect(band.line).toContain('Ihr Anschluss ist geschützt');
    // ⚠ Der Satz der BOX wird durchgereicht, nie neu formuliert.
    expect(band.sourceLine).toBe('Das Budget folgt der Messung am Netzanschluss.');
  });

  it('behauptet ohne Anschlussgrenze KEIN Band, sondern nennt die Lücke', () => {
    const band = budgetBand({ ...budget, gridLimitKw: null, effLimitKw: null })!;
    expect(band.limitKw).toBeNull();
    expect(band.headline).toBeNull();
    expect(band.line).toContain('Anschlussgrenze ist noch nicht hinterlegt');
  });

  it('erfindet ohne gemessene Gebäudelast kein Gebäude-Segment', () => {
    const band = budgetBand({ ...budget, siteLoadKw: null })!;
    expect(band.segments.some((s) => s.id === 'gebaeude')).toBe(false);
    expect(band.line).toContain('misst diese Anlage noch nicht');
  });

  it('ohne Budget-Block gibt es gar kein Band', () => {
    expect(budgetBand(null)).toBeNull();
  });
});

describe('ladevorgangRows', () => {
  const laden = saeule({
    connectors: [
      {
        connectorId: 1,
        status: 'Charging',
        charging: true,
        allocatedKw: 41,
        powerKw: 40,
        socPct: 62,
        reasonText: 'lädt',
        sessionSince: '2026-08-20T08:41:00Z',
      },
      {
        connectorId: 2,
        status: 'Preparing',
        charging: false,
        allocatedKw: 0,
        reasonText: 'wartet - Budget vergeben',
        nextTurn: '2026-08-20T11:26:00Z',
        sessionSince: '2026-08-20T09:10:00Z',
      },
    ],
  });

  it('trägt Wort, Grund und Zahlen - und nennt den Stecker beim Namen', () => {
    const rows = ladevorgangRows([laden], Date.parse('2026-08-20T11:24:00Z'));
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Hof Nord · Stecker A');
    expect(rows[0].word).toBe('Lädt');
    expect(rows[0].tone).toBe('laedt');
    // Der Grund wiederholt das Wort NICHT - zweimal „lädt" ist Rauschen.
    expect(rows[0].reason).toBeNull();
    expect(rows[0].powerKw).toBe(40);
    expect(rows[0].socPct).toBe(62);
    // Warten ist kein Fehler: grau, aber IMMER mit Grund und Termin.
    // Das Wort kommt aus dem OCPP-Status (`Preparing`), nicht aus `charging`.
    expect(rows[1].word).toBe('Auto eingesteckt · startet');
    expect(rows[1].tone).toBe('ruhig');
    expect(rows[1].reason).toBe('wartet - Budget vergeben');
    expect(rows[1].nextTurn).toBe('dran in ca. 2 Min.');
  });

  it('behauptet für eine getrennte Säule GAR NICHTS', () => {
    expect(ladevorgangRows([{ ...laden, connected: false }])).toEqual([]);
  });

  it('macht aus einem fehlenden Messwert keine 0', () => {
    const rows = ladevorgangRows([
      saeule({ connectors: [{ connectorId: 1, status: 'Available', charging: false }] }),
    ]);
    expect(rows[0].powerKw).toBeNull();
    expect(rows[0].allocatedKw).toBeNull();
    expect(rows[0].socPct).toBeNull();
  });

  it('sagt den Leerlauf ehrlich statt Nullzeilen zu erfinden', () => {
    const line = idleLine({
      budget,
      chargers: [saeule({ connectors: [{ connectorId: 1, status: 'Available', charging: false }] })],
    });
    expect(line).toBe('Gerade lädt niemand - alle 6 Stecker sind frei.');
    // Sobald einer lädt, gibt es keinen Leerlauf-Satz mehr.
    expect(idleLine({ budget, chargers: [laden] })).toBeNull();
  });
});

describe('ladeZustand - der OCPP-Status entscheidet das Wort', () => {
  const con = (over: Partial<Parameters<typeof ladeZustand>[0]> = {}) => ({
    connectorId: 1,
    charging: false,
    ...over,
  });
  const saeuleAn = { connected: true, lastSeen: '2026-08-20T09:12:00Z' };

  // ⚠ DER BEFUND, der diesen Fix ausgelöst hat: die Box hält `charging` auch
  // für eine Säule auf TRUE, die UNSER Lastmanagement gerade auf 0 kW hält.
  it('sagt NICHT „lädt" über ein Auto, das wir gerade ausbremsen', () => {
    const z = ladeZustand(
      con({
        status: 'SuspendedEVSE',
        charging: true, // die Box: die Sitzung lebt, die Zuteilung bleibt
        allocatedKw: 0,
        powerKw: null, // diese Säule meldet gar keine MeterValues
        reason: 'budget',
        reasonText: 'wartet - Budget vergeben',
      }),
      saeuleAn,
    );
    expect(z.kind).toBe('wartet');
    expect(z.word).toBe('Eingesteckt · wartet');
    expect(z.word).not.toMatch(/[Ll]ädt/);
    expect(z.tone).toBe('ruhig');
    // Der Grund der Box steht daneben - Wort und Grund widersprechen sich nicht mehr.
    expect(z.reason).toBe('wartet - Budget vergeben');
    expect(z.reasonCode).toBe('budget');
  });

  it('trennt „wir halten sie an" von „sie hält selbst an"', () => {
    const eigen = ladeZustand(
      con({ status: 'SuspendedEVSE', charging: true, allocatedKw: 11 }),
      saeuleAn,
    );
    expect(eigen.kind).toBe('saeule_pausiert');
    expect(eigen.word).toBe('Eingesteckt · Säule pausiert');
    expect(eigen.tone).toBe('ruhig');
  });

  it('lädt nur bei `Charging` mit gemessener Leistung', () => {
    const z = ladeZustand(con({ status: 'Charging', charging: true, powerKw: 11 }), saeuleAn);
    expect(z.kind).toBe('laedt');
    expect(z.word).toBe('Lädt');
    expect(z.tone).toBe('laedt');
  });

  it('nennt die fehlende Messung, statt eine Vorgabe als Ersatz zu zeigen', () => {
    const z = ladeZustand(
      con({ status: 'Charging', charging: true, powerKw: null, allocatedKw: 11 }),
      saeuleAn,
    );
    expect(z.kind).toBe('laedt_ohne_messung');
    expect(z.word).toBe('Lädt — Leistung nicht messbar');
    expect(z.tone).toBe('laedt');
  });

  it('sagt bei `Charging` mit 0 kW ehrlich, dass nichts fließt', () => {
    const z = ladeZustand(con({ status: 'Charging', charging: true, powerKw: 0 }), saeuleAn);
    expect(z.kind).toBe('nimmt_nichts');
    expect(z.word).toBe('Eingesteckt · nimmt gerade keinen Strom');
    expect(z.tone).toBe('ruhig');
  });

  it('rät bei `SuspendedEV` nicht, WARUM das Auto pausiert', () => {
    const z = ladeZustand(con({ status: 'SuspendedEV', charging: true }), saeuleAn);
    expect(z.kind).toBe('auto_pausiert');
    expect(z.word).toBe('Auto pausiert');
    expect(z.detail).toBe('voll oder Auto-Timer');
    expect(z.tone).toBe('ruhig');
  });

  it('kennt Available, Preparing, Finishing, Reserved', () => {
    expect(ladeZustand(con({ status: 'Available' }), saeuleAn)).toMatchObject({
      kind: 'frei',
      word: 'Kein Auto eingesteckt',
      tone: 'ruhig',
    });
    expect(ladeZustand(con({ status: 'Preparing' }), saeuleAn)).toMatchObject({
      kind: 'startet',
      word: 'Auto eingesteckt · startet',
      tone: 'ruhig',
    });
    // Fertig ist nicht ladend - deshalb GRAU, nicht grün.
    expect(ladeZustand(con({ status: 'Finishing' }), saeuleAn)).toMatchObject({
      kind: 'beendet',
      word: 'Ladung beendet · Auto noch eingesteckt',
      tone: 'ruhig',
    });
    expect(ladeZustand(con({ status: 'Reserved' }), saeuleAn)).toMatchObject({
      kind: 'reserviert',
      word: 'Reserviert',
      tone: 'ruhig',
    });
  });

  it('trennt eine Störung von „nicht verfügbar"', () => {
    const kaputt = ladeZustand(con({ status: 'Faulted' }), saeuleAn);
    expect(kaputt.kind).toBe('stoerung');
    expect(kaputt.word).toBe('Störung an der Säule');
    expect(kaputt.tone).toBe('stoerung');
    // ⚠ `Unavailable` ist KEINE Störung - die Säule ist bloß abgemeldet.
    const aus = ladeZustand(con({ status: 'Unavailable' }), saeuleAn);
    expect(aus.kind).toBe('nicht_verfuegbar');
    expect(aus.word).toBe('Nicht verfügbar');
    expect(aus.tone).toBe('ruhig');
  });

  it('behauptet über eine getrennte Säule nichts als ihren letzten Kontakt', () => {
    const z = ladeZustand(con({ status: 'Charging', charging: true, powerKw: 11 }), {
      connected: false,
      lastSeen: '2026-08-20T09:12:00Z',
    });
    expect(z.kind).toBe('getrennt');
    expect(z.word).toBe('Säule getrennt');
    expect(z.tone).toBe('stoerung');
    expect(z.detail).toMatch(/^zuletzt \d{2}:\d{2}$/);
    // Ohne letzten Kontakt wird keine Uhrzeit erfunden.
    expect(ladeZustand(con({}), { connected: false, lastSeen: null }).detail).toBeNull();
  });

  it('fällt OHNE gemeldeten Status auf das Flag zurück, statt zu raten', () => {
    // Der gefährliche Fall oben trägt seinen Status per Konstruktion - dieser
    // Rückfall macht das Loch also nicht wieder auf.
    expect(ladeZustand(con({ charging: true, powerKw: 11 }), saeuleAn).kind).toBe('laedt');
    expect(ladeZustand(con({ charging: false }), saeuleAn).kind).toBe('frei');
    expect(
      ladeZustand(con({ charging: false, sessionSince: '2026-08-20T09:00:00Z' }), saeuleAn).kind,
    ).toBe('wartet');
  });

  it('sagt „voll auf Ihren Wunsch" NUR über eine Ladung, die wirklich läuft', () => {
    expect(
      ladeZustand(con({ status: 'Charging', charging: true, powerKw: 22, boost: true }), saeuleAn)
        .word,
    ).toBe('Lädt voll auf Ihren Wunsch');
    // Ein ausgebremster Stecker trägt den Zusatz NICHT - das wäre dieselbe
    // Lüge in Grün.
    const gehalten = ladeZustand(
      con({ status: 'SuspendedEVSE', charging: true, allocatedKw: 0, boost: true }),
      saeuleAn,
    );
    expect(gehalten.word).toBe('Eingesteckt · wartet');
    expect(gehalten.tone).toBe('ruhig');
  });

  it('ist die EINE Wortquelle - die Zeile leitet nichts eigenes ab', () => {
    const c = {
      deviceId: 'd',
      chargePointId: 'saeule-1',
      priority: false,
      connected: true,
      ready: true,
      connectors: [
        con({ status: 'SuspendedEVSE', charging: true, allocatedKw: 0, reasonText: 'wartet - Budget vergeben' }),
      ],
    };
    const row = ladevorgangRows([c])[0];
    const z = ladeZustand(c.connectors[0], c);
    expect(row.kind).toBe(z.kind);
    expect(row.word).toBe(z.word);
    expect(row.tone).toBe(z.tone);
    expect(row.reason).toBe(z.reason);
  });
});

describe('turnIn', () => {
  it('nennt einen Termin nur, wenn einer gemeldet wurde', () => {
    expect(turnIn(null)).toBeNull();
    expect(turnIn('keine zeit')).toBeNull();
    expect(turnIn('2026-08-20T11:26:00Z', Date.parse('2026-08-20T11:24:00Z'))).toBe(
      'dran in ca. 2 Min.',
    );
    expect(turnIn('2026-08-20T11:24:00Z', Date.parse('2026-08-20T11:26:00Z'))).toBe(
      'dran in Kürze',
    );
  });
});

describe('chargerView', () => {
  it('nennt bei einer getrennten Säule die FOLGE, nicht nur die Tatsache', () => {
    const view = chargerView(saeule({ connected: false, lastSeen: '2026-08-20T10:00:00Z' }));
    expect(view.state).toBe('getrennt');
    expect(view.detail).toContain('Sicherheitsprofil');
  });

  it('nennt eine nie gesehene Säule normal - das ist die Einrichtung', () => {
    const view = chargerView(saeule({ connected: false, ready: false }));
    expect(view.state).toBe('nie_gesehen');
    expect(view.detail).toContain('normal');
  });

  it('nimmt den Namen des Betreibers, sonst die Kennung - nie einen erfundenen', () => {
    expect(chargerName(saeule())).toBe('Hof Nord');
    expect(chargerName(saeule({ label: '  ' }))).toBe('saeule-1');
    expect(connectorName(2)).toBe('Stecker B');
  });
});

describe('Ausfall-Schutz', () => {
  it('zeigt die RECHNUNG statt einer nackten Zahl', () => {
    expect(failsafeSum(budget)).toBe(
      '6 Stecker × 15 kW + höchste Gebäudelast 180 kW = 270 kW < Grenze 277 kW ✓',
    );
    const steps = ausfallSchutz(budget);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toContain('läuft nach 2 Minuten von selbst ab');
    expect(steps[2]).toContain('270 kW');
  });

  it('rechnet NICHT, wenn eine Zahl fehlt - und behauptet dann keine Summe', () => {
    expect(failsafeSum({ ...budget, maxHouseLoadKw: null })).toBeNull();
    const steps = ausfallSchutz({ ...budget, maxHouseLoadKw: null });
    expect(steps).toHaveLength(2);
  });

  it('sagt es, wenn die Rechnung NICHT aufgeht - „hält" wäre eine Lüge', () => {
    const sum = failsafeSum({ ...budget, safeDefaultHolds: false, safeWorstCaseKw: 300 })!;
    expect(sum).toContain('>');
    expect(sum).not.toContain('✓');
  });
});

describe('Aktivieren-Dialog', () => {
  it('nennt die Grenze und sagt, was GLEICH bleibt', () => {
    const folgen = aktivierenFolgen(277);
    expect(folgen[0]).toContain('277 kW');
    expect(folgen.some((f) => f.includes('Ausfall-Schutz'))).toBe(true);
  });

  it('lehnt eine unplausible Eingabe VOR dem Speichern ab', () => {
    expect(grenzeFehler('277')).toBeNull();
    expect(grenzeFehler('277,5')).toBeNull();
    expect(grenzeFehler('0')).toContain('größer 0');
    expect(grenzeFehler('-5')).toContain('größer 0');
    expect(grenzeFehler('abc')).toContain('größer 0');
    expect(grenzeFehler('250000')).toContain('unplausibel');
  });
});

describe('Anbinden', () => {
  it('dreht die Richtung im ERSTEN Satz um', () => {
    expect(ANBINDEN_EINSTIEG).toContain('verbinden sich selbst');
    // ⚠ Der EINSTIEG behauptet weiterhin keine Adresse - er FÜHRT nur in den
    // Assistenten. Dass die Adresse dort nur aus GEMELDETEN Angaben entsteht,
    // ist die Sache von `ladesaeuleAnbinden.test.ts`; hier wäre ein `ws://`
    // eine Behauptung ohne jeden Bezug zu einer Box.
    expect(ANBINDEN_EINSTIEG).not.toMatch(/ws:\/\//);
  });

  it('graut die Überschuss-Karte MIT Grund aus, statt sie zu verstecken', () => {
    expect(PV_UEBERSCHUSS_OHNE_PV).toContain('nicht verfügbar');
    expect(PV_UEBERSCHUSS_OHNE_PV).toContain('keine PV');
  });
});

/* --- Der Ladepunkt im Anlagen-Modell ------------------------------------- */

import { plantModel } from './komponenten';

describe('Anlagen-Modell', () => {
  it('nennt einen Ladepunkt nicht „schaltbar per Regel" - das wäre falsch', () => {
    const model = plantModel(
      [
        {
          id: 'e1',
          entityType: 'ev-charger',
          typeLabel: 'Ladepunkt',
          label: 'Hof Nord',
          control: false,
          capabilities: { measure: [{ channel: 'power_kw' }], actuate: [] },
        } as never,
      ],
      null,
      [],
      null,
    );
    const charger = model.components.find((c) => c.entityId === 'e1')!;
    expect(charger.label).toBe('Hof Nord');
    // Seine Leistung verteilt das Lastmanagement auf der Box - nicht eine Regel.
    expect(charger.summary).toContain('das Lastmanagement');
    expect(charger.summary).not.toContain('Regel');
  });
});

// ---------------------------------------------------------------------------
// Stufe 4: PV-Überschussladen + „Jetzt voll laden"
// ---------------------------------------------------------------------------

/** Zwei Säulen: eine lädt, eine wartet ohne Überschuss. */
const surplusChargers: ChargePoint[] = [
  saeule({
    connectors: [
      { connectorId: 1, charging: true, powerKw: 45, allocatedKw: 45, reason: 'laedt' },
      {
        connectorId: 2,
        charging: false,
        sessionSince: '2026-08-20T12:41:00Z',
        reason: 'kein_ueberschuss',
        reasonText: 'wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)',
      },
    ],
  }),
];

/** Dieselbe Anlage, eine Ausbaustufe später: mit Sonne und einer Übersteuerung. */
const surplusBudget: ChargingBudget = {
  ...budget,
  budgetKw: 197,
  surplusPolicy: 'nur_sonne',
  storagePriority: 'auto_vor_speicher',
  surplusActive: true,
  surplusKw: 110,
  surplusMode: 'gemessen',
  surplusNote: 'Ihre Priorität: Nur Sonnenstrom. Für die Fahrzeuge stehen gerade 110,0 kW zur Verfügung.',
  surplusTotalKw: 130,
  surplusBatteryKw: 20,
  sourceAllocatedKw: 89,
};

describe('die Quellen-Bahn wird DURCHGEREICHT, nie neu formuliert', () => {
  it('nennt den Satz der Box unverändert', () => {
    // ⚠ Er entsteht EINMAL im Lastmanagement der Box; nur sie kennt die Zahlen
    // dahinter, und zwei Renderings dürfen dasselbe Urteil nicht verschieden sagen.
    expect(surplusLine(surplusBudget)).toBe(surplusBudget.surplusNote);
    expect(surplusLine(budget)).toBeNull();
    expect(surplusLine(null)).toBeNull();
  });

  it('zeigt BEIDE Wahrheiten - sonst liest die Drosselung wie ein Defekt', () => {
    const streifen = kombinationsStreifen(surplusBudget);
    expect(streifen).toMatch(/197 kW physisch möglich/);
    expect(streifen).toMatch(/110 kW aus Ihrer Sonne/);
    expect(streifen).toMatch(/niedrigere Grenze/);
    // Ohne Quellen-Bahn gibt es nichts zu kombinieren - EINE Grenze ist EINE.
    expect(kombinationsStreifen(budget)).toBeNull();
    expect(kombinationsStreifen(null)).toBeNull();
  });

  it('sagt die Sonnen-Deckung als STANDORT-Aussage, nie je Fahrzeug', () => {
    expect(sonnenDeckung(surplusBudget)).toBe('89 kW davon deckt gerade Ihre Sonne');
    // Deckt sie nichts, wird nichts behauptet - nie eine erfundene 0.
    expect(sonnenDeckung({ ...surplusBudget, sourceAllocatedKw: 0 })).toBeNull();
    expect(sonnenDeckung(budget)).toBeNull();
  });
});

describe('die Prioritäten-Wahl', () => {
  it('kennt genau die drei Wörter des Vertrags', () => {
    expect(asPolicy('nur_sonne')).toBe('nur_sonne');
    expect(asPolicy('schnell')).toBe('schnell');
    // Ein Wort, das wir nicht kennen, wird NICHT zu einer Auswahl.
    expect(asPolicy('hoffentlich')).toBeNull();
    expect(asPolicy(null)).toBeNull();
    expect(asStorage('auto_vor_speicher')).toBe('auto_vor_speicher');
    expect(asStorage('irgendwas')).toBeNull();
  });

  it('hat „Sonne zuerst" als Vorgabe INNERHALB der Karte', () => {
    // ⚠ Nicht dieselbe Vorgabe wie die einer Anlage, die nie gefragt wurde: die
    // ist „schnell" (gar keine Quellen-Bahn) und lebt auf der BOX.
    expect(POLICY_DEFAULT).toBe('sonne_zuerst');
    expect(POLICY_LABEL[POLICY_DEFAULT]).toMatch(/Sonne zuerst/);
  });

  it('blendet die Karte ohne PV aus - sichtbar, mit Grund', () => {
    const charging = { budget: surplusBudget, chargers: surplusChargers };
    expect(ueberschussVerfuegbar(true, charging)).toBe(true);
    expect(ueberschussVerfuegbar(false, charging)).toBe(false);
    expect(PV_UEBERSCHUSS_OHNE_PV).toMatch(/keine PV/);
  });
});

describe('„Jetzt voll laden"', () => {
  const rows = ladevorgangRows(surplusChargers);

  it('wird nur angeboten, wo es etwas ändern KANN', () => {
    const laden = rows.find((r) => r.tone === 'laedt')!;
    expect(boostbar(surplusBudget, laden)).toBe(true);
    // Ohne Quellen-Bahn gibt es nichts zu übersteuern.
    expect(boostbar(budget, laden)).toBe(false);
    expect(boostbar(null, laden)).toBe(false);
    // Und ein schon übersteuerter Ladevorgang bekommt den anderen Knopf.
    expect(boostbar(surplusBudget, { ...laden, boost: true })).toBe(false);
  });

  it('sagt in der Folgenliste auch, was GLEICH bleibt', () => {
    const folgen = boostFolgen();
    expect(BOOST_INTRO).toMatch(/diesen einen Ladevorgang/);
    expect(folgen.join(' ')).toMatch(/auch mit Netzstrom/);
    // Die zwei Punkte, die eine Übersteuerung ehrlich machen.
    expect(folgen.join(' ')).toMatch(/für alle anderen Ladevorgänge unverändert/);
    expect(folgen.join(' ')).toMatch(/Anschlussgrenze.*gelten weiter/);
    expect(folgen.join(' ')).toMatch(/längstens 4 Stunden/);
  });

  it('macht eine übersteuerte Ladung in ihrer Zeile SICHTBAR', () => {
    const boosted = ladevorgangRows([
      saeule({ connectors: [{ connectorId: 1, charging: true, powerKw: 50, boost: true }] }),
    ]);
    // Eine volle Ladung, die niemand angefordert hat, wäre ein stiller Bruch
    // der eigenen Priorität des Kunden.
    expect(boosted[0].word).toBe('Lädt voll auf Ihren Wunsch');
    expect(boosted[0].boost).toBe(true);
    // Und die Zeile weiß, WELCHEN Ladevorgang sie meint.
    expect(boosted[0].chargePointId).toBe('saeule-1');
    expect(boosted[0].connectorId).toBe(1);
  });

  it('sagt „lädt" nicht noch einmal unter „Lädt voll auf Ihren Wunsch"', () => {
    // Der Verteiler kennt die Übersteuerung nicht und meldet für dieselbe
    // Sekunde weiter seinen eigenen Grund - im echten Browser aufgefallen.
    const boosted = ladevorgangRows([
      saeule({
        connectors: [
          {
            connectorId: 1,
            charging: true,
            powerKw: 50,
            boost: true,
            reason: 'laedt',
            reasonText: 'lädt',
          },
        ],
      }),
    ]);
    expect(boosted[0].word).toBe('Lädt voll auf Ihren Wunsch');
    expect(boosted[0].reason).toBeNull();
    // Ein Grund, der MEHR sagt, bleibt selbstverständlich stehen.
    const anders = ladevorgangRows([
      saeule({
        connectors: [
          {
            connectorId: 1,
            charging: true,
            powerKw: 50,
            boost: true,
            reasonText: 'lädt mit reduzierter Leistung',
          },
        ],
      }),
    ]);
    expect(anders[0].reason).toBe('lädt mit reduzierter Leistung');
  });

  it('prüft das MASCHINEN-Wort, nie den deutschen Satz', () => {
    // Der Satz der Box trägt bei „kein Überschuss" zusätzlich die Priorität -
    // ein Vergleich gegen ihn hätte NIE getroffen.
    const wartend = ladevorgangRows([
      saeule({
        connectors: [
          {
            connectorId: 1,
            charging: false,
            reason: 'kein_ueberschuss',
            reasonText: 'wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)',
          },
        ],
      }),
    ]);
    expect(wartend[0].reasonCode).toBe('kein_ueberschuss');
    expect(wartend[0].reason).toMatch(/Ihre Priorität/);
    expect(boostbar(surplusBudget, wartend[0])).toBe(true);
    // Ein Wort, das dieser Stand nicht kennt, begründet nichts.
    expect(boostbar(surplusBudget, { ...wartend[0], reasonCode: 'neues_wort' })).toBe(false);
  });
});
