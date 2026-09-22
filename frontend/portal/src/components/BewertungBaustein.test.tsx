import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Bericht, type BerichtUeberpruefung, type Selbstauskunft } from '../api';
import { bewertungFristBaustein } from '../bewertungFrist';
import { UEMS_NORMGRENZE } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { UebersichtBausteine, useUebersichtBausteine } from './UebersichtBausteine';

/** AP-16 R10: Stand Nr. 2 vom 17.11.2026, abgerufen am 18.11.2027 — so liefert es die Bericht-Route (IP-24). */
const r10 = (u: Partial<BerichtUeberpruefung> = {}): BerichtUeberpruefung => ({
  stand_nr: 2,
  stand_vom: '2026-11-17',
  wiedervorlage_monate: 12,
  faellig_am: '2027-11-17',
  ueberpruefung_faellig: true,
  faellig_seit_tagen: 1,
  abgeloest_durch: null,
  wesentliche_einsaetze: 6,
  offene_bedarfe: 1,
  verantwortliche: [
    { name: 'Martin Dörr', einsaetze: ['EE-1'] },
    { name: 'Peter Hahn', einsaetze: ['EE-2', 'EE-5'] },
    { name: 'Ines Kaltenbach', einsaetze: ['EE-3'] },
    { name: 'Jonas Wendt', einsaetze: ['EE-6', 'EE-7'] },
  ],
  ohne_verantwortliche: [],
  ...u,
});

const bericht = (kennung: string, vorlage: string, ueberpruefung: BerichtUeberpruefung | null): Bericht => ({
  kennung,
  vorlage,
  vorlage_fassung: 1,
  geltung_art: 'unternehmen',
  geltung_id: 'u-1',
  geltung_name: 'Kunststoffwerk Ahrenberg',
  zeitraum_art: 'monat',
  zeitraum: '2026-10',
  zeitraum_text: 'Oktober 2026',
  zeitzone: 'Europe/Berlin',
  angelegt_von: { name: 'Ines Kaltenbach', rolle: null },
  angelegt_am: '2026-11-09T09:00:00Z',
  archiviert_am: null,
  stand_zeichen: 'berichtsstand',
  stand_text: 'Berichtsstand Nr. 2',
  neueste_nr: ueberpruefung ? ueberpruefung.stand_nr : null,
  entwurf_datenstand: null,
  wiedervorlage_monate: vorlage === 'energetische_bewertung' ? 12 : null,
  ueberpruefung,
});

describe('bewertungFristBaustein (rein, §5.5 Schritt 4, R10)', () => {
  it('am 18.11.2027: der Satz aus §5.7, die Zahlen und die Verantwortlichen der wesentlichen Einsätze', () => {
    const bild = bewertungFristBaustein([bericht('BR-2026-0003', 'energetische_bewertung', r10())]);
    expect(bild?.satz).toBe('Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.');
    expect(bild?.faellig).toBe(true);
    expect(bild?.zahlen).toBe('6 wesentliche Energieeinsätze · 1 offener Messbedarf');
    expect(bild?.hinweis).toBe(
      'Verantwortlich für die wesentlichen Energieeinsätze: Martin Dörr (EE-1) · Peter Hahn (EE-2, EE-5) · Ines Kaltenbach (EE-3) · Jonas Wendt (EE-6, EE-7).',
    );
    expect(bild?.ohneVerantwortliche).toBeNull();
  });

  it('vor und am Frist-Tag dieselbe Kopfzeile; der Hinweis erst, wenn fällig', () => {
    const vorher = bewertungFristBaustein([
      bericht('BR-2026-0003', 'energetische_bewertung', r10({ ueberpruefung_faellig: false, faellig_seit_tagen: null })),
    ]);
    expect(vorher?.satz).toBe('Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig am 17.11.2027.');
    expect(vorher?.hinweis).toBeNull();
    const amTag = bewertungFristBaustein([bericht('BR-2026-0003', 'energetische_bewertung', r10({ faellig_seit_tagen: 0 }))]);
    expect(amTag?.satz).toBe('Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung heute fällig.');
    const lange = bewertungFristBaustein([bericht('BR-2026-0003', 'energetische_bewertung', r10({ faellig_seit_tagen: 12 }))]);
    expect(lange?.satz).toContain('fällig seit 12 Tagen.');
  });

  it('wesentlicher Einsatz ohne Person wird genannt; Einzahl in den Zahlen', () => {
    const bild = bewertungFristBaustein([
      bericht('BR-2026-0003', 'energetische_bewertung', r10({ wesentliche_einsaetze: 1, offene_bedarfe: 0, verantwortliche: [], ohne_verantwortliche: ['EE-8'] })),
    ]);
    expect(bild?.zahlen).toBe('1 wesentlicher Energieeinsatz · 0 offene Messbedarfe');
    expect(bild?.hinweis).toBeNull();
    expect(bild?.ohneVerantwortliche).toBe('Ohne verantwortliche Person: EE-8.');
  });

  it('die abgelöste Bewertung zählt nicht; ohne Stand, ohne Bewertung oder ohne Liste kein Baustein (R11)', () => {
    const alt = bericht('BR-2026-0003', 'energetische_bewertung', r10({ abgeloest_durch: 'BR-2027-0001', faellig_am: null }));
    const neu = bericht('BR-2027-0001', 'energetische_bewertung', r10({ stand_nr: 1, stand_vom: '2027-11-24', faellig_am: '2028-11-24', ueberpruefung_faellig: false, faellig_seit_tagen: null }));
    expect(bewertungFristBaustein([alt, neu])?.kennung).toBe('BR-2027-0001');
    expect(bewertungFristBaustein([alt, neu])?.satz).toBe('Energetische Bewertung: Stand Nr. 1 vom 24.11.2027 · Überprüfung fällig am 24.11.2028.');
    expect(bewertungFristBaustein([bericht('BR-2026-0003', 'energetische_bewertung', null)])).toBeNull();
    expect(bewertungFristBaustein([bericht('BR-2026-0001', 'monatsbericht_unternehmen', null)])).toBeNull();
    expect(bewertungFristBaustein(null)).toBeNull();
  });
});

