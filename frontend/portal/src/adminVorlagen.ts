/**
 * Die REINE Ableitung der Vorlagen-Verwaltung (Einheitsmodell Stufe 6).
 *
 * <p>Kein React, kein Netz - das Haus-Muster von `adminEdgeUpdates`,
 * `adminFleet`, `onboardingFunnel`: die Seite holt und rendert, hier stehen die
 * Wörter und die Urteile.
 *
 * <p><b>Die zwei Ehrlichkeitsregeln dieser Fläche:</b>
 * 1. Ein unbekannter Prüf-Zustand behauptet NICHTS („Unbekannt", nie
 *    „geprüft") - dieselbe Regel wie in `adminDeviceTypes`.
 * 2. Eine EINGEBAUTE Vorlage ist nicht editierbar, und die Fläche SAGT warum.
 *    Ein deaktivierter Knopf ohne Grund liest sich wie ein Fehler; ein
 *    aktiver Knopf, der 409 bringt, ist eine Sackgasse.
 */

/** Eine Vorlagen-Fassung, so wie `GET /api/v1/admin/component-templates` sie liefert. */
export interface AdminVorlage {
  templateRef: string;
  kind: string;
  version: number;
  brand: string;
  brandLabel: string;
  model: string;
  modelLabel: string;
  family?: string | null;
  familyLabel?: string | null;
  communication: string;
  communicationLabel?: string | null;
  transportSchema?: unknown;
  channels?: unknown;
  writes?: unknown;
  ratedKw?: number | null;
  controlTier?: number;
  certificationStatus: string;
  certifiedAt?: string | null;
  certificationNote?: string | null;
  note?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  updatedAt?: string | null;
  withdrawnAt?: string | null;
  withdrawnBy?: string | null;
  usedByComponents?: number;
}

export type Ton = 'ok' | 'warn' | 'off';

export interface Etikett {
  label: string;
  ton: Ton;
}

/** Woher die Vorlage kommt. */
export const HERKUNFT: Record<string, Etikett> = {
  builtin: { label: 'Eingebaut', ton: 'off' },
  certified: { label: 'Von VoltPilot eingetragen', ton: 'ok' },
  custom: { label: 'Privat', ton: 'off' },
};

/** Wofür die Plattform einsteht. */
export const PRUEFSTAND: Record<string, Etikett> = {
  builtin: { label: 'Mit der Software ausgeliefert', ton: 'off' },
  certified: { label: 'Geprüft', ton: 'ok' },
  in_certification: { label: 'Prüfung läuft', ton: 'warn' },
  not_certified: { label: 'Ungeprüft', ton: 'warn' },
};

/** Ein unbekanntes Wort behauptet nichts. */
export function herkunft(kind: string | null | undefined): Etikett {
  return (kind && HERKUNFT[kind]) || { label: 'Unbekannt', ton: 'off' };
}

export function pruefstand(status: string | null | undefined): Etikett {
  return (status && PRUEFSTAND[status]) || { label: 'Unbekannt', ton: 'off' };
}

/** Eine Vorlage mit allen ihren Fassungen - die Zeile der Verwaltung. */
export interface VorlagenGruppe {
  templateRef: string;
  kind: string;
  brandLabel: string;
  modelLabel: string;
  communicationLabel: string;
  /** Die Fassungen, neueste zuerst. */
  fassungen: AdminVorlage[];
  /** Die Fassung, die der Assistent gerade anbietet - `null`, wenn keine. */
  waehlbar: AdminVorlage | null;
  /** Wie viele Komponenten der Flotte auf diesem Schlüssel stehen. */
  benutztVon: number;
  /** Kann ein Betreiber hier etwas ändern? */
  editierbar: boolean;
  /** Warum nicht - `null`, wenn editierbar. */
  gesperrtWeil: string | null;
}

/**
 * ⚠ Der EINE Satz zur eingebauten Vorlage. Er nennt den WEG (Katalog +
 * Auslieferung), statt nur zu sperren - dieselbe Haltung wie
 * `HOST_NOT_PRIVATE` beim Selbstbau.
 */
export const BUILTIN_GESPERRT =
  'Diese Vorlage kommt bei jedem Start aus dem Geräte-Katalog der Edge-Software. ' +
  'Eine Änderung hier wäre beim nächsten Neustart wieder weg - der Weg führt über ' +
  'den Katalog und eine neue Edge-Auslieferung.';

/**
 * Fasst die flache Fassungs-Liste zu Vorlagen zusammen.
 *
 * <p>Die Reihenfolge der Gruppen folgt der Antwort (Marke, Modell); innerhalb
 * einer Gruppe die neueste Fassung zuerst - wie der Server sortiert, damit die
 * Fläche keine zweite Ordnung erfindet.
 */
