import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { OnboardingWizard } from '../Onboarding';
import { STARTKLAR_SATZ } from '../anlageFlow';
import { api, ApiError, type Funktionen, type MastrPreview } from '../api';
import { steuerGeldWoerter } from '../anlegeNurMessen';
import { anlageRoute, hashForRoute, standortMessstellenRoute } from '../nav';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import { ahrenbergHeute, bestandEineAnlage, FIXTURE_IDS, werkLindach } from '../test/standorteFixtures';
import { anlageLindach, leereKomponenten, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Der Modus „nur messen" im Anlege-Fluss (Captain 15.09.2026: „Von Steuern soll beim
 * Messen eigentlich noch nicht die Rede sein. Ebenso eine Frage, darf ich ohne Anlage
 * auch einfach Messstellen anlegen?"). Geprüft wird gegen die WORTLISTE
 * (`STEUER_GELD_WOERTER`), nicht gegen einzelne Sätze — über allen lesbaren Text der
 * Seite samt Beschriftungen und Platzhaltern, in jedem Schritt bis zum Ende. Dazu: der
 * Standort entscheidet, Verborgenes wird nicht gesendet, und der Weg führt ohne Umweg
 * zu den Messstellen. Seit Anlage-Flow a1 Paket 2 hat die Leiste in jeder Art dieselben
 * drei Schritte (Adresse · Box · Anlage); die Art zeigt sich am Geld-Teil von Schritt 1
 * und am Ziel des Endes.
 */

vi.mock('../auth', () => ({ isPlatformAdmin: () => false }));

vi.mock('leaflet', () => {
  const map = {
    on: vi.fn(),
    setView: vi.fn(),
    removeLayer: vi.fn(),
    invalidateSize: vi.fn(),
    getZoom: () => 13,
    getBounds: () => ({ contains: () => true }),
    remove: vi.fn(),
  };
  const marker = {
    addTo: vi.fn(() => marker),
    on: vi.fn(),
    setLatLng: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })),
  };
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    marker: vi.fn(() => marker),
    divIcon: vi.fn(() => ({})),
    latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })),
  };
  return { default: L };
});

const MESSSTELLEN_LINDACH = standortMessstellenRoute(FIXTURE_IDS.st2);

const pvAusDemRegister: MastrPreview = {
  mastrNummer: 'SEE900000012345',
  kind: 'pv',
  name: null,
  status: 'In Betrieb',
  plantType: null,
  powerKw: 9.8,
  inverterPowerKw: null,
  moduleCount: 24,
  azimuthLabel: 'Süd',
  azimuthDeg: 180,
  tiltLabel: '30°',
  tiltDeg: 30,
  commissionedOn: '2023',
  storageCapacityKwh: null,
  chargePowerKw: null,
  batteryTechnology: null,
  plz: '89551',
  ort: 'Königsbronn',
  linkedUnitNumber: null,
  warnings: [],
};

/** Ein Kunde, der nur misst: sein einziger Standort Werk Lindach spricht nicht von Steuern. */
function messkunde() {
  vi.spyOn(api, 'standorte').mockResolvedValue({ ...ahrenbergHeute(), standorte: [werkLindach()] });
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }));
  const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
  vi.spyOn(api, 'mastrLookup').mockResolvedValue(pvAusDemRegister);
  vi.spyOn(api, 'mastrApply').mockResolvedValue([]);
  const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(leereKomponenten);
  vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
  // Die Schreibwege des früheren Schritts „Betrieb" (D6) — nie mehr aus dem Anlege-Fluss.
  const betrieb = [
    vi.spyOn(api, 'siteProfiles').mockResolvedValue({ profiles: [] }),
    vi.spyOn(api, 'setSiteProfile').mockResolvedValue(undefined as never),
    vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(undefined as never),
  ];
  return { createSite, claimDevice, betrieb };
}

