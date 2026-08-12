/**
 * Die REINEN Regeln der EIGENEN Vorlagen einer Anlage (Einheitsmodell
 * Stufe 6, Vervollständigung der Selbstbau-Tür).
 *
 * <p>Eine eigene Vorlage entsteht beim „Duplizieren" eines selbst gebauten
 * Geräts und beschreibt einen GERÄTETYP - Anschluss und Messwerte, aber
 * <b>ausdrücklich NICHT die Adresse des Originals</b> (der Server streift sie
 * ab; hier wird das SICHTBAR gemacht, damit niemand sie sucht).
 *
 * <p>Sie ist PRIVAT je Anlage: sie wird nicht geteilt, steht in keinem Katalog
 * und erscheint nie in der öffentlichen Vorlagen-Liste.
 */

/** Eine private Vorlage, so wie `GET /sites/{id}/component-templates` sie liefert. */
export interface EigeneVorlage {
  templateRef: string;
  version: number;
  label: string;
  communication: string;
  /** Anschluss OHNE Adresse - Port und Unit-ID sind Eigenschaften des Typs. */
  connection?: Record<string, unknown> | null;
  channels?: unknown;
  note?: string | null;
  createdAt?: string | null;
}

/** Eine Zeile der Liste - alles, was die Fläche zeigt, ohne sie zu rechnen. */
export interface VorlagenZeile {
  templateRef: string;
  label: string;
  /** „3 Messwerte · Port 502 · Unit-ID 1" */
  umfang: string;
  note: string | null;
  /** Kann daraus ein Gerät entstehen? Ohne Messwerte hätte es keinen Leseplan. */
  verwendbar: boolean;
}

export function zeilen(list: EigeneVorlage[]): VorlagenZeile[] {
  return list.map((v) => {
    const kanaele = Array.isArray(v.channels) ? v.channels.length : 0;
    const teile = [kanaele === 1 ? '1 Messwert' : `${kanaele} Messwerte`];
    const port = v.connection?.port;
    const unit = v.connection?.unit_id;
    if (typeof port === 'number') teile.push(`Port ${port}`);
    if (typeof unit === 'number') teile.push(`Unit-ID ${unit}`);
    return {
      templateRef: v.templateRef,
      label: v.label,
      umfang: teile.join(' · '),
      note: v.note?.trim() ? v.note.trim() : null,
      verwendbar: kanaele > 0,
    };
  });
}

/**
 * ⚠ Der EINE Satz, warum in der Vorlage keine Adresse steht.
 *
 * <p>Ohne ihn sucht der Kunde ein Feld, das es absichtlich nicht gibt - und
 * hielte das Fehlen für einen Fehler.
 */
export const KEINE_ADRESSE =
  'Eine Vorlage beschreibt einen Gerätetyp, kein einzelnes Gerät. ' +
  'Die Adresse im Netzwerk tragen Sie beim Anlegen ein.';

/** Der Kopf-Satz der Fläche - ohne Vorlagen erklärt er, wie eine entsteht. */
export function kopfSatz(anzahl: number): string {
  if (anzahl === 0) {
    return 'Noch keine eigenen Vorlagen. Aus jedem selbst angelegten Gerät können Sie eine machen — ' +
      'dann ist das nächste gleiche Gerät in wenigen Klicks eingerichtet.';
  }
  return anzahl === 1
    ? 'Eine eigene Vorlage, nur für diese Anlage.'
    : `${anzahl} eigene Vorlagen, nur für diese Anlage.`;
}

/** Die Folgenliste des Löschens - der Haus-Dialog verlangt sie. */
export function loeschFolgen(zeile: VorlagenZeile): string[] {
  return [
    `Die Vorlage „${zeile.label}" verschwindet aus der Auswahl.`,
    'Geräte, die Sie daraus angelegt haben, laufen unverändert weiter.',
    'Aus einem dieser Geräte können Sie jederzeit eine neue Vorlage machen.',
  ];
}

/** Ein Name muss bleiben - eine namenlose Vorlage ist in der Auswahl nicht unterscheidbar. */
export function nameFehler(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Bitte geben Sie der Vorlage einen Namen.';
  if (n.length > 200) return 'Der Name ist zu lang (höchstens 200 Zeichen).';
  return null;
}

/** Der Vorschlag beim Duplizieren - derselbe, den der Server ohne Namen bildet. */
export function vorschlagsName(geraetName: string): string {
  return `${geraetName} (Vorlage)`;
}

/**
 * Die Vorbefüllung des Selbstbau-Assistenten aus einer Vorlage.
 *
 * <p>⚠ Der HOST bleibt leer - die Vorlage kennt ihn nicht, und ihn zu raten
 * (etwa aus einem Geschwister-Gerät) hieße, das zweite Gerät auf das erste
 * zeigen zu lassen; das fiele erst auf, wenn beide dieselben Werte melden.
 */
export interface VorlagenPrefill {
  label: string;
  port: string;
  unitId: string;
  zeilen: {
    label: string;
    unit: string;
    registerKind: string;
    address: string;
    dataType: string;
    wordOrder: string;
    scale: string;
    offset: string;
    minReadIntervalS: string;
  }[];
}

export function prefill(v: EigeneVorlage): VorlagenPrefill {
  const kanaele = Array.isArray(v.channels) ? (v.channels as Record<string, unknown>[]) : [];
  return {
    label: v.label,
    port: String(v.connection?.port ?? 502),
    unitId: String(v.connection?.unit_id ?? 1),
    zeilen: kanaele.map((c) => {
      const reg = (c.register ?? {}) as Record<string, unknown>;
      return {
        label: text(c.label),
        unit: text(c.unit),
        registerKind: text(reg.kind) || 'holding',
        address: num(reg.address, ''),
        dataType: text(reg.data_type) || 'u16',
        wordOrder: text(reg.word_order) || 'big',
        scale: num(c.scale, '1'),
        offset: num(c.offset, '0'),
        minReadIntervalS: num(c.min_read_interval_s, '10'),
      };
    }),
  };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown, fallback: string): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback;
}
