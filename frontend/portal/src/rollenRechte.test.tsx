import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Recht } from './components/Recht';
import { darf, grundUndWeg, ohneStandort, RechteStandort, setSelbstauskunft, sichtbareStandorte, teilansichtKopf } from './rollen';
import { darf as vertragDarf } from './rechte';
import { rechteSeed, RECHTE_MATRIX, STANDORT_IDS } from './test/rollenFixtures';
import { startEbene } from './betriebsart';

afterEach(cleanup);
const PERSONEN = ['JW', 'IK', 'PH', 'MD', 'CB', 'TB', 'LV', 'SR'];

describe('IP-12 · jede Matrix-Zeile über Ahrenberg-/me', () => {
  for (const aktion of RECHTE_MATRIX.keys()) it(aktion, () => {
    for (const person of PERSONEN) {
      const { me, benutzer, kundenbereich, jetzt } = rechteSeed(person);
      setSelbstauskunft(me);
      for (const standort of [null, ...kundenbereich.standorte.map(s => s.kennzeichen)]) {
        const erwartet = (standort === null || me.standorte.some(s => s.kennzeichen === standort)) && vertragDarf(RECHTE_MATRIX, benutzer, kundenbereich, aktion,
          { standort, anlage: null, stichtag: null }, jetzt).darf;
        expect(darf(aktion, standort ? STANDORT_IDS[standort] : null), `${person}: ${standort}`).toBe(erwartet);
      }
      expect(darf(aktion, 'unsichtbar')).toBe(false);
    }
  });
});

it('R1 · Murat darf eingreifen und die Betriebsweise ändern, aber weder Freigabe noch Grenze', () => {
  setSelbstauskunft(rechteSeed('MD').me);
  for (const aktion of ['handeingriff.setzen', 'betriebsweise.aendern', 'steuerung.anhalten_fortsetzen']) {
    expect(darf(aktion, STANDORT_IDS['ST-1'])).toBe(true);
  }
  render(<RechteStandort.Provider value={STANDORT_IDS['ST-1']}>
    <Recht aktion="handeingriff.setzen"><button>Eingreifen</button></Recht>
    <Recht aktion="freigabe.erteilen"><button>Freigeben</button></Recht>
    <Recht aktion="grenze.eintragen"><button>Grenze ändern</button></Recht>
  </RechteStandort.Provider>);
  expect(screen.getByRole('button', { name: 'Eingreifen' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Grenze ändern' })).toBeNull();
  expect(screen.getAllByRole('note')).toHaveLength(2);
  expect(grundUndWeg()).toContain('Jonas Wendlinger');
});

it('T1 · Claudia sieht die zwei gelieferten Standorte und den Teilansicht-Kopf, keinen fremden Namen', () => {
  const { me } = rechteSeed('CB');
  setSelbstauskunft(me);
  expect(sichtbareStandorte().map(s => s.kennzeichen)).toEqual(['ST-1', 'ST-2']);
  expect(teilansichtKopf()).toContain('2 von 3 Standorten');
  expect(teilansichtKopf()).not.toContain('Werk Nord');
  expect(darf('handeingriff.setzen', STANDORT_IDS['ST-1'])).toBe(false);
});

it('T3 · Peter landet mit nur einem sichtbaren Standort auf Werk Lindach, auch ohne Anlage', () => {
  const { me } = rechteSeed('PH');
  setSelbstauskunft(me);
  const orte = { standorte: me.standorte.map(s => ({ id: s.id, name: s.name, anlagen: [] })),
    standorteGesamt: me.teilansicht!.gesamt, unternehmen: me.kundenbereich!.name };
  const ebene = startEbene({ isAdmin: false, betriebsart: 'betreiber', siteIds: [], orte, eingeschraenkt: true });
  expect(ebene.art).toBe('standort');
  expect(orte.standorte.map(s => s.name)).toEqual(['Werk Lindach']);
});

it('L3 · keine Standorte; unbekannte, gesperrte und entzogene Rechte bleiben geschlossen', () => {
  setSelbstauskunft(null);
  expect(darf('anlage.verwalten')).toBe(false);
  const { me } = rechteSeed('PH');
  setSelbstauskunft({ ...me, standorte: [] });
  expect(ohneStandort()).toBe(true);
  expect(darf('handeingriff.setzen', STANDORT_IDS['ST-2'])).toBe(false);
  setSelbstauskunft({ ...rechteSeed('JW').me, zustand: 'gesperrt' });
  expect(darf('anlage.verwalten')).toBe(false);
});

it('Unerlaubte fremde Ziele verraten keinen Ort und keinen Hebel', () => {
  setSelbstauskunft(rechteSeed('PH').me);
  const markup = renderToStaticMarkup(createElement(Recht, { aktion: 'anlage.verwalten', standort: STANDORT_IDS['ST-1'], children: 'Werk Ahrenberg' }));
  expect(markup).toBe('');
});
