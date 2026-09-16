import referenz from '../../../docs/contracts/v2/uems-referenzunternehmen.json' with { type: 'json' };

/** Ahrenberg-Zahlen ausschließlich aus der Referenzdatei; Deye und A5 sind ausdrücklich Ankerfälle. */
export const STAND = '2026-10-20T08:15:12Z';
export type Register = { entityId: string; name: string; punkt: string; label: string; wert: number; direction: string | null; selected: boolean };
const ms = (kennzeichen: string) => referenz.messstellen.find((m) => m.kennzeichen === kennzeichen)!;
export const leistung = (kennzeichen: string) => ms(kennzeichen).beispielwerte.momentanleistung_kw!;
export const ahrenbergRoh = { pv: leistung('MS-03'), netz: leistung('MS-01'), verbrauch: ['MS-05', 'MS-06', 'MS-07', 'MS-08'].reduce((n, k) => n + leistung(k), 0) };
const kanal = (kennzeichen: string, entityId: string, label: string): Register => ({
  entityId, name: ms(kennzeichen).name, punkt: `${entityId}-power`, label,
  wert: ms(kennzeichen).beispielwerte.momentanleistung_kw!, direction: 'import', selected: true,
});
export const FAELLE = {
  deye: { titel: 'Deye SUN-30K', standort: 'ST-1', rolle: 'pv', name: 'PV mit Gen-Port', wert: 14.4, roh: 12.4,
    register: [
      ...[5.2, 4.1, 3.1].map((wert, i) => ({ entityId: 'inv', name: 'Deye SUN-30K', punkt: `pv${i + 1}`, label: `PV ${i + 1}`, wert, direction: 'generation', selected: true })),
      { entityId: 'inv', name: 'Deye SUN-30K', punkt: 'deye.hybrid_3p.generator-smartload-microinverter.generator-power', label: 'Gen-Port', wert: 2, direction: null, selected: false },
    ] as Register[] },
  ahrenberg: { titel: 'Werk Ahrenberg · Halle 1', standort: 'ST-1', rolle: 'consumer', name: 'Verbrauch Produktion Halle 1 jetzt', wert: 213.5, roh: ahrenbergRoh.verbrauch,
    register: [kanal('MS-06', 'K-5', 'Wirkleistung Spritzguss'), kanal('MS-07', 'K-6', 'Wirkleistung Druckluft'), kanal('MS-08', 'K-7', 'Wirkleistung Kühlung')] },
  lindach: { titel: 'Werk Lindach · WAGO-Controller C-2', standort: 'ST-2', rolle: 'consumer', name: 'Hallen Lindach jetzt', wert: 32.3, roh: ms('MS-16').beispielwerte.momentanleistung_kw!,
    register: [kanal('MS-17', 'K-10.1', 'EK-5 Wirkleistung'), kanal('MS-18', 'K-10.2', 'EK-6 Wirkleistung')] },
  netz: { titel: 'Ankerfall · Zähler mit Bezug und Abgabe', standort: 'ST-1', rolle: 'grid', name: 'Netz saldiert', wert: -2, roh: 6,
    register: [
      { entityId: 'meter', name: 'Zähler', punkt: 'bezug', label: 'Wirkleistung Bezug', wert: 8, direction: 'import', selected: true },
      { entityId: 'meter', name: 'Zähler', punkt: 'abgabe', label: 'Wirkleistung Abgabe', wert: 10, direction: 'export', selected: true },
    ] as Register[] },
};
export type Fall = keyof typeof FAELLE;
