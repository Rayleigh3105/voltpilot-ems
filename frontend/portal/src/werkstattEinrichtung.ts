/**
 * Die Einrichtungs-Detailseite einer Box in der Werkstatt (`#/werkstatt?box=<referenz>`):
 * die reine Schicht dahinter. Sie sagt, was zur Box gehört (Hardware, Fassungen,
 * Netz, Bindung) und welchen Stand die Box-Druckdatei des Gehäuses hat.
 *
 * Die Druckdatei (mit Referenz in Klarschrift und QR-Code dieser Box im Unterteil)
 * baut der Werkstatt-Dienst nach einem Auftrag ohne Fehler selbst und lädt sie zur
 * API hoch (vp-mango-3mf-pro-box); die Karte bietet NUR diese Box-Datei an, nie eine
 * allgemeine ohne Referenz.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */
import { boxOrt, type FernwartungBox } from './adminFernwartung';
import { beschriftung, type WerkstattAbnahme, type WerkstattBox, type WerkstattGehaeuseDatei } from './werkstatt';
import { kurzSha, type GehaeuseAuftragAnsicht, type WerkstattFreigabe, type WerkstattFreigabePfc200 } from './werkstattBank';
import { verlaufZeile, type Fernlauf } from './werkstattFernlauf';

/** Die Hardware der Mango, wie das Gehäuse-Programm sie nennt. */
export const MANGO_HARDWARE = 'GL.iNet GL-MT300N-V2 („Mango“)';
/** Der zweite Gerätetyp der Werkstatt: läuft als Box „Edge Industrie“. */
export const PFC200_HARDWARE = 'WAGO PFC200 750-8212 (Edge Industrie)';

/**
 * Der Stand der Box-Druckdatei für die Karte (automatisch nachholen,
 * vp-mango-3mf-pro-box): `bereit` bietet den Download an. `baut` sagt ehrlich,
 * dass sie noch entsteht - auch eine abgenommene Box ohne Auftrag in der
 * Ansicht (der Dienst reiht sie im eigenen Takt von selbst ein, Abgleich
 * Portal ↔ Ablage; kein Handgriff nötig). `fehler` nennt den Grund und bietet
 * „Erneut erstellen“ an, statt endlos selbst neu zu bauen. `wartet`: die Box
 * ist noch nicht abgenommen.
 */
export type GehaeuseStand =
  | ({ art: 'bereit' } & WerkstattGehaeuseDatei)
  | { art: 'baut'; seit: string | null }
  | { art: 'fehler'; grund: string | null }
  | { art: 'wartet' };

export function gehaeuseStand(
  box: WerkstattBox | null,
  auftraege?: readonly GehaeuseAuftragAnsicht[] | null,
): GehaeuseStand {
  if (box?.gehaeuse) return { art: 'bereit', ...box.gehaeuse };
  const a = box ? auftraege?.find((x) => x.referenz === box.edgeRef) ?? null : null;
  if (a?.zustand === 'fehler') return { art: 'fehler', grund: a.grund ?? null };
  if (a) return { art: 'baut', seit: a.bestellt };
  if (box && box.abnahmen.length > 0) return { art: 'baut', seit: null };
  return { art: 'wartet' };
}

export const GEHAEUSE_WARTET_SATZ =
  'Die Box-Druckdatei (mit Referenz und QR-Code dieser Box) wird nach einem Werkstatt-Lauf ohne Fehler hier abgelegt.';
export const GEHAEUSE_BAUT_SATZ = 'Druckdatei wird erstellt …';
export function gehaeuseFehlerSatz(grund: string | null): string {
  return grund ? `Die Druckdatei konnte nicht erstellt werden: ${grund}` : 'Die Druckdatei konnte nicht erstellt werden.';
}

/**
 * Ein Zubehörteil zum Download (vp-werkstatt-zubehoer-download): ohne Kennung, für jede Box
 * gleich - anders als die Box-Druckdatei des Gehäuses. `teil` ist zugleich das Pfadsegment der
 * Download-Route (`GET /api/v1/admin/werkstatt/zubehoer/{teil}`); `dateiname` der erwartete Name
 * im `Content-Disposition`-Kopf der Antwort. Texte aus `edge-light/gehaeuse/glinet-gl-mt300n-v2/
 * docs/montage.md` und `druck/README.md` - der ehrliche Stand ist nicht erfunden.
 */
