/**
 * Werkstatt: die reine Schicht hinter „Geräte › Werkstatt“ (Formen der API,
 * die Prüfungen der Werkstatt-Regel, die Beschriftung des Gehäuses).
 *
 * Seit der Werkstatt-Automatik (WI-8 A) richtet der Werkstatt-Dienst die Box
 * ein, jeden Schritt mit Beleg; die Bildschirme dazu leitet `werkstattBank.ts`
 * ab. Die Handschritte am eigenen Rechner (Befehle, Passwort im Browser,
 * Probe-Knöpfe) gibt es im Portal nicht mehr.
 *
 * Bleibende Entscheide vom 26.10.2026: 5c keine Box mit Stufe 1 an einen
 * Kunden; 8 Referenz und QR-Code werden aufs Gehäuse gedruckt.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */
import { kennungWieGedruckt, koppelLink } from './koppelLink';

// ── Formen der API (/api/v1/admin/werkstatt) ────────────────────────────────

export type BoxArt = 'edge-light' | 'edge-app' | 'edge-industrie';

/** Wie das Gerät einer Box des Registers kurz heißt (Listen): die Mango, der WAGO PFC200 (Edge Industrie), sonst die Docker-Box. */
export function geraetName(boxArt: string): string {
  if (boxArt === 'edge-light') return 'Mango';
  if (boxArt === 'edge-industrie') return 'PFC200';
  return 'Docker-Box';
}

export interface WerkstattSchrittStand {
  /** ISO-Zeit, zu der der Haken gesetzt wurde. */
  am: string;
  von: string;
}

/** Was das Portal über das Fenster der Werkstatt-Probe wusste; null = keine Meldung nannte es. */
export interface WerkstattProbeBeleg {
  fensterId: string;
  technikerName: string;
  grund: string;
  beginn: string;
  ende: string;
  geschlossenAm: string | null;
  geschlossenVon: string | null;
  schluesselAbgeholtUm: string | null;
  gemeldetAm: string | null;
}

export interface WerkstattAbnahme {
  id: string;
  edgeRef: string;
  hostSchluessel: string;
  fassung: string;
  tunnelAdresse: string;
  lanNetz: string;
  pruefungen: string[];
  probe: WerkstattProbeBeleg;
  notiz: string | null;
  erfasstAm: string;
  erfasstVon: string;
  /** `hand` (Haken im Portal) oder `dienst` (Belege des Werkstatt-Dienstes, WI-7 A). */
  quelle?: 'hand' | 'dienst';
  /** Je Prüfung der Beleg des Dienstes; null bei `hand`. */
  belege?: Record<string, string> | null;
  freigabeId?: string | null;
  einloesungId?: string | null;
  /** Das Root-Passwort, mit age verschlüsselt; nur der Betreiber kann es lesen. */
  passwortAge?: string | null;
  /**
   * true: ein Werkstatt-Dienst vor S1 (PR #1885) hat ohne den Beleg
   * `einrichtung_wlan_bereit` abgenommen (Übergangsfrist bis 13.12.2026);
   * fehlt bei einer API vor diesem Feld.
   */
  dienstFassungVorEinrichtungWlan?: boolean;
}

export interface WerkstattBox {
  id: string;
  edgeRef: string;
  boxArt: BoxArt;
  /** Die LAN-Adresse der Box mit Präfix, sobald sie festgehalten ist (Entscheid 6a). */
  lanNetz: string | null;
  schritte: Record<string, WerkstattSchrittStand>;
  notiz: string | null;
  angelegtAm: string;
  angelegtVon: string;
  geaendertAm: string;
  /** Neueste zuerst; leer = noch nicht abgenommen. */
  abnahmen: WerkstattAbnahme[];
  /**
   * Was das Löschen sperrt, in Worten (Abnahme, Zertifikat, Kunde, Vorab-Registrierung); leer = die
   * Box lässt sich löschen. Fehlt bei einer API vor dieser Route.
   */
  inGebrauch?: string[];
  /**
   * Was beim Löschen mitgeht, in Worten (Tunnel-Schlüssel mit Adresse, offene Fenster, Codes,
   * Geräteschlüssel, Zertifikatsanfrage); leer = nur der Eintrag im Register. Fehlt bei einer API vor
   * diesem Feld.
   */
  loeschtMit?: string[];
  /**
   * Wer die Box über den QR-Einstieg eingerichtet hat (Claim); null = noch kein Kunde. Fehlt bei
   * einer API vor diesem Feld: dann ist es unbekannt, nicht „kein Kunde“.
   */
  kunde?: WerkstattKunde | null;
  /**
   * Die Box-Druckdatei des Gehäuses (vp-mango-3mf-pro-box, mit Referenz und QR-Code
   * dieser Box), vom Werkstatt-Dienst hochgeladen; null = noch keine Datei im Portal.
   * Fehlt bei einer API vor diesem Feld.
   */
  gehaeuse?: WerkstattGehaeuseDatei | null;
}

/** Der Kunde einer Box: Mandant, Anlage (null = ohne Anlage), seit wann (ISO). */
export interface WerkstattKunde {
  mandant: string;
  anlage: string | null;
  seit: string;
}

/** Die Box-Druckdatei des Gehäuses, wie die API sie nennt. */
export interface WerkstattGehaeuseDatei {
  name: string;
  sha256: string;
  bytes: number;
  hochgeladenAm: string;
}

/**
 * Ob die Seite „Löschen“ anbietet: für jede Box, die die API löschen lässt - keine Abnahme und
 * `inGebrauch` leer (nicht gekoppelt, kein Kunde). Fehlt die Angabe, nie.
 */
