import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { keycloak } from '../auth';
import { UEMS_NORMGRENZE } from '../glossar';
import { setSelbstauskunft } from '../rollen';
import { routenHeute, vergissAbruf } from '../routenUhr';
import { SEITE_IDS, seitenBuehne, type SeitenLage } from '../test/kennzahlSeiteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { KennzahlenPage } from './KennzahlenPage';

/**
 * Die Seite einer Kennzahl ohne Reiter und die Bezugsbasis eine Ebene tiefer (Konzept Auswerten a1 §6.5, §6.6; PR2) in
 * der Welt des Konzepts (`test/kennzahlSeiteFixtures.ts`): Antwort zuerst, Verlässlichkeit, Kacheln, Grafik mit
 * Infozeile, Monatsliste, Auffälligkeit, Rechenweg, Bezugsbasis in Klartext. Am Rechner (jsdom kennt keine Breite).
 */
const t = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ');
const original = { ...api };

function welt(lage: SeitenLage = 'ueber', person = 'IK') {
  const me = rechteSeed(person).me;
  setSelbstauskunft(me);
  keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
  Object.assign(api, seitenBuehne(lage));
}

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  Object.assign(api, original);
  vi.restoreAllMocks();
});

describe('die Seite einer Kennzahl (§6.5)', () => {
  it('Antwort zuerst: Satz mit Bedingung, Verlässlichkeit, Kachel mit Stern, Ziel, Fazit, Rechenweg, Bezugsbasis', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const antwort = await screen.findByTestId('kennzahl-antwort');
    expect(t(antwort.textContent)).toContain(
      'Im März 2029 brauchte der Prozess Spritzguss 2,2 % mehr Energie, als die Bezugsbasis bei 306.000 kg Produktionsmenge erwarten ließ.',
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(t(screen.getByTestId('kennzahl-vertrauen').textContent)).toBe(
      'Vorsicht beim Lesen: Die Bezugsbasis stammt aus einem einzigen Monat (Oktober 2026) und ist vorläufig. Bezugsbasis ansehen',
    );
    const kachel = screen.getByTestId('kennzahl-kacheln');
    await waitFor(() => expect(within(kachel).getByLabelText('Leitkennzahl - sie steht auf der Übersicht')).toBeTruthy());
    expect(t(kachel.textContent)).toContain('0,29kWh je kg');
    expect(t(kachel.textContent)).toContain('über der Bezugsbasis▼ 2 % ggü. Vormonat');
    expect(t(kachel.textContent)).toContain('erwartet 0,28 kWh je kg bei 306.000 kg · gemessen 88.740 kWh, erwartet 86.812 kWh');
    expect(t((await screen.findByTestId('kennzahl-energieziel')).textContent)).toContain('Stand nach 1 von 10 Monaten: 2,2 % mehr · verantwortlich Ines Kaltenbach');
    expect(t((await screen.findByTestId('kennzahl-fazit')).textContent)).toBe(
      'April 2028 bis März 2029: 3,0 % mehr als erwartet; 10 von 12 Monaten über der Bezugsbasis, 2 im Rahmen.',
    );
    // Am Rechner: die Monate als Tabelle mit sechs Spalten, „Zusammengezählt“ neben der Grafik.
    expect(within(screen.getByTestId('kennzahl-werte')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Monat', 'Gemessen', 'Bedingung', 'Erwartet', 'Abweichung', 'Urteil',
    ]);
    expect(screen.getByTestId('kennzahl-zusammen')).toBeTruthy();
    expect(t((await screen.findByTestId('kennzahl-erwartet')).textContent)).toBe(
      'Erwartet: 0,2837 kWh je kg aus der Bezugsbasis mal 306.000 kg = 86.812 kWh.',
    );
    expect(t(screen.getByTestId('kennzahl-bezugsbasis').textContent)).toContain('nächste Überprüfung bis 30.04.2030');
    expect(t(screen.getByTestId('kennzahl-stammdaten').textContent)).toContain('Gilt für den Prozess Spritzguss');
  });

  it('die Grafik ist ein Schieber: Pfeiltasten wechseln den Monat der Infozeile und des Rechenwegs', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const schieber = await screen.findByRole('slider');
    const info = () => t(screen.getByTestId('grafik-infozeile').textContent);
    expect(info()).toBe('März 202988.740 kWhstatt 86.812 erwartet2,2 % mehr · über der Bezugsbasis');
    expect(schieber.getAttribute('aria-valuenow')).toBe('12');
    fireEvent.keyDown(schieber, { key: 'ArrowLeft' });
    expect(info()).toContain('Februar 2029');
    expect(schieber.getAttribute('aria-valuetext')).toContain('Februar 2029');
    fireEvent.keyDown(schieber, { key: 'Home' });
    expect(info()).toContain('April 2028');
    await waitFor(() => expect(t(screen.getByTestId('kennzahl-herkunft').textContent)).toContain('April 2028: 88.200 kWh (Spritzguss)'));
  });

  it('die Monate der Tabelle sind Knöpfe: per Tastatur gewählt wechseln Infozeile und Rechenweg (Review r3)', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const tabelle = within(await screen.findByTestId('kennzahl-werte'));
    const februar = tabelle.getByRole('button', { name: 'Februar 2029' });
    expect(februar.getAttribute('aria-pressed')).toBe('false');
    februar.focus();
    fireEvent.click(februar);
    expect(februar.getAttribute('aria-pressed')).toBe('true');
    expect(t(screen.getByTestId('grafik-infozeile').textContent)).toContain('Februar 2029');
  });

  it('die offene Auffälligkeit: „Beantworten“ öffnet die beiden Antworten (Abweichung eröffnen, zur Kenntnis nehmen)', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const karte = await screen.findByTestId('kennzahl-auffaelligkeit');
    expect(t(karte.textContent)).toContain('Auffälligkeit zu März 2029 · offen. VoltPilot hat den Monat vermerkt');
    fireEvent.click(within(karte).getByTestId('auffaelligkeit-beantworten'));
    expect(within(karte).getByTestId('vermerk-eroeffnen')).toBeTruthy();
  });

  it('„Bezugsbasis ansehen“ und „Alle Fassungen“ führen eine Ebene tiefer', async () => {
    welt();
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={onOeffnen} onListe={vi.fn()} />);
    fireEvent.click(await within(await screen.findByTestId('kennzahl-vertrauen')).findByRole('button', { name: 'Bezugsbasis ansehen' }));
    fireEvent.click(await screen.findByTestId('alle-fassungen'));
    expect(onOeffnen.mock.calls).toEqual([[SEITE_IDS.kz4, 'bezugsbasis'], [SEITE_IDS.kz4, 'bezugsbasis']]);
  });

  it('noch kein Vergleich: keine zwölf leeren Säulen - die Werte mit Vorjahr, „Vergleich ab Juni 2029“', async () => {
    welt('noch_kein_vergleich');
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const grafik = await screen.findByTestId('kennzahl-grafik');
    expect(within(grafik).getByRole('heading').textContent).toBe('Je Monat');
    expect(t(screen.getByTestId('kennzahl-kacheln').textContent)).toContain('Vergleich ab Juni 2029');
    expect(screen.queryByTestId('kennzahl-fazit')).toBeNull();
    expect(screen.queryByTestId('kennzahl-zusammen')).toBeNull();
  });

  it('ohne Bezugsbasis: das Vorjahr als Satz und Marke, der Hinweis mit „Bezugsbasis festlegen“, keine Kachel', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz24} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const antwort = await screen.findByTestId('kennzahl-antwort');
    expect(t(antwort.textContent)).toBe(
      'Im März 2029 lag das Gebäude Halle 1 bei 20,64 kWh je m² - genauso viel wie im März 2028.kWh je m² · Gebäude Halle 1 · ohne Bezugsbasisunverändert ggü. Vorjahr',
    );
    expect(t(screen.getByTestId('kennzahl-vertrauen').textContent)).toContain('Bezugsbasis festlegen');
    expect(screen.queryByTestId('kennzahl-kacheln')).toBeNull();
    expect(within(screen.getByTestId('kennzahl-werte')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Monat', 'Wert', 'Vorjahr', 'Veränderung']);
  });

  it('ohne Bezugsbasis trägt jeder Monat sein Vorjahr aus der Auswertung - auch solange die Monatswerte noch laden', async () => {
    welt();
    // Die Monatswerte (Rechenweg) antworten nicht: Infozeile und Tabelle behaupten trotzdem nie „ohne Vorjahreswert“.
    api.kennzahlWerte = () => new Promise(() => {});
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz24} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const info = await screen.findByTestId('grafik-infozeile');
    expect(t(info.textContent)).toContain('Vorjahr 20,64');
    expect(t(info.textContent)).not.toContain('ohne Vorjahreswert');
    const zeilen = within(screen.getByTestId('kennzahl-werte')).getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(12);
    // Jede Zeile: Monat, Wert, Vorjahr und die rohe Veränderung - kein Monat mit leerer Spalte.
    expect(zeilen.map((z) => within(z).getAllByRole('cell').map((c) => t(c.textContent)))).toContainEqual(['17,81 kWh je m²', '17,81', '0,0 %']);
    for (const z of zeilen) expect(within(z).getAllByRole('cell').map((c) => c.textContent)).not.toContain('—');
  });

  it('den Stern trägt nur, wen der Server als Leitkennzahl nennt - ein offenes Ziel allein reicht nicht (§10.8, Review r3)', async () => {
    welt();
    const vorher = api.kennzahl;
    api.kennzahl = async (id, mit) => ({ ...(await vorher(id, mit)), leitkennzahl: false });
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const kachel = await screen.findByTestId('kennzahl-kacheln');
    expect(await screen.findByTestId('kennzahl-energieziel')).toBeTruthy();
    expect(within(kachel).queryByLabelText('Leitkennzahl - sie steht auf der Übersicht')).toBeNull();
  });

  it('scheitert die Auswertung (500), steht die Seite ohne sie da - mit Stammdaten und Menü statt Ladefehler (Review r3)', async () => {
    welt();
    const vorher = api.kennzahl;
    const aufrufe: (string | undefined)[] = [];
    api.kennzahl = async (id, mit) => {
      aufrufe.push(mit);
      if (mit) throw new ApiError(500, 'Serverfehler');
      return vorher(id);
    };
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    expect(await screen.findByTestId('kennzahl-stammdaten')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Stromeinsatz Spritzguss je kg');
    expect(screen.getByRole('button', { name: 'Weitere Aktionen' })).toBeTruthy();
    expect(screen.queryByText('Die Kennzahl ließ sich gerade nicht laden. Ihre Daten sind nicht betroffen.')).toBeNull();
    expect(aufrufe).toEqual(['auswertung', undefined]);
  });

  it('das Menü ⋯ verlangt das Recht der Geltung: die Werkzeuge stehen für Ines, nicht für eine reine Leserin (Review r3)', async () => {
    const werkzeuge = ['Kopieren', 'Berechnung ändern ab …', 'Stammdaten ändern', 'Archivieren'];
    const eintraege = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Weitere Aktionen' }));
      return screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
    };
    welt('ueber', 'IK');
    const { unmount } = render(
      <KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />,
    );
    await screen.findByTestId('kennzahl-antwort');
    expect(await eintraege()).toEqual(expect.arrayContaining(werkzeuge));
    unmount();

    welt('ueber', 'CB');
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('kennzahl-antwort');
    const knopf = screen.queryByRole('button', { name: 'Weitere Aktionen' });
    if (knopf) {
      fireEvent.click(knopf);
      const sichtbar = screen.queryAllByRole('menuitem').map((m) => m.textContent ?? '');
      for (const w of werkzeuge) expect(sichtbar).not.toContain(w);
    }
  });

  it('404 bleibt „gibt es nicht (mehr)“ - kein zweiter Versuch ohne Auswertung', async () => {
    welt();
    const aufrufe: (string | undefined)[] = [];
    api.kennzahl = async (_id, mit) => {
      aufrufe.push(mit);
      throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    };
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    expect(await screen.findByText('Diese Kennzahl gibt es nicht (mehr).')).toBeTruthy();
    expect(aufrufe).toEqual(['auswertung']);
  });

  it('eine alte Adresse der Wiedervorlage (`…?entscheid=bezugsbasis_ueberpruefung`) springt auf die Ebene der Bezugsbasis', async () => {
    welt();
    window.location.hash = `#/portfolio/kennzahlen/${SEITE_IDS.kz4}?entscheid=bezugsbasis_ueberpruefung&kennzeichen=BB-0001`;
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/portfolio/kennzahlen/${SEITE_IDS.kz4}/bezugsbasis?entscheid=bezugsbasis_ueberpruefung&kennzeichen=BB-0001`),
    );
  });
});

describe('„Energieziel setzen“ an der Kennzahl - eine Uhr (Konzept Verbessern v1, Befund 2; Review r1 M-0.1)', () => {
  // Der Browser steht im Oktober 2026, die Route im April 2029 (Bühnen-Uhr der Demo).
  beforeEach(() => {
    vergissAbruf();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vergissAbruf();
  });

  /** Die Welt ohne laufendes Energieziel an KZ-0004 - erst dann bietet das Menü „Energieziel setzen“ an. */
  function ohneZiel(person = 'IK') {
    welt('ueber', person);
    const kennzahl = api.kennzahl;
    Object.assign(api, {
      kennzahl: async (id: string, mit?: 'auswertung') => {
        const k = await kennzahl(id, mit);
        return k.auswertung ? { ...k, auswertung: { ...k.auswertung, energieziel: null } } : k;
      },
      energieziele: async () => ({ energieziele: [] }),
    });
  }
  const zielperiode = (dialog: HTMLElement) =>
    ['Erster Monat', 'Letzter Monat'].map((l) => within(dialog).getByLabelText(l).textContent?.trim());
  async function zielDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Weitere Aktionen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Energieziel setzen/ }));
    return screen.findByTestId('energieziel-setzen');
  }

  it('die Seite merkt sich den Tag der Route aus den Auffälligkeiten; die Vorgabe ist das Jahr nach ihm (2030, nicht 2027)', async () => {
    ohneZiel();
    const uebersicht = vi.spyOn(api, 'verbesserungUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('kennzahl-auffaelligkeit');
    expect(routenHeute()).toBe('2029-04-30');
    const dialog = await zielDialog();
    expect(zielperiode(dialog)).toEqual(['Januar 2030', 'Dezember 2030']);
    expect(within(dialog).getByTestId('energieziel-basis-zeile').textContent).toContain('Bezugsbasis BB-0001');
    // Konzept Verbessern v1, PR 4: der Grenz-Satz steht einmal am Fuß der Seite, nicht im Dialog.
    expect(within(dialog).queryByText(UEMS_NORMGRENZE)).toBeNull();
    expect(uebersicht).not.toHaveBeenCalled();
    // Ohne Wortlaut und Begründung geht nichts an die Route.
    const senden = vi.spyOn(api, 'energiezielAnlegen');
    await act(async () => fireEvent.click(screen.getByTestId('energieziel-setzen-senden')));
    expect(senden).not.toHaveBeenCalled();
  });

  it('ohne Antwort der Auffälligkeiten-Route holt der Dialog den Tag einmal über die Übersicht', async () => {
    ohneZiel();
    Object.assign(api, { auffaelligkeiten: async () => Promise.reject(new ApiError(503, 'nicht erreichbar')) });
    const uebersicht = vi
      .spyOn(api, 'verbesserungUebersicht')
      .mockResolvedValue({ abruf: '2029-04-30' } as Awaited<ReturnType<typeof api.verbesserungUebersicht>>);
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('kennzahl-antwort');
    const dialog = await zielDialog();
    expect(zielperiode(dialog)).toEqual(['Januar 2030', 'Dezember 2030']);
    expect(uebersicht).toHaveBeenCalledTimes(1);
  });

  it('ohne `verbesserung.verwalten` steht „Energieziel setzen“ nicht im Menü', async () => {
    ohneZiel('CB');
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('kennzahl-antwort');
    const knopf = screen.queryByRole('button', { name: 'Weitere Aktionen' });
    if (knopf) {
      fireEvent.click(knopf);
      expect(screen.queryByRole('menuitem', { name: /Energieziel setzen/ })).toBeNull();
    }
  });
});

describe('die Bezugsbasis eine Ebene tiefer (§6.6)', () => {
  it('Kopf, Status, Antwort, „vorläufig“, Fassungen als Datumsblöcke und die Überprüfung mit dem Entscheid der Wiedervorlage', async () => {
    welt();
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} ebene="bezugsbasis" onOeffnen={onOeffnen} onListe={vi.fn()} />);
    expect(t((await screen.findByTestId('bezugsbasis-status')).textContent)).toBe('Gilt seit 01.11.2027nächste Überprüfung bis 30.04.2030');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bezugsbasis BB-0001');
    expect(t(screen.getByTestId('bezugsbasis-antwort').textContent)).toBe(
      'VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.Fassung 2 · Verhältnis · Vergleichszeitraum Oktober 2026',
    );
    expect(t(screen.getByTestId('bezugsbasis-vorlaeufig-hinweis').textContent)).toContain('Belastbar wird sie mit zwölf Monaten');
    const f2 = await screen.findByTestId('bezugsbasis-fassung-2');
    expect(t(f2.textContent)).toContain('seit01.11.2027Fassung 2 · gilt');
    const pruefung = screen.getByTestId('bezugsbasis-ueberpruefung');
    expect(t(pruefung.textContent)).toContain('Zuletzt bestätigt am 30.04.2029. Ist sie noch die richtige Messlatte?');
    expect(within(pruefung).getByTestId('bezugsbasis-antworten').getAttribute('data-entscheid')).toBe('bezugsbasis_ueberpruefung');
    fireEvent.click(screen.getByRole('button', { name: 'Stromeinsatz Spritzguss je kg' }));
    expect(onOeffnen).toHaveBeenCalledWith(SEITE_IDS.kz4);
  });

  it('scheitert die Auswertung (500), zeigt die Ebene die Bezugsbasis trotzdem (Review r3)', async () => {
    welt();
    const vorher = api.kennzahl;
    api.kennzahl = async (id, mit) => {
      if (mit) throw new ApiError(503, 'nicht erreichbar');
      return vorher(id);
    };
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} ebene="bezugsbasis" onOeffnen={vi.fn()} onListe={vi.fn()} />);
    expect(await screen.findByTestId('bezugsbasis-status')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bezugsbasis BB-0001');
  });
});
