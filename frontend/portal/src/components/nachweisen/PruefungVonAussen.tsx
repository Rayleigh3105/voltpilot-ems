import { useEffect, useState } from 'react';
import { api, type EnergiemanagementMappe, type EnergiemanagementVerzeichnis } from '../../api';
import * as E from '../../energiemanagementPortal';
import * as P from '../../mappeBild';
import { hashForRoute, mappeRoute, type Route } from '../../nav';
import { useRollen } from '../../rollen';
import { EinsichtBlatt } from './EinsichtBlatt';
import { MappeBlatt } from './MappeBlatt';
import { NwBlatt } from './NwBlatt';
import { NwSymbol } from './NwSymbol';
import { Fakt, NwZeile, NwZeilen } from './NwZeilen';

/**
 * „Prüfung von außen“ im Überblick (Konzept Nachweisen n1, Runde 2, Entscheide 2, 7 und 8, Mock r2-U): nach
 * „Demnächst“ zwei Knöpfe - „Unterlagen zusammenstellen“ (wer das Energiemanagement bearbeitet) und „Einsicht geben“
 * (Kundenadministratoren) - und „Mappen · n“, die noch abrufbar sind, mit der Liste im Blatt. Ohne Recht und ohne abrufbare Mappe
 * steht der Abschnitt nicht da.
 *
 * `verzeichnis` und `offen` kommen aus dem Überblick, der sie schon gelesen hat; `heute` ist der Tag der Route.
 */
export function PruefungVonAussen({
  heute,
  verzeichnis,
  offen,
  onNavigate,
}: {
  heute: string;
  verzeichnis: Pick<EnergiemanagementVerzeichnis, 'gruppen'> | null;
  offen: readonly string[];
  onNavigate: (r: Route) => void;
}) {
  const rollen = useRollen();
  const darfMappe = rollen.darf(E.RECHT_VERWALTEN, null);
  const darfEinsicht = rollen.darf('benutzer.verwalten', null);
  const [mappen, setMappen] = useState<EnergiemanagementMappe[]>([]);
  const [blatt, setBlatt] = useState<null | 'mappe' | 'einsicht' | 'mappen'>(null);

  useEffect(() => {
    let aktiv = true;
    api.energiemanagementMappen().then(
      (r) => aktiv && setMappen(r.mappen.filter((m) => m.abrufbar)),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, []);

  if (!darfMappe && !darfEinsicht && mappen.length === 0) return null;
  return (
    <section className="vp-nw-karte vp-nw-ub-aussen" aria-labelledby="vp-nw-aussen" data-testid="ueberblick-aussen">
      <div className="vp-nw-kk">
        <h2 id="vp-nw-aussen">{P.PRUEFUNG_VON_AUSSEN}</h2>
      </div>
      {(darfMappe || darfEinsicht) && (
        // Dieselben Knöpfe wie „Weitergeben“ (Mock r2-U: `.weitergeben .wg`).
        <div className="vp-nw-wg vp-nw-aussen-knoepfe">
          {darfMappe && (
            <button type="button" className="vp-nw-wg-k" onClick={() => setBlatt('mappe')} data-testid="aussen-mappe">
              <NwSymbol name="ordner" size={16} />
              <span>{P.UNTERLAGEN_ZUSAMMENSTELLEN}</span>
            </button>
          )}
          {darfEinsicht && (
            <button type="button" className="vp-nw-wg-k" onClick={() => setBlatt('einsicht')} data-testid="aussen-einsicht">
              <NwSymbol name="eye" size={16} />
              <span>{P.EINSICHT_GEBEN}</span>
            </button>
          )}
        </div>
      )}
      {/* Die Mappen, die noch abrufbar sind: im Überblick eine Zeile mit ihrer Zahl, die Liste im Blatt (≤ 90 Wörter). */}
      {mappen.length > 0 && (
        <NwZeilen>
          <NwZeile titel={P.MAPPEN} rechts={<Fakt>{mappen.length}</Fakt>} onClick={() => setBlatt('mappen')} testId="aussen-mappen" />
        </NwZeilen>
      )}
      <NwBlatt open={blatt === 'mappen'} titel={P.MAPPEN} onClose={() => setBlatt(null)} testId="aussen-mappen-blatt">
        <NwZeilen>
          {mappen.map((m) => (
            <NwZeile
              key={m.id}
              titel={m.titel}
              unter={P.zeitText(m.stichtag)}
              rechts={<Fakt>{`noch ${m.abrufbar_tage === 1 ? '1 Tag' : `${m.abrufbar_tage} Tage`}`}</Fakt>}
              href={hashForRoute(mappeRoute(m.id))}
              onClick={() => onNavigate(mappeRoute(m.id))}
              testId={`aussen-mappe-${m.id}`}
            />
          ))}
        </NwZeilen>
      </NwBlatt>
      {blatt === 'mappe' && (
        <MappeBlatt
          heute={heute}
          verzeichnis={verzeichnis}
          offen={offen}
          onClose={() => setBlatt(null)}
          onErstellt={(m) => {
            setBlatt(null);
            onNavigate(mappeRoute(m.id));
          }}
        />
      )}
      {blatt === 'einsicht' && <EinsichtBlatt heute={heute} onClose={() => setBlatt(null)} />}
    </section>
  );
}
