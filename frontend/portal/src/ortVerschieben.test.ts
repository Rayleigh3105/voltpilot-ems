import { describe, expect, it } from 'vitest';
import { menueEintraege } from './ortArchiv';
import {
  danachAbzeichen,
  ergebnisSatz,
  folgenKarte,
  KEINE_MESSSTELLE,
  NICHTS_AENDERT_SICH,
  protokollZeile,
  pruefeVerschieben,
  verschiebenAnfrage,
  verschiebenFeldAusServer,
  WEG_ANLAGE,
  WEG_MESSSTELLE,
  zeitpunktSatz,
  zeitstrahl,
  zielOptionen,
} from './ortVerschieben';
import { ORT_IDS } from './test/ortsbaumFixtures';
import {
  ahrenbergV1,
  ahrenbergV4,
  halle2NachNord,
  halle2Rueckwirkend,
  halle2Verschoben,
  lagerNachHalle1,
  NORD_ID,
  zieleBereich,
  zieleGebaeude,
} from './test/ortVerschiebenFixtures';

/**
 * UEMS AP-02 IP-12 — die reine Hälfte von „Verschieben“: der Wortlaut der Folgen-Karte (V3, A13), was
 * der Tag bedeutet (V2), das Ergebnis mit Zeitstrahl und Protokolleintrag (V4) und das Abzeichen im Baum.
 */

function alleSaetze(k: ReturnType<typeof folgenKarte>): string[] {
  return [...k.ziehtMit, ...k.bleibt.flatMap((b) => [b.satz, b.weg ?? '']), ...k.auswertungen, k.nichts];
}

describe('Folgen-Karte (V3, A13)', () => {
  it('Halle 2 → Werk Ahrenberg Nord: was mitzieht, was bleibt — mit Weg — und dass sich nichts ändert', () => {
    const k = folgenKarte(halle2NachNord());
    expect(k.ziehtMit).toEqual([
      'Ab 01.03.2027 gehört Halle 2 zu Werk Ahrenberg Nord (ST-3).',
      'Bis 28.02.2027 bleibt es bei Werk Ahrenberg (ST-1).',
      'Die Bereiche Halle 2 Montage, Halle 2 Spritzguss und Halle 2 Lager ziehen mit.',
      'Die Messstellen MS-10, MS-11, MS-12, MS-13 und MS-15 wechseln ab 01.03.2027 den Standort — sie bleiben an ihrem Ort.',
    ]);
    expect(k.bleibt).toEqual([
      { satz: 'Die Anlage „Werk Ahrenberg – Halle 2“ bleibt bei Werk Ahrenberg (ST-1).', weg: WEG_ANLAGE },
      { satz: 'Der Netzanschluss NA-2 bleibt, wo er ist.', weg: null },
      { satz: 'MS-14 Ladepunkt Parkplatz Halle 2 hängt direkt am Standort Werk Ahrenberg und bleibt dort.', weg: WEG_MESSSTELLE },
    ]);
    expect(WEG_ANLAGE).toContain('„Anlage zuordnen“ ist ein eigener Schritt');
    expect(k.auswertungen).toEqual(['Auswertungen bis 28.02.2027 zählen Halle 2 bei Werk Ahrenberg, ab 01.03.2027 bei Werk Ahrenberg Nord.']);
    // A13: „nichts ändert sich“ steht wörtlich in der Karte.
    expect(k.nichts).toBe(NICHTS_AENDERT_SICH);
    expect(k.nichts).toBe('Nichts ändert sich an Anlagen, Netzanschlüssen und VoltPilot-Boxen — verschoben wird nur der Ort.');
  });

  it('spricht nicht von Steuern (Captain 14.09.2026: wer nur misst, verschiebt nur einen Ort)', () => {
    for (const v of [halle2NachNord(), halle2Rueckwirkend(), lagerNachHalle1()]) {
      for (const satz of alleSaetze(folgenKarte(v))) {
        expect(satz).not.toMatch(/Steuer|Betriebsmodell|Freigabe|Regelkreis|Befehl|Topic/);
      }
    }
  });

  it('eine schon geplante Zuordnung danach: die neue endet am Vortag und sagt, was dann gilt', () => {
    const k = folgenKarte(halle2NachNord({ gueltigBis: '2027-05-31', danach: { id: 'x', art: 'standort', kurzzeichen: 'ST-2', name: 'Werk Lindach' } }));
    expect(k.ziehtMit[2]).toBe('Die neue Zuordnung endet am 31.05.2027: ab 01.06.2027 gilt die schon geplante zu Werk Lindach (ST-2).');
  });

  it('rückwirkend: die Karte nennt die Tage, die nachträglich anders zählen', () => {
    const k = folgenKarte(halle2Rueckwirkend());
    expect(k.auswertungen).toEqual([
      'Auswertungen bis 19.02.2027 zählen Halle 2 bei Werk Ahrenberg, ab 20.02.2027 bei Werk Ahrenberg Nord.',
      'Rückwirkend (18 Tage): Auswertungen vom 20.02.2027 bis 09.03.2027 zählen nachträglich anders.',
    ]);
  });

  it('Halle 2 Lager → Halle 1 innerhalb des Standorts: nichts zieht mit, nichts bleibt zurück', () => {
    const k = folgenKarte(lagerNachHalle1());
    expect(k.ziehtMit).toEqual([
      'Ab 01.03.2027 hängt Halle 2 Lager an Halle 1 (G-1).',
      'Bis 28.02.2027 bleibt es bei Halle 2 (G-2).',
      KEINE_MESSSTELLE,
    ]);
    expect(k.bleibt).toEqual([]);
    expect(k.auswertungen).toEqual(['Die Auswertungen der Standorte ändern sich nicht — Halle 2 Lager bleibt bei Werk Ahrenberg.']);
  });
});

