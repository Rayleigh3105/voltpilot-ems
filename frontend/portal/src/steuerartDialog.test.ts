import { describe, expect, it } from 'vitest';
import {
  FLEX_FALLBACK_NOTE,
  entwurfAus,
  fehlt,
  folgen,
  fragen,
  minusStunden,
  mitVorbelegung,
  quellenKarten,
  standardAbweichung,
  wunschAus,
  zielKarten,
  type SteuerartEntwurf,
  type SteuerartOptionen,
} from './steuerartDialog';
import type { VerbraucherEintrag } from './verbraucherZone';

const OPTIONEN: SteuerartOptionen = {
  schreibbar: true,
  quellen: [
    { id: 'sofort', gesperrt: false },
    { id: 'ueberschuss', gesperrt: false },
    { id: 'guenstig', gesperrt: true, grund: 'Ihr Stromtarif hat keine stündlichen Preise.' },
  ],
  ziele: [{ id: 'bis_uhrzeit', gesperrt: false }],
  vorgaben: {
    schwelleKw: 4.2,
    preisgrenzeCtKwh: null,
    mindestlaufzeitMinuten: 10,
    fenster: { tage: 'daily', von: '13:00', bis: '14:00' },
    zielUhrzeit: '06:00',
    zielTage: 'daily',
    zielEnergieKwh: 20,
    zielLaufzeitMinuten: 60,
    zielFensterStunden: 12,
  },
};

function eintrag(over: Partial<VerbraucherEintrag> = {}): VerbraucherEintrag {
  return {
    entityId: 'e1',
    name: 'Wallbox Garage',
    typ: 'wallbox',
    typLabel: 'Wallbox',
    ladepunkt: true,
    steuerart: { quelle: 'sofort', herkunft: 'ohne' },
    regeln: 0,
    optionen: OPTIONEN,
    ...over,
  };
}

describe('Die Karten kommen vom SERVER — nie geraten', () => {
  it('rendert die Quellen in der Reihenfolge des Servers, mit ihren Sperren', () => {
    const k = quellenKarten(OPTIONEN, true);
    expect(k.map((x) => x.id)).toEqual(['sofort', 'ueberschuss', 'guenstig']);
    expect(k[2].gesperrt).toBe(true);
    // ⚠ Eine gesperrte Karte trägt IMMER ihren Grund — er ist der Grund, warum
    // sie überhaupt noch sichtbar ist.
    expect(k[2].grund).toContain('stündlichen Preise');
  });

  it('lässt eine Quelle weg, die dieser Portal-Stand nicht kennt', () => {
    const k = quellenKarten(
      { ...OPTIONEN, quellen: [{ id: 'nachts_wenn_der_mond', gesperrt: false }] }, true);
    expect(k).toEqual([]);
  });

  it('nennt „Sofort" am Ladepunkt anders als an einem Heizstab', () => {
    // Dieselbe Id, zwei ehrliche Sätze: am Ladepunkt ist es eine WAHL, sonst
    // die RÜCKNAHME der Steuerung.
    const lp = quellenKarten(OPTIONEN, true).find((x) => x.id === 'sofort');
    const hz = quellenKarten(OPTIONEN, false).find((x) => x.id === 'sofort');
    expect(lp?.titel).toBe('Sofort laden');
    expect(hz?.titel).toContain('Ohne Steuerung');
    expect(hz?.zeile).toContain('schaltet es nicht');
  });

  it('sagt „lädt" nur am Ladepunkt — ein Heizstab LÄUFT', () => {
    // Die Ladepunkt-Sprache der Mockups gilt nur am Ladepunkt; dieselbe Quelle
    // bekommt sonst ihren eigenen Satz (im Browser aufgefallen).
    const lp = quellenKarten(OPTIONEN, true).find((x) => x.id === 'ueberschuss');
    const hz = quellenKarten(OPTIONEN, false).find((x) => x.id === 'ueberschuss');
    expect(lp?.zeile).toContain('Lädt mit dem Strom');
    expect(hz?.zeile).toContain('Läuft mit dem Strom');
    expect(hz?.zeile).not.toContain('Lädt');
  });

  it('stellt „Kein Ziel" vor die echten Ziele — und lässt sie ganz weg, wo es keines gibt', () => {
    expect(zielKarten(OPTIONEN, true).map((z) => z.id)).toEqual(['', 'bis_uhrzeit']);
    expect(zielKarten({ ...OPTIONEN, ziele: [] }, true)).toEqual([]);
  });
});

