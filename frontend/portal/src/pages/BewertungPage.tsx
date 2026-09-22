import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type BewertungMessabdeckungOrt, type BewertungRangliste, type BewertungUmfang, type Energieeinsatz, type EnergieeinsatzEinstufungFassung } from '../api';
import {
  ANLEGEN_KNOPF,
  darfVerwalten,
  darfEinstufen,
  darfKriterienAendern,
  bewertungZeitraum,
  EINSAETZE_TITEL,
  einsatzZeile,
  KEINE_WERTE,
  LADEN,
  ladeFehler,
  laeuft,
  LEER,
  NUR_LESEN,
  TITEL,
  UMFANG_AENDERN,
  UMFANG_FESTLEGEN,
  UMFANG_TITEL,
  umfangKarte,
  type EinsatzZeile,
} from '../bewertung';
import { EnergieeinsatzAnlegenDialog } from '../components/EnergieeinsatzDialoge';
import { RanglisteBereich } from '../components/BewertungEntscheidungen';
import { istWesentlich, Pruefaufgaben } from '../components/EinsatzMessmittel';
import { MessabdeckungTabelle } from '../components/MessabdeckungTabelle';
import { MessbedarfErfassenDialog, MessplanungStandorte } from '../components/Messplanung';
import { ErrorState, Skeleton } from '../components/States';
import { UmfangDialog } from '../components/UmfangDialog';
import { UEMS_NORMGRENZE } from '../glossar';
import { useRollen } from '../rollen';
import { EnergieeinsatzSeite } from './EnergieeinsatzSeite';
import './BewertungPage.css';

/**
 * „Unternehmen › Bewertung“ (UEMS AP-16 IP-6, `#/portfolio/bewertung`) und die Seite eines Energieeinsatzes
 * (`#/portfolio/bewertung/{id}`) — Meilenstein M1: Umfang und Einsätze lassen sich anlegen, sehen und zuordnen; nichts
 * rechnet, nichts stuft selbst ein. IP-12 ergänzt Rangliste, Kriterien und die begründete Einstufung durch eine Person.
 * Die Welt erscheint nach der Berichte-Regel (ein Standort misst) und nur mit
 * `energieeinsatz.ansehen` (`ebenenNav.ts`).
 *
 * Die Fläche liest nur ihre eigene Welt (W11): `…/bewertung/umfang` und `…/energieeinsaetze`. Jede Ableitung steht im
 * reinen Modul `bewertung.ts`; der Grenz-Satz steht auf jeder Bewertungs-Fläche (SP3, `copy.test.ts`).
 */
export function BewertungPage({
  einsatzId = null,
  onOeffnen,
  onListe,
}: {
  einsatzId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
}) {
  if (einsatzId) return <EnergieeinsatzSeite key={einsatzId} id={einsatzId} onListe={onListe} />;
  return <BewertungUebersicht onOeffnen={onOeffnen} />;
}

