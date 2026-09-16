import type { ControllerwechselVorschau, Zaehlerwechsel } from './api';
import { ablesestandWert } from './zahl';
import { kartenWechselPruefen } from './uemsMessstelle';

export function controllerFolgen(v: ControllerwechselVorschau): string[] {
  return v.folgen.map(f => `${f.kennzeichen} · ${f.groesse} · ${f.richtung} · ${f.rolle === 'fuehrend' ? 'führende Quelle' : 'Vergleichsquelle'}`);
}
export function controllerAuftrag(v: ControllerwechselVorschau, uebernommen: string[], endstaende: Record<string, string>,
  typ: string, seriennummer: string): { body: Zaehlerwechsel | null; fehler: string | null } {
  const fuehrend = v.folgen.filter(f => f.rolle === 'fuehrend' && f.zaehlerstand);
  const gelesen = Object.keys(endstaende).filter(id => endstaende[id].trim());
  const regel = kartenWechselPruefen(v.karten.map(k => k.id), uebernommen, fuehrend.map(f => f.bindung), gelesen);
  if (regel) return { body: null, fehler: 'Die Auswahl hat sich geändert. Prüfen Sie die Karten und Ablesestände erneut.' };
  if (!typ.trim()) return { body: null, fehler: 'Bitte geben Sie den Typ des neuen Controllers an.' };
  if (gelesen.some(id => ablesestandWert(endstaende[id]) === null || ablesestandWert(endstaende[id])! < 0)) {
    return { body: null, fehler: 'Bitte geben Sie für jeden erfassten Endstand eine Zahl ab 0 an.' };
  }
  return { fehler: null, body: {
    zeitpunkt: v.zeitpunkt, neues_geraet: { typ: typ.trim(), seriennummer: seriennummer.trim() || null },
    karten_uebernommen: uebernommen, bestaetigte_bindungen: v.folgen.map(f => f.bindung),
    ablesestaende: gelesen.map(id => ({ bindung: id, endstand: { wert: ablesestandWert(endstaende[id])!, einheit: fuehrend.find(f => f.bindung === id)!.einheit } })),
    einstellungen_uebernehmen: true,
  } };
}
