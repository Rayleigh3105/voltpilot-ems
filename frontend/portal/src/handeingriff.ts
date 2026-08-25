/**
 * Die HANDEINGRIFFE der Jetzt-Zone (Steuerung Stufe 4, Konzept
 * `vp-steuerung-konzept-b3` §3.2 + §3.5 + §3.7 B2/B4/B5; Captain-Entscheid
 * S1 = A): „Speicher jetzt laden", „Ladestand halten" und „Automatik
 * pausieren" — jeweils mit der Folgen-Karte DAVOR und dem Beleg danach.
 *
 * PURE + unit-getestet (`handeingriff.test.ts`); die Fläche rendert nur.
 *
 * **⚠ Die ZAHL der Folgen-Karte ist die einzige Stelle, an der hier gerechnet
 * wird — und sie wird NIE erfunden.** Sie kommt aus den Fahrplan-Slots bis zum
 * gewählten Ende (`batteryKw` × Slotlänge × `importPriceCtKwh`), also aus
 * derselben Antwort, die das Diagramm zeichnet. Fehlt der Plan oder fehlt der
 * Preis, steht dort wörtlich „nicht abschätzbar" mit dem GRUND — die
 * Echtheits-Regel des Hauses.
 */
import type { ScheduleSlot } from './api';
import { fmtNum } from './format';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Was ein Speicher-Eingriff sein kann (S1 = A: genau diese zwei). */
export type SpeicherAktion = 'speicher_laden' | 'speicher_halten';

/** Jede Handlung, die eine Zeile oder das Banner anbieten kann. */
export type HandeingriffAktion = SpeicherAktion | 'pause' | 'resume';

export const HANDEINGRIFF_LABEL: Record<HandeingriffAktion, string> = {
  speicher_laden: 'Speicher jetzt laden',
  speicher_halten: 'Ladestand halten',
  pause: 'Automatik pausieren',
  resume: 'Automatik fortsetzen',
};

/**
 * Die angebotenen Dauern (§3.2). „Bis morgen früh" ist bewusst dabei: es ist
 * die Dauer, nach der ein Mensch fragt — und sie ist erst seit der
 * cloud-seitigen Erneuerung (B6) ehrlich anbietbar.
 */
export interface DauerOption {
  key: string;
  label: string;
  /** Minuten; null = ein absoluter Zeitpunkt (siehe `bisMorgenFrueh`). */
  minutes: number | null;
}

export const DAUERN: DauerOption[] = [
  { key: '30m', label: '30 Minuten', minutes: 30 },
  { key: '1h', label: '1 Stunde', minutes: 60 },
  { key: '2h', label: '2 Stunden', minutes: 120 },
  { key: '4h', label: '4 Stunden', minutes: 240 },
  { key: 'morgen', label: 'Bis morgen früh (06:00)', minutes: null },
];

/**
 * „Bis morgen früh" als absoluter Zeitpunkt. Der SERVER rechnet dieselbe
 * Arithmetik noch einmal (`Handeingriff.bisMorgenFrueh`) — hier steht sie nur,
 * damit die Vorschau schon vor dem Klick die richtige Uhrzeit nennen kann.
 */
export function bisMorgenFrueh(now: Date, stunde = 6): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(stunde, 0, 0, 0);
  return d;
}

/** Das Ende einer gewählten Dauer — die EINE Auflösung für Vorschau und Aufruf. */
export function endeVon(option: DauerOption, now: Date): Date {
  return option.minutes == null
    ? bisMorgenFrueh(now)
    : new Date(now.getTime() + option.minutes * 60_000);
}

// ---------------------------------------------------------------------------
// Die Zahl der Folgen-Karte
// ---------------------------------------------------------------------------

/** Was der Fahrplan im gewählten Fenster vorhatte — oder warum es unbekannt ist. */
export interface PlanVerzicht {
  /** Entladene kWh, die entfallen (>= 0). null = nicht bestimmbar. */
  entladenKwh: number | null;
  /** Geladene kWh, die entfallen (>= 0). null = nicht bestimmbar. */
  geladenKwh: number | null;
  /** Der Geldwert des Verzichts in EUR (>= 0). null = nicht bestimmbar. */
  eur: number | null;
  /** Warum es keine Zahl gibt — nur gesetzt, wenn `eur` null ist. */
  grund: string | null;
}