export interface ZubehoerTeil {
  teil: 'hutschienen-clip' | 'bohrlehre';
  dateiname: string;
  name: string;
  zweck: string;
  druckhinweis: string;
  stand: string;
}

export const WERKSTATT_ZUBEHOER: readonly ZubehoerTeil[] = [
  {
    teil: 'hutschienen-clip',
    dateiname: 'hutschienen-clip.3mf',
    name: 'Hutschienen-Clip',
    zweck: 'Clip für die Hutschiene TH 35, von hinten mit zwei Schrauben 2,5 × 10 mm angeschraubt.',
    druckhinweis: 'Einfarbig; Material wie in der Druckanleitung.',
    stand: 'Noch nie gedruckt; Federkraft und Halt an der Schiene sind unerprobt.',
  },
  {
    teil: 'bohrlehre',
    dateiname: 'bohrlehre.3mf',
    name: 'Bohrlehre',
    zweck: 'Bohrlehre für die zwei Wandschrauben.',
    druckhinweis: 'Einfarbig; Material wie in der Druckanleitung.',
    stand: 'Noch nie gedruckt; die Wandmontage ist nicht einzeln bestätigt.',
  },
];

export interface EinrichtungZeile {
  /** Stabiler Schlüssel, auch für Tests. */
  id: string;
  titel: string;
  /** null = unbekannt oder nicht erhoben; die Seite schreibt dann „–“ oder den Grund. */
  wert: string | null;
}

/** Die Freigabe, unter der die Box eingerichtet wurde (aus Abnahme oder Lauf); aus der Liste ihres Geräts. */
export function freigabeDerBox<F extends { id: string; kennung: string }>(
  abnahme: WerkstattAbnahme | null,
  laufFreigabe: string | null | undefined,
  freigaben: readonly F[],
): F | null {
  if (abnahme?.freigabeId) {
    const nachId = freigaben.find((f) => f.id === abnahme.freigabeId);
    if (nachId) return nachId;
  }
  return laufFreigabe ? freigaben.find((f) => f.kennung === laufFreigabe) ?? null : null;
}

/** „2026-11-mango-4 · Regel, Release 214“ oder „2026-11-mango-3 · von Hand (Alex)“. */
function freigabeHerkunft(f: Pick<WerkstattFreigabe, 'kennung' | 'quelle' | 'edgeReleaseSeq' | 'erteiltVon'>): string {
  if (f.quelle === 'regel') return `${f.kennung} · Regel${f.edgeReleaseSeq != null ? `, Release ${f.edgeReleaseSeq}` : ''}`;
  return `${f.kennung} · von Hand (${f.erteiltVon})`;
}

/**
 * Was die Einrichtung festhält: aus dem Register (`WerkstattBox`) und der
 * neuesten Abnahme. Fehlt die Abnahme, bleiben ihre Felder leer: Unbekannt ist
 * keine Angabe, und eine nicht abgenommene Box hat keinen geprüften Stand.
 */