describe('Der Entwurf startet beim BESTAND, sonst bei den Server-Vorgaben', () => {
  it('übernimmt die geltende Steuerart samt Werten', () => {
    const e = entwurfAus(eintrag({
      steuerart: {
        quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 2.5,
        ziel: 'bis_uhrzeit', zielFenster: { tage: 'weekdays', von: '18:00', bis: '07:00' },
        zielEnergieKwh: 15,
      },
    }));
    expect(e.quelle).toBe('ueberschuss');
    expect(e.schwelleKw).toBe(2.5);
    expect(e.ziel).toBe('bis_uhrzeit');
    expect(e.zielUhrzeit).toBe('07:00');
    expect(e.zielEnergieKwh).toBe(15);
  });

  it('startet bei „Eigene Regel" OHNE Quelle — nichts wird umgedeutet', () => {
    const e = entwurfAus(eintrag({ steuerart: { quelle: 'eigene_regel', herkunft: 'policy' } }));
    expect(e.quelle).toBe('');
    expect(e.ziel).toBe('');
  });

  it('nimmt die Server-Vorgaben, wo der Bestand nichts sagt', () => {
    const e = entwurfAus(eintrag());
    expect(e.schwelleKw).toBe(4.2);
    expect(e.zielEnergieKwh).toBe(20);
    expect(e.zielUhrzeit).toBe('06:00');
  });

  it('lässt ein Feld LEER, für das es keine belegte Vorgabe gibt', () => {
    const e = entwurfAus(eintrag({
      optionen: { ...OPTIONEN, vorgaben: { ...OPTIONEN.vorgaben, schwelleKw: null } },
    }));
    expect(e.schwelleKw).toBeNull();
  });
});

describe('Der PUT-Rumpf trägt nur, was die Quelle wirklich fragt', () => {
  const basis = entwurfAus(eintrag());

  it('schickt bei „Überschuss" die Schwelle, aber keine Preisgrenze', () => {
    const w = wunschAus({ ...basis, quelle: 'ueberschuss', preisgrenzeCtKwh: 9 });
    expect(w).toEqual({ quelle: 'ueberschuss', schwelleKw: 4.2, mindestlaufzeitMinuten: 10 });
    expect('preisgrenzeCtKwh' in w).toBe(false);
  });

  it('schickt bei „Feste Zeiten" das Fenster', () => {
    const w = wunschAus({
      ...basis, quelle: 'feste_zeiten', fensterTage: 'weekdays',
      fensterVon: '09:00', fensterBis: '11:00',
    });
    expect(w.fenster).toEqual({ tage: 'weekdays', von: '09:00', bis: '11:00' });
  });

  it('schickt beim Ziel den Termin OHNE Beginn — den setzt der Server (§3.2)', () => {
    const w = wunschAus({
      ...basis, quelle: 'ueberschuss', ziel: 'bis_uhrzeit', zielUhrzeit: '06:00',
      zielTage: 'daily', zielEnergieKwh: 20,
    });
    expect(w.zielFenster).toEqual({ tage: 'daily', von: '', bis: '06:00' });
    expect(w.zielEnergieKwh).toBe(20);
  });

  it('schickt bei „Sofort" nur die Quelle — sie nimmt zurück, sie stellt nichts ein', () => {
    expect(wunschAus({ ...basis, quelle: 'sofort' })).toEqual({ quelle: 'sofort' });
  });
});

describe('Der Weiter-Knopf sperrt genau da, wo der Server ablehnen würde', () => {
  const basis = entwurfAus(eintrag());

  it('ohne Quelle', () => {
    expect(fehlt({ ...basis, quelle: '' }, OPTIONEN)).toContain('wählen');
  });

  it('mit einer GESPERRTEN Quelle — und nennt GENAU ihren Grund', () => {
    expect(fehlt({ ...basis, quelle: 'guenstig' }, OPTIONEN))
      .toBe('Ihr Stromtarif hat keine stündlichen Preise.');
  });

  it('ohne Schwelle bei „Überschuss" und ohne Fenster bei „Feste Zeiten"', () => {
    expect(fehlt({ ...basis, quelle: 'ueberschuss', schwelleKw: null }, OPTIONEN))
      .toContain('Überschuss-Schwelle');
    expect(fehlt({
      ...basis, quelle: 'feste_zeiten', fensterVon: '13:00', fensterBis: '13:00',
    }, OPTIONEN)).toContain('nicht gleich');
  });

  it('lässt eine vollständige Wahl durch', () => {
    expect(fehlt({ ...basis, quelle: 'ueberschuss' }, OPTIONEN)).toBeNull();
  });
});

