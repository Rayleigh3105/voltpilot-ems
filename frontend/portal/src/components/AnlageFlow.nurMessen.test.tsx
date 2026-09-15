import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { OnboardingWizard } from '../Onboarding';
import { STARTKLAR_SATZ } from '../anlageFlow';
import { api, ApiError, type Funktionen, type MastrPreview, type TelemetryPoint } from '../api';
import {
  ERSTE_DATEN_NUR_MESSEN,
  nurMessenWeiterSatz,
  steuerGeldWoerter,
  ZU_DEN_MESSSTELLEN,
} from '../anlegeNurMessen';
import { hashForRoute, standortMessstellenRoute } from '../nav';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import { ahrenbergHeute, bestandEineAnlage, FIXTURE_IDS, werkLindach } from '../test/standorteFixtures';
import { anlageLindach, leereKomponenten, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Der Modus „nur messen" im Anlege-Fluss (Captain 15.09.2026: „Von Steuern soll beim
 * Messen eigentlich noch nicht die Rede sein. Ebenso eine Frage, darf ich ohne Anlage
 * auch einfach Messstellen anlegen?"). Geprüft wird gegen die WORTLISTE
 * (`STEUER_GELD_WOERTER`), nicht gegen einzelne Sätze — über allen lesbaren Text der
 * Seite samt Beschriftungen und Platzhaltern, in jedem Schritt bis „Fertig". Dazu: der
 * Standort entscheidet, Verborgenes wird nicht gesendet, und der Weg führt ohne Umweg
 * zu den Messstellen, ohne dass die Anlage (und ihr Bereich „Steuerung") verloren geht.
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
const ERSTER_PUNKT = { ts: '2026-10-20T08:15:00Z' } as unknown as TelemetryPoint;

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
function messkunde(opts: { telemetrie?: TelemetryPoint[] } = {}) {
  vi.spyOn(api, 'standorte').mockResolvedValue({ ...ahrenbergHeute(), standorte: [werkLindach()] });
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }));
  const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
  vi.spyOn(api, 'mastrLookup').mockResolvedValue(pvAusDemRegister);
  vi.spyOn(api, 'mastrApply').mockResolvedValue([]);
  const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
  vi.spyOn(api, 'telemetry').mockResolvedValue(opts.telemetrie ?? []);
  // Die Abrufe und Schreibwege des Schritts „Betrieb" — im Modus „nur messen" nie.
  const betrieb = [
    vi.spyOn(api, 'siteEntities').mockResolvedValue(leereKomponenten),
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

async function anlegenUndRegisterUeberspringen(name = 'Halle 3') {
  fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später nachtragen' }));
  expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Modus „nur messen": der Anlege-Fluss spricht kein Wort über Steuern, Geld oder Erlöse', () => {
  it('gegen die Wortliste — in jedem Schritt, Hinweis, Knopf und Fehlersatz bis „Fertig"', async () => {
    const { createSite, claimDevice, betrieb } = messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);
    await ruhe();

    // Schritt 1: Werk Lindach vorbelegt — keine Veräußerungsform, keine Feineinstellungen, kein „Betrieb".
    expect(screen.getByRole('combobox', { name: 'Standort *' })).toHaveTextContent('Werk Lindach (ST-2)');
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät']);
    expect(screen.queryByRole('combobox', { name: 'Veräußerungsform' })).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByText('Bitte geben Sie einen Namen für Ihre Anlage ein.')).toBeInTheDocument();
    schweigt('Schritt 1 · Anlage');

    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Halle 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    // Gesendet wird, was ein unberührter Block sendet — kein Wert, den der Kunde nicht sehen konnte.
    expect(createSite.mock.calls[0][0]).toStrictEqual({
      name: 'Halle 3',
      biddingZone: 'DE-LU',
      latitude: null,
      longitude: null,
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      netzladenErlaubt: false,
      maxFeedInKw: null,
      standortId: FIXTURE_IDS.st2,
    });

    // Schritt 2: Register — Eingabe, Handeingabe und Vorschau.
    expect(await screen.findByText('PV & Speicher aus dem Register')).toBeInTheDocument();
    schweigt('Schritt 2 · Register');
    fireEvent.click(screen.getByRole('button', { name: 'Keine Nummer? Daten manuell eingeben' }));
    expect(screen.getByText('Daten manuell eingeben')).toBeInTheDocument();
    schweigt('Schritt 2 · Handeingabe');
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zur Registersuche' }));
    fireEvent.change(screen.getByLabelText('MaStR-Nummer der PV-Anlage'), { target: { value: 'SEE900000012345' } });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    expect(await screen.findByText('Im Register gefunden')).toBeInTheDocument();
    schweigt('Schritt 2 · Vorschau aus dem Register');
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen & weiter' }));

    // Schritt 3: Gerät — auch der Fehlersatz.
    expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    claimDevice.mockRejectedValueOnce(new ApiError(422, 'unbekannt'));
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(await screen.findByText(/Diese Geräte-ID kennen wir nicht/)).toBeInTheDocument();
    schweigt('Schritt 3 · Gerät');
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));

    // Fertig — ohne Schritt „Betrieb", mit dem Weg zu den Messstellen.
    expect(await screen.findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
    expect(screen.getByText(nurMessenWeiterSatz(funktionWerkLindach()))).toBeInTheDocument();
    expect(screen.queryByText('Wofür ist diese Anlage?')).toBeNull();
    schweigt('Fertig');
    for (const abruf of betrieb) expect(abruf).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: ZU_DEN_MESSSTELLEN }));
    expect(onDone).toHaveBeenCalledWith(MESSSTELLEN_LINDACH);
  });

  it('Einrichtungs-Assistent: auch das Warten auf die ersten Daten schweigt', async () => {
    messkunde();
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} onSkipAll={() => {}} />);
    await ruhe();
    await anlegenUndRegisterUeberspringen();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(await screen.findByText('Ihr Gerät meldet sich…')).toBeInTheDocument();
    schweigt('Warten auf die ersten Daten');
  });

  it('Einrichtungs-Assistent: die ersten Daten — „Zu den Messstellen", und die Anlage bleibt einen Tipp entfernt', async () => {
    messkunde({ telemetrie: [ERSTER_PUNKT] });
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} waitForFirstData onDone={onDone} onSkipAll={() => {}} />);
    await ruhe();
    await anlegenUndRegisterUeberspringen();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(await screen.findByText('Ihre Anlage ist verbunden')).toBeInTheDocument();
    expect(screen.getByText(ERSTE_DATEN_NUR_MESSEN)).toBeInTheDocument();
    schweigt('Erste Daten');

    // Erreichbarkeit: „Zur Anlage" führt ohne Ziel dorthin, wo der Bereich „Steuerung" still bleibt.
    fireEvent.click(screen.getByRole('button', { name: 'Zur Anlage' }));
    expect(onDone).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole('button', { name: ZU_DEN_MESSSTELLEN }));
    expect(onDone).toHaveBeenLastCalledWith(MESSSTELLEN_LINDACH);
  });

  it('Wiedereinstieg im Einrichtungs-Assistenten: die bestehende Anlage an Werk Lindach misst nur', async () => {
    messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[anlageLindach]} waitForFirstData onDone={onDone} onSkipAll={() => {}} />);
    await ruhe();
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät']);
    fireEvent.click(screen.getByRole('button', { name: 'Überspringen - später nachtragen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    expect(await screen.findByText(/„Werk Lindach“ ist da/)).toBeInTheDocument();
    schweigt('Fertig nach dem Wiedereinstieg');
    fireEvent.click(screen.getByRole('button', { name: ZU_DEN_MESSSTELLEN }));
    expect(onDone).toHaveBeenCalledWith(MESSSTELLEN_LINDACH);
  });
});

