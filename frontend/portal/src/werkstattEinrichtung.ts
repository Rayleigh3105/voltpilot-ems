/**
 * Die Einrichtungs-Detailseite einer Box in der Werkstatt (`#/werkstatt?box=<referenz>`):
 * die reine Schicht dahinter. Sie sagt, was zur Box gehört (Hardware, Fassungen,
 * Netz, Bindung) und welche Gehäuse-Druckdateien das Portal anbietet.
 *
 * Die Druckdateien sind die eingecheckten des Gehäuse-Programms (v0.4,
 * `edge-light/gehaeuse/glinet-gl-mt300n-v2/druck/`), als Kopie im Portal, weil
 * das Portal-Image nur diesen Ordner kennt; `werkstattEinrichtung.test.ts`
 * vergleicht die Kopien mit `SHA256SUMS` des Gehäuses. Das Gehäuse MIT Referenz
 * und QR-Code dieser Box baut der Werkstatt-Dienst nach der Übergabe in seine
 * Ablage; ans Portal reicht es noch nicht.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */
import deckelUrl from './assets/gehaeuse/deckel.3mf?url';
import gehaeuseUrl from './assets/gehaeuse/gehaeuse-v04.3mf?url';
import unterteilUrl from './assets/gehaeuse/unterteil.3mf?url';
import { boxOrt, type FernwartungBox } from './adminFernwartung';
import type { WerkstattAbnahme, WerkstattBox } from './werkstatt';
import type { WerkstattFreigabe } from './werkstattBank';

/** Die Hardware der Mango, wie das Gehäuse-Programm sie nennt. */
export const MANGO_HARDWARE = 'GL.iNet GL-MT300N-V2 („Mango“)';

export interface GehaeuseDatei {
  /** Dateiname beim Herunterladen. */
  name: string;
  /** Adresse im Bündel (Vite hasht sie). */
  url: string;
  titel: string;
  /** Was drin ist. */
  inhalt: string;
  /** Was vom Druck bestätigt ist (Stand `druck/README.md`, v0.4); nichts darüber hinaus behaupten. */
  druckStand: string;
}

/** Die generischen Druckdateien v0.4, ohne Kennung und QR-Code einer Box. */
export const GEHAEUSE_DATEIEN: readonly GehaeuseDatei[] = [
  {
    name: 'gehaeuse-v04.3mf',
    url: gehaeuseUrl,
    titel: 'Gehäuse komplett',
    inhalt: 'Unterteil und Deckel auf einer Platte, ein Drucklauf; Filament 1 weiß, 2 schwarz, 3 hellblau.',
    druckStand: 'Bestätigt ist, was die beiden Einzelteile unten sagen.',
  },
  {
    name: 'unterteil.3mf',
    url: unterteilUrl,
    titel: 'Unterteil',
    inhalt: 'Wanne, Sockel mit Schlüssellöchern, vier Schraubsäulen; weiß.',
    druckStand: 'Gedruckt und bestätigt am 11.10.2026: „sitzt perfekt“.',
  },
  {
    name: 'deckel.3mf',
    url: deckelUrl,
    titel: 'Deckel',
    inhalt: 'Deckel mit Logo, Lichtschacht und Beschriftung in 3,8 mm; weiß, schwarz, hellblau.',
    druckStand: 'Körper gedruckt und bestätigt am 11.10.2026; die Beschriftung wurde nach dem Druck gewählt (12.10.2026).',
  },
];

/** Der Satz über die Dateien: Sie sind nicht die Datei dieser Box. */
export const GEHAEUSE_OHNE_KENNUNG =
  'Allgemeine Gehäuse-Druckdatei (Stand v0.4), ohne Referenz und QR-Code dieser Box. Das Unterteil mit der Kennung dieser Box baut der Werkstatt-Dienst nach der Übergabe in seine Ablage; es liegt dort, nicht im Portal.';

export interface EinrichtungZeile {
  /** Stabiler Schlüssel, auch für Tests. */
  id: string;
  titel: string;
  /** null = unbekannt oder nicht erhoben; die Seite schreibt dann „–“ oder den Grund. */
  wert: string | null;
}

/** Die Freigabe, unter der die Box eingerichtet wurde (aus Abnahme oder Lauf). */
export function freigabeDerBox(
  abnahme: WerkstattAbnahme | null,
  laufFreigabe: string | null | undefined,
  freigaben: readonly WerkstattFreigabe[],
): WerkstattFreigabe | null {
  if (abnahme?.freigabeId) {
    const nachId = freigaben.find((f) => f.id === abnahme.freigabeId);
    if (nachId) return nachId;
  }
  return laufFreigabe ? freigaben.find((f) => f.kennung === laufFreigabe) ?? null : null;
}

/**
 * Was die Einrichtung festhält: aus dem Register (`WerkstattBox`) und der
 * neuesten Abnahme. Fehlt die Abnahme, bleiben ihre Felder leer: Unbekannt ist
 * keine Angabe, und eine nicht abgenommene Box hat keinen geprüften Stand.
 */
export function einrichtung(box: WerkstattBox, freigabe: WerkstattFreigabe | null): EinrichtungZeile[] {
  const a = box.abnahmen[0] ?? null;
  const hardware = box.boxArt === 'edge-light' ? MANGO_HARDWARE : 'Docker-Box (Edge App)';
  return [
    { id: 'hardware', titel: 'Hardware', wert: hardware },
    { id: 'edge-light', titel: 'Edge Light (aufgespielt)', wert: a?.fassung ?? null },
    { id: 'openwrt', titel: 'OpenWrt (laut Freigabe)', wert: freigabe ? freigabe.openwrt.fassung : null },
    { id: 'freigabe', titel: 'Freigabe', wert: freigabe ? freigabe.kennung : null },
    { id: 'lan', titel: 'LAN-Netz der Box', wert: a?.lanNetz ?? box.lanNetz },
    { id: 'tunnel', titel: 'Tunnel-Adresse', wert: a?.tunnelAdresse ?? null },
    { id: 'host', titel: 'Host-Schlüssel', wert: a?.hostSchluessel ?? null },
  ];
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

/** Frühere Abnahmen dieser Box (neueste zuerst im Register; die erste zeigt die Seite voll). */
export function fruehereAbnahmen(box: WerkstattBox): WerkstattAbnahme[] {
  return box.abnahmen.slice(1);
}
