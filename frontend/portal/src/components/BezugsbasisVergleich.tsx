import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  monatsOptionen,
  VERGLEICH_BASIS_WAHL,
  VERGLEICH_BEREINIGT,
  VERGLEICH_BIS,
  VERGLEICH_LADEFEHLER,
  VERGLEICH_REITER,
  VERGLEICH_ROH,
  VERGLEICH_SPALTEN,
  VERGLEICH_VON,
  VERGLEICH_ZEITRAUM,
  VERGLEICH_ZEITRAUM_UNGUELTIG,
  vergleichBild,
  zeitraumGueltig,
  type BezugsbasisDerKennzahl,
  type BezugsbasisVergleich as Vergleich,
  type BezugsbasisVergleichWahl,
  type MonatBild,
  type ZeitraumBild,
} from '../bezugsbasisVergleich';
import { UEMS_NORMGRENZE } from '../glossar';
import { ErrorState, Skeleton } from './States';
import { VpPicker } from './VpPicker';
import './BezugsbasisVergleich.css';

/**
 * UEMS AP-17 IP-20 (U1–U6, S5, SP3): der Reiter „Vergleich mit Bezugsbasis“ an der Kennzahl. Er liest nur den Leser
 * IP-19 (`api.bezugsbasisVergleich`, Vertrag `bezugsbasis.md` §16) und rendert das Bild aus `bezugsbasisVergleich.ts` —
 * hier wird nichts gerechnet und kein Urteil formuliert. Je Monat stehen **roh** (gemessen, Veränderung zum Vormonat,
 * „ohne Urteil“; U1, VG3) und **bereinigt** (Bedingung, erwartet, Δ, Urteil-Wort mit Band, Kennzeichen, Satz des
 * Lesers) nebeneinander; ein Monat, den die Bezugsbasis nicht trägt, zeigt den Satz des Lesers statt der Zahlen. Darüber
 * die Basis-Zeile und der Zeitraum (Σ ÷ Σ, U5), darunter die Stände (S5) und der Grenz-Satz. 375 px: Monate als Karten;
 * ab 960 px eine Tafel.
 */
