import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGGREGATE,
  MAX_EIGENE,
  MAX_TITEL,
  aggregatLabel,
  aggregatSatz,
  ausEntwurf,
  deckelSatz,
  einheit,
  entwurfFehler,
  erlaubt,
  erlaubteAggregate,
  grund,
  istEigen,
  kanalart,
  leererEntwurf,
  nachKanalwechsel,
  neuerSchluessel,
  titelVorschlag,
  vorlageFuer,
  vorlagen,
  werteNachId,
  wertText,
  zeitbezug,
  type EigeneAuswertungWerte,
} from './eigeneAuswertung';

/**
 * Die EHRLICHKEITSREGEL der eigenen Auswertung (Anwendungs-Programm Stufe 5)
 * gegen die EINE geteilte Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../cockpit/EigeneAuswertungTest` fährt.
 *
 * Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 */
const VECTORS = resolve(
  process.cwd(),
  '../../docs/contracts/v2/eigene-auswertung-vectors.json',
);

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  aggregate: string[];
  darstellung: string[];
  kanalarten: string[];
  kanalart: { channel: string; kanalart: string }[];
  erlaubt: Record<string, string | boolean>[];
  gruende: Record<string, string>;
};

describe('die geteilten Vektoren: beide Zwillinge urteilen gleich', () => {
  it('das Vokabular der Datei ist das Vokabular dieses Moduls', () => {
    expect(vectors.aggregate).toEqual(AGGREGATE);
    expect(vectors.darstellung).toEqual(['kachel', 'chart']);
    expect([...vectors.kanalarten].sort()).toEqual(
      ['anteil', 'energie', 'leistung', 'messwert'].sort(),
    );
  });

  for (const v of vectors.kanalart) {
    it(`Kanalart · ${v.channel} -> ${v.kanalart}`, () => {
      expect(kanalart(v.channel)).toBe(v.kanalart);
    });
  }

  for (const fall of vectors.erlaubt) {
    for (const agg of AGGREGATE) {
      it(`${fall.name} · ${agg}`, () => {
        const erwartet = fall[agg] === true;
        expect(erlaubt(fall.channel as string, agg)).toBe(erwartet);
        // Genau dann gibt es einen GRUND, wenn es nicht erlaubt ist — nie ein
        // Grund ohne Ablehnung und nie eine Ablehnung ohne Grund.
        expect(grund(fall.channel as string, agg) == null).toBe(erwartet);
      });
    }
  }

  it('die Gründe der Datei sind die Gründe dieses Moduls', () => {
    const g = vectors.gruende;
    expect(grund('pv_power_kw', 'tagessumme', 'PV-Leistung')).toBe(g.tagessumme_leistung);
    expect(grund('soc_pct', 'tagessumme', 'Ladestand')).toBe(g.tagessumme_anteil);
    expect(grund('temperature_c', 'tagessumme', 'Temperatur')).toBe(g.tagessumme_messwert);
    expect(grund('energy_kwh', 'tagesmax', 'Energie')).toBe(g.tagesmax_energie);
    expect(grund('energy_kwh', 'tagesmittel', 'Energie')).toBe(g.tagesmittel_energie);
  });
});

describe('die Ehrlichkeitsregel in Worten', () => {
  it('ein Energie-Kanal kennt nur den Stand und den Zuwachs', () => {
    expect(erlaubteAggregate('energy_kwh')).toEqual(['jetzt', 'tagessumme']);
  });

  it('jeder andere Kanal kennt alles ausser der Summe', () => {
    for (const c of ['pv_power_kw', 'soc_pct', 'temperature_c', 'kesselfuellung']) {
      expect(erlaubteAggregate(c), c).toEqual(['jetzt', 'tagesmax', 'tagesmittel']);
    }
  });

  it('„jetzt" ist auf JEDEM Kanal ehrlich - auch auf einem unbekannten', () => {
    for (const c of ['energy_kwh', 'pv_power_kw', 'soc_pct', 'was_auch_immer', '']) {
      expect(erlaubt(c, 'jetzt'), c).toBe(true);
    }
  });

  it('ein unbekanntes Aggregat ist nie erlaubt und wird nie angeboten', () => {
    expect(erlaubt('pv_power_kw', 'tagesmedian')).toBe(false);
    expect(erlaubteAggregate('pv_power_kw')).not.toContain('tagesmedian');
  });

  it('der Grund benennt die Kanalart UND die Auswege, nie nur „ungültig"', () => {
    const g = grund('pv_power_kw', 'tagessumme', 'PV-Leistung')!;
    expect(g).toContain('eine Leistung');
    expect(g).toContain('Tageshöchstwert');
    expect(g).not.toMatch(/ungültig|invalid|Fehler/i);
  });
});