export function einrichtung(
  box: WerkstattBox,
  freigabe: WerkstattFreigabe | WerkstattFreigabePfc200 | null,
  erstesVerbinden: ErstesVerbinden | null = null,
  fernlauf: Fernlauf | null = null,
  jetzt: Date = new Date(),
): EinrichtungZeile[] {
  const a = box.abnahmen[0] ?? null;
  const nachDerWerkstatt = fernlaufEinrichtungZeile(fernlauf, jetzt);
  const automatik = erstesVerbindenZeile(erstesVerbinden);
  if (box.boxArt === 'edge-industrie') {
    // Der PFC200: kein OpenWrt (seine Firmware fasst die Werkstatt nicht an), dafür zwei Netze und drei Angaben.
    const f = freigabe && freigabe.openwrt == null ? freigabe : null;
    const angaben = a?.angaben ?? null;
    return [
      { id: 'hardware', titel: 'Hardware', wert: PFC200_HARDWARE },
      { id: 'edge-light', titel: 'Edge Industrie (aufgespielt)', wert: a?.fassung ?? null },
      ...(nachDerWerkstatt ? [nachDerWerkstatt] : []),
      ...(automatik ? [automatik] : []),
      { id: 'firmware', titel: 'Firmware des Geräts (nur gelesen)', wert: angaben?.firmware ?? null },
      { id: 'artikel', titel: 'Bestellnummer', wert: angaben?.artikel ?? null },
      { id: 'seriennummer', titel: 'Seriennummer', wert: angaben?.seriennummer ?? null },
      {
        id: 'pruefsummen',
        titel: 'Prüfsummen (laut Freigabe)',
        wert: f
          ? `Programm ${kurzSha(f.edgeLight.programmSha256)} · Skripte ${kurzSha(f.edgeLight.skripteSha256)} · Tunnel-Programm ${kurzSha(f.edgeLight.wartungSha256)}`
          : null,
      },
      { id: 'freigabe', titel: 'Freigabe', wert: f ? freigabeHerkunft(f) : null },
      { id: 'netz-x1', titel: 'Buchse X1 (Kundennetz)', wert: a ? 'Adresse aus dem Netz des Kunden (DHCP)' : null },
      { id: 'lan', titel: 'Buchse X2 (Anlagennetz)', wert: a?.lanNetz ?? box.lanNetz },
      { id: 'tunnel', titel: 'Tunnel-Adresse', wert: a?.tunnelAdresse ?? null },
      { id: 'host', titel: 'Host-Schlüssel', wert: a?.hostSchluessel ?? null },
    ];
  }
  const hardware = box.boxArt === 'edge-light' ? MANGO_HARDWARE : 'Docker-Box (Edge App)';
  if (freigabe && freigabe.openwrt == null) freigabe = null; // die Zeile eines anderen Geräts sagt hier nichts
  return [
    { id: 'hardware', titel: 'Hardware', wert: hardware },
    { id: 'edge-light', titel: 'Edge Light (aufgespielt)', wert: a?.fassung ?? null },
    ...(nachDerWerkstatt ? [nachDerWerkstatt] : []),
    ...(automatik ? [automatik] : []),
    { id: 'openwrt', titel: 'OpenWrt (laut Freigabe)', wert: freigabe ? freigabe.openwrt.fassung : null },
    {
      id: 'pruefsummen',
      titel: 'Prüfsummen (laut Freigabe)',
      wert: freigabe
        ? `Programm ${kurzSha(freigabe.edgeLight.programmSha256)} · Skripte ${kurzSha(freigabe.edgeLight.skripteSha256)} · OpenWrt ${kurzSha(freigabe.openwrt.sha256)}`
        : null,
    },
    { id: 'freigabe', titel: 'Freigabe', wert: freigabe ? freigabeHerkunft(freigabe) : null },
    { id: 'lan', titel: 'LAN-Netz der Box', wert: a?.lanNetz ?? box.lanNetz },
    { id: 'tunnel', titel: 'Tunnel-Adresse', wert: a?.tunnelAdresse ?? null },
    { id: 'host', titel: 'Host-Schlüssel', wert: a?.hostSchluessel ?? null },
  ];
}

/**
 * Erstverbindung S3 (E7 = A, `GET /api/v1/admin/werkstatt/boxen/{ref}/erstes-verbinden`): was die Automatik beim
 * ersten Verbinden mit der Box tat oder tun wird - aus Journal und Box-Meldung; die Abnahme bleibt, wie sie ist.
 */
export interface ErstesVerbinden {
  stand: 'vorher' | 'prueft' | 'laeuft' | 'fertig' | 'aktuell' | 'nicht';
  release: string | null;
  am: string | null;
  grund: string | null;
}

/** „edge-light-2026.11.13“ → „2026.11.13“: die Fassung, wie die Werkstatt sie nennt. */
const fassung = (release: string | null) => (release ?? '').replace(/^edge-light-/, '').replace(/^edge-/, '') || null;

const tagUhr = (iso: string) =>
  new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