/** Alles, was der Kunde lesen kann: Text, Beschriftungen, Platzhalter, Titel. */
function lesbar(): string {
  const merkmale = [...document.body.querySelectorAll('[aria-label],[placeholder],[title],[alt]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
  );
  return [document.body.textContent ?? '', ...merkmale].join('\n');
}

function schweigt(stelle: string) {
  expect(steuerGeldWoerter(lesbar()), stelle).toEqual([]);
}

const leiste = () => [...document.querySelectorAll('.vp-step-label')].map((l) => l.textContent);

async function anlegenBisZurBox(name = 'Halle 3') {
  fireEvent.change(screen.getByLabelText('Name der neuen Anlage'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  expect(await screen.findByText('Ihre VoltPilot-Box')).toBeInTheDocument();
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('Modus „nur messen": der Anlege-Fluss spricht kein Wort über Steuern, Geld oder Erlöse', () => {
  it('gegen die Wortliste — in jedem Schritt, Hinweis, Knopf und Fehlersatz bis zum Ende', async () => {
    const { createSite, claimDevice, betrieb } = messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await ruhe();

    // Schritt 1: Werk Lindach vorbelegt — keine Veräußerungsform, keine Feineinstellungen.
    expect(screen.getByRole('radio', { name: /„Werk Lindach“/ })).toBeChecked();
    expect(leiste()).toEqual(['Adresse', 'Box', 'Anlage']);
    expect(screen.queryByRole('combobox', { name: 'Veräußerungsform' })).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByText('Bitte geben Sie einen Namen für Ihre Anlage ein.')).toBeInTheDocument();
    schweigt('Schritt 1 · Adresse');

    fireEvent.change(screen.getByLabelText('Name der neuen Anlage'), { target: { value: 'Halle 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    // Gesendet wird, was ein unberührter Block sendet — kein Wert, den der Kunde nicht sehen konnte. Lage und
    // Gebotszone übernimmt die Anlage von ihrem Standort (Anlage-Flow a1: der Ort wird einmal erfasst).
    expect(createSite.mock.calls[0][0]).toStrictEqual({
      name: 'Halle 3',
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      netzladenErlaubt: false,
      maxFeedInKw: null,
      standortId: FIXTURE_IDS.st2,
    });

    // Schritt 2: Box — auch der Fehlersatz.
    expect(await screen.findByText('Ihre VoltPilot-Box')).toBeInTheDocument();
    schweigt('Schritt 2 · Box');
    claimDevice.mockRejectedValueOnce(new ApiError(422, 'unbekannt'));
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'edge-k7m2xq3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
    expect(await screen.findByText(/Diese Kennung kennen wir nicht/)).toBeInTheDocument();
    schweigt('Schritt 2 · Box, abgelehnt');
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));

    // Schritt 3: Anlage — die Box sucht, Solar und Speicher, das Register mit Vorschau.
    expect(await screen.findByText('Ihre Box meldet gerade ihre Geräte …')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speicher' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stimmt so' }));
    expect(await screen.findByText(/Kapazität des Speichers als Zahl/)).toBeInTheDocument();
    schweigt('Schritt 3 · Anlage');
    fireEvent.click(screen.getByRole('button', { name: 'Speicher' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aus dem Register holen' }));
    schweigt('Schritt 3 · Register');
    fireEvent.change(screen.getByLabelText('MaStR-Nummer der PV-Anlage'), { target: { value: 'SEE900000012345' } });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    expect(await screen.findByText('Im Register gefunden')).toBeInTheDocument();
    schweigt('Schritt 3 · Vorschau aus dem Register');
    fireEvent.click(screen.getByRole('button', { name: 'Andere Nummer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ohne Register weiter' }));

    // Das Ende: ohne Umweg zu den Messstellen - kein „Betrieb", kein Fertig-Bildschirm (D6, D7).
    fireEvent.click(await screen.findByRole('button', { name: 'Stimmt so' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(MESSSTELLEN_LINDACH));
    for (const abruf of betrieb) expect(abruf).not.toHaveBeenCalled();
    // Die Karte „Ihre Anlage ist live“ spricht vom Strompreis - ein Messkunde bekommt sie nicht.
    expect(localStorage.getItem(`vp.erste-werte.${neueAnlage.id}`)).toBeNull();
  });

  it('ohne Box: „Was haben Sie?" schweigt, „Später ergänzen" führt zu den Messstellen', async () => {
    messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="assistent" onDone={onDone} onSkipAll={() => {}} />);
    await ruhe();
    await anlegenBisZurBox();
    fireEvent.click(screen.getByRole('button', { name: 'Box ist noch nicht da - später verbinden' }));
    expect(await screen.findByRole('heading', { name: 'Was haben Sie?' })).toBeInTheDocument();
    schweigt('Schritt 3 ohne Box');
    fireEvent.click(screen.getByRole('button', { name: 'Später ergänzen' }));
    expect(onDone).toHaveBeenCalledWith(MESSSTELLEN_LINDACH);
  });

  it('Wiedereinstieg im Einrichtungs-Assistenten: die bestehende Anlage an Werk Lindach misst nur', async () => {
    messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[anlageLindach]} wirt="assistent" onDone={onDone} onSkipAll={() => {}} />);
    await ruhe();
    expect(leiste()).toEqual(['Adresse', 'Box', 'Anlage']);
    fireEvent.click(await screen.findByRole('button', { name: 'Box ist noch nicht da - später verbinden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Später ergänzen' }));
    schweigt('Ende nach dem Wiedereinstieg');
    expect(onDone).toHaveBeenCalledWith(MESSSTELLEN_LINDACH);
  });
});

describe('der Standort entscheidet — derselbe Fakt wie auf der Übersicht (Steuern-Regel, PR 779)', () => {
  const geldTeil = () => screen.queryByRole('combobox', { name: 'Veräußerungsform' });

  it('Ahrenberg: vor der Wahl wie heute, Werk Lindach nur messen, Werk Ahrenberg wie heute — Verborgenes wird nicht gesendet', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    const createSite = vi.spyOn(api, 'createSite').mockReturnValue(new Promise(() => {}));
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await ruhe();
    const waehle = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));

    // Vor der Wahl spricht das Unternehmen — Halle 1 steuert. Die Leiste ist in jeder Art dieselbe.
    expect(leiste()).toEqual(['Adresse', 'Box', 'Anlage']);
    fireEvent.click(screen.getByText(/Feineinstellungen/));
    fireEvent.change(screen.getByLabelText('Maximale Einspeiseleistung am Netzanschlusspunkt (kW)'), {
      target: { value: '75' },
    });

    waehle(/„Werk Lindach“/);
    expect(geldTeil()).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();

    waehle(/„Werk Ahrenberg“/);
    expect(geldTeil()).toBeInTheDocument();
    expect(leiste()).toEqual(['Adresse', 'Box', 'Anlage']);

    waehle(/„Werk Lindach“/);
    fireEvent.change(screen.getByLabelText('Name der neuen Anlage'), { target: { value: 'Halle 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(createSite).toHaveBeenCalledTimes(1);
    expect(createSite.mock.calls[0][0]).toMatchObject({
      standortId: FIXTURE_IDS.st2,
      plantKind: 'eigenverbrauch',
      tarifArt: 'ohne',
      netzladenErlaubt: false,
      maxFeedInKw: null,
    });
  });

  it('vom Wirt vorbelegt (Knopf „Messanlage anlegen“): Werk Lindach still ab dem ersten Bild, Werk Ahrenberg wie heute — kein Schalter', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    const lindach = render(
      <AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} standortId={FIXTURE_IDS.st2} />,
    );
    await ruhe();
    expect(screen.getByRole('radio', { name: /„Werk Lindach“/ })).toBeChecked();
    expect(geldTeil()).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();
    lindach.unmount();

    // Dieselbe Vorbelegung an einem Standort, der steuert: der Fakt entscheidet, nicht der Einstieg.
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} standortId={FIXTURE_IDS.st1} />);
    await ruhe();
    expect(screen.getByRole('radio', { name: /„Werk Ahrenberg“/ })).toBeChecked();
    expect(geldTeil()).toBeInTheDocument();
  });

  it('eine Vorbelegung, die nicht zur Wahl steht, gilt nicht — der Kunde wählt wie heute', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} standortId="st-archiviert" />);
    await ruhe();
    expect(screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });

  it('solange die Funktionen unterwegs sind: kein Geld-Block — danach wie heute', async () => {
    let antworten: (f: Funktionen) => void = () => {};
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockReturnValue(
      new Promise<Funktionen>((r) => {
        antworten = r;
      }),
    );
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await ruhe();
    expect(leiste()).toEqual(['Adresse', 'Box', 'Anlage']);
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();

    await act(async () => antworten(ahrenbergFunktionen()));
    expect(await screen.findByText(/Feineinstellungen/)).toBeInTheDocument();
  });

  it('Funktionen nicht lesbar: keine der beiden Fassungen wird behauptet', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue({ ...ahrenbergHeute(), standorte: [werkLindach()] });
    vi.spyOn(api, 'funktionen').mockRejectedValue(new ApiError(503, 'kurz weg'));
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await ruhe();
    expect(screen.getByText('Der nächste Schritt konnte nicht geladen werden.')).toBeInTheDocument();
    expect(screen.queryByText('Zuerst den Standort')).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();
  });
});

