import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Kennzahl, type KennzahlAuswertung } from '../api';
import { LEER_SATZ, OHNE_BASISWERT } from '../bezugsbasisAnlegen';
import { OHNE_GRUNDLAGE } from '../bezugsbasisModell';
import { FEHLER_IM_BEREICH } from './Fehlergrenze';
import { UEMS_NORMGRENZE } from '../glossar';
import { KennzahlenPage } from '../pages/KennzahlenPage';
import { setSelbstauskunft } from '../rollen';
import { bb1, bb1Fassung, BB_IDS, faktorenVorschlag, kz4, variablenVorschlag } from '../test/bezugsbasisFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { BezugsbasisReiter, type BezugsbasisLage } from './BezugsbasisReiter';

/**
 * UEMS AP-17 IP-9 — der Reiter „Bezugsbasis“ an der Kennzahl, sein Assistent, die Basis-Zeile und das Register-
 * Kennzeichen, gegen die Antworten von R1 (Ines Kaltenbach, KZ-0004, BB-0001 Oktober 2026 vorläufig). Die Routen von
 * IP-7 (Anlegen, Entwurf) und IP-8 (Liste der Basen, beantragen · freigeben · ablehnen, Register-Feld) sind
 * gemockt.
 */
const ZONE = 'Europe/Berlin';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T09:00:00+01:00'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSelbstauskunft(null);
});

const reiter = (lage: BezugsbasisLage, k: Kennzahl = kz4()) => {
  const onNeu = vi.fn();
  render(<BezugsbasisReiter kennzahl={k} lage={lage} zone={ZONE} onNeu={onNeu} />);
  return { onNeu };
};

describe('leerer Zustand und Rechte-Sicht (§5.8 „Leer“, R10)', () => {
  it('Ines Kaltenbach (Energiemanager) liest den Satz und den Knopf „Bezugsbasis anlegen“ — und den Grenz-Satz', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'keine' });
    expect(screen.getByText(LEER_SATZ)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bezugsbasis anlegen' })).toBeTruthy();
    expect(screen.getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });
  it('Claudia Berger (Leserin) liest nur den Satz, keinen Knopf', () => {
    setSelbstauskunft(rechteSeed('CB').me);
    reiter({ art: 'keine' });
    expect(screen.getByText(LEER_SATZ)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bezugsbasis anlegen' })).toBeNull();
  });
  it('eine archivierte Kennzahl bekommt keine neue Bezugsbasis', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'keine' }, kz4({ archiviert_am: '2026-11-01T00:00:00+01:00' }));
    expect(screen.queryByRole('button', { name: 'Bezugsbasis anlegen' })).toBeNull();
  });
});

