import { describe, expect, it } from 'vitest';
import { POLICY_LABEL } from './ladepunkte';
import {
  CHIP_ABWEICHEND,
  CHIP_STANDARD,
  MODUS_KURZ,
  OHNE_REGEL,
  ZONE_LEER,
  type SiteVerbraucher,
  type Steuerart,
  type VerbraucherEintrag,
  fensterText,
  modusLang,
  quelleChip,
  quelleLang,
  rahmenView,
  ranglisteZusammenfassung,
  regelnChip,
  zeile,
  zielChip,
  zone,
} from './verbraucherZone';

function steuerart(over: Partial<Steuerart> = {}): Steuerart {
  return { quelle: 'sofort', herkunft: 'ohne', ...over };
}

function eintrag(over: Partial<VerbraucherEintrag> = {}): VerbraucherEintrag {
  return {
    entityId: 'e-1',
    name: 'Wallbox Garage',
    typ: 'ev-charger',
    typLabel: 'Ladepunkt',
    ladepunkt: true,
    steuerart: steuerart(),
    regeln: 0,
    ...over,
  };
}

describe('Die Wörter einer Steuerart', () => {
  it('nennt jede Quelle beim Namen und hängt das Fenster an', () => {
    expect(quelleChip(steuerart({ quelle: 'sofort' }))).toBe('Sofort');
    expect(quelleChip(steuerart({ quelle: 'ueberschuss' }))).toBe('Überschuss');
    expect(quelleChip(steuerart({ quelle: 'guenstig' }))).toBe('Günstige Stunden');
    expect(quelleChip(steuerart({
      quelle: 'feste_zeiten',
      fenster: { tage: 'weekdays', von: '13:00', bis: '15:00' },
    }))).toBe('Feste Zeiten 13–15 Uhr');
  });

  it('ein unbekanntes Wort wird „Eigene Regel" — nie ein geratenes', () => {
    expect(quelleChip(steuerart({ quelle: 'irgendwas_neues' }))).toBe('Eigene Regel');
    expect(quelleChip(null)).toBe('Eigene Regel');
    expect(quelleChip(steuerart({ quelle: 'eigene_regel' }))).toBe('Eigene Regel');
  });

  it('die lange Fassung nennt Modus, Schwelle oder Preisgrenze — sonst nichts', () => {
    expect(quelleLang(steuerart({ quelle: 'ueberschuss', ueberschussModus: 'mindestleistung' })))
      .toBe('Überschuss (Sonne zuerst)');
    expect(quelleLang(steuerart({ quelle: 'ueberschuss', ueberschussModus: 'pausieren' })))
      .toBe('Überschuss (nur Sonne)');
    expect(quelleLang(steuerart({ quelle: 'ueberschuss', schwelleKw: 2.5 })))
      .toBe('Überschuss ab 2,5 kW');
    expect(quelleLang(steuerart({ quelle: 'guenstig', preisgrenzeCtKwh: 12 })))
      .toBe('Günstige Stunden unter 12 ct/kWh');
    // Ohne belegte Zahl bleibt es beim nackten Wort.
    expect(quelleLang(steuerart({ quelle: 'ueberschuss' }))).toBe('Überschuss');
  });

  it('MODUS_KURZ ist der ZWILLING von POLICY_LABEL — beide zusammen ändern', () => {
    expect(Object.keys(MODUS_KURZ).sort()).toEqual(['mindestleistung', 'pausieren']);
    expect(modusLang('pausieren')).toBe(POLICY_LABEL.nur_sonne);
    expect(modusLang('mindestleistung')).toBe(POLICY_LABEL.sonne_zuerst);
    expect(modusLang('gibt-es-nicht')).toBeNull();
  });

  it('formatiert ein Fenster nur, wenn es beide Grenzen hat', () => {
    expect(fensterText({ tage: 'daily', von: '06:30', bis: '18:00' })).toBe('06:30–18 Uhr');
    expect(fensterText(null)).toBeNull();
    expect(fensterText({ tage: 'daily', von: '', bis: '18:00' })).toBeNull();
  });
});

