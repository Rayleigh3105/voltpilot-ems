import { describe, expect, it } from 'vitest';

import { NBSP } from './format';
import {
  ANTEILIG_HINWEIS,
  BORDERLINE_CT,
  STATUS_AMTLICH,
  STATUS_VORLAEUFIG,
  anteiligText,
  aufstockungsRechnung,
  istKnappUndVorlaeufig,
  marktpraemie,
  praemieMonat,
  statusText,
  type MarktpraemieInput,
} from './marktpraemie';

/**
 * Der reale Kundenfall vom 05.08.2026: AW 6,9 · vorläufiger MW 7,0 ⇒ Prämie 0.
 * Das Fenster ist BERLIN-geschnitten wie `HistoryRange.window()` es liefert.
 */
function fall(over: Partial<MarktpraemieInput> = {}): MarktpraemieInput {
  return {
    marktpraemieEur: 0,
    anzulegenderWertCtKwh: 6.9,
    marketValueSolarCtKwh: 7.0,
    marketValueProvisional: true,
    eingespeistKwh: 9573.8,
    plantKind: 'direktvermarktung',
    range: 'month',
    from: '2026-07-31T22:00:00Z',
    to: '2026-08-31T22:00:00Z',
    siteId: 's1',
    ...over,
  };
}

