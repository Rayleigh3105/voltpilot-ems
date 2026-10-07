import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstellenRegister, type MessstellenRegisterAnfrage } from '../api';
import { OHNE_ANGABE, type MessstellenEbene } from '../messstellen';
import { KOPF_SATZ, NOCH_KEINE_QUELLE, SUCHE_WORIN } from '../messstellenListe';
import { messstelleAngelegt, VORSCHLAG } from '../test/messstelleDialogFixtures';
import { ahrenbergRegister, leeresRegister, REGISTER_ORT_IDS } from '../test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
import { MessstellenPage } from './MessstellenPage';

/**
 * Die Liste „Messstellen“ (Konzept Messen m1, §6.2/§6.3/§6.11) gegen die gestellte Route `GET /api/v1/messstellen`
 * (Referenzunternehmen, heute = 20.10.2026): Kopf mit erklärendem Satz und Menü ⋯, Statuszeile mit dem Satz des
 * Servers, die EINE Suche (in der Adresse), Marken, die nur erscheinen, wenn es sie gibt, Gruppen je Ort mit Reihen als
 * Verweis, „Woher die Werte kommen“, „Stand an einem Tag ansehen“ und die Leerzustände.
 */

const UNTERNEHMEN: MessstellenEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' };
const WERK: MessstellenEbene = { art: 'standort', id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg' };
const WARTEN = { timeout: 3000 };
const MS06 = '3e000000-0000-4000-8000-000000000006';

function verdrahte(antwort: (a: MessstellenRegisterAnfrage) => MessstellenRegister = ahrenbergRegister) {
  return vi.spyOn(api, 'messstellenRegister').mockImplementation(async (a = {}) => antwort(a));
}

function telefon(ja: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: ja,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '#/portfolio/messstellen');
  // Die Ausfälle der Standorte sind ein eigener Lesezug; ohne Antwort zeigt die Liste keinen.
  vi.spyOn(api, 'standortAusfall').mockRejectedValue(new Error('nicht gestellt'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reihen = () => screen.getAllByTestId('messstelle-reihe');
const reiheVon = (kz: string) => reihen().find((r) => within(r).queryByText(kz, { exact: true }))!;
const orte = () => screen.getAllByTestId('messstellen-ort').map((s) => within(s).getByRole('heading', { level: 2 }).textContent);
const suchfeld = () => screen.getByRole('searchbox', { name: 'Messstellen suchen' });

async function menue(eintrag: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: eintrag }));
}

/** Wählt im offenen Kalender von „Stand am“ einen Tag (wie `StandortePageStandAm.test.tsx`). */
async function waehleTag(iso: string) {
  const feld = await screen.findByRole('combobox', { name: 'Stand am' });
  if (!document.querySelector('.vp-kal-tag')) fireEvent.click(feld);
  const [t, m, j] = (feld.textContent ?? '').match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  for (let i = 0; i < 24; i++) {
    const tag = document.querySelector<HTMLButtonElement>(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
    if (tag) {
      fireEvent.click(tag);
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: richtung }));
  }
  throw new Error(`Tag ${iso} nicht erreicht`);
}

