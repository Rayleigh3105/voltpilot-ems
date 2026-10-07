import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Selbstauskunft } from '../../api';
import { energiemanagementRoute, pageRoute } from '../../nav';
import { setSelbstauskunft } from '../../rollen';
import { energiemanagementBuehne } from '../../test/energiemanagementFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { wvR12 } from '../../test/wiedervorlageFixtures';
import { erklaerWoerter, ERKLAER_WOERTER_HOECHSTENS } from './erklaerung';
import { NACHWEIS, TEIL, TRIFFT_NICHT_ZU, VERZEICHNIS } from './nachweisBegriffe';
import { Ueberblick } from './Ueberblick';
import { VerzeichnisMonate } from './VerzeichnisMonate';

/**
 * Überblick und Verzeichnis von Nachweisen (Konzept n1, Runde 2, §6.3 und §6.9) auf der Bühne des Referenzunternehmens
 * am 12.02.2029 (R12): die Antwort als Zahl und Zeichen, ein nächster Schritt, Teile je Gruppe, Blätter auf Antippen,
 * „Trifft bei uns zurzeit nicht zu“ mit Grund und Person (Entscheid 5).
 */
const JETZT = '2029-02-12T09:00:00+01:00';
const laden = async () => {
  await act(async () => {});
  await act(async () => {});
};

