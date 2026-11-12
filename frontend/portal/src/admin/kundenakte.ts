import type { Site, SelbstauskunftKundenbereichBeendet } from '../api';
import type { BenutzerEintrag } from '../benutzer';
import { KUNDENROLLEN } from '../benutzer';
import type { AdminFleetSite } from './fleetApi';
import type { AdminUser } from './adminApi';

/**
 * Reine Ableitungen der Kundenakte (Admin-Umbau Scheibe S5, Konzept
 * `vp-adminview-konzept-k1` §4.5/§4.7, E5 = A): die EINE Personenliste aus
 * Konto (Keycloak, `adminApi.listUsers`) und Rolle (UEMS, `benutzerApi.liste`)
 * sowie die Zustands- und Zähl-Ableitungen der Kundenliste. Beide Antworten
 * sind VORHANDEN (Datenkatalog §3.2) - das zusammengeführte Lesemodell selbst
 * kommt erst mit S6 (L6); bis dahin fügt diese Schicht die zwei Antworten
 * CLIENT-SEITIG zusammen, rein lesend.
 *
 * Komponenten rendern nur das Ergebnis dieser Module - keine Fach-Ableitung
 * im JSX (Portal-Hausregel).
 */

export type Ton = 'ok' | 'warn' | 'off';

/** Eine Zeile der zusammengeführten Personenliste (E5). */
export interface KundenPerson {
  /** Keycloak-`sub` bzw. `AdminUser.id` - dieselbe Kennung in beiden Antworten. */
  key: string;
  name: string;
  email: string | null;
  rollenText: string;
  ton: Ton;
  zustandText: string;
  /** `null`, wenn die Person nur im UEMS-Lesemodell steht (Server-Inkonsistenz, keine Aktion möglich). */
  konto: AdminUser | null;
  eintrag: BenutzerEintrag | null;
}

const ROLLEN_LABEL = new Map(KUNDENROLLEN.map((r) => [r.value, r.label]));

function rolleLabel(code: string): string {
  return ROLLEN_LABEL.get(code) ?? code;
}

function rollenText(eintrag: BenutzerEintrag | null): string {
  if (!eintrag || eintrag.zuweisungen.length === 0) return 'Keine Rolle';
  const labels = [...new Set(eintrag.zuweisungen.map((z) => rolleLabel(z.rolle)))];
  return labels.join(', ');
}

/** Konto- bzw. Rollen-Zustand einer Person; das UEMS-Lesemodell (`eintrag.zustand`) führt, Keycloak füllt nur die Lücke. */
function personZustand(konto: AdminUser | null, eintrag: BenutzerEintrag | null): { ton: Ton; text: string } {
  const zustand = eintrag?.zustand ?? (konto ? (konto.enabled ? 'aktiv' : 'gesperrt') : null);
  if (zustand === 'aktiv') return { ton: 'ok', text: 'aktiv' };
  if (zustand === 'angelegt') return { ton: 'warn', text: 'angelegt' };
  if (zustand === 'gesperrt') return { ton: 'off', text: 'gesperrt' };
  if (zustand === 'entfernt') return { ton: 'off', text: 'entfernt' };
  return { ton: 'off', text: 'unbekannt' };
}

/**
 * Die EINE Personenliste: jedes Keycloak-Konto UND jeder UEMS-Eintrag kommt
 * genau einmal vor, zusammengeführt über die Kennung. Eine Seite ohne die
 * andere ist eine echte Inkonsistenz (zeigt an, führt zu keiner Aktion mehr,
 * als die vorhandene Hälfte erlaubt) - "fehlend ist keine Null".
 */
export function personenListe(konten: AdminUser[], eintraege: BenutzerEintrag[]): KundenPerson[] {
  const byKennung = new Map(eintraege.map((e) => [e.sub, e]));
  const gesehen = new Set<string>();
  const zeilen: KundenPerson[] = [];
  for (const k of konten) {
    const eintrag = byKennung.get(k.id) ?? null;
    gesehen.add(k.id);
    const { ton, text } = personZustand(k, eintrag);
    zeilen.push({
      key: k.id,
      name: eintrag?.anzeigename || [k.firstName, k.lastName].filter(Boolean).join(' ') || k.username,
      email: k.email ?? eintrag?.email ?? null,
      rollenText: rollenText(eintrag),
      ton,
      zustandText: text,
      konto: k,
      eintrag,
    });
  }
  for (const e of eintraege) {
    if (gesehen.has(e.sub)) continue;
    const { ton, text } = personZustand(null, e);
    zeilen.push({
      key: e.sub,
      name: e.anzeigename,
      email: e.email,
      rollenText: rollenText(e),
      ton,
      zustandText: text,
      konto: null,
      eintrag: e,
    });
  }
  return zeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Eine Box in „Anlagen und Boxen" (B4 = A, Konzept vp-plattform-admin-box-
 * benutzer-konzept): „online" oder „nie gemeldet" statt nur einer Summe - eine
 * nie gemeldete Box führt in die Geräteakte, wo „Vom Kunden lösen" sitzt.
 */
