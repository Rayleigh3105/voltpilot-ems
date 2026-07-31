/**
 * Die Adresse EINER Gruppe der Einstellungs-Seite (E1) — rein, ohne React.
 *
 * Seit dem Captain-Entscheid D1 besitzt die Einstellungs-Seite die Geld-/
 * Verhaltens-Einstellungen, und der Modus-Container spiegelt sie nur noch. Damit
 * der Spiegel nicht in einer Sackgasse endet, braucht er einen Deep-Link, der
 * genau die Gruppe öffnet, in der der Wert wohnt — dieses Modul ist die eine
 * Wahrheit darüber, wie diese Adresse aussieht und wie die Seite sie liest.
 *
 * Die Adresse ist ein PARAMETER im Hash (`…/technik?abschnitt=geld`), kein
 * zweites `#` — die App ist hash-geroutet, ein `#…#…` wäre keine gültige
 * Route. `parseRoute` schneidet den Query-Teil ohnehin ab (`split('?')[0]`),
 * die Route bleibt also unverändert; das Muster ist das der Historie
 * (`historieHash` mit `z=`/`at=`).
 */
import type { ModeSettingId } from './surface';

/** Die anspringbaren Gruppen der Einstellungs-Seite. */
export type SettingsGroupId = 'anlage' | 'geld' | 'geraet' | 'speicher' | 'registrierung' | 'loeschen';

/** Der Parametername im Hash. */
const PARAM = 'abschnitt';

const GROUPS = new Set<string>([
  'anlage',
  'geld',
  'geraet',
  'speicher',
  'registrierung',
  'loeschen',
]);

/**
 * Wo eine Einstellung auf der Einstellungs-Seite wohnt.
 *
 * Die Zuordnung folgt dem Entwurf (`data/vp-settings-ux-konzept/concept.html`,
 * §7 P4): Geld & Verträge trägt Stromtarif, Vergütung und Netzladen; der
 * „Umgang mit dem Speicher" ist eine Verhaltens-Einstellung des Speichers und
 * gehört deshalb in die Speicher-Gruppe, nicht zum Geld. Für alles, was gar
 * nicht auf der Seite wohnt (die von-VoltPilot-Werte, `home: 'modus'`), gibt es
 * hier bewusst KEINE Adresse — ein Link, der nirgendwo landet, wäre schlimmer
 * als kein Link.
 */
export function settingsGroupFor(id: ModeSettingId): SettingsGroupId | null {
  switch (id) {
    case 'stromtarif':
    case 'anzulegender-wert':
    case 'netzladen':
      return 'geld';
    case 'speicherschonung':
      return 'speicher';
    default:
      return null;
  }
}

/** Die Adresse der Einstellungs-Seite, optional auf eine Gruppe gezielt. */
export function einstellungenHash(siteId: string, group?: SettingsGroupId | null): string {
  const base = `#/anlage/${siteId}/technik`;
  return group ? `${base}?${PARAM}=${group}` : base;
}

/**
 * Die per Deep-Link angesprungene Gruppe aus einem Hash — null, wenn keine oder
 * eine unbekannte genannt ist (nie raten).
 */
export function parseSettingsAnchor(hash: string): SettingsGroupId | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(hash.slice(q + 1)).get(PARAM);
  return value && GROUPS.has(value) ? (value as SettingsGroupId) : null;
}

/**
 * Die eine Erklärzeile je Einstellung auf der Einstellungs-Seite: WAS der Wert
 * bewirkt, in Kundendeutsch und ohne Innenleben (kein Optimierer, kein MILP).
 * Sie steht dort, wo der Wert WOHNT — der Spiegel im Modus-Container zeigt sie
 * nicht, dort erklärt der Modus selbst den Zusammenhang.
 */
export const SETTING_HINT: Partial<Record<ModeSettingId, string>> = {
  stromtarif:
    'Der Preis, zu dem Sie Strom beziehen - damit plant Ihr Fahrplan, und damit wird jede Euro-Zahl bewertet.',
  'anzulegender-wert':
    'Ihr EEG-Referenzwert aus dem Direktvermarktungsvertrag - Grundlage Ihrer Marktprämie.',
  netzladen:
    'Darf Ihr Speicher Strom aus dem Netz laden? EEG-geförderte Anlagen dürfen das nicht (Ausschließlichkeitsprinzip).',
  speicherschonung:
    'Wie oft Ihr Speicher bewegt wird - schonend spart Ladezyklen, aggressiv holt mehr heraus.',
};

/**
 * Die Zusammenfassungszeile der Geld-Gruppe im zugeklappten Zustand (die Form
 * der Edge-Box). Sie nennt NUR, was wirklich hinterlegt ist — nie einen
 * erfundenen Preis.
 */
export function geldGroupSummary(input: {
  tarifLabel: string;
  netzladenLabel: string;
  anzulegenderWertLabel?: string | null;
}): string {
  return [input.tarifLabel, input.anzulegenderWertLabel, input.netzladenLabel]
    .filter((p): p is string => p != null && p !== '')
    .join(' · ');
}

/** Die Beschriftung des Spiegel-Links im Modus-Container. */
export const SETTINGS_DEEPLINK_LABEL = 'In den Einstellungen ändern';

/**
 * Die Notiz unter den gespiegelten Zeilen eines Modus-Containers — sie sagt in
 * einem Satz, WARUM hier nichts zu bearbeiten ist.
 */
export const SETTINGS_MIRROR_NOTE =
  'Diese Werte gelten für Ihre ganze Anlage und werden in den Einstellungen gepflegt - hier sehen Sie, womit dieser Modus rechnet.';