describe('Zeitpunkt (V2)', () => {
  it('Zukunft geplant, heute, Vergangenheit rückwirkend gekennzeichnet — wie der Server den Tag einordnet', () => {
    expect(zeitpunktSatz(halle2NachNord())).toBe('Geplant: bis 28.02.2027 bleibt alles, wie es ist.');
    expect(zeitpunktSatz(halle2NachNord({ gueltigAb: '2027-02-20', rueckwirkung: { art: 'ab_heute', tage: 0, abzeichen: null } }))).toBe(
      'Gilt ab heute.',
    );
    expect(zeitpunktSatz(halle2Rueckwirkend())).toBe('Rückwirkend (18 Tage): wird im Änderungsprotokoll so gekennzeichnet.');
  });
});

describe('Ziel, Prüfung und Anfrage (V2)', () => {
  it('ein Gebäude wählt nur Standorte — der bisherige steht nicht zur Wahl', () => {
    const { options, groups } = zielOptionen('gebaeude', zieleGebaeude());
    expect(options.map((o) => o.label)).toEqual(['Werk Lindach (ST-2)', 'Werk Ahrenberg Nord (ST-3)']);
    expect(groups).toBeUndefined();
  });

  it('ein Bereich wählt ein Gebäude (mit Standort) oder einen Standort direkt — nie sein bisheriges Gebäude', () => {
    const { options, groups } = zielOptionen('bereich', zieleBereich(ORT_IDS.g2));
    expect(groups?.map((g) => g.label)).toEqual(['An einem Gebäude', 'Direkt an einem Standort']);
    expect(options.map((o) => o.label)).toContain('Halle 1 (G-1)');
    expect(options.map((o) => o.label)).toContain('Werk Ahrenberg (ST-1)');
    expect(options.map((o) => o.label)).not.toContain('Halle 2 (G-2)');
    expect(options.find((o) => o.label === 'Halle 1 (G-1)')?.sub).toBe('Werk Ahrenberg');
  });

  it('prüft vor dem Senden, schickt keine leere Begründung und legt den Satz des Servers an sein Feld', () => {
    expect(Object.keys(pruefeVerschieben({ zielId: null, gueltigAb: null, begruendung: '' }, 'gebaeude'))).toEqual(['zielId', 'gueltigAb']);
    expect(verschiebenAnfrage({ zielId: NORD_ID, gueltigAb: '2027-03-01', begruendung: '  ' }, 'gebaeude')).toEqual({
      zielId: NORD_ID,
      gueltigAb: '2027-03-01',
    });
    expect(verschiebenAnfrage({ zielId: null, gueltigAb: '2027-03-01', begruendung: '' }, 'bereich')).toBeNull();
    const satz = 'Halle 2 gibt es im Portal erst seit 01.10.2026. Wählen Sie ein Datum ab dem 01.10.2026.';
    expect(verschiebenFeldAusServer({ code: 'vor_dem_ersten_intervall', message: satz, feld: 'gueltigAb' } as never)).toBe('gueltigAb');
    expect(verschiebenFeldAusServer({ code: 'name_belegt', message: 'x' } as never)).toBeNull();
  });
});

