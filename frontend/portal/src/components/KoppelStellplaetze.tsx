/**
 * Abschnitt „Stellplätze“ einer Anlagensteuerung mit Koppelbild (PFC200 Stufe 4) - an der Karte unter
 * Steuerung › Geräte und auf der Geräteseite `as-<Komponente>`. Kopf mit der Lage der Box gegenüber der Steuerung,
 * dann je Stellplatz das Angebot und drei getrennte Zeilen: Wunsch der Box, Quittung der Steuerung und was die
 * Anlage laut Steuerung anwendet. Schalt-Test und Freigabe öffnen im nachgeladenen `KoppelStellplatzDialog`.
 *
 * Die Wörter und Ableitungen stehen in `koppelStellplaetze.ts`; ohne Koppelbild-Route (älteres Backend) rendert der
 * Abschnitt nichts.
 */
import { lazy, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import type { Koppelbild } from '../api';
import { KOPPEL_QUITTUNG, KOPPEL_SCHALT_TEST, KOPPEL_STELLPLAETZE, KOPPEL_WIRKSAM, KOPPEL_WUNSCH } from '../glossar';
import { koppelKopf, stellplatzAnzeigen, type StellplatzAnzeige, type Zeile } from '../koppelStellplaetze';
import { useKoppelbild } from '../useAnlagensteuerung';
import { LazyBoundary } from './Lazy';
import { Recht } from './Recht';
import './KoppelStellplaetze.css';

const KoppelStellplatzDialog = lazy(() =>
  import('./KoppelStellplatzDialog').then((m) => ({ default: m.KoppelStellplatzDialog })),
);

export function KoppelStellplaetze({
  siteId,
  geraetId,
  ebene,
  einheitHref,
  jetzt,
}: {
  siteId: string;
  geraetId: string;
  /** `karte` unter Steuerung › Geräte, `geraet` in der Karte „Gerät“ der Geräteseite. */
  ebene: 'karte' | 'geraet';
  /** Die Seite einer Erzeugungseinheit; ohne sie steht das Ziel ohne Weg. */
  einheitHref?: (teNr: number) => string | null;
  /** Die Uhr der Seite (Tests); ohne sie „jetzt“. */
  jetzt?: Date;
}) {
  const { bild, neuLaden, setze } = useKoppelbild(siteId, geraetId);
  if (!bild) return null;
  return (
    <KoppelStellplaetzeAnzeige
      bild={bild}
      geraetId={geraetId}
      ebene={ebene}
      einheitHref={einheitHref}
      jetzt={jetzt}
      onChanged={(neu) => (neu ? setze(neu) : neuLaden())}
    />
  );
}

export function KoppelStellplaetzeAnzeige({
  bild,
  geraetId,
  ebene,
  einheitHref,
  jetzt,
  onChanged,
}: {
  bild: Koppelbild;
  geraetId: string;
  ebene: 'karte' | 'geraet';
  einheitHref?: (teNr: number) => string | null;
  jetzt?: Date;
  /** Nach Test, Freigabe oder Rücknahme: mit dem frischen Koppelbild aus der Antwort, sonst neu laden. */
  onChanged: (neu?: Koppelbild) => void;
}) {
  const [offen, setOffen] = useState<number | null>(null);
  const now = jetzt ?? new Date();
  const kopf = koppelKopf(bild, now);
  const plaetze = stellplatzAnzeigen(bild);
  const offenerPlatz = offen == null ? null : bild.stellplaetze.find((s) => s.platz === offen) ?? null;
  const ueberschrift = `vp-kb-h-${geraetId}-${ebene}`;
  const meta = [kopf.frist && `Frist: ${kopf.frist}`, kopf.alt, kopf.bibliothek].filter(Boolean);

  return (
    <section
      className={`vp-kb vp-kb-${ebene}${kopf.alt ? ' is-alt' : ''}`}
      aria-labelledby={ueberschrift}
      data-testid="koppel-stellplaetze"
    >
      {ebene === 'geraet' ? (
        <h4 className="vp-gh-unter" id={ueberschrift}>{KOPPEL_STELLPLAETZE}</h4>
      ) : (
        <h3 className="vp-kb-h" id={ueberschrift}>{KOPPEL_STELLPLAETZE}</h3>
      )}
      <p className={`vp-kb-satz is-${kopf.ton}`} data-testid="koppel-kopf">
        {kopf.satz}
      </p>
      {meta.length > 0 && (
        <p className="vp-kb-meta">
          {meta.map((m) => (
            <span key={m as string}>{m}</span>
          ))}
        </p>
      )}
      {kopf.bibliothekWarnung && (
        <p className="vp-kb-warnung" role="note">
          {kopf.bibliothekWarnung}
        </p>
      )}
      {plaetze.length === 0 ? (
        bild.stand && bild.unterstuetzt && bild.stand.lage === 'bereit' ? (
          <p className="vp-kb-leer">Die Steuerung bietet noch keinen Stellplatz an.</p>
        ) : null
      ) : (
        <ul className="vp-kb-liste" aria-label={KOPPEL_STELLPLAETZE}>
          {plaetze.map((p) => (
            <StellplatzEintrag
              key={p.platz}
              p={p}
              href={p.angebot?.einheit != null ? einheitHref?.(p.angebot.einheit) ?? null : null}
              onOeffnen={() => setOffen(p.platz)}
            />
          ))}
        </ul>
      )}
      {offenerPlatz && (
        <LazyBoundary fallback={null}>
          <KoppelStellplatzDialog
            geraetId={geraetId}
            stellplatz={offenerPlatz}
            bild={bild}
            jetzt={now}
            onClose={() => setOffen(null)}
            onChanged={onChanged}
          />
        </LazyBoundary>
      )}
    </section>
  );
}

function StellplatzEintrag({ p, href, onOeffnen }: { p: StellplatzAnzeige; href: string | null; onOeffnen: () => void }) {
  return (
    <li className="vp-kb-platz" data-testid="koppel-stellplatz">
      <div className="vp-kb-platz-kopf">
        <b>{p.titel}</b>
        <span className={`vp-kb-pill is-${p.freigabe.ton}`}>{p.freigabe.text}</span>
      </div>
      {p.angebot ? (
        <p className="vp-kb-angebot">
          {/* Der Trennpunkt hängt am Wort davor - ein Umbruch beginnt nie mit „·“. */}
          <span>
            {p.angebot.art}
            {'\u00a0· '}
            {href ? (
              <a href={href} data-testid="koppel-ziel-link">
                {p.angebot.ziel}
              </a>
            ) : (
              p.angebot.ziel
            )}
            {'\u00a0· '}
            <span className="vp-kb-band">{p.angebot.band}</span>
          </span>
          <span className={`vp-kb-bereit is-${p.angebot.bereit.ton}`}>{p.angebot.bereit.text}</span>
        </p>
      ) : (
        <p className="vp-kb-angebot is-leer">Die Steuerung bietet an diesem Stellplatz gerade nichts an.</p>
      )}
      <dl className="vp-kb-zeilen">
        <ZeileAnzeige titel={KOPPEL_WUNSCH} zeile={p.wunsch} />
        <ZeileAnzeige titel={KOPPEL_QUITTUNG} zeile={p.quittung} />
        <ZeileAnzeige titel={KOPPEL_WIRKSAM} zeile={p.wirksam} />
      </dl>
      {p.bedienbar && (
        <Recht aktion={['schalttest.durchfuehren', 'freigabe.erteilen']}>
          <div className="vp-kb-aktion">
            <Button variant="outline" size="sm" onClick={onOeffnen}>
              {KOPPEL_SCHALT_TEST} und Freigabe
            </Button>
          </div>
        </Recht>
      )}
    </li>
  );
}

function ZeileAnzeige({ titel, zeile }: { titel: string; zeile: Zeile }) {
  return (
    <div>
      <dt>{titel}</dt>
      <dd className={`is-${zeile.ton}`}>{zeile.text}</dd>
    </div>
  );
}
