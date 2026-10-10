import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AKTIONEN,
  FUNKTIONEN,
  GRUND_TEXT,
  PRUEFUNGEN,
  ZUSTAENDE,
  bestand,
  bestandStandort,
  messen,
  standort,
  teilnahme,
  uebergangAnlage,
  uebergangMessen,
  uebergangStandort,
  type Aktion,
  type BestandEingang,
  type FunktionZustand,
  type Komponente,
  type TeilnahmeStand,
} from './uemsFunktion';
import { VORGABE_ZEITZONE, type BoxZustand, type LiefertDatenZustand } from './uemsZustand';

/**
 * Der FUNKTIONS-ZUSTAND je Standort und die TEILNAHME je Anlage (UEMS AP-01
 * IP-1) gegen die EINE geteilte Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/FunktionZustandAbleitungVectorsTest` fährt.
 *
 * Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const VECTORS = resolve(process.cwd(), '../../docs/contracts/v2/funktion-zustand-vectors.json');

type Familie = 'teilnahme' | 'standort' | 'messen' | 'uebergaenge' | 'bestand';

interface Fall {
  name: string;
  familie: Familie;
  ableitung: 'anlage' | 'standort' | 'messen';
  abnahme?: string;
  why: string;
  // Die Eingänge sind snake_case wie die Datei; jede Familie liest ihre eigenen Felder.
  input: any;
  expected: any;
}

interface VectorFile {
  schema_version: string;
  zeitzone: string;
  familien: Familie[];
  abnahmefaelle: string[];
  funktionen: Record<string, string>;
  zustaende: FunktionZustand[];
  zustaende_messen: FunktionZustand[];
  pruefungen: string[];
  aktionen: string[];
  gruende: Record<string, string>;
  cases: Fall[];
}

const vectors: VectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'));

function faelle(familie: Familie, ableitung?: Fall['ableitung']): Fall[] {
  return vectors.cases.filter(
    (c) => c.familie === familie && (ableitung === undefined || c.ableitung === ableitung),
  );
}

interface RohStand {
  anlage: string;
  zustand: FunktionZustand;
  seit: string | null;
  fehlt: string[];
}

const stand = (t: RohStand): TeilnahmeStand => ({
  anlage: t.anlage,
  zustand: t.zustand,
  seit: t.seit,
  fehlt: t.fehlt,
});

interface RohBestand {
  anlage: string;
  betriebsmodell_an: boolean;
  betriebsmodell_seit: string | null;
  eigenverbrauch_laeuft: boolean;
  eigenverbrauch_seit: string | null;
  steuerart_oder_regel_aktiv: boolean;
  steuerart_seit: string | null;
  scharfschaltung: boolean;
}

const bestandEingang = (b: RohBestand): BestandEingang => ({
  anlage: b.anlage,
  betriebsmodellAn: b.betriebsmodell_an,
  betriebsmodellSeit: b.betriebsmodell_seit,
  eigenverbrauchLaeuft: b.eigenverbrauch_laeuft,
  eigenverbrauchSeit: b.eigenverbrauch_seit,
  steuerartOderRegelAktiv: b.steuerart_oder_regel_aktiv,
  steuerartSeit: b.steuerart_seit,
  scharfschaltung: b.scharfschaltung,
});

describe('uemsFunktion · Teilnahme je Anlage (geteilte Vektoren)', () => {
  const cases = faelle('teilnahme', 'anlage');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input;
      const ist = teilnahme({
        anlage: i.anlage,
        aufgenommen: i.aufgenommen,
        eingerichtetAm: i.eingerichtet_am,
        gestartetAm: i.gestartet_am,
        uebernommen: i.uebernommen,
        ruheEintrag: i.ruhe_eintrag,
        beendetAm: i.beendet_am,
        boxen: i.boxen as BoxZustand[],
        hauptzaehler:
          i.hauptzaehler === null
            ? null
            : {
                kennzeichen: i.hauptzaehler.kennzeichen,
                zustand: i.hauptzaehler.zustand as LiefertDatenZustand,
                seit: i.hauptzaehler.seit,
              },
        komponenten: (i.komponenten as Array<Record<string, unknown>>).map(
          (k): Komponente => ({
            name: k.name as string,
            art: k.art as Komponente['art'],
            freigegeben: k.freigegeben as boolean,
            verbindungstestBestanden: k.verbindungstest_bestanden as boolean,
            steuerart: k.steuerart as string | null,
          }),
        ),
        betriebsmodell: i.betriebsmodell,
        grenzePlausibel: i.grenze_plausibel,
        ausfuehrung:
          i.ausfuehrung === null
            ? null
            : {
                laeuft: i.ausfuehrung.laeuft,
                laeuftArt: i.ausfuehrung.laeuft_art,
                laeuftName: i.ausfuehrung.laeuft_name,
                boxBestaetigt: i.ausfuehrung.box_bestaetigt,
              },
        jetzt: i.jetzt,
        zeitzone: i.zeitzone,
      });
      expect({
        zustand: ist.zustand,
        seit: ist.seit,
        pruefliste: ist.pruefliste,
        fehlt: ist.fehlt,
        text: ist.text,
        steuert:
          ist.steuert === null
            ? null
            : {
                zustand: ist.steuert.steuert ? 'steuert' : 'steuert_nicht',
                grund: ist.steuert.grund,
                text: ist.steuert.text,
              },
      }).toEqual(c.expected);
    });
  }
});

describe('uemsFunktion · Standort (geteilte Vektoren)', () => {
  const cases = faelle('standort', 'standort');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      expect(standort((c.input.teilnahmen as RohStand[]).map(stand), c.input.zeitzone)).toEqual(
        c.expected,
      );
    });
  }
});

describe('uemsFunktion · Messen & Auswerten (geteilte Vektoren)', () => {
  const cases = faelle('messen', 'standort');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input;
      const ist = messen({
        standort: i.standort,
        angelegt: i.angelegt,
        standortEingerichtet: i.standort_eingerichtet,
        standortArchiviertAm: i.standort_archiviert_am,
        eingerichtetAm: i.eingerichtet_am,
        boxen: i.boxen as BoxZustand[],
        messstellen: (i.messstellen as Array<Record<string, unknown>>).map((m) => ({
          kennzeichen: m.kennzeichen as string,
          manuell: m.manuell as boolean,
          quelleVorhanden: m.quelle_vorhanden as boolean,
          letzterGuterWert: m.letzter_guter_wert as string | null,
          jeEinWert: m.je_ein_wert as boolean,
          kadenzS: m.kadenz_s as number,
        })),
        registerZeilen: i.register_zeilen as LiefertDatenZustand[],
        anlagen: (i.anlagen as Array<Record<string, unknown>>).map((a) => ({
          name: a.name as string,
          hauptzaehlerAnzahl: a.hauptzaehler_anzahl as number,
        })),
        jetzt: i.jetzt,
        zeitzone: i.zeitzone,
      });
      expect(ist).toEqual(c.expected);
    });
  }
});

describe('uemsFunktion · Übergänge (geteilte Vektoren)', () => {
  const cases = faelle('uebergaenge');

  it('hat Fälle für Anlage, Standort und Messen', () => {
    expect(new Set(cases.map((c) => c.ableitung))).toEqual(new Set(['anlage', 'standort', 'messen']));
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input;
      const aktion = i.aktion as Aktion;
      const ist =
        i.funktion === 'messen'
          ? uebergangMessen(aktion, i.zustand as FunktionZustand)
          : 'teilnahmen' in i
            ? uebergangStandort(aktion, (i.teilnahmen as RohStand[]).map(stand), VORGABE_ZEITZONE)
            : uebergangAnlage(aktion, stand(i.teilnahme as RohStand));
      expect(ist).toEqual(c.expected);
    });
  }
});

describe('uemsFunktion · Bestand (geteilte Vektoren)', () => {
  for (const c of faelle('bestand', 'anlage')) {
    it(`Anlage · ${c.name}`, () => {
      const ist = bestand(bestandEingang(c.input.anlage as RohBestand), c.input.zeitzone);
      expect({ zustand: ist.zustand, gestartet_am: ist.gestartetAm, text: ist.text }).toEqual(
        c.expected,
      );
    });
  }

  for (const c of faelle('bestand', 'standort')) {
    it(`Standort · ${c.name}`, () => {
      expect(
        bestandStandort((c.input.anlagen as RohBestand[]).map(bestandEingang), c.input.zeitzone),
      ).toEqual(c.expected);
    });
  }
});

describe('uemsFunktion · die Datei als Ganzes', () => {
  /** Die Reihenfolge IST die Regel: der „höchste Zustand" ist der letzte. */
  it('das Vokabular ist dasselbe — und in derselben Reihenfolge', () => {
    expect(vectors.zustaende).toEqual([...ZUSTAENDE]);
    expect(vectors.pruefungen).toEqual([...PRUEFUNGEN]);
    expect(vectors.aktionen).toEqual([...AKTIONEN]);
    expect(vectors.gruende).toEqual(GRUND_TEXT);
    expect(vectors.funktionen).toEqual(FUNKTIONEN);
    expect(vectors.zeitzone).toBe(VORGABE_ZEITZONE);
  });

  it('Messen kennt weder „eingerichtet" noch „angehalten"', () => {
    expect(vectors.zustaende_messen).not.toContain('eingerichtet');
    expect(vectors.zustaende_messen).not.toContain('angehalten');
    for (const c of faelle('messen')) {
      expect(vectors.zustaende_messen, c.name).toContain(c.expected.zustand);
    }
  });

  it('jede Familie hat Fälle, jeder genannte Abnahmefall ist gepinnt', () => {
    expect(new Set(vectors.cases.map((c) => c.familie))).toEqual(new Set(vectors.familien));
    const abnahmen = new Set(vectors.cases.map((c) => c.abnahme).filter(Boolean));
    for (const a of vectors.abnahmefaelle) expect(abnahmen, a).toContain(a);
  });

  it('jeder Fall sagt, warum er da ist — und heißt eindeutig', () => {
    for (const c of vectors.cases) expect(c.why, c.name).toBeTruthy();
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.cases.length);
  });
});