describe('Einrichtungs-Assistent: die Schrittzahl folgt dem Fluss', () => {
  it('„In drei Schritten“ — für Messkunden wie für Kunden mit Steuern, erst nach der Entscheidung', async () => {
    messkunde();
    const erster = render(<OnboardingWizard sites={[]} onDone={() => {}} onSkip={() => {}} />);
    await ruhe();
    expect(screen.getByText('In drei Schritten ist Ihre Anlage startklar.')).toBeInTheDocument();
    schweigt('Willkommen im Einrichtungs-Assistenten');
    erster.unmount();

    vi.restoreAllMocks();
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    render(<OnboardingWizard sites={[]} onDone={() => {}} onSkip={() => {}} />);
    expect(screen.queryByText(/Schritten ist Ihre Anlage startklar/)).toBeNull();
    await ruhe();
    expect(screen.getByText(STARTKLAR_SATZ)).toBeInTheDocument();
  });
});

describe('Gegenprobe: derselbe Abtaster beißt beim Kunden mit Steuern', () => {
  it('Werk Ahrenberg: Schritt 1 nennt Veräußerung, Vergütung und Netzladen; das Ende führt ins Cockpit', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await ruhe();
    expect(steuerGeldWoerter(lesbar())).toEqual(expect.arrayContaining(['veräußerung', 'vergüt', 'netzladen']));

    await anlegenBisZurBox();
    fireEvent.click(screen.getByRole('button', { name: 'Box ist noch nicht da - später verbinden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Später ergänzen' }));
    expect(onDone).toHaveBeenCalledWith(anlageRoute(neueAnlage.id));
  });
});

