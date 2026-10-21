import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  type Anlagensteuerung,
  type Device,
  type NetzVermarktung,
  type UemsDatenquelle,
  type UemsDatenquellePruefergebnis,
} from '../api';
import type { ErzeugerKopf } from '../anlagensteuerungAssistent';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import { anlagensteuerungApi } from '../anlagensteuerungApi';
import { ueberwachungApi } from '../ueberwachungApi';
import { AnlagensteuerungAssistent } from './AnlagensteuerungAssistent';

/**
 * UEMS EZ-15 „Anlege-Schritt Steuerung verbinden“: Kopfprüfung über die Probe `erzeuger_kopf` (zwei Lesungen),
 * Vorbelegung aus dem Bild (Büttner: zwei BHKW-Motoren, N-ERGIE, WVV), Anlegen über die EZ-6-Route und die Rechte
 * (Kundenadministrator legt auch Alarme an, ein Unterstützer mit „einrichten“ verbindet ohne Alarme, ein Leser nicht).
 */

const SITE = { id: 'anlage-buettner', name: 'Biogas Engelhard' };
const BOX = { id: 'box-1', kind: 'edge', siteId: SITE.id, name: 'VP-7Q4K · Maschinenraum', externalRef: 'VP-7Q4K' } as Device;
const ALT = { id: 'box-2', kind: 'edge', siteId: SITE.id, name: 'Alte Box', externalRef: 'VP-ALT' } as Device;

const BUETTNER: ErzeugerKopf = {
  signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 2, herzschlag: 500,
  programmstand: 2610, steuerung_id: 0xa1b2, anlagenart: 2, beschreibung_ab: 140,
  einheiten: [
    { einheit: 1, art: 2, nenn_kw: 66, typ_name: 'MAN E0836LE' },
    { einheit: 2, art: 2, nenn_kw: 33, typ_name: 'KW Energie Smartblock 33' },
  ],
  netzbetreiber_name: 'N-ERGIE Netz GmbH',
  direktvermarkter_name: 'WVV (Stadtwerke Würzburg)',
};

function pruefung(kopf: ErzeugerKopf | null, ergebnis = 'ok'): UemsDatenquellePruefergebnis {
  return {
    ergebnis, gewertet: ergebnis === 'ok', text: ergebnis, adresse: '192.168.4.165:502', zeitpunkt: '', dauer_ms: 40,
    antwort: kopf ? { requestId: 'r', results: [{ id: 'erreichbarkeit', ok: kopf.erkannt, erzeuger_kopf: kopf }] } : null,
  } as unknown as UemsDatenquellePruefergebnis;
}

const NV: NetzVermarktung = {
  site_id: SITE.id, netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: null, direktvermarkter_kanal: null,
  einspeisemanagement: null, einspeisemanagement_prozent: null,
  namen_aus_bild: { netzbetreiber: null, direktvermarkter: null, gelesen_am: null }, hinweise: [], revision: 0,
};

let pruefen: ReturnType<typeof vi.spyOn<typeof api, 'datenquellePruefen'>>;
let anlegen: ReturnType<typeof vi.spyOn<typeof anlagensteuerungApi, 'anlegen'>>;
let namen: ReturnType<typeof vi.spyOn<typeof anlagensteuerungApi, 'namen'>>;
let alarm: ReturnType<typeof vi.spyOn<typeof ueberwachungApi, 'anlegen'>>;
let quelleAnlegen: ReturnType<typeof vi.spyOn<typeof api, 'datenquelleAnlegen'>>;

