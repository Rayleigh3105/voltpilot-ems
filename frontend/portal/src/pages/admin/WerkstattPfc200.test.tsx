import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { FEHLER_IM_BEREICH, Fehlergrenze } from '../../components/Fehlergrenze';
import { PRUEFUNGEN_PFC200, VERSAND_SATZ } from '../../werkstatt';
import type { LaufStand, WerkstattAnsicht, WerkstattDienst, WerkstattFreigabe, WerkstattFreigabePfc200, WerkstattRegel } from '../../werkstattBank';
import type { WerkstattRegelPfc200 } from '../../werkstattPfc200';

const werkstattBoxen = vi.fn();
const werkstattDienst = vi.fn();
const werkstattFreigaben = vi.fn();
const werkstattFreigabenPfc200 = vi.fn();
const werkstattRegel = vi.fn();
const werkstattRegelPfc200 = vi.fn();
const fernwartungBox = vi.fn();
const fernwartung = vi.fn();
const edgeUpdates = vi.fn();
const werkstattErstesVerbinden = vi.fn();
const werkstattFernlaufZeile = vi.fn();
const werkstattZurSeite = vi.fn();
const werkstattNochmal = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    werkstattBoxen: () => werkstattBoxen(),
    werkstattDienst: () => werkstattDienst(),
    werkstattFreigaben: () => werkstattFreigaben(),
    werkstattFreigabenPfc200: () => werkstattFreigabenPfc200(),
    werkstattRegel: () => werkstattRegel(),
    werkstattRegelPfc200: () => werkstattRegelPfc200(),
    fernwartungBox: (r: string) => fernwartungBox(r),
    fernwartung: () => fernwartung(),
    edgeUpdates: () => edgeUpdates(),
    werkstattErstesVerbinden: (r: string) => werkstattErstesVerbinden(r),
    werkstattFernlaufZeile: (r: string) => werkstattFernlaufZeile(r),
    werkstattZurSeite: (l: string) => werkstattZurSeite(l),
    werkstattNochmal: (l: string) => werkstattNochmal(l),
  },
}));

const { WerkstattPage } = await import('./WerkstattPage');

const contracts = resolve(__dirname, '../../../../../docs/contracts');
/** Die Ansicht in jedem Zustand eines Laufs am PFC200, erzeugt aus dem Dienst selbst (TestAnsichtZustaendePFC200). */
const zustaende: Record<string, WerkstattAnsicht> = JSON.parse(readFileSync(resolve(contracts, 'werkstatt-ansicht-v1.zustaende-pfc200.json'), 'utf8'));
/** Die Ansicht eines Dienstes, der nur Mangos einrichtet. */
const nurMango: WerkstattAnsicht = JSON.parse(readFileSync(resolve(contracts, 'werkstatt-ansicht-v1.example.json'), 'utf8'));
const SHA = '0123456789abcdef'.repeat(4);
const BOX = 'edge-k7m2xq3';
const AGE = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----';
const INDUSTRIE = { fassung: 'edge-industrie-2026.11.0', quelle: 'https://e.example/', programmSha256: '4'.repeat(64), skripteSha256: '5'.repeat(64), wartungSha256: '6'.repeat(64) };

const freigabe: WerkstattFreigabe = {
  id: 'f1', kennung: '2026-11-mango-1', boxArt: 'mango', gueltigAb: '2026-11-02T08:00:00Z', gueltigBis: '2026-11-30T08:00:00Z', obergrenze: 20,
  openwrt: { fassung: '25.12.5', datei: 'openwrt-25.12.5-x-sysupgrade.bin', sha256: SHA, quelle: 'https://o.example/' },
  edgeLight: { fassung: 'edge-light-2026.11.1', quelle: 'https://e.example/', programmSha256: SHA, skripteSha256: SHA },
  notiz: null, erteiltAm: '2026-11-02T08:00:00Z', erteiltVon: 'Regel: neueste Fassung', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null,
  quelle: 'regel', edgeReleaseSeq: 12,
};
const freigabePfc: WerkstattFreigabePfc200 = { ...freigabe, id: 'p1', kennung: '2026-11-pfc200-1', boxArt: 'pfc200', openwrt: null, edgeLight: INDUSTRIE, edgeReleaseSeq: 21 };
const regel: WerkstattRegel = {
  zustand: 'laeuft', grund: null, neueste: 'edge-light-2026.11.1', openwrt: freigabe.openwrt, edgeLight: freigabe.edgeLight, releaseSeq: 12,
  freigabe: '2026-11-mango-1', vonHand: false, heute: 2, tagesgrenze: 40, angehalten: null, verlauf: [],
};
const regelPfc: WerkstattRegelPfc200 = {
  zustand: 'laeuft', grund: null, neueste: INDUSTRIE.fassung, openwrt: null, edgeLight: INDUSTRIE, releaseSeq: 21, freigabe: '2026-11-pfc200-1', heute: 2, tagesgrenze: 40,
};

