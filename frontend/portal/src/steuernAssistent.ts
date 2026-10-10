import type {
  FunktionFreigabeZeile,
  FunktionStandort,
  Netzanschluss,
  SiteEntity,
  StandortAmStichtag,
} from './api';
import { freigabeZustand } from './schaltFreigabe';
import type { VerbraucherEintrag } from './verbraucherZone';
import type { SteuerartWunsch } from './steuerartDialog';

/** Reine Regeln des Assistenten „Steuern & Optimieren“ (AP-01 IP-10a). */
export const STEUERN_SCHRITTE = ['Anlage', 'Freigeben', 'Grenze', 'Betriebsweise', 'Prüfen', 'Starten'] as const;
export type SteuernSchritt = 1 | 2 | 3 | 4 | 5 | 6;

export const STEUERN_TITEL = 'Steuern & Optimieren einrichten';
export const STEUERN_TITEL_KURZ = 'Steuern & Optimieren';
export const STEUERN_EINSTIEG_SATZ = 'Diese Anlage nimmt noch nicht an „Steuern & Optimieren“ teil.';
export const STEUERN_EINSTIEG_AKTION = 'Steuern & Optimieren einrichten';
export const SPATER = 'Später fortsetzen';
export const STEUERN_ENTWURF_SCHLUESSEL = 'vp.uems.steuern-assistent.entwurf.v1';

export interface SteuernEntwurf {
  standortId: string;
  anlageId: string;
  steuerarten: Record<string, SteuerartWunsch>;
  betriebsmodell: string | null;
}

export function browserSpeicher(): Pick<Storage, 'setItem'> | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function entwurfSpeichern(speicher: Pick<Storage, 'setItem'> | null, entwurf: SteuernEntwurf): void {
  try { speicher?.setItem(STEUERN_ENTWURF_SCHLUESSEL, JSON.stringify(entwurf)); } catch { /* Server-Fakten bleiben maßgeblich. */ }
}

export function schrittZaehler(schritt: SteuernSchritt): string {
  return `Schritt ${schritt} von 6`;
}

export function vor(schritt: SteuernSchritt): SteuernSchritt | null {
  return schritt < 6 ? ((schritt + 1) as SteuernSchritt) : null;
}

export function zurueck(schritt: SteuernSchritt): SteuernSchritt | null {
  return schritt > 1 ? ((schritt - 1) as SteuernSchritt) : null;
}

export function anlagenDesStandorts(standort: StandortAmStichtag | null): Array<{ id: string; name: string }> {
  return standort?.anlagen.map(({ id, name }) => ({ id, name })) ?? [];
}

export function teilnahmeSatz(funktion: FunktionStandort | null, anlageId: string): string | null {
  const a = funktion?.steuern.anlagen.find((x) => x.id === anlageId);
  if (!a || a.teilnahme.zustand === 'kein_objekt' || a.teilnahme.zustand === 'archiviert') return null;
  return a.teilnahme.seit ? `Nimmt seit ${datum(a.teilnahme.seit)} teil` : 'Nimmt bereits teil';
}

export interface KomponentenZeile {
  id: string;
  name: string;
  steuerbar: boolean;
  status: string;
  weg: string | null;
}

export interface FreigabeDarstellung {
  titel: string;
  status: string;
  hinweis: string;
  aktion: string | null;
}

/** Die drei bestehenden Wege sprechen bewusst verschieden: Kunde, OCPP-Fakten und VoltPilot. */
export function freigabeDarstellung(zeile: FunktionFreigabeZeile): FreigabeDarstellung {
  if (zeile.weg === 'selbstbau') {
    const zustand = freigabeZustand({ schaltbar: zeile.freigegeben, quelle: 'selbst' });
    return {
      titel: zeile.name,
      status: zeile.freigegeben ? zustand.wort : zeile.status,
      hinweis: zeile.freigegeben
        ? zustand.satz
        : 'Vor der Freigabe führt der Assistent den Schalt-Test durch und fragt „Steuern freigeben?“.',
      aktion: zeile.freigegeben ? 'Freigabe ansehen' : 'Schalt-Test und Freigabe',
    };
  }
  if (zeile.weg === 'ocpp') {
    return {
      titel: zeile.name,
      status: zeile.status,
      hinweis: zeile.steuerart_gesetzt
        ? 'Die Steuerart des Ladepunkts ist gesetzt.'
        : 'Die Steuerart wählen Sie in Schritt 4 „Betriebsweise“.',
      aktion: null,
    };
  }
  return {
    titel: 'Wir schalten die Steuerung für Ihren Wechselrichter frei — VoltPilot',
    status: zeile.status,
    hinweis: zeile.name,
    aktion: null,
  };
}

/** Die API sagt mit `control`, was steuerbar ist. Ein Messkanal wird nie erraten. */
export function komponentenZeilen(entities: readonly SiteEntity[]): KomponentenZeile[] {
  return entities.map((e) => ({
    id: e.id,
    name: e.label?.trim() || e.typeLabel,
    steuerbar: e.control,
    status: e.control ? 'Steuerbar — Freigabe prüfen' : 'Nicht steuerbar (misst)',
    weg: !e.control ? null
      : /inverter|wechselrichter/i.test(`${e.entityType} ${e.typeLabel}`)
        ? 'VoltPilot schaltet die Steuerung frei'
        : /charge|lade|ocpp/i.test(`${e.entityType} ${e.typeLabel}`)
          ? 'Verbindung und Freigabe prüfen'
          : 'Schalt-Test und Freigabe öffnen',
  }));
}

export function netzanschlussDerAnlage(netzanschluesse: readonly Netzanschluss[], anlageId: string): Netzanschluss | null {
  return netzanschluesse.find((n) => n.anlagen.some((a) => a.anlage.id === anlageId && a.gueltig_bis == null)) ?? null;
}

export function kw(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function grenzeFehler(grenze: string, vereinbartKw: number | null): string | null {
  const wert = kw(grenze);
  if (wert == null || wert <= 0) return 'Bitte tragen Sie eine Anschlussgrenze größer als 0 kW ein.';
  if (vereinbartKw != null && wert > vereinbartKw) {
    return `${zahl(wert)} kW liegen über ${zahl(vereinbartKw)} kW vereinbarter Leistung — bitte prüfen.`;
  }
  return null;
}

export const BETRIEBSMODELLE = [
  { id: 'speicher-fahrplan', label: 'Speicher-Fahrplan', text: 'Erzeugung und Verbrauch vorausschauend ausgleichen.' },
  { id: 'peak', label: 'Lastspitzenkappung', text: 'Lastspitzen innerhalb Ihrer Anschlussgrenze begrenzen.' },
  { id: 'arbitrage', label: 'Marktoptimierung', text: 'Günstige Stunden nutzen. Die Wahl schaltet noch nichts ein.' },
  { id: 'atypisch', label: 'Atypische Netznutzung', text: 'Die vereinbarten Hochlastzeitfenster berücksichtigen.' },
] as const;

export function hatSpeicher(entities: readonly SiteEntity[]): boolean {
  return entities.some((e) => /storage|battery|speicher/i.test(`${e.role} ${e.entityType} ${e.typeLabel}`));
}

export function waehleVerbraucher(verbraucher: readonly VerbraucherEintrag[]): VerbraucherEintrag[] {
  return verbraucher.filter((v) => v.optionen?.schreibbar === true);
}

function datum(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

function zahl(n: number): string {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(n);
}
