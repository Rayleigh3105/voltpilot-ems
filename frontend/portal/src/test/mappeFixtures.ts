import { ApiError, type EnergiemanagementMappe, type EnergiemanagementMappeAnlegen } from '../api';
import type { BenutzerAngelegt, BenutzerAnlage } from '../benutzer';
import { VOKABULARE, WOERTER } from '../energiemanagement';

/**
 * Bühne von „Unterlagen zusammenstellen“ und „Einsicht geben“ (Konzept Nachweisen n1, Entscheide 7 und 8, PR 6) - ein
 * MOCK der Mappen-Routen (`…/energiemanagement/mappen`, openapi `EnergiemanagementMappe…`) und des Anlegens eines
 * Zugangs (`POST /api/v1/benutzer`). Er spielt Form und Wörter der Route nach, nicht ihre Prüfungen: Rechte, Mandant,
 * Frist und Abrufprotokoll prüft die Route selbst (`EnergiemanagementMappeApiTest`, `UemsMappeMigrationTest`).
 *
 * `jetzt` ist die Uhr der Bühne (in der Spec `page.clock`); `abruf` und `stichtag` tragen wie die Route den Versatz des
 * Unternehmens (Europe/Berlin). Jeder Schreib-Körper und jeder Abruf steht in `gesendet`.
 */

export type MappeLage = 'leer' | 'r6';

/** R6: eine Mappe vom 28.04.2029, noch abrufbar, und eine vom 10.03.2029, deren 30 Tage um sind. */
export const MAPPE_IDS = {
  abrufbar: '6a990000-0000-4000-8000-000000000001',
  abgelaufen: '6a990000-0000-4000-8000-000000000002',
} as const;

const TITEL: Record<string, string> = {
  audit_von_aussen: 'Unterlagen für das Audit',
  anfrage_behoerde: 'Unterlagen für die Behörde',
  eigene_ablage: 'Unterlagen für die eigene Ablage',
};
const AUFBEWAHRUNG_TAGE = 30;
const ABGELAUFEN = `Die Mappe war ${AUFBEWAHRUNG_TAGE} Tage abrufbar und ist es nicht mehr. Stellen Sie die Unterlagen neu zusammen.`;

/** Ein Augenblick als ISO mit dem Versatz von Europe/Berlin, auf die Minute - wie `OffsetDateTime` der Route. */
export function berlinAugenblick(iso: string): string {
  const ms = Math.floor(Date.parse(iso) / 60000) * 60000;
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const lokal = `${teile.year}-${teile.month}-${teile.day}T${teile.hour}:${teile.minute}:00`;
  const versatz = Math.round((Date.parse(`${lokal}Z`) - ms) / 60000);
  const v = `${versatz >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(versatz) / 60)).padStart(2, '0')}:${String(Math.abs(versatz) % 60).padStart(2, '0')}`;
  return `${lokal}${v}`;
}