describe('der Standort entscheidet — derselbe Fakt wie auf der Übersicht (Steuern-Regel, PR 779)', () => {
  it('Ahrenberg: vor der Wahl wie heute, Werk Lindach nur messen, Werk Ahrenberg wie heute — Verborgenes wird nicht gesendet', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    const createSite = vi.spyOn(api, 'createSite').mockReturnValue(new Promise(() => {}));
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    await ruhe();
    const picker = screen.getByRole('combobox', { name: 'Standort *' });
    const waehle = (name: RegExp) => {
      fireEvent.click(picker);
      fireEvent.click(screen.getByRole('option', { name }));
    };

    // Vor der Wahl spricht das Unternehmen — Halle 1 steuert.
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät', 'Betrieb']);
    fireEvent.click(screen.getByText(/Feineinstellungen/));
    fireEvent.change(screen.getByLabelText('Maximale Einspeiseleistung am Netzanschlusspunkt (kW)'), {
      target: { value: '75' },
    });

    waehle(/Werk Lindach \(ST-2\)/);
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät']);
    expect(screen.queryByRole('combobox', { name: 'Veräußerungsform' })).toBeNull();
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();

    waehle(/Werk Ahrenberg \(ST-1\)/);
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät', 'Betrieb']);
    expect(screen.getByRole('combobox', { name: 'Veräußerungsform' })).toBeInTheDocument();

    waehle(/Werk Lindach \(ST-2\)/);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Halle 3' } });
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

  it('solange die Funktionen unterwegs sind: kein Geld-Block, kein „Betrieb" — danach wie heute', async () => {
    let antworten: (f: Funktionen) => void = () => {};
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockReturnValue(
      new Promise<Funktionen>((r) => {
        antworten = r;
      }),
    );
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    await ruhe();
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät']);
    expect(screen.queryByText(/Feineinstellungen/)).toBeNull();

    await act(async () => antworten(ahrenbergFunktionen()));
    expect(await screen.findByText(/Feineinstellungen/)).toBeInTheDocument();
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät', 'Betrieb']);
  });

  it('Funktionen nicht lesbar (älteres Backend, Fehler): wie heute — auch an einem Standort, der nur misst', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue({ ...ahrenbergHeute(), standorte: [werkLindach()] });
    vi.spyOn(api, 'funktionen').mockRejectedValue(new ApiError(503, 'kurz weg'));
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    await ruhe();
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät', 'Betrieb']);
    expect(screen.getByText(/Feineinstellungen/)).toBeInTheDocument();
  });
});

