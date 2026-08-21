import { describe, expect, it } from 'vitest';
import type { ComponentTemplate } from './api';
import type { TestErgebnis } from './komponentenAssistent';
import { HEBEL_HINWEIS, geschwister, hebel } from './testHebel';

const DEYE = {
  templateRef: 'builtin:deye:sun-30k-sg01hp3',
  kind: 'builtin', version: 1,
  brand: 'deye', brandLabel: 'Deye',
  model: 'sun-30k-sg01hp3', modelLabel: 'SUN-30K-SG01HP3-EU',
  family: 'hybrid_3p', familyLabel: 'Hybrid, 3-phasig',
  communication: 'solarman_v5', communicationLabel: 'Solarman-V5',
  transportSchema: [
    { key: 'ip', label: 'IP-Adresse des Datenloggers', type: 'text', required: true },
    { key: 'serial', label: 'Datenlogger-Seriennummer', type: 'text', required: true },
    {
      key: 'power_scale', label: 'Leistungsskalierung', type: 'select', default: 0,
      options: [{ value: 0, label: 'Automatisch' }, { value: 10, label: 'Dekawatt (×10)' }],
    },
  ],
} as unknown as ComponentTemplate;

/** Eine Marke ohne Skalierung und ohne Logger-Seriennummer. */
const FRONIUS = {
  ...DEYE,
  templateRef: 'builtin:fronius:gen24',
  brand: 'fronius', brandLabel: 'Fronius',
  model: 'gen24', modelLabel: 'Symo GEN24',
  communication: 'fronius_solar_api',
  transportSchema: [{ key: 'ip', label: 'IP-Adresse', type: 'text', required: true }],
} as unknown as ComponentTemplate;

const GESCHWISTER = {
  ...DEYE,
  templateRef: 'builtin:deye:sun-25k-sg02hp3-eu-am3',
  model: 'sun-25k-sg02hp3-eu-am3', modelLabel: 'SUN-25K-SG02HP3-EU-AM3',
} as unknown as ComponentTemplate;

function erg(over: Partial<TestErgebnis> = {}): TestErgebnis {
  return { zustand: 'fehlgeschlagen', text: 'x', messwerte: [], ...over };
}

function ctx(over: Partial<Parameters<typeof hebel>[0]> = {}) {
  return {
    ergebnis: erg(),
    template: DEYE,
    templates: [DEYE, GESCHWISTER, FRONIUS],
    verbindung: {} as Record<string, unknown>,
    ...over,
  };
}

describe('Logger-Hebel', () => {
  it('erscheint, wenn nichts antwortet - und nennt die häufigste Verwechslung', () => {
    const h = hebel(ctx({ ergebnis: erg({ errorCode: 'unreachable' }) }));
    const logger = h.find((x) => x.id === 'logger');
    expect(logger?.feld).toBe('serial');
    expect(logger?.satz).toContain('DATENLOGGERS');
  });

  it('erscheint auch bei der LEERANTWORT des Loggers (alle Register 0)', () => {
    const h = hebel(ctx({
      ergebnis: erg({
        errorCode: 'implausible',
        befund: { channel: 'soc_pct', rule: 'no_answer' },
      }),
    }));
    expect(h.map((x) => x.id)).toContain('logger');
  });

  it('springt das Feld an, das die Vorlage WIRKLICH hat', () => {
    const h = hebel(ctx({
      template: FRONIUS,
      ergebnis: erg({ errorCode: 'fronius_api' }),
    }));
    expect(h.find((x) => x.id === 'logger')?.feld).toBe('ip');
  });

  it('erscheint nicht bei einem bestandenen Test', () => {
    const h = hebel(ctx({ ergebnis: erg({ zustand: 'bestanden', errorCode: null }) }));
    expect(h.map((x) => x.id)).not.toContain('logger');
  });
});

