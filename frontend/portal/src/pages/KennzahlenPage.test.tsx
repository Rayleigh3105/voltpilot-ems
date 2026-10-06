import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { ebenenAktiv, ebenenOrt } from '../ebenenNav';
import { hashForRoute, kennzahlRoute, pageRoute, parseRoute } from '../nav';
import {
  fassungenVon,
  KZ,
  kennzahlenDerWelt,
  kennzahlWerteAntwort,
  kennzahlWertVersionenAntwort,
} from '../test/kennzahlWerteFixtures';
import { referenzListe } from '../test/kennzahlListeFixtures';
import { KennzahlenPage } from './KennzahlenPage';

/** Geschütztes Leerzeichen (U+00A0) zwischen Zahl und Einheit. */
const NB = String.fromCharCode(160);

/**
 * „Unternehmen › Kennzahlen“ und die Kennzahl-Seite (UEMS AP-11 IP-13) mit den Antworten aus den Vektoren
 * (`test/kennzahlWerteFixtures.ts`) — gelesen zu einer festen Uhr.
 */
function verdrahte(jetzt: string, ausserhalb: string[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(jetzt));
  vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({ kennzahlen: kennzahlenDerWelt() }));
  vi.spyOn(api, 'kennzahl').mockImplementation(async (id) => {
    const k = kennzahlenDerWelt().find((x) => x.id === id);
    if (!k) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    return k;
  });
  vi.spyOn(api, 'kennzahlFassungen').mockImplementation(async (id) => ({ kennzahl_id: id, kennzeichen: '', fassungen: fassungenVon(id) }));
  const werte = vi.spyOn(api, 'kennzahlWerte').mockImplementation(async (id, periode, von, bis) => {
    if (ausserhalb.includes(id)) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    return kennzahlWerteAntwort(id, periode, von, bis, Date.now());
  });
  vi.spyOn(api, 'kennzahlWertVersionen').mockImplementation(async (id, periode, von) =>
    kennzahlWertVersionenAntwort(id, periode, von, Date.now()),
  );
  return { werte };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Das Menü ⋯ im Kopf der Seite: die Einträge, die der Nutzer sieht (das Menü schließt danach wieder). */
async function menue(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Weitere Aktionen' }));
  const eintraege = (await screen.findAllByRole('menuitem')).map((e) => e.textContent ?? '');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return eintraege;
}

/** Ein Eintrag des Menüs ⋯ im Kopf der Seite. */
async function waehle(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Weitere Aktionen' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('die Adresse der Welt', () => {
  it('`#/portfolio/kennzahlen` ist die Liste, `…/{id}` die Kennzahl — beide im Bereich „Kennzahlen“ des Unternehmens', () => {
    expect(hashForRoute(pageRoute('portfolio-kennzahlen'))).toBe('#/portfolio/kennzahlen');
    expect(parseRoute('#/portfolio/kennzahlen')).toEqual(pageRoute('portfolio-kennzahlen'));
    expect(hashForRoute(kennzahlRoute(KZ.kz1))).toBe(`#/portfolio/kennzahlen/${KZ.kz1}`);
    expect(parseRoute(`#/portfolio/kennzahlen/${KZ.kz1}`)).toEqual(kennzahlRoute(KZ.kz1));
    expect(ebenenAktiv('portfolio-kennzahlen')).toBe('kennzahlen');
    expect(ebenenOrt(kennzahlRoute(KZ.kz1), { art: 'unternehmen' })).toEqual({ art: 'unternehmen' });
  });
});

