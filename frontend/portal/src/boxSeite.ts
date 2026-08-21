/**
 * Die BOX-Seite als reine Ableitung (Scout `data/vp-geraeteseite-rev-b8` §4.1,
 * Gattung A; Captain-Abnahme 21.08.2026 inkl. E3).
 *
 * **Der behobene Befund war die SCHABLONE, kein Versehen:** die Box lief als
 * vierte Geräte-ART durch dieselbe Sektions-Reihenfolge wie ein Wechselrichter.
 * Sie bekam damit „Gelesene Register" (und erklärte dort, dass sie keine hat),
 * „Register schreiben" (und schrieb dabei an ein ANDERES Gerät) und „Befehle an
 * dieses Gerät" (und meinte alle Befehle der Anlage) - drei Sektionen, die nur
 * dastanden, um ihre Nicht-Zuständigkeit zu erklären. Ihre beiden echten
 * Hauptinhalte, der SOFTWARE-Stand und die ADRESSE im Netzwerk, waren
 * Nebenzeilen einer Liste.
 *
 * Die Box ist ein **TOR**: sie ist verbunden oder nicht, sie fährt eine
 * Software, sie ist im Heimnetz erreichbar, und an ihr hängen die GERÄTE. Genau
 * das steht hier - in dieser Reihenfolge, und nichts sonst.
 *
 * Vier Regeln, alle Haus-Regeln:
 *
 * 1. **Unbekannt ist nie „nein".** Ein fehlender Stand heißt „nicht gemeldet"
 *    und trägt seinen Grund; er wird NIE zu „veraltet".
 * 2. **Jede leere Fläche nennt ihren Grund** - nie ein leerer Kasten.
 * 3. **Die zwei D5-Belege bleiben getrennt** (`erreicht` ⟷ `schnittstelle`) -
 *    eine Adresse, unter der nur GEMELDET wurde, verspricht keine Antwort.
 * 4. **Die Box altert gegen ihre Telemetrie** (`Device.lastSeenAt` gegen die
 *    Bezugszeit der Geräteliste, die `liveness.ts`-Lehre) - nie gegen eine
 *    weiterlaufende Uhr über einem stehenden Schnappschuss.
 *
 * Rein + framework-frei; `pages/BoxSeiteSection.tsx` rendert nur.
 */
import type { ControlStatus, CurtailmentStatus, Device, EdgeVersion } from './api';
import { fmtRelative } from './format';
import { NO_DATA } from './nodata';
import { versionLabel } from './edgeVersionLabel';
import type { EntityLocalSetup, SiteSource } from './api';
import type { BoxGeraet, GeraetTon, Zeile } from './geraetSeite';
import {
  ART_WORT,
  ROLLEN_WORT,
  boxZustand,
  chargerGeraetId,
  lanZeile,
  quellenZustand,
} from './geraetSeite';
import { technicalDeviceName } from './entityLabel';
import { chargerName, type ChargePoint } from './ladepunkte';

/** Eine der drei Kacheln des Kopfes. */
export interface BoxKachel {
  key: 'verbindung' | 'software' | 'netzwerk';
  label: string;
  /** Die eine große Aussage („verbunden", „edge-2026.08.10", „192.168.20.14"). */
  wert: string;
  ton: GeraetTon;
  /** Der eine erklärende Satz darunter. */
  satz: string;
  /** Höchstens zwei Zusatz-Zeilen (Bezugszeit, Build, Soll-Stand). */
  zeilen: string[];
  mono?: boolean;
  /** Nur die Netzwerk-Kachel: die lokale Oberfläche, sonst null. */
  url?: string | null;
}

/** Das Ergebnis: was die Box-Seite rendert. */
export interface BoxSeiteView {
  /** false = die Adresse nennt keine Box dieser Anlage (mit Grund). */
  gefunden: boolean;
  grund: string | null;
  titel: string;
  unterzeile: string;
  kennung: string;
  zustand: { wort: string; ton: GeraetTon; detail: string | null };
  kacheln: BoxKachel[];
  /** Die Geräte AN der Box - die Absprungliste, die die Seite AUSMACHT. */
  geraete: BoxGeraet[];
  geraeteLeer: string | null;
  /** „Schutz & Grenzen Ihrer Anlage". */
  grenzen: Zeile[];
  grenzenLeer: string | null;
  /** Technik-Aufklapper. */
  technik: Zeile[];
}

