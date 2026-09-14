import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type OrtsbaumAmStichtag } from '../api';
import { ortsbaumLindachOhneGebaeude, verwaltung } from '../test/ortsbaumFixtures';
import { a12Liste, a12Orte, A12_HEUTE, A12_STICHTAGE, ST3_ID, type A12Stichtag } from '../test/standAmFixtures';
import { ahrenbergUnternehmen, FIXTURE_IDS } from '../test/standorteFixtures';
import { StandortePage } from './StandortePage';

/**
 * „Stand am …“ auf der Liste „Standorte“ und im Ortsbaum (UEMS AP-02 IP-13, H1).
 * Abnahme A12: Ines wählt 15.02.2027, dann 15.03.2027, dann 15.09.2026 — mit den
 * Antworten des Szenarios `ahrenberg`, deren Eltern und „gab es noch nicht“ gegen
 * die Vektoren `stand_am` aus `ortsbaum-vectors.json` gelesen werden.
 */

const NB = String.fromCharCode(160);

/** Die Folge aus drei Stichtagen lädt je Tag Liste und Bäume — unter paralleler Last dauert sie über die 5 s der Vorgabe. */
const LANG = 20_000;
const WARTEN = { timeout: 5_000 };

interface StandAmFall {
  familie: string;
  input: { szenario?: string; stichtag?: string };
  expected: {
    orte: { kennzeichen: string; standort: string | null }[];
    nicht_gezeigt: { kennzeichen: string; grund: string; text: string }[];
  };
}

const VEKTOREN: StandAmFall[] = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/ortsbaum-vectors.json'), 'utf8'),
).cases;

function vektor(stichtag: string): StandAmFall['expected'] {
  const fall = VEKTOREN.find(
    (c) => c.familie === 'stand_am' && c.input.szenario === 'ahrenberg' && c.input.stichtag === stichtag,
  );
  expect(fall, `Vektor stand_am ahrenberg ${stichtag}`).toBeDefined();
  return fall!.expected;
}

const KURZZEICHEN: Record<string, string> = { [FIXTURE_IDS.st1]: 'ST-1', [FIXTURE_IDS.st2]: 'ST-2', [ST3_ID]: 'ST-3' };

function verdrahte(orte: (id: string, tag: A12Stichtag) => OrtsbaumAmStichtag | null = a12Orte) {
  vi.spyOn(api, 'standorte').mockImplementation(async (stichtag) => a12Liste((stichtag ?? A12_HEUTE) as A12Stichtag));
  vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen({ standortZahl: 3 }));
  vi.spyOn(api, 'standortOrte').mockImplementation(async (id, stichtag) => {
    const baum = orte(id, (stichtag ?? A12_HEUTE) as A12Stichtag);
    if (!baum) throw new Error(`kein Ortsbaum für ${id} am ${stichtag}`);
    return baum;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const feld = () => screen.getByRole('combobox', { name: 'Stand am' });

/** Wählt im Datumsfeld „Stand am“ einen Tag — blättert dafür Monat für Monat. */
async function waehleTag(iso: string) {
  const vorher = feld().textContent ?? '';
  fireEvent.click(feld());
  const [t, m, j] = vorher.match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
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

/** Kurzzeichen der Gebäude und Bereiche, die ein Ortsbaum zeigt. */
function baumKurzzeichen(baum: HTMLElement): string[] {
  return [...baum.querySelectorAll('.vp-ob-knoten .vp-st-kz')].map((k) => k.textContent ?? '').sort();
}

/** Je Karte: Kurzzeichen → gezeigte Knoten, und die Sätze „gab es noch nicht“. */
function seite() {
  const karten = [...document.querySelectorAll<HTMLElement>('ul[aria-label="Standorte"] > li')];
  const baeume: Record<string, string[]> = {};
  const saetze: Record<string, string> = {};
  for (const k of karten) {
    const kz = k.querySelector('.vp-st-name .vp-st-kz')!.textContent!;
    const baum = k.querySelector<HTMLElement>('[data-testid="ortsbaum"]');
    if (baum) baeume[kz] = baumKurzzeichen(baum);
    if (k.dataset.testid === 'gab-es-noch-nicht') saetze[kz] = k.querySelector('.vp-st-zeile')!.textContent!;
  }
  return { baeume, saetze };
}

/** Was die Vektoren für denselben Tag sagen — Gebäude/Bereiche je Standort und die Standort-Sätze. */
function erwartet(stichtag: string) {
  const v = vektor(stichtag);
  const baeume: Record<string, string[]> = {};
  for (const o of v.orte) {
    if (o.kennzeichen.startsWith('ST-')) baeume[o.kennzeichen] ??= [];
    else if (o.standort) (baeume[o.standort] ??= []).push(o.kennzeichen);
  }
  for (const k of Object.keys(baeume)) baeume[k].sort();
  const saetze = Object.fromEntries(
    v.nicht_gezeigt.filter((n) => n.kennzeichen.startsWith('ST-')).map((n) => [n.kennzeichen, n.text]),
  );
  return { baeume, saetze };
}

async function warteAufBaeume(stichtag: string) {
  const v = vektor(stichtag);
  const zahl = v.orte.filter((o) => o.kennzeichen.startsWith('ST-')).length;
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="ortsbaum"] .vp-ob-knoten')).not.toHaveLength(0);
    expect(screen.queryAllByText('Gebäude werden geladen …')).toHaveLength(0);
    expect(screen.getAllByTestId('ortsbaum')).toHaveLength(zahl);
  }, WARTEN);
}