describe('Überblick', () => {
  const original = { ...api };
  let buehne: ReturnType<typeof energiemanagementBuehne>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    buehne = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => new Date().toISOString());
    Object.assign(api, buehne.routen, { energiemanagementWiedervorlage: async () => wvR12() });
    await buehne.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vi.useRealTimers();
  });

  it('antwortet mit Zählern, einem nächsten Schritt und den Teilen als Zeichen - ohne Satz unter dem Titel', async () => {
    const onNavigate = vi.fn();
    const springe = vi.fn();
    render(<Ueberblick onNavigate={onNavigate} springe={springe} />);
    await laden();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Überblick');
    expect(screen.getByTestId('ueberblick-kopf').textContent).toContain('Stand 12.02.2029');
    const zaehler = screen.getByTestId('ueberblick-zaehler');
    expect(within(zaehler).getByTestId('zaehler-ueberfaellig').textContent).toBe('8 Fristen überfällig');
    expect(within(zaehler).getByTestId('zaehler-offen').textContent).toMatch(/^\d+ Teile offen$/);
    const naechstes = screen.getByTestId('ueberblick-naechstes');
    expect(naechstes.textContent).toContain('Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 entscheiden');
    fireEvent.click(within(naechstes).getByRole('button', { name: 'Entscheiden' }));
    expect(springe).toHaveBeenCalledWith(expect.objectContaining({ hash: expect.stringContaining('#/portfolio/berichte/BR-2028-0001') }));
    // Vier Gruppen, je eine Zeichen-Reihe; die Teile, die etwas brauchen, als Chip mit Kurzwort.
    const teile = screen.getByTestId('ueberblick-teile');
    expect(within(teile).getAllByRole('button', { name: /^(Grundlagen|Menschen und Abläufe|Messen und Verbessern|Prüfen und Rückblick):/ })).toHaveLength(4);
    expect(screen.getByTestId('teil-chip-kontext').textContent).toBe('Kontext');
    expect(screen.getByTestId('teil-chip-bezugsbasen').textContent).toBe('Bezugsbasen4');
    expect(screen.getByTestId('zeichen-legende').textContent).toContain('überfällig');
  });

  it('das Blatt einer Gruppe nennt je Teil einen Fakt; ein offener Teil hält mit Grund und Person fest, was zurzeit nicht zutrifft', async () => {
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: /^Grundlagen:/ }));
    const blatt = screen.getByTestId('gruppen-blatt');
    expect(within(blatt).getByTestId('gruppen-teil-rechtliche_anforderungen').textContent).toContain('Fassung 1');
    expect(within(blatt).getByTestId('gruppen-teil-kontext').textContent).toBe('Kontext und interessierte ParteienFesthalten');
    await act(async () => {
      fireEvent.click(within(blatt).getByTestId('gruppen-teil-kontext'));
    });
    const festhalten = screen.getByTestId('teil-blatt');
    expect(within(festhalten).getByLabelText(/Als Dokument festhalten/)).toBeTruthy();
    fireEvent.click(within(festhalten).getByLabelText(/Trifft zurzeit nicht zu/));
    fireEvent.click(screen.getByTestId('teil-weiter'));
    expect(screen.getByTestId('nw-schritt').textContent).toBe('Schritt 2 von 3');
    // Zu kurz: der Satz der Grenze, kein Absenden.
    fireEvent.change(screen.getByTestId('teil-satz'), { target: { value: 'kurz' } });
    fireEvent.click(screen.getByTestId('teil-weiter'));
    expect(screen.getByTestId('teil-fehler').textContent).toBe('10 bis 500 Zeichen.');
    fireEvent.change(screen.getByTestId('teil-satz'), { target: { value: 'Unsere Interessen stehen im Handbuch, Kapitel Umfeld.' } });
    await act(async () => {});
    fireEvent.click(screen.getByRole('combobox', { name: 'Wer hat entschieden?' }));
    fireEvent.click(await screen.findByRole('option', { name: /Jonas Wendlinger/ }));
    fireEvent.click(screen.getByTestId('teil-weiter'));
    expect(screen.getByTestId('teil-pruefen').textContent).toContain('Jonas Wendlinger');
    await act(async () => {
      fireEvent.click(screen.getByTestId('teil-weiter'));
    });
    await laden();
    expect(buehne.gesendet.map((g) => g.route)).toEqual(['POST /api/v1/energiemanagement/teil-vermerke']);
    expect(buehne.gesendet[0].koerper).toEqual({ teil: 'kontext', satz: 'Unsere Interessen stehen im Handbuch, Kapitel Umfeld.', entschieden_von: expect.any(String) });
    // Der Teil ist festgehalten; das Blatt der Gruppe zeigt den Vermerk als Fakt.
    expect(screen.queryByTestId('teil-chip-kontext')).toBeTruthy();
    expect(screen.getByTestId('teil-chip-kontext').className).toContain('is-festgehalten');
  });

  it('der Vermerk lässt sich lesen und aufheben', async () => {
    const personen = (await buehne.routen.energiemanagementPersonen()).personen;
    await buehne.routen.energiemanagementTeilVermerkAnlegen({
      teil: 'risiken_chancen', satz: 'Risiken führen wir im Risiko-Register des Konzerns.', entschieden_von: personen.find((p) => p.name === 'Jonas Wendlinger')!.id,
    });
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    await act(async () => {
      fireEvent.click(screen.getByTestId('teil-chip-risiken_chancen'));
    });
    const blatt = screen.getByTestId('vermerk-blatt');
    expect(blatt.textContent).toContain('Risiken führen wir im Risiko-Register des Konzerns.');
    expect(blatt.textContent).toContain('Entschieden vonJonas Wendlinger');
    expect(blatt.textContent).toContain('Ab12.02.2029');
    await act(async () => {
      fireEvent.click(screen.getByTestId('vermerk-aufheben'));
    });
    await laden();
    expect(buehne.gesendet.at(-1)?.route).toMatch(/^POST \/api\/v1\/energiemanagement\/teil-vermerke\/.+\/aufheben$/);
    expect(screen.getByTestId('teil-chip-risiken_chancen').className).toContain('is-offen');
  });

  it('„8 Fristen überfällig“ öffnet die Fristen gebündelt, mit dem Weg in die Wiedervorlage', async () => {
    const springe = vi.fn();
    render(<Ueberblick onNavigate={vi.fn()} springe={springe} />);
    await laden();
    fireEvent.click(screen.getByTestId('zaehler-ueberfaellig'));
    const blatt = screen.getByTestId('fristen-blatt');
    expect(screen.getByRole('dialog', { name: '8 Fristen überfällig' })).toBeTruthy();
    expect(blatt.textContent).toContain('4 Bezugsbasen überprüfen');
    fireEvent.click(within(blatt).getByTestId('fristen-wiedervorlage'));
    expect(springe).toHaveBeenCalledWith(expect.objectContaining({ route: energiemanagementRoute('wiedervorlage') }));
  });

  it('ein Ladefehler sagt es ohne Schuld und bietet „Erneut versuchen“', async () => {
    Object.assign(api, { energiemanagementVerzeichnis: async () => Promise.reject(new Error('weg')) });
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    expect(screen.getByTestId('ueberblick-fehler').textContent).toContain('Ihre Daten sind nicht betroffen.');
  });

  it('ein Ladefehler der Vermerke ist kein „kein Vermerk“: der Stand ist unbekannt (Review r1, P1-1)', async () => {
    const personen = (await buehne.routen.energiemanagementPersonen()).personen;
    await buehne.routen.energiemanagementTeilVermerkAnlegen({
      teil: 'kontext', satz: 'Unsere Interessen stehen im Handbuch, Kapitel Umfeld.', entschieden_von: personen[0].id,
    });
    Object.assign(api, { energiemanagementTeilVermerke: async () => Promise.reject(new ApiError(500, 'kaputt')) });
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    expect(screen.getByTestId('ueberblick-fehler')).toBeTruthy();
    // Kein Teil steht als „offen“ da, kein „Kontext festhalten“, das in 409 `vermerk_besteht` endete.
    expect(screen.queryByTestId('ueberblick-teile')).toBeNull();
    expect(screen.queryByTestId('ueberblick-naechstes')).toBeNull();
  });

  it('ein älterer Server ohne Vermerk-Route (404) zeigt den Stand ohne Vermerke', async () => {
    Object.assign(api, { energiemanagementTeilVermerke: async () => Promise.reject(new ApiError(404, 'unbekannt')) });
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    expect(screen.queryByTestId('ueberblick-fehler')).toBeNull();
    expect(screen.getByTestId('teil-chip-kontext').className).toContain('is-offen');
  });

  it('ohne Wiedervorlage sagt die Zählerzeile „Fristen nicht geladen“ und es gibt kein „Als Nächstes“ (Review r1, P1-2)', async () => {
    const wv = vi.fn(async () => Promise.reject(new Error('weg')));
    Object.assign(api, { energiemanagementWiedervorlage: wv });
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    const zaehler = screen.getByTestId('ueberblick-zaehler');
    expect(within(zaehler).getByTestId('zaehler-fristen-fehler').textContent).toBe('Fristen nicht geladen · Erneut versuchen');
    expect(within(zaehler).queryByTestId('zaehler-ruhig')).toBeNull();
    expect(screen.queryByTestId('ueberblick-naechstes')).toBeNull();
    await act(async () => {
      fireEvent.click(within(zaehler).getByTestId('zaehler-fristen-fehler'));
    });
    await laden();
    expect(wv).toHaveBeenCalledTimes(2);
  });

  it('ein Fehler der CSV lässt den Überblick stehen und versucht die CSV erneut (Review r1, P1-6)', async () => {
    const csv = vi.fn(async () => Promise.reject(new Error('weg')));
    Object.assign(api, { energiemanagementVerzeichnisCsv: csv });
    const lesen = vi.spyOn(api, 'energiemanagementVerzeichnis');
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Verzeichnis als CSV' }));
    });
    const fehler = screen.getByTestId('ueberblick-csv-fehler');
    expect(fehler.textContent).toContain('Die CSV-Datei ließ sich gerade nicht erstellen.');
    expect(screen.getByTestId('ueberblick-teile')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(fehler).getByRole('button', { name: 'Erneut versuchen' }));
    });
    expect(csv).toHaveBeenCalledTimes(2);
    expect(lesen).toHaveBeenCalledTimes(1);
  });

  it('die Region heißt „Teile“, und der Zähler liest sich mit Leerzeichen (Review r1, P1-8)', async () => {
    render(<Ueberblick onNavigate={vi.fn()} springe={vi.fn()} />);
    await laden();
    const region = screen.getByTestId('ueberblick-teile');
    expect(screen.getByRole('region', { name: 'Teile' })).toBe(region);
    // Der Name kommt aus dem Wort allein: Chrome las den i-Knopf im benannten Element mit („Teile Was ist ein Teil?“).
    const name = document.getElementById(region.getAttribute('aria-labelledby')!)!;
    expect(name.textContent).toBe('Teile');
    expect(name.querySelector('button')).toBeNull();
    expect(screen.getByTestId('zaehler-offen').textContent).toMatch(/^\d+ Teile? offen$/);
  });

  it('ein Vermerk bleibt erreichbar, wenn der Teil daneben eine Fassung hat (Review r1, P1-8)', async () => {
    const personen = (await buehne.routen.energiemanagementPersonen()).personen;
    await buehne.routen.energiemanagementTeilVermerkAnlegen({
      teil: 'kontext', satz: 'Unsere Interessen stehen im Handbuch, Kapitel Umfeld.', entschieden_von: personen[0].id,
    });
    const echt = api.energiemanagementTeilVermerke;
    // Der Vermerk steht an einem Teil, der inzwischen eine gültige Fassung hat.
    Object.assign(api, {
      energiemanagementTeilVermerke: async () => {
        const r = await echt();
        return { ...r, vermerke: r.vermerke.map((v) => ({ ...v, teil: 'rechtliche_anforderungen' })) };
      },
    });
    const onNavigate = vi.fn();
    render(<Ueberblick onNavigate={onNavigate} springe={vi.fn()} />);
    await laden();
    await act(async () => {
      fireEvent.click(screen.getByTestId('teil-chip-rechtliche_anforderungen'));
    });
    const blatt = screen.getByTestId('vermerk-blatt');
    fireEvent.click(within(blatt).getByTestId('vermerk-ort'));
    expect(within(blatt).getByTestId('vermerk-ort').textContent).toBe('Ebenfalls festgehalten: Fassung 1');
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ dokumentId: expect.any(String) }));
  });
});