export interface BoxSeiteInput {
  /** Die Referenz aus der Adresse; null = die Fläche löst die eine Box selbst auf. */
  ref: string | null;
  siteName: string;
  siteId: string;
  devices: Device[] | null;
  /** Bezugszeit der Geräteliste - die Box altert dagegen. */
  devicesFetchedAt?: number | null;
  edgeVersions: EdgeVersion[] | null;
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
  /** Die Geräte AN der Box, schon abgeleitet (dieselbe Liste wie bisher). */
  geraete: BoxGeraet[];
  now?: number;
}

/** Der Satz, der eine Box-lose Adresse ehrlich beendet. */
export const KEINE_BOX =
  'Diese Adresse nennt keine VoltPilot-Box dieser Anlage. Vielleicht wurde sie entfernt.';

/** Der Satz unter der Geräte-Liste, solange sich nichts gemeldet hat. */
export const KEINE_GERAETE = 'An dieser Box meldet sich noch kein Gerät.';

/**
 * Der Satz, der die Box als TOR beschreibt - er steht im Kopf.
 *
 * Er lebt in `geraetSeite.ART_WORT`, weil die Zentrale-Liste und das Schaltbild
 * ihn ebenfalls benennen - zwei Formulierungen für dieselbe Rolle wären zwei
 * Aussagen über dasselbe Ding.
 */
export const BOX_ROLLE = ART_WORT.box;

/** Die Anbindungs-Zusage: die Box wählt an, niemand wählt sie an. */
export const ANBINDUNG_SATZ =
  'Ihre Box wählt VoltPilot selbst an — von außen ist sie nicht erreichbar.';

/** Was auf der Box-Seite ABSICHTLICH fehlt, in einem Satz. */
export const GERAETE_HINWEIS =
  'Messwerte, Register und die Befehle eines Geräts stehen auf seiner eigenen Seite.';

/**
 * Der SOFTWARE-Stand als Kachel - Version, Build und das URTEIL gegen das
 * Release-Register (`newestRelease`/`upToDate`, api-seitig gebildet).
 *
 * ⚠ **`upToDate` ist DREIWERTIG.** `null` heißt „nicht bewertbar" (nichts
 * gemeldet, oder der Stand steht nicht im Register - eine Lücke im REGISTER,
 * keine Alters-Aussage über die Box). Daraus „veraltet" zu machen wäre genau
 * die Behauptung, die die OTA-Stufe 0 an dieser Stelle schon einmal beendet hat.
 */
export function softwareKachel(edge: EdgeVersion | null | undefined): BoxKachel {
  const stand = (edge?.coreVersion ?? '').trim();
  const soll = (edge?.newestRelease ?? '').trim();
  if (!stand) {
    return {
      key: 'software',
      label: 'Software',
      wert: 'meldet keinen Stand',
      ton: 'off',
      satz:
        'Ihre Box meldet ihren Software-Stand, sobald sie sich das nächste Mal '
        + 'vollständig gemeldet hat.',
      zeilen: [],
    };
  }
  // Tag + Build getrennt, aber eine nackte SHA bleibt VERBATIM - sie zu
  // zerlegen erfände ein Release-Tag, mit dem der Bau nie erzeugt wurde.
  // ⚠ Getrennt wird nur gegen einen BEKANNTEN Tag, und bekannt ist hier allein
  // der SOLL-Stand: ein VERALTETER Bau zeigt deshalb seinen rohen Stempel. Das
  // ist die ehrliche Seite derselben Regel - wir kennen sein Release-Tag nicht,
  // der Satz darunter nennt dafür den Soll-Stand sauber.
  const wert = versionLabel(stand, soll ? [{ version: soll }] : []);
  if (edge?.upToDate === true) {
    return {
      key: 'software',
      label: 'Software',
      wert,
      ton: 'ok',
      satz: 'Ihre Box ist auf dem neuesten Stand.',
      zeilen: [],
      mono: true,
    };
  }
  if (edge?.upToDate === false) {
    return {
      key: 'software',
      label: 'Software',
      wert,
      ton: 'warn',
      satz:
        `Ein neuerer Stand ist verfügbar${soll ? `: ${soll}` : ''}. Um Aktualisierungen `
        + 'kümmert sich VoltPilot — Sie müssen nichts tun.',
      zeilen: [],
      mono: true,
    };
  }
  return {
    key: 'software',
    label: 'Software',
    wert,
    ton: 'off',
    satz: soll
      // „nicht registriert": eine Lücke im Register, KEINE Alters-Aussage.
      ? 'Diesen Stand führt unser Verzeichnis nicht — ob er älter ist, lässt sich '
        + 'daraus nicht sagen.'
      // Leeres Register: ohne Maßstab wird nichts als veraltet bewertet.
      : 'Ein Soll-Stand ist noch nicht hinterlegt — deshalb wird hier nichts als '
        + 'veraltet bewertet.',
    zeilen: [],
    mono: true,
  };
}

