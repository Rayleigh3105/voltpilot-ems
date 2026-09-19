import {
  ApiError,
  type NetzanschlussAnfrage,
  type NetzanschlussBinden,
  type NetzanschlussUebernehmen,
  type StandorteAmStichtag,
} from '../src/api';
import { ahrenbergNetzanschluesse } from '../src/test/netzanschlussFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from '../src/test/standorteFixtures';
import { anschlussDerAnlage, bindungPruefen, giltAm } from '../src/netzanschlussListe';
import { minusTage } from '../src/uemsBilanz';

export function netzanschlussBuehne(standorte: StandorteAmStichtag) {
  const params = new URLSearchParams(location.search);
  const liste = ['leer', 'vorschlag'].includes(params.get('netz') ?? '') ? [] : ahrenbergNetzanschluesse();
  if (params.get('netz') === 'ungebunden')
    liste.forEach((n) => {
      n.anlagen = [];
    });
  const entschieden = new Set<string>();
  const aufrufe = {
    uebernehmen: [] as NetzanschlussUebernehmen[],
    verwerfen: [] as string[],
    anlegen: [] as NetzanschlussAnfrage[],
    binden: [] as NetzanschlussBinden[],
  };
  Object.assign(window, { naAufrufe: aufrufe });
  const standort = (id: string) => ({
    id,
    kurzzeichen: id === FIXTURE_IDS.st1 ? 'ST-1' : 'ST-2',
  });
  return {
    standorte: async (am = standorte.stichtag) => ({
      ...structuredClone(standorte),
      stichtag: am,
      standorte: standorte.standorte.map((s) => ({
        ...s,
        anlagen: s.anlagen.map((a) => {
          const n = anschlussDerAnlage(liste, a.id, am),
            b = n?.anlagen.find((b) => b.anlage.id === a.id && giltAm(b, am));
          return {
            ...a,
            netzanschluss:
              n && b
                ? {
                    id: n.id,
                    kennzeichen: n.kennzeichen,
                    gueltigAb: b.gueltig_ab,
                    gueltigBis: b.gueltig_bis,
                  }
                : null,
          };
        }),
      })),
    }),
    netzanschlussVorschlaege: async (id: string) =>
      params.get('netz') !== 'vorschlag'
        ? []
        : standorte.standorte
            .find((s) => s.id === id)!
            .anlagen.filter(
              (a) =>
                !entschieden.has(a.id) && !liste.some((n) => n.anlagen.some((b) => b.anlage.id === a.id)),
            )
            .map((a, i) => ({
              anlage_id: a.id,
              anlage_name: a.name,
              bindung_ab: a.gueltigAb,
              kennzeichen: `NA-000${liste.length + i + 1}`,
              name: `Netzanschluss ${a.name}`,
            })),
    netzanschlussVerwerfen: async (_id: string, anlage: string) => {
      entschieden.add(anlage);
      aufrufe.verwerfen.push(anlage);
    },
    netzanschlussUebernehmen: async (id: string, anlage: string, body: NetzanschlussUebernehmen) => {
      if (entschieden.has(anlage))
        throw new ApiError(409, 'Nicht mehr verfügbar', {
          message: 'Dieser Vorschlag ist nicht mehr verfügbar.',
        });
      const a = standorte.standorte.find((s) => s.id === id)!.anlagen.find((a) => a.id === anlage)!;
      const { bindung_ab, grund: _grund, ...felder } = body;
      const n = {
        ...felder,
        id: `na-${anlage}`,
        kennzeichen: body.kennzeichen ?? 'NA-0001',
        standort: standort(id),
        hinweise: [],
        angelegt_am: new Date().toISOString(),
        anlagen: [
          {
            id: `bindung-${anlage}`,
            anlage: { id: anlage, name: a.name },
            gueltig_ab: bindung_ab,
            gueltig_bis: null,
          },
        ],
      };
      liste.push(n);
      entschieden.add(anlage);
      aufrufe.uebernehmen.push(body);
      return structuredClone(n);
    },
    netzanschluesse: async (id: string, am?: string) => {
      if (params.get('netz') === 'fehler') throw new Error('Lesefehler der Bühne');
      return structuredClone({
        standort: standort(id),
        stichtag: am ?? null,
        kennzeichen_vorschlag: 'NA-0004',
        netzanschluesse: liste
          .filter((n) => n.standort.id === id && (!am || giltAm(n, am)))
          .map((n) => ({
            ...n,
            anlagen: n.anlagen.filter((b) => !am || giltAm(b, am)),
          })),
      });
    },
    netzanschlussAnlegen: async (id: string, body: NetzanschlussAnfrage) => {
      aufrufe.anlegen.push(body);
      const n = {
        ...body,
        id: 'na-neu',
        kennzeichen: body.kennzeichen ?? 'NA-0004',
        standort: standort(id),
        hinweise: [],
        anlagen: [],
        angelegt_am: new Date().toISOString(),
      };
      liste.push(n);
      return structuredClone(n);
    },
    netzanschlussBinden: async (_standort: string, id: string, body: NetzanschlussBinden) => {
      aufrufe.binden.push(body);
      if (params.get('netz') === 'konflikt')
        throw new ApiError(409, 'Bindung überlappt', {
          code: 'bindung_ueberlappt',
          message: 'Die Bindung überschneidet sich mit einer bestehenden Bindung.',
        });
      const n = liste.find((n) => n.id === id)!;
      const u = bindungPruefen(liste, n, body.anlage_id, body.gueltig_ab, '2026-10-20');
      if (u.feld) throw new Error(u.text);
      liste.forEach((n) =>
        n.anlagen.forEach((b) => {
          if (b.anlage.id === body.anlage_id && giltAm(b, body.gueltig_ab))
            b.gueltig_bis = minusTage(body.gueltig_ab, 1);
        }),
      );
      const a = [...werkAhrenberg().anlagen, ...werkLindach().anlagen].find((a) => a.id === body.anlage_id)!;
      n.anlagen.push({
        id: `bindung-${aufrufe.binden.length}`,
        anlage: { id: a.id, name: a.name },
        gueltig_ab: body.gueltig_ab,
        gueltig_bis: n.gueltig_bis,
      });
      return structuredClone(n);
    },
  };
}
