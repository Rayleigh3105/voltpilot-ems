import { describe, expect, it } from 'vitest';
import {
  abschnittHash,
  ankerId,
  GESICHT_ZU_RAHMEN,
  initialSektionOffen,
  istKlappbar,
  kopfHinweis,
  kurz,
  parseAbschnitt,
  rahmen,
  SEKTION_FRAGE,
  SEKTION_ICON,
  SEKTION_TITEL,
  SEKTIONS_ORDNUNG,
  sektionKey,
  standardOffen,
  type RahmenSektionId,
} from './geraetRahmen';

/**
 * Der RAHMEN aller Geräteseiten (Konzept `data/vp-geraeteseite-rahmen-r2` §4).
 *
 * Geprüft wird, was den Rahmen ausmacht: die kanonische ORDNUNG, der
 * Standard-Offen-Entscheid D2a, die zwei Leerzustands-Arten, der EINE
 * Kopf-Hinweis, der Deep-Link und der Klapp-Speicher.
 */
describe('SEKTIONS_ORDNUNG — die feste Reihenfolge (§4.4)', () => {
  it('ist genau die neun Sektionen des Konzepts, in seiner Reihenfolge', () => {
    expect(SEKTIONS_ORDNUNG).toEqual([
      'jetzt', 'befehle', 'steuerung', 'komponenten', 'register',
      'verbindung', 'software', 'diagnose', 'plattform',
    ]);
  });

  it('gibt jeder Sektion einen Namen und ein Sinnbild', () => {
    for (const id of SEKTIONS_ORDNUNG) {
      expect(SEKTION_TITEL[id]?.trim()).toBeTruthy();
      expect(SEKTION_ICON[id]?.trim()).toBeTruthy();
    }
  });

  it('nennt für jede Kunden-Sektion ihre Frage — nur die Plattform-Sicht hat keine', () => {
    for (const id of SEKTIONS_ORDNUNG) {
      if (id === 'plattform') expect(SEKTION_FRAGE[id]).toBeNull();
      else expect(SEKTION_FRAGE[id]?.trim()).toBeTruthy();
    }
  });

  it('lässt VIER Gesicht-Sektionen in „Steuerung & Grenzen" aufgehen', () => {
    expect(GESICHT_ZU_RAHMEN.grenzen).toBe('steuerung');
    expect(GESICHT_ZU_RAHMEN.einspeise).toBe('steuerung');
    expect(GESICHT_ZU_RAHMEN.ausfallschutz).toBe('steuerung');
    expect(GESICHT_ZU_RAHMEN.ladepark).toBe('steuerung');
  });

  it('bildet jede andere Gesicht-Sektion auf ihren gleichnamigen Platz ab', () => {
    for (const id of ['jetzt', 'befehle', 'komponenten', 'register', 'verbindung', 'software'] as const) {
      expect(GESICHT_ZU_RAHMEN[id]).toBe(id);
    }
  });
});

describe('rahmen — die Ordnung gehört dem Rahmen, nicht dem Aufrufer', () => {
  it('sortiert kanonisch, egal in welcher Reihenfolge der Wirt anbietet', () => {
    const v = rahmen([
      { id: 'software' }, { id: 'jetzt' }, { id: 'register' }, { id: 'befehle' },
    ]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['jetzt', 'befehle', 'register', 'software']);
  });

  it('lässt aus, was der Wirt nicht anbietet — nie eine leere Behauptung', () => {
    const v = rahmen([{ id: 'jetzt' }, { id: 'verbindung' }]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['jetzt', 'verbindung']);
  });

  it('ignoriert ein unbekanntes Fach', () => {
    const v = rahmen([{ id: 'jetzt' }, { id: 'erfunden' as RahmenSektionId }]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['jetzt']);
  });

  it('zeigt eine doppelt genannte Sektion einmal — der erste Eintrag gewinnt', () => {
    const v = rahmen([
      { id: 'befehle', kurzfassung: 'zuletzt 14:02' },
      { id: 'befehle', kurzfassung: 'etwas anderes' },
    ]);
    expect(v.sektionen).toHaveLength(1);
    expect(v.sektionen[0].kurzfassung).toBe('zuletzt 14:02');
  });

  it('überschreibt den Namen nur, wenn ein Blatt ausdrücklich einen nennt', () => {
    const v = rahmen([{ id: 'register', titel: 'Messwerte' }, { id: 'verbindung' }]);
    expect(v.sektionen[0].titel).toBe('Messwerte');
    expect(v.sektionen[1].titel).toBe(SEKTION_TITEL.verbindung);
  });

  it('nimmt einen leeren Namen NICHT als Namen', () => {
    const v = rahmen([{ id: 'register', titel: '   ' }]);
    expect(v.sektionen[0].titel).toBe(SEKTION_TITEL.register);
  });
});

