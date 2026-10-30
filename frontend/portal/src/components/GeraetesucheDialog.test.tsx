import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ProbeAntwort } from '../api';
import type { Geraetesuche, GeraetesucheFehler } from '../geraetesuche';
import {
  GS_BOX_ID,
  GS_DEYE_HV,
  GS_GOE,
  GS_SHELLY,
  GS_SITE_ID,
  GS_SUCH_ID,
  GS_TEMPLATES,
  geraetesucheFaelle,
  gsDeye,
  gsKomponenten,
  gsShelly,
  gsVerlauf,
  gsWallboxZeile,
} from '../test/geraetesucheFixtures';
import { hashForRoute, pageRoute } from '../nav';
import { GeraetesucheDialog } from './GeraetesucheDialog';

const JETZT = Date.now();
const F = geraetesucheFaelle(JETZT);

function rendere(over: Partial<Parameters<typeof GeraetesucheDialog>[0]> = {}) {
  const props = {
    open: true,
    siteId: GS_SITE_ID,
    boxId: GS_BOX_ID,
    boxName: 'Seewiesen',
    zuletztGesehen: null,
    portalVerwaltet: true,
    komponenten: gsKomponenten.components,
    uebernommen: new Map<string, string>(),
    onClose: vi.fn(),
    onUebernehmen: vi.fn(),
    onSelbst: vi.fn(),
    onVonHand: vi.fn(),
    onAdresseGespeichert: vi.fn(),
    ...over,
  };
  const r = render(<GeraetesucheDialog {...props} />);
  return { props, r };
}

const starten = (s: Geraetesuche) => vi.spyOn(api, 'geraetesucheStarten').mockResolvedValue(structuredClone(s));
const fehler = (status: number, body: Partial<GeraetesucheFehler>) =>
  new ApiError(status, body.message ?? 'abgelehnt', { suchId: null, zuletztGesehen: null, wiederAb: null, message: '', ...body });