describe('der Assistent in fünf Schritten (R1: Oktober 2026, Verhältnis, vorläufig)', () => {
  it('bildet den Entwurf, zeigt die Monate, graut die Modelle aus, schlägt Einflussgrößen und Faktoren vor und gibt mit Begründung frei', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const anlegen = vi.spyOn(api, 'bezugsbasisAnlegen').mockResolvedValue(bb1(null));
    const entwurf = vi.spyOn(api, 'bezugsbasisEntwurf').mockImplementation(async (_k, _b, body) =>
      bb1Fassung('entwurf', { referenzperiode: body.referenzperiode }),
    );
    const variablen = vi.spyOn(api, 'kennzahlVariablenVorschlag').mockResolvedValue(variablenVorschlag());
    const faktoren = vi.spyOn(api, 'kennzahlFaktorenVorschlag').mockResolvedValue(faktorenVorschlag());
    const freigabe = vi.spyOn(api, 'bezugsbasisFreigabe').mockResolvedValue(bb1Fassung('freigegeben'));
    reiter({ art: 'keine' });
    fireEvent.click(screen.getByRole('button', { name: 'Bezugsbasis anlegen' }));
    const dialog = await screen.findByTestId('bezugsbasis-assistent');
    const weiter = () => screen.getByTestId('bezugsbasis-weiter');

    // (1) Referenzperiode: Vorschlag die letzten zwölf vollen Monate; erst „Monate prüfen“ öffnet den Weg.
    expect(within(dialog).getByText('November 2025')).toBeTruthy();
    expect(within(dialog).getByText('Oktober 2026')).toBeTruthy();
    expect((weiter() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    expect(anlegen).toHaveBeenCalledWith(BB_IDS.kz4);
    expect(entwurf).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, { referenzperiode: '2025-11/2026-10', methode: 'verhaeltnis' });
    const monate = screen.getByTestId('bezugsbasis-monate');
    expect(within(monate).getByText('vorhanden')).toBeTruthy();
    expect(screen.getByTestId('bezugsbasis-vorlaeufig').textContent).toBe('vorläufig (1 von 12 Monaten)');

    // (2) Methode: bei einem Monat trägt nur das Verhältnis — die Modelle mit dem §5.8-Satz „Modell nicht möglich …“ (G1).
    fireEvent.click(weiter());
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked, r.disabled])).toEqual([
      ['verhaeltnis', true, false],
      ['regression_eine_variable', false, true],
      ['regression_zwei_variablen', false, true],
      ['gradtage', false, true],
    ]);
    expect(within(dialog).getAllByText('Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.')).toHaveLength(3);
    expect(within(dialog).queryByText('kommt')).toBeNull();

    // (3) Einflussgrößen: Variable 1 = Bezugsgröße der Kennzahl; BZ-3 hängt an BZ-1, die Leckagerate hat keine Zahl.
    fireEvent.click(weiter());
    await screen.findByText(/Produktionsmenge \(BZ-1, kg\) — die Bezugsgröße der Kennzahl/);
    expect(variablen).toHaveBeenCalledWith(BB_IDS.kz4, '2025-11/2026-10');
    const kandidaten = screen.getByTestId('bezugsbasis-kandidaten');
    expect(within(kandidaten).getByText(/hängt an Produktionsmenge \(r = 0,997\)/)).toBeTruthy();
    expect(within(kandidaten).getByText('ohne Zahl — erst als Bezugsgröße erfassen')).toBeTruthy();
    expect((within(kandidaten).getAllByRole('checkbox') as HTMLInputElement[]).every((c) => c.disabled)).toBe(true);

    // (4) Statische Faktoren: Vorschlag der Struktur am gilt_ab, ankreuzbar, dazu ein Wortlaut.
    fireEvent.click(weiter());
    await screen.findByText(/Fläche Halle 1 \(G-1\): 4 200 m²/);
    expect(faktoren).toHaveBeenCalledWith(BB_IDS.kz4, '2026-11-01');
    fireEvent.click(within(screen.getByTestId('bezugsbasis-faktoren')).getAllByRole('checkbox')[0]);

    // (5) Vorschau → „Als Entwurf speichern“ → ohne Vier-Augen (Ahrenberg) „Freigeben“ mit Begründung 10–500.
    fireEvent.click(weiter());
    expect(screen.getByTestId('bezugsbasis-basiswert').textContent).toBe('0,2837 kWh je kg');
    expect(screen.getByTestId('bezugsbasis-faktoren-zahl').textContent).toBe('1 gewählt');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-entwurf-knopf')));
    expect(entwurf).toHaveBeenLastCalledWith(BB_IDS.kz4, BB_IDS.bb1, {
      referenzperiode: '2025-11/2026-10', methode: 'verhaeltnis', variablen: [BB_IDS.bz1], toleranz_prozent: '2', wiedervorlage_monate: 12,
      faktoren: [{ art: 'flaeche', objekt_id: 'g1000000-0000-4000-8000-000000000001' }],
    });
    const text = screen.getByLabelText('Begründung');
    fireEvent.change(text, { target: { value: 'zu kurz' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-freigeben-knopf')));
    expect(freigabe).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Bitte begründen Sie mit mindestens 10 Zeichen.');
    fireEvent.change(text, { target: { value: 'Oktober 2026 ist der erste volle Monat mit Produktionsmenge.' } });
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-freigeben-knopf')));
    expect(freigabe).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, 1, 'freigeben', 'Oktober 2026 ist der erste volle Monat mit Produktionsmenge.');
    expect(screen.getByTestId('bezugsbasis-nach-antrag').textContent).toBe('Fassung 1 ist freigegeben und gilt ab 01.11.2026.');
    expect(within(dialog).getByText(UEMS_NORMGRENZE)).toBeTruthy();
  });

  it('eine Ablehnung der Route steht als ihr Satz; `methode_noch_nicht_gebaut` graut die Methode weiter aus', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'bezugsbasisAnlegen').mockRejectedValue(
      new ApiError(409, 'Diese Kennzahl hat schon eine laufende Bezugsbasis; bilden Sie dort eine neue Fassung.', {
        code: 'bezugsbasis_laeuft', bezugsbasis_id: BB_IDS.bb1, bezugsbasis: 'BB-0001',
      }),
    );
    const entwurf = vi.spyOn(api, 'bezugsbasisEntwurf').mockRejectedValue(
      new ApiError(422, 'In der Referenzperiode hat die Kennzahl keinen gespeicherten Monatswert.', { code: 'keine_werte' }),
    );
    reiter({ art: 'keine' });
    fireEvent.click(screen.getByRole('button', { name: 'Bezugsbasis anlegen' }));
    await screen.findByTestId('bezugsbasis-assistent');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    // B1 als Wettlauf: der Entwurf geht an die laufende Basis, die die Route nennt.
    expect(entwurf).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, expect.anything());
    expect(screen.getByTestId('bezugsbasis-fehler').textContent).toBe('In der Referenzperiode hat die Kennzahl keinen gespeicherten Monatswert.');
    expect((screen.getByTestId('bezugsbasis-weiter') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Freigabe einer beantragten Fassung (F1/F2, Vier-Augen)', () => {
  it('wer `bezugsbasis.freigeben` hat, sieht „Freigeben“ und „Ablehnen“ mit Vier-Augen-Hinweis; eine Leserin nicht', async () => {
    const lage: BezugsbasisLage = { art: 'da', basis: bb1('beantragt'), fassung: bb1Fassung('beantragt') };
    setSelbstauskunft(rechteSeed('JW').me);
    const freigabe = vi.spyOn(api, 'bezugsbasisFreigabe').mockResolvedValue(bb1Fassung('freigegeben'));
    const { onNeu } = reiter(lage);
    const eintrag = screen.getByTestId('bezugsbasis-fassung-1');
    expect(within(eintrag).getByText('zur Freigabe beantragt')).toBeTruthy();
    expect(within(eintrag).getByText(/Vier-Augen-Prinzip/)).toBeTruthy();
    fireEvent.change(within(eintrag).getByLabelText('Begründung'), { target: { value: 'Geprüft: Grundlage und Basiswert stimmen.' } });
    await act(async () => fireEvent.click(within(eintrag).getByRole('button', { name: 'Ablehnen' })));
    expect(freigabe).toHaveBeenCalledWith(BB_IDS.kz4, BB_IDS.bb1, 1, 'ablehnen', 'Geprüft: Grundlage und Basiswert stimmen.');
    expect(onNeu).toHaveBeenCalled();
  });
  it('die Leserin sieht die Fassung, aber keinen Hebel', () => {
    setSelbstauskunft(rechteSeed('CB').me);
    reiter({ art: 'da', basis: bb1('beantragt'), fassung: bb1Fassung('beantragt') });
    expect(screen.getByTestId('bezugsbasis-fassung-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(screen.queryByLabelText('Begründung')).toBeNull();
  });
  it('ein Entwurf wird bearbeitet und ohne Vier-Augen freigegeben, mit Vier-Augen beantragt', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    reiter({ art: 'da', basis: bb1('entwurf'), fassung: bb1Fassung('entwurf') });
    expect(screen.getByRole('button', { name: 'Entwurf bearbeiten' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Freigeben' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Zur Freigabe beantragen' })).toBeNull();
  });
  it('kennt die Fläche die Einstellung nicht, folgt sie der Route: 409 `vieraugen_beantragen` → beantragen', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const freigabe = vi
      .spyOn(api, 'bezugsbasisFreigabe')
      .mockRejectedValueOnce(new ApiError(409, 'Mit Vier-Augen wird die Fassung beantragt.', { code: 'vieraugen_beantragen' }))
      .mockResolvedValueOnce(bb1Fassung('beantragt', { vieraugen: true }));
    const { onNeu } = reiter({ art: 'da', basis: bb1('entwurf'), fassung: null });
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Oktober 2026 als erste Bezugsbasis.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Freigeben' })));
    expect(freigabe.mock.calls.map((c) => c[3])).toEqual(['freigeben', 'beantragen']);
    expect(onNeu).toHaveBeenCalled();
  });
});

