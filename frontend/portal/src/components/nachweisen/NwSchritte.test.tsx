import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AntwortKarten, HinweisZeile, PruefZeilen, SchrittAnzeige, Umschalter, WahlChips, WerteAltNeu, Wortlaut } from './NwSchritte';

describe('Blatt-Bausteine Nachweisen', () => {
  it('Schritt-Anzeige: der Satz für Vorleser, so viele Balken wie Schritte, die erreichten an', () => {
    const { container } = render(<SchrittAnzeige nr={2} von={3} />);
    expect(screen.getByTestId('nw-schritt').textContent).toBe('Schritt 2 von 3');
    const balken = container.querySelectorAll('.vp-nw-schritt-bar i');
    expect(balken).toHaveLength(3);
    expect([...balken].map((b) => b.className)).toEqual(['an', 'an', '']);
  });

  it('Antwort-Karten sind eine Radiogruppe mit der Frage als Name; eine nicht wählbare Karte bleibt aus', () => {
    const onWahl = vi.fn();
    render(
      <AntwortKarten
        frage="Gilt Rev. 4 noch?"
        optionen={[
          { wert: 'bleibt', titel: 'Ja, bleibt', zusatz: 'nächste Prüfung 2030' },
          { wert: 'neu', titel: 'Nein, neuer Stand' },
          { wert: 'spaeter', titel: 'April 2029', zusatz: 'ab 07.05.2029', aus: true },
        ]}
        wert="bleibt"
        onWahl={onWahl}
        testid="wahl"
      />,
    );
    const gruppe = screen.getByRole('group', { name: 'Gilt Rev. 4 noch?' });
    expect(gruppe).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Ja, bleibt/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Nein, neuer Stand/ }));
    expect(onWahl).toHaveBeenCalledWith('neu');
    expect((screen.getByRole('radio', { name: /April 2029/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('wahl-bleibt').className).toContain(' an');
  });

  it('Wahl-Chips: eine Antwort als Radio, mehrere als Kontrollkästchen', () => {
    const eins = vi.fn();
    const { unmount } = render(
      <WahlChips frage="Wann?" optionen={[{ wert: 'heute', label: 'Heute, 30.04.' }, { wert: 'gestern', label: 'Gestern' }]} wert="heute" onWahl={eins} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Gestern' }));
    expect(eins).toHaveBeenCalledWith('gestern');
    unmount();
    const viele = vi.fn();
    render(
      <WahlChips
        frage="Wie?"
        mehrfach
        optionen={[{ wert: 'aushang', label: 'Aushang' }, { wert: 'intranet', label: 'Intranet' }]}
        werte={['aushang']}
        onWahl={viele}
        fehler="Bitte wählen Sie einen Weg."
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Intranet' }));
    expect(viele).toHaveBeenLastCalledWith(['aushang', 'intranet']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Aushang' }));
    expect(viele).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole('alert').textContent).toBe('Bitte wählen Sie einen Weg.');
  });

  it('Hinweis-Zeile trägt Titel, Zusatz und den hereingereichten i-Knopf', () => {
    render(<HinweisZeile icon="users" titel="Eine Person gibt frei" zusatz="wahlfrei" knopf={<button type="button">i</button>} testid="hz" />);
    expect(screen.getByTestId('hz').textContent).toBe('Eine Person gibt frei · wahlfreii');
  });

  it('Prüfen-Zeilen: „Ändern“ nur, wo ein Weg zurück da ist, mit dem Etikett im Namen', () => {
    const aendern = vi.fn();
    render(<PruefZeilen zeilen={[{ etikett: 'Teil', wert: 'Risiken und Chancen' }, { etikett: 'Original', wert: 'RR-2029', onAendern: aendern }]} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Original ändern' }));
    expect(aendern).toHaveBeenCalled();
  });

  it('Werte alt → neu: fehlend steht als Strich, nie als Null, und Vorleser hören den Satz', () => {
    render(<WerteAltNeu werte={[{ name: 'Montage Linie M1', alt: '6.100', neu: '6.040', einheit: 'kWh' }, { name: 'Neu', alt: null, neu: '12', einheit: null }]} />);
    expect(screen.getByText('vorher 6.100, jetzt 6.040 kWh')).toBeTruthy();
    expect(screen.getByText('vorher kein Wert, jetzt 12')).toBeTruthy();
  });

  it('Wortlaut: Absätze bleiben Absätze, das Neue ist hinterlegt', () => {
    const { container } = render(
      <Wortlaut absaetze={[[{ text: 'Wir messen. ', neu: false }, { text: 'Beim Kauf zählt die Nutzungsdauer.', neu: true }], [{ text: 'Zweiter Absatz.', neu: false }]]} />,
    );
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelector('mark')?.textContent).toBe('Beim Kauf zählt die Nutzungsdauer.');
  });

  it('Umschalter: zwei Formen als Radiogruppe', () => {
    const onWahl = vi.fn();
    render(<Umschalter label="Form" optionen={[{ wert: 'wortlaut', label: 'Text' }, { wert: 'verweis', label: 'Verweis' }]} wert="wortlaut" onWahl={onWahl} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Verweis' }));
    expect(onWahl).toHaveBeenCalledWith('verweis');
  });
});
