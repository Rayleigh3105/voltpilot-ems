import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Massnahme, type MassnahmeListe } from '../api';
import * as B from '../massnahmenBild';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import { BegriffAufklapper } from './BegriffAufklapper';
import { FristDatum, Kennzeichentext } from './FristDatum';
import { GrenzHinweis, GrenzSatz } from './GrenzSatz';
import { MassnahmeAnlegenDialog } from './MassnahmeDialoge';
import '../pages/Verbesserung.css';
import './Wiedervorlage.css';
import './kacheln/Kacheln.css';
import '../pages/Massnahmen.css';

type Lage = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; l: MassnahmeListe };
type Filter = B.Stufe | 'alle';

/** Die Marke „Was es bringt“ in der Familie der Kacheln (`.vp-k-marke`). */
export function BringtMarke({ marke }: { marke: B.Marke }) {
  const ton = marke.ton === 'ok' ? ' is-ok' : marke.ton === 'warn' ? ' is-warn' : marke.ton === 'plan' ? ' is-plan' : marke.ton === 'ohne' ? ' is-ohne' : '';
  return (
    <span className={`vp-k-marke${ton}`} data-testid="massnahme-marke">
      {marke.ton === 'ok' && <Icon name="check" size={12} />}
      {marke.wort}
    </span>
  );
}