describe('Überblick für Leser und Einsicht (Review r1, P1-4 und P1-5)', () => {
  const original = { ...api };

  async function buehneFuer(me: Selbstauskunft) {
    setSelbstauskunft(me);
    const b = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => new Date().toISOString());
    Object.assign(api, b.routen, { energiemanagementWiedervorlage: async () => wvR12() });
    await b.bereit;
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vi.useRealTimers();
  });

  it('ein Leser öffnet an einem offenen Teil kein „festhalten“, sondern den Ort zum Ansehen', async () => {
    await buehneFuer(rechteSeed('CB').me);
    const onNavigate = vi.fn();
    render(<Ueberblick onNavigate={onNavigate} springe={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: /^Grundlagen:/ }));
    expect(within(screen.getByTestId('gruppen-blatt')).getByTestId('gruppen-teil-kontext').textContent).not.toContain('Festhalten');
    await act(async () => {
      fireEvent.click(screen.getByTestId('teil-chip-kontext'));
    });
    expect(screen.queryByTestId('teil-blatt')).toBeNull();
    expect(onNavigate).toHaveBeenCalledWith(energiemanagementRoute('dokumente'));
  });

  it('mit Einsicht führen „Als Nächstes“, die Fristen und „Demnächst“ zum Ansehen - ohne offenen Entscheid', async () => {
    await buehneFuer(rechteSeed('RF').me);
    const springe = vi.fn();
    render(<Ueberblick onNavigate={vi.fn()} springe={springe} />);
    await laden();
    const naechstes = screen.getByTestId('ueberblick-naechstes');
    expect(within(naechstes).queryByRole('button', { name: 'Entscheiden' })).toBeNull();
    fireEvent.click(within(naechstes).getByRole('button', { name: 'Ansehen' }));
    expect(springe).toHaveBeenLastCalledWith(expect.objectContaining({ hash: expect.stringContaining('#/portfolio/berichte/BR-2028-0001') }));
    expect(springe.mock.calls.every(([s]) => !s.hash.includes('entscheid='))).toBe(true);
    for (const a of screen.getByTestId('ueberblick-demnaechst').querySelectorAll('a')) expect(a.getAttribute('href')).not.toContain('entscheid=');
    fireEvent.click(screen.getByTestId('zaehler-ueberfaellig'));
    for (const a of screen.getByTestId('fristen-blatt').querySelectorAll('a')) expect(a.getAttribute('href')).not.toContain('entscheid=');
    await act(async () => {
      fireEvent.click(screen.getByTestId('teil-chip-energiepolitik'));
    });
    expect(springe.mock.calls.every(([s]) => !s.hash.includes('entscheid='))).toBe(true);
  });

  it('ohne Recht auf die Fläche eines Teils ist er nur Zeichen, kein Knopf', async () => {
    const cb = rechteSeed('CB').me;
    const ohne = (r: string[]) => r.filter((x) => x !== 'energieeinsatz.ansehen');
    await buehneFuer({ ...cb, unternehmen_rechte: ohne(cb.unternehmen_rechte), standorte: cb.standorte.map((st) => ({ ...st, rechte: ohne(st.rechte) })) });
    const onNavigate = vi.fn();
    Object.assign(api, { energiemanagementWiedervorlage: async () => ({ ...wvR12(), faellig: [], vorschau: [] }) });
    render(<Ueberblick onNavigate={onNavigate} springe={vi.fn()} />);
    await laden();
    expect(screen.getByTestId('teil-chip-energetische_bewertung').tagName).toBe('SPAN');
    fireEvent.click(screen.getByRole('button', { name: /^Messen und Verbessern:/ }));
    expect(within(screen.getByTestId('gruppen-blatt')).getByTestId('gruppen-teil-energetische_bewertung').tagName).toBe('DIV');
    expect(onNavigate).not.toHaveBeenCalledWith(pageRoute('portfolio-bewertung'));
  });
});