describe('Standard offen — Captain-Entscheid D2a', () => {
  it('öffnet Jetzt und Befehle, alles Übrige bleibt zu', () => {
    expect(standardOffen('jetzt')).toBe(true);
    expect(standardOffen('befehle')).toBe(true);
    for (const id of SEKTIONS_ORDNUNG) {
      if (id === 'jetzt' || id === 'befehle') continue;
      expect(standardOffen(id)).toBe(false);
    }
  });

  it('trägt die Vorgabe an jedem Eintrag', () => {
    const v = rahmen(SEKTIONS_ORDNUNG.map((id) => ({ id })));
    const offen = v.sektionen.filter((s) => s.offenAlsVorgabe).map((s) => s.id);
    expect(offen).toEqual(['jetzt', 'befehle']);
  });

  it('gibt „Jetzt" als EINZIGE keinen Klapp-Kopf (§4.5)', () => {
    expect(istKlappbar('jetzt')).toBe(false);
    for (const id of SEKTIONS_ORDNUNG) {
      if (id === 'jetzt') continue;
      expect(istKlappbar(id)).toBe(true);
    }
  });
});

describe('Leerzustände — zwei Arten, zwei Behandlungen (§4.6)', () => {
  it('STRUKTURELL leer: die Sektion entfällt, ihr Grund zieht in die Diagnose', () => {
    const v = rahmen([
      { id: 'jetzt' },
      { id: 'register', entfaellt: true, grund: 'Dieses Gerät wird über seine Web-Schnittstelle gelesen.' },
      { id: 'verbindung' },
    ]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['jetzt', 'verbindung']);
    expect(v.entfallen).toEqual(['Dieses Gerät wird über seine Web-Schnittstelle gelesen.']);
  });

  it('SITUATIV leer: die Sektion bleibt und trägt ihren Grund in der Kurzfassung', () => {
    const v = rahmen([
      { id: 'befehle', kurzfassung: 'Die Aufzeichnung hat noch nicht begonnen.' },
    ]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['befehle']);
    expect(v.sektionen[0].kurzfassung).toBe('Die Aufzeichnung hat noch nicht begonnen.');
    expect(v.entfallen).toEqual([]);
  });

  it('sammelt die Gründe in kanonischer Ordnung, nie in Aufruf-Ordnung', () => {
    const v = rahmen([
      { id: 'software', entfaellt: true, grund: 'kein Firmware-Stand' },
      { id: 'register', entfaellt: true, grund: 'keine Register' },
    ]);
    expect(v.entfallen).toEqual(['keine Register', 'kein Firmware-Stand']);
  });

  it('behauptet ohne Grund nichts — eine entfallene Sektion ohne Satz bleibt still', () => {
    const v = rahmen([{ id: 'register', entfaellt: true }]);
    expect(v.sektionen).toEqual([]);
    expect(v.entfallen).toEqual([]);
  });

  it('macht aus einer leeren Kurzfassung `null`, nie ein „—"', () => {
    const v = rahmen([{ id: 'befehle', kurzfassung: '  ' }]);
    expect(v.sektionen[0].kurzfassung).toBeNull();
  });
});