describe('KennzahlenPage — die Liste', () => {
  it('ohne Auswertung (älterer Server): je Kennzahl der letzte Wert wie bisher - K8 als „—“, K10 mit „mindestens“, K11 mit „höchstens“', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    render(<KennzahlenPage onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('kennzahl-reihe').filter((r) => r.textContent?.includes('·'))).toHaveLength(5));
    const reihen = screen.getAllByTestId('kennzahl-reihe');
    const text = (i: number) => reihen[i].textContent ?? '';
    // Alle stehen „Zum Beobachten“ - ohne Auswertung gibt es kein Urteil.
    expect(screen.getByTestId('kennzahlen-ohne').textContent).toContain('Zum Beobachten');
    expect(screen.queryByTestId('kennzahlen-mit')).toBeNull();
    expect(text(0)).toContain('KZ-0001');
    expect(text(0)).toContain('Stromeinsatz Montage je Stück — Halle 2');
    expect(text(0)).toContain('—');
    expect(text(0)).toContain('keine Werte');
    expect(text(0)).toContain('November 2026');
    expect(text(2)).toContain(`0,20${NB}kWh je Stück`);
    expect(text(2)).toContain('Oktober 2026 · endgültig');
    expect(text(3)).toContain(`mindestens 30,83${NB}kWh je Person`);
    expect(text(3)).toContain('05.11.2026 · vorläufig');
    expect(text(4)).toContain(`höchstens 10,55${NB}kWh je h`);
  });

  it('R-A7: kennt die Werte-Route eine gelistete Kennzahl nicht (404), steht die Hinweiszeile — ohne Wert', async () => {
    verdrahte('2026-11-10T09:00:00+01:00', [KZ.kz3]);
    const { container } = render(<KennzahlenPage onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('[data-kennzeichen="KZ-0003"]')?.textContent).toContain('umfasst Standorte außerhalb Ihres Zugriffs'));
    const reihe = container.querySelector('[data-kennzeichen="KZ-0003"]') as HTMLElement;
    expect(reihe.textContent).toContain('Stromeinsatz Montage je Stück — Unternehmen');
    expect(reihe.querySelector('.vp-kzl-reihe-zahl')).toBeNull();
  });

  it('ein Tipp auf die Reihe öffnet die Kennzahl', async () => {
    verdrahte('2026-11-10T09:00:00+01:00');
    const onOeffnen = vi.fn();
    render(<KennzahlenPage onOeffnen={onOeffnen} onListe={vi.fn()} />);
    const reihen = await screen.findAllByTestId('kennzahl-reihe');
    fireEvent.click(reihen[0]);
    expect(onOeffnen).toHaveBeenCalledWith(KZ.kz1);
  });

  it('mit Auswertung (Konzept Auswerten a1 §6.4): eine Anfrage, keine Werte-Anfrage je Karte; Hinweiskarte und Gruppen', async () => {
    const { werte } = verdrahte('2029-04-30T10:00:00+02:00');
    const liste = vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({ kennzahlen: referenzListe() }));
    const onOeffnen = vi.fn();
    render(<KennzahlenPage onOeffnen={onOeffnen} onListe={vi.fn()} />);
    const mit = await screen.findByTestId('kennzahlen-mit');
    expect(liste).toHaveBeenCalledWith('auswertung');
    // Archivierte sind zu, alle anderen tragen ihre Auswertung: keine einzige Werte-Anfrage.
    expect(werte).not.toHaveBeenCalled();
    expect(within(mit).getAllByTestId('kennzahl-karte').map((k) => k.dataset.kennzeichen)).toEqual(['KZ-0004', 'KZ-0023', 'KZ-0021']);
    expect(screen.getByTestId('kennzahlen-hinweis').textContent).toContain('2 Kennzahlen liegen über der Bezugsbasis');
    expect(within(screen.getByTestId('kennzahlen-ohne')).getAllByTestId('kennzahl-reihe')).toHaveLength(3);
    // Aufklappen lädt die Werte der Archivierten.
    const archiv = screen.getByTestId('kennzahlen-archiv') as HTMLDetailsElement;
    archiv.open = true;
    fireEvent(archiv, new Event('toggle'));
    await waitFor(() => expect(werte).toHaveBeenCalledTimes(5));
  });
});

