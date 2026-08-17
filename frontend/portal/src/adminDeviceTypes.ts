/**
 * Die reine Ableitung der Plattform-Admin-Liste „Steuerbare Gerätetypen"
 * (Inkrement 5 / D11). Wahrheitsquelle ist der entitytypes-Katalog (Backend
 * `GET /api/v1/admin/consumer-device-types`); diese Fläche ist READ-ONLY und
 * erfindet nie eine Zertifizierung - ein Katalog-Status, den wir nicht kennen,
 * wird ehrlich „Unbekannt", nie „zertifiziert".
 */
import type { ConsumerDeviceType } from './admin/adminApi';

export type CertTone = 'ok' | 'warn' | 'off';

export interface CertView {
  label: string;
  tone: CertTone;
}

/** Der Katalog-Status → Wort + Ton. */
export const CERT_STATUS: Record<string, CertView> = {
  certified: { label: 'Zertifiziert (plattformweit)', tone: 'ok' },
  in_certification: { label: 'In Zertifizierung', tone: 'warn' },
  simulator_only: { label: 'Nur Simulator', tone: 'off' },
  not_certified: { label: 'Nicht zertifiziert', tone: 'off' },
  // Einheitsmodell Stufe 4: eine Geräteart, deren Freigabe strukturell JE GERÄT
  // erfolgt (der geführte Schalt-Test) - eine Prüfstands-Zertifizierung ist für
  // frei definierte Geräte unmöglich, es gibt kein Modell auf einem Tisch.
  // Deshalb ein eigenes Wort statt „nicht zertifiziert": das läse sich wie ein
  // fehlender Lauf, den jemand nachholen könnte.
  per_device: { label: 'Freigabe je Gerät', tone: 'ok' },
};

/** Ein unbekannter Status behauptet NICHTS (nie „zertifiziert"). */
export function certView(status: string | null | undefined): CertView {
  return (status && CERT_STATUS[status]) || { label: 'Unbekannt', tone: 'off' };
}

/** ISO-Datum → DD.MM.YYYY (deterministisch, ohne Zeitzonen-Abhängigkeit). */
function isoDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

/**
 * Die Detail-Zeile: bei einem zertifizierten Typ „seit {Datum}" (nur mit
 * echtem Datum), dazu die Katalog-Notiz, wenn vorhanden. '' wenn nichts zu
 * sagen ist.
 */
export function certDetail(dt: ConsumerDeviceType): string {
  const parts: string[] = [];
  if (dt.certificationStatus === 'certified' && dt.certifiedAt) {
    const d = isoDate(dt.certifiedAt);
    if (d) parts.push(`seit ${d}`);
  }
  if (dt.certificationNotes) parts.push(dt.certificationNotes);
  return parts.join(' · ');
}

const TONE_RANK: Record<CertTone, number> = { ok: 0, warn: 1, off: 2 };

/** Zertifizierte Typen zuerst, dann in Zertifizierung, dann Rest; je Ton nach Label. */
export function deviceTypeRows(types: ConsumerDeviceType[]): ConsumerDeviceType[] {
  return [...types].sort((a, b) => {
    const ra = TONE_RANK[certView(a.certificationStatus).tone];
    const rb = TONE_RANK[certView(b.certificationStatus).tone];
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label, 'de');
  });
}

/**
 * Der EINE ehrliche Kopfsatz: wie viele Typen zertifiziert sind, plus - wenn
 * KEINER zertifiziert ist - der wahre heutige Anfangszustand („nur der
 * Simulator, kein realer Typ").
 */
export function certSummary(types: ConsumerDeviceType[]): string {
  if (types.length === 0) return 'Noch keine steuerbaren Gerätetypen.';
  const certified = types.filter((t) => t.certificationStatus === 'certified').length;
  if (certified === 0) {
    return 'Heute ist kein realer Gerätetyp plattformweit zertifiziert - nur der Simulator.';
  }
  return `${certified} von ${types.length} Gerätetypen plattformweit zertifiziert.`;
}