/** Eine Maßnahme der Liste: am Telefon eine Karte, ab 760 px Breite eine Reihe mit fünf Spalten (§6.5). */
function Eintrag({ m, onOeffnen }: { m: Massnahme; onOeffnen: (id: string) => void }) {
  const rollen = useRollen();
  const datum = B.datumBild(m);
  const bringt = B.bringtBild(m);
  const schritt = B.naechsterSchritt(m, {
    melden: rollen.darf('verbesserung.verwalten', m.standort_id),
    abschliessen: rollen.darf('verbesserung.abschliessen', m.standort_id),
  });
  const woher = B.woherZeile(m);
  return (
    <div className="vp-wv-eintrag vp-mn-eintrag is-ziel" data-testid={`massnahme-eintrag-${m.kennzeichen}`} data-entscheid="massnahme_termin">
      <FristDatum wort={datum.wort} tag={datum.tag} jahr={datum.jahr} satz={datum.satz} ton={datum.ton} />
      <span className="vp-wv-text">
        <span className="vp-wv-aufgabe vp-mn-titel">
          <a
            className="vp-wv-ziel"
            href={`#/portfolio/verbesserung/massnahmen/${m.id}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onOeffnen(m.id);
            }}
            aria-label={`${m.titel}: ${schritt.wort}`}
            data-testid={`massnahme-oeffnen-${m.kennzeichen}`}
          >
            {m.titel}
          </a>
          <span className="vp-mn-kz">{m.kennzeichen}</span>
        </span>
        {woher && (
          <span className="vp-wv-grund">
            <Kennzeichentext text={woher} />
          </span>
        )}
      </span>
      <span className="vp-wv-chev" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
      <span className="vp-mn-bringt" data-testid="massnahme-bringt">
        {bringt.zahl && <span className="vp-mn-zahl">{bringt.zahl}</span>}
        {bringt.text && <span className="vp-mn-bringt-text">{bringt.text}</span>}
        {bringt.marke && <BringtMarke marke={bringt.marke} />}
      </span>
      <span className="vp-wv-fuss">
        <span className="vp-wv-wer">
          <span className="vp-mn-wer-icon" aria-hidden="true">
            <Icon name="users" size={14} />
          </span>
          {m.verantwortlich.name}
        </span>
        <span className={`vp-wv-schritt${schritt.leise ? ' is-leise' : ''}`} aria-hidden="true" data-testid="massnahme-schritt">
          {schritt.wort}
        </span>
      </span>
    </div>
  );
}

/** „So läuft eine Maßnahme“: die drei Stufen mit einem Satz (§6.5). */
function SoLaeuft() {
  return (
    <section className="vp-wv-karte" aria-labelledby="mn-so-laeuft" data-testid="massnahmen-so-laeuft">
      <div className="vp-wv-blockkopf">
        <h2 id="mn-so-laeuft">{B.SO_LAEUFT}</h2>
      </div>
      <ol className="vp-mn-stufen" aria-label="Stufen einer Maßnahme">
        <li className="is-done">
          <span className="vp-mn-punkt" aria-hidden="true">
            <Icon name="check" size={13} />
          </span>
          <b>Geplant</b>
          <small>Wer, was, bis wann</small>
        </li>
        <li className="is-an">
          <span className="vp-mn-punkt" aria-hidden="true" />
          <b>Umgesetzt</b>
          <small>gemeldet mit Tag</small>
        </li>
        <li className="is-offen">
          <span className="vp-mn-punkt" aria-hidden="true" />
          <b>Wirkung geprüft</b>
          <small>nach bis zu 12 Monaten</small>
        </li>
      </ol>
      <p className="vp-wv-leise">{B.SO_LAEUFT_SATZ}</p>
    </section>
  );
}

/**
 * Der Reiter „Maßnahmen“ (Verbessern-Konzept v1 §6.5, Richtungsfrage 9.2 A): Titel mit Klartext und „Planen“ im Kopf
 * (Entscheid 7), Antwort zuerst, Filter-Chips nach Stufe, die Gruppen „Zu tun“, „Umgesetzt“, „Abgeschlossen“ mit je
 * einer Karte bzw. Reihe - wer sich kümmert, bis wann, was es bringt, der nächste Schritt mit seinem Verb. Die Marke
 * `data-entscheid="massnahme_termin"` bleibt an jeder Karte, damit die Sprünge der Wiedervorlage treffen.
 */
export function MassnahmenRegister({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [filter, setFilter] = useState<Filter>('alle');
  const [planen, setPlanen] = useState(false);
  const rollen = useRollen();
  const darfPlanen = rollen.darf('verbesserung.verwalten', null) || (rollen.selbst?.standorte ?? []).some((s) => rollen.darf('verbesserung.verwalten', s.id));

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahmen().then(
      (l) => {
        // Eine Uhr (Befund 2): die Blätter rechnen „heute“ mit dem Tag der Route.
        merkeAbruf(l.abruf);
        if (aktiv) setLage({ art: 'da', l });
      },
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const kopf = (
    <header className="vp-wv-kopf vp-mn-kopf">
      <div className="vp-wv-kopf-text">
        <h1>{B.TITEL}</h1>
        <p className="vp-wv-meta">{B.UNTERTITEL}</p>
      </div>
      {darfPlanen && (
        <>
          {/* Entscheid 7: „Planen“ steht auch am Telefon im Kopf - dort umrandet, am Rechner gefüllt. */}
          <Button
            className="vp-mn-planen vp-mn-planen-kurz"
            variant="outline"
            size="sm"
            iconLeft={<Icon name="plus" size={15} />}
            onClick={() => setPlanen(true)}
            data-testid="massnahme-planen-knopf"
          >
            {B.KNOPF_PLANEN_KURZ}
          </Button>
          <Button
            className="vp-mn-planen vp-mn-planen-lang"
            size="sm"
            iconLeft={<Icon name="plus" size={15} />}
            onClick={() => setPlanen(true)}
            data-testid="massnahme-planen-knopf-lang"
          >
            {B.KNOPF_PLANEN}
          </Button>
        </>
      )}
    </header>
  );

  const fuss = (
    <>
      <SoLaeuft />
      <GrenzHinweis />
      <GrenzSatz className="vp-ez-grenze" />
    </>
  );

  let inhalt: React.ReactNode;
  if (lage.art === 'laedt') {
    inhalt = (
      <div className="vp-wv-skelett" aria-busy="true" aria-label="Wird geladen" data-testid="massnahmen-laedt">
        <span className="vp-skeleton is-zeile" />
        <span className="vp-skeleton is-karte" />
        <span className="vp-skeleton is-karte" />
      </div>
    );
  } else if (lage.art === 'fehler') {
    inhalt = (
      <section className="vp-wv-karte is-fehler" role="alert" data-testid="massnahmen-fehler">
        <div className="vp-wv-blockkopf">
          <h2>{B.LADEFEHLER_TITEL}</h2>
        </div>
        <p className="vp-wv-leise">{B.LADEFEHLER}</p>
        <button type="button" className="vp-wv-link" onClick={() => setVersuch((v) => v + 1)}>
          {B.ERNEUT_VERSUCHEN}
        </button>
      </section>
    );
  } else if (lage.l.massnahmen.length === 0) {
    inhalt = (
      <section className="vp-wv-karte" data-testid="massnahmen-leer">
        <p className="vp-wv-leer">{B.LEER}</p>
        {darfPlanen && (
          <Button size="sm" iconLeft={<Icon name="plus" size={15} />} onClick={() => setPlanen(true)}>
            {B.KNOPF_PLANEN}
          </Button>
        )}
        <BegriffAufklapper begriff="massnahme" />
      </section>
    );
  } else {
    const liste = lage.l.massnahmen;
    const g = B.gruppen(liste);
    const sichtbar = B.STUFEN.filter((s) => g[s].length > 0 && (filter === 'alle' || filter === s));
    inhalt = (
      <>
        <div className="vp-mn-antwort" data-testid="massnahmen-antwort">
          <p className="vp-mn-satz">{B.antwortSatz(liste)}</p>
          <p className="vp-mn-formal">{B.formalZeile(liste, lage.l.abruf)}</p>
        </div>
        {/* „Was ist eine Maßnahme?“ wie jeder Begriff, mit den Fachwörtern zuletzt (Entscheid 14; Review r2 S-r2-2). */}
        <BegriffAufklapper begriff="massnahme" />
        <div className="vp-wv-filter" role="group" aria-label="Nach Stufe zeigen" data-testid="massnahmen-chips">
          {B.chips(liste).map((c) => (
            <button
              key={c.key}
              type="button"
              className="vp-wv-chip"
              aria-pressed={filter === c.key}
              onClick={() => setFilter(c.key)}
              data-testid={`massnahmen-chip-${c.key}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {sichtbar.map((s, i) => (
          <section key={s} className="vp-wv-abschnitt" aria-labelledby={`mn-gruppe-${s}`} data-testid={`massnahmen-gruppe-${s}`}>
            <div className="vp-wv-abschnitt-kopf">
              <h2 id={`mn-gruppe-${s}`}>
                {B.STUFE_WORT[s]}
                <span className="vp-mn-nur-telefon"> · {g[s].length}</span>
              </h2>
              <span className="vp-wv-abschnitt-m">{`${g[s].length} · ${B.STUFE_ORDNUNG[s]}`}</span>
            </div>
            {i === 0 && (
              <div className="vp-mn-kopfzeile" aria-hidden="true">
                <span>{B.SPALTEN.termin}</span>
                <span>{B.SPALTEN.massnahme}</span>
                <span>{B.SPALTEN.bringt}</span>
                <span>{B.SPALTEN.verantwortlich}</span>
                <span>{B.SPALTEN.schritt}</span>
              </div>
            )}
            <ul className="vp-wv-eintraege">
              {g[s].map((m) => (
                <li key={m.id}>
                  <Eintrag m={m} onOeffnen={onOeffnen} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );
  }

  return (
    <div className="vp-wv vp-mn vp-k-farben" data-testid="massnahmen-register">
      {kopf}
      {inhalt}
      {fuss}
      {planen && (
        <MassnahmeAnlegenDialog
          vorbelegung={{ herkunft: 'von_hand' }}
          tagHeute={lage.art === 'da' ? lage.l.abruf : undefined}
          onClose={() => setPlanen(false)}
          onAngelegt={(m) => {
            setPlanen(false);
            onOeffnen(m.id);
          }}
        />
      )}
    </div>
  );
}