describe('Ergebnis (V4)', () => {
  it('Kopf, Zeitstrahl und Protokolleintrag: Zeit · was · gilt ab · wer', () => {
    const v = halle2Verschoben();
    expect(ergebnisSatz(v)).toBe('Halle 2 gehört ab 01.03.2027 zu Werk Ahrenberg Nord (ST-3).');
    expect(ergebnisSatz(lagerNachHalle1())).toBe('Halle 2 Lager hängt ab 01.03.2027 an Halle 1 (G-1).');
    expect(zeitstrahl(v).map(({ titel, zeitraum, zustand }) => [titel, zeitraum, zustand])).toEqual([
      ['Werk Ahrenberg (ST-1)', '01.10.2026 – 28.02.2027', 'gilt'],
      ['Werk Ahrenberg Nord (ST-3)', 'ab 01.03.2027', 'geplant'],
    ]);
    expect(protokollZeile(v, v.protokoll[0])).toEqual({
      zeit: '20.02.2027, 10:04 Uhr',
      was: 'Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)',
      giltAb: 'gilt ab 01.03.2027',
      wer: 'Ines Kaltenbach',
    });
    const r = halle2Rueckwirkend();
    expect(protokollZeile(r, r.protokoll[0]).giltAb).toBe('gilt ab 20.02.2027 · rückwirkend (18 Tage)');
  });

  it('das Abzeichen im Baum: „ab 01.03.2027 → Werk Ahrenberg Nord“', () => {
    const g2 = ahrenbergV4().gebaeude.find((g) => g.kurzzeichen === 'G-2')!;
    expect(danachAbzeichen(g2.danach!)).toBe('ab 01.03.2027 → Werk Ahrenberg Nord');
  });
});

describe('Menü (V1)', () => {
  it('„Verschieben …“ steht vor „Archivieren“; Löschen mit Historie bleibt ein Hinweis mit Grund', () => {
    const g2 = ahrenbergV1().gebaeude.find((g) => g.kurzzeichen === 'G-2')!;
    expect(menueEintraege(g2.aktionen).map((e) => e.art)).toEqual(['verschieben', 'archivieren_gesperrt', 'loeschen_gesperrt']);
    const ohneZiel = { ...g2.aktionen!, verschieben: { erlaubt: false, text: 'Halle 2 kann nicht verschoben werden: es gibt keinen anderen Standort.', ziele: [] } };
    expect(menueEintraege(ohneZiel)[0]).toEqual({
      art: 'verschieben_gesperrt',
      knopf: false,
      text: 'Halle 2 kann nicht verschoben werden: es gibt keinen anderen Standort.',
    });
  });
});
