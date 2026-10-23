import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Site, type StandortBezug } from '../api';
import { adresseAusTreffer, adresseText, SATZ_NICHT_GEFUNDEN, ZEITZONE_DES_LANDES } from '../anlageOrt';
import { ersteWerteErledigt } from '../ersteWerte';
import { einstellungenHash } from '../settingsNav';
import { alsOrtFehler } from '../standorte';
import { AdressSuche, type AdressWahl } from './AdressSuche';
import { LocationMap } from './LocationMap';
import { Recht } from './Recht';
import './AnlageHinweise.css';

/**
 * Die zwei Karten über dem Cockpit (Anlage-Flow a1) - das Cockpit selbst bleibt, wie es ist (Captain,
 * Runde 2). Nachgeladen: `AnlagenPage` gehört zum Einstiegs-Bündel und entscheidet nur, OB eine Karte steht.
 *
 * - „Ihre Anlage ist live“ (D7): einmal, sobald die neue Anlage ihre ersten Werte zeigt, mit genau einem
 *   nächsten Schritt - ohne Strompreis „Strompreis angeben“, dann rechnet das Cockpit die Ersparnis in Euro.
 * - „Wo steht …?“ (D9): der Standort der Anlage hat noch keine Adresse (automatisch angelegt, Entwurf). Eine
 *   Eingabe vervollständigt ihn und setzt den Kartenpunkt der Anlage, beides in einem Zug; ein Standort, den
 *   VoltPilot benannt hat, heißt danach nach seiner Straße (der Server, `StandortService#bearbeiten`).
 */
export default function AnlageHinweise({
  site,
  ersteWerte,
  standort,
  onGespeichert,
}: {
  site: Site;
  /** Die Karte „Ihre Anlage ist live“ steht an. */
  ersteWerte: boolean;
  /** Der Standort ohne Adresse - `null`: keine Karte „Wo steht …?“. */
  standort: StandortBezug | null;
  /** Nach der Adresse: der Wirt lädt Anlage und Übersicht neu. */
  onGespeichert: () => void;
}) {
  const [ersteWerteOffen, setErsteWerteOffen] = useState(ersteWerte);
  return (
    <div className="vp-anlage-hinweise">
      {ersteWerteOffen && (
        <ErsteWerteKarte
          site={site}
          onFertig={() => {
            ersteWerteErledigt(site.id);
            setErsteWerteOffen(false);
          }}
        />
      )}
      {standort && <WoStehtKarte standort={standort} onGespeichert={onGespeichert} />}
    </div>
  );
}

function ErsteWerteKarte({ site, onFertig }: { site: Site; onFertig: () => void }) {
  // Der eine nächste Schritt: ohne Strompreis rechnet das Cockpit nur in kWh.
  const ohnePreis = site.tarifArt === 'ohne';
  return (
    <section className="vp-hinweis vp-hinweis-live" aria-labelledby="vp-erste-werte-titel">
      <span className="vp-hinweis-symbol" aria-hidden="true">
        <Icon name="check" size={18} strokeWidth={3} />
      </span>
      <div className="vp-hinweis-text">
        <h3 id="vp-erste-werte-titel">Ihre Anlage ist live.</h3>
        <p>
          {ohnePreis
            ? 'Ein nächster Schritt: Strompreis angeben, dann zeigen wir Ihre Ersparnis in Euro.'
            : 'Die ersten Werte sind da - darunter sehen Sie, was Ihre Anlage gerade tut.'}
        </p>
      </div>
      {ohnePreis && (
        <div className="vp-hinweis-knoepfe">
          <Recht aktion="anlage.verwalten">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onFertig();
                window.location.hash = einstellungenHash(site.id, 'geld');
              }}
            >
              Strompreis angeben
            </Button>
          </Recht>
        </div>
      )}
      <button type="button" className="vp-hinweis-zu" aria-label="Hinweis schließen" onClick={onFertig}>
        <Icon name="x" size={16} />
      </button>
    </section>
  );
}