export function loeschbar(box: WerkstattBox | null): boolean {
  return box != null && box.abnahmen.length === 0 && Array.isArray(box.inGebrauch) && box.inGebrauch.length === 0;
}

/** Ob mit der Box ein Tunnel-Schlüssel geht (die API nennt ihn in `loeschtMit`). */
export function loeschtTunnelSchluessel(box: WerkstattBox): boolean {
  return (box.loeschtMit ?? []).some((w) => w.includes('Tunnel-Schlüssel'));
}

// ── Die Prüfungen der Werkstatt-Regel ──────────────────────────────────────

/** Zwilling von `WerkstattPruefungen.java`; Vektor: `docs/contracts/werkstatt-pruefungen.json`. */
export const PRUEFUNGEN = [
  { id: 'root_passwort', text: 'Root-Passwort gesetzt: je Box ein eigenes, zufällig erzeugt, in der Passwortablage' },
  { id: 'notfall_schluessel', text: 'Genau ein dauerhafter Schlüssel auf der Box, und sein Fingerabdruck ist der des Notfall-Schlüssels' },
  { id: 'tunnel_status', text: 'Tunnel eingerichtet: Handshake, SSH 2222 außerhalb der Tunnel abgewiesen, Abholer läuft' },
  { id: 'anmeldeprobe', text: 'Anmeldung über Portal und Tunnel im Fenster der Werkstatt-Probe gelungen' },
  { id: 'host_schluessel', text: 'Host-Schlüssel auf zwei Wegen gelesen und gleich' },
  { id: 'fenster_zu', text: 'Fenster geschlossen, der neue Versuch endet mit Connection timed out' },
  { id: 'lan_netz', text: 'LAN der Box auf ein unübliches Netz gestellt' },
  { id: 'neustart', text: 'Neustart-Probe: Tunnel wieder oben, dieselbe Referenz, ein dauerhafter Schlüssel' },
  {
    id: 'update_bereit',
    text: 'Update-bereit: signierte Fassung als bestätigter Stand, Vertrauens-Set geprüft, Box-Art Edge Light',
  },
  { id: 'einrichtung_wlan_bereit', text: 'Einrichtungs-WLAN bereit: Funkmodul auf Land DE, Paket relayd auf der Box' },
] as const;

export type PruefungId = (typeof PRUEFUNGEN)[number]['id'];

/**
 * Die Prüfungen für den WAGO PFC200 (Edge Industrie): `geraete.pfc200` im selben Vektor, Zwilling von
 * `WerkstattPruefungen.PFC200`. Ohne Prüfung der SPS und der Firmware; ihr Stand steht als Angabe an der Abnahme.
 */
export const PRUEFUNGEN_PFC200 = [
  { id: 'zugaenge', text: 'Drei eigene Passwörter gesetzt (root, admin, user), jedes Werkspasswort abgewiesen, Anmeldung mit Passwort aus' },
  { id: 'notfall_schluessel', text: 'Genau ein dauerhafter Schlüssel auf dem Gerät, und sein Fingerabdruck ist der des Notfall-Schlüssels' },
  { id: 'tunnel_status', text: 'Tunnel eingerichtet: Handshake, Port 2222 nur im Tunnel, Abholer läuft' },
  { id: 'anmeldeprobe', text: 'Anmeldung über Portal und Tunnel im Fenster der Werkstatt-Probe gelungen' },
  { id: 'host_schluessel', text: 'Host-Schlüssel auf zwei Wegen gelesen und gleich' },
  { id: 'fenster_zu', text: 'Fenster geschlossen, der neue Versuch endet mit Connection timed out' },
  { id: 'netze', text: 'Buchsen getrennt: X1 Kundennetz, X2 Anlagennetz, keine Weiterleitung' },
  { id: 'dienste_zu', text: 'Firewall ein, nur die Soll-Dienste offen, Docker aus, Start nur vom internen Speicher' },
  { id: 'neustart', text: 'Neustart-Probe: Tunnel wieder oben, dieselbe Referenz, derselbe Host-Schlüssel, Schalter auf RUN' },
  { id: 'update_bereit', text: 'Update-bereit: signierte Fassung als bestätigter Stand, Vertrauens-Set geprüft, Box-Art Edge Industrie' },
] as const;

/** Die Prüfliste eines Geräts der Werkstatt (`pfc200`; sonst die Mango). */
export function pruefungenFuer(geraet: string | null | undefined): readonly { id: string; text: string }[] {
  return geraet === 'pfc200' ? PRUEFUNGEN_PFC200 : PRUEFUNGEN;
}

// ── Beschriftung des Gehäuses (Entscheid 8, geändert am 26.10.2026) ─────────

export interface Beschriftung {
  /** Die Referenz, wie sie gedruckt wird: Die Strichschrift des Gehäuses kennt nur Großbuchstaben. */
  klartext: string;
  /** Der Inhalt des QR-Codes: der Direktlink ins Portal. */
  link: string;
}

export function beschriftung(ref: string): Beschriftung {
  return { klartext: kennungWieGedruckt(ref), link: koppelLink(ref) };
}

/**
 * Der Satz am Ende des Ablaufs (Entscheid 5c vom 26.10.2026). Er steht dort, wo sonst „verpacken und
 * versenden“ stünde, und bei jeder abgenommenen Box.
 */
export const VERSAND_SATZ =
  'Nicht versenden. Entscheid 5c vom 26.10.2026: Keine Box mit Stufe 1 geht an einen Kunden, bevor Stufe 2 steht (Programm mit geprüfter Signatur und Updates aus dem Portal). Eine abgenommene Box bleibt in der Werkstatt; sie ist eingerichtet und geprüft, mehr nicht.';

