/**
 * WOHER der Ladestand kommt - die EINE Wahrheit über `soc_source_code`
 * (P5b Ebene 2, Konzept `vp-deye-diybms-luecke-l5` §3.2b; Fläche P5d).
 *
 * Die Ehrlichkeitsregel des Konzepts lautet: „`soc_source` reist mit,
 * Optimierer und jede Fläche zeigen es." Damit Cockpit, Geräteseite und
 * Fahrplan nicht DREI Formulierungen für dieselbe Tatsache entwickeln, wohnt
 * das Wort hier - einmal.
 *
 * ⚠ **Warum ein CODE und kein Wort:** die Telemetrie-Kanäle sind per Vertrag
 * ZAHLEN. Ein Wort hätte einen Umbau der ganzen Ingest-Kette gebraucht; der
 * Code reist durch die bewiesene Kette unverändert und steht JE MESSZEITPUNKT
 * in der Historie - die Historie behält also die DAMALIGE Quelle.
 *
 * ⚠ **Es gibt bewusst keine 0 für „unbekannt".** Ein unbekannter Ladestand ist
 * ein ABWESENDER Kanal, nie eine gemeldete Null - und ein Code außerhalb des
 * Vokabulars wird VERWORFEN, nie geraten.
 */

/** Der Telemetrie-Kanal, der die Herkunft trägt. */
export const SOC_HERKUNFT_KANAL = 'soc_source_code';

export const SOC_CODE_GEMESSEN = 1;
export const SOC_CODE_KENNLINIE = 2;
export const SOC_CODE_LADUNGSZAEHLUNG = 3;

export type SocHerkunft = {
  code: number;
  /** Das kurze Wort neben der Zahl („gemessen", „berechnet: Kennlinie"). */
  kurz: string;
  /** Der ganze Satz für ein Tooltip / eine Fußzeile. */
  lang: string;
  /** true = gerechnet, nicht gemessen. Die Unterscheidung, auf die es ankommt. */
  berechnet: boolean;
};

const HERKUENFTE: Record<number, SocHerkunft> = {
  [SOC_CODE_GEMESSEN]: {
    code: SOC_CODE_GEMESSEN,
    kurz: 'gemessen',
    lang: 'Dieser Ladestand kommt als Messung aus Ihrem Batteriemanagement.',
    berechnet: false,
  },
  [SOC_CODE_KENNLINIE]: {
    code: SOC_CODE_KENNLINIE,
    kurz: 'berechnet: Kennlinie',
    lang:
      'Dieser Ladestand ist aus der Zellspannung über die Kennlinie Ihrer Zelle berechnet, '
      + 'nicht gemessen - er ist eine gute Schätzung, keine Messung.',
    berechnet: true,
  },
  [SOC_CODE_LADUNGSZAEHLUNG]: {
    code: SOC_CODE_LADUNGSZAEHLUNG,
    kurz: 'berechnet: Ladungszählung',
    lang:
      'Dieser Ladestand ist ab einem Startpunkt mitgezählt, nicht gemessen - ohne '
      + 'Nachkalibrierung läuft er mit der Zeit auseinander.',
    berechnet: true,
  },
};

/**
 * Die Herkunft zu einem Code - oder `null`.
 *
 * `null` heißt „nicht bekannt" und darf NIE als „gemessen" gelesen werden: die
 * allermeisten Batterien (jede über einen Katalog-Treiber gelesene) melden
 * diesen Kanal gar nicht, und eine Kachel, die dort „gemessen" schriebe, hätte
 * sich das ausgedacht.
 */
export function socHerkunft(code: number | null | undefined): SocHerkunft | null {
  if (code == null || !Number.isFinite(code)) return null;
  return HERKUENFTE[Math.round(code)] ?? null;
}

/** Eine Fähigkeitszeile, wie das Topologie-Lesemodell sie liefert. */
type Kanal = { channel: string; value?: number | null };

/**
 * Die Herkunft aus den Fähigkeiten EINER Entität.
 *
 * ⚠ Ein abwesender Kanal und ein Kanal ohne frischen Wert sind dasselbe
 * Ergebnis: `null`. Beides heißt „wir wissen es nicht", und das ist eine
 * ehrliche Auskunft - im Gegensatz zu einem geratenen „gemessen".
 */
export function herkunftAusKanaelen(kanaele: Kanal[] | null | undefined): SocHerkunft | null {
  if (!kanaele) return null;
  const k = kanaele.find((c) => c.channel === SOC_HERKUNFT_KANAL);
  return k ? socHerkunft(k.value) : null;
}

/**
 * Die Herkunft über MEHRERE Entitäten (der Speicher-Knoten kann mehrere
 * Mitglieder haben).
 *
 * ⚠ Uneinigkeit gewinnt NICHT still: melden zwei Batterien verschiedene
 * Herkünfte, ist das Ergebnis der GERECHNETE der beiden - ein Speicherstand,
 * der teilweise geschätzt ist, ist als Ganzes geschätzt. Nach oben zu runden
 * („eine ist gemessen, also gemessen") wäre genau die Beschönigung, die diese
 * Kennzeichnung verhindern soll.
 */
export function herkunftUeberEntitaeten(
  listen: (Kanal[] | null | undefined)[],
): SocHerkunft | null {
  const gefunden = listen
    .map((k) => herkunftAusKanaelen(k))
    .filter((h): h is SocHerkunft => h != null);
  if (gefunden.length === 0) return null;
  return gefunden.find((h) => h.berechnet) ?? gefunden[0];
}