/** Die drei Kacheln des Kopfes - Verbindung · Software · Im Netzwerk. */
export function boxKacheln(
  device: Device | undefined,
  edge: EdgeVersion | null | undefined,
  zustand: { wort: string; ton: GeraetTon; detail: string | null },
  now: number,
): BoxKachel[] {
  const lan = lanZeile(device, now);
  const erreicht = device?.lanSource === 'erreicht';
  const host = (device?.lanHost ?? '').trim();
  return [
    {
      key: 'verbindung',
      label: 'Verbindung',
      wert: zustand.wort,
      ton: zustand.ton,
      satz: ANBINDUNG_SATZ,
      zeilen: zustand.detail ? [`Letzte Meldung ${zustand.detail}`] : [],
    },
    softwareKachel(edge),
    {
      key: 'netzwerk',
      label: 'Im Netzwerk',
      wert: lan.wert,
      ton: lan.ton ?? 'off',
      satz: lan.detail ?? '',
      zeilen: [],
      mono: !!host,
      // ⚠ Ein Weg wird nur angeboten, wo er BELEGT ist: nur eine wirklich
      // erreichte Adresse hat nachweislich geantwortet (die D5-Regel).
      url: host && erreicht ? `http://${host}` : null,
    },
  ];
}

/**
 * „Schutz & Grenzen Ihrer Anlage" - was IMMER gilt, unabhängig vom Fahrplan.
 *
 * Es wird nur genannt, was BELEGT ist: der Einspeise-Wächter aus dem Herzschlag
 * und der Not-Aus aus dem Steuerungs-Beleg. Eine Grenze, die niemand gemeldet
 * hat, wird nicht behauptet.
 */
export function grenzenZeilen(
  control: ControlStatus | null,
  curtailment: CurtailmentStatus | null,
  boxDeviceId: string | null,
): Zeile[] {
  const out: Zeile[] = [];
  const guard = curtailment?.exportGuard;
  if (guard) {
    out.push({
      label: 'Einspeise-Begrenzung',
      wert: `${guard.limitKw.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW am Netzanschluss`,
      detail: guard.reach ?? guard.reason ?? null,
      ton: !guard.effective || guard.reach || guard.blind ? 'warn' : 'ok',
    });
  }
  const limit = curtailment?.deviceExportLimit;
  if (limit) {
    out.push({
      label: 'Grenze im Wechselrichter',
      wert: `${limit.limitKw.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`,
      detail: `Register ${limit.register}, zuletzt gelesen ${uhr(limit.readAt)}`,
      mono: false,
    });
  }
  // ⚠ Der Beleg gehört dem Gerät, das ihn GEMELDET hat (die `eigenerBeleg`-Regel).
  if (control && boxDeviceId && control.deviceId === boxDeviceId) {
    out.push({
      label: 'Not-Aus',
      wert: control.controlEnabled
        ? 'aus — VoltPilot darf steuern'
        : 'an — VoltPilot steuert gerade nicht',
      ton: control.controlEnabled ? 'ok' : 'warn',
    });
  }
  return out;
}

/**
 * Die GERÄTE an der Box - die Absprungliste, die die Seite AUSMACHT.
 *
 * Sie ist bewusst die einzige Liste dieser Fläche: was ein Gerät MISST und was
 * VoltPilot ihm schickt, steht auf SEINER Seite - die Box überbringt es nur.
 */