describe('Die Folgen-Karte sagt nur, was der Entwurf hergibt', () => {
  const basis = entwurfAus(eintrag());

  it('nennt Quelle, Ziel, den Box-Notnagel und die Regeln', () => {
    const s = folgen(
      { ...basis, quelle: 'ueberschuss', ziel: 'bis_uhrzeit' },
      { name: 'Wallbox Garage', ladepunkt: true, regeln: 2, zielFensterStunden: 12 },
    );
    expect(s[0]).toContain('4,2 kW');
    expect(s.join(' ')).toContain('06:00');
    expect(s.join(' ')).toContain('20 kWh');
    // Der Frist-Notnagel ist WÖRTLICH der des Regel-Baukastens — dieselbe
    // Zusage darf nicht an zwei Orten anders klingen.
    expect(s).toContain(FLEX_FALLBACK_NOTE);
    expect(s.join(' ')).toContain('2 Regeln');
  });

  it('sagt „Netzstrom erlaubt" nur, wo es strukturell stimmt', () => {
    const nur = folgen({ ...basis, quelle: 'ueberschuss', ziel: '' },
      { name: 'Heizstab', ladepunkt: false, regeln: 0 });
    expect(nur.join(' ')).not.toContain('Netzstrom erlaubt');
    const zeit = folgen({
      ...basis, quelle: 'feste_zeiten', fensterVon: '22:00', fensterBis: '06:00', ziel: '',
    }, { name: 'Heizstab', ladepunkt: false, regeln: 0 });
    expect(zeit.join(' ')).toContain('Netzstrom erlaubt');
  });

  it('nennt den Box-Notnagel NUR mit Frist', () => {
    const ohne = folgen({ ...basis, quelle: 'ueberschuss', ziel: '' },
      { name: 'Heizstab', ladepunkt: false, regeln: 0 });
    expect(ohne).not.toContain(FLEX_FALLBACK_NOTE);
  });

  it('sagt das Ziel-Fenster, das der Server daraus macht', () => {
    const s = folgen({ ...basis, quelle: 'ueberschuss', ziel: 'bis_uhrzeit' },
      { name: 'Wallbox', ladepunkt: true, regeln: 0, zielFensterStunden: 12 });
    expect(s.join(' ')).toContain('zwischen 18:00 und 06:00');
  });

  it('sagt bei „Sofort" an einem Heizstab die RÜCKNAHME, nicht „volle Leistung"', () => {
    const s = folgen({ ...basis, quelle: 'sofort' },
      { name: 'Heizstab', ladepunkt: false, regeln: 0 });
    expect(s[0]).toContain('VoltPilot schaltet es nicht');
  });
});

describe('Die Abweichung vom Anlagen-Standard', () => {
  const basis = entwurfAus(eintrag());

  it('steht nur an einem Ladepunkt und nur bei bekanntem Standard', () => {
    expect(standardAbweichung({ ...basis, quelle: 'ueberschuss' },
      { name: 'x', ladepunkt: false, regeln: 0, standard: { quelle: 'sofort', herkunft: 'standard' } }))
      .toBeNull();
    expect(standardAbweichung({ ...basis, quelle: 'ueberschuss' },
      { name: 'x', ladepunkt: true, regeln: 0, standard: null })).toBeNull();
  });

  it('schweigt, wo die Wahl DEM Standard entspricht', () => {
    expect(standardAbweichung({ ...basis, quelle: 'sofort', ziel: '' },
      { name: 'x', ladepunkt: true, regeln: 0, standard: { quelle: 'sofort', herkunft: 'standard' } }))
      .toBeNull();
  });

  it('nennt sie, wo die Wahl abweicht', () => {
    expect(standardAbweichung({ ...basis, quelle: 'ueberschuss', ziel: '' },
      { name: 'x', ladepunkt: true, regeln: 0, standard: { quelle: 'sofort', herkunft: 'standard' } }))
      .toContain('weicht');
  });
});

