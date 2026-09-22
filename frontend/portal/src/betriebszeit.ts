import { dez, dezText, dezVergleich } from './dez';
/** AP-16 E9 Vertragszwilling. Die Oberfläche liest weiterhin nur Serverwerte. */
export function betriebszeit(von: string, bis: string, kadenz: number,
  werte: { zeit: string; kw: string | null; gut: boolean }[],
  fassungen: { von: string; bis: string | null; kw: string }[],
  luecken: { von: string; bis: string }[]) {
  const a = Date.parse(von), z = Date.parse(bis);
  if (z <= a || kadenz < 1) throw new Error('Zeitraum oder Kadenz ungültig');
  const roh = werte.map(r => ({ ...r, t: Date.parse(r.zeit) })).sort((x, y) => x.t - y.t);
  const schwellen = fassungen.map(s => ({ ...s, a: Date.parse(s.von), z: s.bis === null ? Infinity : Date.parse(s.bis) })).sort((x, y) => x.a - y.a);
  if (schwellen.some(s => dezVergleich(dez(s.kw), dez('0')) < 0)) throw new Error('Schwelle ungültig');
  const grenzen = new Set([a, z]);
  for (const r of roh) { grenzen.add(r.t); grenzen.add(r.t + kadenz * 1000); }
  for (const s of schwellen) { grenzen.add(s.a); if (Number.isFinite(s.z)) grenzen.add(s.z); }
  const delta = new Map<number, number>();
  for (const l of luecken) {
    const x = Date.parse(l.von), y = Date.parse(l.bis); grenzen.add(x); grenzen.add(y);
    delta.set(x, (delta.get(x) ?? 0) + 1); delta.set(y, (delta.get(y) ?? 0) - 1);
  }
  let ri = -1, si = -1, offen = 0, vorher: number | null = null, gemessen = 0, betrieb = 0;
  for (const ende of [...grenzen].sort((x, y) => x - y)) {
    if (vorher !== null && vorher >= a && ende <= z && offen === 0 && ri >= 0 && si >= 0) {
      const r = roh[ri], s = schwellen[si];
      if (r.gut && r.kw !== null && vorher < r.t + kadenz * 1000 && vorher < s.z) {
        gemessen += ende - vorher;
        if (dezVergleich(dez(r.kw), dez(s.kw)) > 0) betrieb += ende - vorher;
      }
    }
    while (ri + 1 < roh.length && roh[ri + 1].t <= ende) ri++;
    while (si + 1 < schwellen.length && schwellen[si + 1].a <= ende) si++;
    offen += delta.get(ende) ?? 0; vorher = ende;
  }
  return { betrag: gemessen === 0 ? null : { z: (BigInt(betrieb) * 1000000n + 1800000n) / 3600000n, e: 6 },
    zustand: gemessen === 0 ? 'keine Werte' : gemessen === z - a ? 'vollständig' : 'unvollständig',
    abdeckung_prozent: Number((BigInt(gemessen) * 1000n + BigInt(z - a) / 2n) / BigInt(z - a)) / 10,
    kennzeichen: [...new Set(schwellen.filter(s => s.a < z && s.z > a).map(s => `aus Leistung über ${dezText(dez(s.kw)).replace('.', ',')} kW (Annahme)`))] };
}