export function boxGeraeteListe(
  localSetup: EntityLocalSetup[] | null,
  sources: SiteSource[] | null,
  chargers: ChargePoint[] | null,
  now: number,
): BoxGeraet[] {
  const out: BoxGeraet[] = [];
  for (const l of localSetup ?? []) {
    const s = (sources ?? []).find((x) => x.sourceId === l.id);
    const z = quellenZustand(s, now);
    out.push({
      geraetId: l.id,
      name: technicalDeviceName({ edgeLabel: l.label, brand: l.brand, model: l.model }) ?? 'Gerät',
      art: l.kind === 'inverter' ? 'Hauptgerät' : (ROLLEN_WORT[l.role ?? ''] ?? 'Gerät'),
      zustand: z.detail ? `${z.wort} · ${z.detail}` : z.wort,
      ton: z.ton,
    });
  }
  for (const c of chargers ?? []) {
    out.push({
      geraetId: chargerGeraetId(c.chargePointId),
      name: chargerName(c),
      art: 'Ladesäule',
      zustand: c.connected ? 'verbunden' : 'getrennt',
      ton: c.connected ? 'ok' : 'warn',
    });
  }
  return out;
}

/** Die Box-Seite. */
export function boxSeite(input: BoxSeiteInput): BoxSeiteView {
  const now = input.now ?? Date.now();
  const eigene = (input.devices ?? []).filter((d) => d.siteId === input.siteId);
  const box = input.ref
    ? eigene.find((d) => d.externalRef === input.ref)
    : eigene.length === 1
      ? eigene[0]
      : undefined;

  if (!box) {
    return {
      gefunden: false,
      grund: KEINE_BOX,
      titel: 'VoltPilot-Box',
      unterzeile: `${BOX_ROLLE} · Anlage ${input.siteName}`,
      kennung: input.ref ?? NO_DATA,
      zustand: { wort: 'nicht verbunden', ton: 'off', detail: null },
      kacheln: [],
      geraete: [],
      geraeteLeer: null,
      grenzen: [],
      grenzenLeer: null,
      technik: [],
    };
  }

  const zustand = boxZustand(box, input.devicesFetchedAt, now);
  const edge = input.edgeVersions?.find((v) => v.deviceId === box.id) ?? null;
  const name = (box.name ?? '').trim() || box.externalRef;

  const technik: Zeile[] = [
    { label: 'Kennung', wert: box.externalRef, mono: true },
    {
      label: 'Letzte Meldung',
      wert: uhr(box.lastSeenAt),
      detail: zustand.detail,
    },
  ];
  if (edge?.paletteVersion) {
    technik.push({ label: 'Bausteine', wert: edge.paletteVersion, mono: true });
  }
  if (edge?.reportedAt) {
    technik.push({ label: 'Stand gemeldet', wert: uhr(edge.reportedAt) });
  }
  // ⚠ Die Adresse steht als KACHEL oben und NUR dort - sie hier zu wiederholen
  // wäre dieselbe Aussage zweimal auf einer Seite (die Haus-Regel), ohne eine
  // zweite Lesehöhe zu sein.

  const grenzen = grenzenZeilen(input.control, input.curtailment, box.id);
  return {
    gefunden: true,
    grund: null,
    titel: `VoltPilot-Box ${name}`,
    unterzeile: `${BOX_ROLLE} · Anlage ${input.siteName}`,
    kennung: box.externalRef,
    zustand,
    kacheln: boxKacheln(box, edge, zustand, now),
    geraete: input.geraete,
    geraeteLeer: input.geraete.length === 0 ? KEINE_GERAETE : null,
    grenzen,
    grenzenLeer: grenzen.length === 0
      ? 'Zu den Grenzen Ihrer Anlage meldet die Box gerade nichts.'
      : null,
    technik,
  };
}

/** Uhrzeit eines Zeitpunkts, sonst „—". */
function uhr(iso: string | null | undefined): string {
  if (!iso) return NO_DATA;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return NO_DATA;
  return t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Wie alt ein Zeitpunkt ist - die EINE Haus-Formatierung. */
export function boxAlter(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fmtRelative(iso, new Date(now));
}
