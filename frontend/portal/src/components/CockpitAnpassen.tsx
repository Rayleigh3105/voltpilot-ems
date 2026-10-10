import { Recht } from './Recht';
import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  type AnpassenZeile,
  type BausteinId,
  type LayoutQuelle,
} from '../cockpitLayout';
import type { CockpitBlockId } from '../surface';
import './CockpitAnpassen.css';

/**
 * Der ANPASSEN-MODUS des Cockpits (Anwendungs-Programm Stufe 3,
 * Captain-Entscheid E4: „Inline Anpassen-Modus auf dem Cockpit — Griff, Auge,
 * Stern; Fertig/Zurücksetzen; am Telefon eine Listen-Ansicht derselben
 * Bausteine").
 *
 * Render-only: JEDE Ableitung liegt im reinen `src/cockpitLayout.ts`
 * (`anpassenZeilen`, `verschiebe`, `anpassenDokument`, `resetZiel`). Hier
 * werden nur Knöpfe gezeichnet.
 *
 * ## Barrierefreiheit ist hier kein Zusatz, sondern die Bedienform
 *
 * Es gibt bewusst KEIN Drag-and-Drop als einzigen Weg: die Reihenfolge ändert
 * man mit ▲/▼ — echten Knöpfen, die Tastatur, Screenreader und Touch gleich
 * gut bedienen. Ein Layout-Editor, den man nur mit der Maus bedienen kann, ist
 * für einen Teil der Kunden gar keiner.
 */

/** Die Leiste, die den Modus trägt (Fertig · Zurücksetzen · Ansage). */
export function AnpassenLeiste({
  quelle,
  resetSatz,
  dirty,
  saving,
  fehler,
  band,
  alsVorgabe,
  onAlsVorgabe,
  onFertig,
  onAbbrechen,
  onZuruecksetzen,
  mitStern = true,
}: {
  quelle: LayoutQuelle;
  resetSatz: string;
  dirty: boolean;
  saving: boolean;
  fehler: string | null;
  /** Das Admin-Band „Sie gestalten die Vorgabe für {Kunde}" — null = Kunde. */
  band: string | null;
  /** Sichtbarer Schalter „als Vorgabe speichern" (nur Portal-Admin). */
  alsVorgabe: boolean | null;
  onAlsVorgabe: (value: boolean) => void;
  onFertig: () => void;
  onAbbrechen: () => void;
  onZuruecksetzen: () => void;
  /**
   * Gibt es auf DIESER Fläche überhaupt einen Stern? Am Cockpit ja (die
   * Bühne hat einen Lead), im Portfolio NICHT — dort ist kein Baustein
   * lead-fähig, und der Server lehnt jeden Lead ab. Eine Anleitung, die einen
   * Knopf verspricht, den es nicht gibt, schickt den Kunden auf die Suche.
   */
  mitStern?: boolean;
}) {
  return (
    <div className="vp-anpassen-bar" role="region" aria-label="Cockpit anpassen">
      {band && <p className="vp-anpassen-band">{band}</p>}
      <div className="vp-anpassen-bar-row">
        <p className="vp-anpassen-hint">
          {mitStern
            ? 'Ordnen Sie die Bausteine mit ▲ ▼, blenden Sie mit dem Auge aus und heben Sie einen Baustein mit dem Stern hervor.'
            : 'Ordnen Sie die Bausteine mit ▲ ▼ und blenden Sie mit dem Auge aus.'}
          {quelle === 'vorgabe-anlage' || quelle === 'vorgabe-kunde'
            ? ' Zurzeit gilt die Vorgabe Ihres Betreibers.'
            : ''}
        </p>
        <div className="vp-anpassen-actions">
          {alsVorgabe != null && (
            <label className="vp-anpassen-toggle">
              <input
                type="checkbox"
                checked={alsVorgabe}
                onChange={(e) => onAlsVorgabe(e.target.checked)}
              />
              Als Vorgabe speichern
            </label>
          )}
          <Recht aktion="cockpit.anpassen"><button type="button" className="vp-anpassen-btn" onClick={onZuruecksetzen}>
            Zurücksetzen
          </button></Recht>
          <button type="button" className="vp-anpassen-btn" onClick={onAbbrechen}>
            Abbrechen
          </button>
          <Recht aktion="cockpit.anpassen"><button
            type="button"
            className="vp-anpassen-btn is-primary"
            onClick={onFertig}
            disabled={saving}
          >
            {saving ? 'Wird gespeichert …' : 'Fertig'}
          </button></Recht>
        </div>
      </div>
      <p className="vp-anpassen-reset-note">{resetSatz}</p>
      {dirty && !saving && (
        <p className="vp-anpassen-reset-note">Ihre Änderungen sind noch nicht gespeichert.</p>
      )}
      {fehler && (
        <p className="vp-anpassen-fehler" role="alert">
          {fehler}
        </p>
      )}
    </div>
  );
}