describe('an der Kennzahl-Seite: keine Reiter, die Bezugsbasis eine Ebene tiefer (Konzept Auswerten a1 §6.6)', () => {
  const seite = (k: Kennzahl, basen: ReturnType<typeof bb1>[], ebene: 'bezugsbasis' | null = null) => {
    vi.spyOn(api, 'kennzahl').mockResolvedValue(k);
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [k] });
    vi.spyOn(api, 'kennzahlFassungen').mockResolvedValue({ kennzahl_id: k.id, kennzeichen: k.kennzeichen, fassungen: [] });
    vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new ApiError(500, 'x'));
    const liste = vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: basen });
    vi.spyOn(api, 'bezugsbasisFassung').mockResolvedValue(bb1Fassung('freigegeben'));
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={k.id} ebene={ebene} zone={ZONE} onOeffnen={onOeffnen} onListe={() => undefined} />);
    return { liste, onOeffnen };
  };
  it('KZ-0004 mit BB-0001: die Seite hat keine Reiter; Fassungen und Freigabe stehen auf der Ebene der Bezugsbasis', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    seite(kz4(), [bb1('freigegeben')]);
    await screen.findByTestId('kennzahl-stammdaten');
    expect(screen.queryByRole('tablist', { name: 'Reiter der Kennzahl KZ-0004' })).toBeNull();
    expect(screen.queryByTestId('bezugsbasis-reiter')).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    seite(kz4(), [bb1('freigegeben')], 'bezugsbasis');
    expect(await screen.findByTestId('bezugsbasis-reiter')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bezugsbasis BB-0001');
    expect((await screen.findByTestId('bezugsbasis-antwort')).textContent).toBe(
      'VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.Fassung 1 · Verhältnis · Vergleichszeitraum Oktober 2026',
    );
  });
  it('ein Anteil fragt keine Bezugsbasis ab (B2) - auch nicht auf der Ebene darunter', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    const { liste } = seite(kz4({ rechenform: 'anteil' }), []);
    await screen.findByTestId('kennzahl-stammdaten');
    cleanup();
    seite(kz4({ rechenform: 'anteil' }), [], 'bezugsbasis');
    expect(await screen.findByText('Ein Anteil hat keine Bezugsbasis - VoltPilot vergleicht ihn nur mit dem Vorjahr.')).toBeTruthy();
    expect(liste).not.toHaveBeenCalled();
  });
});