export function gruppen(rows: AdminVorlage[]): VorlagenGruppe[] {
  const byRef = new Map<string, AdminVorlage[]>();
  for (const r of rows) {
    const list = byRef.get(r.templateRef);
    if (list) list.push(r);
    else byRef.set(r.templateRef, [r]);
  }
  const out: VorlagenGruppe[] = [];
  for (const [templateRef, all] of byRef) {
    const fassungen = [...all].sort((a, b) => b.version - a.version);
    const neueste = fassungen[0];
    const builtin = neueste.kind === 'builtin';
    out.push({
      templateRef,
      kind: neueste.kind,
      brandLabel: neueste.brandLabel || neueste.brand,
      modelLabel: neueste.modelLabel || neueste.model,
      communicationLabel: neueste.communicationLabel || neueste.communication,
      fassungen,
      // ⚠ Die Auswahl ist die HÖCHSTE NICHT-zurückgezogene Fassung - genau die
      // Regel des Servers. Eine zurückgezogene Fassung 2 fällt auf 1 zurück.
      waehlbar: fassungen.find((f) => !f.withdrawnAt) ?? null,
      benutztVon: neueste.usedByComponents ?? 0,
      editierbar: !builtin,
      gesperrtWeil: builtin ? BUILTIN_GESPERRT : null,
    });
  }
  return out;
}

/** Der Zustand EINER Fassung in einem Wort. */
export function fassungsZustand(f: AdminVorlage, gruppe: VorlagenGruppe): Etikett {
  if (f.withdrawnAt) return { label: 'Zurückgezogen', ton: 'off' };
  if (gruppe.waehlbar && gruppe.waehlbar.version === f.version) {
    return { label: 'In der Auswahl', ton: 'ok' };
  }
  return { label: 'Überholt', ton: 'off' };
}

/**
 * Was eine Vorlage erklärt - und was ausdrücklich NICHT.
 *
 * <p>⚠ `null` heißt „hier nicht erklärt", `[]` gäbe es gar nicht (der Server
 * lehnt eine leere Liste ab). Die Fläche muss den Unterschied SAGEN: „keine
 * Angabe" ist etwas anderes als „liefert keine Messwerte".
 */
export function umfang(f: AdminVorlage): string[] {
  const teile: string[] = [];
  const felder = Array.isArray(f.transportSchema) ? f.transportSchema.length : 0;
  teile.push(felder === 1 ? '1 Verbindungsfeld' : `${felder} Verbindungsfelder`);
  teile.push(
    Array.isArray(f.channels)
      ? `${f.channels.length} Messwerte`
      : 'Messwerte: keine Angabe',
  );
  teile.push(
    Array.isArray(f.writes)
      ? `${f.writes.length} Schreib-Fähigkeiten`
      : 'Schreiben: keine Angabe',
  );
  return teile;
}

/**
 * Die Folgenliste einer Rücknahme - der Haus-`ConfirmDialog` verlangt sie.
 *
 * <p>Sie nennt AUSDRÜCKLICH, was GLEICH bleibt: ohne diesen Satz liest sich
 * jede Rücknahme wie ein Eingriff in laufende Anlagen (die Lehre aus der
 * Wellen-Automatik).
 */
export function ruecknahmeFolgen(gruppe: VorlagenGruppe, version: number): string[] {
  const rest = gruppe.fassungen.filter((f) => f.version !== version && !f.withdrawnAt);
  const naechste = rest.length ? rest[0] : null;
  const folgen = [
    naechste
      ? `Der Assistent bietet ab sofort Fassung ${naechste.version} an.`
      : 'Diese Vorlage steht dann nicht mehr zur Auswahl.',
  ];
  folgen.push(
    gruppe.benutztVon === 0
      ? 'Aktuell nutzt keine Komponente diese Vorlage.'
      : `${gruppe.benutztVon} ${gruppe.benutztVon === 1 ? 'Komponente läuft' : 'Komponenten laufen'} ` +
        'damit — sie ändern sich NICHT und laufen unverändert weiter.',
  );
  folgen.push('Die Fassung wird nicht gelöscht; Sie können sie jederzeit wieder freigeben.');
  return folgen;
}

/**
 * Die Papier-Spur einer Fassung: wer sie eingetragen und wer sie
 * zurückgezogen hat.
 *
 * <p>Das ist die Audit-Sicht, die DIESE Stufe hat - sie ist von Anfang an
 * gefüllt, nicht eine leere Fläche mit einem Versprechen.
 */
export function spur(f: AdminVorlage): string[] {
  const out: string[] = [];
  if (f.createdBy) out.push(`Eingetragen von ${f.createdBy}`);
  if (f.withdrawnBy) out.push(`Zurückgezogen von ${f.withdrawnBy}`);
  return out;
}

/** Der Kopf-Satz der Seite - er zählt nur BELEGTES. */
export function bestand(gruppen0: VorlagenGruppe[]): string {
  const eigene = gruppen0.filter((g) => g.kind === 'certified');
  const eingebaut = gruppen0.filter((g) => g.kind === 'builtin');
  if (!gruppen0.length) {
    return 'Das Register ist leer — der Start-Abgleich hat noch nicht gelaufen.';
  }
  const teile = [`${eingebaut.length} eingebaute Vorlagen`];
  teile.push(
    eigene.length === 1
      ? '1 selbst eingetragene'
      : `${eigene.length} selbst eingetragene`,
  );
  const zurueck = gruppen0.filter((g) => !g.waehlbar).length;
  if (zurueck) teile.push(`${zurueck} nicht mehr wählbar`);
  return teile.join(' · ');
}
