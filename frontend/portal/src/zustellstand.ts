/**
 * Der Zustellstand an jeder Meldung (Kunden-Alarmierung P4, Konzept §6.1 Nr. 7 und §6.2), rein: aus den Zeilen des
 * Versand-Protokolls (`GET /api/v1/meldungen/zustellung`) wird EIN Satz unter der Karte - „Gemeldet: E-Mail 12:34 ·
 * Push 12:34“ oder ehrlich „Nicht gesendet: Ruhezeit“. Nichts wird geschätzt: was nicht im Protokoll steht, steht
 * hier auch nicht.
 *
 * Und der Hinweis „ein Weg fällt aus“ (`GET /api/v1/zustellwege/ausfaelle`) als Kundensatz.
 *
 * Nur die Lazy-Seite `pages/MeldungenPage.tsx` importiert dieses Modul.
 */
import type { WegAusfall, Zustellstand, ZustellstandWeg } from './benachrichtigungenApi';
import { datumZeit } from './rechteTexte';

/** Die Wege in Kundenwörtern - dieselben wie unter „So erreichen wir Sie“. */
export const WEG_WORT: Record<string, string> = {
  email: 'E-Mail',
  webpush: 'Push',
  webhook: 'Team-Kanal',
  telegram: 'Telegram',
};

/** Reihenfolge im Satz: was die meisten haben zuerst. */
const WEG_RANG = ['email', 'webpush', 'webhook', 'telegram'];

/**
 * Warum etwas NICHT hinausging, in Kundenwörtern. `stumm` heißt im Protokoll beides: die Überwachung war
 * stummgeschaltet, oder die Meldung war schon vorbei, als die Ruhezeit endete - darum entscheidet der Zustand der
 * Meldung, welches Wort stimmt.
 */
export function grundWort(grund: string | null, meldungVorbei: boolean): string {
  switch (grund) {
    case 'kein_weg':
      return 'kein Weg eingeschaltet';
    case 'stumm':
      return meldungVorbei ? 'Ruhezeit' : 'stumm';
    case 'beruhigt':
      return 'beruhigt';
    case 'keine_sicht':
      return 'kein Zugriff auf diesen Standort';
    case 'vor_dem_weg':
      return 'vor dem Einschalten des Wegs';
    default:
      return 'nicht zugestellt';
  }
}

/** „12:34“ heute, sonst „13.11. 12:34“ - in der Zeitzone des Portals (wie jede Zeit an der Karte). */
export function zeitPunkt(iso: string, jetzt: Date): string {
  const voll = datumZeit(iso);
  return voll.slice(0, 10) === datumZeit(jetzt.toISOString()).slice(0, 10) ? voll.slice(11) : `${voll.slice(0, 6)} ${voll.slice(11)}`;
}

export type ZustellTon = 'gemeldet' | 'wartet' | 'nicht' | 'fehler';

export interface ZustellSatz {
  ton: ZustellTon;
  text: string;
}

function sortiert(wege: readonly ZustellstandWeg[]): ZustellstandWeg[] {
  const rang = (w: ZustellstandWeg) => {
    const i = WEG_RANG.indexOf(w.weg);
    return i < 0 ? WEG_RANG.length : i;
  };
  return [...wege].sort((a, b) => rang(a) - rang(b));
}

function wort(w: ZustellstandWeg): string {
  return WEG_WORT[w.weg] ?? w.weg;
}

/** Ein wartender Weg: „E-Mail um 07:00 (Ruhezeit)“, „Push um 18:34 (beruhigt)“, „E-Mail wird erneut versucht“. */
function wartetText(w: ZustellstandWeg, jetzt: Date): string {
  if (w.versuche > 0 && w.grund !== 'beruhigt') return `${wort(w)} wird erneut versucht`;
  const spaeter = w.am != null && Date.parse(w.am) - jetzt.getTime() > 60_000;
  if (!spaeter) return `${wort(w)} wird gesendet`;
  const um = zeitPunkt(w.am as string, jetzt);
  return w.grund === 'beruhigt' ? `${wort(w)} um ${um}, falls noch aktuell (beruhigt)` : `${wort(w)} um ${um} (Ruhezeit)`;
}

/**
 * Der Satz zu EINEM Anlass (Auslösung oder Entwarnung) aus den Zeilen dieses Anlasses. `null` ohne Zeilen.
 *
 * - Gesendet: „E-Mail 12:34 · Push 12:34“ - jeder Weg, der ankam, mit Uhrzeit.
 * - Wartet: „E-Mail um 07:00 (Ruhezeit)“.
 * - Fehlgeschlagen: „E-Mail nicht zugestellt“.
 * - Sonst die Gründe, aus denen nichts hinausging. „Kein Weg“ für Team-Kanal und Telegram ist der Normalfall und
 *   zählt nur, wenn E-Mail und Push gar keine Zeile haben (z. B. ein Hinweis, der nur als Push geht).
 */