describe('Der Ziel-Chip', () => {
  const ziel = steuerart({
    quelle: 'ueberschuss',
    ziel: 'bis_uhrzeit',
    zielFenster: { tage: 'daily', von: '00:00', bis: '06:00' },
    zielEnergieKwh: 20,
  });

  it('nennt Frist und Menge, wo es keinen Beleg gibt', () => {
    expect(zielChip(ziel)).toBe('bis 06:00 · 20 kWh');
  });

  it('zeigt mit Beleg den Fortschritt', () => {
    expect(zielChip(ziel, {
      requirementId: 'r1', state: 'running', actualEnergyKwh: 12.1, requiredEnergyKwh: 20,
    })).toBe('bis 06:00 · 12,1 von 20 kWh');
  });

  it('sagt eine verpasste Frist als solche', () => {
    expect(zielChip(ziel, {
      requirementId: 'r1', state: 'missed', actualEnergyKwh: 14.2, requiredEnergyKwh: 20,
    })).toBe('bis 06:00 · nicht geschafft (14,2 von 20 kWh)');
  });

  it('rechnet ein Laufzeit-Ziel in Minuten', () => {
    const laufzeit = steuerart({
      quelle: 'feste_zeiten', ziel: 'laufzeit_bis',
      zielFenster: { tage: 'daily', von: '06:00', bis: '18:00' },
      zielLaufzeitMinuten: 90,
    });
    expect(zielChip(laufzeit)).toBe('bis 18:00 · 90 Min.');
    expect(zielChip(laufzeit, {
      requirementId: 'r1', state: 'running', actualRuntimeSeconds: 1800,
      requiredRuntimeSeconds: 5400,
    })).toBe('bis 18:00 · 30 von 90 Min.');
  });

  it('ohne Ziel gibt es keinen Chip, und ohne Zahl keine erfundene', () => {
    expect(zielChip(steuerart())).toBeNull();
    expect(zielChip(null)).toBeNull();
    expect(zielChip(steuerart({
      quelle: 'guenstig', ziel: 'bis_uhrzeit',
      zielFenster: { tage: 'daily', von: '00:00', bis: '06:00' },
    }))).toBe('bis 06:00');
  });
});

describe('Die Zeile', () => {
  it('trägt „Standard" bzw. „abweichend" NUR an einem Ladepunkt', () => {
    expect(zeile(eintrag({ steuerart: steuerart({ herkunft: 'standard' }) })).chip)
      .toBe(CHIP_STANDARD);
    expect(zeile(eintrag({ steuerart: steuerart({ herkunft: 'policy' }) })).chip)
      .toBe(CHIP_ABWEICHEND);
    expect(zeile(eintrag({ ladepunkt: false, typ: 'heating-rod', typLabel: 'Heizstab' })).chip)
      .toBeNull();
  });

  it('zählt die Regeln und lässt „Ohne Regel" der Fläche', () => {
    expect(zeile(eintrag({ regeln: 2 })).regeln).toBe('2 Regeln →');
    expect(zeile(eintrag({ regeln: 1 })).regeln).toBe('1 Regel →');
    expect(zeile(eintrag({ regeln: 0 })).regeln).toBeNull();
    expect(regelnChip(0)).toBeNull();
    expect(OHNE_REGEL).toBe('Ohne Regel');
  });

  it('ohne Namen steht der TYP da — nie „null"', () => {
    expect(zeile(eintrag({ name: null })).name).toBe('Ladepunkt');
    expect(zeile(eintrag({ name: '   ' })).name).toBe('Ladepunkt');
  });

  it('markiert eine nicht abbildbare Steuerart als „Eigene Regel"', () => {
    expect(zeile(eintrag({ steuerart: steuerart({ quelle: 'eigene_regel' }) })).eigeneRegel)
      .toBe(true);
    expect(zeile(eintrag()).eigeneRegel).toBe(false);
  });
});