function BewertungUebersicht({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const { selbst } = useRollen();
  const verwalten = darfVerwalten(selbst);
  const einstufen = darfEinstufen(selbst);
  const kriterienAendern = darfKriterienAendern(selbst);
  const zeitraum = useMemo(() => bewertungZeitraum(), []);
  const [liste, setListe] = useState<Energieeinsatz[] | null>(null);
  const [umfang, setUmfang] = useState<BewertungUmfang | null>(null);
  const [rangliste, setRangliste] = useState<BewertungRangliste | null>(null);
  const [historien, setHistorien] = useState<Record<string, EnergieeinsatzEinstufungFassung[]>>({});
  const [kriterienHinweis, setKriterienHinweis] = useState<string | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<'umfang' | 'anlegen' | null>(null);
  const [rest, setRest] = useState<BewertungMessabdeckungOrt | null>(null);
  const [planVersion, setPlanVersion] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.energieeinsaetze(), api.bewertungUmfang(), api.bewertungRangliste(zeitraum.von, zeitraum.bis)]).then(
      async ([l, u, r]) => {
        if (!aktiv) return;
        setListe(l.energieeinsaetze);
        setUmfang(u);
        setRangliste(r);
        const h = await Promise.all([...r.einsaetze, ...r.weitere_traeger].map(async (e) => [e.id, (await api.energieeinsatzEinstufungen(e.id)).fassungen] as const));
        if (aktiv) setHistorien(Object.fromEntries(h));
      },
      (e) => aktiv && setFehler(ladeFehler(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch, zeitraum.bis, zeitraum.von]);

  const karte = useMemo(() => {
    if (!umfang) return null;
    const namen = new Map<string, string>();
    for (const s of umfang.standorte) {
      namen.set(s.id, s.name);
      for (const a of s.anlagen_im_umfang) namen.set(a.id, a.name);
    }
    return umfangKarte(umfang, namen);
  }, [umfang]);

  return (
    <div className="vp-bw" data-testid="bewertung">
      <header className="vp-bw-kopf">
        <div>
          <h1>{TITEL}</h1>
          <p>{EINSAETZE_TITEL} und Umfang Ihres Unternehmens</p>
        </div>
        {verwalten && liste && (
          <Button size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setDialog('anlegen')} data-testid="einsatz-anlegen-knopf">
            {ANLEGEN_KNOPF}
          </Button>
        )}
      </header>
      {selbst && !verwalten && (
        <p className="vp-bw-hinweis" role="note" data-testid="bewertung-nur-lesen">
          {NUR_LESEN}
        </p>
      )}

      {fehler ? (
        fehler.erneut ? (
          <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
        ) : (
          <p className="vp-bw-hinweis" role="status">
            {fehler.satz}
          </p>
        )
      ) : !liste || !karte ? (
        <div aria-busy="true" aria-label={LADEN}>
          <Skeleton height={112} />
        </div>
      ) : (
        <>
          <section className="vp-bw-karte vp-bw-umfang" aria-labelledby="bw-umfang" data-testid="bewertung-umfang">
            <div className="vp-bw-karte-kopf">
              <h2 id="bw-umfang">{UMFANG_TITEL}</h2>
              {verwalten && (
                <Button size="sm" variant="outline" onClick={() => setDialog('umfang')} data-testid="umfang-knopf">
                  {karte.gespeichert ? UMFANG_AENDERN : UMFANG_FESTLEGEN}
                </Button>
              )}
            </div>
            <p className="vp-bw-umfang-fassung" data-testid="umfang-fassung">
              {karte.kopf}
            </p>
            <ul className="vp-bw-umfang-standorte">
              {karte.standorte.map((s) => (
                <li key={s.id}>
                  <span>{s.name}</span>
                  <span className="vp-bw-leise">{s.anlagen}</span>
                </li>
              ))}
            </ul>
            <p className="vp-bw-leise" data-testid="umfang-anlagen">
              {karte.anlagen}
            </p>
            <p className="vp-bw-traeger">
              {karte.traeger.map((t) => (
                <Badge key={t} variant="tint">
                  {t}
                </Badge>
              ))}
            </p>
            {karte.ausschluesse.length > 0 && (
              <ul className="vp-bw-ausschluesse" data-testid="umfang-ausschluesse">
                {karte.ausschluesse.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
            {karte.akteur && <p className="vp-bw-leise">Festgelegt von {karte.akteur}</p>}
            {karte.teilansicht && <p className="vp-bw-leise">{karte.teilansicht}</p>}
          </section>

          {kriterienHinweis && <p className="vp-alert vp-alert-ok" role="status" data-testid="kriterien-hinweis">{kriterienHinweis}</p>}
          {rangliste && <RanglisteBereich
            rangliste={rangliste}
            zeitraum={zeitraum.label}
            historien={historien}
            darfEinstufen={einstufen}
            darfKriterien={kriterienAendern}
            onEinstufung={(id, f) => setHistorien((h) => ({ ...h, [id]: [f, ...(h[id] ?? [])] }))}
            onKriterien={(f) => {
              setKriterienHinweis(`Kriterien-Fassung ${f.fassung} gilt ab sofort für Rangliste und Vorschlag. Keine Einstufung ändert sich dadurch.`);
              setVersuch((v) => v + 1);
            }}
          />}

          {/* AP-16 IP-18 (G3, R8): Prüfaufgaben aus wesentlichen Einsätzen mit Messmitteln ohne Angabe. */}
          <Pruefaufgaben einsaetze={liste.filter((e) => istWesentlich(historien[e.id])).map((e) => ({ name: `${e.kennzeichen} ${e.name}`, messstellen: e.messstellen }))} />
          {/* AP-16 IP-18 (§5.3, R5): Messabdeckung je Einsatz und je Ort; ohne Einsatz steht nichts (R11). */}
          {liste.length > 0 && (
            <MessabdeckungTabelle
              von={zeitraum.von}
              bis={zeitraum.bis}
              zeitraum={zeitraum.label}
              version={planVersion}
              onRestErfassen={verwalten && liste.some((e) => laeuft(e) && e.traeger === 'Strom') ? setRest : undefined}
            />
          )}
          {/* AP-16 IP-20: die Messbedarfe aller Einsätze je Standort; gehandelt wird am Einsatz. */}
          {liste.length > 0 && <MessplanungStandorte einsaetze={liste} version={planVersion} onOeffnen={onOeffnen} />}

          <section className="vp-bw-einsaetze" aria-labelledby="bw-einsaetze">
            <h2 id="bw-einsaetze">{EINSAETZE_TITEL}</h2>
            {liste.length === 0 ? (
              <p className="vp-bw-leer" data-testid="bewertung-leer">
                {LEER}
              </p>
            ) : (
              <ul className="vp-bw-liste">
                {liste.map((e) => (
                  <li key={e.id}>
                    <EinsatzKarte zeile={einsatzZeile(e)} onOeffnen={() => onOeffnen(e.id)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <p className="vp-bw-grenze" data-testid="bewertung-grenze">{UEMS_NORMGRENZE}</p>

      {dialog === 'umfang' && umfang && (
        <UmfangDialog
          umfang={umfang}
          onClose={() => setDialog(null)}
          onGespeichert={(u) => {
            setUmfang(u);
            setDialog(null);
          }}
        />
      )}
      {rest && liste && (
        <MessbedarfErfassenDialog
          einsaetze={liste.filter((e) => laeuft(e) && e.traeger === 'Strom')}
          rest={rest}
          onClose={() => setRest(null)}
          onErfasst={() => {
            setRest(null);
            setPlanVersion((v) => v + 1);
          }}
        />
      )}
      {dialog === 'anlegen' && liste && (
        <EnergieeinsatzAnlegenDialog
          einsaetze={liste}
          onClose={() => setDialog(null)}
          onAngelegt={(e) => {
            setDialog(null);
            setListe((l) => [...(l ?? []), e]);
            onOeffnen(e.id);
          }}
        />
      )}
    </div>
  );
}

function EinsatzKarte({ zeile, onOeffnen }: { zeile: EinsatzZeile; onOeffnen: () => void }) {
  return (
    <button type="button" className={`vp-bw-einsatz${zeile.laeuft ? '' : ' is-beendet'}`} data-testid="einsatz-karte" onClick={onOeffnen}>
      <span className="vp-bw-einsatz-kopf">
        <span className="vp-bw-kz">{zeile.kennzeichen}</span>
        <Badge variant="tint">{zeile.traeger}</Badge>
        {zeile.keineWerte && <Badge variant="off">{KEINE_WERTE}</Badge>}
        <span className="vp-bw-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-bw-einsatz-name">{zeile.name}</span>
      <span className="vp-bw-leise">
        {zeile.prozess} · {zeile.messstellen}
      </span>
      <span className="vp-bw-leise">
        {zeile.verantwortlich} · {zeile.zustand}
      </span>
    </button>
  );
}
