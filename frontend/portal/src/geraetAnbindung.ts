/**
 * Der Abschnitt „ANBINDUNG" der Geräteseite (Konzept „Ein Gerät, ein Eintrag", GE-2, entschieden 23.10.2026).
 *
 * Der Weg zu einem Gerät — eine Datenquelle aus UEMS AP-06 — ist kein eigener Kasten, sondern Teil der Seite
 * des Geräts, an dem er endet (Regel §2.2): Weg, lesende Box, Empfang, Last an der Box, laufende Übergabe,
 * Lesetakt und klein die Kennung (GD-4 A, GD-5 A). Ohne Weg gibt es den Abschnitt nicht.
 *
 * WELCHER Weg zu einem Gerät gehört, entscheidet hier nichts: die Seite sucht ihr Gerät im Aufbau
 * (`aufbauBaum`, GE-1) und liest dessen Anbindungen ab — dieselben gespeicherten Verweise
 * (`geraet.data_source_id`), nie eine gleiche Adresse. Auch der Zustand im Kopf folgt der Regel der
 * Aufbau-Zeile (`wegStoerung`): eine gemeldete Störung des Wegs gewinnt, „Box meldet noch nicht je Quelle"
 * ist keine.
 */
import { request, type Device, type UemsDatenquelle, type UemsDatenquelleBox } from './api';
import { wegStoerung, type AufbauBaum, type AufbauGeraet, type AufbauWeg } from './aufbauBaum';
import { lastProzent, lastTeile, protokollName, quellWeg, quellZeile, wegLast, zeitpunkt } from './boxUebersicht';
import { NBSP } from './format';
import { UEMS_ANBINDUNG } from './glossar';
import { gatewaySeiteHash } from './geraetAdresse';
import type { GeraetTon } from './geraetSeite';
import { boxSeiteHash } from './nav';
import { einstellungenHash } from './settingsNav';
import { gemeinsameSteuerungAendern, wegDesWechsels } from './uemsDatenquelle';

/** Eine Zeile des Abschnitts; `href` = der Weg dorthin („›"), null = keiner. */
export interface AnbindungZeile {
  label: string;
  wert: string;
  detail: string | null;
  href: string | null;
  ton: GeraetTon | null;
}

/**
 * Was „Zuständige Box wechseln" an diesem Weg heißt — dieselbe Weiche wie auf der Box-Seite (AP-15 T6,
 * `wegDesWechsels`): der vorhandene Dialog, der Weg über die Gemeinsame Steuerung oder ein Satz, warum es
 * nicht geht. null = der Wechsel steht nicht hier (hinter einem Gateway gilt er für alle Geräte daran).
 */
export type WechselAngebot =
  | { art: 'dialog' }
  | { art: 'gemeinsam'; text: string; href: string }
  | { art: 'satz'; text: string }
  | null;

export interface Anbindung {
  quelle: UemsDatenquelle;
  /** „Anbindung", ab dem zweiten Weg „Weitere Anbindung". */
  titel: string;
  zeilen: AnbindungZeile[];
  /** Hinter einem Gateway: dass Box und Last für alle Geräte daran gelten. */
  hinweis: string | null;
  wechsel: WechselAngebot;
  /** „Kennung DQ-1" — klein, zum Suchen und für den Support (GD-5 A). */
  kennung: string;
}

/** Das Gerät dieser Seite im Aufbau und — hinter einem Gateway — dessen Zeile. */
export interface GeraetImAufbau {
  geraet: AufbauGeraet;
  gateway: AufbauWeg | null;
}

/**
 * Sucht das Gerät der Seite im Aufbau der geöffneten Anlage: über die Komponenten, die die Seite zeigt.
 * null = keins (Aufbau oder Zuordnung nicht geladen) — dann gibt es keine Anbindung, nie eine geratene.
 */
