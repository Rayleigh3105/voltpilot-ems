import type { ComponentTemplate, SiteComponentRow } from './api';
import type { KomponentenRolle } from './komponentenAssistent';

export const SECRET_MASK = '••••••••';

export type AenderungsZeile = { feld: string; vorher: string; nachher: string };

export function kundenRolle(row: SiteComponentRow): KomponentenRolle {
  if (row.entityType === 'battery-hybrid' || row.role === 'battery-hybrid') return 'inverter';
  if (row.entityType === 'producer' || row.role === 'producer') return 'pv-generation';
  if (row.entityType === 'grid-meter' || row.role === 'grid-meter') return 'grid-meter';
  return 'consumer';
}

function sichtbar(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'nicht gesetzt';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return String(value);
}

function secret(field: { key: string; type?: string; secret?: boolean }): boolean {
  const key = field.key.toLowerCase();
  return Boolean(field.secret) || field.type === 'password' || key.includes('password')
    || key.includes('secret') || key.endsWith('token') || key.endsWith('api_key');
}

export function istSecret(field: { key: string; type?: string; secret?: boolean }): boolean {
  return secret(field);
}

/**
 * Bringt eine Formular-Eingabe auf den JSON-Typ, den das `transport_schema`
 * dem Feld gibt. Ein Eingabefeld liefert IMMER Text (`e.target.value`), die Box
 * liest die Verbindung aber in typisierte Felder: `"unit_id": "01"` hat den
 * ganzen Push der Anlage abgelehnt (Scout vp-kundenanlage-drei-geraete,
 * 04.11.2026).
 *
 * - `number`: Text wird zur Zahl (Komma wie Punkt); leer bleibt leer ("nicht
 *   gesetzt" - `verbindungFuerSpeichern` lässt es weg), Unlesbares bleibt Text
 *   und wird von der API mit dem Feldnamen abgelehnt, statt zu verschwinden.
 * - Auswahl mit Optionen: der Picker liefert den Optionswert als Text; zurück
 *   kommt der Wert in seinem Schema-Typ (`16`, nicht `"16"`).
 */
export function normalisiereFeldEingabe(
  field: { type?: string; options?: { value: string | number }[] },
  value: unknown,
): unknown {
  if (field.options?.length && (typeof value === 'string' || typeof value === 'number')) {
    const option = field.options.find((o) => String(o.value) === String(value));
    if (option) return option.value;
  }
  if (field.type === 'number' && typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (text === '') return '';
    const zahl = Number(text);
    return Number.isFinite(zahl) ? zahl : value;
  }
  return value;
}

/**
 * Geheimnisse, die der Mensch nicht angefasst hat, verlassen das Formular
 * nicht. Der Server setzt fehlende Werte aus der gespeicherten Fassung wieder
 * ein; nur ein wirklich neuer Wert wird damit je als Secret übertragen.
 */
export function verbindungFuerSpeichern(
  template: ComponentTemplate,
  connection: Record<string, unknown>,
): Record<string, unknown> {
  const fields = new Map((template.transportSchema ?? []).map((field) => [field.key, field]));
  return Object.fromEntries(Object.entries(connection).filter(([key, value]) => {
    const field = fields.get(key);
    // Ein leeres Zahlenfeld heißt "nicht gesetzt" (die Box setzt ihre Vorgabe), nie "".
    if (field?.type === 'number' && (value === '' || value == null)) return false;
    return !(field && secret(field) && (value === '' || value === SECRET_MASK || value == null));
  }).map(([key, value]) => {
    // Auch Altbestand (gespeichertes "01") und Vorbelegungen gehen typrichtig hinaus.
    const field = fields.get(key);
    return [key, field ? normalisiereFeldEingabe(field, value) : value];
  }));
}

/** Nur die Verbindung, die das Gerät wirklich bekommt; Serverbelege zählen nicht als Eingabe. */
export function verbindungsFingerprint(value: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([key]) => key !== 'allow_missing_soc' && key !== 'reading_override')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function brauchtVerbindungstest(
  row: SiteComponentRow,
  template: ComponentTemplate | null,
  templateVersion: number | null,
  connection: Record<string, unknown>,
): boolean {
  if (!template || row.templateRef !== template.templateRef
    || row.templateVersion !== templateVersion) return true;
  return JSON.stringify(verbindungsFingerprint(row.connection))
    !== JSON.stringify(verbindungsFingerprint(connection));
}

export function normalisiereSecretEingabe(
  field: { key: string; type?: string; secret?: boolean },
  value: unknown,
  original: unknown,
): unknown {
  return secret(field) && original === SECRET_MASK && (value === '' || value == null)
    ? SECRET_MASK
    : value;
}

export function delta(
  row: SiteComponentRow,
  template: ComponentTemplate,
  templateVersion: number | null,
  role: KomponentenRolle,
  name: string,
  connection: Record<string, unknown>,
  capacityKwp: string,
): AenderungsZeile[] {
  const out: AenderungsZeile[] = [];
  const add = (feld: string, vorher: unknown, nachher: unknown) => {
    if (JSON.stringify(vorher ?? null) !== JSON.stringify(nachher ?? null)) {
      out.push({ feld, vorher: sichtbar(vorher), nachher: sichtbar(nachher) });
    }
  };
  add('Anzeigename', row.label?.trim() || null, name.trim() || null);
  if (row.brand !== template.brand || row.model !== template.model) {
    out.push({
      feld: 'Hersteller / Modell',
      vorher: sichtbar([row.brand, row.model].filter(Boolean).join(' ')),
      nachher: `${template.brandLabel} ${template.modelLabel}`.trim(),
    });
  }
  add('Vorlagenfassung', row.templateVersion, templateVersion);
  add('Gerätefamilie', row.family, template.family);
  add('Elektrische Rolle', kundenRolle(row), role);
  add('Nennleistung', row.capacityKwp, capacityKwp.trim() ? Number(capacityKwp) : null);
  const fields = template.transportSchema ?? [];
  const keys = new Set([...Object.keys(row.connection ?? {}), ...Object.keys(connection)]);
  for (const key of keys) {
    if (key === 'allow_missing_soc' || key === 'reading_override' || key === 'interval_s') continue;
    const field = fields.find((f) => f.key === key);
    const before = row.connection?.[key];
    const after = connection[key];
    if (field && secret(field)) {
      if (after !== undefined && after !== '' && after !== SECRET_MASK) {
        out.push({ feld: field.label, vorher: '••••••••', nachher: 'neu gesetzt' });
      }
      continue;
    }
    add(field?.label ?? key, before, after);
  }
  return out;
}

export function auswirkungen(rows: AenderungsZeile[]): string[] {
  const names = rows.map((r) => r.feld);
  const out = ['Geräte-ID, Messhistorie, Transaktionen, Befehle und Audit bleiben erhalten.'];
  if (names.includes('Gerätefamilie') || names.includes('Hersteller / Modell')) {
    out.push('Die neue Decoder- und Registerzuordnung gilt erst ab dieser Änderung; alte Messwerte werden nie neu interpretiert.');
  }
  if (rows.some((r) => !['Anzeigename', 'Nennleistung', 'Elektrische Rolle'].includes(r.feld))) {
    out.push('Die bisher aktive Verbindung läuft weiter, bis die Box die neue Fassung vollständig bestätigt.');
  }
  if (names.includes('Elektrische Rolle') || names.includes('Nennleistung')) {
    out.push('Bilanz, Plausibilitätsgrenzen und Steuerung werden ab der neuen Fassung neu geprüft.');
  }
  return out;
}