/** Der Grund, wenn gar kein Plan vorliegt (§3.2 wörtlich). */
export const KEIN_FAHRPLAN = 'nicht abschätzbar — es liegt kein Fahrplan vor.';

/** Der Grund, wenn der Plan das Fenster nicht abdeckt. */
export const PLAN_ZU_KURZ =
  'nicht abschätzbar — der Fahrplan reicht nicht bis zum gewählten Ende.';

/** Der Grund, wenn kein Bezugspreis mitgeliefert wurde. */
export const KEIN_PREIS =
  'nicht abschätzbar — für diesen Zeitraum liegt kein Strompreis vor.';

const SLOT_STUNDEN = 0.25;

/**
 * Was der Fahrplan zwischen `now` und `ende` mit dem Speicher vorhatte.
 *
 * ⚠ Gewertet werden nur Slots, die GANZ im Fenster liegen bzw. deren Beginn
 * hineinfällt — eine anteilige Verrechnung des laufenden Slots wäre eine
 * Genauigkeit, die die Datenlage nicht hergibt. Und: **ein Slot ohne Preis
 * macht die GANZE Zahl unbestimmbar**, statt still mit weniger Slots zu
 * rechnen (das ergäbe eine zu kleine Zahl, die wie eine echte aussieht).
 */
export function planVerzicht(
  slots: ScheduleSlot[] | null | undefined,
  now: Date,
  ende: Date,
): PlanVerzicht {
  const leer = (grund: string): PlanVerzicht =>
    ({ entladenKwh: null, geladenKwh: null, eur: null, grund });
  if (!slots || slots.length === 0) return leer(KEIN_FAHRPLAN);

  const von = now.getTime();
  const bis = ende.getTime();
  const im: ScheduleSlot[] = [];
  let letzterBeginn = -Infinity;
  for (const s of slots) {
    const t = Date.parse(s.start);
    if (!Number.isFinite(t)) continue;
    letzterBeginn = Math.max(letzterBeginn, t);
    if (t >= von - SLOT_STUNDEN * 3_600_000 && t < bis) im.push(s);
  }
  if (im.length === 0) return leer(KEIN_FAHRPLAN);
  // Deckt der Plan das Fenster überhaupt ab? Sein letzter Slot muss bis zum
  // Ende reichen, sonst wäre die Summe nur ein Teil des Verzichts.
  if (letzterBeginn + SLOT_STUNDEN * 3_600_000 < bis) return leer(PLAN_ZU_KURZ);

  let entladen = 0;
  let geladen = 0;
  let eur = 0;
  for (const s of im) {
    const kw = s.batteryKw;
    if (kw == null || !Number.isFinite(kw)) continue;
    const kwh = Math.abs(kw) * SLOT_STUNDEN;
    if (kw < 0) entladen += kwh;
    else geladen += kwh;
    const preis = s.importPriceCtKwh;
    if (preis == null || !Number.isFinite(preis)) return leer(KEIN_PREIS);
    // Eine ENTLADUNG spart Netzbezug, eine LADUNG kostet ihn - der Verzicht
    // auf beides ist der Betrag, den der Plan im Fenster bewegt hätte.
    eur += (kwh * preis) / 100;
  }
  if (entladen === 0 && geladen === 0) {
    return { entladenKwh: 0, geladenKwh: 0, eur: 0, grund: null };
  }
  return { entladenKwh: entladen, geladenKwh: geladen, eur, grund: null };
}

// ---------------------------------------------------------------------------
// Die Folgen-Karte (§3.5: vier feste Blöcke, das Haus-Muster)
// ---------------------------------------------------------------------------

export interface FolgenBlock {
  key: 'passiert' | 'fahrplan' | 'risiko' | 'gleich' | 'ende';
  titel: string;
  zeilen: string[];
}

export interface HandeingriffFolgen {
  titel: string;
  intro: string;
  bloecke: FolgenBlock[];
  bestaetigen: string;
}