/** Die Zeile „Beim ersten Verbinden“ (vorher) bzw. „Beim Kunden“ (danach); null = keine Aussage der Automatik. */
export function erstesVerbindenZeile(e: ErstesVerbinden | null): EinrichtungZeile | null {
  if (!e) return null;
  const f = fassung(e.release);
  switch (e.stand) {
    case 'vorher':
      return {
        id: 'erstes-verbinden', titel: 'Beim ersten Verbinden',
        wert: f ? `holt sich die neueste Fassung selbst (heute ${f})` : 'holt sich die neueste Fassung selbst',
      };
    case 'prueft':
      return { id: 'beim-kunden', titel: 'Beim Kunden', wert: 'verbunden · die Automatik entscheidet gerade' };
    case 'laeuft':
      return { id: 'beim-kunden', titel: 'Beim Kunden', wert: `holt gerade ${f ?? 'die neueste Fassung'} · automatisch beim ersten Verbinden` };
    case 'fertig':
      return {
        id: 'beim-kunden', titel: 'Beim Kunden',
        wert: `✓ ${e.am ? `${tagUhr(e.am)} ` : ''}auf ${f ?? 'die neueste Fassung'} · automatisch beim ersten Verbinden`,
      };
    case 'aktuell':
      return { id: 'beim-kunden', titel: 'Beim Kunden', wert: `lief schon ${f ?? 'die neueste Fassung'} · nichts zu tun` };
    case 'nicht':
      return { id: 'beim-kunden', titel: 'Beim Kunden', wert: `nicht aktualisiert${e.grund ? `: ${e.grund}` : ''}` };
  }
}

/**
 * Die Zeile „Nach der Werkstatt“ (Fernlauf S3, §4.6): der letzte Fernlauf durch den Wartungstunnel für
 * diese Box, in derselben Sprache wie die Karte „Durch den Tunnel aufspielen“ der Akte; `null` ohne einen.
 */
export function fernlaufEinrichtungZeile(f: Fernlauf | null, jetzt: Date): EinrichtungZeile | null {
  if (!f) return null;
  const { text, wann } = verlaufZeile(f, jetzt);
  return { id: 'fernlauf', titel: 'Nach der Werkstatt', wert: `${text} · ${wann}` };
}

/** Die Bindung: Tunnel-Schlüssel, Zugang, Kunde. `null` = für die Box ist kein Tunnel-Schlüssel hinterlegt (404), also auch kein Kunde. */
export function bindung(fw: FernwartungBox | null): EinrichtungZeile[] {
  if (!fw) {
    return [
      { id: 'tunnel-schluessel', titel: 'Tunnel-Schlüssel', wert: 'nicht hinterlegt' },
      { id: 'ort', titel: 'Kunde und Anlage', wert: 'noch nicht gekoppelt' },
    ];
  }
  return [
    { id: 'tunnel-schluessel', titel: 'Tunnel-Schlüssel', wert: fw.publicKeyKurz },
    { id: 'zugang', titel: 'Fernwartungs-Zugang', wert: fw.status === 'aktiv' ? 'aktiv' : 'gesperrt' },
    { id: 'ort', titel: 'Kunde und Anlage', wert: boxOrt(fw) },
  ];
}

/**
 * Ob der Kunde die Box schon eingerichtet hat (Claim über den QR-Einstieg), aus `kunde` der
 * Werkstatt-API. Ohne Register-Eintrag oder bei einer API ohne das Feld: unbekannt, nie „offen“.
 * `link` ist genau die Adresse des QR-Codes auf dem Gehäuse (`beschriftung`).
 */
export type KundenStand =
  | { art: 'unbekannt' }
  | { art: 'offen'; link: string }
  | { art: 'eingerichtet'; mandant: string; anlage: string | null; seit: string };

export function kundenStand(box: WerkstattBox | null, ref: string): KundenStand {
  if (!box || box.kunde === undefined) return { art: 'unbekannt' };
  if (box.kunde === null) return { art: 'offen', link: beschriftung(ref).link };
  return { art: 'eingerichtet', mandant: box.kunde.mandant, anlage: box.kunde.anlage, seit: box.kunde.seit };
}

/** Frühere Abnahmen dieser Box (neueste zuerst im Register; die erste zeigt die Seite voll). */
export function fruehereAbnahmen(box: WerkstattBox): WerkstattAbnahme[] {
  return box.abnahmen.slice(1);
}
