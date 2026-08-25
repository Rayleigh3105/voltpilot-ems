import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { JetztHeld, TagesFilm } from './FahrplanJetzt';
import type { JetztHeldView } from '../fahrplanJetzt';
import type { FilmRow, FilmView } from '../fahrplanFilm';

/**
 * Render-only: die Zustands-Vollständigkeit liegt in `fahrplanJetzt.test.ts`
 * und `fahrplanFilm.test.ts`; hier wird nur geprüft, dass die Fläche das
 * Abgeleitete auch WIRKLICH zeigt - inklusive der beiden Ehrlichkeitsstellen
 * („—" mit Grund, „Morgen" eingeklappt).
 */

function held(over: Partial<JetztHeldView> = {}): JetztHeldView {
  return {
    state: 'angepasst',
    tone: 'ok',
    badge: 'Gemessen',
    badgeArt: 'gemessen',
    badgeNote: 'vor 8 Sek.',
    status: 'Läuft wie vorgesehen — nichts zu tun',
    lead: 'Ihre Batterie deckt gerade den Verbrauch',
    value: '6,1 kW',
    valueNote: 'aus dem Speicher',
    valueMissing: null,
    adjust: 'Der Fahrplan sah 4,3 kW vor — Ihr Gerät hat den Wert angepasst.',
    confirm: 'vom Wechselrichter bestätigt · geprüft vor 8 Sek.',
    conflict: null,
    curtailment: null,
    flowConflict: null,
    flowConflictSeverity: null,
    why: 'Netzstrom kostet Sie jetzt 32,5 ct/kWh.',
    chips: [{ label: 'Haus', value: '7,1 kW' }],
    next: null,
    ...over,
  };
}

function row(over: Partial<FilmRow> & { phaseIndex: number }): FilmRow {
  return {
    role: 'eigenverbrauch',
    kind: 'discharge',
    now: false,
    done: false,
    label: 'Verbrauch decken',
    time: '17:45–21:30 Uhr',
    from: '2026-08-01T17:45:00Z',
    to: '2026-08-01T21:30:00Z',
    sub: null,
    eur: null,
    einkauf: false,
    duty: null,
    ...over,
  };
}

function view(over: Partial<FilmView> = {}): FilmView {
  return { past: [], today: [], tomorrow: [], tomorrowSummary: null, empty: null, ...over };
}