beforeEach(() => {
  vi.spyOn(api, 'anlagensteuerungen').mockResolvedValue({
    einrichtung: { moeglich: true, grund: null, boxen: [{ device_id: BOX.id, faehig: true }, { device_id: ALT.id, faehig: false }] },
    steuerungen: [],
  });
  vi.spyOn(api, 'netzVermarktung').mockResolvedValue(NV);
  quelleAnlegen = vi.spyOn(api, 'datenquelleAnlegen').mockResolvedValue({ id: 'dq-1', kennzeichen: 'DQ-1' } as UemsDatenquelle);
  pruefen = vi.spyOn(api, 'datenquellePruefen')
    .mockResolvedValueOnce(pruefung(BUETTNER))
    .mockResolvedValueOnce(pruefung({ ...BUETTNER, herzschlag: 502 }));
  vi.spyOn(api, 'datenquelleZuweisen').mockResolvedValue({} as Awaited<ReturnType<typeof api.datenquelleZuweisen>>);
  anlegen = vi.spyOn(anlagensteuerungApi, 'anlegen').mockResolvedValue({
    geraet_id: 'g-1', kennzeichen: 'G-7', bezeichnung: 'Anlagensteuerung', entity_id: 'e-1',
    einheiten: [{ te_nr: 1, bezeichnung: 'Motor 1' }, { te_nr: 2, bezeichnung: 'Motor 2' }],
  } as unknown as Anlagensteuerung);
  namen = vi.spyOn(anlagensteuerungApi, 'namen').mockResolvedValue({ ...NV, hinweise: [] });
  alarm = vi.spyOn(ueberwachungApi, 'anlegen').mockResolvedValue({} as Awaited<ReturnType<typeof ueberwachungApi.anlegen>>);
});

function zeige(onFertig = vi.fn(), standort: string | null = null) {
  render(<RechteStandort.Provider value={standort}>
    <AnlagensteuerungAssistent site={SITE} boxen={[BOX, ALT]} onClose={() => {}} onFertig={onFertig} herzschlagAbstandMs={0} />
  </RechteStandort.Provider>);
  return onFertig;
}

async function waehle(feld: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: feld }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

const weiter = () => screen.getByRole('button', { name: 'Weiter' }) as HTMLButtonElement;

async function kopfErkannt() {
  fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.4.165' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
  return screen.findByText('✓ Bild erkannt');
}

describe('Anlagensteuerung verbinden - Kopfprüfung', () => {
  it('liest den Kopf zweimal über erzeuger_kopf und gibt „Weiter“ erst bei laufendem Herzschlag frei', async () => {
    zeige();
    expect(weiter().disabled).toBe(true);
    await kopfErkannt();
    expect(screen.getByText('VoltPilot-Registerbild Erzeuger 1.0 · Programm 2610 · Anlagenart BHKW')).toBeTruthy();
    expect(screen.getByText('2 Einheiten · Herzschlag läuft (2 Lesungen, +2) · Wortfolge stimmt')).toBeTruthy();
    expect(screen.getByText('Kennung der Steuerung 0000A1B2 (vom Programm gesetzt)')).toBeTruthy();
    expect(pruefen).toHaveBeenCalledTimes(2);
    expect(pruefen.mock.calls[0]).toEqual([SITE.id, 'dq-1', {
      device_id: BOX.id, op: 'erzeuger_kopf', unit_id: 1, register: 0, register_kind: 'input', word_order: 'big',
    }]);
    expect(quelleAnlegen.mock.calls[0][1]).toMatchObject({ protokoll: 'modbus_tcp', adresse: '192.168.4.165:502',
      geraete_ids: [1], kadenz_s: 5, device_id: BOX.id });
    expect(weiter().disabled).toBe(false);
  });

  it('nennt den Grund eines fremden Bilds und liest dann kein zweites Mal', async () => {
    pruefen.mockReset().mockResolvedValue(pruefung({ signatur_ok: false, erkannt: false, grund: 'signatur_fremd' }, 'invalid_response'));
    zeige();
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.4.165' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
    const kasten = await screen.findByTestId('anst-kopf');
    expect(within(kasten).getByText('Bild unbekannt: andere Signatur')).toBeTruthy();
    expect(within(kasten).getByText(/Energiekarten-Bild/)).toBeTruthy();
    expect(pruefen).toHaveBeenCalledTimes(1);
    expect(weiter().disabled).toBe(true);
  });

  it('meldet einen stehenden Herzschlag und lässt nicht weiter', async () => {
    pruefen.mockReset().mockResolvedValue(pruefung(BUETTNER));
    zeige();
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.4.165' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
    expect(await screen.findByText('Herzschlag steht')).toBeTruthy();
    expect(weiter().disabled).toBe(true);
  });

  it('sagt „Box-Update nötig“ für eine Box ohne Fähigkeitswort - ohne die Box zu fragen', async () => {
    zeige();
    await screen.findByRole('combobox', { name: 'Zuständige Box' });
    await waehle('Zuständige Box', /Alte Box · Update nötig/);
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: '192.168.4.165' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopf prüfen' }));
    expect(await screen.findByText('Box-Update nötig')).toBeTruthy();
    expect(pruefen).not.toHaveBeenCalled();
    expect(quelleAnlegen).not.toHaveBeenCalled();
  });
});