describe('Der Ladepark-Rahmen', () => {
  it('nennt nur BELEGTE Zahlen, in ihrer Reihenfolge', () => {
    const v = rahmenView({
      netzanschlussKw: 32, hoechsteHausLastKw: 5, verteiltKw: 22,
      hinweis: 'Ihr Anschluss ist geschützt.', steckerAnzahl: 4,
    })!;
    expect(v.zahlen).toEqual([
      'Netzanschluss 32 kW', 'Reserve Haus 5 kW', 'gerade 22 kW verteilt',
    ]);
    expect(v.hinweis).toBe('Ihr Anschluss ist geschützt.');
    expect(v.grenzeFehlt).toBe(false);
    expect(v.anteil).toBeCloseTo(22 / 32);
  });

  it('sagt „gemessen", wo die Box wirklich misst', () => {
    const v = rahmenView({ netzanschlussKw: 32, hausLastKw: 5, hoechsteHausLastKw: 40 })!;
    expect(v.zahlen[1]).toBe('Gebäude 5 kW (gemessen)');
  });

  it('ohne Anschlussgrenze fehlt die Zahl UND es steht der Grund an', () => {
    const v = rahmenView({ verteiltKw: 0 })!;
    expect(v.grenzeFehlt).toBe(true);
    expect(v.zahlen).not.toContain(expect.stringContaining('Netzanschluss'));
    expect(v.anteil).toBeNull();
  });

  it('fällt auf die im Portal GEPFLEGTE Grenze zurück, wenn die Box schweigt', () => {
    expect(rahmenView({ gepflegteGrenzeKw: 32 })!.zahlen[0]).toBe('Netzanschluss 32 kW');
  });

  it('ohne Rahmen gibt es keinen', () => {
    expect(rahmenView(null)).toBeNull();
  });
});

describe('Die Zone', () => {
  function daten(over: Partial<SiteVerbraucher> = {}): SiteVerbraucher {
    return {
      verbraucher: [],
      ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
      rangliste: [],
      ...over,
    };
  }

  it('trennt Ladepunkte von den weiteren Verbrauchern', () => {
    const v = zone(daten({
      verbraucher: [
        eintrag({ entityId: 'a' }),
        eintrag({
          entityId: 'b', ladepunkt: false, name: 'Heizstab', typ: 'heating-rod',
          typLabel: 'Heizstab',
        }),
      ],
      ladepunkte: { standard: steuerart({ herkunft: 'standard' }), standardFolger: 1, gesamt: 1, rahmen: null },
    }));
    expect(v.ladepunkte.map((z) => z.entityId)).toEqual(['a']);
    expect(v.weitere.map((z) => z.entityId)).toEqual(['b']);
    expect(v.leer).toBeNull();
    expect(v.standardSatz).toBe('Gilt für 1 von 1 Ladepunkt');
  });

  it('sagt bei GAR NICHTS Steuerbarem den Weg', () => {
    const v = zone(daten());
    expect(v.leer).toBe(ZONE_LEER);
    expect(v.standardSatz).toBeNull();
    expect(v.standard).toBeNull();
  });

  it('überlebt eine fehlende Antwort (fail-soft)', () => {
    const v = zone(null);
    expect(v.leer).toBe(ZONE_LEER);
    expect(v.ladepunkte).toEqual([]);
    expect(v.rangliste).toEqual([]);
  });

  it('fasst die Rangliste zusammen — mit dem, was WIRKLICH oben steht', () => {
    expect(ranglisteZusammenfassung([
      { position: 1, art: 'speicher', entityId: null, name: 'Speicher' },
      { position: 2, art: 'ladepunkt', entityId: 'a', name: 'Wallbox' },
    ])).toBe('Speicher zuerst · 2 Einträge');
    expect(ranglisteZusammenfassung([
      { position: 1, art: 'verbraucher', entityId: 'h', name: 'Heizstab' },
    ])).toBe('Heizstab zuerst · 1 Eintrag');
    expect(ranglisteZusammenfassung([])).toBeNull();
  });

  it('nennt die Schwellen der Skalierung (§6.4)', () => {
    const v = zone(daten());
    expect(v.sucheAb).toBe(12);
    expect(v.klappenAb).toBe(25);
  });
});