describe('kurz — die Kurzfassung erfindet nichts', () => {
  it('verbindet die belegten Teile mit „ · "', () => {
    expect(kurz('zuletzt 14:02', 'bestätigt')).toBe('zuletzt 14:02 · bestätigt');
  });

  it('lässt leere Teile weg', () => {
    expect(kurz('Solarman', null, '192.168.20.14', undefined, '  ', 'vor 12 s'))
      .toBe('Solarman · 192.168.20.14 · vor 12 s');
  });

  it('gibt ohne einen einzigen belegten Teil `null` zurück', () => {
    expect(kurz(null, undefined, '')).toBeNull();
    expect(kurz()).toBeNull();
  });
});

describe('kopfHinweis — höchstens EINER, der schlimmste (§4.1 Zeile 3)', () => {
  const alle = SEKTIONS_ORDNUNG;

  it('gibt ohne Befund nichts zurück', () => {
    expect(kopfHinweis([], alle)).toBeNull();
    expect(kopfHinweis([null, undefined], alle)).toBeNull();
  });

  it('zeigt den EINEN Befund samt der Sektion, die ihn erklärt', () => {
    const h = kopfHinweis([
      { art: 'grenze', satz: 'Ihr Wechselrichter begrenzt auf 33,0 kW — hinterlegt sind 70,0 kW.', ton: 'warn' },
    ], alle);
    expect(h).toEqual({
      satz: 'Ihr Wechselrichter begrenzt auf 33,0 kW — hinterlegt sind 70,0 kW.',
      ton: 'warn',
      art: 'grenze',
      sektion: 'register',
    });
  });

  it('lässt den schlimmsten gewinnen, unabhängig von der Aufruf-Reihenfolge', () => {
    const befunde = [
      { art: 'grenze' as const, satz: 'Grenze', ton: 'warn' as const },
      { art: 'verbindung' as const, satz: 'Tot', ton: 'off' as const },
      { art: 'waechter' as const, satz: 'Wächter', ton: 'warn' as const },
    ];
    expect(kopfHinweis(befunde, alle)?.art).toBe('verbindung');
    expect(kopfHinweis([...befunde].reverse(), alle)?.art).toBe('verbindung');
  });

  it('ordnet die vier Arten: Verbindung > Rücklesen > Wächter > Grenze', () => {
    const satz = (art: 'verbindung' | 'ruecklesen' | 'waechter' | 'grenze') =>
      ({ art, satz: art, ton: 'warn' as const });
    expect(kopfHinweis([satz('ruecklesen'), satz('waechter'), satz('grenze')], alle)?.art)
      .toBe('ruecklesen');
    expect(kopfHinweis([satz('waechter'), satz('grenze')], alle)?.art).toBe('waechter');
    expect(kopfHinweis([satz('grenze')], alle)?.art).toBe('grenze');
  });

  it('verwirft einen Befund ohne Satz — der Rahmen formuliert keinen', () => {
    expect(kopfHinweis([{ art: 'waechter', satz: '   ', ton: 'warn' }], alle)).toBeNull();
  });

  it('verwirft eine unbekannte Befund-Art, statt sie zu zeigen', () => {
    expect(kopfHinweis(
      [{ art: 'erfunden' as 'grenze', satz: 'irgendwas', ton: 'warn' }],
      alle,
    )).toBeNull();
  });

  it('bietet KEINEN Weg an, wo die Seite die Sektion gar nicht hat', () => {
    const h = kopfHinweis(
      [{ art: 'grenze', satz: 'Grenze', ton: 'warn' }],
      ['jetzt', 'verbindung'],
    );
    expect(h?.satz).toBe('Grenze');
    expect(h?.sektion).toBeNull();
  });
});

describe('Klapp-Zustand — je Gerät, je Tab-Sitzung (§4.5)', () => {
  it('schlüsselt je Gerät UND je Sektion', () => {
    expect(sektionKey('site-1:inverter', 'register'))
      .toBe('vp.geraet.sektion.site-1:inverter.register');
    expect(sektionKey('site-1:inverter', 'register'))
      .not.toBe(sektionKey('site-1:cp-A', 'register'));
  });

  it('lässt die gespeicherte Wahl über den Standard gewinnen — in BEIDE Richtungen', () => {
    expect(initialSektionOffen('1', 'register')).toBe(true);
    expect(initialSektionOffen('0', 'befehle')).toBe(false);
  });

  it('fällt ohne Wahl auf den Standard zurück', () => {
    expect(initialSektionOffen(null, 'befehle')).toBe(true);
    expect(initialSektionOffen(null, 'register')).toBe(false);
    expect(initialSektionOffen(undefined, 'jetzt')).toBe(true);
  });

  it('nimmt alles außer den zwei bekannten Wörtern NICHT als Wahl', () => {
    expect(initialSektionOffen('ja', 'register')).toBe(false);
    expect(initialSektionOffen('', 'befehle')).toBe(true);
  });
});

