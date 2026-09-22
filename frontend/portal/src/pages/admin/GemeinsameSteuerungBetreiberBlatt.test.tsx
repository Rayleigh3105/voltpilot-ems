import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError, type Device } from '../../api';
import { keycloak } from '../../auth';
import { useGemeinsameSteuerung } from '../../components/GemeinsameSteuerungKarte';
import { setSelbstauskunft } from '../../rollen';
import { gsBetreiberZustand, gsBlatt, gsProbe } from '../../test/betreiberblattFixtures';
import { ahrenbergFunktionen } from '../../test/funktionenFixtures';
import { GS_IDS, gsBoxen, gsDatenquellen, gsEingerichtet } from '../../test/gemeinsameSteuerungFixtures';
import { rechteSeed } from '../../test/rollenFixtures';
import { FIXTURE_IDS } from '../../test/standorteFixtures';
import { GemeinsameSteuerungAbschnitt } from '../AnlageTechnik';

const JETZT = new Date('2027-06-15T11:40:00Z');
const kc = keycloak as unknown as { tokenParsed?: unknown };

function Technik({ boxen }: { boxen: Device[] }) {
  const daten = useGemeinsameSteuerung(FIXTURE_IDS.an1, boxen);
  return <GemeinsameSteuerungAbschnitt siteId={FIXTURE_IDS.an1} siteDevices={boxen} daten={daten} jetzt={JETZT} />;
}

function stelle(zustand: Parameters<typeof gsBetreiberZustand>[0], blatt: ReturnType<typeof gsBlatt>) {
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
  vi.spyOn(api, 'gemeinsameSteuerung').mockResolvedValue(gsBetreiberZustand(zustand));
  vi.spyOn(api, 'gemeinsameSteuerungEinrichten').mockResolvedValue(gsEingerichtet());
  vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: gsDatenquellen() });
  return vi.spyOn(api, 'gemeinsameSteuerungBlatt').mockResolvedValue(blatt);
}

const boxen = () => gsBoxen(JETZT).map((b) => ({ ...b, siteId: FIXTURE_IDS.an1 }));
const plattform = () => { kc.tokenParsed = { realm_access: { roles: ['platform-admin'] } }; };

beforeEach(() => setSelbstauskunft(rechteSeed('JW').me));
afterEach(() => {
  vi.restoreAllMocks();
  setSelbstauskunft(null);
  kc.tokenParsed = undefined;
});

async function blatt() {
  const b = await screen.findByTestId('betreiber-blatt', {}, { timeout: 3000 });
  await within(b).findByTestId('gsb-spalten', {}, { timeout: 3000 });
  return b;
}