/**
 * Die Bedienelemente EINER Baustein-Zeile — Griff (▲▼), Auge, Stern.
 *
 * Generisch über den Baustein-Schlüssel, weil es GENAU EINEN Anpassen-Modus
 * gibt: das Anlagen-Cockpit und das Portfolio-Cockpit (Stufe 4) haben
 * verschiedene Baustein-Mengen, aber dieselbe Bedienung. Ein zweiter Editor
 * wäre eine zweite Bedienlogik für dieselbe Handlung.
 */
export function AnpassenSteuerung<T extends string = BausteinId>({
  zeile,
  onVerschieben,
  onSichtbar,
  onLead,
  extra,
}: {
  zeile: AnpassenZeile<T>;
  onVerschieben: (id: T, richtung: 'hoch' | 'runter') => void;
  onSichtbar: (id: T, sichtbar: boolean) => void;
  onLead: (block: CockpitBlockId) => void;
  /**
   * Zusätzliche Bedienelemente DIESER Zeile — heute der Stift einer eigenen
   * Auswertung (Stufe 5). Sie stehen hier statt in einer zweiten Zeile, weil
   * „ändern" zu demselben Baustein gehört wie „verschieben" und „ausblenden".
   */
  extra?: ReactNode;
}) {
  return (
    <div className="vp-anpassen-ctrl">
      <span className="vp-anpassen-name">{zeile.label}</span>
      {zeile.beweglich ? (
        <>
          <Recht aktion="cockpit.anpassen"><button
            type="button"
            className="vp-anpassen-icon"
            onClick={() => onVerschieben(zeile.id, 'hoch')}
            disabled={!zeile.kannHoch}
            aria-label={`${zeile.label} nach oben`}
            title="Nach oben"
          >
            <Icon name="arrow-up" size={16} />
          </button></Recht>
          <Recht aktion="cockpit.anpassen"><button
            type="button"
            className="vp-anpassen-icon"
            onClick={() => onVerschieben(zeile.id, 'runter')}
            disabled={!zeile.kannRunter}
            aria-label={`${zeile.label} nach unten`}
            title="Nach unten"
          >
            <Icon name="arrow-down" size={16} />
          </button></Recht>
        </>
      ) : (
        <span className="vp-anpassen-fest" title="Bleibt an seinem Platz">
          fest
        </span>
      )}
      {zeile.leadBlock && (
        <Recht aktion="cockpit.anpassen"><button
          type="button"
          className={`vp-anpassen-icon${zeile.lead ? ' is-on' : ''}`}
          onClick={() => onLead(zeile.leadBlock as CockpitBlockId)}
          aria-pressed={zeile.lead}
          aria-label={
            zeile.lead
              ? `${zeile.label} nicht mehr hervorheben`
              : `${zeile.label} hervorheben`
          }
          title={zeile.lead ? 'Hervorhebung aufheben (wieder automatisch)' : 'Hervorheben'}
        >
          <Icon name="star" size={16} />
        </button></Recht>
      )}
      {zeile.pflicht ? (
        <span className="vp-anpassen-fest" title="Gehört zur Grundausstattung">
          immer sichtbar
        </span>
      ) : (
        <Recht aktion="cockpit.anpassen"><button
          type="button"
          className="vp-anpassen-icon"
          onClick={() => onSichtbar(zeile.id, !zeile.sichtbar)}
          aria-pressed={!zeile.sichtbar}
          aria-label={`${zeile.label} ${zeile.sichtbar ? 'ausblenden' : 'einblenden'}`}
          title={zeile.sichtbar ? 'Ausblenden' : 'Einblenden'}
        >
          <Icon name={zeile.sichtbar ? 'eye' : 'eye-off'} size={16} />
        </button></Recht>
      )}
      {extra}
    </div>
  );
}

/**
 * Ein Baustein IM Anpassen-Modus: seine Bedienelemente über dem echten
 * Baustein. Der Kunde sieht dabei, WAS er anordnet — genau der Grund, warum
 * E4 den Inline-Modus einer eigenen Einstellungs-Seite vorzieht („sonst
 * gestaltet der Kunde blind").
 */