describe('Deep-Link `?abschnitt=` — ein Parameter, keine zweite Raute (§4.3)', () => {
  it('liest die genannte Sektion', () => {
    expect(parseAbschnitt('#/anlage/s1/geraet/vp-1?abschnitt=register')).toBe('register');
  });

  it('liest sie auch neben anderen Parametern', () => {
    expect(parseAbschnitt('#/anlage/s1/geraet/vp-1?z=1&abschnitt=steuerung')).toBe('steuerung');
  });

  it('rät NIE: eine unbekannte Sektion öffnet nichts', () => {
    expect(parseAbschnitt('#/anlage/s1/geraet/vp-1?abschnitt=erfunden')).toBeNull();
    expect(parseAbschnitt('#/anlage/s1/geraet/vp-1')).toBeNull();
    expect(parseAbschnitt('')).toBeNull();
  });

  it('schreibt die Sektion als Parameter, nie als zweite Raute', () => {
    const h = abschnittHash('#/anlage/s1/geraet/vp-1', 'register');
    expect(h).toBe('#/anlage/s1/geraet/vp-1?abschnitt=register');
    expect(h.slice(1)).not.toContain('#');
  });

  it('erhält einen bestehenden Query-Teil und ersetzt nur den Abschnitt', () => {
    expect(abschnittHash('#/anlage/s1/geraet/vp-1?abschnitt=jetzt&f=1', 'software'))
      .toBe('#/anlage/s1/geraet/vp-1?abschnitt=software&f=1');
  });

  it('nimmt den Abschnitt wieder heraus', () => {
    expect(abschnittHash('#/anlage/s1/geraet/vp-1?abschnitt=jetzt', null))
      .toBe('#/anlage/s1/geraet/vp-1');
  });

  it('ist mit `parseAbschnitt` rundlauffähig', () => {
    for (const id of SEKTIONS_ORDNUNG) {
      expect(parseAbschnitt(abschnittHash('#/anlage/s1/box/vp-1', id))).toBe(id);
    }
  });

  it('gibt jeder Sektion einen eigenen Sprungpunkt', () => {
    const ids = new Set(SEKTIONS_ORDNUNG.map((id) => ankerId(id)));
    expect(ids.size).toBe(SEKTIONS_ORDNUNG.length);
  });
});

describe('Rollen-Tor — die Plattform-Sicht ist eine Sektion wie jede andere (§4.7)', () => {
  it('erscheint nur, wenn der Wirt sie anbietet — es gibt keine zweite Sektionsliste', () => {
    const kunde = rahmen([{ id: 'jetzt' }, { id: 'verbindung' }]);
    expect(kunde.sektionen.map((s) => s.id)).not.toContain('plattform');

    const admin = rahmen([{ id: 'jetzt' }, { id: 'verbindung' }, { id: 'plattform' }]);
    expect(admin.sektionen.map((s) => s.id)).toEqual(['jetzt', 'verbindung', 'plattform']);
  });

  it('setzt sie ans ENDE, egal wo der Wirt sie nennt', () => {
    const v = rahmen([{ id: 'plattform' }, { id: 'jetzt' }, { id: 'diagnose' }]);
    expect(v.sektionen.map((s) => s.id)).toEqual(['jetzt', 'diagnose', 'plattform']);
  });

  it('beginnt zu — die Betreiber-Sicht drängt sich einem Kunden-Blick nie auf', () => {
    expect(standardOffen('plattform')).toBe(false);
    expect(standardOffen('diagnose')).toBe(false);
  });
});