function WoStehtKarte({ standort, onGespeichert }: { standort: StandortBezug; onGespeichert: () => void }) {
  const [offen, setOffen] = useState(false);
  const [suche, setSuche] = useState('');
  const [wahl, setWahl] = useState<AdressWahl | null>(null);
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [fokus, setFokus] = useState(0);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function waehle(w: AdressWahl | null) {
    setWahl(w);
    setFehler(null);
    if (w?.punkt) {
      setLat(w.punkt.breitengrad);
      setLon(w.punkt.laengengrad);
      setFokus((n) => n + 1);
    }
  }

  async function speichern() {
    if (busy) return;
    let gewaehlt = wahl;
    if (!gewaehlt) {
      // F5: getippt, aber nicht gewählt - der erste Vorschlag gilt, der Pin zeigt ihn zur Kontrolle.
      if (suche.trim().length < 3) {
        setFehler('Bitte geben Sie die Adresse an - Straße und Hausnummer genügen.');
        document.getElementById('vp-wo-steht-adresse')?.focus();
        return;
      }
      try {
        const t = (await api.orteSuche(suche.trim())).treffer.find((x) => adresseAusTreffer(x));
        if (!t) {
          setFehler(SATZ_NICHT_GEFUNDEN);
          return;
        }
        const ad = adresseAusTreffer(t)!;
        setSuche(adresseText(ad));
        waehle({ adresse: ad, punkt: { breitengrad: t.breitengrad, laengengrad: t.laengengrad } });
        setFehler(null);
      } catch {
        setFehler('Die Adresssuche ist gerade nicht erreichbar - geben Sie die Adresse bitte von Hand ein.');
      }
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const alle = await api.standorte();
      const s = alle.standorte.find((x) => x.id === standort.id);
      if (!s) throw new Error('Standort nicht gefunden');
      const a = gewaehlt.adresse;
      await api.standortBearbeiten(s.id, {
        // Der Name bleibt, wie er ist: hat ihn VoltPilot vergeben, benennt ihn der Server nach der Straße.
        name: s.name,
        kurzzeichen: s.kurzzeichen,
        adresse: { strasse: a.strasse, plz: a.plz, ort: a.ort, land: a.land },
        zeitzone: s.zeitzone || ZEITZONE_DES_LANDES[a.land],
        nutzung: s.nutzung ?? null,
        notiz: s.notiz ?? null,
        lage: lat != null && lon != null ? { breitengrad: lat, laengengrad: lon } : null,
      });
      onGespeichert();
    } catch (e) {
      const abgelehnt = e instanceof ApiError ? alsOrtFehler(e.body) : null;
      setFehler(abgelehnt?.message ?? 'Das Speichern hat gerade nicht geklappt. Bitte versuchen Sie es noch einmal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vp-hinweis vp-hinweis-ort" aria-labelledby="vp-wo-steht-titel">
      <span className="vp-hinweis-symbol" aria-hidden="true">
        <Icon name="map-pin" size={18} />
      </span>
      <div className="vp-hinweis-text">
        <h3 id="vp-wo-steht-titel">Wo steht {standort.name}?</h3>
        <p>Mit der Adresse kommen Wetter und Sonnenprognose - für alle Anlagen an diesem Ort.</p>
        {offen && (
          <div className="vp-hinweis-form">
            <AdressSuche
              id="vp-wo-steht-adresse"
              suche={suche}
              onSuche={(t) => {
                setSuche(t);
                setFehler(null);
              }}
              gewaehlt={wahl}
              onWahl={waehle}
              fehler={fehler}
            />
            {wahl && (
              <LocationMap
                lat={lat}
                lon={lon}
                fokus={fokus}
                onChange={(la, lo) => {
                  setLat(la);
                  setLon(lo);
                }}
              />
            )}
            <Recht aktion="anlage.verwalten">
              <Button variant="primary" onClick={speichern} disabled={busy}>
                {busy ? 'Wird gespeichert…' : 'Adresse speichern'}
              </Button>
            </Recht>
          </div>
        )}
      </div>
      {!offen && (
        <div className="vp-hinweis-knoepfe">
          <Recht aktion="anlage.verwalten">
            <Button variant="primary" size="sm" onClick={() => setOffen(true)}>
              Adresse angeben
            </Button>
          </Recht>
        </div>
      )}
    </section>
  );
}