describe('marktpraemie · (1) die berechnete Null erklärt sich selbst', () => {
  it('nennt beide Zahlen und sagt, dass die Vergütung voll aus dem Markt kommt', () => {
    const v = marktpraemie(fall());

    expect(v.state).toBe('voll_aus_dem_markt');
    // Eine berechnete Null ist weder Zugewinn noch Verlust.
    expect(v.wert).toBe(`0,00${NBSP}€`);
    expect(v.vorhanden).toBe(true);
    expect(v.note).toContain(`Monatsmarktwert (7,0${NBSP}ct)`);
    expect(v.note).toContain(`Garantiewert (6,9${NBSP}ct)`);
    expect(v.note).toContain('voll aus dem Markt');
    // Ruhig, nie ein Warnton: es ist nichts kaputt.
    expect(v.note).not.toMatch(/Fehler|Problem|fehlt/);
  });

  it('behauptet kein „über", wenn der Monatswert genau auf dem Garantiewert liegt', () => {
    const v = marktpraemie(fall({ marketValueSolarCtKwh: 6.9, marketValueProvisional: false }));
    expect(v.state).toBe('voll_aus_dem_markt');
    expect(v.note).toContain('genau auf Höhe');
    expect(v.note).not.toContain('liegt über');
  });

  it('bleibt ohne Monatsmarktwert zahlenfrei ehrlich, statt einen zu erfinden', () => {
    const v = marktpraemie(fall({ marketValueSolarCtKwh: null, marketValueProvisional: null }));
    expect(v.state).toBe('voll_aus_dem_markt');
    expect(v.note).toContain('voll aus dem Markt');
    expect(v.note).not.toMatch(/\(\d/);
    expect(v.vorlaeufigKnapp).toBe(false);
  });
});

describe('marktpraemie · (2) der knappe, vorläufige Monatswert wird angesagt', () => {
  it('hängt bei vorläufigem UND knappem Monatswert genau eine ruhige Zeile an', () => {
    const v = marktpraemie(fall());
    expect(v.vorlaeufigKnapp).toBe(true);
    // Der Termin steht IN diesem Satz - der Status-Satz entfällt dann, sonst
    // stünde derselbe Termin zweimal untereinander.
    expect(v.hinweise).toEqual([
      'Endgültiger Monatswert steht aus (amtlich ca. Mitte des Folgemonats) — die Prämie kann sich noch ändern.',
    ]);
    expect(v.hinweise).not.toContain(STATUS_VORLAEUFIG);
  });

  it('schweigt, sobald der Monatswert endgültig ist - auch wenn er knapp liegt', () => {
    expect(istKnappUndVorlaeufig(fall({ marketValueProvisional: false }))).toBe(false);
    expect(istKnappUndVorlaeufig(fall({ marketValueProvisional: null }))).toBe(false);
    // Dann steht dort der schlichte Stand - kein „kann sich noch ändern".
    expect(marktpraemie(fall({ marketValueProvisional: false })).hinweise).toEqual([
      STATUS_AMTLICH,
    ]);
  });

  it('schweigt, sobald der Abstand die Schwelle überschreitet - und meldet genau auf ihr', () => {
    const auf = fall({ marketValueSolarCtKwh: 6.9 + BORDERLINE_CT });
    const drueber = fall({ marketValueSolarCtKwh: 6.9 + BORDERLINE_CT + 0.05 });
    expect(istKnappUndVorlaeufig(auf)).toBe(true);
    expect(istKnappUndVorlaeufig(drueber)).toBe(false);
    // Auch nach UNTEN (die Prämie kann ebenso schrumpfen wie entstehen).
    expect(istKnappUndVorlaeufig(fall({ marketValueSolarCtKwh: 6.9 - BORDERLINE_CT }))).toBe(true);
  });

  it('behauptet ohne bekannte Größen gar nichts', () => {
    expect(istKnappUndVorlaeufig(fall({ marketValueSolarCtKwh: null }))).toBe(false);
    expect(istKnappUndVorlaeufig(fall({ anzulegenderWertCtKwh: null }))).toBe(false);
  });
});

describe('marktpraemie · (3) ohne anzulegenden Wert gibt es KEINE Null', () => {
  it('zeigt „—" mit Grund und dem Weg dorthin - nie „0,00 €"', () => {
    const v = marktpraemie(fall({ marktpraemieEur: null, anzulegenderWertCtKwh: null }));

    expect(v.state).toBe('kein_wert');
    expect(v.wert).toBe('—');
    expect(v.wert).not.toContain('0,00');
    expect(v.vorhanden).toBe(false);
    expect(v.note).toContain('anzulegender Wert');
    expect(v.hinweise.join(' ')).toContain('Einstellungen');
    expect(v.href).toBe('#/anlage/s1/technik?abschnitt=geld');
  });

  it('erfindet auch dann keine Null, wenn der Server eine 0 liefert', () => {
    const v = marktpraemie(fall({ marktpraemieEur: 0, anzulegenderWertCtKwh: null }));
    expect(v.state).toBe('kein_wert');
    expect(v.wert).toBe('—');
  });

  it('nennt auf einer Eigenverbrauchs-Anlage den wahren Grund und bietet keinen Weg an', () => {
    const v = marktpraemie(
      fall({ marktpraemieEur: null, anzulegenderWertCtKwh: null, plantKind: 'eigenverbrauch' }),
    );
    expect(v.note).toContain('nicht direkt vermarktet');
    expect(v.href).toBeNull();
    // Ohne Prämie ist auch der Stand des Monatsmarktwerts keine Auskunft,
    // sondern Rauschen - diese eine Zeile bleibt ungerahmt.
    expect(v.hinweise).toEqual([]);
    expect(v.label).toBe('Marktprämie');
    expect(v.monatLabel).toBeNull();
    expect(v.statusText).toBeNull();
  });

  it('bietet ohne bekannte Anlage keinen Link an, statt einen ins Leere zu bauen', () => {
    const v = marktpraemie(fall({ marktpraemieEur: null, anzulegenderWertCtKwh: null, siteId: null }));
    expect(v.href).toBeNull();
  });
});

describe('marktpraemie · (4) eine echte Aufstockung zeigt ihre Rechnung', () => {
  const echt = fall({
    marktpraemieEur: 105.31,
    anzulegenderWertCtKwh: 6.9,
    marketValueSolarCtKwh: 5.8,
    marketValueProvisional: false,
  });

  it('rechnet kompakt vor, woher der Betrag kommt', () => {
    const v = marktpraemie(echt);
    expect(v.state).toBe('aufstockung');
    expect(v.wert).toBe(`+ 105,31${NBSP}€`);
    expect(v.note).toBe(`6,9 − 5,8 = 1,1${NBSP}ct/kWh × 9.573,8${NBSP}kWh eingespeist`);
    expect(v.hinweise).toEqual([STATUS_AMTLICH, 'bereits im Einspeise-Erlös enthalten']);
  });

  it('lässt die Menge weg, statt eine zu erfinden', () => {
    expect(aufstockungsRechnung({ ...echt, eingespeistKwh: null })).toBe(
      `6,9 − 5,8 = 1,1${NBSP}ct/kWh`,
    );
  });

  it('verzichtet auf die Rechnung, wenn eine Größe fehlt', () => {
    const v = marktpraemie({ ...echt, marketValueSolarCtKwh: null });
    expect(v.state).toBe('aufstockung');
    expect(v.note).toBe('bereits im Einspeise-Erlös enthalten');
    expect(v.hinweise).toEqual([STATUS_AMTLICH]);
  });

  it('bringt bei knapper, vorläufiger Lage BEIDE ruhigen Zeilen', () => {
    const v = marktpraemie(
      fall({
        marktpraemieEur: 12.3,
        anzulegenderWertCtKwh: 6.9,
        marketValueSolarCtKwh: 6.7,
        marketValueProvisional: true,
      }),
    );
    expect(v.hinweise).toHaveLength(2);
    expect(v.hinweise[0]).toContain('bereits im Einspeise-Erlös');
    expect(v.hinweise[1]).toContain('kann sich noch ändern');
  });
});

// ---------------------------------------------------------------------------
// Captain-Klärung 05.08.2026: Monat, Stand und Anteiligkeit gehören an JEDE
// Zeile. Beleg: `EarningsRepository.MARKET_VALUE_JOIN` (der Slot zieht den
// Monatswert SEINES Berliner Kalendermonats) + `premium(M)` im Klassen-Javadoc.
// ---------------------------------------------------------------------------

describe('marktpraemie · der Monat ist die Abrechnungseinheit und wird benannt', () => {
  it('trägt den Monat in JEDEM der vier Zustände in der Überschrift', () => {
    const zustaende: MarktpraemieInput[] = [
      fall(), // voll_aus_dem_markt
      fall({ marktpraemieEur: 105.31, marketValueSolarCtKwh: 5.8 }), // aufstockung
      fall({ marktpraemieEur: null, anzulegenderWertCtKwh: null }), // kein_wert
      fall({ marktpraemieEur: null }), // nicht_berechenbar
    ];
    const states = zustaende.map((z) => marktpraemie(z));
    expect(new Set(states.map((s) => s.state)).size).toBe(4);
    for (const s of states) {
      expect(s.monatLabel).toBe('August 2026');
      expect(s.label).toBe('Marktprämie · August 2026');
    }
  });

  it('nennt keinen Monat, wenn der Zeitraum mehrere umfasst - statt einen zu wählen', () => {
    const jahr = marktpraemie(
      fall({ range: 'year', from: '2025-12-31T23:00:00Z', to: '2026-12-31T23:00:00Z' }),
    );
    expect(jahr.monatLabel).toBeNull();
    expect(jahr.label).toBe('Marktprämie');
  });

  it('bewertet das EXKLUSIVE Fensterende, damit ein Monat nicht in den nächsten rutscht', () => {
    // Ein sauberes Berliner Monatsfenster - das `to` gehört schon zum August.
    expect(praemieMonat('2026-06-30T22:00:00Z', '2026-07-31T22:00:00Z')).toBe('Juli 2026');
    // Ein Tag mitten im Monat.
    expect(praemieMonat('2026-08-04T22:00:00Z', '2026-08-05T22:00:00Z')).toBe('August 2026');
    // Eine Woche über die Monatsgrenze trägt keinen einzelnen Monat.
    expect(praemieMonat('2026-07-26T22:00:00Z', '2026-08-02T22:00:00Z')).toBeNull();
    expect(praemieMonat(null, '2026-08-31T22:00:00Z')).toBeNull();
    expect(praemieMonat('quatsch', 'unsinn')).toBeNull();
  });
});

describe('marktpraemie · der amtliche Stand und die Anteiligkeit', () => {
  it('unterscheidet vorläufig, amtlich und unbekannt - und erfindet kein „amtlich"', () => {
    expect(statusText(true)).toBe(STATUS_VORLAEUFIG);
    expect(statusText(true)).toContain('Mitte des Folgemonats');
    expect(statusText(false)).toBe(STATUS_AMTLICH);
    expect(statusText(null)).toBeNull();
    expect(statusText(undefined)).toBeNull();

    const unbekannt = marktpraemie(fall({ marketValueProvisional: null }));
    expect(unbekannt.statusText).toBeNull();
    expect(unbekannt.hinweise).toEqual([]);
  });

  it('nennt den Stand in JEDEM der vier Zustände', () => {
    const zustaende: MarktpraemieInput[] = [
      fall({ marketValueProvisional: false }),
      fall({ marktpraemieEur: 105.31, marketValueSolarCtKwh: 5.8, marketValueProvisional: false }),
      fall({
        marktpraemieEur: null,
        anzulegenderWertCtKwh: null,
        marketValueProvisional: false,
      }),
      fall({ marktpraemieEur: null, marketValueProvisional: false }),
    ];
    for (const z of zustaende) {
      const v = marktpraemie(z);
      expect(v.statusText).toBe(STATUS_AMTLICH);
      expect(v.hinweise).toContain(STATUS_AMTLICH);
    }
  });

  it('sagt in Tages- und Wochenansichten, dass die Zahl anteilig ist', () => {
    expect(anteiligText('day')).toBe(ANTEILIG_HINWEIS);
    expect(anteiligText('week')).toBe(ANTEILIG_HINWEIS);
    expect(anteiligText('month')).toBeNull();
    expect(anteiligText('year')).toBeNull();
    expect(anteiligText('all')).toBeNull();
    expect(anteiligText(null)).toBeNull();

    const tag = marktpraemie(
      fall({ range: 'day', from: '2026-08-04T22:00:00Z', to: '2026-08-05T22:00:00Z' }),
    );
    expect(tag.anteiligText).toBe(ANTEILIG_HINWEIS);
    expect(tag.hinweise).toContain(ANTEILIG_HINWEIS);
    // Der Monat bleibt trotzdem benannt - er IST die Abrechnungseinheit.
    expect(tag.label).toBe('Marktprämie · August 2026');
  });

  it('stellt Stand und Anteiligkeit VOR die zustandsspezifischen Zeilen', () => {
    const v = marktpraemie(
      fall({
        range: 'day',
        from: '2026-08-04T22:00:00Z',
        to: '2026-08-05T22:00:00Z',
        marktpraemieEur: 105.31,
        marketValueSolarCtKwh: 5.8,
        marketValueProvisional: false,
      }),
    );
    expect(v.hinweise).toEqual([
      STATUS_AMTLICH,
      ANTEILIG_HINWEIS,
      'bereits im Einspeise-Erlös enthalten',
    ]);
  });
});

describe('marktpraemie · gepflegter Wert ohne Zurechnung', () => {
  it('sagt bei fehlendem Monatsmarktwert, dass die Prämie noch nicht feststeht', () => {
    const v = marktpraemie(fall({ marktpraemieEur: null, marketValueSolarCtKwh: null }));
    expect(v.state).toBe('nicht_berechenbar');
    expect(v.wert).toBe('—');
    expect(v.note).toContain('noch kein Monatsmarktwert');
  });

  it('sagt bei bekanntem Monatswert schlicht, dass nichts angefallen ist', () => {
    const v = marktpraemie(fall({ marktpraemieEur: null }));
    expect(v.state).toBe('nicht_berechenbar');
    expect(v.note).toBe('In diesem Zeitraum ist keine Prämie angefallen.');
  });
});