const BLOCK_TITEL: Record<FolgenBlock['key'], string> = {
  passiert: 'Das passiert',
  fahrplan: 'Auswirkung auf den Fahrplan',
  risiko: 'Risiko',
  gleich: 'Das bleibt gleich',
  ende: 'Ende / Rücknahme',
};

/**
 * ⚠ Der „bleibt gleich"-Block ist keine Beruhigung, sondern eine
 * Konstruktions-Aussage: § 14a, die Einspeise-Wache, die Abregelung und der
 * Geräteschutz liegen UNTERHALB der Arbitrierung in der Guard-Kette — ein
 * Handeingriff kann sie strukturell nicht erreichen.
 */
export const BLEIBT_GLEICH: string[] = [
  'Netzvorgaben Ihres Netzbetreibers (§ 14a) und die Einspeisegrenze.',
  'Die Abregelung bei negativen Preisen.',
  'Der Geräteschutz Ihrer Anlage — Nennleistung, Ladestand-Grenzen, Mindestpausen.',
];

/** Der Verzicht als Satz — mit Zahl, wenn es eine gibt, sonst mit dem GRUND. */
export function verzichtSatz(v: PlanVerzicht): string {
  if (v.grund) return `Auswirkung ${v.grund}`;
  const teile: string[] = [];
  if ((v.entladenKwh ?? 0) > 0.05) {
    teile.push(`${fmtNum(v.entladenKwh as number, 'kWh', 1)} geplante Entladung`);
  }
  if ((v.geladenKwh ?? 0) > 0.05) {
    teile.push(`${fmtNum(v.geladenKwh as number, 'kWh', 1)} geplante Ladung`);
  }
  if (teile.length === 0) {
    return 'Der Fahrplan hatte in dieser Zeit ohnehin nichts mit dem Speicher vor.';
  }
  const geld = (v.eur ?? 0) >= 0.005
    ? ` (≈ ${fmtNum(v.eur as number, '€', 2)})`
    : '';
  return `Der Fahrplan hätte ${teile.join(' und ')} vorgenommen${geld} — das entfällt.`;
}

export interface FolgenInput {
  aktion: HandeingriffAktion;
  /** Das gewählte Ende, als Uhrzeit-Text („18:00 Uhr"). */
  endeText: string;
  /** Der Ladestand jetzt, in Prozent; null = nicht gemeldet. */
  socPct?: number | null;
  /** Die wirksame Ladeleistung („lädt mit bis zu X kW"); null = unbekannt. */
  leistungKw?: number | null;
  verzicht: PlanVerzicht;
}