function ausZustand(name: string, ansicht: WerkstattAnsicht = zustaende[name]): WerkstattDienst {
  const s = ansicht.lauf as LaufStand | null | undefined;
  const laeufe = s
    ? [{ kennung: s.kennung, freigabe: s.freigabe, boxArt: s.box_art, zustand: s.zustand, schritt: s.schritt ?? null, titel: s.titel ?? null, grund: s.grund ?? null,
        beginn: s.beginn, ende: s.ende ?? null, aktualisiertAm: ansicht.zeit, stand: s }]
    : [];
  return { ansicht, gemeldetAm: new Date().toISOString(), dienstZeit: ansicht.zeit, alterSekunden: 2, aktuell: true, laeufe, zurSeite: [] };
}

/** Ein abgenommener PFC200 im Register, wie die API ihn nach einer Abnahme des Dienstes nennt. */
function pfcBox(over: Record<string, unknown> = {}) {
  return {
    id: BOX, edgeRef: BOX, boxArt: 'edge-industrie', lanNetz: '10.213.0.1/24', schritte: {}, notiz: null, angelegtAm: '2026-11-04T10:00:00Z',
    angelegtVon: 'Dienst', geaendertAm: '2026-11-04T10:40:00Z', kunde: null,
    abnahmen: [{
      id: 'a1', edgeRef: BOX, hostSchluessel: 'SHA256:' + 'Q'.repeat(43), fassung: INDUSTRIE.fassung, tunnelAdresse: '10.10.16.7', lanNetz: '10.213.0.1/24',
      pruefungen: PRUEFUNGEN_PFC200.map((p) => p.id), notiz: null, erfasstAm: '2026-11-04T10:40:00Z', erfasstVon: 'werkstatt-dienst',
      probe: { fensterId: 'p1', technikerName: 'Werkstatt-Dienst', grund: 'Werkstatt-Probe', beginn: '2026-11-04T10:30:00Z', ende: '2026-11-04T10:36:00Z',
        geschlossenAm: '2026-11-04T10:35:00Z', geschlossenVon: 'werkstatt-dienst', schluesselAbgeholtUm: null, gemeldetAm: null },
      quelle: 'dienst', belege: Object.fromEntries(PRUEFUNGEN_PFC200.map((p) => [p.id, `Schritt ${p.id}: belegt im Test`])),
      freigabeId: 'p1', einloesungId: 'e1', passwortAge: AGE, angaben: { artikel: '750-8212', firmware: '03.10.08(22)', seriennummer: 'SN-TEST-0001' },
    }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/werkstatt?werkbank=1';
  werkstattBoxen.mockResolvedValue([]);
  werkstattFreigaben.mockResolvedValue([freigabe]);
  werkstattFreigabenPfc200.mockResolvedValue([freigabePfc]);
  werkstattRegel.mockResolvedValue(regel);
  werkstattRegelPfc200.mockResolvedValue(regelPfc);
  werkstattDienst.mockResolvedValue(ausZustand('ohne_antwort'));
  fernwartungBox.mockRejectedValue(new ApiError(404, 'keine Box'));
  fernwartung.mockResolvedValue({ rueckmeldungen: [] });
  edgeUpdates.mockRejectedValue(new ApiError(503, 'nicht da'));
  werkstattErstesVerbinden.mockResolvedValue(undefined);
  werkstattFernlaufZeile.mockResolvedValue(undefined);
});
afterEach(cleanup);

/** An die Werkbank und den PFC200 wählen. */
async function waehlePfc200() {
  render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
  fireEvent.click(await screen.findByTestId('wsb-pfc200'));
  return screen.getByTestId('wsb');
}

describe('Werkstatt, PFC200: Start und Anschließen', () => {
  it('die Kachel „PFC200“ steht neben der Mango; ohne Dienst für PFC200 ist sie gesperrt und sagt warum', async () => {
    render(<WerkstattPage />);
    const kachel = await screen.findByTestId('wsb-pfc200');
    expect(kachel).toBeEnabled();
    expect(kachel).toHaveTextContent('PFC200');
    expect(kachel).toHaveTextContent('wird Edge Industrie');
    expect(screen.getByTestId('wsb-mango')).toBeEnabled();
    // Nur noch zwei Kacheln: Raspberry Pi gibt es nicht mehr.
    expect(screen.queryByTestId('wsb-pi')).toBeNull();
    cleanup();
    werkstattRegelPfc200.mockClear();
    werkstattFreigabenPfc200.mockClear();

    werkstattDienst.mockResolvedValue(ausZustand('nur-mango', { ...nurMango, lauf: null }));
    render(<WerkstattPage />);
    const gesperrt = await screen.findByTestId('wsb-pfc200');
    expect(gesperrt).toBeDisabled();
    expect(gesperrt).toHaveTextContent('der Dienst richtet hier keine PFC200 ein');
    // Eine Werkstatt nur mit Mangos fragt den Stand für den PFC200 gar nicht erst ab.
    expect(werkstattRegelPfc200).not.toHaveBeenCalled();
    expect(werkstattFreigabenPfc200).not.toHaveBeenCalled();
  });

  it('Anschließen: X2, Strom, und der Handgriff „feste Adresse“ steht immer da, in Text und Bild', async () => {
    const wsb = await waehlePfc200();
    expect(wsb).toHaveAttribute('data-bildschirm', 'anschliessen');
    expect(screen.getByRole('heading', { name: 'PFC200 anschließen' })).toBeInTheDocument();
    expect(wsb).toHaveTextContent('Das orange Kabel WERKSTATT in die Buchse X2. Die Buchse X1 bleibt leer.');
    expect(wsb).toHaveTextContent('Endklemme anstecken.');
    const handgriff = screen.getByTestId('wsb-feste-adresse');
    expect(handgriff).toHaveTextContent('Antwortet er nicht: feste Adresse geben');
    expect(handgriff).toHaveTextContent('Den Betriebsartenschalter auf STOP stellen.');
    expect(handgriff).toHaveTextContent('länger als 8 Sekunden gedrückt halten, bis die Leuchte SYS orange blinkt');
    expect(handgriff).toHaveTextContent('Den Betriebsartenschalter wieder auf RUN stellen.');
    expect(handgriff).toHaveTextContent('vorübergehend die Adresse 192.168.1.17');
    expect(handgriff).toHaveTextContent('Nach einem Neustart wäre die Adresse wieder weg');
    // Drei Zeichnungen: STOP, Reset gedrückt mit SYS orange, zurück auf RUN.
    const bild = within(handgriff).getByTestId('wsb-bild');
    expect(bild).toHaveAttribute('data-bild', 'pfc-adresse');
    const zeichnungen = [...bild.querySelectorAll('svg')];
    expect(zeichnungen.map((z) => z.getAttribute('data-schalter'))).toEqual(['stop', 'stop', 'run']);
    expect(zeichnungen[1]).toHaveAttribute('data-rst', 'ja');
    expect(zeichnungen[1]).toHaveAttribute('data-sys', 'orange');
    // Das Kabel steckt im Bild in X2.
    expect(wsb.querySelector('[data-bild="pfc-anschluss"] svg')).toHaveAttribute('data-kabel', 'x2');
    const warten = screen.getByTestId('wsb-warten');
    expect(warten).toHaveTextContent('PFC200 meldet sich unter seiner festen Adresse');
    expect(wsb.textContent).not.toMatch(/Mango|WAN|OpenWrt/);
    expect(screen.queryByRole('button', { name: /Weiter/ })).toBeNull();
  });

  it('wartet die Werkstatt für den PFC200, steht der Grund beim Anschließen', async () => {
    const grund = 'Die Fassung edge-industrie-2026.10.9 trägt Skriptstand und Tunnel-Programm nicht im signierten Manifest.';
    werkstattDienst.mockResolvedValue(ausZustand('ohne_antwort', { ...zustaende.ohne_antwort, freigabe_pfc200: { laufend: false, boxen: 0, grund, freigabe: null } }));
    await waehlePfc200();
    const hinweis = screen.getByTestId('wsb-nicht-freigegeben');
    expect(hinweis).toHaveTextContent('Die Werkstatt richtet gerade keinen PFC200 ein.');
    expect(hinweis).toHaveTextContent(grund);
    // Der Handgriff steht trotzdem da.
    expect(screen.getByTestId('wsb-feste-adresse')).toBeInTheDocument();
  });
});

describe('Werkstatt, PFC200: jeder Zustand des Dienstes', () => {
  const erwartet = (name: string): string =>
    name.startsWith('laeuft_') ? 'laeuft' : name === 'fertig' ? 'fertig' : name === 'ohne_antwort' ? 'anschliessen' : 'fall';
  const ABLAUF = Object.keys(zustaende).sort().map((n): [string, string] => [n, erwartet(n)]);

  it('die Datei trägt den Anschluss, jeden Schritt, die Handgriffe, die Fälle und fertig', () => {
    expect(ABLAUF.map(([n]) => n)).toEqual(expect.arrayContaining([
      'ohne_antwort', 'startet', 'laeuft_erkennen', 'laeuft_zugaenge', 'laeuft_netze', 'laeuft_uebergabe', 'wartet_schalter_run', 'wartet_kabel_x2',
      'wartet_schalter_run_nach_neustart', 'angehalten_pfc_passwort', 'angehalten_passwort_fremd', 'angehalten_pfc_docker_an',
      'angehalten_pfc_falsches_geraet', 'angehalten_pfc_schon_eingerichtet', 'angehalten_pfc_notfall_schluessel', 'angehalten_beim_neustart', 'fertig',
    ]));
  });

  it.each(ABLAUF)('An der Werkbank: %s zeichnet den Bildschirm %s und nennt nie die Mango', async (name, art) => {
    werkstattDienst.mockResolvedValue(ausZustand(name));
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wsb = await waehlePfc200();
    expect(screen.queryByText(FEHLER_IM_BEREICH)).toBeNull();
    expect(wsb).toHaveAttribute('data-bildschirm', art);
    // Kein Wort der Mango auf einer Seite des PFC200, und kein Schritt für SPS oder Firmware.
    expect(wsb.textContent).not.toMatch(/Mango|OpenWrt|Edge Light|Gehäuse drucken|Startlader/);
    expect(fehler).not.toHaveBeenCalled();
    fehler.mockRestore();
  });

  it('Läuft: „PFC200 wird eingerichtet“, sechs Phasen, Edge Industrie, keine erfundene Minutenzahl', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('laeuft_netze'));
    const wsb = await waehlePfc200();
    expect(screen.getByRole('heading', { name: 'PFC200 wird eingerichtet' })).toBeInTheDocument();
    expect(screen.getByTestId('wsb-restzeit')).toHaveTextContent('Wie lange es dauert, ist noch nicht gemessen');
    expect(screen.getByTestId('wsb-restzeit').textContent).not.toMatch(/\d+ Minute/);
    const schritte = screen.getByTestId('wsb-schritte');
    expect([...schritte.querySelectorAll('[data-phase]')].map((p) => p.getAttribute('data-phase')))
      .toEqual(['erkannt', 'absichern', 'software', 'anmelden', 'probe', 'abnahme']);
    expect(schritte.querySelector('[data-schritt="erkennen"]')).toHaveTextContent('WAGO 750-8212 · Firmware 03.10.08(22)');
    expect(schritte.querySelector('[data-schritt="netze"]')).toHaveAttribute('data-zustand', 'lauf');
    expect(schritte.querySelector('[data-schritt="sps"]')).toBeNull();
    const jetzt = screen.getByTestId('wsb-jetzt');
    expect(jetzt).toHaveTextContent('Schritt 10 von 14');
    expect(jetzt).toHaveTextContent('Netze trennen, Firewall einschalten');
    expect(jetzt).toHaveTextContent('X1 wird das Kundennetz, X2 das Anlagennetz');
    expect(jetzt.textContent).not.toMatch(/meist/);
    const sw = screen.getAllByTestId('wsb-software')[0];
    expect(sw).toHaveTextContent('Freigabe 2026-11-pfc200-1');
    expect(within(sw).getByTestId('wsb-soft-edge-industrie')).toHaveTextContent('Edge Industrie 2026.11.0');
    expect(within(sw).getByTestId('wsb-soft-firmware')).toHaveTextContent('bleibt, wie sie ist');
    expect(within(sw).getByTestId('wsb-soft-firmware')).toHaveTextContent('Die Werkstatt liest sie nur und prüft sie nicht.');
    expect(within(sw).queryByTestId('wsb-soft-openwrt')).toBeNull();
    expect(screen.getByTestId('wsb-box')).toHaveTextContent('192.168.1.17');
    expect(wsb).toHaveTextContent('Werkstatt › PFC200');
  });

  it('Schalter auf STOP: die Seite des Handgriffs mit Bild; der Lauf wartet und geht von selbst weiter', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('wartet_schalter_run'));
    const wsb = await waehlePfc200();
    expect(wsb).toHaveAttribute('data-fall', 'pfc_schalter_stop');
    expect(screen.getByTestId('wsb-fall-banner')).toHaveAttribute('data-art', 'hand');
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent('Der Betriebsartenschalter steht auf STOP.');
    expect(screen.getByTestId('wsb-loesung')).toHaveTextContent('Den Betriebsartenschalter wieder auf RUN stellen.');
    const bild = screen.getByTestId('wsb-bild');
    expect(bild).toHaveAttribute('data-bild', 'pfc-run');
    expect([...bild.querySelectorAll('svg')].map((z) => z.getAttribute('data-schalter'))).toEqual(['stop', 'run']);
    expect(screen.getByTestId('wsb-selbst')).toHaveAttribute('data-selbst', 'ja');
    expect(screen.getByTestId('wsb-live')).toHaveTextContent('Der Dienst sieht selbst nach, ob der Schalter auf RUN steht.');
    // Der Lauf arbeitet noch: kein „zur Seite legen“, kein „Nochmal“.
    expect(screen.queryByTestId('wsb-knoepfe')).toBeNull();
    expect(screen.getByTestId('wsb-schritte').querySelector('[data-schritt="erkennen"]')).toHaveAttribute('data-zustand', 'lauf');
  });

  it('Kabel in X1: das Bild zeigt erst X1, dann X2', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('wartet_kabel_x2'));
    await waehlePfc200();
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent('Das orange Kabel steckt nicht in der Buchse X2.');
    const bild = screen.getByTestId('wsb-bild');
    expect(bild).toHaveAttribute('data-bild', 'pfc-x2');
    expect([...bild.querySelectorAll('svg')].map((z) => z.getAttribute('data-kabel'))).toEqual(['x1', 'x2']);
  });

  it('Werksreset: nur für das halb eingerichtete Gerät dieser Werkstatt, mit Bild, danach die feste Adresse', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('angehalten_pfc_passwort'));
    const wsb = await waehlePfc200();
    expect(wsb).toHaveAttribute('data-fall', 'pfc_passwort');
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent('Dieser PFC200 ist nur halb eingerichtet.');
    expect(screen.getByTestId('wsb-fall-was')).toHaveTextContent('Nur darum nennt die Werkstatt hier den Werksreset');
    const bilder = screen.getAllByTestId('wsb-bild');
    expect(bilder.map((b) => b.getAttribute('data-bild'))).toEqual(['pfc-werksreset', 'pfc-adresse']);
    const reset = [...bilder[0].querySelectorAll('svg')];
    expect(reset.map((z) => z.getAttribute('data-schalter'))).toEqual(['run', 'reset', 'run']);
    expect(reset[1]).toHaveAttribute('data-rst', 'ja');
    expect(reset[2]).toHaveAttribute('data-sys', 'rotgruen');
    const loesung = screen.getByTestId('wsb-loesung');
    expect(loesung).toHaveTextContent('bis die Leuchte SYS abwechselnd rot und grün blinkt');
    expect(loesung).toHaveTextContent('Ein SPS-Programm auf dem Gerät ist damit gelöscht.');
    expect(loesung).toHaveTextContent('länger als 8 Sekunden');
    expect(screen.getByTestId('wsb-selbst')).toHaveAttribute('data-selbst', 'ja');
    expect(screen.getByTestId('wsb-knopf-zur-seite')).toBeInTheDocument();
  });

  it.each([
    ['angehalten_passwort_fremd', 'Dieser PFC200 gehört nicht zur Werkstatt.'],
    ['angehalten_pfc_schon_eingerichtet', 'Auf diesem PFC200 ist schon Edge Industrie.'],
    ['angehalten_pfc_falsches_geraet', 'Das ist kein PFC200 750-8212.'],
    ['angehalten_pfc_notfall_schluessel', 'Der Notfall-Schlüssel passt nicht zum PFC200.'],
  ])('%s: zur Seite, ohne Bild eines Resets; der Dienst fasst das Gerät nicht an', async (name, titel) => {
    werkstattDienst.mockResolvedValue(ausZustand(name));
    await waehlePfc200();
    expect(screen.getByTestId('wsb-fall-banner')).toHaveAttribute('data-art', 'seite');
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent(titel);
    expect(screen.queryByTestId('wsb-bild')).toBeNull();
    expect(screen.getByTestId('wsb-selbst')).toHaveAttribute('data-selbst', 'nein');
    // Die Schritte nennen den Werksreset nie als Handgriff (höchstens als das, was man nicht tut).
    expect(screen.getByTestId('wsb-loesung').textContent).not.toMatch(/Reset-Taster|Schalter auf RESET/);
  });

  it('Docker an: der Handgriff liegt in der Web-Oberfläche des Geräts; der Dienst beendet nichts', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('angehalten_pfc_docker_an'));
    await waehlePfc200();
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent('Auf diesem PFC200 läuft Docker.');
    expect(screen.getByTestId('wsb-fall-was')).toHaveTextContent('Fremde Container beendet der Dienst nicht');
    expect(screen.getByTestId('wsb-fall-banner')).toHaveAttribute('data-art', 'hand');
  });

  it('Fertig: Schild statt Gehäuse, und wo die drei Zugänge für CODESYS stehen; kein Passwort auf der Seite', async () => {
    werkstattDienst.mockResolvedValue(ausZustand('fertig'));
    const wsb = await waehlePfc200();
    expect(screen.getByTestId('wsb-fertig')).toHaveTextContent('Alle zehn Prüfungen bestanden');
    expect(screen.getByTestId('wsb-ref')).toHaveTextContent('EDGE-K7M2XQ3');
    expect(screen.getByTestId('wsb-qr')).toBeInTheDocument();
    expect(wsb).toHaveTextContent('Schild mit Referenz und QR-Code drucken');
    const codesys = screen.getByTestId('wsb-codesys');
    expect(codesys).toHaveTextContent('CODESYS und Zugänge');
    expect(within(codesys).getByTestId('wsb-codesys-zugaenge'))
      .toHaveTextContent('Die Passwörter von root, admin und user stehen nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“.');
    expect(within(codesys).getByTestId('wsb-codesys-zugaenge')).toHaveTextContent('Das Portal kann sie nicht lesen');
    expect(within(codesys).getByTestId('wsb-codesys-admin')).toHaveTextContent('brauchst du das Passwort von admin');
    expect(within(codesys).getByTestId('wsb-codesys-admin')).toHaveTextContent('Du entschlüsselst es selbst');
    expect(codesys).toHaveTextContent('CODESYS erreicht den PFC200 nur an der Buchse X2 (Anlagennetz)');
    expect(codesys).toHaveTextContent('Die Werkstatt hat kein SPS-Programm geladen');
    expect(wsb).toHaveTextContent(VERSAND_SATZ);
    expect(wsb.textContent).not.toContain('AGE ENCRYPTED');
    expect(within(screen.getAllByTestId('wsb-software')[0]).getByTestId('wsb-soft-edge-industrie')).toHaveTextContent('✓ update-bereit');
    // Zur Seite der Box, wo der verschlüsselte Text steht.
    fireEvent.click(screen.getByTestId('wsb-zur-box'));
    expect(window.location.hash).toBe(`#/werkstatt?box=${BOX}`);
  });
});