export function geraetImAufbau(baum: AufbauBaum | null, entityIds: readonly string[]): GeraetImAufbau | null {
  const anlage = baum?.anlagen.find((a) => a.aktuell);
  if (!anlage || entityIds.length === 0) return null;
  const gesucht = new Set(entityIds);
  const geraete = [...anlage.boxen.flatMap((b) => b.geraete), ...anlage.ohneBox];
  const geraet = geraete.find((g) => g.karte.komponenten.some((c) => gesucht.has(c.entityId)));
  if (!geraet) return null;
  const wege = [...anlage.boxen.flatMap((b) => b.wege), ...anlage.wegeOhneBox];
  return { geraet, gateway: geraet.gateway ? wege.find((w) => w.id === geraet.gateway?.id) ?? null : null };
}

/**
 * EIN Zustand im Kopf (GE-2): der eigene Zustand der Seite (bei der Anlagensteuerung das Werte-Alter, EZ-22) und
 * die Box-Rückmeldung zu ihrem Weg — nach derselben Regel wie die Aufbau-Zeile. Ohne gemeldete Störung bleibt
 * der eigene Zustand.
 */
export function kopfZustand<Z extends { wort: string; ton: GeraetTon; detail: string | null }>(
  eigen: Z,
  imAufbau: GeraetImAufbau | null,
): Z | { wort: string; ton: GeraetTon; detail: string | null } {
  const s = imAufbau ? wegStoerung(imAufbau.geraet.anbindungen) : null;
  return s ? { wort: s.wort, ton: 'warn', detail: s.grund } : eigen;
}

/** Eine Box, wie dieser Abschnitt sie nennt: „VoltPilot-Box Halle", sonst mit der Kennung vom Aufkleber. */
function boxWort(box: UemsDatenquelleBox, devices: readonly Device[]): { wert: string; href: string | null } {
  const d = devices.find((b) => b.id === box.id);
  if (d) return { wert: `VoltPilot-Box ${d.name?.trim() || d.externalRef}`, href: boxSeiteHash(d.siteId, d.externalRef) };
  return { wert: box.name?.trim() ? `VoltPilot-Box ${box.name.trim()}` : 'eine entfernte Box', href: null };
}

function lesetakt(s: number | null): string | null {
  return s == null ? null : `alle ${s}${NBSP}s`;
}

const zeile = (label: string, wert: string, o: Partial<Omit<AnbindungZeile, 'label' | 'wert'>> = {}): AnbindungZeile => ({
  label, wert, detail: o.detail ?? null, href: o.href ?? null, ton: o.ton ?? null,
});

/**
 * Die Zeilen EINES Wegs nach dem Weg selbst: lesende Box, Empfang, Last an der Box, laufende Übergabe, Lesetakt —
 * an Gerät und Gateway dieselben (GE-2, GE-5). Hinter einem Gateway fehlt am Gerät die Last: sie gilt für alle
 * Geräte daran und steht auf der Seite des Gateways.
 */
function wegZeilen(q: UemsDatenquelle, devices: readonly Device[], mitLast: boolean): AnbindungZeile[] {
  const zeilen: AnbindungZeile[] = [];
  const box = q.zustaendige_box ? boxWort(q.zustaendige_box, devices) : null;
  if (box) {
    zeilen.push(zeile('Gelesen von', box.wert, { href: box.href }));
    const z = quellZeile(q);
    zeilen.push(zeile('Empfang', z.zustand, {
      detail: [z.fehlerklasse, z.seit].filter(Boolean).join(' · ') || null,
      ton: z.ton,
    }));
    if (mitLast) {
      // Dieselbe Rechnung wie Box-Seite und Box-Zeile (GE-4, `wegLast`): nicht gemeldet ist keine Null.
      const last = wegLast([q]);
      zeilen.push(last.prozent != null
        ? zeile('Last an der Box', lastProzent(last.prozent), { detail: lastTeile(last).join(' · ') })
        : zeile('Last an der Box', 'von der Box nicht gemeldet'));
    }
  } else {
    zeilen.push(zeile('Gelesen von', 'Von keiner Box gelesen', { ton: 'off' }));
  }
  const u = q.uebergabe;
  if (u) {
    const neu = u.box_neu ? boxWort(u.box_neu, devices).wert : 'eine andere Box';
    const alt = u.box_alt ? boxWort(u.box_alt, devices).wert : null;
    zeilen.push(zeile('Übergabe', `Wechselt zu ${neu}`, {
      detail: [zeitpunkt(u.seit) ? `seit ${zeitpunkt(u.seit)}` : null, alt ? `bisher ${alt}` : null]
        .filter(Boolean).join(' · ') || null,
      ton: 'warn',
    }));
  }
  const takt = lesetakt(q.kadenz_s);
  if (takt) zeilen.push(zeile('Lesetakt', takt));
  return zeilen;
}