describe('KennzahlSeite (§5.3, §5.5)', () => {
  it('K1 am 10.11.2026: Kopf, „0,15 kWh je Stück“ · vollständig · Verlauf 100 % · Oktober 2026 · endgültig, Herkunft, Berechnung, Stammdaten', async () => {
    verdrahte('2026-11-10T09:00:00+01:00');
    render(<KennzahlenPage kennzahlId={KZ.kz1} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const karte = await screen.findByTestId('werte-karte');
    // K5: der Name zuerst, das Kennzeichen klein dahinter.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stromeinsatz Montage je Stück — Halle 2 KZ-0001');
    expect(screen.getByText('Gebäude Halle 2 · verantwortlich Ines Kaltenbach')).toBeTruthy();
    expect(karte.textContent).toContain(`0,15${NB}kWh je Stück`);
    expect(karte.textContent).toContain('vollständig');
    expect(karte.textContent).toContain(`Verlauf 100${NB}%`);
    expect(karte.textContent).toContain('Oktober 2026');
    expect(within(karte).getByTestId('werte-fassung').textContent).toBe('endgültig');
    expect(within(karte).queryByTestId('werte-versionen')).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Periode' }).textContent).toBe('MonatJahr');
    expect(screen.getByTestId('kennzahl-klartext').textContent).toBe(
      `Gerechnet aus 6.100${NB}kWh (Montage Linie M1) geteilt durch 41.000${NB}Stück (Gutteile Montage Halle 2).`,
    );
    // Der Satz in Kennzeichen steht weiter da — im Aufklapper „Wie wird gerechnet?“.
    expect(screen.getByTestId('kennzahl-rechenweg').textContent).toContain(
      `Menge 6.100${NB}kWh (MS-12, vollständig, Version 1) je 41.000${NB}Stück (BZ-6, Fassung 1)`,
    );
    expect(screen.getByTestId('kennzahl-berechnung').textContent).toContain(
      'Menge je Bezugsgröße · Montage Linie M1 (MS-12) je Gutteile Montage Halle 2 (BZ-6) · Fassung 1 gilt seit Beginn',
    );
    // „Über diese Kennzahl“ (Konzept Auswerten a1 §6.5): Zweck und Geltung in einem Satz.
    expect(screen.getByTestId('kennzahl-stammdaten').textContent).toContain('Gilt für das Gebäude Halle 2 · verantwortlich Ines Kaltenbach');
  });

  it('K8 am 03.12.2026: „—“ mit dem Kundensatz; ein Tipp auf Oktober zeigt Version 2 mit „2 Versionen“ — und die Versionen öffnen', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    render(<KennzahlenPage kennzahlId={KZ.kz1} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const grund = await screen.findByTestId('werte-grund');
    expect(grund.textContent).toBe('Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.');
    expect(screen.queryByTestId('kennzahl-herkunft')).toBeNull();
    const balken = screen.getAllByTestId('verlauf-balken');
    expect(balken.map((b) => b.getAttribute('aria-label'))).toEqual([
      `Oktober 2026 · 0,15${NB}kWh je Stück · vollständig`,
      'November 2026 · — · keine Werte',
      'Dezember 2026 · —',
    ]);
    fireEvent.click(balken[0]);
    const einstieg = await screen.findByTestId('werte-versionen');
    expect(einstieg.textContent).toContain('2 Versionen');
    expect(screen.getByTestId('werte-karte').textContent).toContain('korrigiert (Version 2)');
    expect(screen.getByTestId('kennzahl-herkunft').textContent).toContain('Anlass K-2026-0007 (freigegeben 12.11.2026)');
    fireEvent.click(einstieg);
    const dialog = await screen.findByTestId('versionen-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('version')).toHaveLength(2));
    expect(dialog.textContent).toContain(`0,1488${NB}kWh je Stück`);
    expect(dialog.textContent).toContain('Korrektur K-2026-0007');
    expect(dialog.textContent).toContain('freigegeben von Ines Kaltenbach');
  });

  it('der Perioden-Umschalter fragt die Jahre — ohne Zeile steht jede Periode als „—“', async () => {
    const { werte } = verdrahte('2026-12-03T09:00:00+01:00');
    render(<KennzahlenPage kennzahlId={KZ.kz1} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('werte-karte');
    fireEvent.click(screen.getByRole('tab', { name: 'Jahr' }));
    await waitFor(() => expect(werte).toHaveBeenLastCalledWith(KZ.kz1, 'jahr', '2022-01-01', '2026-12-31'));
    await waitFor(() => expect(screen.getAllByTestId('verlauf-balken')).toHaveLength(5));
    expect(screen.getByTestId('werte-karte').textContent).toContain('—');
  });

  it('eine Kennzahl, die es nicht (mehr) gibt, sagt das — mit dem Weg zurück zur Liste', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    const onListe = vi.fn();
    render(<KennzahlenPage kennzahlId="c0de0000-0000-4000-8000-00000000ffff" onOeffnen={vi.fn()} onListe={onListe} />);
    expect(await screen.findByText('Diese Kennzahl gibt es nicht (mehr).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Alle Kennzahlen' }));
    expect(onListe).toHaveBeenCalled();
  });
});

describe('KennzahlSeite — ändern, archivieren, löschen (AP-11 IP-15, §5.4, §5.7)', () => {
  type K = ReturnType<typeof kennzahlenDerWelt>[number];
  const eine = (id: string, over: (k: K) => K = (k) => k): K => over(kennzahlenDerWelt().find((k) => k.id === id)!);

  it('„Stammdaten ändern“: PUT mit unverändertem Kennzeichen, ohne Fassung — die Seite zeigt den neuen Verantwortlichen', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    const aendern = vi
      .spyOn(api, 'kennzahlAendern')
      .mockImplementation(async (id, body) => ({ ...eine(id), name: body.name, verantwortlich_name: body.verantwortlich_name, zweck: body.zweck ?? null }));
    const eintragen = vi.spyOn(api, 'kennzahlFassungEintragen');
    render(<KennzahlenPage kennzahlId={KZ.kz1} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    // Konzept Auswerten a1 §6.5: die Werkzeuge stehen im Menü ⋯ des Kopfs.
    await waehle('Stammdaten ändern');
    const dialog = await screen.findByTestId('kennzahl-stammdaten-dialog');
    const speichern = () => screen.getByRole('button', { name: 'Speichern' }) as HTMLButtonElement;
    expect(dialog.textContent).toContain('es entsteht keine neue Fassung');
    expect(speichern().disabled).toBe(true);
    fireEvent.change(within(dialog).getByDisplayValue('Ines Kaltenbach'), { target: { value: 'Peter Hollerbach' } });
    expect(speichern().disabled).toBe(false);
    fireEvent.click(speichern());
    await waitFor(() => expect(aendern).toHaveBeenCalledTimes(1));
    expect(aendern).toHaveBeenCalledWith(KZ.kz1, {
      kennzeichen: 'KZ-0001',
      name: 'Stromeinsatz Montage je Stück — Halle 2',
      verantwortlich_name: 'Peter Hollerbach',
      zweck: 'Spezifischer Stromeinsatz der Montagelinie M1 je Gutteil; Basis für den Vergleich mit Lindach.',
    });
    expect(await screen.findByText('Gebäude Halle 2 · verantwortlich Peter Hollerbach')).toBeTruthy();
    expect(eintragen).not.toHaveBeenCalled();
  });

  it('KZ-0001 hat Werte: kein Löschen im Menü ⋯; Archivieren nennt KZ-0003 — danach „archiviert“ und kein Ändern mehr', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    const archivieren = vi
      .spyOn(api, 'kennzahlArchivieren')
      .mockImplementation(async (id) => eine(id, (k) => ({ ...k, archiviert_am: '2026-12-03T09:05:00+01:00' })));
    const loeschen = vi.spyOn(api, 'kennzahlLoeschen');
    render(<KennzahlenPage kennzahlId={KZ.kz1} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await screen.findByTestId('werte-karte');
    // Mit Werten bietet das Menü ⋯ kein Löschen (V5) - Archivieren ist der Weg.
    expect(await menue()).toEqual(['Kopieren', 'Berechnung ändern ab …', 'Stammdaten ändern', 'Archivieren']);
    await waehle('Archivieren');
    const folgen = await screen.findByTestId('confirm-consequences');
    await waitFor(() =>
      expect(folgen.textContent).toContain('KZ-0003 Stromeinsatz Montage je Stück — Unternehmen liest KZ-0001 und zeigt danach „Eingang archiviert (KZ-0001)“.'),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Archivieren' }).at(-1)!);
    await waitFor(() => expect(archivieren).toHaveBeenCalledWith(KZ.kz1));
    expect((await screen.findByTestId('kennzahl-archiviert')).textContent).toBe(
      'Archiviert am 03.12.2026 — die Werte bleiben lesbar, VoltPilot rechnet sie nicht mehr.',
    );
    // Archiviert: nichts mehr zu ändern - nur Kopieren bleibt.
    expect(await menue()).toEqual(['Kopieren']);
    expect(loeschen).not.toHaveBeenCalled();
  });

  it('KZ-0003 zeigt „Eingang archiviert (KZ-0001)“ an der Berechnung, sobald KZ-0001 archiviert ist', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({
      kennzahlen: kennzahlenDerWelt().map((k) => (k.id === KZ.kz1 ? { ...k, archiviert_am: '2026-12-03T09:05:00+01:00' } : k)),
    }));
    render(<KennzahlenPage kennzahlId={KZ.kz3} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    expect((await screen.findByTestId('kennzahl-eingang-archiviert')).textContent).toBe('Eingang archiviert (KZ-0001)');
  });

  it('ohne einen einzigen Wert und ohne Leser: „Kennzahl löschen“ → DELETE — und zurück zur Liste', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    const ohneWerte = (k: K): K => (k.id === KZ.kz8 ? { ...k, hat_werte: false } : k);
    vi.spyOn(api, 'kennzahl').mockImplementation(async (id) => eine(id, ohneWerte));
    vi.spyOn(api, 'kennzahlen').mockImplementation(async () => ({ kennzahlen: kennzahlenDerWelt().map(ohneWerte) }));
    const loeschen = vi.spyOn(api, 'kennzahlLoeschen').mockImplementation(async () => undefined);
    const onListe = vi.fn();
    render(<KennzahlenPage kennzahlId={KZ.kz8} onOeffnen={vi.fn()} onListe={onListe} />);
    await waehle('Kennzahl löschen');
    fireEvent.click(within(await screen.findByTestId('kennzahl-lebenszyklus')).getByRole('button', { name: 'Kennzahl löschen' }));
    expect(screen.getByText('KZ-0008 Stromabgabe je Ladestunde verschwindet aus der Liste.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(loeschen).toHaveBeenCalledWith(KZ.kz8));
    expect(onListe).toHaveBeenCalledTimes(1);
  });

  it('lehnt die Route das Löschen ab, steht ihr Satz — und die Seite bleibt', async () => {
    verdrahte('2026-12-03T09:00:00+01:00');
    vi.spyOn(api, 'kennzahl').mockImplementation(async (id) => eine(id, (k) => ({ ...k, hat_werte: false })));
    vi.spyOn(api, 'kennzahlLoeschen').mockRejectedValue(new ApiError(409, 'KZ-0008 hat Werte — archivieren Sie sie.'));
    const onListe = vi.fn();
    render(<KennzahlenPage kennzahlId={KZ.kz8} onOeffnen={vi.fn()} onListe={onListe} />);
    await waehle('Kennzahl löschen');
    fireEvent.click(within(await screen.findByTestId('kennzahl-lebenszyklus')).getByRole('button', { name: 'Kennzahl löschen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    expect(await screen.findByText('KZ-0008 hat Werte — archivieren Sie sie.')).toBeTruthy();
    expect(onListe).not.toHaveBeenCalled();
  });
});