export function BezugsbasisVergleich({ kennzahlId }: { kennzahlId: string }) {
  const [wahl, setWahl] = useState<BezugsbasisVergleichWahl>({});
  const [antwort, setAntwort] = useState<Vergleich | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [basen, setBasen] = useState<BezugsbasisDerKennzahl[]>([]);
  const [entwurf, setEntwurf] = useState<{ von: string; bis: string } | null>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    api.bezugsbasisVergleich(kennzahlId, wahl).then(
      (v) => {
        if (!aktiv) return;
        setAntwort(v);
        setEntwurf({ von: v.von, bis: v.bis });
      },
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [kennzahlId, wahl, versuch]);

  useEffect(() => {
    let aktiv = true;
    // Die Wahl gibt es erst ab zwei Bezugsbasen; eine Liste, die nicht antwortet, bringt keine Wahl.
    api.kennzahlBezugsbasen(kennzahlId).then(
      (l) => aktiv && setBasen(l.bezugsbasen),
      () => aktiv && setBasen([]),
    );
    return () => {
      aktiv = false;
    };
  }, [kennzahlId]);

  if (fehler) return <ErrorState message={VERGLEICH_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />;
  if (!antwort) {
    return (
      <div aria-busy="true" data-testid="vergleich-laedt">
        <Skeleton height={148} />
      </div>
    );
  }

  const bild = vergleichBild(antwort);
  const zeitraumFalsch = entwurf !== null && !zeitraumGueltig(entwurf.von, entwurf.bis);
  const setzeZeitraum = (von: string, bis: string) => {
    setEntwurf({ von, bis });
    if (zeitraumGueltig(von, bis)) setWahl((w) => ({ ...w, von, bis }));
  };
  const optionen = monatsOptionen(entwurf && entwurf.bis > antwort.bis ? entwurf.bis : antwort.bis);

  return (
    <section className="vp-bbv" aria-label={VERGLEICH_REITER} data-testid="bezugsbasis-vergleich">
      {bild.art === 'leer' ? (
        <div className="vp-kz-block vp-bbv-leer" data-testid="vergleich-leer">
          <p>{bild.satz}</p>
          <p className="vp-kz-leise">{bild.hinweis}</p>
        </div>
      ) : (
        <>
          <p className="vp-bbv-basis" data-testid="vergleich-basis">
            {bild.basisZeile}
          </p>
          <div className="vp-bbv-wahl">
            {basen.length > 1 && (
              <VpPicker
                label={VERGLEICH_BASIS_WAHL}
                options={basen.map((b) => ({ value: b.kennzeichen, label: b.kennzeichen, sub: b.beendet_zum ? 'beendet' : 'laufend' }))}
                value={wahl.basis ?? antwort.bezugsbasis?.kennzeichen ?? null}
                onChange={(basis) => setWahl((w) => ({ ...w, basis }))}
                search="nie"
              />
            )}
            <VpPicker
              label={VERGLEICH_VON}
              options={optionen}
              value={entwurf?.von ?? antwort.von}
              onChange={(von) => setzeZeitraum(von, entwurf?.bis ?? antwort.bis)}
            />
            <VpPicker
              label={VERGLEICH_BIS}
              options={optionen}
              value={entwurf?.bis ?? antwort.bis}
              onChange={(bis) => setzeZeitraum(entwurf?.von ?? antwort.von, bis)}
              error={zeitraumFalsch ? VERGLEICH_ZEITRAUM_UNGUELTIG : undefined}
            />
          </div>
          <ZeitraumKopf z={bild.zeitraum} />
          <MonateTafel monate={bild.monate} />
        </>
      )}
      {bild.art === 'vergleich' && (
        <p className="vp-bbv-stand" data-testid="vergleich-stand">
          {bild.standSatz}
        </p>
      )}
      <p className="vp-bbv-grenze" data-testid="vergleich-grenze">{UEMS_NORMGRENZE}</p>
    </section>
  );
}

/** Der Zeitraum (U5): Σ gemessen, Σ erwartet, Δ, Urteil mit Band und der Satz des Lesers. */
function ZeitraumKopf({ z }: { z: ZeitraumBild }) {
  return (
    <div className="vp-kz-block vp-bbv-zeitraum" data-testid="vergleich-zeitraum">
      <h2>
        {VERGLEICH_ZEITRAUM} · {z.titel}
      </h2>
      <dl className="vp-bbv-zahlen">
        <div>
          <dt>{VERGLEICH_SPALTEN.gemessen}</dt>
          <dd>{z.gemessen}</dd>
        </div>
        <div>
          <dt>{VERGLEICH_SPALTEN.erwartet}</dt>
          <dd>{z.erwartet}</dd>
        </div>
        <div>
          <dt>{VERGLEICH_SPALTEN.delta}</dt>
          <dd>{z.delta ?? '—'}</dd>
        </div>
        <div>
          <dt>{VERGLEICH_SPALTEN.urteil}</dt>
          <dd>
            <UrteilWort klasse={z.urteilKlasse} wort={z.urteil} band={z.band} />
          </dd>
        </div>
      </dl>
      {z.monate && (
        <p className="vp-kz-leise" data-testid="zeitraum-monate">
          {z.monate}
        </p>
      )}
      <p data-testid="zeitraum-satz">{z.satz}</p>
      <Kennzeichen liste={z.kennzeichen} />
    </div>
  );
}

function UrteilWort({ klasse, wort, band }: { klasse: string; wort: string; band: string | null }) {
  return (
    <span className={`vp-bbv-urteil is-${klasse}`} data-testid="urteil">
      {wort}
      {band && <span className="vp-bbv-band"> ({band})</span>}
    </span>
  );
}

function Kennzeichen({ liste }: { liste: string[] }) {
  if (liste.length === 0) return null;
  return (
    <ul className="vp-bbv-kennzeichen" data-testid="kennzeichen">
      {liste.map((k) => (
        <li key={k}>{k}</li>
      ))}
    </ul>
  );
}

/**
 * Je Monat eine Zeile: gemessen (mit Version), die rohe Hälfte ohne Urteil (U1) und die bereinigte Hälfte; darunter der
 * Satz des Lesers. Ein Monat ohne Vergleich trägt statt der bereinigten Zahlen den Satz des Lesers (Grund statt Zahl).
 */
function MonateTafel({ monate }: { monate: MonatBild[] }) {
  return (
    <table className="vp-bbv-tafel" data-testid="vergleich-monate">
      <thead>
        <tr>
          <th scope="col" rowSpan={2}>
            {VERGLEICH_SPALTEN.monat}
          </th>
          <th scope="col" rowSpan={2}>
            {VERGLEICH_SPALTEN.gemessen}
          </th>
          <th scope="colgroup" colSpan={2} className="vp-bbv-roh-kopf">
            {VERGLEICH_ROH}
          </th>
          <th scope="colgroup" colSpan={5} className="vp-bbv-ber-kopf">
            {VERGLEICH_BEREINIGT}
          </th>
        </tr>
        <tr>
          <th scope="col">{VERGLEICH_SPALTEN.vormonat}</th>
          <th scope="col">{VERGLEICH_SPALTEN.urteil}</th>
          <th scope="col">{VERGLEICH_SPALTEN.bedingung}</th>
          <th scope="col">{VERGLEICH_SPALTEN.erwartet}</th>
          <th scope="col">{VERGLEICH_SPALTEN.delta}</th>
          <th scope="col">{VERGLEICH_SPALTEN.urteil}</th>
          <th scope="col">{VERGLEICH_SPALTEN.kennzeichen}</th>
        </tr>
      </thead>
      {monate.map((m) => (
        <tbody key={m.periode} className="vp-bbv-monat" data-testid={`monat-${m.periode}`}>
          <tr>
            <th scope="row" className="vp-bbv-monat-name">
              {m.beschriftung}
            </th>
            <td className="vp-bbv-gemessen" data-label={VERGLEICH_SPALTEN.gemessen} data-testid="gemessen">
              {m.roh.gemessen}
              {m.version && <span className="vp-bbv-neben">{m.version}</span>}
            </td>
            <td className="vp-bbv-roh" data-label={`${VERGLEICH_ROH} · ${VERGLEICH_SPALTEN.vormonat}`} data-testid="roh">
              {m.roh.veraenderung ?? '—'}
              {m.roh.bedingung && <span className="vp-bbv-neben">{m.roh.bedingung}</span>}
            </td>
            <td className="vp-bbv-roh vp-bbv-ohne" data-label={`${VERGLEICH_ROH} · ${VERGLEICH_SPALTEN.urteil}`} data-testid="roh-urteil">
              {m.roh.ohneUrteil}
            </td>
            {m.bereinigt.art === 'grund' ? (
              <td colSpan={5} className="vp-bbv-grund" data-label={VERGLEICH_BEREINIGT} data-testid="grund">
                {m.satz}
                <Kennzeichen liste={m.bereinigt.kennzeichen} />
              </td>
            ) : (
              <>
                <td className="vp-bbv-ber" data-label={`${VERGLEICH_BEREINIGT} · ${VERGLEICH_SPALTEN.bedingung}`} data-testid="bedingung">
                  {m.bereinigt.bedingung}
                </td>
                <td className="vp-bbv-ber" data-label={VERGLEICH_SPALTEN.erwartet} data-testid="erwartet">
                  {m.bereinigt.erwartet}
                </td>
                <td className="vp-bbv-ber" data-label={VERGLEICH_SPALTEN.delta} data-testid="delta">
                  {m.bereinigt.delta ?? '—'}
                </td>
                <td className="vp-bbv-ber" data-label={VERGLEICH_SPALTEN.urteil}>
                  <UrteilWort klasse={m.bereinigt.urteilKlasse} wort={m.bereinigt.urteil} band={m.bereinigt.band} />
                </td>
                <td className="vp-bbv-ber" data-label={VERGLEICH_SPALTEN.kennzeichen}>
                  <Kennzeichen liste={m.bereinigt.kennzeichen} />
                </td>
              </>
            )}
          </tr>
          {m.bereinigt.art === 'zahl' && (
            <tr className="vp-bbv-satz-zeile">
              <td colSpan={9} data-testid="satz">
                {m.satz}
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );
}