/** „Gateway DQ-3 (4 Geräte)" — wie Gerät und Box-Seite ein Gateway nennen. */
export function gatewayWort(kennzeichen: string, geraete: number): string {
  return `Gateway ${kennzeichen} (${geraete} ${geraete === 1 ? 'Gerät' : 'Geräte'})`;
}

/** Dass Box und Last für alle Geräte an einem Gateway gelten — am Gerät dahinter und auf der Gateway-Seite derselbe Satz. */
export function gatewayHinweis(geraete: number): string {
  return `Box und Last gelten für alle ${geraete} Geräte an diesem Gateway — ein Wechsel der Box nimmt alle mit.`;
}

/**
 * Die Anbindungen der Seite, in der Reihenfolge des Aufbaus (nach Kennzeichen). Leer = das Gerät hat keinen
 * gespeicherten Weg — dann bleibt der Abschnitt weg.
 *
 * @param gemeinsamZustand der Zustand der Gemeinsamen Steuerung der Anlage (nur für Steuerquellen gefragt);
 *     null = keine oder nicht geladen — dann gilt die Sperre der Steuerquelle wie auf der Box-Seite.
 */
export function anbindungen(input: {
  imAufbau: GeraetImAufbau | null;
  datenquellen: readonly UemsDatenquelle[] | null;
  devices: readonly Device[];
  siteId: string;
  gemeinsamZustand: string | null;
}): Anbindung[] {
  const { imAufbau, devices } = input;
  if (!imAufbau) return [];
  const { geraet, gateway } = imAufbau;
  const quellen = new Map((input.datenquellen ?? []).map((q) => [q.id, q]));
  const out: Anbindung[] = [];
  for (const a of geraet.anbindungen) {
    const q = quellen.get(a.quelleId);
    if (!q) continue;
    const amGateway = gateway?.id === q.id;
    const zeilen: AnbindungZeile[] = [];
    // Hinter einem Gateway nennt der Weg die eigene Geräte-ID dieses Geräts, sonst die des Wegs.
    zeilen.push(zeile('Weg', amGateway
      ? [protokollName(q.protokoll), q.adresse, geraet.anbindungText].filter(Boolean).join(' · ')
      : quellWeg(q)));
    if (amGateway && gateway) {
      // GE-5: der Weg führt auf die Seite des Gateways — dort stehen Box-Wechsel und Last für alle Geräte daran.
      zeilen.push(zeile('Gelesen über', gatewayWort(q.kennzeichen, gateway.geraete.length), {
        href: gatewaySeiteHash(input.siteId, q, devices),
      }));
    }
    zeilen.push(...wegZeilen(q, devices, !amGateway));

    out.push({
      quelle: q,
      titel: out.length === 0 ? UEMS_ANBINDUNG : `Weitere ${UEMS_ANBINDUNG}`,
      zeilen,
      hinweis: amGateway && gateway ? gatewayHinweis(gateway.geraete.length) : null,
      wechsel: amGateway ? null : wechselAngebot(q, input.siteId, input.gemeinsamZustand),
      kennung: `Kennung ${q.kennzeichen}`,
    });
  }
  return out;
}

/**
 * Die Anbindung eines GATEWAYS (GE-5) — dieselben Zeilen wie am Gerät, aber mit allen Geräte-IDs des Wegs und mit
 * Last und Box-Wechsel: sie gelten hier für alle Geräte dahinter (GD-3 A, GD-4 A).
 */