function anlassSatz(
  wege: readonly ZustellstandWeg[],
  jetzt: Date,
  meldungVorbei: boolean,
): ZustellSatz | null {
  if (wege.length === 0) return null;
  const s = sortiert(wege);
  const gesendet = s.filter((w) => w.zustand === 'gesendet');
  const wartend = s.filter((w) => w.zustand === 'wartet');
  const fehler = s.filter((w) => w.zustand === 'fehlgeschlagen');
  const teile: string[] = [];
  if (gesendet.length > 0) {
    teile.push(gesendet.map((w) => (w.am ? `${wort(w)} ${zeitPunkt(w.am, jetzt)}` : wort(w))).join(' · '));
  }
  teile.push(...wartend.map((w) => wartetText(w, jetzt)));
  teile.push(...fehler.map((w) => `${wort(w)} nicht zugestellt`));
  if (teile.length > 0) {
    const ton: ZustellTon = gesendet.length > 0 ? 'gemeldet' : fehler.length > 0 ? 'fehler' : 'wartet';
    return { ton: fehler.length > 0 && gesendet.length === 0 ? 'fehler' : ton, text: teile.join(' · ') };
  }
  // Alles unterdrückt: die Gründe der persönlichen Wege (E-Mail, Push) - die anderen nur, wenn sie mehr sagen.
  const persoenlich = s.filter((w) => w.weg === 'email' || w.weg === 'webpush');
  const zaehlen = s.filter((w) => persoenlich.includes(w) || w.grund !== 'kein_weg');
  const basis = zaehlen.length > 0 ? zaehlen : s;
  const gruende = [...new Set(basis.map((w) => grundWort(w.grund, meldungVorbei)))];
  return { ton: 'nicht', text: gruende.join(' · ') };
}

/**
 * Der Satz unter einer Meldung. `vorbei`: die Meldung ist erledigt (für „Ruhezeit“ statt „stumm“). Ohne Stand (noch
 * nicht geladen, ältere API) `null` - dann steht nichts da, nie eine Vermutung.
 */
export function zustellSatz(stand: Zustellstand | undefined, jetzt: Date, vorbei: boolean): ZustellSatz | null {
  if (!stand) return null;
  if (stand.still === 'probelauf') return { ton: 'nicht', text: 'Nicht gesendet: Probelauf' };
  if (stand.still === 'abhaengig') {
    return {
      ton: 'nicht',
      text: `Nicht einzeln gesendet: gehört zu ${stand.stillDurch ?? 'der Meldung der Box'}`,
    };
  }
  if (stand.still === 'heute_schon') return { ton: 'nicht', text: 'Nicht gesendet: heute schon gemeldet' };
  const ausloesung = anlassSatz(
    stand.wege.filter((w) => w.anlass === 'ausgeloest'),
    jetzt,
    vorbei,
  );
  if (!ausloesung) return { ton: 'nicht', text: 'Nicht an Sie gesendet' };
  // Wartet und Fehlschlag sagen es selbst („E-Mail um 07:00 (Ruhezeit)“, „E-Mail nicht zugestellt“).
  const praefix = ausloesung.ton === 'gemeldet' ? 'Gemeldet: ' : ausloesung.ton === 'nicht' ? 'Nicht gesendet: ' : '';
  return { ton: ausloesung.ton, text: praefix + ausloesung.text };
}

/** Die Entwarnung im Verlauf, nur wenn sie hinausging: „Entwarnung: E-Mail 13:00“. */
export function entwarnungSatz(stand: Zustellstand | undefined, jetzt: Date): string | null {
  if (!stand) return null;
  const gesendet = sortiert(stand.wege.filter((w) => w.anlass === 'wieder_normal' && w.zustand === 'gesendet'));
  if (gesendet.length === 0) return null;
  return `Entwarnung: ${gesendet.map((w) => (w.am ? `${wort(w)} ${zeitPunkt(w.am, jetzt)}` : wort(w))).join(' · ')}`;
}

/** Ein ausgefallener Weg als Kundensatz: Titel und was zu tun ist. */
export function ausfallText(a: WegAusfall, jetzt: Date): { titel: string; satz: string } {
  const seit = zeitPunkt(a.seit, jetzt);
  switch (a.weg) {
    case 'email':
      return {
        titel: 'E-Mails kommen nicht an',
        satz: `Die Meldung von ${seit} konnte an ${a.name ?? 'Ihre Adresse'} nicht zugestellt werden. Prüfen Sie die Adresse unter „Einstellen“.`,
      };
    case 'webpush':
      return {
        titel: `Push auf „${a.name ?? 'einem Gerät'}“ ist abgemeldet`,
        satz: `Das Gerät nimmt seit ${seit} keine Mitteilungen mehr an. Schalten Sie Push dort neu ein.`,
      };
    case 'webhook':
      return {
        titel: `Team-Kanal „${a.name || 'ohne Namen'}“ antwortet nicht`,
        satz: `Seit ${seit} kommt dort nichts mehr an. Prüfen Sie die Adresse des Kanals.`,
      };
    default:
      return { titel: 'Ein Weg fällt aus', satz: `Seit ${seit} kommt dort nichts mehr an.` };
  }
}