describe('AP-15 IP-24 · Betreiber-Blatt — Sichtbarkeit', () => {
  it('ein Kundenkonto sieht das Blatt nie und liest die Admin-Route nie', async () => {
    const lesen = stelle('beobachtet', gsBlatt('s1', JETZT));
    render(<Technik boxen={boxen()} />);
    await screen.findByTestId('gemeinsame-steuerung');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('betreiber-blatt')).toBeNull();
    expect(lesen).not.toHaveBeenCalled();
    expect(screen.queryByText(/nachweis|Sprungprobe fehlt/)).toBeNull();
  });

  it('mit Plattform-Rolle unter der Kundenkarte: Kopf, fehlt (auch nachweis_fehlt), Spalten je Box', async () => {
    plattform();
    stelle('beobachtet', gsBlatt('s1', JETZT));
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    expect(within(b).getByTestId('gsb-kopf')).toHaveTextContent('S1 · beobachtet · Epoche 0');
    expect(within(b).getByTestId('gsb-fehlt')).toHaveTextContent('Sprungprobe fehlt an Box Verwaltung (T5)');
    const tabelle = within(b).getByTestId('gsb-spalten');
    const kopf = tabelle.querySelectorAll('thead th[data-box]');
    expect([...kopf].map((t) => t.getAttribute('data-box'))).toEqual([GS_IDS.e1, GS_IDS.e4]);
    const zelle = (zeile: string, box: string) => tabelle.querySelector(`tr[data-zeile="${zeile}"] td[data-box="${box}"]`)!;
    expect(zelle('waechter-einspeisung', GS_IDS.e4)).toHaveTextContent('nicht gemeldet');
    expect(zelle('waechter-einspeisung', GS_IDS.e4).className).toContain('vp-gsb-unbekannt');
    expect(zelle('messpunkt', GS_IDS.e4)).toHaveTextContent('nicht gemeldet');
    expect(zelle('wirksam-bezug', GS_IDS.e4)).toHaveTextContent('nicht gemeldet');
    expect(zelle('faehigkeit', GS_IDS.e4)).toHaveTextContent('fehlt');
    expect(zelle('geraete', GS_IDS.e1)).toHaveTextContent('Rückfall 40 kW (am Gerät hinterlegt)');
    expect(within(b).getByTestId('gsb-auslegung')).toHaveTextContent('passt.');
    expect(within(b).getByTestId('gsb-bilanz')).toHaveTextContent('Verbund-Bilanz plausibel');
  });

  it('plan_id und Revision ungleich sind sichtbar markiert', async () => {
    plattform();
    stelle('anteile_aktiv', gsBlatt('uebergang', JETZT));
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    await waitFor(() => expect(within(b).getByTestId('gsb-zweischritt')).toHaveAttribute('data-art', 'uebergang'));
    const q = b.querySelector(`tr[data-zeile="revision-quittiert"] td[data-box="${GS_IDS.e4}"]`)!;
    expect(q).toHaveAttribute('data-warnung', 'ja');
    expect(b.querySelector(`tr[data-zeile="revision-quittiert"] td[data-box="${GS_IDS.e1}"]`)).not.toHaveAttribute('data-warnung');
    expect(within(b).getByTestId('gsb-zweischritt')).toHaveTextContent('1 von 2 Boxen hat bestätigt · wartet auf Box Verwaltung');
    expect(b).not.toHaveTextContent('Zielstand steht');
  });

  it('zeigt jede Steckerprobe mit dem Grenz-Nachweis genau ihres Zeitraums', async () => {
    plattform();
    const daten = gsBlatt('s1', JETZT);
    daten.steckerproben = [{
      id: 'ab000000-0000-4000-8000-000000000001',
      von: '2026-10-21T10:00:00Z', bis: '2026-10-21T10:30:00Z', box_id: GS_IDS.e4,
      bemerkung: 'Kabel gezogen', eingetragen_am: '2026-10-21T10:35:00Z', grund: null,
      nachweis: {
        netzanschluss_id: 'na-1', kennzeichen: 'NA-1', monat: null, von: '2026-10-21', bis: '2026-10-21',
        zeitraum_von: '2026-10-21T12:00:00+02:00', zeitraum_bis: '2026-10-21T12:30:00+02:00',
        zeitzone: 'Europe/Berlin', grenze_geprueft: true, grund: null, urteil: 'eingehalten',
        richtungen: [{ richtung: 'einspeisung', grenze_geprueft: true, urteil: 'eingehalten',
          hoechstes_mittel: { von: '2026-10-21T12:00:00+02:00', bis: '2026-10-21T12:15:00+02:00',
            mittel_kw: 97.3, grenze_kw: 100, abstand_kw: -2.7 }, grenzherkunft: ['grenzblatt'], grenzhinweis: null }],
      },
    }];
    stelle('beobachtet', daten);
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    expect(within(b).getByTestId('gsb-steckerproben')).toHaveTextContent('Box Verwaltung');
    expect(within(b).getByTestId('gsb-steckerproben')).toHaveTextContent('höchstes Viertel 97,3 kW, Grenze 100 kW, hält');
  });
});