/**
 * Konzept Auswerten a1 §6.4 (PR1): das Register ordnet in zwei Gruppen statt mit Kennzeichen und Filter - „Mit
 * Bezugsbasis“ trägt, wer eine freigegebene Fassung hat (der Server legt dann `auswertung.vergleich` an), alles andere
 * steht „Zum Beobachten“. Eine Bezugsbasis im Entwurf macht keine Energieleistungskennzahl (B3).
 */
describe('Register: zwei Gruppen statt Kennzeichen und Filter (B3, Konzept Auswerten a1 §6.4)', () => {
  const auswertung = (mitVergleich: boolean): KennzahlAuswertung => ({
    monat: '2026-10',
    wert: { periode: '2026-10', wert: '0.2837', einheit: 'kWh/kg', zustand: 'vollständig', richtung: null },
    vorjahr: null,
    monate: Array.from({ length: 12 }, (_, i) => ({ periode: `2026-${String(i + 1).padStart(2, '0')}`, wert: null, delta_prozent: null, urteil: null, grund: null })),
    vergleich: mitVergleich
      ? { bezugsbasis: 'BB-0001', urteil: 'im_rahmen', delta_prozent: '0.4', band_prozent: '2.0', richtung: 'mehr', grund: null, satz: null, erster_monat: null }
      : null,
    energieziel: null,
  });
  const register = (kennzahlen: Kennzahl[]) => {
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen });
    vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new ApiError(500, 'x'));
    render(<KennzahlenPage onOeffnen={() => undefined} onListe={() => undefined} zone={ZONE} />);
  };
  it('ohne freigegebene Basis steht alles „Zum Beobachten“ - keine Gruppe „Mit Bezugsbasis“', async () => {
    register([
      kz4({ auswertung: auswertung(false) }),
      kz4({ id: 'x2', kennzeichen: 'KZ-0005', bezugsbasis: { kennzeichen: 'BB-0002', fassung: 1, freigabe_status: 'entwurf', vorlaeufig: true }, auswertung: auswertung(false) }),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('kennzahl-reihe')).toHaveLength(2));
    expect(screen.queryByTestId('kennzahlen-mit')).toBeNull();
    // Die Basis im Entwurf ist genannt, nicht als Urteil.
    expect(screen.getAllByTestId('kennzahl-reihe')[1].textContent).toContain('BB-0002 im Entwurf');
  });
  it('mit freigegebener Basis steht die Kennzahl „Mit Bezugsbasis“, mit Urteil und „Bezugsbasis vorläufig“', async () => {
    register([
      kz4({ bezugsbasis: { kennzeichen: 'BB-0001', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: true }, auswertung: auswertung(true) }),
      kz4({ id: 'x3', kennzeichen: 'KZ-0003', name: 'Unternehmen je Stück', auswertung: auswertung(false) }),
    ]);
    const mit = await screen.findByTestId('kennzahlen-mit');
    expect(within(mit).getAllByTestId('kennzahl-karte')).toHaveLength(1);
    expect(within(mit).getByText('im Rahmen der Bezugsbasis')).toBeTruthy();
    expect(mit.textContent).toContain('Bezugsbasis vorläufig');
    expect(within(screen.getByTestId('kennzahlen-ohne')).getAllByTestId('kennzahl-reihe')).toHaveLength(1);
  });
});