describe('Die Vorbelegung eines Vorschlags', () => {
  it('setzt nur, was der Vorschlag WIRKLICH sagt', () => {
    const basis = { ...entwurfAus(eintrag()), zielEnergieKwh: 33 };
    const e = mitVorbelegung(basis, { quelle: 'guenstig', preisgrenzeCtKwh: 8 });
    expect(e.quelle).toBe('guenstig');
    expect(e.preisgrenzeCtKwh).toBe(8);
    // Was er nicht sagt, bleibt stehen — nie ein pauschales Überschreiben.
    expect(e.zielEnergieKwh).toBe(33);
    expect(e.schwelleKw).toBe(4.2);
  });

  it('lässt den Entwurf unberührt, wenn es keinen Vorschlag gibt', () => {
    const basis = entwurfAus(eintrag());
    expect(mitVorbelegung(basis, null)).toBe(basis);
  });
});

describe('Die Folgefragen je Quelle (§3.2)', () => {
  it('fragt genau das, was diese Quelle braucht', () => {
    expect(fragen('ueberschuss')).toEqual(['schwelle', 'mindestlaufzeit']);
    expect(fragen('guenstig')).toEqual(['preisgrenze']);
    expect(fragen('feste_zeiten')).toEqual(['fenster']);
    expect(fragen('freigabe_ueberschuss')).toEqual(['schwelle', 'mindestlaufzeit', 'sperrzeit']);
    // „Sofort" hat nichts zu fragen — der Dialog überspringt den Schritt.
    expect(fragen('sofort')).toEqual([]);
  });
});

describe('Die Fenster-Arithmetik ist der Zwilling der Server-Regel', () => {
  it('rechnet über Mitternacht und lässt Unlesbares stehen', () => {
    expect(minusStunden('06:00', 12)).toBe('18:00');
    expect(minusStunden('02:15', 12)).toBe('14:15');
    expect(minusStunden('kaputt', 12)).toBe('kaputt');
  });
});

// ---------------------------------------------------------------------------
// P5: die Quellen-BAHN je Ladepunkt (§3.2)
// ---------------------------------------------------------------------------

describe('die Modus-Frage am Ladepunkt (P5)', () => {
  it('gibt es NUR am Ladepunkt', () => {
    expect(fragen('ueberschuss')).not.toContain('ueberschussModus');
    expect(fragen('ueberschuss', true)).toContain('ueberschussModus');
  });

  it('laesst jede andere Quelle Zeichen fuer Zeichen unveraendert', () => {
    for (const q of ['guenstig', 'feste_zeiten', 'sofort', 'freigabe_guenstig']) {
      expect(fragen(q, true)).toEqual(fragen(q));
    }
  });

  it('reist als Bahn mit - und der Boden NUR, wenn er gemeint ist', () => {
    const e = {
      ...entwurfAus(null),
      quelle: 'ueberschuss',
      ueberschussModus: 'mindestleistung',
      mindestleistungKw: 4.2,
    };
    const w = wunschAus(e, true);
    expect(w.ueberschussModus).toBe('mindestleistung');
    expect(w.mindestleistungKw).toBe(4.2);

    const pause = wunschAus({ ...e, ueberschussModus: 'pausieren' }, true);
    expect(pause.ueberschussModus).toBe('pausieren');
    // ⚠ Eine Zahl ohne Wirkung koennte der Server als `sonne_zuerst` lesen.
    expect(pause.mindestleistungKw).toBeUndefined();
  });

  it('sendet die Bahn NICHT von einem Nicht-Ladepunkt', () => {
    const w = wunschAus(
      { ...entwurfAus(null), quelle: 'ueberschuss', ueberschussModus: 'mindestleistung' },
      false,
    );
    expect(w.ueberschussModus).toBeUndefined();
  });

  it('startet ohne gespeicherte Angabe auf `pausieren`', () => {
    // „Nur Sonnenstrom" ist die ehrliche Vorgabe - `mindestleistung` waere eine
    // Netzstrom-Freigabe, die niemand erteilt hat.
    expect(entwurfAus(null).ueberschussModus).toBe('pausieren');
  });
});