const st = werkAhrenberg();
const anlagen = st.anlagen.map((a) => ({ id: a.id, name: a.name }));
function Uebersicht({ art }: { art: 'unternehmen' | 'standort' }) {
  const daten = useUebersichtBausteine(
    art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
    anlagen,
    ahrenbergFunktionen(),
  );
  return daten && <UebersichtBausteine daten={daten} zeigen={['bewertung']} onNavigate={() => {}} />;
}

const ohneEnergieeinsatz = (me: Selbstauskunft): Selbstauskunft => ({
  ...me,
  unternehmen_rechte: me.unternehmen_rechte.filter((r) => r !== 'energieeinsatz.ansehen'),
  standorte: me.standorte.map((s) => ({ ...s, rechte: s.rechte.filter((r) => r !== 'energieeinsatz.ansehen') })),
});

describe('Übersichts-Baustein „Energetische Bewertung“ am Unternehmen', () => {
  beforeEach(() => {
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
    vi.spyOn(api, 'anlageBilanz').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'standortOrte').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
    vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [bericht('BR-2026-0003', 'energetische_bewertung', r10())] });
  });
  afterEach(() => {
    setSelbstauskunft(null);
    vi.restoreAllMocks();
  });

  it('mit energieeinsatz.ansehen: Frist-Satz, Zahlen, Verantwortliche und der Grenz-Satz', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(screen.getByTestId('bewertung-frist').textContent).toBe(
      'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.',
    );
    expect(screen.getByTestId('bewertung-zahlen').textContent).toBe('6 wesentliche Energieeinsätze · 1 offener Messbedarf');
    expect(screen.getByTestId('bewertung-verantwortliche').textContent).toContain('Peter Hahn (EE-2, EE-5)');
    expect(screen.getByTestId('baustein-bewertung').textContent).toContain(UEMS_NORMGRENZE);
    const text = screen.getByTestId('baustein-bewertung').textContent ?? '';
    for (const wort of ['SEU', 'ISO-wesentlich', 'automatisch eingestuft']) expect(text).not.toContain(wort);
  });

  it('ohne energieeinsatz.ansehen: kein Baustein und keine Abfrage', async () => {
    setSelbstauskunft(ohneEnergieeinsatz(rechteSeed('IK').me));
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(api.berichte).not.toHaveBeenCalled();
  });

  it('am Standort nie — der Baustein gehört dem Unternehmen', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const { container } = render(<Uebersicht art="standort" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(api.berichte).not.toHaveBeenCalled();
  });

  it('eine abgelehnte Liste (kein Berichte-Recht) zeigt nichts', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.mocked(api.berichte).mockRejectedValue(new Error('403'));
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});
