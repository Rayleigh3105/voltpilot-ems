import { benachrichtigungenApi, type PushAbo } from './benachrichtigungenApi';

/**
 * Web-Push einschalten (Alerting Scheibe 3, Konzept §5 [K1], §6.8 Entwurf 4): der Einschalt-Knopf
 * fragt die Browser-Erlaubnis erst NACH einem Tippen - nie beim Laden der Seite. Auf iOS nur aus der
 * als Web-App installierten Fassung (ab 16.4); {@link pushUnterstuetzt} sagt vorher ehrlich, ob der
 * Versuch überhaupt Sinn hat.
 */

export function pushUnterstuetzt(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** `true` auf iOS/iPadOS im Browser-Tab (nicht als installierte Web-App) - Push geht hier NIE (§5 [K1]). */
export function istIosOhneInstallierteApp(): boolean {
  if (typeof navigator === 'undefined') return false;
  const istIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const istInstalliert = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  return istIos && !istInstalliert;
}

/** Die rohen Bytes eines URL-sicheren Base64-Schlüssels - `PushManager.subscribe` will `Uint8Array`. */
export function urlBase64AlsBytes(text: string): Uint8Array {
  const polster = '='.repeat((4 - (text.length % 4)) % 4);
  const standard = (text + polster).replace(/-/g, '+').replace(/_/g, '/');
  const roh = atob(standard);
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i += 1) bytes[i] = roh.charCodeAt(i);
  return bytes;
}

/** Ein vernünftiger Vorschlag für den Gerätenamen ("iPhone", "Chrome unter Windows", …) - frei änderbar. */
export function geraeteVorschlag(): string {
  if (typeof navigator === 'undefined') return 'Dieses Gerät';
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android-Handy';
  if (/macintosh/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows-Rechner';
  return 'Dieses Gerät';
}

/**
 * Fragt die Erlaubnis, abonniert und meldet das Abo der API. Wirft mit einem Kundensatz, den das
 * Blatt direkt zeigen kann - nie eine rohe `DOMException`. Liefert das angelegte Abo zurück, damit
 * die Einstellungs-Seite seine Kennung als „dieses Gerät" merken kann (`push.ts` kennt dafür keinen
 * Speicher - das ist Sache der Seite, siehe `EinstellungenPage.tsx`).
 */
export async function pushEinschalten(geraet: string): Promise<PushAbo> {
  if (!pushUnterstuetzt()) {
    throw new Error('Push wird von diesem Browser nicht unterstützt.');
  }
  const erlaubnis = await Notification.requestPermission();
  if (erlaubnis !== 'granted') {
    throw new Error('Ohne Erlaubnis des Browsers kann VoltPilot keine Push-Nachrichten schicken.');
  }
  const registrierung = await navigator.serviceWorker.ready;
  const schluessel = await benachrichtigungenApi.pushOeffentlicherSchluessel();
  if (!schluessel) {
    throw new Error('Push ist auf diesem Server noch nicht eingerichtet.');
  }
  const abo = await registrierung.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64AlsBytes(schluessel) as BufferSource,
  });
  const json = abo.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Der Browser hat kein brauchbares Abo geliefert.');
  }
  return benachrichtigungenApi.pushAbonnieren(json.endpoint, json.keys.p256dh, json.keys.auth, geraet,
    navigator.userAgent);
}

/**
 * Der Endpunkt des Browser-Abos DIESES Geräts, falls eines besteht - `null` ohne Abo oder ohne
 * Unterstützung. Die Einstellungs-Seite (Scheibe 2, Befund M4) vergleicht ihn mit dem `endpoint`
 * jedes `PushAbo`, um "dieses Gerät" zu erkennen - zuverlässiger als der frühere, rein lokal
 * gemerkte Schlüssel (Scheibe 1), der ein Abo aus einem anderen Tab/Profil nie erkannte.
 */
export async function aktuellerPushEndpoint(): Promise<string | null> {
  if (!pushUnterstuetzt()) return null;
  try {
    const registrierung = await navigator.serviceWorker.getRegistration();
    const abo = await registrierung?.pushManager.getSubscription();
    return abo?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Beim Abmelden (Alerting Einstellungen Scheibe 0, B8): ein geteiltes Gerät darf das Push-Abo der
 * abgemeldeten Person nicht behalten - sonst bekäme die nächste angemeldete Person ihre Meldungen.
 * Beendet das Browser-Abo DIESES Geräts und meldet es beim Server ab, bevor überhaupt ein neuer
 * Benutzer sich anmelden kann; rein bestmöglich - ein fehlendes oder schon totes Abo ist kein Fehler
 * und darf das eigentliche Abmelden nie aufhalten.
 */
export async function pushBeiAbmeldenAufraeumen(): Promise<void> {
  if (!pushUnterstuetzt()) return;
  try {
    const registrierung = await navigator.serviceWorker.getRegistration();
    const abo = await registrierung?.pushManager.getSubscription();
    if (!abo) return;
    const endpoint = abo.endpoint;
    await abo.unsubscribe();
    await benachrichtigungenApi.pushAbmelden(endpoint);
  } catch {
    // bestmöglich - siehe Klassenkommentar
  }
}