beforeEach(() => {
  vi.spyOn(api, 'componentTemplates').mockResolvedValue(GS_TEMPLATES);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GeraetesucheDialog · Suche läuft (m2/d2)', () => {
  it('startet die Suche mit einer Anfrage-Kennung und zeigt Schritt, Restzeit und erste Funde', async () => {
    const start = starten(F.laeuft);
    rendere();
    expect(await screen.findByRole('heading', { name: 'Suche im Heimnetz …' })).toBeInTheDocument();
    expect(start).toHaveBeenCalledWith(GS_SITE_ID, GS_BOX_ID, expect.stringMatching(/^portal-/));
    expect(screen.getByRole('dialog', { name: 'Geräte suchen' })).toBeInTheDocument();
    expect(screen.getByText('Noch etwa 15 Sekunden · Schritt 2 von 3 · Geräte ansprechen')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('progressbar', { name: 'Fortschritt der Suche' })).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByText('Shelly Pro 3')).toBeInTheDocument();
    expect(screen.getByText('Sie können das Fenster schließen – die Suche läuft weiter.')).toBeInTheDocument();
  });

  it('fragt alle 2 s ab, solange sie läuft, und hört nach dem Ergebnis auf', async () => {
    vi.useFakeTimers();
    starten(F.laeuft);
    const abfrage = vi.spyOn(api, 'geraetesuche')
      .mockResolvedValueOnce(structuredClone(F.laeuft))
      .mockResolvedValueOnce(structuredClone(F.fertig));
    rendere();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('heading', { name: 'Suche im Heimnetz …' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(abfrage).toHaveBeenCalledTimes(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(abfrage).toHaveBeenCalledTimes(1);
    expect(abfrage.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(abfrage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: '2 Geräte gefunden' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(abfrage).toHaveBeenCalledTimes(2);
  });

  it('„Abbrechen" schickt den Abbruch; die Funde bis dahin bleiben', async () => {
    starten(F.laeuft);
    const abbruch = vi.spyOn(api, 'geraetesucheAbbrechen').mockResolvedValue(structuredClone(F.abgebrochen));
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }));
    expect(abbruch).toHaveBeenCalledWith(GS_SITE_ID, GS_SUCH_ID);
    expect(await screen.findByText('Die Suche wurde abgebrochen. Was bis dahin gefunden war, steht unten.')).toBeInTheDocument();
    expect(screen.getByText('Shelly Pro 3')).toBeInTheDocument();
  });

  it('„Mitansehen": eine laufende Suche zeigen, ohne eine zweite zu starten', async () => {
    const start = vi.spyOn(api, 'geraetesucheStarten');
    const lesen = vi.spyOn(api, 'geraetesuche').mockResolvedValue(structuredClone(F.fremd));
    rendere({ suchId: GS_SUCH_ID });
    expect(await screen.findByText(/von Anna Weber \(VoltPilot-Service\)/)).toBeInTheDocument();
    expect(lesen).toHaveBeenCalledWith(GS_SITE_ID, GS_SUCH_ID);
    expect(start).not.toHaveBeenCalled();
  });

  it('Schließen lässt die Suche auf der Box weiterlaufen - kein Abbruch', async () => {
    starten(F.laeuft);
    const abbruch = vi.spyOn(api, 'geraetesucheAbbrechen');
    const { props } = rendere();
    await screen.findByRole('heading', { name: 'Suche im Heimnetz …' });
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(abbruch).not.toHaveBeenCalled();
  });
});

describe('GeraetesucheDialog · Ergebnis (m3/d3)', () => {
  it('Gruppen in fester Reihenfolge, die anklopfende Ladesäule gleich nach dem, was Hilfe braucht', async () => {
    starten(F.breit);
    rendere();
    await screen.findByTestId('gs-ergebnis');
    const titel = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(titel).toEqual([
      'Braucht Ihre Hilfe',
      'Ladesäule klopft an',
      'Bereit zum Übernehmen3',
      'Erkannt, mit dieser Box noch nicht anbindbar2',
      'Vielleicht ein Energie-Gerät',
    ]);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('3 neue Geräte, 1 Hinweis');
    // DP-3 A: Telefone und Rechner nur als Zahl.
    expect(screen.getByText('4 weitere Geräte')).toBeInTheDocument();
    expect(screen.getByText('Router, 2 Telefone oder Tablets, 1 Rechner')).toBeInTheDocument();
    expect(screen.getByText('Diese Box liest es noch nicht; andere VoltPilot-Boxen schon.')).toBeInTheDocument();
    expect(screen.getByText(/Passwortschutz ist an/)).toBeInTheDocument();
  });

  it('„Woran erkannt?" macht die Erkennung prüfbar', async () => {
    starten(F.fertig);
    rendere();
    await screen.findByTestId('gs-ergebnis');
    const zeile = document.querySelector(`[data-fund="${gsDeye.schluessel}"]`) as HTMLElement;
    const knopf = within(zeile).getByRole('button', { name: 'Woran erkannt?' });
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(knopf);
    expect(knopf).toHaveAttribute('aria-expanded', 'true');
    expect(within(zeile).getByText('Der Datenlogger nennt seine Seriennummer im Antwortkopf (Solarman V5).')).toBeVisible();
    expect(within(zeile).getByText('sicher erkannt')).toBeInTheDocument();
  });

  it('Shelly: die Zeile nennt den belegten Produktnamen, „Woran erkannt?" den Modellcode der Box', async () => {
    starten(F.fertig);
    rendere();
    await screen.findByTestId('gs-ergebnis');
    const zeile = document.querySelector(`[data-fund="${gsShelly.schluessel}"]`) as HTMLElement;
    expect(within(zeile).getByText('Shelly Pro 3')).toBeInTheDocument();
    fireEvent.click(within(zeile).getByRole('button', { name: 'Woran erkannt?' }));
    expect(within(zeile).getByText('Modellcode')).toBeVisible();
    expect(within(zeile).getByText('SPSW-003XE16EU')).toBeVisible();
  });

  it('go-e: ein Tipp übernimmt mit Vorlage und Anschluss aus der Suche', async () => {
    starten(F.breit);
    const { props } = rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'go-e Wallbox übernehmen' }));
    expect(props.onUebernehmen).toHaveBeenCalledWith({
      fund: expect.objectContaining({ schluessel: 'goe:204117' }),
      template: GS_GOE,
      verbindung: { ip: '192.168.178.52', port: 80 },
      kanal: null,
      schluessel: 'goe:204117',
    });
  });

  it('Deye: nur das Modell vom Typenschild wählen - die acht passenden, danach der Anlege-Fluss', async () => {
    starten(F.fertig);
    const { props } = rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Deye Hybrid-Wechselrichter übernehmen' }));
    expect(await screen.findByRole('heading', { name: 'Welches Modell steht auf dem Typenschild?' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Wechselrichter hinzufügen' })).toBeInTheDocument();
    expect(screen.getByText('8 Modelle passen. Die Leistung liest die Suche nicht aus.')).toBeInTheDocument();
    expect(screen.getByText('Seriennummer 2409066698 · 192.168.178.34')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /SUN-30K-SG01HP3-EU/ }));
    expect(props.onUebernehmen).toHaveBeenCalledWith(expect.objectContaining({
      template: GS_DEYE_HV[3],
      verbindung: { ip: '192.168.178.34', port: 8899, serial: '3115580613', unit_id: 1, mb_slave_id: 1 },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zur Liste' }));
    expect(await screen.findByRole('heading', { name: '2 Geräte gefunden' })).toBeInTheDocument();
  });

  it('Shelly: je Ausgang eine Komponente; ein übernommener Ausgang steht als übernommen', async () => {
    starten(F.fertig);
    const { props } = rendere({ uebernommen: new Map([[`${gsShelly.schluessel}#0`, 'Heizstab']]) });
    fireEvent.click(await screen.findByRole('button', { name: 'Shelly Pro 3 übernehmen' }));
    expect(await screen.findByRole('heading', { name: 'Welcher Ausgang steuert ein Gerät?' })).toBeInTheDocument();
    expect(screen.getByText('Heizstab')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ausgang 1/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ausgang 2/ }));
    expect(props.onUebernehmen).toHaveBeenCalledWith(expect.objectContaining({
      template: GS_SHELLY, kanal: 1, schluessel: `${gsShelly.schluessel}#1`,
      verbindung: { ip: '192.168.178.43', port: 80, channel: 1 },
    }));
  });

  it('nach dem Speichern: Bestätigung oben, das Übernommene wandert nach unten (m5c)', async () => {
    starten(F.fertig);
    rendere({ uebernommen: new Map([[gsDeye.schluessel, 'Wechselrichter']]), zuletzt: { titel: 'Wechselrichter', n: 1 } });
    expect(await screen.findByText(/„Wechselrichter“ ist angelegt\./)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Noch 1 Gerät');
    const uebernommen = screen.getByRole('region', { name: 'Übernommen' });
    expect(within(uebernommen).getByText('Wechselrichter')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deye Hybrid-Wechselrichter übernehmen' })).toBeNull();
  });

  it('nur wahrscheinlich erkannt: Übernehmen fragt erst nach', async () => {
    const wahrscheinlich = structuredClone(F.breit);
    const bereit = wahrscheinlich.gruppen.find((g) => g.gruppe === 'bereit')!;
    bereit.funde = bereit.funde.map((f) => (f.schluessel === 'goe:204117' ? { ...f, erkennung: 'wahrscheinlich' as const } : f));
    starten(wahrscheinlich);
    const { props } = rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'go-e Wallbox übernehmen' }));
    expect(props.onUebernehmen).not.toHaveBeenCalled();
    const frage = screen.getByRole('group', { name: 'Erkennung bestätigen' });
    expect(frage).toHaveTextContent('Ist es ein Wallbox?');
    fireEvent.click(within(frage).getByRole('button', { name: 'Ja, übernehmen' }));
    expect(props.onUebernehmen).toHaveBeenCalledTimes(1);
  });

  it('Geräte, die die Box pflegt: suchen ja, übernehmen nein - mit dem vorhandenen Satz', async () => {
    starten(F.fertig);
    rendere({ portalVerwaltet: false });
    expect(await screen.findByText('Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /übernehmen$/ })).toBeNull();
  });

  it('„Fertig" schließt, „Erneut suchen" startet mit neuer Kennung', async () => {
    const start = starten(F.fertig);
    const { props } = rendere();
    await screen.findByTestId('gs-ergebnis');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut suchen' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[0][2]).not.toBe(start.mock.calls[1][2]);
    fireEvent.click(await screen.findByRole('button', { name: 'Fertig' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe('GeraetesucheDialog · Adresse geändert (DP-7 A, m9)', () => {
  const bestanden: ProbeAntwort = { results: [{ ok: true, reading: { value: 11, unit: 'kW' } }] } as unknown as ProbeAntwort;

  it('ein Tipp: Test mit der neuen Adresse an DERSELBEN Komponente, dann eine neue Fassung', async () => {
    starten(F.hinweis);
    const test = vi.spyOn(api, 'testComponentConnection').mockResolvedValue(bestanden);
    const speichern = vi.spyOn(api, 'updateComponent').mockResolvedValue(gsKomponenten);
    const { props } = rendere();
    expect(await screen.findByText(/^Bisher 192\.168\.178\.51:80\. Gleiche Seriennummer/)).toBeInTheDocument();
    // Die Zeile nennt das eingerichtete Gerät beim Namen - es ist dasselbe.
    expect(screen.getByText('Wallbox Garage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Neue Adresse 192.168.178.52:80 für Wallbox Garage übernehmen' }));
    expect(await screen.findByText('Neue Adresse für „Wallbox Garage“ übernommen – dasselbe Gerät.')).toBeInTheDocument();
    expect(test).toHaveBeenCalledWith(GS_SITE_ID, expect.objectContaining({
      entityId: gsWallboxZeile.id, templateRef: GS_GOE.templateRef, connection: { ip: '192.168.178.52', port: 80 },
    }));
    expect(speichern).toHaveBeenCalledWith(GS_SITE_ID, gsWallboxZeile.id, expect.objectContaining({
      expectedRevision: 3, role: 'consumer', label: 'Wallbox Garage', connection: { ip: '192.168.178.52', port: 80 },
    }));
    expect(props.onAdresseGespeichert).toHaveBeenCalled();
  });

  it('ohne bestandenen Test wird nichts gespeichert - der Grund steht am Fund', async () => {
    starten(F.hinweis);
    vi.spyOn(api, 'testComponentConnection').mockResolvedValue({ errorCode: 'timeout', message: 'keine Antwort' } as unknown as ProbeAntwort);
    const speichern = vi.spyOn(api, 'updateComponent');
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: /Neue Adresse 192\.168\.178\.52:80/ }));
    expect(await screen.findByText(/^Nicht übernommen:/)).toBeInTheDocument();
    expect(speichern).not.toHaveBeenCalled();
  });

  it('schon eingerichtet steht mit dem Namen der Komponente', async () => {
    starten(F.hinweis);
    rendere();
    const region = await screen.findByRole('region', { name: 'Schon eingerichtet' });
    expect(within(region).getByText('Wechselrichter')).toBeInTheDocument();
    expect(within(region).getByText('eingerichtet')).toBeInTheDocument();
  });
});

describe('GeraetesucheDialog · OCPP „klopft an"', () => {
  it('„Zulassen" trägt die Kennung an DIESER Box ein', async () => {
    starten(F.breit);
    const zulassen = vi.spyOn(api, 'admitChargePoint').mockResolvedValue({} as never);
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Ladesäule CP-HOF-1 zulassen' }));
    expect(zulassen).toHaveBeenCalledWith(GS_SITE_ID, { chargePointId: 'CP-HOF-1', deviceId: GS_BOX_ID });
    expect(await screen.findByText(/Zugelassen\. Die Ladesäule darf sich/)).toBeInTheDocument();
  });
});

describe('GeraetesucheDialog · wenn es nicht geht', () => {
  it('nichts gefunden (m7): was gesehen wurde, wo gesucht wurde, zwei Wege weiter', async () => {
    starten(F.nichts);
    const { props } = rendere();
    expect(await screen.findByRole('heading', { name: 'Keine Energie-Geräte gefunden' })).toBeInTheDocument();
    expect(screen.getByText('3 andere Geräte im Heimnetz')).toBeInTheDocument();
    expect(screen.getByText(/Gesucht wurde in 192\.168\.178\.0\/24 und 192\.168\.2\.0\/24/)).toBeInTheDocument();
    expect(screen.getByText(/Diese Box sucht noch nicht nach: .*Fronius/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Von Hand hinzufügen' }));
    expect(props.onVonHand).toHaveBeenCalled();
  });

  it('Box offline (409): der Satz mit der letzten Meldung', async () => {
    vi.spyOn(api, 'geraetesucheStarten').mockRejectedValue(fehler(409, { code: 'box_offline', zuletztGesehen: '2026-11-02T07:40:00Z' }));
    rendere();
    expect(await screen.findByText(/Ihre Box meldet sich gerade nicht \(zuletzt 08:40\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut suchen' })).toBeInTheDocument();
  });

  it('Box zu alt (409 nicht_unterstuetzt): „Update nötig für: Gerätesuche" und „Update planen"', async () => {
    vi.spyOn(api, 'geraetesucheStarten').mockRejectedValue(fehler(409, { code: 'nicht_unterstuetzt' }));
    rendere();
    expect(await screen.findByText('Update nötig für: Gerätesuche')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Update planen/ })).toHaveAttribute('href', hashForRoute(pageRoute('edge-updates')));
    expect(screen.queryByRole('button', { name: 'Erneut suchen' })).toBeNull();
  });

  it('läuft schon (409 mit suchId): die laufende Suche mitansehen statt einer zweiten', async () => {
    vi.spyOn(api, 'geraetesucheStarten').mockRejectedValue(fehler(409, { code: 'laeuft_schon', suchId: GS_SUCH_ID }));
    const lesen = vi.spyOn(api, 'geraetesuche').mockResolvedValue(structuredClone(F.fremd));
    rendere();
    expect(await screen.findByRole('heading', { name: 'Suche im Heimnetz …' })).toBeInTheDocument();
    expect(lesen).toHaveBeenCalledWith(GS_SITE_ID, GS_SUCH_ID);
  });

  it('zu oft (429): wann es wieder geht', async () => {
    vi.spyOn(api, 'geraetesucheStarten').mockRejectedValue(fehler(429, { code: 'zu_oft', wiederAb: '2026-11-02T09:30:00Z' }));
    rendere();
    expect(await screen.findByText('Bitte einen Moment warten. Je Box sind 6 Suchen pro Stunde möglich. Ab 10:30 geht es wieder.')).toBeInTheDocument();
  });

  it('keine Antwort: die Box hat nicht zu Ende gemeldet, Funde bis dahin bleiben', async () => {
    starten(F.keineAntwort);
    rendere();
    expect(await screen.findByText('Ihre Box hat die Suche nicht zu Ende gemeldet. Was bis dahin gefunden war, steht unten.')).toBeInTheDocument();
    expect(screen.getByText('Shelly Pro 3')).toBeInTheDocument();
  });

  it('abgelehnt von der Box: der Grund in Worten', async () => {
    starten(F.abgelehnt);
    rendere();
    expect(await screen.findByText(/Ihre Box weiß nicht, in welchem Heimnetz sie steht/)).toBeInTheDocument();
  });
});

describe('GeraetesucheDialog · Verlauf (m10)', () => {
  it('„Letzte Suchen" zeigt den Verlauf der Box, gesucht wird erst auf Wunsch', async () => {
    const start = starten(F.laeuft);
    const verlauf = vi.spyOn(api, 'geraetesucheVerlauf').mockResolvedValue({ suchen: gsVerlauf(JETZT) });
    rendere({ start: 'verlauf' });
    expect(await screen.findByRole('heading', { name: 'Letzte Suchen' })).toBeInTheDocument();
    expect(verlauf).toHaveBeenCalledWith(GS_SITE_ID, GS_BOX_ID, expect.any(AbortSignal));
    expect(await screen.findByText('Anna Weber (VoltPilot-Service) · abgebrochen')).toBeInTheDocument();
    expect(screen.getByText(/ohne Namen und ohne MAC-Adresse/)).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Geräte suchen' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });
});
