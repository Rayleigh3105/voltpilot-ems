import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { MessmittelBlatt, MessmittelDialog } from './components/MessmittelBlatt';
import { abdeckungSumme, einsatzZeilen, ortZeilen } from './uemsMessabdeckung';
import { blattZeilen, eintragAus, entwurfAus, herstellerZeilen, messmittelLesbar, messmittelSatz, pruefsummeKurz, pruefsummeLokal, toleranzWert } from './uemsMessmittel';
import { ahrenbergMessabdeckung, gr2Messmittel, gr5Messmittel, leerMessmittel, messmittelNachEintrag } from './test/messmittelFixtures';

/**
 * UEMS AP-16 IP-18: Messmittel-Blatt, Dialog, Toleranz und Abdeckung als reine Ableitungen — und der Beweis, dass die
 * Prüfsumme LOKAL entsteht: aus der gewählten Datei wird im Browser die SHA-256, und den Client verlässt nur sie (G2).
 */
afterEach(() => vi.restoreAllMocks());

describe('AP-16 IP-18 · Prüfsumme lokal (G2)', () => {
  it('bildet die SHA-256 der Datei mit Web Crypto — bekannte Vektoren', async () => {
    expect(await pruefsummeLokal(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await pruefsummeLokal(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(pruefsummeKurz('3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e')).toBe('3b1f…9a2e');
  });

  it('der Dialog sendet nur Bezeichnung, Ablage und Prüfsumme — kein Datei-Inhalt verlässt den Client', async () => {
    const inhalt = 'GEHEIMER-INHALT-DER-NETZRECHNUNG-4711';
    const netz = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('kein Netz im Test'));
    const put = vi.spyOn(api, 'geraetMessmittelEintragen').mockImplementation(async (_id, e) => messmittelNachEintrag(gr5Messmittel(), e));
    const gespeichert = vi.fn();
    render(createElement(MessmittelDialog, { angaben: gr5Messmittel(), onClose: () => undefined, onGespeichert: gespeichert }));
    fireEvent.change(screen.getByLabelText('Genauigkeitsklasse'), { target: { value: '1' } });
    const datei = new File([inhalt], 'pruefprotokoll.pdf', { type: 'application/pdf' });
    // Die Prüfsumme entsteht asynchron (Web Crypto) — der Zustandswechsel danach gehört in act().
    await act(async () => {
      fireEvent.change(screen.getByTestId('messmittel-datei'), { target: { files: [datei] } });
      await new Promise((r) => setTimeout(r, 50));
    });
    const erwartet = await pruefsummeLokal(new Blob([inhalt]));
    await waitFor(() => expect(screen.getByTestId('messmittel-pruefsumme')).toHaveTextContent(`Prüfsumme ${pruefsummeKurz(erwartet)} aus „pruefprotokoll.pdf“ — die Datei bleibt auf Ihrem Gerät.`));
    await act(async () => {
      fireEvent.click(screen.getByTestId('messmittel-speichern'));
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(gespeichert).toHaveBeenCalled());

    expect(put).toHaveBeenCalledTimes(1);
    const [, eintrag] = put.mock.calls[0];
    expect(eintrag.beleg).toEqual({ bezeichnung: 'pruefprotokoll.pdf', ablage: null, sha256: erwartet });
    const gesendet = JSON.stringify(eintrag);
    expect(gesendet).not.toContain(inhalt);
    expect(gesendet).not.toContain(btoa(inhalt));
    expect(Object.keys(eintrag.beleg!)).toEqual(['bezeichnung', 'ablage', 'sha256']);
    // Nichts anderes ging ins Netz — der PUT läuft über `api`, die Datei nirgends.
    expect(netz).not.toHaveBeenCalled();
  });
});

describe('AP-16 IP-18 · Messmittel-Blatt (G1, G3)', () => {
  it('GR-2: Eichung mit Beleg und Prüfsumme; abgelaufen steht mit „abgelaufen seit“', () => {
    const zeilen = blattZeilen(gr2Messmittel(), '2026-11-28');
    expect(zeilen.map((z) => [z.label, z.wert])).toEqual([
      ['Genauigkeitsklasse', 'B (MID, Wirkenergie)'],
      ['Prüfung', 'Eichung am 14.06.2023'],
      ['Gültig bis', '31.12.2031'],
      ['Beleg', 'Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental, Zählernr. 47110000001-Z1 · Ablage: beim Kunden (Netzrechnung)'],
    ]);
    expect(zeilen[3].hinweis).toBe('Prüfsumme 3b1f…9a2e · eingetragen von Ines Kaltenbach am 28.11.2026');
    expect(blattZeilen(gr2Messmittel(), '2032-01-05')[2].hinweis).toBe('abgelaufen seit 01.01.2032');
    expect(messmittelSatz('Netzzähler Halle 1', gr2Messmittel())).toBe(
      'Netzzähler Halle 1: Klasse B (MID, Wirkenergie) · Eichung am 14.06.2023, gültig bis 31.12.2031 · Beleg: Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental, Zählernr. 47110000001-Z1 (Prüfsumme 3b1f…9a2e).');
  });

  it('GR-5: alles „nicht erhoben“ — wörtlich, nie ein Wert; Wandler-Klasse je Fassung', () => {
    const zeilen = blattZeilen(gr5Messmittel(), '2026-11-28');
    expect(zeilen.map((z) => z.wert)).toEqual(['nicht erhoben', 'nicht erhoben', 'nicht erhoben', 'nicht erhoben']);
    expect(zeilen.every((z) => z.offen)).toBe(true);
    expect(messmittelSatz('Unterzähler Druckluft', gr5Messmittel())).toBe('Unterzähler Druckluft: Klasse und Prüfung nicht erhoben.');
    const w = blattZeilen(leerMessmittel('x', 'C-1', 'K-8.2', true), '2027-02-10').at(-1)!;
    expect([w.label, w.wert, w.hinweis]).toEqual(['Stromwandler 400/5 A', 'Klasse nicht erhoben', 'ab 01.02.2027']);
  });

  it('G4: „laut Hersteller“ steht getrennt, mit Fundstelle — nie in den Einbau-Zeilen, nie als Ersatz', () => {
    const k82 = leerMessmittel('x', 'C-1', 'K-8.2', true);
    expect(herstellerZeilen(k82).map((z) => [z.label, z.wert, z.hinweis])).toEqual([[
      'Energiekarte K-8.2 (WAGO 750-494)', 'Messfehler ± 0,5 % v. Messbereichsendwert der Wirkleistung',
      'Handbuch Version 1.5.0, Tabelle 16 „Messfehler“, Seite 37 · Quelle 7a31…ac7f',
    ]]);
    // Die Einbau-Zeilen bleiben „nicht erhoben“ — die Katalog-Zahl füllt sie nicht.
    expect(blattZeilen(k82, '2027-02-10')[0].wert).toBe('nicht erhoben');
    expect(JSON.stringify(blattZeilen(k82, '2027-02-10'))).not.toContain('0,5 %');
    const offen = { ...k82, laut_hersteller: [{ ...k82.laut_hersteller[0], zustand: 'nicht_belegt' as const, klasse: null, wert: null, bezug: null, fundstelle: null, source_url: null, source_sha256: null }] };
    expect(herstellerZeilen(offen).map((z) => [z.wert, z.hinweis])).toEqual([['laut Hersteller nicht belegt', undefined]]);
    expect(herstellerZeilen(gr5Messmittel())).toEqual([]);
  });

  it('Entwurf: ein Beleg braucht Bezeichnung UND Datei; leer bleibt nicht erhoben; Wandler nur geänderte Fassungen', () => {
    const leer = leerMessmittel('x', 'C-1', 'K-8.2', true);
    const e = entwurfAus(leer);
    expect(eintragAus({ ...e, belegBezeichnung: 'Protokoll' }, leer)).toEqual({ fehler: { feld: 'beleg_datei', satz: 'Bitte wählen Sie die Datei des Belegs — das Portal bildet daraus nur die Prüfsumme.' } });
    expect(eintragAus({ ...e, belegSha256: 'a'.repeat(64) }, leer)).toMatchObject({ fehler: { feld: 'beleg_bezeichnung' } });
    expect(eintragAus(e, leer)).toEqual({ eintrag: { genauigkeitsklasse: null, pruefungsart: 'nicht_erhoben', pruefung_am: null, pruefung_gueltig_bis: null, beleg: null } });
    const mitWandler = eintragAus({ ...e, wandler: { '9c000000-0000-4000-8000-000000000082': '0,5' } }, leer);
    expect(mitWandler).toMatchObject({ eintrag: { wandler: [{ fassung: '9c000000-0000-4000-8000-000000000082', klasse: '0,5' }] } });
  });

  it('Toleranz: deutsche Eingabe, über 0, höchstens 100, zwei Nachkommastellen', () => {
    expect(toleranzWert('2,5')).toBe('2.5');
    expect(toleranzWert('3 %')).toBe('3');
    expect(toleranzWert('0')).toBeNull();
    expect(toleranzWert('100,01')).toBeNull();
    expect(toleranzWert('1,234')).toBeNull();
    expect(toleranzWert('abc')).toBeNull();
  });
});

describe('AP-16 IP-18 · Messmittel-Blatt ohne lesbare Antwort', () => {
  it('eine Antwort ohne Wandler-Liste gilt wie keine Antwort — das Blatt steht nicht da und reißt die Seite nicht mit', async () => {
    expect(messmittelLesbar(gr5Messmittel())).toBe(true);
    for (const kaputt of [{}, null, 'x', { ...gr5Messmittel(), wandler: undefined }]) expect(messmittelLesbar(kaputt)).toBe(false);
    const abruf = vi.spyOn(api, 'geraetMessmittel').mockResolvedValue({} as never);
    // Wie auf der Geräteseite: ein Nachbar im selben Baum (dort der Knopf „Controller austauschen“).
    render(createElement('div', null, createElement('button', null, 'Nachbar'),
      createElement(MessmittelBlatt, { geraetId: 'g-z5a', heute: '2026-11-28' })));
    await waitFor(() => expect(abruf).toHaveBeenCalledWith('g-z5a'));
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Nachbar' })).toBeTruthy();
    expect(screen.queryByTestId('messmittel-blatt')).toBeNull();
  });

  it('mit lesbarer Antwort steht das Blatt wie bisher', async () => {
    vi.spyOn(api, 'geraetMessmittel').mockResolvedValue(gr5Messmittel());
    render(createElement(MessmittelBlatt, { geraetId: 'gr-5', heute: '2026-11-28' }));
    expect(await screen.findByTestId('messmittel-blatt')).toBeTruthy();
  });
});

describe('AP-16 IP-18 · Abdeckungs-Tabelle (§5.3, R5)', () => {
  it('vier Spalten je Einsatz, Rest-Zeilen je Anlage, Summe mit K8 — geplant nie als 0', () => {
    const m = ahrenbergMessabdeckung();
    const zeilen = einsatzZeilen(m);
    const ee1 = zeilen.find((z) => z.kennzeichen === 'EE-1')!;
    expect(ee1.zellen.gemessen).toEqual(['MS-06 (B-1 Halle 1 Nord): 55.100 kWh', 'MS-11 (B-4 Halle 2 Spritzguss): 22.400 kWh']);
    expect(ee1.menge).toBe('77.500 kWh');
    const ee8 = zeilen.find((z) => z.kennzeichen === 'EE-8')!;
    expect(ee8.zellen.geplant).toEqual(['MS-23 (G-1 Halle 1) — keine Datenquelle seit 27.11.2026 · für MB-1']);
    expect(ee8.menge).toBe('geplant — keine Werte');
    expect(JSON.stringify(ee8)).not.toMatch(/(^|[^0-9.])0 kWh/);
    expect(ee8.zellen.ungemessen).toEqual(['Rest Halle 1: 54.580 kWh (39,2 % der Anlage)']);
    expect(zeilen.filter((z) => z.art === 'rest').map((z) => z.titel)).toEqual(['Rest Halle 1', 'Rest Halle 2', 'Rest Werk Lindach']);
    const gas = ortZeilen(m).find((z) => z.titel === 'Verwaltung')!;
    expect(gas.unter).toBe('Gas — ohne Anteil');
    expect(gas.zellen.ungemessen).toEqual(['ohne Nenner je Träger']);
    const s = abdeckungSumme(m);
    expect(s.k8).toBe('K8 · Messabdeckung: unter Schwelle');
    expect(s.teile.map((t) => t.wert)).toEqual([
      '185.380 kWh aus 3 von 3 Anlagen', '125.740 kWh = 67,8 %', 'MS-23 — noch keine Werte',
      '0 kWh (in „gemessen“ enthalten)', '59.640 kWh = 32,2 %',
    ]);
  });
});