const tagText = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function mappeBuehne(lage: MappeLage, jetzt: () => string, wer: { name: string }) {
  const gesendet: { route: string; body?: unknown }[] = [];
  const mappen: EnergiemanagementMappe[] = [];

  function mappe(id: string, anlass: string, von: string | null, stichtag: string, gruppen: string[], offen: string[]): EnergiemanagementMappe {
    const bis = stichtag.slice(0, 10);
    return {
      id,
      titel: TITEL[anlass],
      anlass,
      anlass_wort: WOERTER.mappe_anlass[anlass],
      von,
      bis,
      stichtag,
      gruppen,
      gruppen_woerter: gruppen.map((g) => WOERTER.verzeichnis_gruppe[g] ?? g),
      offen,
      offen_woerter: offen.map((t) => WOERTER.teil[t] ?? t),
      eintraege: 24,
      gilt: 9,
      datei_titel: `Nachweise Ahrenberg, ${tagText(bis)}`,
      datei_name: `nachweise-${bis}`,
      pdf_pruefsumme: 'a'.repeat(64),
      csv_pruefsumme: 'b'.repeat(64),
      abrufbar: true,
      abrufbar_tage: AUFBEWAHRUNG_TAGE,
      aufbewahrung_tage: AUFBEWAHRUNG_TAGE,
      abrufe: 0,
      erstellt: { name: wer.name, am: new Date(Date.parse(stichtag)).toISOString() },
      abruf: berlinAugenblick(jetzt()),
    };
  }

  // Wie die Datenbank: die Tage zählen ab dem Anlegen, nach 30 ist die Mappe nicht mehr abrufbar.
  function frisch(m: EnergiemanagementMappe): EnergiemanagementMappe {
    const tage = Math.ceil((Date.parse(m.erstellt.am) + AUFBEWAHRUNG_TAGE * 86_400_000 - Date.parse(jetzt())) / 86_400_000);
    const abrufbar = tage > 0;
    return { ...m, abrufbar, abrufbar_tage: abrufbar ? tage : 0, abruf: berlinAugenblick(jetzt()) };
  }

  if (lage === 'r6') {
    const alle = [...VOKABULARE.verzeichnis_gruppe];
    mappen.push(mappe(MAPPE_IDS.abrufbar, 'audit_von_aussen', '2028-04-29', '2029-04-28T09:30:00+02:00', alle, ['kontext', 'beschaffung']));
    mappen.push(mappe(MAPPE_IDS.abgelaufen, 'anfrage_behoerde', null, '2029-03-10T11:00:00+01:00', ['berichte'], []));
  }

  function finde(id: string): EnergiemanagementMappe {
    const m = mappen.find((x) => x.id === id);
    if (!m) throw new ApiError(404, 'Diese Mappe gibt es nicht.', { code: 'nicht_gefunden', message: 'Diese Mappe gibt es nicht.' });
    return m;
  }

  const routen = {
    energiemanagementMappen: async () => ({ mappen: [...mappen].reverse().map(frisch) }),
    energiemanagementMappe: async (id: string) => frisch(finde(id)),
    energiemanagementMappeAnlegen: async (body: EnergiemanagementMappeAnlegen) => {
      gesendet.push({ route: 'POST /mappen', body });
      if (!VOKABULARE.mappe_anlass.includes(body.anlass)) throw new ApiError(400, 'Unbekannter Anlass.', { code: 'anfrage', message: 'Unbekannter Anlass.', feld: 'anlass' });
      if (!body.gruppen.length) throw new ApiError(400, 'Mindestens eine Gruppe.', { code: 'anfrage', message: 'Mindestens eine Gruppe.', feld: 'gruppen' });
      const stichtag = berlinAugenblick(jetzt());
      const m = mappe(`6a990000-0000-4000-8000-${String(100 + mappen.length).padStart(12, '0')}`, body.anlass, body.von ?? null, stichtag, body.gruppen, body.offen ?? []);
      mappen.push(m);
      return m;
    },
    energiemanagementMappeDatei: async (id: string, format: 'pdf' | 'csv') => {
      const m = frisch(finde(id));
      if (!m.abrufbar) throw new ApiError(410, ABGELAUFEN, { code: 'mappe_abgelaufen', message: ABGELAUFEN });
      gesendet.push({ route: `GET /mappen/${id}/${format}` });
      const ziel = mappen.find((x) => x.id === id)!;
      ziel.abrufe += 1;
      return format === 'pdf'
        ? new Blob(['%PDF-1.7\n% Bühne: Mappe\n'], { type: 'application/pdf' })
        : new Blob(['\uFEFFgruppe;art;kennzeichen\n'], { type: 'text/csv;charset=UTF-8' });
    },
  };

  /** „Einsicht geben“: `POST /api/v1/benutzer` mit Rolle `einsicht` und `gueltig_bis`; das Startpasswort einmal. */
  const benutzer = {
    anlegen: async (anlage: BenutzerAnlage): Promise<BenutzerAngelegt> => {
      gesendet.push({ route: 'POST /benutzer', body: anlage });
      return {
        benutzer: { sub: 'einsicht-buehne', anzeigename: [anlage.vorname, anlage.nachname].filter(Boolean).join(' '), email: anlage.email, zustand: 'angelegt' },
        startpasswort: 'Buehne-Start-7Kq2',
      };
    },
  };

  return { routen, benutzer, gesendet };
}
