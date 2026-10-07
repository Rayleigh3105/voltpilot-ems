import { useId, type ReactNode } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import './NwSchritte.css';

/*
 * Die Bausteine der geführten Blätter in Nachweisen (Konzept Nachweisen n1, Runde 2, §6.10 und §12): eine Frage je
 * Schritt, Antwort-Karten statt Formularfeldern, Hinweise als eine Zeile mit i-Knopf, Prüfen in Zeilen. Gebaut nur
 * aus Haus-Tokens (`NwSchritte.css`); das Blatt selbst (Griff, Titel, Fokusfalle) und der i-Knopf kommen aus den
 * Bausteinen von PR 1 und werden hier nur als Kinder hereingereicht.
 *
 * Jede Auswahl ist ein natives Formularelement (Radio oder Kontrollkästchen in seinem Etikett): Tastatur,
 * Vorleser und Formular-Absenden funktionieren ohne eigene Tastenlogik.
 */

/** „Schritt 2 von 3“ mit Balken; Vorleser hören den Satz, der Balken ist Bild. */
export function SchrittAnzeige({ nr, von }: { nr: number; von: number }) {
  return (
    <div className="vp-nw-schritt" style={{ ['--n' as string]: von }} data-testid="nw-schritt">
      <p className="vp-nw-schritt-st">
        Schritt <b>{`${nr} von ${von}`}</b>
      </p>
      <div className="vp-nw-schritt-bar" aria-hidden="true">
        {Array.from({ length: von }, (_, i) => (
          <i key={i} className={i < nr ? 'an' : undefined} />
        ))}
      </div>
    </div>
  );
}

export interface AntwortOption<T extends string> {
  wert: T;
  titel: string;
  /** Höchstens drei Wörter Zusatz (§6.10): „Robert Falk gibt frei“, „ein Monat“. */
  zusatz?: string | null;
  /** Nicht wählbar (etwa „April 2029 · ab 07.05.2029“, der Monat läuft noch) - grau, ohne Auswahl. */
  aus?: boolean;
}

/**
 * Antwort-Karten: jede Antwort ist eine ganze Karte mit Radio (mind. 52 px hoch). `frage` ist die Frage über den
 * Karten - sie benennt die Gruppe auch für Vorleser; ohne Frage benennt `label` die Gruppe unsichtbar.
 */
