/**
 * Wo eine Anlagensteuerung läuft (Konzept „PFC200 statt Raspberry Pi“, Stufe 2, Abschnitt 4.5): im Netz der Anlage
 * unter einer eigenen Adresse oder IN DIESEM GERÄT - ein WAGO PFC200, auf dem VoltPilot selbst läuft, liest sein
 * eigenes SPS-Programm über die Schleifenadresse 127.0.0.1. Dieselbe Datenquelle, nur eine andere Adresse; die Box
 * prüft sie wie jedes Ziel im Kundennetz (`docs/contracts/lan-host-vectors.json`: loopback ist privat).
 *
 * Reine Regeln, ohne React - der Anlege-Schritt und die Geräteseite nennen den Ort mit denselben Wörtern.
 */

/** Die Adresse der Steuerung im Gerät selbst. */
export const IN_DIESEM_GERAET_HOST = '127.0.0.1';

/** Das Wort, mit dem das Portal diese Adresse nennt. */
export const IN_DIESEM_GERAET_TEXT = 'in diesem Gerät';

/** Ob ein Host das Gerät selbst meint (IPv4 127.x, IPv6 ::1, localhost). */
export function istInDiesemGeraet(host: string | null | undefined): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Eine gespeicherte Modbus-Adresse („127.0.0.1:502“, „192.168.4.165:502“) für Menschen: im Gerät selbst „in diesem
 * Gerät“ (mit Port, wenn es nicht der Modbus-Standard 502 ist), sonst unverändert.
 */
export function adresseText(adresse: string | null | undefined): string {
  const roh = (adresse ?? '').trim();
  const treffer = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(roh);
  if (!treffer || !istInDiesemGeraet(treffer[1])) return roh;
  const port = treffer[2] == null ? 502 : Number(treffer[2]);
  return port === 502 ? IN_DIESEM_GERAET_TEXT : `${IN_DIESEM_GERAET_TEXT} (Port ${port})`;
}