describe('„Anlage anlegen" als Drawer: das Ende führt zu den Messstellen, ins Cockpit oder zurück zum Wirt', () => {
  async function bisZumEnde() {
    await ruhe();
    await anlegenBisZurBox();
    fireEvent.click(screen.getByRole('button', { name: 'Box ist noch nicht da - später verbinden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Später ergänzen' }));
  }

  it('Messkunde: der Wirt erfährt Anlage und Ziel, die Adresse zeigt auf die Messstellen', async () => {
    messkunde();
    window.location.hash = '#/portfolio';
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(<AnlageAnlegenDrawer open onClose={onClose} onChanged={onChanged} />);
    await bisZumEnde();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(neueAnlage.id, MESSSTELLEN_LINDACH);
    expect(window.location.hash).toBe(hashForRoute(MESSSTELLEN_LINDACH));
  });

  it('Kunde mit Steuern: ins Cockpit der neuen Anlage (D7)', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    window.location.hash = '#/portfolio';
    const onChanged = vi.fn();
    render(<AnlageAnlegenDrawer open onClose={() => {}} onChanged={onChanged} />);
    await bisZumEnde();
    expect(onChanged).toHaveBeenCalledWith(neueAnlage.id, anlageRoute(neueAnlage.id));
    expect(window.location.hash).toBe(hashForRoute(anlageRoute(neueAnlage.id)));
  });

  it('mit Rückkehr (Assistent „Messen & Auswerten“): zurück zum Wirt, ohne Ziel und ohne Adresswechsel', async () => {
    messkunde();
    window.location.hash = '#/portfolio';
    const onChanged = vi.fn();
    render(<AnlageAnlegenDrawer open onClose={() => {}} onChanged={onChanged} standortId={FIXTURE_IDS.st2} zurueck />);
    await bisZumEnde();
    expect(onChanged).toHaveBeenCalledWith(neueAnlage.id, undefined);
    expect(window.location.hash).toBe('#/portfolio');
  });
});