export function AnpassenHuelle<T extends string = BausteinId>({
  zeile,
  children,
  note,
  onVerschieben,
  onSichtbar,
  onLead,
  extra,
}: {
  zeile: AnpassenZeile<T>;
  children?: ReactNode;
  /**
   * Ein Baustein OHNE eigenen Knoten am Rechner (die Geld-Leiste und der
   * Steuerungs-Fuß wohnen dort IN der Bühne). Er bekommt trotzdem seine Zeile —
   * sonst wäre er der einzige, den man am Rechner nicht ausblenden oder
   * hervorheben könnte, und der Kunde suchte einen Knopf, den es nur am Telefon
   * gibt.
   */
  note?: string | null;
  onVerschieben: (id: T, richtung: 'hoch' | 'runter') => void;
  onSichtbar: (id: T, sichtbar: boolean) => void;
  onLead: (block: CockpitBlockId) => void;
  extra?: ReactNode;
}) {
  return (
    <section
      className={`vp-anpassen-huelle${children == null ? ' is-zeile' : ''}`}
      aria-label={zeile.label}
    >
      <AnpassenSteuerung
        zeile={zeile}
        onVerschieben={onVerschieben}
        onSichtbar={onSichtbar}
        onLead={onLead}
        extra={extra}
      />
      {note && <p className="vp-anpassen-note">{note}</p>}
      {children != null && <div className="vp-anpassen-inhalt">{children}</div>}
    </section>
  );
}

/**
 * Die Telefon-Fassung (E4): dieselben Bausteine als LISTE. Auf 375 px ist ein
 * Inline-Overlay über einem Diagramm nicht bedienbar — die Liste zeigt
 * dieselben Zeilen mit denselben drei Bedienelementen.
 */
export function AnpassenListe<T extends string = BausteinId>({
  zeilen,
  onVerschieben,
  onSichtbar,
  onLead,
  extra,
  note,
}: {
  zeilen: AnpassenZeile<T>[];
  onVerschieben: (id: T, richtung: 'hoch' | 'runter') => void;
  onSichtbar: (id: T, sichtbar: boolean) => void;
  onLead: (block: CockpitBlockId) => void;
  /** Zusätzliche Bedienelemente je Zeile (Stufe 5: der Stift). */
  extra?: (zeile: AnpassenZeile<T>) => ReactNode;
  /**
   * Der Orts-Hinweis eines unbeweglichen Bausteins — die `AnpassenHuelle` trägt
   * ihn am Rechner, die Liste bis Stufe 3 gar nicht. Optional, damit jeder
   * bestehende Aufrufer zeichengleich rendert.
   */
  note?: (zeile: AnpassenZeile<T>) => string | null;
}) {
  const sichtbar = zeilen.filter((z) => z.sichtbar);
  const versteckt = zeilen.filter((z) => !z.sichtbar);
  return (
    <div className="vp-anpassen-liste">
      <ul>
        {sichtbar.map((z) => (
          <li key={z.id}>
            <AnpassenSteuerung
              zeile={z}
              onVerschieben={onVerschieben}
              onSichtbar={onSichtbar}
              onLead={onLead}
              extra={extra?.(z)}
            />
            {note?.(z) && <p className="vp-anpassen-note">{note(z)}</p>}
          </li>
        ))}
      </ul>
      <AusgeblendetZeile
        zeilen={versteckt}
        onVerschieben={onVerschieben}
        onSichtbar={onSichtbar}
        onLead={onLead}
        extra={extra}
      />
    </div>
  );
}

/**
 * Die eingeklappte Reihe „Ausgeblendet (n)" (§3.4 Punkt 4): ausgeblendete
 * Bausteine bleiben ERREICHBAR. Ohne sie wäre „ausblenden" ein Weg ohne
 * Rückweg — der Kunde müsste raten, was er einmal versteckt hat.
 */
export function AusgeblendetZeile<T extends string = BausteinId>({
  zeilen,
  onVerschieben,
  onSichtbar,
  onLead,
  extra,
}: {
  zeilen: AnpassenZeile<T>[];
  onVerschieben: (id: T, richtung: 'hoch' | 'runter') => void;
  onSichtbar: (id: T, sichtbar: boolean) => void;
  onLead: (block: CockpitBlockId) => void;
  /** Zusätzliche Bedienelemente je Zeile (Stufe 5: der Stift). */
  extra?: (zeile: AnpassenZeile<T>) => ReactNode;
}) {
  if (zeilen.length === 0) return null;
  return (
    <details className="vp-anpassen-versteckt">
      <summary>Ausgeblendet ({zeilen.length})</summary>
      <ul>
        {zeilen.map((z) => (
          <li key={z.id}>
            <AnpassenSteuerung
              zeile={z}
              onVerschieben={onVerschieben}
              onSichtbar={onSichtbar}
              onLead={onLead}
              extra={extra?.(z)}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