describe('Vorlagen: die zwei Arten kommen aus dem Katalog', () => {
  it('das Cockpit kennt Kachel und Verlauf, in dieser Reihenfolge', () => {
    expect(vorlagen().map((v) => v.id)).toEqual(['eigene-kachel', 'eigener-chart']);
    expect(vorlagen().map((v) => v.darstellung)).toEqual(['kachel', 'chart']);
  });

  it('jede Vorlage nennt ihren Anker und ihre Anwendung', () => {
    for (const v of vorlagen()) {
      expect(v.anwendung, v.id).toBe('eigene-auswertung');
      expect(v.nach, v.id).toBe('kacheln');
      expect(v.satz, v.id).toBeTruthy();
    }
  });

  it('das Portfolio kennt KEINE - dort gibt es keine einzelne Komponente', () => {
    expect(vorlagen('portfolio')).toEqual([]);
  });

  it('eine unbekannte Darstellung hat keine Vorlage', () => {
    expect(vorlageFuer('torte')).toBeNull();
    expect(vorlageFuer('chart')?.id).toBe('eigener-chart');
  });
});

describe('Copy: jede Zahl trägt ihren Zeitbezug', () => {
  it('die vier Kennzahlen heissen beim Kunden anders als im Vertrag', () => {
    expect(AGGREGATE.map(aggregatLabel)).toEqual([
      'Aktuell',
      'Tagessumme',
      'Tageshöchstwert',
      'Tagesmittel',
    ]);
  });

  it('der Zeitbezug steht unter jeder Zahl - „3,2 kW" allein sagt zu wenig', () => {
    for (const a of AGGREGATE) expect(zeitbezug(a), a).toBeTruthy();
    expect(zeitbezug('jetzt')).toBe('jetzt');
    expect(zeitbezug('tagessumme')).toBe('heute');
  });

  it('der Satz zur Tagessumme nennt den ZUWACHS, nie eine Summe der Messwerte', () => {
    expect(aggregatSatz('energy_kwh', 'tagessumme')).toContain('Zuwachs');
  });

  it('die Einheit wird nie erfunden', () => {
    expect(einheit('pv_power_kw')).toBe('kW');
    expect(einheit('soc_pct')).toBe('%');
    expect(einheit('energy_kwh')).toBe('kWh');
    // Ein selbst benannter Kanal ohne deklarierte Einheit bekommt keine.
    expect(einheit('kesselfuellung')).toBe('');
    // Die DEKLARIERTE Einheit der Komponente gewinnt.
    expect(einheit('kesselfuellung', 'l')).toBe('l');
  });

  it('eine fehlende Zahl bleibt ein Strich - nie eine 0', () => {
    expect(wertText(null, 'pv_power_kw')).toBe('—');
    expect(wertText(undefined, 'pv_power_kw')).toBe('—');
    expect(wertText(Number.NaN, 'pv_power_kw')).toBe('—');
    expect(wertText(0, 'pv_power_kw')).toContain('0,00');
  });

  it('die Zahl wird nach ihrer Grösse gerundet', () => {
    expect(wertText(3.14159, 'pv_power_kw')).toContain('3,14');
    expect(wertText(41.2, 'pv_power_kw')).toContain('41,2');
    expect(wertText(1234.5, 'energy_kwh')).toContain('1.235');
  });

  it('der Titel-Vorschlag nennt Komponente, Messwert und - ausser jetzt - den Bezug', () => {
    expect(titelVorschlag('Wärmepumpe', 'Leistung', 'jetzt')).toBe('Wärmepumpe · Leistung');
    expect(titelVorschlag('Wärmepumpe', 'Energie', 'tagessumme')).toBe(
      'Wärmepumpe · Energie (heute)',
    );
    expect(titelVorschlag('x'.repeat(80), 'Leistung', 'jetzt').length).toBeLessThanOrEqual(
      MAX_TITEL,
    );
  });

  it('der Deckel wird erst genannt, wenn er erreicht ist - und nennt die Zahl', () => {
    expect(deckelSatz(0)).toBeNull();
    expect(deckelSatz(MAX_EIGENE - 1)).toBeNull();
    expect(deckelSatz(MAX_EIGENE)).toContain(String(MAX_EIGENE));
  });
});