describe('Messstellen · Kopf, Statuszeile und Gruppen je Ort', () => {
  it('am Rechner: Titel mit erklärendem Satz, „Messstelle anlegen“ als Knopf, Seltenes im Menü ⋯', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Messstellen');
    expect(screen.getByText(KOPF_SATZ)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Messstelle anlegen' })).toBeInTheDocument();
    // „Summenwert anlegen“ gibt es unter Messen nicht mehr (Konzept §6.10).
    expect(screen.queryByRole('button', { name: /Summenwert/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    const eintraege = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(eintraege).toEqual(['Stand an einem Tag ansehenNur lesen, z. B. für eine Prüfung']);
    // EINE Abfrage ohne Filter.
    expect(register).toHaveBeenCalledTimes(1);
    // Messen PR5: die Liste fragt den letzten Monat mit - nur sie zeigt ihn.
    expect(register).toHaveBeenCalledWith({ letzterMonat: true });
  });

  it('am Telefon steht „Messstelle anlegen“ im Menü, nicht als Knopf im Kopf', async () => {
    telefon(true);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    expect(screen.queryByRole('button', { name: 'Messstelle anlegen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual([
      'Messstelle anlegen',
      'Stand an einem Tag ansehenNur lesen, z. B. für eine Prüfung',
    ]);
  });

  it('die Statuszeile ist der Satz des Servers; die Reihen stehen je Ort in der Reihenfolge des Ortsbaums', async () => {
    telefon(false);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    // Eine Messstelle ohne Quelle liefert nicht - aber nichts davon ist überfällig: ein ruhiger Hinweis ohne Schritt.
    expect(screen.getByText('21 von 22 Messstellen liefern Daten')).toBeInTheDocument();
    expect(orte()).toEqual([
      'Unternehmen',
      'Werk Ahrenberg',
      'Halle 1',
      'Halle 1 Nord',
      'Halle 1 Süd',
      'Halle 2',
      'Halle 2 Montage',
      'Halle 2 Spritzguss',
      'Halle 2 Lager',
      'Verwaltung',
      'Werk Lindach',
      'Lagerhalle Lindach',
      'Montagehalle Lindach',
      'Kein Ort zugeordnet',
    ]);
    expect(reihen()).toHaveLength(22);
    expect(screen.getByText('22 Messstellen an 14 Orten')).toBeInTheDocument();
    // Im Ort der Hauptzähler zuerst; über einem Gebäude steht sein Standort.
    const werk = screen.getAllByTestId('messstellen-ort')[1];
    expect(within(werk).getAllByTestId('messstelle-reihe').map((r) => r.textContent?.match(/MS-\d+/)?.[0])).toEqual([
      'MS-01',
      'MS-02',
      'MS-14',
    ]);
    expect(within(screen.getAllByTestId('messstellen-ort')[2]).getByText('Werk Ahrenberg · 2')).toBeInTheDocument();
  });

  it('Messen PR5: rechts der Verbrauch des letzten Monats, am Rechner unter dem Kopf „September 2026“', async () => {
    telefon(false);
    // Die Antwort mit `letzterMonat=true`: jede Zeile trägt den Monat (hier der Schritt von HZ-1 aus der echten Antwort).
    const echt = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures/register-letzter-monat-2026-09.json'), 'utf8')) as {
      register: MessstellenRegister['register'];
    };
    const monat = echt.register.find((z) => z.kennzeichen === 'HZ-1')!.letzter_monat;
    verdrahte(() => {
      const r = ahrenbergRegister();
      return { ...r, register: r.register.map((z) => (z.kennzeichen === 'MS-06' ? { ...z, letzter_monat: monat } : z)) };
    });
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    expect(document.querySelector('.vp-ms-spalten')).toHaveTextContent('September 2026');
    const ms06 = reiheVon('MS-06');
    expect(ms06.textContent).toContain('199.500');
    expect(ms06).toHaveTextContent('Sep 2026');
  });

  it('jede Reihe ist der Verweis auf ihre Messstelle; „Woher die Werte kommen“ sagt Gerät oder noch keine Quelle', async () => {
    telefon(false);
    verdrahte();
    const onOeffnen = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa onOeffnen={onOeffnen} />);
    await screen.findAllByTestId('messstelle-reihe');
    const ms06 = reiheVon('MS-06');
    expect(ms06.tagName).toBe('A');
    expect(ms06).toHaveAttribute('href', `#/portfolio/messstellen/${MS06}`);
    expect(ms06).toHaveTextContent('Unterzähler von MS-01 in Halle 1 · Strom');
    expect(ms06).toHaveTextContent('Liefert Daten');
    expect(ms06).toHaveTextContent('automatisch vom Gerät');
    expect(ms06).toHaveTextContent('Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug');
    fireEvent.click(ms06);
    expect(onOeffnen).toHaveBeenCalledWith(MS06, null);
    // Mit Strg/⌘ bleibt es ein gewöhnlicher Verweis (neuer Tab), die Seite öffnet nicht selbst.
    fireEvent.click(ms06, { ctrlKey: true });
    expect(onOeffnen).toHaveBeenCalledTimes(1);
    const ms21 = reiheVon('MS-21');
    expect(ms21).toHaveTextContent(NOCH_KEINE_QUELLE);
    expect(ms21).toHaveTextContent('noch keine Quelle');
    // Fehlt ein Wert, steht der Strich - nie eine 0.
    expect(within(ms21).getByText(OHNE_ANGABE)).toBeInTheDocument();
  });

  it('eine Ablesestelle: „von Hand abgelesen, monatlich“; fehlt die Ablesung, eine Hinweiskarte mit „Ablesen“ und das Ziel der Wiedervorlage', async () => {
    const mitAblesung = (a: MessstellenRegisterAnfrage) => {
      const r = ahrenbergRegister(a);
      const z = r.register.find((x) => x.kennzeichen === 'MS-21')!;
      z.quelle = {
        stand: 'ablesung',
        fuehrend: null,
        davor: null,
        vergleichsquellen: 0,
        ablesung: { seit: '2024-10-01T00:00:00+02:00', zuletzt: '2026-08-01T00:00:00+02:00' },
      };
      z.lebenszyklus = 'aktiv';
      z.beobachtung = { ...z.beobachtung!, zustand: 'liefert_nicht_seit', seit: '2026-10-01T00:00:00+02:00', text: 'Ablesung überfällig seit 01.10.2026' };
      return r;
    };
    telefon(false);
    verdrahte(mitAblesung);
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    const ms21 = reiheVon('MS-21');
    expect(ms21).toHaveTextContent('von Hand abgelesen, monatlich');
    expect(ms21).toHaveTextContent('Ablesung überfällig seit 01.10.2026');
    expect(ms21).toHaveAttribute('data-entscheid', 'zaehlerablesung');
    expect([...document.querySelectorAll('[data-entscheid="zaehlerablesung"]')]).toHaveLength(1);
    // Handlungsbedarf: die Hinweiskarte tritt an die Stelle der ruhigen Zeile und filtert auf ihre Marke.
    const karte = screen.getByRole('button', { name: /Gas Heizung Verwaltung \(MS-21\) ist die Ablesung überfällig/ });
    expect(karte).toHaveTextContent('Seit 01.10.2026 · Verwaltung');
    expect(karte).toHaveTextContent('Ablesen');
    fireEvent.click(karte);
    await waitFor(() => expect(reihen()).toHaveLength(1));
    expect(screen.getByRole('button', { name: '1 Ablesung überfällig' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Messstellen · Wörter, wie sie gerendert stehen (Review r4 S6)', () => {
  // Die Wächter in `copy.test.ts` lesen den Quelltext; die Wörter kommen aber oft über Konstanten anderer Module. Hier
  // zählt, was tatsächlich auf dem Schirm steht - mit offenem Menü, am Rechner und am Telefon.
  const VERBOTEN = /Quelle \(führend\)|Keine Datenquelle|Summenwert|Elektrische Stellung/;

  it.each([false, true])('Telefon %s: kein Datenmodell-Wort in der Liste und im Menü ⋯', async (ja) => {
    telefon(ja);
    verdrahte();
    render(<MessstellenPage ebene={WERK} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    await screen.findAllByRole('menuitem');
    expect(document.body.textContent).not.toMatch(VERBOTEN);
  });
});

describe('Messstellen · die EINE Suche', () => {
  it('sucht sofort und tolerant in Name, Kennzeichen, Ort und Gerät; die Fundstelle ist markiert, die Suche steht in der Adresse', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    fireEvent.change(suchfeld(), { target: { value: 'druck' } });
    expect(reihen()).toHaveLength(1);
    expect(reihen()[0]).toHaveTextContent('Druckluft Kompressoren K1+K2');
    expect(reihen()[0].querySelector('mark')?.textContent).toBe('Druck');
    expect(screen.getByText('1 von 22 Messstellen')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/portfolio/messstellen?suche=druck');
    // Gesucht wird in der geladenen Antwort - keine Anfrage je Taste.
    expect(register).toHaveBeenCalledTimes(1);

    // „ms 06“ findet MS-06 über das Kennzeichen (wie „az 3“ den Aufkleber AZ-3), „Z-5a“ über das Gerät der Quelle.
    fireEvent.change(suchfeld(), { target: { value: 'ms 06' } });
    expect(reihen().map((r) => r.textContent?.match(/MS-\d+/)?.[0])).toEqual(['MS-06']);
    fireEvent.change(suchfeld(), { target: { value: 'z-5a' } });
    expect(reihen().map((r) => r.textContent?.match(/MS-\d+/)?.[0])).toEqual(['MS-06']);
    // „halle 2“ sucht „Halle 2“ - nie „Halle“ und irgendeine 2.
    fireEvent.change(suchfeld(), { target: { value: 'halle 2' } });
    expect(new Set(screen.getAllByTestId('messstellen-ort').map((s) => s.querySelector('h2')?.textContent))).not.toContain('Halle 1');

    // Escape leert die Suche.
    fireEvent.keyDown(suchfeld(), { key: 'Escape' });
    expect(suchfeld()).toHaveValue('');
    expect(reihen()).toHaveLength(22);
    expect(window.location.hash).toBe('#/portfolio/messstellen');
  });

  it('kein Treffer: der Begriff, worin gesucht wird, und „Suche leeren“', async () => {
    telefon(false);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    fireEvent.change(suchfeld(), { target: { value: 'Wärmepumpe ' } });
    expect(await screen.findByText('Keine Messstelle passt zu „Wärmepumpe“.')).toBeInTheDocument();
    expect(screen.getByText(SUCHE_WORIN)).toBeInTheDocument();
    expect(screen.queryAllByTestId('messstelle-reihe')).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('messstellen-kein-treffer')).getByRole('button', { name: 'Suche leeren' }));
    expect(reihen()).toHaveLength(22);
  });

  it('die Suche aus der Adresse steht beim Öffnen schon da (Rückweg von einer Messstelle)', async () => {
    window.history.replaceState(null, '', '#/portfolio/messstellen?suche=lindach');
    telefon(false);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    expect(suchfeld()).toHaveValue('lindach');
    expect(reihen().map((r) => r.textContent?.match(/MS-\d+/)?.[0])).toEqual(['MS-16', 'MS-17', 'MS-18', 'MS-22']);
  });
});

describe('Messstellen · Marken und Filter der Adresse', () => {
  it('Marken erscheinen nur, wenn es sie gibt, und filtern; noch einmal getippt ist alles wieder da', async () => {
    telefon(false);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    const marken = within(screen.getByRole('group', { name: 'Nur diese zeigen' }));
    expect(marken.getAllByRole('button').map((b) => b.textContent)).toEqual(['1 ohne Quelle']);
    fireEvent.click(marken.getByRole('button', { name: '1 ohne Quelle' }));
    expect(reihen()).toHaveLength(1);
    expect(reihen()[0]).toHaveTextContent('MS-21');
    expect(marken.getByRole('button', { name: '1 ohne Quelle' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 von 22 Messstellen')).toBeInTheDocument();
    // Die Marke steht in der Adresse - der Rückweg von einer Messstelle findet sie wieder (Konzept §6.4).
    expect(window.location.hash).toBe('#/portfolio/messstellen?marke=ohneQuelle');
    fireEvent.click(marken.getByRole('button', { name: '1 ohne Quelle' }));
    expect(reihen()).toHaveLength(22);
    expect(window.location.hash).toBe('#/portfolio/messstellen');
  });

  it('Rückweg: Marke und Stichtag aus der Adresse stehen beim Öffnen schon da (Review r4 S2)', async () => {
    window.history.replaceState(null, '', '#/portfolio/messstellen?marke=ohneQuelle&stand=2026-10-10');
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await waitFor(() => expect(register).toHaveBeenCalledWith({ stichtag: '2026-10-10', letzterMonat: true }), WARTEN);
    await waitFor(() => expect(screen.getByTestId('stand-am')).toHaveTextContent('Stand 10.10.2026'), WARTEN);
    await waitFor(() => expect(reihen()).toHaveLength(1), WARTEN);
    expect(screen.getByRole('button', { name: '1 ohne Quelle' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu heute' }));
    await waitFor(() => expect(screen.queryByTestId('stand-am')).toBeNull(), WARTEN);
    expect(window.location.hash).toBe('#/portfolio/messstellen?marke=ohneQuelle');
  });

  it('`?ort=G-1`: wird das Kurzzeichen zur ID des Orts, bleiben die Reihen stehen - kein zweites Skelett', async () => {
    window.history.replaceState(null, '', '#/portfolio/messstellen?ort=G-1');
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    const erste = reihen()[0];
    await waitFor(() => expect(register).toHaveBeenCalledWith({ ort: REGISTER_ORT_IDS['G-1'], letzterMonat: true }), WARTEN);
    await waitFor(() => expect(register.mock.results.every((r) => r.type === 'return')).toBe(true));
    expect(screen.queryByTestId('messstellen-laedt')).toBeNull();
    // Dieselbe Reihe, dasselbe Element: der Blick der Wiedervorlage bliebe auf ihr.
    expect(reihen()[0]).toBe(erste);
  });

  it('`?ort=` aus der Wiedervorlage fragt dieselbe Route mit dem Ort; die Marke „×“ nimmt ihn heraus', async () => {
    window.history.replaceState(null, '', '#/portfolio/messstellen?ort=G-1');
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await waitFor(() => expect(register).toHaveBeenCalledWith({ ort: REGISTER_ORT_IDS['G-1'], letzterMonat: true }), WARTEN);
    const marke = await screen.findByRole('button', { name: 'Halle 1 – Filter entfernen' });
    fireEvent.click(marke);
    await waitFor(() => expect(reihen()).toHaveLength(22), WARTEN);
    expect(window.location.hash).toBe('#/portfolio/messstellen');
  });
});

describe('Messstellen · Filter `?anlage=` ohne Messstelle (Review r4 S9)', () => {
  const ANLAGE = '9f2c0000-0000-4000-8000-0000000000aa';
  const ohneTreffer = (a: MessstellenRegisterAnfrage) => (a.anlage ? leeresRegister() : ahrenbergRegister());

  it('der Name der Anlage kommt aus der Liste der Anlagen - nie die Kennung', async () => {
    window.history.replaceState(null, '', `#/portfolio/messstellen?anlage=${ANLAGE}`);
    telefon(false);
    verdrahte(ohneTreffer);
    vi.spyOn(api, 'listSites').mockResolvedValue({
      eintraege: [{ id: ANLAGE, name: 'Halle 3 Dach' } as Awaited<ReturnType<typeof api.listSites>>['eintraege'][number]],
      teilansicht: { sichtbar: 1, gesamt: 1 },
    });
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    expect(await screen.findByText('An der Anlage Halle 3 Dach hängt keine Messstelle.', {}, WARTEN)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ANLAGE);
  });

  it('ohne Antwort heißt sie „diese Anlage“', async () => {
    window.history.replaceState(null, '', `#/portfolio/messstellen?anlage=${ANLAGE}`);
    telefon(false);
    verdrahte(ohneTreffer);
    vi.spyOn(api, 'listSites').mockRejectedValue(new Error('nicht erreichbar'));
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    expect(await screen.findByText('An dieser Anlage hängt keine Messstelle.', {}, WARTEN)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ANLAGE);
  });
});

describe('Messstellen · „Stand an einem Tag ansehen“', () => {
  it('aus dem Menü ein Tag: die Plan-Marke „Stand …“, die Reihen dieses Tags, benannt was es noch nicht gab - und kein Schreibweg', async () => {
    telefon(false);
    const register = verdrahte();
    const onOeffnen = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa onOeffnen={onOeffnen} />);
    await screen.findAllByTestId('messstelle-reihe');
    await menue(/^Stand an einem Tag ansehen/);
    await waehleTag('2026-10-10');
    await waitFor(() => expect(screen.getByTestId('stand-am')).toHaveTextContent('Stand 10.10.2026'), WARTEN);
    expect(register).toHaveBeenLastCalledWith({ stichtag: '2026-10-10', letzterMonat: true });
    expect(window.location.hash).toBe('#/portfolio/messstellen?stand=2026-10-10');
    // Eine Reihe öffnet die Messstelle an genau diesem Tag (AP-13 IP-3) - als Verweis und als Klick.
    await waitFor(() => expect(reiheVon('MS-06')).toHaveAttribute('href', `#/portfolio/messstellen/${MS06}?periode=2026-10-10&stand=2026-10-10`), WARTEN);
    fireEvent.click(reiheVon('MS-06'));
    expect(onOeffnen).toHaveBeenCalledWith(MS06, '2026-10-10');
    const nochNicht = await screen.findByTestId('messstellen-noch-nicht', {}, WARTEN);
    expect(nochNicht).toHaveTextContent('Am 10.10.2026 noch nicht im Portal');
    expect(nochNicht).toHaveTextContent('Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.');
    expect(screen.queryByRole('button', { name: 'Messstelle anlegen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu heute' }));
    await waitFor(() => expect(screen.queryByTestId('stand-am')).toBeNull(), WARTEN);
    expect(window.location.hash).toBe('#/portfolio/messstellen');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Messstelle anlegen' })).toBeInTheDocument(), WARTEN);
  });

  it('am Standort stehen im Menü auch die Korrekturen', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={WERK} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe');
    expect(register).toHaveBeenCalledWith({ standort: FIXTURE_IDS.st1, letzterMonat: true });
    expect(screen.getByText(`Werk Ahrenberg · ${KOPF_SATZ}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual([
      'Stand an einem Tag ansehenNur lesen, z. B. für eine Prüfung',
      'Korrekturen am Standort',
    ]);
    // Escape schließt den Dialog; der Fokus kehrt zum Menü ⋯ zurück, nicht auf `body` (Review r4 S23).
    vi.spyOn(api, 'korrekturen').mockResolvedValue([]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Korrekturen am Standort' }));
    const dialog = await screen.findByRole('dialog', { name: 'Korrekturen am Standort' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weitere Aktionen' })).toHaveFocus());
  });
});

describe('Messstellen · Leerzustände', () => {
  it('ohne „Messen & Auswerten“: der Satz und der Weg zur Übersicht - keine Suche, kein Anlegen', async () => {
    telefon(false);
    verdrahte(() => leeresRegister());
    const zurUebersicht = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa={false} onUebersicht={zurUebersicht} />);
    expect(
      await screen.findByText('Messstellen gibt es, sobald ein Standort „Messen & Auswerten“ eingerichtet hat.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Messstelle anlegen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(zurUebersicht).toHaveBeenCalledTimes(1);
  });

  it('eingerichtet, aber noch keine Messstelle: der Satz, was eine Messstelle ist, und „Messstelle anlegen“', async () => {
    telefon(false);
    verdrahte(() => leeresRegister());
    render(<MessstellenPage ebene={{ art: 'standort', id: FIXTURE_IDS.st2, name: 'Werk Lindach' }} bereichDa />);
    expect(await screen.findByText('Noch keine Messstelle in Werk Lindach.')).toBeInTheDocument();
    expect(
      screen.getByText('Eine Messstelle ist jeder Zähler, den Sie auswerten wollen – automatisch von einem Gerät oder zum Ablesen von Hand.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Messstelle anlegen']);
  });

  it('ein Ladefehler sagt, dass die Daten nicht betroffen sind, und lässt sich wiederholen', async () => {
    telefon(false);
    const register = vi.spyOn(api, 'messstellenRegister').mockRejectedValueOnce(new Error('503'));
    register.mockImplementation(async (a = {}) => ahrenbergRegister(a));
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Messstellen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await screen.findAllByTestId('messstelle-reihe');
  });
});

describe('Messstellen · „Messstelle anlegen“ öffnet den Dialog (AP-04 IP-6)', () => {
  function dialogGestellt() {
    vi.spyOn(api, 'kennzeichenVorschlag').mockResolvedValue({ kennzeichen: VORSCHLAG });
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'standortOrte').mockImplementation(async (id: string) =>
      id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
    );
  }

  it('der Kopf öffnet den Dialog mit dem Standort als Vorgabe; hat ein Schritt gespeichert, liest die Liste nach dem Schließen neu', async () => {
    telefon(false);
    const register = verdrahte();
    dialogGestellt();
    const anlegen = vi.spyOn(api, 'messstelleAnlegen').mockResolvedValue(messstelleAngelegt());
    render(<MessstellenPage ebene={WERK} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe', {}, WARTEN);

    fireEvent.click(screen.getByRole('button', { name: 'Messstelle anlegen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Messstelle anlegen' });
    await waitFor(() => expect((within(dialog).getByLabelText('Kennzeichen') as HTMLInputElement).value).toBe(VORSCHLAG));
    fireEvent.change(within(dialog).getByLabelText('Name *'), { target: { value: 'Spritzguss SG01–SG06 Kühlung' } });
    for (const [feld, wahl] of [
      ['Hauptgröße *', /^Wirkenergie/],
      ['Richtung *', /^Bezug/],
      ['Wertart *', /^Zählerstand/],
    ] as const) {
      fireEvent.click(within(dialog).getByRole('combobox', { name: feld }));
      fireEvent.click(await screen.findByRole('option', { name: wahl }));
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Weiter: Zuordnung' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    // §5.1 „Vorgabe: Standort“ - die Seite ist Werk Ahrenberg.
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Ort' }).textContent).toContain('Werk Ahrenberg'));

    const vorher = register.mock.calls.length;
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(register.mock.calls.length).toBeGreaterThan(vorher));
    expect(register).toHaveBeenLastCalledWith({ standort: FIXTURE_IDS.st1, letzterMonat: true });
  });

  it('ohne Speichern geschlossen: kein neues Lesen', async () => {
    telefon(false);
    const register = verdrahte();
    dialogGestellt();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findAllByTestId('messstelle-reihe', {}, WARTEN);
    fireEvent.click(screen.getByRole('button', { name: 'Messstelle anlegen' }));
    await screen.findByRole('dialog', { name: 'Messstelle anlegen' });
    await waitFor(() => expect(api.kennzeichenVorschlag).toHaveBeenCalled());
    const vorher = register.mock.calls.length;
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Messstelle anlegen' })).toBeNull());
    expect(register.mock.calls.length).toBe(vorher);
  });
});