describe('AP-15 IP-24 · Betreiber-Blatt — Handgriffe', () => {
  it('Scharfschalten zeigt VOR dem Klick die I1-Liste; ein 409 steht an seiner Stelle', async () => {
    plattform();
    stelle('beobachtet', gsBlatt('s1', JETZT));
    const scharf = vi.spyOn(api, 'gemeinsameSteuerungBetreiber').mockRejectedValue(new ApiError(409, 'abgelehnt', {
      code: 'nachweis_fehlt', message: 'Nachweis fehlt.', fehlt: [{ wort: 'nachweis_fehlt', box_id: GS_IDS.e4 }],
    }));
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    const liste = within(b).getByTestId('gsb-i1');
    expect(liste.querySelector(`[data-punkt="sprungprobe:${GS_IDS.e4}"]`)).toHaveAttribute('data-stand', 'offen');
    expect(liste.querySelector('[data-punkt="auslegung"]')).toHaveAttribute('data-stand', 'erfuellt');
    fireEvent.click(within(b).getByRole('button', { name: 'Scharfschalten' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('gsb-i1-dialog')).toHaveTextContent('Sprungprobe bestanden an Box');
    expect(dialog).toHaveTextContent('erst nach ihrer Quittung');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scharfschalten' }));
    await waitFor(() => expect(scharf).toHaveBeenCalledWith(FIXTURE_IDS.an1, 'scharfschalten'));
    expect(await within(b).findByTestId('gsb-abgelehnt')).toHaveTextContent('Sprungprobe fehlt an Box Verwaltung');
    const punkt = within(b).getByTestId('gsb-i1').querySelector(`[data-punkt="sprungprobe:${GS_IDS.e4}"]`)!;
    expect(punkt).toHaveTextContent('Sprungprobe fehlt an Box Verwaltung (T5)');
  });

  it('Sprungprobe: Knopf an der Box, die sie meldet; Grund statt Knopf an der anderen; Sprung ≤ 50 kW', async () => {
    plattform();
    const lesen = stelle('beobachtet', gsBlatt('s1', JETZT));
    const probe = vi.spyOn(api, 'gemeinsameSteuerungSprungprobe').mockResolvedValue(gsProbe(GS_IDS.e1, JETZT, 'ausgeloest').probe);
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    expect(within(b).getByTestId('gsb-sprung-grund')).toHaveTextContent('Box Verwaltung meldet die Fähigkeit sprungprobe nicht.');
    expect(within(b).getAllByRole('button', { name: 'Sprungprobe auslösen' })).toHaveLength(1);
    lesen.mockResolvedValue(gsBlatt('s1', JETZT, [gsProbe(GS_IDS.e1, JETZT, 'ausgeloest')]));
    fireEvent.click(within(b).getByRole('button', { name: 'Sprungprobe auslösen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Sprung \(kW/), { target: { value: '51' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sprungprobe auslösen' }));
    expect(await within(dialog).findByText('Höchstens 50 kW.')).toBeInTheDocument();
    expect(probe).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Sprung \(kW/), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sprungprobe auslösen' }));
    await waitFor(() => expect(probe).toHaveBeenCalledWith(FIXTURE_IDS.an1, { box_id: GS_IDS.e1, art: 'erzeugung_senken', sprung_kw: 30 }));
    expect(await within(b).findByTestId('gsb-protokoll')).toHaveTextContent('ausgelöst — Bericht steht aus');
  });

  it('als Betreiber anhalten und fortsetzen; Mitglied bestätigen nach dem Box-Tausch', async () => {
    plattform();
    stelle('anteile_aktiv', gsBlatt('aktiv', JETZT));
    const zustand = gsBetreiberZustand('anteile_aktiv');
    zustand.mitglieder![1] = { ...zustand.mitglieder![1], bestaetigt_am: null };
    vi.spyOn(api, 'gemeinsameSteuerung').mockResolvedValue(zustand);
    const halt = vi.spyOn(api, 'gemeinsameSteuerungSchritt').mockResolvedValue(gsBetreiberZustand('angehalten_betreiber'));
    const bestaetigen = vi.spyOn(api, 'gemeinsameSteuerungBestaetigen').mockResolvedValue(zustand);
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    fireEvent.click(await within(b).findByRole('button', { name: 'Mitglied bestätigen' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(bestaetigen).toHaveBeenCalledWith(FIXTURE_IDS.an1, GS_IDS.e4));
    fireEvent.click(within(b).getByRole('button', { name: 'Als Betreiber anhalten' }));
    const d = await screen.findByRole('dialog');
    expect(d).toHaveTextContent('Die Anteile bleiben in Kraft');
    fireEvent.click(within(d).getByRole('button', { name: 'Anhalten' }));
    await waitFor(() => expect(halt).toHaveBeenCalledWith(FIXTURE_IDS.an1, 'anhalten'));
  });

  it('vom Betreiber angehalten: Kopf sagt es, fortsetzen nur hier', async () => {
    plattform();
    stelle('angehalten_betreiber', gsBlatt('aktiv', JETZT));
    const fort = vi.spyOn(api, 'gemeinsameSteuerungBetreiber').mockResolvedValue(gsBetreiberZustand('anteile_aktiv'));
    render(<Technik boxen={boxen()} />);
    const b = await blatt();
    expect(within(b).getByTestId('gsb-kopf')).toHaveTextContent('angehalten · vom Betreiber angehalten');
    fireEvent.click(within(b).getByRole('button', { name: 'Als Betreiber fortsetzen' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Fortsetzen' }));
    await waitFor(() => expect(fort).toHaveBeenCalledWith(FIXTURE_IDS.an1, 'fortsetzen'));
  });
});
