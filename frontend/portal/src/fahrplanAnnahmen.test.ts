import { describe, expect, it } from 'vitest';
import { planAnnahmen } from './fahrplanAnnahmen';
import { FALLBACK_14A_NOTE, FORECAST_FOOTNOTE } from './fahrplanWhy';
import { NBSP } from './format';

const BASIS = { planVon: null, slotMinutes: 15, plantKind: 'eigenverbrauch' as const };

describe('planAnnahmen · worauf der Plan achtet', () => {
  it('nennt nur gepflegte Werte - ohne Angaben bleiben die Prognosen', () => {
    const z = planAnnahmen(BASIS);
    expect(z.map((x) => x.key)).toEqual(['prognosen']);
    expect(z[0]).toMatchObject({ text: FORECAST_FOOTNOTE, link: { href: '#/prognose', text: 'Zur Prognosequalität' } });
  });

  it('beschreibt Tarif, Vermarktung, Netzladen und die Grenzen des Laufs', () => {
    const z = planAnnahmen({
      ...BASIS,
      planVon: new Date(2026, 8, 24, 14, 0),
      plantKind: 'direktvermarktung',
      tarifArt: 'fest',
      tarifParamCtKwh: 25,
      netzladenErlaubt: false,
      untergrenzePct: 10,
      einspeisegrenzeKw: 30,
      lastspitzeZielKw: 8,
      fallback14a: true,
    });
    const text = Object.fromEntries(z.map((x) => [x.key, `${x.titel}: ${x.text}`]));
    expect(text).toEqual({
      tarif: `Fester Strompreis: 25,0${NBSP}ct je kWh.`,
      vermarktung: 'Direktvermarktung: Verkauft wird zum Börsenpreis.',
      netzladen: 'Nur Solarladen (EEG): Der Speicher lädt nur aus Sonnenstrom (Ihre Einstellung).',
      untergrenze: `Untergrenze: Der Plan entlädt nicht unter 10${NBSP}%.`,
      einspeisegrenze: `Einspeisegrenze: 30,0${NBSP}kW am Netzanschluss.`,
      lastspitze: `Lastspitzen: Ziel: höchstens 8,0${NBSP}kW Netzbezug.`,
      '14a': `§ 14a: ${FALLBACK_14A_NOTE}`,
      neu: 'Neu geplant: Zuletzt um 14:00 Uhr; VoltPilot plant alle 15 Minuten neu.',
      prognosen: `Prognosen: ${FORECAST_FOOTNOTE}`,
    });
  });

  it('nennt beim dynamischen Tarif den Aufschlag, wenn es einen gibt', () => {
    const mit = planAnnahmen({ ...BASIS, tarifArt: 'dynamisch', tarifParamCtKwh: 4.5, netzladenErlaubt: true });
    expect(mit.find((x) => x.key === 'tarif')?.text).toBe(`Ihr Strompreis folgt der Börse, dazu 4,5${NBSP}ct Aufschlag je kWh.`);
    expect(mit.find((x) => x.key === 'netzladen')?.titel).toBe('Netzladen aktiv');
    const ohne = planAnnahmen({ ...BASIS, tarifArt: 'dynamisch', tarifParamCtKwh: null });
    expect(ohne.find((x) => x.key === 'tarif')?.text).toBe('Ihr Strompreis folgt der Börse.');
    // Ein fester Tarif ohne Preis ist keine Zeile - nie „fest zu —".
    expect(planAnnahmen({ ...BASIS, tarifArt: 'fest', tarifParamCtKwh: null }).some((x) => x.key === 'tarif')).toBe(false);
  });

  it('übernimmt die Lage - und den Horizont-Satz nur einmal', () => {
    const horizont = 'Der Fahrplan reicht bis zum Tagesende.';
    const lage = { bogen: 'Der Börsenpreis ist mittags am günstigsten.', ausblick: horizont, nachtreserve: 'Hält 0,3 kWh für die Nacht.', bedingung: '', quelle: '' };
    const z = planAnnahmen({ ...BASIS, lage, horizont });
    expect(z.map((x) => x.key)).toEqual(['bogen', 'ausblick', 'nachtreserve', 'prognosen']);
    const ohneLage = planAnnahmen({ ...BASIS, horizont });
    expect(ohneLage[0]).toMatchObject({ key: 'horizont', text: horizont });
  });
});
