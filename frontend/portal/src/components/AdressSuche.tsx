import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type OrtTreffer } from '../api';
import { adresseAusTreffer, adresseText, SATZ_STRASSE_FEHLT, type Adresse } from '../anlageOrt';
import { LAENDER, type Land } from '../standorte';
import { VpPicker } from './VpPicker';
import './AdressSuche.css';

/** Eine gewählte Adresse und ihr Punkt (aus dem Vorschlag; von Hand eingegeben ohne). */
export interface AdressWahl {
  adresse: Adresse;
  punkt: { breitengrad: number; laengengrad: number } | null;
}

/** Wie lange nach dem letzten Tastendruck gesucht wird. */
const WARTEN_MS = 250;

/**
 * Das EINE Adressfeld des Anlege-Flusses (Anlage-Flow a1, Paket 1): Vorschläge beim Tippen über die
 * eigene API (`GET /api/v1/orte/suche`, OpenStreetMap-Adressen, nur DE/AT/CH) - Straße und Hausnummer
 * genügen. Ein Vorschlag mit Straße wird die Adresse (Straße, PLZ, Ort, Land) samt Punkt; ein Ort
 * allein genügt nicht. Unter der Liste steht die Namensnennung der Daten.
 *
 * Ist die Suche nicht erreichbar, geht es von Hand weiter: Straße, PLZ, Ort und Land - der Punkt kommt
 * dann von der Karte. Escape schließt nur die Liste (nie den Dialog darüber).
 *
 * Den getippten Text hält der Wirt (`suche`), damit „Weiter“ ohne Wahl den ersten Vorschlag nehmen
 * kann (F5: ein getippter Ort ohne „Suchen“ wurde still verworfen).
 */
export const AdressSuche = forwardRef<
  HTMLInputElement,
  {
    id?: string;
    label?: string;
    suche: string;
    onSuche: (text: string) => void;
    gewaehlt: AdressWahl | null;
    onWahl: (wahl: AdressWahl | null) => void;
    fehler?: string | null;
    /** Ein Hinweis unter dem Feld, solange kein Fehler steht. */
    hinweis?: string;
    /** Der Wirt hat seine eigenen Adressfelder (Standort-Dialog): kein Weg „von Hand“ hier. */
    ohneHand?: boolean;
  }
>(function AdressSuche(
  { id, label = 'Adresse', suche, onSuche, gewaehlt, onWahl, fehler = null, hinweis, ohneHand = false },
  ref,
) {
  // Mit `id` tragen Liste und Vorschläge sie als Grundlage (stabil, auch in Schnappschüssen).
  const eigene = useId().replace(/:/g, '');
  const basis = id ?? `vp-adr-${eigene}`;
  const [treffer, setTreffer] = useState<OrtTreffer[]>([]);
  const [quelle, setQuelle] = useState<string | null>(null);
  const [offen, setOffen] = useState(false);
  const [aktiv, setAktiv] = useState(-1);
  const [laedt, setLaedt] = useState(false);
  const [ausfall, setAusfall] = useState(false);
  const [vonHand, setVonHand] = useState(false);
  const [eigenerFehler, setEigenerFehler] = useState<string | null>(null);
  const runde = useRef(0);

  // Suchen, sobald der Kunde kurz innehält - eine veraltete Antwort zählt nie.
  useEffect(() => {
    const q = suche.trim();
    if (vonHand || q.length < 3 || (gewaehlt && adresseText(gewaehlt.adresse) === q)) {
      setTreffer([]);
      setLaedt(false);
      return;
    }
    const meine = ++runde.current;
    const abbruch = new AbortController();
    setLaedt(true);
    const zeit = setTimeout(() => {
      api.orteSuche(q, abbruch.signal).then(
        (a) => {
          if (meine !== runde.current) return;
          setTreffer(a.treffer);
          setQuelle(a.quelle);
          setAktiv(a.treffer.length > 0 ? 0 : -1);
          setAusfall(false);
          setLaedt(false);
        },
        (e) => {
          if (meine !== runde.current || abbruch.signal.aborted) return;
          setTreffer([]);
          setLaedt(false);
          setAusfall(!(e instanceof ApiError) || e.status >= 500);
        },
      );
    }, WARTEN_MS);
    return () => {
      clearTimeout(zeit);
      abbruch.abort();
    };
  }, [suche, vonHand, gewaehlt]);

  function waehle(t: OrtTreffer) {
    const adresse = adresseAusTreffer(t);
    setOffen(false);
    if (!adresse) {
      // Ein Ort allein ist keine Adresse - der Kunde ergänzt Straße und Hausnummer.
      setEigenerFehler(SATZ_STRASSE_FEHLT);
      onSuche(`${t.text.split(',')[0]} `);
      return;
    }
    setEigenerFehler(null);
    onSuche(adresseText(adresse));
    onWahl({ adresse, punkt: { breitengrad: t.breitengrad, laengengrad: t.laengengrad } });
  }

  if (vonHand) {
    return (
      <VonHand
        basis={basis}
        gewaehlt={gewaehlt}
        onWahl={onWahl}
        fehler={fehler}
        onZurSuche={
          ausfall
            ? null
            : () => {
                setVonHand(false);
                onWahl(null);
              }
        }
      />
    );
  }

  const listeOffen = offen && treffer.length > 0;
  const satz = fehler ?? eigenerFehler;
  return (
    <div className="vp-adr">
      <Input
        ref={ref}
        id={basis}
        label={label}
        placeholder="z. B. Hauptstraße 12, Gunzenhausen"
        value={suche}
        autoComplete="street-address"
        role="combobox"
        aria-expanded={listeOffen}
        aria-controls={`${basis}-liste`}
        aria-autocomplete="list"
        aria-activedescendant={listeOffen && aktiv >= 0 ? `${basis}-t${aktiv}` : undefined}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          onSuche(e.target.value);
          setOffen(true);
          setEigenerFehler(null);
          if (gewaehlt) onWahl(null);
        }}
        onFocus={() => setOffen(true)}
        onBlur={() => setTimeout(() => setOffen(false), 150)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (!listeOffen) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAktiv((a) => Math.min(a + 1, treffer.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAktiv((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && aktiv >= 0) {
            e.preventDefault();
            waehle(treffer[aktiv]);
          } else if (e.key === 'Escape') {
            // Nur die Liste - der Dialog darüber bleibt offen.
            e.preventDefault();
            e.stopPropagation();
            setOffen(false);
          }
        }}
        error={satz}
        hint={!satz && !listeOffen ? (gewaehlt ? <Gewaehlt /> : hinweis ?? 'Straße und Hausnummer genügen.') : undefined}
      />
      {listeOffen && (
        <div className="vp-adr-liste-rahmen">
          <ul id={`${basis}-liste`} className="vp-adr-liste" role="listbox" aria-label="Vorschläge">
            {treffer.map((t, i) => (
              <li
                key={`${t.text}-${t.breitengrad}`}
                id={`${basis}-t${i}`}
                role="option"
                aria-selected={i === aktiv}
                className={`vp-adr-treffer${i === aktiv ? ' is-aktiv' : ''}`}
                // Vor dem Blur des Felds wählen, sonst schlösse die Liste vorher.
                onMouseDown={(e) => {
                  e.preventDefault();
                  waehle(t);
                }}
              >
                <Icon name="map-pin" size={15} />
                <span>{t.text}</span>
              </li>
            ))}
          </ul>
          {quelle && <p className="vp-adr-quelle">Adressen: {quelle}</p>}
        </div>
      )}
      {laedt && suche.trim().length >= 3 && !listeOffen && (
        <p className="vp-adr-status" aria-live="polite">Suche …</p>
      )}
      {ausfall && (
        <p className="vp-adr-status" role="status">
          Die Adresssuche ist gerade nicht erreichbar.{' '}
          {!ohneHand && (
            <button type="button" className="vp-linklike" onClick={() => setVonHand(true)}>
              Adresse von Hand eingeben
            </button>
          )}
        </p>
      )}
      {!ausfall && !gewaehlt && !ohneHand && (
        <button type="button" className="vp-linklike vp-linklike-quiet vp-adr-hand" onClick={() => setVonHand(true)}>
          Adresse von Hand eingeben
        </button>
      )}
    </div>
  );
});

