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
import type { GehaeuseAuftragAnsicht, WerkstattFreigabe } from './werkstattBank';

/** Die Hardware der Mango, wie das Gehäuse-Programm sie nennt. */
export const MANGO_HARDWARE = 'GL.iNet GL-MT300N-V2 („Mango“)';

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