describe('Verzeichnis eine Ebene tiefer', () => {
  const original = { ...api };
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(JETZT));
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    const b = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => new Date().toISOString());
    Object.assign(api, b.routen);
    await b.bereit;
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
    vi.useRealTimers();
  });

  it('nach Monaten, mit Rückweg zum Überblick; ein Eintrag zeigt Ort, Personen und Prüfsumme und öffnet sein Dokument', async () => {
    const onDokument = vi.fn();
    const onUeberblick = vi.fn();
    render(<VerzeichnisMonate onDokument={onDokument} onUeberblick={onUeberblick} />);
    await laden();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Verzeichnis');
    expect(screen.getByTestId('verzeichnis-kopf').textContent).toMatch(/\d+ Einträge/);
    const monate = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    // Neueste zuerst: am 12.02.2029 ist der jüngste Monat der Januar 2029.
    expect(monate[0]).toBe('Januar 2029');
    expect(monate.indexOf('Dezember 2026')).toBeGreaterThan(monate.indexOf('Dezember 2028'));
    fireEvent.click(screen.getByRole('button', { name: 'Überblick' }));
    expect(onUeberblick).toHaveBeenCalled();
    const dezember2026 = screen.getByTestId('verzeichnis-monat-2026-12');
    const politik = within(dezember2026).getAllByTestId('verzeichnis-eintrag').find((e) => e.textContent?.startsWith('15.12.Energiepolitik'))!;
    fireEvent.click(politik);
    const blatt = screen.getByTestId('eintrag-blatt');
    expect(blatt.textContent).toContain('Robert Falk');
    expect(blatt.textContent).toContain('Wortlaut in VoltPilot, Original bei Ihnen');
    expect(blatt.querySelector('.vp-nw-pruefsumme')?.textContent).toMatch(/^sha256:/);
    fireEvent.click(within(blatt).getByRole('button', { name: 'Dokument öffnen' }));
    expect(onDokument).toHaveBeenCalled();
  });

  it('die Suche filtert in der Seite, „Meine“ und Thema fragen die Route', async () => {
    const lesen = vi.spyOn(api, 'energiemanagementVerzeichnis');
    render(<VerzeichnisMonate onDokument={vi.fn()} onUeberblick={vi.fn()} />);
    await laden();
    fireEvent.change(screen.getByTestId('verzeichnis-suche'), { target: { value: 'Rechtskataster' } });
    expect(screen.getAllByTestId('verzeichnis-eintrag').every((e) => e.textContent?.includes('Rechtskataster'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Meine' }));
    await laden();
    expect(lesen).toHaveBeenLastCalledWith(expect.objectContaining({ person: expect.any(String) }));
    fireEvent.click(screen.getByRole('button', { name: 'Thema' }));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('thema-blatt')).getByLabelText('Berichte'));
    });
    await laden();
    expect(lesen).toHaveBeenLastCalledWith(expect.objectContaining({ gruppe: 'berichte' }));
  });

  it('im Thema-Blatt wandert die Pfeiltaste durch die Themen, ohne das Blatt zu schließen (Review r1, P1-7)', async () => {
    const lesen = vi.spyOn(api, 'energiemanagementVerzeichnis');
    render(<VerzeichnisMonate onDokument={vi.fn()} onUeberblick={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: 'Thema' }));
    const blatt = screen.getByTestId('thema-blatt');
    const berichte = within(blatt).getByLabelText('Berichte');
    // Die Pfeiltaste: der Browser wählt das nächste Radio (in jsdom ein Klick ohne Zeiger).
    fireEvent.keyDown(within(blatt).getByLabelText('Alle Themen'), { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.click(berichte);
    });
    await laden();
    expect(lesen).toHaveBeenLastCalledWith(expect.objectContaining({ gruppe: 'berichte' }));
    expect(screen.getByTestId('thema-blatt')).toBeTruthy();
    // Ein Antippen wählt und schließt.
    await act(async () => {
      fireEvent.pointerDown(within(blatt).getByLabelText('Alle Themen'));
      fireEvent.click(within(blatt).getByLabelText('Alle Themen'));
    });
    expect(screen.queryByTestId('thema-blatt')).toBeNull();
  });

  it('ein Fehler der CSV lässt das Verzeichnis stehen und versucht die CSV erneut (Review r1, P1-6)', async () => {
    const csv = vi.fn(async () => Promise.reject(new Error('weg')));
    Object.assign(api, { energiemanagementVerzeichnisCsv: csv });
    render(<VerzeichnisMonate onDokument={vi.fn()} onUeberblick={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    });
    const fehler = screen.getByTestId('verzeichnis-csv-fehler');
    expect(fehler.textContent).toContain('Die CSV-Datei ließ sich gerade nicht erstellen.');
    expect(screen.getAllByTestId('verzeichnis-eintrag').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(within(fehler).getByRole('button', { name: 'Erneut versuchen' }));
    });
    expect(csv).toHaveBeenCalledTimes(2);
  });
});

