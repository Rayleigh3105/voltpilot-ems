import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile, MessstelleVerteilungAnteil } from './api';
import { abgeleiteteGroesse, alsAnfrage, entwurfFehler, faktorHinweis, leererFormelEntwurf,
  messstellenImKontext, messstellenTerm, schritt1Fertig, vorschau } from './formelAssistent';
import { termAus } from './gesamtwert';
import referenz from '../../../docs/contracts/v2/uems-referenzunternehmen.json';

function quelle(kz: string): MessstelleRegisterZeile {
  const m = referenz.messstellen.find(m => m.kennzeichen === kz)!;
  const q = m.fuehrende_quelle[0];
  return { id: kz, kennzeichen: kz, name: m.name, art: 'gemessen', hauptgroesse: m.hauptgroesse,
    archiviert_am: null, elektrische_stellung: m.elektrische_stellung[0],
    quelle: { fuehrend: { komponente: q.komponente, geraet: { bezeichnung: q.geraet } } },
  } as MessstelleRegisterZeile;
}

describe('AP-10 · Erweiterung des Summenwert-Assistenten', () => {
  it('F9: Hauptgröße ist saldiert; zwei Richtungen, feste Vorzeichen und Tagesbeginn im Auftrag', () => {
    const terme = [messstellenTerm(quelle('MS-01')), messstellenTerm(quelle('MS-02'))];
    const e = { ...leererFormelEntwurf(), name: 'Netz-Saldo Halle 1', typ: 'saldo' as const, gueltigAb: '2026-10-01', terme };
    expect(schritt1Fertig(terme, 'saldo')).toBe(true);
    expect(entwurfFehler(e)).toBeNull();
    expect(abgeleiteteGroesse(terme, 'saldo')).toEqual({ groesse: 'Wirkenergie', richtung: 'saldiert', einheit: 'kWh', wertart: 'Intervallmenge' });
    expect(alsAnfrage(e)).toEqual({ name: e.name, formel_typ: 'saldo', gueltig_ab: '2026-10-01', terme: [
      { eingang_art: 'messstelle', quell_messstelle_id: 'MS-01', vorzeichen: '+', faktor: 1 },
      { eingang_art: 'messstelle', quell_messstelle_id: 'MS-02', vorzeichen: '-', faktor: 1 },
    ] });
    expect(entwurfFehler({ ...e, terme: [terme[0]] })).toMatch(/beiden Hauptzähler/);
    expect(entwurfFehler({ ...e, terme: [terme[0], { ...terme[1], faktor: .7 }] })).toMatch(/Faktor 1/);
    expect(vorschau(terme, 'saldo').wert).toBeNull();
  });

  it('F11: Verteilungsidentität statt kopiertem Faktor; keine Teilsumme aus einem übrigen Snapshot', () => {
    const m = quelle('MS-07');
    const anteil = { kostenstelle: { id: 'kostenstelle-4100', kennzeichen: '4100' }, anteil_prozent: '70' } as MessstelleVerteilungAnteil;
    const t = messstellenTerm(m, anteil);
    const anderer = termAus({ ...t.quelle, channel: 'raw', wert: 100 });
    const e = { ...leererFormelEntwurf(), name: 'Prozess Spritzguss gesamt', terme: [anderer, t] };
    expect(alsAnfrage(e).terme[1]).toEqual({ eingang_art: 'verteilung', quell_messstelle_id: 'MS-07', verteilung_ziel: 'kostenstelle-4100', anteil: 'gesamt', vorzeichen: '+', faktor: 1 });
    expect(vorschau(e.terme)).toMatchObject({ wert: null, unvollstaendig: true, fehlende: [t.quelle.name] });
    expect(entwurfFehler({ ...e, terme: [{ ...t, faktor: .7 }] })).toMatch(/immer Faktor 1/);
    expect(faktorHinweis([{ ...anderer, faktor: .7 }])).toMatch(/Kostenstellen-Anteil/);
  });

  it('Gerätegrenze folgt der Komponente; die Anlage darf mehrere Geräte anbieten', () => {
    const zeilen = [quelle('MS-01'), quelle('MS-02'), quelle('MS-07')];
    expect(messstellenImKontext(zeilen, ['K-3'], 'gewichtete_summe').map(m => m.id)).toEqual(['MS-01', 'MS-02']);
    expect(messstellenImKontext(zeilen, ['K-3', 'K-6'], 'gewichtete_summe')).toHaveLength(3);
    expect(messstellenImKontext(zeilen, ['K-3', 'K-6'], 'saldo').map(m => m.id)).toEqual(['MS-01', 'MS-02']);
    expect(messstellenImKontext(zeilen, [], 'saldo')).toEqual([]);
  });
});