/**
 * Demo 27.09.2026 (Welt 1.10): alle acht Fassungen tragen `grundlage` NULL, die Route reicht `null` durch — der Reiter
 * brachte das GANZE Portal auf die Boot-Karte (`null.variablen` in `spannweiten`). Die Antworten hier sind die der Route
 * für so eine Fassung: `monate` 0 (unbekannt), keine Gründe, keine Prüfsumme.
 */
describe('eine Fassung ohne Grundlage (Welt 1.10, Referenzdatei BB-0003 Fassung 2)', () => {
  const ohneGrundlage = { grundlage: null, pruefsumme: null, monate: 0, datenlage_gruende: [], vorbehalte: [] };
  const seite = (fassung: ReturnType<typeof bb1Fassung>) => {
    const k = kz4();
    vi.spyOn(api, 'kennzahl').mockResolvedValue(k);
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [k] });
    vi.spyOn(api, 'kennzahlFassungen').mockResolvedValue({ kennzahl_id: k.id, kennzeichen: k.kennzeichen, fassungen: [] });
    vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new ApiError(500, 'x'));
    vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: [bb1('freigegeben')] });
    vi.spyOn(api, 'bezugsbasisFassung').mockResolvedValue(fassung);
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={k.id} ebene="bezugsbasis" zone={ZONE} onOeffnen={onOeffnen} onListe={() => undefined} />);
    return { onOeffnen };
  };
  const zurEbene = () => screen.findByTestId('bezugsbasis-reiter');

  it('die Ebene zeichnet: Basiswert und Datenlage der Fassung, dazu der Satz — keine Monate, keine erfundene 0', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    seite(bb1Fassung('freigegeben', ohneGrundlage));
    const r = await zurEbene();
    expect((await within(r).findByTestId('bezugsbasis-ohne-grundlage')).textContent).toBe(OHNE_GRUNDLAGE);
    expect(within(r).getByTestId('bezugsbasis-modell-basiswert').textContent).toBe('Verhältnis 0,2837 kWh je kg.');
    expect(within(r).getByTestId('bezugsbasis-modell-datenlage').textContent).toBe('vorläufig');
    expect(within(r).queryByTestId('bezugsbasis-modell-monate')).toBeNull();
    expect(r.textContent).not.toMatch(/\b0 (von 12 )?Monat/);
    // Ohne Grundlage (`monate` 0 heißt „unbekannt“) sagt der Hinweis nie „aus 0 Monaten“.
    expect(screen.getByTestId('bezugsbasis-vorlaeufig-hinweis').textContent).toContain('gebildet aus weniger Monaten als vorgesehen');
    expect(screen.queryByTestId('fehlergrenze')).toBeNull();
  });

  it('ohne Basiswert (Referenzdatei: „leer, nie 0“) steht das Wort statt einer Zahl', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    seite(bb1Fassung('freigegeben', { ...ohneGrundlage, basiswert: null }));
    const r = await zurEbene();
    expect((await within(r).findByTestId('bezugsbasis-modell-basiswert')).textContent).toBe(`Verhältnis ${OHNE_BASISWERT}.`);
    expect(screen.getByTestId('bezugsbasis-antwort').textContent).toContain('Diese Fassung hat keinen Basiswert');
  });

  it('scheitert die Ebene trotzdem, bleibt der Fehler in ihr: Kopf und Rückweg zur Kennzahl bleiben erreichbar', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Eine kaputte Antwort (keine Variablen-Liste) — steht für jeden künftigen Fehler dieser Art.
    const { onOeffnen } = seite(bb1Fassung('freigegeben', { variablen: null as never }));
    expect((await screen.findByTestId('fehlergrenze')).textContent).toBe(FEHLER_IM_BEREICH);
    fireEvent.click(screen.getByRole('button', { name: kz4().name }));
    expect(onOeffnen).toHaveBeenCalledWith(kz4().id);
  });
});