describe('Skalierungs-Hebel', () => {
  const werte = [{ label: 'Solarleistung', wert: '300,00 kW' }];

  it('steht auch neben einem BESTANDENEN Test - der Faktor-10-Fall besteht ihn', () => {
    const h = hebel(ctx({ ergebnis: erg({ zustand: 'bestanden', messwerte: werte }) }));
    const s = h.find((x) => x.id === 'skalierung');
    expect(s?.feld).toBe('power_scale');
    // ⚠ Eine FRAGE, keine Diagnose - es gibt dafür keinen Beleg vom Server.
    expect(s?.titel).toMatch(/\?$/);
  });

  it('erscheint nicht ohne Messwerte - es gäbe nichts zu vergleichen', () => {
    const h = hebel(ctx({ ergebnis: erg({ errorCode: 'unreachable' }) }));
    expect(h.map((x) => x.id)).not.toContain('skalierung');
  });

  it('erscheint nicht, wenn ×10 schon eingestellt ist', () => {
    const h = hebel(ctx({
      ergebnis: erg({ zustand: 'bestanden', messwerte: werte }),
      verbindung: { power_scale: '10' },
    }));
    expect(h.map((x) => x.id)).not.toContain('skalierung');
  });

  it('erscheint nicht, wo die Vorlage die Einstellung gar nicht hat', () => {
    const h = hebel(ctx({
      template: FRONIUS,
      ergebnis: erg({ zustand: 'bestanden', messwerte: werte }),
    }));
    expect(h.map((x) => x.id)).not.toContain('skalierung');
  });
});

describe('Modell-Hebel', () => {
  it('erscheint, wenn die Antwort nicht zum Rahmen passt', () => {
    const h = hebel(ctx({ ergebnis: erg({ errorCode: 'invalid_response' }) }));
    const m = h.find((x) => x.id === 'modell');
    expect(m?.feld).toBeNull();
    expect(m?.satz).toContain('Deye');
  });

  it('erscheint beim unmöglichen Messwert (der Live-Fall SG02HP3-AM3)', () => {
    const h = hebel(ctx({
      ergebnis: erg({
        errorCode: 'implausible',
        befund: { channel: 'soc_pct', rule: 'out_of_range', value: 1270 },
      }),
    }));
    expect(h.map((x) => x.id)).toContain('modell');
  });

  it('erscheint NICHT ohne Alternative - ein Knopf ins Leere ist keiner', () => {
    const h = hebel(ctx({
      ergebnis: erg({ errorCode: 'invalid_response' }),
      templates: [DEYE, FRONIUS],
    }));
    expect(h.map((x) => x.id)).not.toContain('modell');
  });

  it('schlägt NIE über Marken hinweg vor', () => {
    const namen = geschwister(ctx()).map((t) => t.modelLabel);
    expect(namen).toEqual(['SUN-25K-SG02HP3-EU-AM3']);
    expect(namen).not.toContain('Symo GEN24');
  });
});

describe('Ehrlichkeit', () => {
  it('behauptet ohne Ergebnis oder ohne Vorlage GAR NICHTS', () => {
    expect(hebel(ctx({ ergebnis: null }))).toEqual([]);
    expect(hebel(ctx({ template: null }))).toEqual([]);
  });

  it('leitet aus einem UNBEKANNTEN Fehlerwort keinen Hebel ab', () => {
    const h = hebel(ctx({ ergebnis: erg({ errorCode: 'irgendwas-neues' }) }));
    expect(h).toEqual([]);
  });

  it('lässt BELEGTES führen und stellt die FRAGE zuletzt', () => {
    const h = hebel(ctx({
      ergebnis: erg({
        errorCode: 'implausible',
        messwerte: [{ label: 'Solarleistung', wert: '300,00 kW' }],
        befund: { channel: 'soc_pct', rule: 'out_of_range', value: 1270 },
      }),
    }));
    // ⚠ Der Modell-Hebel ist BELEGT (der Server nannte die verletzte Regel),
    // die Skalierung ist nur eine Frage - eine Vermutung über der Erklärung
    // wäre die falsche Reihenfolge.
    expect(h.map((x) => x.id)).toEqual(['modell', 'skalierung']);
  });

  it('nennt keine Diagnose, sondern den nächsten Schritt', () => {
    expect(HEBEL_HINWEIS).toContain('erneut');
    expect(HEBEL_HINWEIS).toContain('Verbindung testen');
  });
});