describe('Einrichtungs-Assistent: die Schrittzahl folgt dem Fluss', () => {
  it('Messkunde „In drei Schritten“ — Kunde mit Steuern „In vier Schritten“ wie heute, beides erst nach der Entscheidung', async () => {
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
  it('Werk Ahrenberg: Schritt 1 nennt Veräußerung, Vergütung und Netzladen, „Betrieb“ und Fertig sprechen vom Steuern', async () => {
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
    vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(leereKomponenten);
    vi.spyOn(api, 'siteProfiles').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    await ruhe();
    expect(steuerGeldWoerter(lesbar())).toEqual(expect.arrayContaining(['veräußerung', 'vergüt', 'netzladen']));

    await anlegenUndRegisterUeberspringen();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(await screen.findByText('Wofür ist diese Anlage?')).toBeInTheDocument();
    await ruhe();
    expect(steuerGeldWoerter(lesbar()).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Überspringen - später festlegen' }));
    expect(await screen.findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
    expect(steuerGeldWoerter(lesbar())).toContain('steuer');
  });
});

describe('„Anlage anlegen" als Drawer: nach „Zu den Messstellen" dorthin, sonst wie heute', () => {
  async function bisFertig() {
    await ruhe();
    await anlegenUndRegisterUeberspringen();
    fireEvent.click(screen.getByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    expect(await screen.findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
  }

  it('„Zu den Messstellen": der Wirt erfährt Anlage und Ziel, die Adresse zeigt auf die Messstellen', async () => {
    messkunde();
    window.location.hash = '#/portfolio';
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(<AnlageAnlegenDrawer open onClose={onClose} onChanged={onChanged} />);
    await bisFertig();
    fireEvent.click(screen.getByRole('button', { name: ZU_DEN_MESSSTELLEN }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(neueAnlage.id, MESSSTELLEN_LINDACH);
    expect(window.location.hash).toBe(hashForRoute(MESSSTELLEN_LINDACH));
  });

  it('„Zur Anlage": ohne Ziel — der Wirt landet wie heute auf der neuen Anlage', async () => {
    messkunde();
    window.location.hash = '#/portfolio';
    const onChanged = vi.fn();
    render(<AnlageAnlegenDrawer open onClose={() => {}} onChanged={onChanged} />);
    await bisFertig();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Anlage' }));
    expect(onChanged).toHaveBeenCalledWith(neueAnlage.id, undefined);
    expect(window.location.hash).toBe('#/portfolio');
  });
});
