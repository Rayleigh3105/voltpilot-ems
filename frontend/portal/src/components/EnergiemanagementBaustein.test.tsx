import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { energiemanagementRoute } from '../nav';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { werkAhrenberg } from '../test/standorteFixtures';
import { wvDemo, wvLeer, wvNormal, wvR12 } from '../test/wiedervorlageFixtures';
import { bausteineMitInhalt } from '../uebersichtBausteine';
import { wasStehtAn, WOHER_SATZ } from '../wiedervorlage';
import { EnergiemanagementBaustein } from './EnergiemanagementBaustein';
import { GrenzSatzBereich } from './GrenzSatz';
import { UebersichtBausteine, useUebersichtBausteine, type UebersichtDaten } from './UebersichtBausteine';

describe('„Was steht an“: ruhig im Normalfall, deutlich bei Überfälligem (Konzept Wiedervorlage w1)', () => {
  it('R12: ein Satz sagt, was das ist; Marken zählen Einträge; vier Zeilen gebündelt nach Aufgabe', () => {
    render(<EnergiemanagementBaustein bild={wasStehtAn(wvR12())!} onOeffnen={() => {}} />);
    const block = screen.getByTestId('baustein-energiemanagement');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Was steht an');
    expect(block.textContent).toContain('Fristen aus Ihrem Energiemanagement');
    expect([...screen.getByTestId('energiemanagement-marken').children].map((m) => m.textContent)).toEqual(['8 überfällig', '1 in den nächsten 30 Tagen']);
    const zeilen = within(screen.getByTestId('was-steht-an')).getAllByRole('listitem');
    expect(zeilen.map((z) => z.querySelector('.vp-fz-titel')!.textContent)).toEqual([
      '4 Bezugsbasen überprüfen',
      'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben',
      'Energetische Bewertung überprüfen',
      'Energiepolitik und Anwendungsbereich überprüfen',
    ]);
    expect(within(zeilen[0]).getByRole('img', { name: 'fällig seit 13.11.2027' })).toBeTruthy();
    // Kein Tageszähler, keine Null-Aussage, kein Kalender auf der Übersicht.
    expect(block.textContent).not.toMatch(/seit \d+ Tagen|0 in den nächsten|Kalender/);
  });

  it('ein Bündel öffnet die Wiedervorlage mit genau diesem Filter, ein einzelner Eintrag sein Objekt mit Entscheid', () => {
    const springe = vi.fn();
    render(<EnergiemanagementBaustein bild={wasStehtAn(wvR12())!} onOeffnen={() => {}} springe={springe} />);
    const [buendel, bericht] = within(screen.getByTestId('was-steht-an')).getAllByRole('link');
    expect(buendel.getAttribute('href')).toBe('#/portfolio/energiemanagement/wiedervorlage?art=bezugsbasis_ueberpruefung');
    expect(bericht.getAttribute('href')).toBe('#/portfolio/berichte/BR-2028-0001?entscheid=bericht_anstoss');
    expect(bericht.textContent).toContain('Entwurf vergleichen');
    fireEvent.click(bericht);
    expect(springe).toHaveBeenCalledWith(expect.objectContaining({ hash: '#/portfolio/berichte/BR-2028-0001?entscheid=bericht_anstoss' }));
  });

  it('Normalfall: „Keine Frist überfällig“ und das Fenster statt einer Null', () => {
    render(<EnergiemanagementBaustein bild={wasStehtAn(wvNormal())!} onOeffnen={() => {}} />);
    expect(screen.getByTestId('energiemanagement-marken').textContent).toBe('Keine Frist überfällig');
    expect(screen.getByTestId('was-steht-an-ruhe').textContent).toBe('Bis 30.05.2029 ist nichts fällig. Danach stehen 11 weitere Fristen an.');
  });

  it('nur Fristen in den nächsten Tagen: „Nächste Fristen“ mit Datum, ohne Warnton', () => {
    render(<EnergiemanagementBaustein bild={wasStehtAn({ ...wvR12(), faellig: [] })!} onOeffnen={() => {}} />);
    expect(screen.getByText('Nächste Fristen')).toBeTruthy();
    const [zeile] = within(screen.getByTestId('was-steht-an')).getAllByRole('listitem');
    expect(within(zeile).getByRole('img', { name: 'fällig bis 28.02.2029' }).className).not.toContain('is-ueber');
    expect(zeile.textContent).toContain('Maßnahme M-2029-0001 · in 16 Tagen');
  });

  it('„Woher kommen diese Fristen?“ öffnet die Herleitung; allein trägt der Block beide Sätze, in der Übersicht schweigen sie', () => {
    const { unmount } = render(<EnergiemanagementBaustein bild={wasStehtAn(wvDemo())!} onOeffnen={() => {}} />);
    expect(screen.getByTestId('was-steht-an-woher').textContent).toContain(WOHER_SATZ);
    const block = screen.getByTestId('baustein-energiemanagement');
    expect(block.textContent).toContain(UEMS_VERANTWORTUNG);
    expect(block.textContent).toContain(UEMS_NORMGRENZE);
    unmount();
    render(
      <GrenzSatzBereich>
        <EnergiemanagementBaustein bild={wasStehtAn(wvDemo())!} onOeffnen={() => {}} />
      </GrenzSatzBereich>,
    );
    expect(screen.getByTestId('baustein-energiemanagement').textContent).not.toContain(UEMS_VERANTWORTUNG);
  });

  it('ohne jede Frist kein Block (AP-13 E3)', () => {
    expect(bausteineMitInhalt({ messstellen: null, energiebilanz: null, gebaeude: [], kennzahlen: null, energiemanagement: wasStehtAn(wvLeer()) })).toEqual([]);
    expect(bausteineMitInhalt({ messstellen: null, energiebilanz: null, gebaeude: [], kennzahlen: null, energiemanagement: wasStehtAn(wvNormal()) })).toEqual([
      'energiemanagement',
    ]);
  });
});

