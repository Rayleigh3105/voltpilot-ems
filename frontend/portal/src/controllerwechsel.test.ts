import { describe, it, expect } from 'vitest';
import { controllerAuftrag, controllerFolgen } from './controllerwechsel';
import { controllerVorschau } from './test/controllerwechselFixtures';
describe('Controllerwechsel C1', () => {
  it('nennt jede betroffene Messstelle, auch Vergleichsquellen und mehrere Zählwerke einer Karte', () => {
    const v = controllerVorschau();
    v.folgen.push({ ...v.folgen[0], bindung: 'q-vergleich', kennzeichen: 'MS-14', rolle: 'vergleich' });
    expect(controllerFolgen(v)).toHaveLength(5);
    for (const id of ['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14']) expect(controllerFolgen(v).join(' ')).toContain(id);
    expect(controllerFolgen(v)[4]).toContain('Vergleichsquelle');
  });
  it('ordnet Endstände eindeutig zu und übernimmt keine Anfangsstände oder Seriennummern still', () => {
    const v = controllerVorschau();
    const a = controllerAuftrag(v, v.karten.slice(0, 3).map(k => k.id), { 'q-0': '1.234,5', 'q-1': '0', 'q-2': '' }, 'WAGO PFC200', '');
    expect(a.fehler).toBeNull();
    expect(a.body?.ablesestaende).toEqual([{ bindung: 'q-0', endstand: { wert: 1234.5, einheit: 'kWh' } }, { bindung: 'q-1', endstand: { wert: 0, einheit: 'kWh' } }]);
    expect(a.body?.bestaetigte_bindungen).toHaveLength(4); expect(a.body?.neues_geraet?.seriennummer).toBeNull();
  });
  it('weist fremde Ziele und unlesbare oder negative Stände ab', () => {
    const v = controllerVorschau();
    for (const staende of [{ fremd: '1' }, { 'q-0': '-1' }, { 'q-0': 'abc' }]) expect(controllerAuftrag(v, [], staende, 'PFC200', '').body).toBeNull();
  });
});