describe('JetztHeld', () => {
  it('zeigt Zustand, Aussage, Ausführungs-Zahl, Nachführung, Warum und Messwerte', () => {
    render(<JetztHeld view={held()} />);
    expect(screen.getByText(/nichts zu tun/)).toBeInTheDocument();
    expect(screen.getByText('Ihre Batterie deckt gerade den Verbrauch')).toBeInTheDocument();
    expect(screen.getByText('6,1 kW')).toBeInTheDocument();
    expect(screen.getByText('aus dem Speicher')).toBeInTheDocument();
    expect(screen.getByText(/Fahrplan sah 4,3 kW vor/)).toBeInTheDocument();
    expect(screen.getByText(/32,5 ct\/kWh/)).toBeInTheDocument();
    expect(screen.getByText('Gemessen')).toBeInTheDocument();
    expect(screen.getByText('7,1 kW')).toBeInTheDocument();
  });

  it('zeigt „—" MIT Grund statt einer erfundenen Zahl', () => {
    render(
      <JetztHeld
        view={held({
          value: null,
          valueNote: null,
          valueMissing: 'Noch keine aktuelle Rückmeldung Ihres Wechselrichters.',
          confirm: null,
        })}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/Noch keine aktuelle Rückmeldung/)).toBeInTheDocument();
    expect(screen.queryByText(/bestätigt/)).not.toBeInTheDocument();
  });

  it('trägt den Ton als Klasse, damit eine Nachführung grün und ein Bruch bernstein liest', () => {
    const { container, rerender } = render(<JetztHeld view={held()} />);
    expect(container.querySelector('.vp-jetzt-status.is-ok')).toBeTruthy();
    rerender(<JetztHeld view={held({ tone: 'warn', state: 'abweichung' })} />);
    expect(container.querySelector('.vp-jetzt-status.is-warn')).toBeTruthy();
  });

  it('meldet Statusänderungen semantisch und zeigt den Ausführungspfad ohne interne Codes', () => {
    const { container } = render(<JetztHeld view={held({
      tone: 'warn',
      status: 'Unerwarteter Verbrauch · Speicher deckt live bis 35 % Reserve',
      chips: [
        { label: 'Ausführung', value: 'Wechselrichter-Automatik' },
        { label: 'Rücklesen', value: 'bestätigt' },
      ],
    })} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Wechselrichter-Automatik')).toBeInTheDocument();
    expect(screen.queryByText(/autonomous_discharge|idle_follow|exception|stack|SQLSTATE/i)).not.toBeInTheDocument();
    // Die reine Statusfläche führt weder am Desktop noch mobil einen neuen
    // Tastaturstopp ein; ihre Änderung erreicht Screenreader über aria-live.
    expect(container.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
  });

  it('zeigt im WARN-Flusskonflikt den bernstein Satz und lässt die Bestätigungszeile verschwinden', () => {
    const { container } = render(
      <JetztHeld
        view={held({
          tone: 'warn',
          confirm: null,
          flowConflictSeverity: 'warn',
          flowConflict:
            'Entladung angewiesen (30,0 kW) - der Speicher entlädt aber nicht (Messung: lädt 3,3 kW). Bitte im Blick behalten.',
        })}
      />,
    );
    expect(screen.getByText(/der Speicher entlädt aber nicht/)).toBeInTheDocument();
    expect(container.querySelector('.vp-jetzt-conflict')).toBeTruthy();
    expect(container.querySelector('.vp-jetzt-confirm')).toBeFalsy();
    // Die „vom Wechselrichter bestätigt"-Zeile ist weg.
    expect(screen.queryByText(/vom Wechselrichter bestätigt/)).not.toBeInTheDocument();
  });

  it('zeigt den INFO-Flussabgleich RUHIG (grün) und behält die Bestätigungszeile', () => {
    const { container } = render(
      <JetztHeld
        view={held({
          tone: 'ok',
          flowConflictSeverity: 'info',
          flowConflict:
            'Der Speicher pausiert planmäßig – nimmt aber gerade 10,0 kW Überschuss auf, weil Ihre Einspeisegrenze (30 kW) erreicht ist. Dieser Strom wäre sonst verloren.',
        })}
      />,
    );
    expect(screen.getByText(/nimmt aber gerade 10,0 kW Überschuss auf/)).toBeInTheDocument();
    // Grün (bestätigt-Stil), NICHT der bernstein Konflikt-Stil.
    expect(container.querySelector('.vp-jetzt-conflict')).toBeFalsy();
    expect(container.querySelectorAll('.vp-jetzt-confirm').length).toBeGreaterThan(0);
    // Die gutartige Info behält die Bestätigung daneben.
    expect(screen.getByText(/vom Wechselrichter bestätigt/)).toBeInTheDocument();
  });
});

describe('TagesFilm', () => {
  const heute = [
    row({ phaseIndex: 0, now: true, sub: 'läuft · noch bis 21:30 Uhr', eur: '+2,80 €' }),
    row({ phaseIndex: 1, role: 'warten', kind: 'idle', label: 'Ruhe', time: '21:30–02:00 Uhr' }),
  ];

  it('zeigt jede Phase mit ihrem WORT und markiert die laufende', () => {
    render(<TagesFilm view={view({ today: heute })} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Verbrauch decken')).toBeInTheDocument();
    expect(screen.getByText('Ruhe')).toBeInTheDocument();
    expect(screen.getByText('Jetzt')).toBeInTheDocument();
    expect(screen.getByText('+2,80 €')).toBeInTheDocument();
  });

  it('hält „Morgen" eingeklappt, bis der Kunde es öffnet', () => {
    render(
      <TagesFilm
        view={view({
          today: heute,
          tomorrow: [row({ phaseIndex: 2, label: 'Sonne speichern' })],
          tomorrowSummary: 'Morgen · 1 weitere Phase',
        })}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText('Sonne speichern')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Morgen/ }));
    expect(screen.getByText('Sonne speichern')).toBeInTheDocument();
  });

  it('klappt das Erklär-Panel AN DER angetippten Zeile aus', () => {
    const { container } = render(
      <TagesFilm
        view={view({ today: heute })}
        selected={1}
        onSelect={() => {}}
        panel={<p className="panel">warum</p>}
      />,
    );
    const rows = container.querySelectorAll('.vp-film-li');
    expect(rows[0].querySelector('.panel')).toBeNull();
    expect(rows[1].querySelector('.panel')).toBeTruthy();
  });

  it('zeigt die Duty-Vorschau an der Phase - mit dem ausführlichen Satz als Tipp', () => {
    const { container } = render(
      <TagesFilm
        view={view({
          today: [
            row({
              phaseIndex: 0,
              duty: {
                kind: 'verbrauch-folgen',
                text: 'folgt dem gemessenen Verbrauch',
                hint: 'Der Wert dieser Phase ist eine Vorhersage: …',
                partial: false,
              },
            }),
            row({ phaseIndex: 1, label: 'Ruhe', role: 'warten', kind: 'idle' }),
          ],
        })}
        selected={null}
        onSelect={() => {}}
      />,
    );
    const notes = container.querySelectorAll('.vp-film-duty');
    // Nur die Pflicht-Phase trägt die Zeile - eine Phase ohne Pflicht schweigt.
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('folgt dem gemessenen Verbrauch');
    expect(notes[0].getAttribute('title')).toContain('Vorhersage');
  });

  it('sagt es, wenn für heute nichts mehr ansteht', () => {
    render(
      <TagesFilm
        view={view({ empty: 'Für heute stehen keine weiteren Phasen an.' })}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/keine weiteren Phasen/)).toBeInTheDocument();
  });
});
