import { describe, expect, it } from 'vitest';
import {
  ALTBESTAND_TITEL,
  DURCH_VOLTPILOT,
  GRUNDMODUS_SATZ,
  GRUNDMODUS_TITEL,
  altbestandSatz,
  ampel,
  betriebsmodellKarten,
  betriebsmodellZone,
  laeuftSeit,
  nichtMoeglichGrund,
  nichtMoeglichTitel,
} from './betriebsmodelle';
import type { SiteProfile } from './profiles';
import type { ActiveMode } from './surface';

function profile(over: Partial<SiteProfile> & { id: string }): SiteProfile {
  return {
    label: over.id,
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

const NOW = new Date('2026-08-25T14:00:00');

// ---------------------------------------------------------------------------
// 1 · Die Voraussetzungs-Ampel
// ---------------------------------------------------------------------------

describe('ampel', () => {
  it('trägt je Voraussetzung Urteil, Art und - nur wo nötig - den WEG', () => {
    const zeilen = ampel(profile({
      id: 'x',
      requirements: [
        { label: 'Speicher', met: true, art: 'hardware', behebung: null },
        {
          label: 'Marktzugang',
          met: false,
          art: 'einstellung',
          behebung: { ziel: 'einstellungen', label: 'Stromtarif hinterlegen' },
        },
      ],
    }));
    expect(zeilen[0]).toMatchObject({ met: true, art: 'hardware', text: 'Speicher', weg: null });
    expect(zeilen[1]).toMatchObject({
      met: false,
      art: 'einstellung',
      text: 'Marktzugang fehlt',
      weg: { ziel: 'einstellungen', label: 'Stromtarif hinterlegen' },
    });
  });

  it('bietet KEINEN Weg an einer ERFÜLLTEN Voraussetzung - da gibt es nichts zu tun', () => {
    const [zeile] = ampel(profile({
      id: 'x',
      requirements: [{
        label: 'Marktzugang',
        met: true,
        art: 'einstellung',
        behebung: { ziel: 'einstellungen', label: 'Stromtarif hinterlegen' },
      }],
    }));
    expect(zeile.weg).toBeNull();
    expect(zeile.durchVoltpilot).toBeNull();
  });

  it('sagt bei einem VoltPilot-Wert den Satz, statt einen Knopf ins Leere zu zeigen', () => {
    const [zeile] = ampel(profile({
      id: 'x',
      requirements: [{
        label: 'Leistungspreis hinterlegt',
        met: false,
        art: 'einstellung',
        behebung: { ziel: 'voltpilot', label: null },
      }],
    }));
    expect(zeile.weg).toBeNull();
    expect(zeile.durchVoltpilot).toBe(DURCH_VOLTPILOT);
  });

  it('⚠ liest eine Voraussetzung OHNE `art` als HARDWARE - die vorsichtigere Lesart', () => {
    // Ein ÄLTERER Server sendet sie nicht. „Hardware" verspricht nie, ein Klick
    // würde reichen; „Einstellung" täte es.
    const [zeile] = ampel(profile({
      id: 'x',
      requirements: [{ label: 'Speicher', met: false }],
    }));
    expect(zeile.art).toBe('hardware');
    expect(zeile.weg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 · „läuft seit …"
// ---------------------------------------------------------------------------

describe('laeuftSeit', () => {
  it('nennt bei HEUTE die Uhrzeit - ein nacktes Datum läse sich wie „schon länger"', () => {
    expect(laeuftSeit('2026-08-25T09:05:00', NOW)).toBe('läuft seit heute, 09:05 Uhr');
  });

  it('sagt „gestern" und sonst das Datum', () => {
    expect(laeuftSeit('2026-08-24T22:00:00', NOW)).toBe('läuft seit gestern');
    expect(laeuftSeit('2026-08-12T09:15:00', NOW)).toBe('läuft seit 12.08.2026');
  });

  it('⚠ behauptet OHNE Stempel nichts - null heißt „nicht belegt", nie „läuft nicht"', () => {
    // Eine abgeleitet aktive Anwendung (jede Bestandsanlage) hat gar keine
    // gespeicherte Zeile.
    expect(laeuftSeit(null, NOW)).toBeNull();
    expect(laeuftSeit(undefined, NOW)).toBeNull();
    expect(laeuftSeit('kein Datum', NOW)).toBeNull();
  });

  it('gibt eine ZUKUNFTS-Zeit nicht als „seit" aus (Uhren-Versatz)', () => {
    expect(laeuftSeit('2026-08-26T09:00:00', NOW)).toBeNull();
    // Ein paar Sekunden Versatz sind kein Grund zu schweigen.
    expect(laeuftSeit('2026-08-25T14:00:20', NOW)).toBe('läuft seit heute, 14:00 Uhr');
  });
});

// ---------------------------------------------------------------------------
// 3 · Karten + Zone
// ---------------------------------------------------------------------------

const MODES: ActiveMode[] = [];

describe('betriebsmodellKarten', () => {
  it('führt NUR das Regal - alles andere gehört nicht in diese Zone', () => {
    const karten = betriebsmodellKarten([
      profile({ id: 'monitoring' }),
      profile({ id: 'ueberschuss' }),
      profile({ id: 'lastspitzenkappung' }),
    ], MODES, null, NOW);
    expect(karten.map((k) => k.id)).toEqual(['lastspitzenkappung']);
  });

  it('lässt eine Id aus, die DIESE Katalog-Kopie nicht kennt', () => {
    // Ein NEUERER Server. Ohne Nutzen-Satz gerendert wäre die Karte eine leere
    // Behauptung - die `profileRows`-Disziplin.
    expect(betriebsmodellKarten([profile({ id: 'gibt-es-nicht' })], MODES, null, NOW))
      .toEqual([]);
  });

  it('trägt Gruppe, Nutzen, Ampel und - nur bei AKTIV - „seit" und Beleg', () => {
    const [aus, an] = betriebsmodellKarten([
      profile({ id: 'marktvermarktung', seit: '2026-08-12T09:15:00' }),
      profile({ id: 'lastspitzenkappung', active: true, seit: '2026-08-12T09:15:00' }),
    ], MODES, null, NOW);
    expect(aus.gruppe).toBe('speicher');
    expect(aus.nutzen).not.toBe('');
    // ⚠ Ein AUSGESCHALTETES Modell trägt kein „läuft seit" - es läuft nicht.
    expect(aus.seit).toBeNull();
    expect(aus.beleg).toBeNull();
    expect(an.seit).toBe('läuft seit 12.08.2026');
  });

  it('ist NICHT möglich, sobald HARDWARE fehlt - eine Einstellung reicht dafür nicht', () => {
    const [hardware, einstellung] = betriebsmodellKarten([
      profile({
        id: 'atypische-netznutzung',
        requirements: [{ label: 'Leistungsmessung', met: false, art: 'hardware' }],
      }),
      profile({
        id: 'marktvermarktung',
        requirements: [{ label: 'Marktzugang', met: false, art: 'einstellung' }],
      }),
    ], MODES, null, NOW);
    expect(hardware.moeglich).toBe(false);
    expect(hardware.fehlendeHardware).toEqual(['Leistungsmessung']);
    // Ein fehlender Tarif ist kein Anlagen-Fakt - die Karte bleibt wählbar.
    expect(einstellung.moeglich).toBe(true);
  });
});

describe('betriebsmodellZone', () => {
  const gruppe = (id: string, active = false) => profile({ id, active });

  it('bündelt die EXKLUSIVE Gruppe zur Radiogruppe und nennt das laufende Modell', () => {
    const zone = betriebsmodellZone([
      gruppe('lastspitzenkappung', true),
      gruppe('marktvermarktung'),
    ], MODES, null, NOW);
    expect(zone.radio.map((k) => k.id))
      .toEqual(['lastspitzenkappung', 'marktvermarktung']);
    expect(zone.aktiv?.id).toBe('lastspitzenkappung');
    expect(zone.altbestand).toEqual([]);
  });

  it('⚠ ein Modell OHNE Gruppe ist ein EIGENER Schalter - es konkurriert mit niemandem', () => {
    // Das Ladepark-Lastmanagement ist SCHUTZ: es läuft auf der Box weiter, was
    // auch immer eine Karte sagt, und darf neben jedem Betriebsmodell laufen.
    const zone = betriebsmodellZone([
      gruppe('lastspitzenkappung', true),
      gruppe('lastmanagement', true),
    ], MODES, null, NOW);
    expect(zone.radio.map((k) => k.id)).toEqual(['lastspitzenkappung']);
    expect(zone.eigene.map((k) => k.id)).toEqual(['lastmanagement']);
    // Und es macht die Anlage NICHT zum Altbestand.
    expect(zone.altbestand).toEqual([]);
  });

  it('ALTBESTAND: zwei aktive derselben Gruppe - und `aktiv` bleibt bewusst null', () => {
    const zone = betriebsmodellZone([
      gruppe('lastspitzenkappung', true),
      gruppe('marktvermarktung', true),
    ], MODES, null, NOW);
    expect(zone.altbestand.map((k) => k.id))
      .toEqual(['lastspitzenkappung', 'marktvermarktung']);
    // Es gibt kein EINES - die Fläche muss fragen, nicht behaupten.
    expect(zone.aktiv).toBeNull();
  });

  it('⚠ zählt für den Altbestand auch eine „nicht mögliche" Karte mit', () => {
    // Ein abgeleitetes Signal fragt nicht nach der Hardware; ein Altbestand
    // darf nicht daran vorbeigehen, weil eine der beiden eingeklappt steht.
    const zone = betriebsmodellZone([
      gruppe('lastspitzenkappung', true),
      profile({
        id: 'atypische-netznutzung',
        active: true,
        requirements: [{ label: 'Leistungsmessung', met: false, art: 'hardware' }],
      }),
    ], MODES, null, NOW);
    expect(zone.nichtMoeglich.map((k) => k.id)).toEqual(['atypische-netznutzung']);
    expect(zone.altbestand).toHaveLength(2);
  });

  it('klappt weg, was diese Anlage nicht kann - und behält es im Blick', () => {
    const zone = betriebsmodellZone([
      profile({
        id: 'atypische-netznutzung',
        requirements: [{ label: 'Leistungsmessung', met: false, art: 'hardware' }],
      }),
    ], MODES, null, NOW);
    expect(zone.radio).toEqual([]);
    expect(zone.nichtMoeglich.map((k) => k.id)).toEqual(['atypische-netznutzung']);
  });

  it('ohne Antwort (älteres Backend) ist die Zone leer - nie erfunden', () => {
    const zone = betriebsmodellZone(null, MODES, null, NOW);
    expect(zone).toEqual({
      radio: [], eigene: [], nichtMoeglich: [], aktiv: null, altbestand: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 4 · Copy
// ---------------------------------------------------------------------------

describe('Copy der Zone', () => {
  it('macht den GRUNDMODUS zu einer vollwertigen Wahl, nicht zu einem Leer-Zustand', () => {
    expect(GRUNDMODUS_TITEL).toBe('Eigenverbrauchs-Fahrplan');
    expect(GRUNDMODUS_SATZ).toMatch(/Ohne Betriebsmodell/);
    expect(GRUNDMODUS_SATZ).toMatch(/eigener Strom im Haus/);
  });

  it('zählt die eingeklappten Karten richtig und nennt je Karte ihren GRUND', () => {
    expect(nichtMoeglichTitel(1)).toBe('Nicht möglich auf dieser Anlage: 1 Betriebsmodell');
    expect(nichtMoeglichTitel(2)).toBe('Nicht möglich auf dieser Anlage: 2 Betriebsmodelle');
    const [karte] = betriebsmodellZone([
      profile({
        id: 'atypische-netznutzung',
        label: 'Atypische Netznutzung',
        requirements: [
          { label: 'Leistungsmessung', met: false, art: 'hardware' },
          { label: 'Speicher', met: false, art: 'hardware' },
        ],
      }),
    ], MODES, null, NOW).nichtMoeglich;
    expect(nichtMoeglichGrund(karte))
      .toBe('Atypische Netznutzung — dafür fehlt Leistungsmessung und Speicher.');
  });

  it('⚠ der Altbestands-Satz FORDERT eine Wahl - er nimmt sie nicht vorweg', () => {
    const karten = betriebsmodellZone([
      profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true }),
      profile({ id: 'marktvermarktung', label: 'Marktoptimierung', active: true }),
    ], MODES, null, NOW).altbestand;
    const satz = altbestandSatz(karten)!;
    expect(satz).toContain('Lastspitzenkappung und Marktoptimierung');
    expect(satz).toContain('VoltPilot schaltet von sich aus nichts ab');
    expect(ALTBESTAND_TITEL).toBe('Bitte wählen Sie ein Betriebsmodell');
  });

  it('sagt ohne Altbestand GAR NICHTS', () => {
    expect(altbestandSatz([])).toBeNull();
  });
});