describe('Werkstatt, PFC200: Übersicht und Seite der Box', () => {
  beforeEach(() => {
    window.location.hash = '#/werkstatt';
    werkstattBoxen.mockResolvedValue([pfcBox()]);
  });

  it('die Karte „Werkstatt“ nennt für den PFC200 seine Fassung; unter „Details für Technik“ auch das Tunnel-Programm', async () => {
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-werkstatt-pfc200')).toHaveTextContent('PFC200: Edge Industrie 2026.11.0');
    expect(screen.getByTestId('ws-werkstatt-zeile')).toHaveTextContent('Edge Light 2026.11.1 · OpenWrt 25.12.5');
    const technik = screen.getByTestId('ws-werkstatt-pfc200-technik');
    expect(technik).toHaveTextContent('edge-industrie-2026.11.0 (Release 21)');
    expect(technik).toHaveTextContent('Tunnel-Programm 666666666666…');
    expect(technik).toHaveTextContent('Die Firmware des Geräts fasst die Werkstatt nicht an.');
    expect(screen.getByTestId('ws-freigaben-pfc200')).toHaveTextContent('2026-11-pfc200-1 · Regel · Edge Industrie 2026.11.0 · Release 21');
    expect(within(screen.getByTestId('ws-boxen')).getByText('PFC200')).toBeInTheDocument();
  });

  it('wartet die Werkstatt für den PFC200, steht da, worauf; die Mango läuft daneben weiter', async () => {
    const grund = 'Im Register liegt keine signierte Edge-Industrie-Fassung.';
    werkstattRegelPfc200.mockResolvedValue({ ...regelPfc, zustand: 'wartet', edgeLight: null, neueste: null, freigabe: null, releaseSeq: null, grund });
    render(<WerkstattPage />);
    const zeile = await screen.findByTestId('ws-werkstatt-pfc200');
    expect(zeile).toHaveAttribute('data-ton', 'warn');
    expect(zeile).toHaveTextContent(`PFC200 wartet: ${grund}`);
    expect(screen.getByTestId('ws-werkstatt')).toHaveAttribute('data-zustand', 'laeuft');
    expect(screen.getByTestId('ws-werkstatt-pfc200-technik')).toHaveTextContent('keine signierte Fassung');
  });

  it('eine API, die den PFC200 noch nicht kennt: keine Zeile, statt der Fassung der Mango', async () => {
    werkstattRegelPfc200.mockResolvedValue(null);
    werkstattFreigabenPfc200.mockResolvedValue([]);
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-werkstatt')).toBeInTheDocument();
    await waitFor(() => expect(werkstattRegelPfc200).toHaveBeenCalled());
    expect(screen.queryByTestId('ws-werkstatt-pfc200')).toBeNull();
    expect(screen.queryByTestId('ws-freigaben-pfc200')).toBeNull();
  });

  it('Seite der Box: Schild statt Druckdatei, Firmware nur gelesen, zwei Netze, zehn Prüfungen des PFC200, drei Zugänge verschlüsselt', async () => {
    window.location.hash = `#/werkstatt?box=${BOX}`;
    render(<WerkstattPage />);
    const seite = await screen.findByTestId('ws-detail');
    expect(seite).toHaveTextContent('PFC200');
    expect(screen.getByTestId('ws-stand')).toHaveTextContent('abgenommen');
    // Kein gedrucktes Gehäuse, kein Zubehör, keine Docker-Box.
    expect(screen.queryByTestId('ws-gehaeuse')).toBeNull();
    expect(screen.queryByTestId('ws-zubehoer')).toBeNull();
    expect(seite.textContent).not.toMatch(/Docker-Box|OpenWrt|Root-Passwort|Edge Light/);
    const schild = screen.getByTestId('ws-karte-schild');
    expect(schild).toHaveTextContent('Auf das Schild am Gerät kommen die Referenz in Klarschrift und ein QR-Code');
    expect(schild.querySelector('a[download]')).toHaveAttribute('download', `schild-${BOX}.svg`);
    expect(screen.getByTestId('ws-kunde')).toHaveTextContent('derselbe wie der QR-Code auf dem Schild');

    const codesys = screen.getByTestId('ws-codesys');
    expect(codesys).toHaveTextContent('nur verschlüsselt an der Abnahme, für den age-Schlüssel „Box-Passwörter“');
    expect(codesys).toHaveTextContent('brauchst du das Passwort von admin');
    expect(codesys).toHaveTextContent('Das Gerät hat dort die Adresse 10.213.0.1.');
    expect(codesys).toHaveTextContent('kein SPS-Programm geladen');

    expect(screen.getByTestId('ws-zeile-hardware')).toHaveTextContent('WAGO PFC200 750-8212 (Edge Industrie)');
    expect(screen.getByTestId('ws-zeile-edge-light')).toHaveTextContent('edge-industrie-2026.11.0');
    expect(screen.getByTestId('ws-zeile-firmware')).toHaveTextContent('03.10.08(22)');
    expect(screen.getByText('Firmware des Geräts (nur gelesen)')).toBeInTheDocument();
    expect(screen.getByTestId('ws-zeile-artikel')).toHaveTextContent('750-8212');
    expect(screen.getByTestId('ws-zeile-seriennummer')).toHaveTextContent('SN-TEST-0001');
    expect(screen.getByTestId('ws-zeile-pruefsummen')).toHaveTextContent('Programm 444444444444… · Skripte 555555555555… · Tunnel-Programm 666666666666…');
    expect(screen.getByTestId('ws-zeile-freigabe')).toHaveTextContent('2026-11-pfc200-1 · Regel, Release 21');
    expect(screen.getByTestId('ws-zeile-netz-x1')).toHaveTextContent('Adresse aus dem Netz des Kunden (DHCP)');
    expect(screen.getByTestId('ws-zeile-lan')).toHaveTextContent('10.213.0.1/24');
    expect(screen.getByText('Buchse X2 (Anlagennetz)')).toBeInTheDocument();
    expect(screen.queryByTestId('ws-zeile-openwrt')).toBeNull();

    const protokoll = screen.getByTestId('ws-abnahme-protokoll');
    expect(within(protokoll).getByTestId('ws-belege-aufklapp')).toHaveTextContent('10 Prüfungen mit Beleg');
    const belege = within(protokoll).getByTestId('ws-belege');
    expect(belege.querySelectorAll('li')).toHaveLength(10);
    expect(belege).toHaveTextContent('Buchsen getrennt: X1 Kundennetz, X2 Anlagennetz, keine Weiterleitung');
    expect(belege).toHaveTextContent('Drei eigene Passwörter gesetzt (root, admin, user)');
    expect(belege.textContent).not.toMatch(/kein Beleg|Einrichtungs-WLAN|LAN der Box/);
    expect(within(protokoll).getByTestId('ws-angaben')).toHaveTextContent('Bestellnummer 750-8212 · Firmware 03.10.08(22) · Seriennummer SN-TEST-0001');
    expect(within(protokoll).getByTestId('ws-angaben')).toHaveTextContent('Nur gelesen, keine Prüfung.');
    expect(within(protokoll).getByText('Zugänge (root, admin, user)')).toBeInTheDocument();
    const age = within(protokoll).getByTestId('ws-passwort-age');
    expect(age).toHaveTextContent('nur mit dem age-Schlüssel „Box-Passwörter“ lesbar');
    expect(age).toHaveTextContent('BEGIN AGE ENCRYPTED FILE');
    expect(within(age).getByTestId('ws-zugaenge-hinweis')).toHaveTextContent('age -d -i <Schlüssel „Box-Passwörter“>');
    expect(seite).toHaveTextContent(VERSAND_SATZ);
  });

  it('ohne Abnahme erfindet die Seite nichts: Firmware, Netze und Prüfsummen bleiben leer', async () => {
    werkstattBoxen.mockResolvedValue([pfcBox({ abnahmen: [], lanNetz: null })]);
    werkstattFreigabenPfc200.mockResolvedValue([]);
    window.location.hash = `#/werkstatt?box=${BOX}`;
    render(<WerkstattPage />);
    await screen.findByTestId('ws-detail');
    for (const id of ['firmware', 'artikel', 'seriennummer', 'pruefsummen', 'freigabe', 'netz-x1', 'lan', 'tunnel', 'host']) {
      expect(screen.getByTestId(`ws-zeile-${id}`), id).toHaveTextContent('–');
    }
    expect(screen.getByTestId('ws-zeile-hardware')).toHaveTextContent('WAGO PFC200 750-8212 (Edge Industrie)');
    expect(screen.getByTestId('ws-karte-schild')).toBeInTheDocument();
  });
});
