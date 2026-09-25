import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import { SAETZE } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_WIEDERVORLAGE } from '../glossar';
import type { Route } from '../nav';
import {
  ART_WORT,
  energiemanagementBaustein,
  FAELLIG,
  KALENDER_ABZUG,
  KALENDER_ABZUG_FEHLER,
  KALENDER_ABZUG_HINWEIS,
  KALENDER_VERMERK_TITEL,
  kalenderVermerk,
  standTag,
  VORSCHAU,
  wiedervorlageSprung,
  type Wiedervorlage,
  type WiedervorlageZeile,
} from '../wiedervorlage';

/**
 * Reiter „Wiedervorlage“ (UEMS AP-19 IP-24, §5.5, WV1–WV4, R12): alle Fristen aller Objekte am Tag des Abrufs, am
 * längsten fällig zuerst, dazu die Vorschau — Lage, Reihenfolge, Titel und Satz jeder Zeile kommen von der Route
 * (`GET /api/v1/energiemanagement/wiedervorlage`), hier wird keine Frist gerechnet (WV2). Je Zeile Art, Kennzeichen,
 * Titel, Tag und Verantwortlich; gesprungen wird nur zu einer Seite, die es gibt (WV3). „Kalender-Abzug“ lädt dieselben
 * Zeilen als .ics — ein Abruf, nichts wird verschickt (WV4, E10), auch mit „Einsicht“.
 * `saetze` zeigt Grenz- und Verantwortungs-Satz, wo der Reiter allein steht (im Bereich stehen sie am Fuß).
 */
export function EnergiemanagementWiedervorlage({ onSprung, saetze = false }: { onSprung?: (ziel: Route) => void; saetze?: boolean }) {
  const [w, setW] = useState<Wiedervorlage | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [kalenderFehler, setKalenderFehler] = useState(false);
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementWiedervorlage().then(
      (r) => aktiv && setW(r),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  async function kalender() {
    setLaeuft(true);
    setKalenderFehler(false);
    try {
      const datei = await api.energiemanagementWiedervorlageIcs();
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wiedervorlage-energiemanagement.ics';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setKalenderFehler(true);
    } finally {
      setLaeuft(false);
    }
  }

  const summe = energiemanagementBaustein(w)?.summe ?? null;
  return (
    <section className="vp-ez-karte" aria-label={UEMS_WIEDERVORLAGE} data-testid="wiedervorlage">
      <div className="vp-em-kopf">
        <h2>{UEMS_WIEDERVORLAGE}</h2>
        <Button variant="outline" iconLeft={<Icon name="calendar" size={16} />} onClick={() => void kalender()} disabled={laeuft} data-testid="wiedervorlage-kalender">
          {KALENDER_ABZUG}
        </Button>
      </div>
      {kalenderFehler && (
        <p className="vp-ez-fehler" role="alert" data-testid="wiedervorlage-kalender-fehler">
          {KALENDER_ABZUG_FEHLER}
        </p>
      )}
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : w === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <>
          <p className="vp-ez-satz" data-testid="wiedervorlage-summe">
            {summe ? `Stand ${standTag(w.stichtag)}: ${summe}` : SAETZE.wiedervorlage_leer}
          </p>
          {summe && (
            <>
              <h3 className="vp-wv-titel">{FAELLIG}</h3>
              {w.faellig.length === 0 ? (
                <p className="vp-ez-leise" data-testid="wiedervorlage-leer">{SAETZE.wiedervorlage_leer}</p>
              ) : (
                <Zeilen zeilen={w.faellig} testid="wiedervorlage-faellig" onSprung={onSprung} />
              )}
              <h3 className="vp-wv-titel">{VORSCHAU(w.vorschau_tage)}</h3>
              {w.vorschau.length === 0 ? (
                <p className="vp-ez-leise">—</p>
              ) : (
                <Zeilen zeilen={w.vorschau} testid="wiedervorlage-vorschau" onSprung={onSprung} />
              )}
            </>
          )}
          <p className="vp-ez-leise" data-testid="wiedervorlage-vermerk">
            {KALENDER_VERMERK_TITEL}: „{kalenderVermerk(w.stichtag)}“ {KALENDER_ABZUG_HINWEIS}
          </p>
        </>
      )}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </section>
  );
}

/** WV3: je Zeile Art, Kennzeichen und Titel (als Sprung, wo es eine Seite gibt), Tag mit Satz, Verantwortlich. */
function Zeilen({ zeilen, testid, onSprung }: { zeilen: WiedervorlageZeile[]; testid: string; onSprung?: (ziel: Route) => void }) {
  return (
    <ul className="vp-wv-liste" data-testid={testid}>
      {zeilen.map((z) => {
        const ziel = onSprung ? wiedervorlageSprung(z) : null;
        const titel = (
          <>
            <span className="vp-wv-kz">{z.kennzeichen}</span> {z.titel}
          </>
        );
        return (
          <li key={`${z.art}/${z.kennzeichen}`} className={`vp-wv-zeile${z.tage > 0 ? ' is-faellig' : ''}`} data-testid={`wiedervorlage-zeile-${z.kennzeichen}`}>
            <span className="vp-wv-art">{ART_WORT[z.art] ?? z.art}</span>
            {ziel ? (
              <button type="button" className="vp-ez-zeile-knopf vp-wv-gegenstand" onClick={() => onSprung?.(ziel)}>
                {titel}
              </button>
            ) : (
              <span className="vp-wv-gegenstand">{titel}</span>
            )}
            <span className="vp-wv-frist">
              <strong>{z.satz}</strong> · {E.tagText(z.faellig_am)}
            </span>
            <span className="vp-wv-wer">{z.verantwortlich ? `Verantwortlich ${z.verantwortlich}` : 'keine Person genannt'}</span>
          </li>
        );
      })}
    </ul>
  );
}