describe('Anlagensteuerung verbinden - Vorbelegung und Anlegen', () => {
  it('belegt Einheiten und Netz aus dem Bild vor und legt Steuerung, Namen und Alarme an', async () => {
    const onFertig = zeige();
    await kopfErkannt();
    fireEvent.click(weiter());

    await screen.findByRole('heading', { name: 'Einheiten aus dem Bild' });
    expect(screen.getByText('Anlagenart BHKW (aus dem Bild)')).toBeTruthy();
    expect(screen.getAllByLabelText('Name').map((f) => (f as HTMLInputElement).value)).toEqual(['Motor 1', 'Motor 2']);
    expect(screen.getAllByLabelText('Typ (aus dem Bild)').map((f) => (f as HTMLInputElement).value))
      .toEqual(['MAN E0836LE', 'KW Energie Smartblock 33']);
    expect(screen.getAllByLabelText('Nennleistung in kW (aus dem Bild)').map((f) => (f as HTMLInputElement).value))
      .toEqual(['66', '33']);
    fireEvent.click(weiter());

    await screen.findByRole('heading', { name: 'Netzbetreiber' });
    expect(screen.getAllByText('N-ERGIE Netz GmbH')).toHaveLength(2);
    expect((screen.getByLabelText('Direktvermarkter (aus dem Bild)') as HTMLInputElement).value).toBe('WVV (Stadtwerke Würzburg)');
    await waehle('Einspeisemanagement', /^Stufen \(Rundsteuerempfänger\)/);
    expect((screen.getByLabelText('Stufe 2 in %') as HTMLInputElement).value).toBe('60');
    await waehle('Weg der Vorgaben', /^Relais und 4–20 mA/);
    fireEvent.change(screen.getByLabelText('Motor 1 · SEE-Nummer'), { target: { value: 'SEE912345678901' } });
    fireEvent.click(weiter());

    await screen.findByRole('heading', { name: 'Alarme vorschlagen' });
    expect(screen.getByText('Gemeldet an: Kundenadministrator.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await screen.findByText('Anlagensteuerung angelegt');

    expect(anlegen).toHaveBeenCalledTimes(1);
    const [site, body] = anlegen.mock.calls[0];
    expect(site).toBe(SITE.id);
    expect(body).toMatchObject({
      data_source_id: 'dq-1', unit_id: 1, anlagenart: 'bhkw', funktionscode: 4, basisadresse: 0, steuerung_kennung: 0xa1b2,
      rse_stufen: [{ stufe: 1, prozent: 100 }, { stufe: 2, prozent: 60 }, { stufe: 3, prozent: 30 }, { stufe: 4, prozent: 0 }],
      netz_vermarktung: { direktvermarkter: 'WVV (Stadtwerke Würzburg)', direktvermarkter_kanal: 'relais_ma',
        einspeisemanagement: 'stufen', einspeisemanagement_prozent: null },
    });
    expect(body.einheiten[0]).toEqual({ te_nr: 1, einheit_art: 'bhkw_motor', bezeichnung: 'Motor 1', typ: 'MAN E0836LE',
      typ_bild: 'MAN E0836LE', nennleistung_kw: 66, registry_unit_id: 'SEE912345678901' });
    expect(namen).toHaveBeenCalledWith('g-1', { netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: 'WVV (Stadtwerke Würzburg)',
      einheiten: [{ te_nr: 1, typ: 'MAN E0836LE' }, { te_nr: 2, typ: 'KW Energie Smartblock 33' }] });
    // Mit Direktvermarkter-Weg, ohne Fernwirktechnik: alle Vorlagen außer „Fernwirk-Verbindung weg“.
    expect(alarm.mock.calls.map(([a]) => a.wertart)).toEqual(['erzeuger.fernsteuerung_nicht_bereit',
      'erzeuger.daten_veraltet', 'erzeuger.anlage_folgt_nicht', 'erzeuger.netzbetreiber_abgeschaltet',
      'erzeuger.programmstand_veraltet']);
    expect(alarm.mock.calls[0][0].empfaenger).toEqual([{ rolle: 'kundenadministrator' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Zur Geräteseite' }));
    expect(onFertig).toHaveBeenCalledWith({ entityId: 'e-1', titel: 'Anlagensteuerung',
      ziel: `#/anlage/${SITE.id}/geraet/VP-7Q4K/as-e-1` });
  });

  it('belegt neu vor, wenn nach „Zurück“ eine andere Steuerung gelesen wird', async () => {
    const pv: ErzeugerKopf = { ...BUETTNER, te_anzahl: 2, anlagenart: 1, steuerung_id: 0x1c4, direktvermarkter_name: '',
      einheiten: [1, 2].map((n) => ({ einheit: n, art: 1 as const, nenn_kw: 125, typ_name: 'Growatt MAX 125KTL3-X' })) };
    pruefen.mockResolvedValueOnce(pruefung(pv)).mockResolvedValueOnce(pruefung({ ...pv, herzschlag: 503 }));
    zeige();
    await kopfErkannt();
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Einheiten aus dem Bild' });
    fireEvent.change(screen.getAllByLabelText('Name')[0], { target: { value: 'Motor links' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Kopf erneut prüfen' }));
    await screen.findByText('2 Einheiten · Herzschlag läuft (2 Lesungen, +3) · Wortfolge stimmt');
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Einheiten aus dem Bild' });
    expect(screen.getAllByLabelText('Name').map((f) => (f as HTMLInputElement).value)).toEqual(['Wechselrichter 1', 'Wechselrichter 2']);
    expect(screen.getByText('Anlagenart PV (aus dem Bild)')).toBeTruthy();
  });

  it('zeigt einen gescheiterten Alarm mit Grund - die Steuerung bleibt angelegt', async () => {
    alarm.mockRejectedValue(new Error('Diese Wertart kennt die Überwachung nicht.'));
    zeige();
    await kopfErkannt();
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Einheiten aus dem Bild' });
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Netzbetreiber' });
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Alarme vorschlagen' });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await screen.findByText('Anlagensteuerung angelegt');
    expect(screen.getByText('Daten veraltet: Diese Wertart kennt die Überwachung nicht.')).toBeTruthy();
  });
});

describe('Anlagensteuerung verbinden - Rechte (EW-14 A)', () => {
  it('verbindet als Unterstützer mit „einrichten“ - Alarme nur als Vorschlag, nie angelegt', async () => {
    setSelbstauskunft(rechteSeed('TB').me);
    zeige(vi.fn(), STANDORT_IDS['ST-1']);
    await kopfErkannt();
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Einheiten aus dem Bild' });
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Netzbetreiber' });
    fireEvent.click(weiter());
    await screen.findByRole('heading', { name: 'Alarme vorschlagen' });
    expect(screen.getByText(/Alarme legt an, wer Überwachungen verwalten darf/)).toBeTruthy();
    expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).disabled)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await screen.findByText('Anlagensteuerung angelegt');
    expect(anlegen).toHaveBeenCalledTimes(1);
    expect(alarm).not.toHaveBeenCalled();
  });

  it('lässt einen Leser nicht verbinden und fragt die Box nicht', async () => {
    setSelbstauskunft(rechteSeed('CB').me);
    zeige(vi.fn(), STANDORT_IDS['ST-1']);
    expect(screen.getByText('Keine Berechtigung')).toBeTruthy();
    expect(screen.queryByLabelText('Adresse')).toBeNull();
    await waitFor(() => expect(pruefen).not.toHaveBeenCalled());
  });
});