describe('Entwurf: die Fläche bietet nichts an, was der Server ablehnt', () => {
  const basis = { ...leererEntwurf(), entityId: 'e1', channel: 'pv_power_kw', titel: 'PV' };

  it('ein frischer Entwurf ist eine Kachel mit dem aktuellen Wert', () => {
    expect(leererEntwurf()).toMatchObject({ darstellung: 'kachel', aggregat: 'jetzt' });
  });

  it('jede Lücke wird beim Namen genannt', () => {
    expect(entwurfFehler(leererEntwurf())).toContain('Komponente');
    expect(entwurfFehler({ ...leererEntwurf(), entityId: 'e1' })).toContain('Messwert');
    expect(entwurfFehler({ ...basis, titel: '  ' })).toContain('Überschrift');
    expect(entwurfFehler({ ...basis, titel: 'x'.repeat(61) })).toContain('länger als');
  });

  it('eine unehrliche Kombination trägt den GRUND, nicht „ungültig"', () => {
    expect(entwurfFehler({ ...basis, aggregat: 'tagessumme' })).toContain('Tagessumme');
  });

  it('ein vollständiger Entwurf hat keinen Fehler und wird zur Definition', () => {
    expect(entwurfFehler(basis)).toBeNull();
    expect(ausEntwurf({ ...basis, titel: '  PV jetzt  ' }, 'eigen:k1')).toEqual({
      id: 'eigen:k1',
      titel: 'PV jetzt',
      darstellung: 'kachel',
      entityId: 'e1',
      channel: 'pv_power_kw',
      aggregat: 'jetzt',
    });
  });

  it('ein Kanalwechsel rettet ein unehrlich gewordenes Aggregat auf „jetzt"', () => {
    // Energie -> Leistung: die Tagessumme wäre dort nicht mehr ehrlich.
    const e = { ...basis, channel: 'energy_kwh', aggregat: 'tagessumme' as const };
    expect(nachKanalwechsel(e, 'pv_power_kw').aggregat).toBe('jetzt');
    // Ein weiterhin ehrliches Aggregat bleibt stehen.
    expect(nachKanalwechsel({ ...basis, aggregat: 'tagesmax' }, 'soc_pct').aggregat).toBe(
      'tagesmax',
    );
  });
});

describe('Schlüssel', () => {
  it('nur ein `eigen:`-Präfix ist eine eigene Auswertung', () => {
    expect(istEigen('eigen:k1')).toBe(true);
    expect(istEigen('kacheln')).toBe(false);
    expect(istEigen(null)).toBe(false);
  });

  it('ein neuer Schlüssel ist frei und trägt nur erlaubte Zeichen', () => {
    expect(neuerSchluessel([])).toBe('eigen:k1');
    expect(neuerSchluessel(['eigen:k1'])).toBe('eigen:k2');
    expect(neuerSchluessel(['eigen:k1', 'eigen:k2'])).toBe('eigen:k3');
    expect(neuerSchluessel([])).toMatch(/^eigen:[a-z0-9][a-z0-9-]*$/);
  });
});

describe('die Werte-Antwort', () => {
  it('die Werte werden über ihren Baustein-Schlüssel gefunden', () => {
    const w = {
      at: '2026-08-25',
      from: '',
      to: '',
      bucketMinutes: 15,
      werte: [
        {
          id: 'eigen:k1',
          titel: 'T',
          darstellung: 'kachel',
          entityId: 'e',
          channel: 'pv_power_kw',
          aggregat: 'jetzt',
          wert: 3,
          kanalart: 'leistung',
          komponente: 'PV',
          entityType: 'producer',
          hinweis: null,
          verlauf: [],
        },
      ],
    } as EigeneAuswertungWerte;
    expect(werteNachId(w).get('eigen:k1')?.wert).toBe(3);
    expect(werteNachId(w).get('eigen:fehlt')).toBeUndefined();
    expect(werteNachId(null).size).toBe(0);
  });
});