function Gewaehlt() {
  return (
    <span style={{ color: 'var(--vp-ok-ink)' }}>
      <Icon name="check" size={12} strokeWidth={3} style={{ verticalAlign: '-1px', marginRight: 4 }} />
      Adresse gefunden - den Punkt auf der Karte können Sie aufs Dach ziehen.
    </span>
  );
}

/** Die Adresse von Hand: Straße mit Hausnummer, PLZ, Ort, Land - der Punkt kommt von der Karte. */
function VonHand({
  basis,
  gewaehlt,
  onWahl,
  fehler,
  onZurSuche,
}: {
  basis: string;
  gewaehlt: AdressWahl | null;
  onWahl: (wahl: AdressWahl | null) => void;
  fehler: string | null;
  onZurSuche: (() => void) | null;
}) {
  const [strasse, setStrasse] = useState(gewaehlt?.adresse.strasse ?? '');
  const [plz, setPlz] = useState(gewaehlt?.adresse.plz ?? '');
  const [ort, setOrt] = useState(gewaehlt?.adresse.ort ?? '');
  const [land, setLand] = useState<Land>(gewaehlt?.adresse.land ?? 'DE');

  function melde(n: { strasse?: string; plz?: string; ort?: string; land?: Land }) {
    const w = { strasse, plz, ort, land, ...n };
    onWahl(w.strasse.trim() && w.ort.trim()
      ? { adresse: { strasse: w.strasse.trim(), plz: w.plz.trim() || null, ort: w.ort.trim(), land: w.land }, punkt: null }
      : null);
  }

  return (
    <div className="vp-adr vp-adr-hand-felder">
      <Input
        id={`${basis}-strasse`}
        label="Straße und Hausnummer"
        value={strasse}
        autoComplete="address-line1"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setStrasse(e.target.value);
          melde({ strasse: e.target.value });
        }}
        error={fehler}
      />
      <div className="vp-adr-reihe">
        <div className="vp-adr-plz">
          <Input
            id={`${basis}-plz`}
            label="PLZ"
            value={plz}
            inputMode="numeric"
            autoComplete="postal-code"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setPlz(e.target.value);
              melde({ plz: e.target.value });
            }}
          />
        </div>
        <div className="vp-adr-ort">
          <Input
            id={`${basis}-ort`}
            label="Ort"
            value={ort}
            autoComplete="address-level2"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setOrt(e.target.value);
              melde({ ort: e.target.value });
            }}
          />
        </div>
      </div>
      <VpPicker
        id={`${basis}-land`}
        label="Land"
        options={LAENDER.map((l) => ({ value: l.code, label: l.wort }))}
        value={land}
        onChange={(v) => {
          setLand(v as Land);
          melde({ land: v as Land });
        }}
      />
      <p className="vp-note" style={{ margin: 0 }}>Den Punkt setzen Sie mit einem Tipp auf die Karte.</p>
      {onZurSuche && (
        <button type="button" className="vp-linklike vp-linklike-quiet vp-adr-hand" onClick={onZurSuche}>
          Zurück zur Adresssuche
        </button>
      )}
    </div>
  );
}