export function gatewayAnbindung(input: {
  quelle: UemsDatenquelle;
  geraete: number;
  devices: readonly Device[];
  siteId: string;
  gemeinsamZustand: string | null;
}): Anbindung {
  const q = input.quelle;
  return {
    quelle: q,
    titel: UEMS_ANBINDUNG,
    zeilen: [zeile('Weg', quellWeg(q)), ...wegZeilen(q, input.devices, true)],
    hinweis: gatewayHinweis(input.geraete),
    wechsel: wechselAngebot(q, input.siteId, input.gemeinsamZustand),
    kennung: `Kennung ${q.kennzeichen}`,
  };
}

/** Die Weiche der Box-Seite (BoxSeiteSection, AP-15 IP-26) für EINEN Weg dieses Geräts. */
function wechselAngebot(q: UemsDatenquelle, siteId: string, gemeinsamZustand: string | null): WechselAngebot {
  if (!q.steuerquelle) return { art: 'dialog' };
  const weg = wegDesWechsels(true, gemeinsamZustand, false, true);
  if (weg === 'innerhalb_der_gemeinsamen_steuerung') return { art: 'dialog' };
  if (weg === 'gemeinsame_steuerung_aendern') {
    return { art: 'gemeinsam', text: gemeinsameSteuerungAendern(q.kennzeichen), href: einstellungenHash(siteId, 'gemeinsam') };
  }
  return { art: 'satz', text: 'Dieses Gerät steuert — seine Box kann erst mit der gemeinsamen Optimierung mehrerer Boxen wechseln.' };
}

/** Der Kurzblick von „Gerät & Verbindung": Weg und Empfang des ersten Wegs. */
export function anbindungKurz(a: readonly Anbindung[]): string | null {
  const erste = a[0];
  if (!erste) return null;
  const wert = (label: string) => erste.zeilen.find((z) => z.label === label)?.wert ?? null;
  return [wert('Weg'), wert('Empfang')].filter(Boolean).join(' · ') || null;
}

// ---- Verlauf der Anbindung: GET …/data-sources/{id}/history ----------------------------------------------

/**
 * Ein Eintrag des Protokolls eines Wegs (`DatenquelleDto.ProtokollEintrag`). `text` ist der Satz des
 * Änderungsprotokolls (additiv, GE-2); ein älterer Server liefert ihn nicht — dann steht der Code da, wie es
 * auch der Server mit einer unbekannten Art hält.
 */
export interface AnbindungVerlaufEintrag {
  id: number;
  art: string;
  text?: string | null;
  box: UemsDatenquelleBox | null;
  ergebnis: string | null;
  gilt_ab: string;
  urheber: { name: string; rolle: string | null; art: string };
  zeitpunkt: string;
}

export const anbindungApi = {
  /** Das Protokoll EINES Wegs, jüngster Eintrag zuerst (Recht lesend: `aenderungsprotokoll.lesen`). */
  verlauf: (siteId: string, quelleId: string) =>
    request<{ eintraege: AnbindungVerlaufEintrag[] }>(`/api/v1/sites/${siteId}/data-sources/${quelleId}/history`),
};

export interface VerlaufZeile {
  id: string;
  /** „23.10.2026, 11:42" — wann es gilt. */
  zeit: string;
  text: string;
  /** „VoltPilot-Box edge-5mz8bdd · Ines Kaltenbach" */
  detail: string | null;
}

export function verlaufZeilen(eintraege: readonly AnbindungVerlaufEintrag[], devices: readonly Device[]): VerlaufZeile[] {
  return eintraege.map((e) => ({
    id: String(e.id),
    zeit: zeitpunkt(e.gilt_ab) ?? e.gilt_ab,
    text: e.text?.trim() || e.art,
    detail: [e.box ? boxWort(e.box, devices).wert : null, e.urheber?.name?.trim() || null].filter(Boolean).join(' · ') || null,
  }));
}