export function AntwortKarten<T extends string>({
  frage,
  label,
  optionen,
  wert,
  onWahl,
  testid,
}: {
  frage?: string;
  label?: string;
  optionen: readonly AntwortOption<T>[];
  wert: T | null;
  onWahl: (wert: T) => void;
  testid?: string;
}) {
  const name = `nw-wahl-${useId().replace(/:/g, '')}`;
  return (
    <fieldset className="vp-nw-feldsatz" data-testid={testid}>
      <legend className={frage ? 'vp-nw-frage' : 'vp-nw-unsichtbar'}>{frage ?? label}</legend>
      <div className="vp-nw-wahl">
        {optionen.map((o) => (
          <label key={o.wert} className={`vp-nw-wo${wert === o.wert ? ' an' : ''}${o.aus ? ' aus' : ''}`} data-testid={testid ? `${testid}-${o.wert}` : undefined}>
            <input type="radio" name={name} value={o.wert} checked={wert === o.wert} disabled={o.aus} onChange={() => onWahl(o.wert)} />
            <span className="vp-nw-rb" aria-hidden="true" />
            <b>{o.titel}</b>
            {o.zusatz && <span className="vp-nw-s">{o.zusatz}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface ChipOption<T extends string> {
  wert: T;
  label: string;
}

/**
 * Wahl-Chips („Heute, 30.04. · Gestern · Anderer Tag“, „Aushang · Intranet“): eine Antwort (Radio) oder mehrere
 * (`mehrfach`, Kontrollkästchen). Gewählte Chips tragen die Hinterlegung der Familie (`.ak-chip.steuert`).
 */
export function WahlChips<T extends string>(
  props: {
    frage: string;
    optionen: readonly ChipOption<T>[];
    testid?: string;
    fehler?: string | null;
  } & ({ mehrfach?: false; wert: T | null; onWahl: (wert: T) => void } | { mehrfach: true; werte: readonly T[]; onWahl: (werte: T[]) => void }),
) {
  const name = `nw-chips-${useId().replace(/:/g, '')}`;
  const gewaehlt = (w: T) => (props.mehrfach ? props.werte.includes(w) : props.wert === w);
  const umschalten = (w: T) => {
    if (props.mehrfach) props.onWahl(props.werte.includes(w) ? props.werte.filter((x) => x !== w) : [...props.werte, w]);
    else props.onWahl(w);
  };
  return (
    <fieldset className="vp-nw-feldsatz" data-testid={props.testid} aria-invalid={props.fehler ? true : undefined}>
      <legend className="vp-nw-frage">{props.frage}</legend>
      <div className="vp-nw-chips">
        {props.optionen.map((o) => (
          <label key={o.wert} className={`vp-nw-chip${gewaehlt(o.wert) ? ' an' : ''}`} data-testid={props.testid ? `${props.testid}-${o.wert}` : undefined}>
            <input type={props.mehrfach ? 'checkbox' : 'radio'} name={name} value={o.wert} checked={gewaehlt(o.wert)} onChange={() => umschalten(o.wert)} />
            {o.label}
          </label>
        ))}
      </div>
      {props.fehler && (
        <p className="vp-nw-fehler" role="alert">
          {props.fehler}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Eine Hinweis-Zeile statt eines Hilfesatzes (§6.10): Zeichen, ein fetter Titel („Eine Person gibt frei“), höchstens
 * ein leiser Zusatz („wahlfrei“) und der i-Knopf, der den Satz im Erklär-Blatt öffnet (`knopf`, Baustein aus PR 1).
 */
export function HinweisZeile({
  icon,
  titel,
  zusatz,
  knopf,
  testid,
}: {
  icon: 'users' | 'lock' | 'check' | 'info' | 'file-text' | 'calendar';
  titel: string;
  zusatz?: string | null;
  knopf?: ReactNode;
  testid?: string;
}) {
  return (
    <p className="vp-nw-hz" data-testid={testid}>
      <span className="vp-nw-hz-i" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <span className="vp-nw-hz-t">
        <b>{titel}</b>
        {zusatz && <span> · {zusatz}</span>}
        {knopf}
      </span>
    </p>
  );
}

export interface PruefZeile {
  etikett: string;
  wert: ReactNode;
  /** „Ändern“ springt zum Schritt, der den Wert fragt. */
  onAendern?: () => void;
}

/** Prüfen in Zeilen (§6.10): Etikett und Wert, „Ändern“ rechts - vor dem Absenden sieht man, was festgehalten wird. */
export function PruefZeilen({ zeilen, testid }: { zeilen: readonly PruefZeile[]; testid?: string }) {
  return (
    <dl className="vp-nw-pruef" data-testid={testid}>
      {zeilen.map((z) => (
        <div key={z.etikett} className="vp-nw-pz">
          <dt>{z.etikett}</dt>
          <dd>{z.wert}</dd>
          {z.onAendern && (
            <button type="button" className="vp-nw-aendern" onClick={z.onAendern} aria-label={`${z.etikett} ändern`}>
              Ändern
            </button>
          )}
        </div>
      ))}
    </dl>
  );
}

export interface WertAltNeu {
  name: string;
  /** Das Kennzeichen der Quelle - eindeutig auch bei gleichen Namen (React-Schlüssel, Review r1 P3-8). */
  schluessel?: string;
  /** Schon formatiert („6.100“); `null` = es gab keinen Wert (steht als „–“, nie als Null). */
  alt: string | null;
  neu: string | null;
  einheit: string | null;
}

/**
 * Werte „alt → neu“ mit Einheit (§6.4): der alte Wert durchgestrichen, der neue in Navy. Was auf beiden Seiten fehlt,
 * ist keine Änderung und gehört nicht hierher (das filtert der Aufrufer).
 */
export function WerteAltNeu({ werte, testid }: { werte: readonly WertAltNeu[]; testid?: string }) {
  return (
    <ul className="vp-nw-wdl" data-testid={testid}>
      {werte.map((w, i) => (
        <li key={`${w.schluessel ?? w.name}-${i}`} className="vp-nw-wd">
          <span className="vp-nw-wdn">{w.name}</span>
          <span className="vp-nw-unsichtbar">{`vorher ${w.alt ?? 'kein Wert'}, jetzt ${w.neu ?? 'kein Wert'}${w.einheit ? ` ${w.einheit}` : ''}`}</span>
          <span className="vp-nw-wdw" aria-hidden="true">
            <s>{w.alt ?? '–'}</s>
            <Icon name="chevron-right" size={13} />
            <b>{w.neu ?? '–'}</b>
            {w.einheit && <small>{w.einheit}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Ein Stück Wortlaut: `neu` hinterlegt (das, was in dieser Fassung dazukam). */
export interface WortlautStueck {
  text: string;
  neu: boolean;
}

/**
 * Der Wortlaut einer Fassung in Lese-Schrift (Inter, 1,62 Zeilenhöhe), das Neue hinterlegt (§6.5). Absätze bleiben
 * Absätze; die Hinterlegung malt ihren seitlichen Rand als Schatten, damit an der Zeilenkante nichts herausragt.
 */
export function Wortlaut({ absaetze, testid, label }: { absaetze: readonly (readonly WortlautStueck[])[]; testid?: string; label?: string }) {
  return (
    // Mit Namen ein eigener Bereich („Wortlaut der Fassung 2“) - ein `aria-label` ohne Rolle liest niemand vor (Review r1, P2-12).
    <div className="vp-nw-wortlaut" data-testid={testid} role={label ? 'region' : undefined} aria-label={label}>
      {absaetze.map((a, i) => (
        <p key={i}>
          {a.map((s, j) =>
            s.neu ? (
              <mark key={j} className="vp-nw-neu">
                {s.text}
              </mark>
            ) : (
              <span key={j}>{s.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** Umschalter zweier Formen („Text · Verweis“): ein Segment-Schalter als Radiogruppe. */
export function Umschalter<T extends string>({
  label,
  optionen,
  wert,
  onWahl,
  testid,
}: {
  label: string;
  optionen: readonly ChipOption<T>[];
  wert: T;
  onWahl: (wert: T) => void;
  testid?: string;
}) {
  const name = `nw-seg-${useId().replace(/:/g, '')}`;
  return (
    <fieldset className="vp-nw-feldsatz" data-testid={testid}>
      <legend className="vp-nw-unsichtbar">{label}</legend>
      <div className="vp-nw-seg">
        {optionen.map((o) => (
          <label key={o.wert} className={wert === o.wert ? 'an' : undefined} data-testid={testid ? `${testid}-${o.wert}` : undefined}>
            <input type="radio" name={name} value={o.wert} checked={wert === o.wert} onChange={() => onWahl(o.wert)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