/** Die Folgen-Karte VOR dem Klick — vier feste Blöcke, nie eine erfundene Zahl. */
export function handeingriffFolgen(input: FolgenInput): HandeingriffFolgen {
  const stand = input.socPct != null && Number.isFinite(input.socPct)
    ? ` (${fmtNum(input.socPct, '%', 0)})`
    : '';
  let passiert: string[];
  let risiko: string[];
  let titel: string;
  if (input.aktion === 'speicher_halten') {
    titel = 'Ladestand halten';
    passiert = [
      `Der Speicher lädt und entlädt nicht mehr — sein Ladestand${stand} bleibt bis `
      + `${input.endeText} stehen.`,
    ];
    risiko = ['Ihr Haus bezieht in dieser Zeit aus Solar und Netz.'];
  } else if (input.aktion === 'speicher_laden') {
    const leistung = input.leistungKw != null && Number.isFinite(input.leistungKw)
      ? ` mit bis zu ${fmtNum(input.leistungKw, 'kW', 1)}`
      : '';
    titel = 'Speicher jetzt laden';
    passiert = [
      `Der Speicher lädt${leistung} bis ${input.endeText}.`,
      'Aus dem Netz wird dabei nur geladen, wenn Ihre Anlage das darf — sonst nur '
      + 'aus Ihrem Solar-Überschuss.',
    ];
    risiko = ['Ein voller Speicher kann später weniger Solarstrom aufnehmen.'];
  } else if (input.aktion === 'pause') {
    titel = 'Automatik pausieren';
    passiert = [
      `Fahrplan und Regeln ruhen bis ${input.endeText}.`,
      'Ihr Speicher versorgt in dieser Zeit einfach Ihr Haus (Eigenverbrauch), '
      + 'schaltbare Geräte gehen in ihren sicheren Zustand.',
    ];
    risiko = ['Günstige Stunden und geplante Erlöse in dieser Zeit entfallen.'];
  } else {
    titel = 'Automatik fortsetzen';
    passiert = ['Der Eingriff endet sofort. Fahrplan und Regeln übernehmen wieder.'];
    risiko = [];
  }

  const bloecke: FolgenBlock[] = [
    { key: 'passiert', titel: BLOCK_TITEL.passiert, zeilen: passiert },
  ];
  if (input.aktion !== 'resume') {
    bloecke.push({
      key: 'fahrplan',
      titel: BLOCK_TITEL.fahrplan,
      zeilen: [verzichtSatz(input.verzicht)],
    });
    bloecke.push({ key: 'risiko', titel: BLOCK_TITEL.risiko, zeilen: risiko });
  }
  bloecke.push({ key: 'gleich', titel: BLOCK_TITEL.gleich, zeilen: [...BLEIBT_GLEICH] });
  bloecke.push({
    key: 'ende',
    titel: BLOCK_TITEL.ende,
    zeilen: input.aktion === 'resume'
      ? ['Sie können jederzeit wieder eingreifen.']
      : [`Endet automatisch um ${input.endeText}; Sie können jederzeit früher beenden.`],
  });
  return {
    titel,
    intro: HANDEINGRIFF_LABEL[input.aktion],
    bloecke,
    bestaetigen: HANDEINGRIFF_LABEL[input.aktion],
  };
}

// ---------------------------------------------------------------------------
// Welche Handlungen eine Zeile anbietet
// ---------------------------------------------------------------------------

export interface SpeicherAktionenInput {
  /** Läuft schon ein Handeingriff am Speicher? */
  laufend: boolean;
  /** Ist die Steuerung dieses Speichers überhaupt scharfgeschaltet? */
  steuerbar: boolean;
  /** Pausiert die ganze Anlage gerade? */
  pausiert: boolean;
}

/**
 * ⚠ Ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten —
 * an seiner Stelle steht der Grund (die Haus-Regel des Portal-Apply). Während
 * einer Anlagen-Pause gibt es am Speicher nichts einzeln zu greifen: die Pause
 * ist der Eingriff, und der Weg zurück ist ihr eigener Knopf.
 */
export function speicherAktionen(i: SpeicherAktionenInput): HandeingriffAktion[] {
  // ⚠ Die Reihenfolge ist eine AUSSAGE: ein LAUFENDER Eingriff bietet IMMER
  // seinen Rückweg an, auch wenn die Anlage inzwischen nicht mehr steuerbar
  // wirkt. Wer eingegriffen hat, muss ihn zurücknehmen können - eine
  // gefangene Handlung wäre schlimmer als gar keine (im Browser-Beweis
  // aufgefallen, nicht im Unit-Test).
  if (i.laufend) return ['resume'];
  if (!i.steuerbar || i.pausiert) return [];
  return ['speicher_laden', 'speicher_halten'];
}

/** Warum es am Speicher gerade keinen Eingriff gibt — nur wenn es keinen gibt. */
export function speicherKeinEingriff(i: SpeicherAktionenInput): string | null {
  if (i.laufend) return null; // der Rückweg steht - es gibt nichts zu erklären
  if (i.pausiert) {
    return 'Die Automatik pausiert gerade — der Speicher versorgt Ihr Haus.';
  }
  if (!i.steuerbar) {
    return 'VoltPilot steuert diesen Speicher noch nicht — ein Eingriff käme nicht an.';
  }
  return null;
}

/** Der Banner-Satz einer laufenden Anlagen-Pause. */
export function pauseBanner(bisText: string, rest: string | null): string {
  const restText = rest ? ` (noch ${rest})` : '';
  return `Automatik pausiert bis ${bisText}${restText}`;
}
