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

export type BoxArt = 'edge-light' | 'edge-app';

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
] as const;

export type PruefungId = (typeof PRUEFUNGEN)[number]['id'];

// ── Das OpenWrt-Abbild (Vorgabe für „Werkstatt freigeben“) ─────────────────

/** Die Fassung, die alle Skripte erwarten (apk, Dropbear ab 2025.89). */
export const OPENWRT_FASSUNG = '25.12.5';
export const OPENWRT_ABBILD = `openwrt-${OPENWRT_FASSUNG}-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin`;
export const OPENWRT_QUELLE = `https://downloads.openwrt.org/releases/${OPENWRT_FASSUNG}/targets/ramips/mt76x8/`;

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