describe('Verzeichnis: der Kalender öffnet am Tag der Route (Review r1, P1-8)', () => {
  const original = { ...api };
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    Object.assign(api, original);
  });

  it('der Zeitraum beginnt im Monat des Abrufs, nicht im Monat des Browsers', async () => {
    const me = rechteSeed('IK').me;
    setSelbstauskunft(me);
    // Der Browser steht heute; die Route trägt die Bühne vom 12.02.2029.
    const b = energiemanagementBuehne('ahrenberg', { kennung: me.kennung!, name: me.name! }, () => JETZT);
    Object.assign(api, b.routen);
    await b.bereit;
    render(<VerzeichnisMonate onDokument={vi.fn()} onUeberblick={vi.fn()} />);
    await laden();
    fireEvent.click(screen.getByRole('button', { name: 'Zeitraum' }));
    fireEvent.click(within(screen.getByTestId('zeitraum-blatt')).getByLabelText('Von'));
    expect(screen.getByText('Februar 2029')).toBeTruthy();
  });
});

describe('Erklär-Blätter von Nachweisen', () => {
  it('jedes hält die Grenze von 45 Wörtern (§0.4), auch mit einem langen „Bei Ihnen“ der Referenzwelt', () => {
    const faelle = [
      { ...NACHWEIS, beiIhnen: 'Anwendungsbereich des Energiemanagements, Fassung 1 - entschieden von Robert Falk am 15.12.2026.' },
      { ...TEIL, beiIhnen: '18 Teile, zu vier ist noch nichts festgehalten: Kontext, Risiken und Chancen, Auslegung und Beschaffung.' },
      { ...VERZEICHNIS, beiIhnen: '77 Einträge seit dem 01.10.2026.' },
      TRIFFT_NICHT_ZU,
    ];
    for (const e of faelle) expect(erklaerWoerter(e), e.frage).toBeLessThanOrEqual(ERKLAER_WOERTER_HOECHSTENS);
  });
});