describe('StandortePage · „Stand am …“ (A12)', () => {
  it('heute: Datumsfeld mit dem heutigen Tag, kein Banner, die Schreibwege sind da', async () => {
    verdrahte();
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Werk Ahrenberg Nord bearbeiten' }, WARTEN);
    expect(feld()).toHaveTextContent('10.04.2027');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Standort anlegen' })).toBeInTheDocument();
    expect(api.standorte).toHaveBeenCalledWith();
  }, LANG);

  it('drei Stichtage nacheinander: 15.02.2027 · 15.03.2027 · 15.09.2026 — Baum und Sätze wie die Vektoren', async () => {
    verdrahte();
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Werk Ahrenberg bearbeiten' }, WARTEN);

    // 15.02.2027: Halle 2 mit drei Bereichen unter Werk Ahrenberg, 3 400 m²; Werk Ahrenberg Nord gab es noch nicht.
    await waehleTag('2027-02-15');
    expect(await screen.findByRole('status', {}, WARTEN)).toHaveTextContent(
      'Sie sehen den Stand am 15.02.2027 — Änderungen sind hier nicht möglich.',
    );
    await warteAufBaeume('2027-02-15');
    expect(seite()).toEqual(erwartet('2027-02-15'));
    expect(seite().baeume['ST-1']).toEqual(expect.arrayContaining(['G-2', 'B-3', 'B-4', 'B-5']));
    const ahrenberg = screen.getAllByTestId('ortsbaum')[0];
    expect([...ahrenberg.querySelectorAll('.vp-ob-beschreibung')].map((z) => z.textContent)).toContain(
      `Produktion · Montage · Lager · 3${NB}400${NB}m² · 2019`,
    );
    expect(screen.getByTestId('gab-es-noch-nicht')).toHaveTextContent(
      'Am 15.02.2027 gab es Werk Ahrenberg Nord im Portal noch nicht.',
    );
    expect(api.standorte).toHaveBeenLastCalledWith('2027-02-15');
    expect(api.standortOrte).toHaveBeenCalledWith(FIXTURE_IDS.st1, '2027-02-15');

    // 15.03.2027: Halle 2 unter Werk Ahrenberg Nord.
    await waehleTag('2027-03-15');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sie sehen den Stand am 15.03.2027'), WARTEN);
    await warteAufBaeume('2027-03-15');
    expect(seite()).toEqual(erwartet('2027-03-15'));
    expect(seite().baeume['ST-3']).toEqual(['B-3', 'B-4', 'B-5', 'G-2']);
    expect(screen.queryByTestId('gab-es-noch-nicht')).toBeNull();

    // 15.09.2026: keinen Standort gab es — jeder ist benannt, keiner weggelassen.
    await waehleTag('2026-09-15');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sie sehen den Stand am 15.09.2026'), WARTEN);
    await waitFor(() => expect(screen.getAllByTestId('gab-es-noch-nicht')).toHaveLength(3), WARTEN);
    expect(seite()).toEqual(erwartet('2026-09-15'));
    expect(screen.getByText('Am 15.09.2026 gab es Werk Ahrenberg im Portal noch nicht.')).toBeInTheDocument();
    expect(screen.queryByTestId('ortsbaum')).toBeNull();
    expect(screen.queryByText('Noch kein Standort angelegt.')).toBeNull();
    // Die Arbeitsliste von heute gehört nicht in die Vergangenheit (das Lesemodell nennt die Anlagen von heute).
    expect(screen.queryByTestId('noch-nicht-zugeordnet')).toBeNull();
  }, LANG);

  it('mit gesetztem Stichtag ist kein Schreibweg angeboten — kein Anlegen, kein Bearbeiten, kein „Fläche eintragen“', async () => {
    // Werk Lindach ohne Gebäude (L1) und Verwaltung ohne Fläche: genau die Stellen, an denen heute Schreibknöpfe stehen.
    verdrahte((id, tag) =>
      id === FIXTURE_IDS.st2
        ? { ...ortsbaumLindachOhneGebaeude(), stichtag: tag, standort: a12Liste(tag).standorte[1] }
        : id === FIXTURE_IDS.st1
          ? { ...a12Orte(id, tag)!, gebaeude: [verwaltung({ flaecheM2: null, flaecheQuelle: null })] }
          : a12Orte(id, tag),
    );
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Verwaltung bearbeiten' }, WARTEN);
    // Gegenprobe heute — sonst wäre die Zusicherung unten leer.
    const heute = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    for (const knopf of [
      'Standort anlegen',
      'Werk Ahrenberg bearbeiten',
      'Gebäude anlegen',
      'Bereich anlegen',
      'Bereich direkt am Standort anlegen',
      'Verwaltung bearbeiten',
      'Fläche eintragen: Verwaltung',
    ]) {
      expect(heute).toContain(knopf);
    }

    await waehleTag('2027-03-15');
    await screen.findByRole('status', {}, WARTEN);
    await waitFor(() => {
      expect(screen.getAllByTestId('ortsbaum')).toHaveLength(3);
      expect(screen.queryAllByText('Gebäude werden geladen …')).toHaveLength(0);
    });
    expect(screen.getByText('für kWh/m² fehlt die Fläche')).toBeInTheDocument();
    expect(screen.getByTestId('ortsbaum-leer')).toBeInTheDocument();
    // Der EINZIGE Knopf der Seite führt zurück zu heute; das Datumsfeld ist eine Auswahl, kein Schreibweg.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Zurück zu heute']);
    expect(document.querySelectorAll('.vp-ob-bearbeiten, .vp-ob-verweis')).toHaveLength(0);
  }, LANG);

  it('„Zurück zu heute“: Banner weg, Schreibwege zurück, der Fokus steht im Datumsfeld', async () => {
    verdrahte();
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Werk Ahrenberg bearbeiten' }, WARTEN);
    await waehleTag('2027-02-15');
    fireEvent.click(await screen.findByRole('button', { name: 'Zurück zu heute' }, WARTEN));
    await screen.findByRole('button', { name: 'Werk Ahrenberg Nord bearbeiten' }, WARTEN);
    expect(screen.queryByRole('status')).toBeNull();
    expect(feld()).toHaveTextContent('10.04.2027');
    await waitFor(() => expect(document.activeElement).toBe(feld()));
    expect(api.standorte).toHaveBeenLastCalledWith();
  }, LANG);

  it('beim Wechsel des Tages steht nie die Liste des vorigen Tages unter dem neuen Banner', async () => {
    verdrahte();
    render(<StandortePage />);
    await screen.findByRole('button', { name: 'Werk Ahrenberg bearbeiten' }, WARTEN);
    vi.mocked(api.standorte).mockImplementation(() => new Promise(() => undefined));
    await waehleTag('2027-02-15');
    expect(await screen.findByRole('status', {}, WARTEN)).toHaveTextContent('15.02.2027');
    expect(screen.getByText('Standorte werden geladen …')).toBeInTheDocument();
    expect(screen.queryByTestId('standort-kopf')).toBeNull();
  }, LANG);

  it('die Fixture deckt jeden A12-Stichtag des Vertrags ab', () => {
    for (const tag of A12_STICHTAGE) {
      const v = vektor(tag);
      const gezeigt = a12Liste(tag).standorte.map((s) => KURZZEICHEN[s.id]).sort();
      expect(gezeigt, tag).toEqual(v.orte.filter((o) => o.kennzeichen.startsWith('ST-')).map((o) => o.kennzeichen).sort());
    }
  }, LANG);
});