export interface AnlageBoxEintrag {
  deviceId: string;
  externalRef: string;
  label: string;
  ton: Ton;
  text: string;
  nieGemeldet: boolean;
}

/** Eine Zeile „Anlagen und Boxen" der Kundenakte: eine Anlage mit ihrem Box-Bestand. */
export interface AnlageBoxZeile {
  siteId: string;
  siteName: string;
  unterzeile: string;
  ton: Ton;
  deviceCount: number;
  boxen: AnlageBoxEintrag[];
}

/**
 * Die Flotten-Antwort kennt nur Anlagen MIT Fleet-Eintrag (Boxen oder nicht);
 * `fleetSites` ist bereits auf diesen Mandanten gefiltert. Eine Anlage ohne
 * Fleet-Zeile (jüngste Anlage, Flotte noch nicht neu geladen) bleibt ehrlich
 * „unbekannt" statt stumm „keine Box" zu behaupten.
 */
export function anlagenBoxenZeilen(sites: Site[], fleetSites: AdminFleetSite[]): AnlageBoxZeile[] {
  const byId = new Map(fleetSites.map((f) => [f.siteId, f]));
  return sites.map((s) => {
    const f = byId.get(s.id);
    if (!f) {
      return { siteId: s.id, siteName: s.name, unterzeile: 'Stand unbekannt', ton: 'off' as Ton, deviceCount: 0, boxen: [] };
    }
    const boxesRaw = f.boxes ?? [];
    const boxen: AnlageBoxEintrag[] = boxesRaw.map((b) => {
      const nieGemeldet = !b.herzschlagAm && !b.messwertAm;
      return {
        deviceId: b.deviceId,
        externalRef: b.externalRef,
        label: b.name || b.externalRef,
        ton: nieGemeldet ? ('off' as Ton) : ('ok' as Ton),
        text: nieGemeldet ? 'nie gemeldet' : 'online',
        nieGemeldet,
      };
    });
    const unterzeile =
      f.deviceCount === 0
        ? 'Noch keine Box'
        : f.deviceCount === 1 && boxesRaw[0]
          ? boxesRaw[0].name || boxesRaw[0].externalRef
          : `${f.deviceCount} Boxen`;
    const ton: Ton = f.deviceCount === 0 ? 'off' : f.worstStatus === 'online' ? 'ok' : f.worstStatus === 'stale' ? 'warn' : f.worstStatus === 'waiting' ? 'warn' : 'off';
    return { siteId: s.id, siteName: s.name, unterzeile, ton, deviceCount: f.deviceCount, boxen };
  });
}

/** Summe der Boxen über alle Anlagen eines Mandanten in der Flotten-Antwort. */
export function boxenZaehlung(tenantId: string, fleetSites: AdminFleetSite[]): number {
  return fleetSites.filter((f) => f.tenantId === tenantId).reduce((sum, f) => sum + f.deviceCount, 0);
}

/** `beendet_am` ist ein Kalendertag (`LocalDate.toString()`, YYYY-MM-DD). */
export function datumDe(tag: string): string {
  const [jahr, monat, t] = tag.split('-');
  return `${t}.${monat}.${jahr}`;
}

/**
 * Der Zustand einer Zeile der Kundenliste bzw. des Kopfs der Kundenakte. Seit
 * vp-kunde-sofort-loeschen-mit-daten ist JEDER Kunde sofort löschbar, mit oder ohne Daten - das
 * Badge zeigt nur noch, ob der Vertrag beendet ist, kein Löschdatum mehr.
 */
export function kundenZustand(
  vertragsende: SelbstauskunftKundenbereichBeendet | null | undefined,
  unterstuetzungBisText: string | null,
): { ton: Ton; text: string } {
  if (vertragsende) return { ton: 'off', text: 'beendet' };
  if (unterstuetzungBisText) return { ton: 'ok', text: `Unterstützung bis ${unterstuetzungBisText}` };
  return { ton: 'ok', text: 'aktiv' };
}

/** Die Zählungen einer Zeile der Kundenliste (`undefined` = lädt noch, `null` = nicht ladbar). */
export interface KundenZahlen {
  anzahlPersonen?: number | null;
  anzahlAnlagen: number | null;
  anzahlBoxen: number | null;
}

function zahlMitWort(n: number | null | undefined, eins: string, mehrere: string): string {
  if (n == null) return `… ${mehrere}`;
  return `${n} ${n === 1 ? eins : mehrere}`;
}

/**
 * Die drei Zahlen einer Kundenzeile als EINE Zeile für das Telefon
 * („1 Person · 3 Anlagen · 0 Boxen") - statt drei Etikett/Wert-Zeilen je Kunde.
 * Eine fehlende Zahl bleibt „…“, nie 0.
 */
export function kundenZahlenText(z: KundenZahlen): string {
  return [
    zahlMitWort(z.anzahlPersonen, 'Person', 'Personen'),
    zahlMitWort(z.anzahlAnlagen, 'Anlage', 'Anlagen'),
    zahlMitWort(z.anzahlBoxen, 'Box', 'Boxen'),
  ].join(' · ');
}