const st = werkAhrenberg();
const anlagen = st.anlagen.map((a) => ({ id: a.id, name: a.name }));
let geladen: UebersichtDaten | null = null;
function Uebersicht({ art, onNavigate = () => {} }: { art: 'unternehmen' | 'standort'; onNavigate?: (r: unknown) => void }) {
  const daten = useUebersichtBausteine(
    art === 'standort' ? { art, standort: st } : { art, name: 'Ahrenberg', standorte: [st] },
    anlagen,
    ahrenbergFunktionen(),
  );
  geladen = daten;
  return daten && <UebersichtBausteine daten={daten} zeigen={['energiemanagement']} onNavigate={onNavigate} />;
}

describe('„Was steht an“ in der Übersicht des Unternehmens', () => {
  beforeEach(() => {
    geladen = null;
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(ahrenbergRegister());
    vi.spyOn(api, 'anlageBilanz').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'standortOrte').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: [] });
    vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [] });
    vi.spyOn(api, 'bezugsbasisUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'verbesserungUebersicht').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(api, 'energiemanagementWiedervorlage').mockResolvedValue(wvR12());
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    vi.restoreAllMocks();
  });

  it('R12: der Block steht; „Zur Wiedervorlage“ führt in die Wiedervorlage; die Statuszeile bekommt ihre Eskalation', async () => {
    const onNavigate = vi.fn();
    render(<Uebersicht art="unternehmen" onNavigate={onNavigate} />);
    await act(async () => {});
    expect(screen.getByTestId('energiemanagement-marken').textContent).toBe('8 überfällig1 in den nächsten 30 Tagen');
    fireEvent.click(screen.getByRole('button', { name: 'Zur Wiedervorlage' }));
    expect(onNavigate).toHaveBeenLastCalledWith(energiemanagementRoute('wiedervorlage'));
    // Entscheid 9: dieselbe Wiedervorlage liefert die Eskalation für die Statuszeile der Übersicht.
    expect(geladen?.wiedervorlageStatus).toMatchObject({ titel: '8 Fristen überfällig', satz: 'Älteste seit 13.11.2027 · Bezugsbasen, Bericht, energetische Bewertung, Dokumente' });
  });

  it('der Kalender-Abzug wohnt in der Wiedervorlage, nicht auf der Übersicht', async () => {
    const ics = vi.spyOn(api, 'energiemanagementWiedervorlageIcs');
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(screen.queryByText(/Kalender-Abzug/)).toBeNull();
    expect(ics).not.toHaveBeenCalled();
  });

  it('nichts überfällig: der Block bleibt ruhig, die Statuszeile bekommt nichts', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvNormal());
    render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(screen.getByTestId('energiemanagement-marken').textContent).toBe('Keine Frist überfällig');
    expect(geladen?.wiedervorlageStatus).toBeNull();
  });

  it('ohne jede Frist kein Render (WV5, AP-13 E3)', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockResolvedValue(wvLeer());
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('am Standort nie und ohne Abfrage: der Block gehört dem Unternehmen', async () => {
    const { container } = render(<Uebersicht art="standort" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(api.energiemanagementWiedervorlage).not.toHaveBeenCalled();
  });

  it('eine abgelehnte Abfrage zeigt nichts', async () => {
    vi.mocked(api.energiemanagementWiedervorlage).mockRejectedValue(new Error('403'));
    const { container } = render(<Uebersicht art="unternehmen" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});
