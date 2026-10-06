import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError, api, type EnergiemanagementDokument, type Feststellung } from '../api';
import { AnwendungsbereichVergleich } from '../components/AnwendungsbereichVergleich';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import {
  AufhebenBlatt,
  BekanntmachenBlatt,
  BestaetigenBlatt,
  FassungenBlatt,
  FreigebenBlatt,
  GrundBlatt,
  NeuFassenBlatt,
  OriginalBlatt,
  OriginalKnoepfe,
  UeberpruefungBlatt,
  WortlautBlatt,
} from '../components/nachweisen/DokumentBlaetter';
import { ErklaerKnopf } from '../components/nachweisen/ErklaerKnopf';
import { NwBlatt } from '../components/nachweisen/NwBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { StatusZeile } from '../components/nachweisen/NwStatus';
import { Wortlaut } from '../components/nachweisen/NwSchritte';
import { NwZeichen } from '../components/nachweisen/NwZeichen';
import { Fakt, NwKarte, NwZeile, NwZeilen } from '../components/nachweisen/NwZeilen';
import { Stufen } from '../components/nachweisen/Stufen';
import { seitenLink } from '../components/nachweisen/teilen';
import { Weitergeben } from '../components/nachweisen/Weitergeben';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ErrorState, Skeleton } from '../components/States';
import * as E from '../energiemanagementPortal';
import * as N from '../nachweisDokumente';
import { dokumentRoute, hashForRoute } from '../nav';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import '../components/nachweisen/NwDokumente.css';

type Blatt = 'neu' | 'freigeben' | 'bestaetigen' | 'bekannt' | 'pruefen' | 'aufheben' | 'wortlaut' | 'fassungen' | 'original' | 'grund' | 'geltung' | 'wer';

/**
 * Die Seite eines Dokuments (Konzept Nachweisen n1, Runde 2, §6.5; Entscheide 10 bis 12, 24, 25): Kopf mit Titel des
 * Kunden, i-Knopf („Was ist eine Fassung?“), Kurzzeile „Fassung 2“ und der Status-Zeile „● gilt · Robert Falk“; Stufen
 * „Entwurf · Freigegeben · Bekannt · Prüfen“ mit Tag; ein Hauptknopf nur mit Anlass (Entwurf wartet, Antrag wartet auf
 * Sie, Prüfung überfällig); am Handy „Neu in Fassung 2“ mit dem neuen Satz und Zeilen statt Karten, am Rechner der
 * ganze Wortlaut links und rechts Stufen, Weitergeben und der Kasten „Stand“. Alles andere im Menü „…“ - auch das
 * Kennzeichen (Entscheid 25). Erklärt wird nur auf Antippen.
 *
 * Konzept Wiedervorlage w1: der Schritt „Bestätigen oder neu fassen“ öffnet die Seite mit `?entscheid=
 * dokument_ueberpruefung`; der Block mit `data-entscheid` trägt dann „Prüfen“ als ersten Knopf.
 */
export function DokumentSeite({ id, onListe, onFeststellung }: { id: string; onListe: () => void; onFeststellung?: (id: string) => void }) {
  const rollen = useRollen();
  const isPhone = useIsPhone();
  const [d, setD] = useState<EnergiemanagementDokument | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [vierAugen, setVierAugen] = useState<boolean | null>(null);
  const [feststellungen, setFeststellungen] = useState<Feststellung[]>([]);
  const [blatt, setBlatt] = useState<Blatt | null>(null);
  const [freigabeNr, setFreigabeNr] = useState<number | null>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementDokument(id).then(
      (r) => aktiv && setD(r),
      (e) => aktiv && setFehler(e instanceof ApiError && e.status === 404 ? { satz: N.DOKUMENT_FEHLT, erneut: false } : { satz: N.DOKUMENT_LADEFEHLER, erneut: true }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);
  useEffect(() => {
    let aktiv = true;
    api.unternehmenVierAugen().then(
      (v) => aktiv && setVierAugen(v.vieraugen),
      () => aktiv && setVierAugen(null),
    );
    api.energiemanagementFeststellungen().then(
      (r) => aktiv && setFeststellungen(r.feststellungen.filter((f) => f.vorgabe.dokument_id === id || f.bezug.dokument_id === id)),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [id]);

  const zurueck = { label: N.ALLE_DOKUMENTE, onClick: onListe };
  if (!d) {
    return (
      <div className="vp-nw-seite" data-testid="dokument-seite">
        <NwKopf titel={N.DOKUMENTE_TITEL} zurueck={zurueck} />
        {fehler ? (
          fehler.erneut ? (
            <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
          ) : (
            <p className="vp-nw-leise" role="status">
              {fehler.satz}
            </p>
          )
        ) : (
          <div aria-busy="true" aria-label="Dokument wird geladen">
            <Skeleton height={64} />
            <Skeleton height={120} />
          </div>
        )}
      </div>
    );
  }

  const standort = d.bezug.standort?.id ?? null;
  const darfVerwalten = rollen.darf(E.RECHT_VERWALTEN, standort);
  const darfFreigeben = rollen.darf(E.RECHT_FREIGEBEN, standort);
  const g = N.gueltigeFassung(d);
  const o = N.offeneFassung(d);
  const gezeigt = g ?? o ?? d.fassungen[d.fassungen.length - 1] ?? null;
  const status = N.seitenStatus(d);
  const stufen = N.stufen(d);
  const anlass = N.anlass(d, rollen.selbst?.kennung ?? null);
  const original = N.originalBild(d, gezeigt);
  const vorige = gezeigt ? N.vorigeFassung(d, gezeigt) : null;
  const wortlaut = gezeigt?.form === 'wortlaut' ? N.wortlautMitNeuem(vorige?.form === 'wortlaut' ? (vorige.wortlaut ?? null) : null, gezeigt.wortlaut ?? '') : null;
  const grund = gezeigt ? N.grundKurz(gezeigt) : null;
  const aufgehoben = d.zustand === 'aufgehoben';
  const bekannt = g ? N.bekanntmachungen(d.eintraege).find((b) => b.fassung === g.nr) : null;
  const geltung = N.geltungKurz(gezeigt);
  const offeneFeststellungen = feststellungen.filter((f) => f.zustand === 'offen');

  const gespeichert = (neu: EnergiemanagementDokument) => {
    setBlatt(null);
    setFreigabeNr(null);
    setD(neu);
  };
  // Nach einer Freigabe fragt VoltPilot, ob Sie die neue Fassung bekannt machen (Energiepolitik und wo schon bekannt gemacht).
  const freigegeben = (neu: EnergiemanagementDokument) => {
    const jetzt = N.gueltigeFassung(neu);
    gespeichert(neu);
    if (jetzt && jetzt.nr !== g?.nr && darfVerwalten && N.stufen(neu).some((s) => s.titel === 'Bekannt' && s.zustand !== 'done')) setBlatt('bekannt');
  };

  const menue: RowMenuItem[] = aufgehoben
    ? []
    : [
        ...(darfVerwalten && o?.status !== 'beantragt' ? [{ label: o ? `Entwurf ${o.nr} bearbeiten` : 'Neu fassen', icon: 'pencil' as const, onClick: () => setBlatt('neu') }] : []),
        ...(darfFreigeben && g && d.klasse === 'vorgabe' ? [{ label: 'Überprüfung festhalten', icon: 'calendar' as const, onClick: () => setBlatt('pruefen') }] : []),
        ...(darfVerwalten && g ? [{ label: 'Bekannt machen', icon: 'users' as const, onClick: () => setBlatt('bekannt') }] : []),
        ...(original ? [{ label: 'Original prüfen', icon: 'lock' as const, onClick: () => setBlatt('original') }] : []),
        { label: `Kennzeichen ${d.kennzeichen} kopieren`, icon: 'link' as const, onClick: () => void navigator.clipboard?.writeText(d.kennzeichen) },
        ...(darfFreigeben ? [{ label: 'Aufheben', icon: 'trash' as const, danger: true, onClick: () => setBlatt('aufheben') }] : []),
      ];

  // Der Hauptknopf nur mit Anlass; ohne Recht statt des Knopfs, wer es kann - Grund und Weg im Erklär-Blatt (§6.13).
  const wer = rollen.selbst?.kundenadministratoren?.[0]?.name ?? null;
  const ohneRecht = (verb: string) => (
    <p className="vp-nw-leise vp-nw-ohne-recht" data-testid="dokument-ohne-recht">
      {verb}: {wer ?? 'eine berechtigte Person'}
      <ErklaerKnopf klein erklaerung={{ frage: 'Wer darf das?', klartext: rollen.grund, nichtVerwechseln: null, fachwort: null }} />
    </p>
  );
  const anlassKnopf =
    anlass?.art === 'freigeben' ? (
      darfFreigeben ? (
        <Button onClick={() => setBlatt('freigeben')} data-testid="dokument-freigeben">
          {vierAugen ? 'Freigabe beantragen' : `Fassung ${anlass.fassung} freigeben`}
        </Button>
      ) : (
        ohneRecht('Freigeben')
      )
    ) : anlass?.art === 'bestaetigen' ? (
      darfFreigeben ? (
        <Button onClick={() => setBlatt('bestaetigen')} data-testid="dokument-bestaetigen">
          Bestätigen oder ablehnen
        </Button>
      ) : (
        ohneRecht('Bestätigen')
      )
    ) : null;
  // Der Entscheid der Wiedervorlage (Konzept w1): „Prüfen“ ist der erste Knopf im Block.
  const pruefKnopf =
    !aufgehoben && d.klasse === 'vorgabe' && g ? (
      darfFreigeben ? (
        <Button variant={anlass?.art === 'pruefen' ? 'primary' : 'outline'} onClick={() => setBlatt('pruefen')} data-testid="dokument-pruefen">
          Prüfen
        </Button>
      ) : null
    ) : null;

  const zeilen = (
    <NwZeilen label="Zum Dokument" testId="dokument-zeilen">
      {!isPhone && g?.entschieden_von && <NwZeile titel="Freigegeben" rechts={<Fakt>{g.entschieden_von.name}</Fakt>} testId="zeile-freigegeben" />}
      {!isPhone && g?.freigabe && <NwZeile titel="Eingetragen" rechts={<Fakt>{g.freigabe.akteur.name}</Fakt>} testId="zeile-eingetragen" />}
      {!isPhone && bekannt && <NwZeile titel="Bekannt gemacht" rechts={<Fakt>{bekannt.kreis}</Fakt>} onClick={() => setBlatt('fassungen')} testId="zeile-bekannt" />}
      {isPhone && gezeigt?.form === 'wortlaut' && <NwZeile titel={wortlaut && wortlaut.neueSaetze.length ? 'Ganzer Wortlaut' : 'Wortlaut'} onClick={() => setBlatt('wortlaut')} testId="zeile-wortlaut" />}
      {geltung && <NwZeile titel="Geltung" rechts={<Fakt>{geltung}</Fakt>} onClick={() => setBlatt('geltung')} testId="zeile-geltung" />}
      <NwZeile titel="Fassungen" rechts={<Fakt>{d.fassungen.length}</Fakt>} onClick={() => setBlatt('fassungen')} testId="zeile-fassungen" />
      {original && !original.verweis && <NwZeile titel="Original" rechts={<Fakt>{N.ortKurz(original.ablage)}</Fakt>} onClick={() => setBlatt('original')} testId="zeile-original" />}
      {offeneFeststellungen.map((f) => (
        <NwZeile
          key={f.id}
          vorn={<NwZeichen art={f.lage.tage !== null && f.lage.tage > 0 ? 'ueber' : 'offen'} />}
          titel="Feststellung"
          rechts={<Fakt warn={f.lage.tage !== null && f.lage.tage > 0}>{f.lage.tage !== null && f.lage.tage > 0 ? 'überfällig' : 'offen'}</Fakt>}
          warn={f.lage.tage !== null && f.lage.tage > 0}
          onClick={onFeststellung ? () => onFeststellung(f.id) : undefined}
          testId={`zeile-feststellung-${f.kennzeichen}`}
        />
      ))}
    </NwZeilen>
  );

  const fussnote =
    gezeigt && grund ? (
      <button type="button" className="vp-nw-fussnote" onClick={() => setBlatt('grund')} data-testid="dokument-grund">
        <Icon name="info" size={14} />
        {!isPhone && wortlaut?.neueSaetze.length ? `Neu in Fassung ${gezeigt.nr} (hinterlegt) · ` : ''}Grund: {grund}
      </button>
    ) : null;

  // Am Handy nur der neue Satz („Neu in Fassung 2“), am Rechner der ganze Wortlaut mit dem Neuen hinterlegt.
  const inhalt =
    gezeigt?.form === 'wortlaut' && wortlaut ? (
      isPhone ? (
        wortlaut.neueSaetze.length > 0 ? (
          <NwKarte titel={`Neu in Fassung ${gezeigt.nr}`} testId="dokument-neu">
            <Wortlaut absaetze={[wortlaut.neueSaetze.map((t, i) => ({ text: i < wortlaut.neueSaetze.length - 1 ? `${t} ` : t, neu: true }))]} />
            {fussnote}
          </NwKarte>
        ) : null
      ) : (
        <NwKarte titel="Wortlaut" zahl={`Fassung ${gezeigt.nr}`} testId="dokument-wortlaut">
          <Wortlaut absaetze={wortlaut.absaetze} label={`Wortlaut der Fassung ${gezeigt.nr}`} />
          {fussnote}
        </NwKarte>
      )
    ) : original?.verweis ? (
      <NwKarte titel="Original" testId="dokument-original">
        <div className="vp-nw-original">
          <span className="vp-nw-original-l">Geführt in</span>
          <b>{original.ablage}</b>
          {(original.kennung || original.stand) && <span className="vp-nw-leise">{[original.kennung, original.stand].filter(Boolean).join(' · ')}</span>}
        </div>
        <OriginalKnoepfe original={original} id={`dok-${d.id}`} rechnet={false} onDatei={() => setBlatt('original')} />
        {fussnote}
      </NwKarte>
    ) : null;

  return (
    <GrenzSatzBereich>
      <div className="vp-nw-seite vp-nw-dok" data-testid="dokument-seite">
        <NwKopf
          zurueck={zurueck}
          titel={d.titel}
          kennzeichen={d.kennzeichen}
          erklaerung={N.fassungErklaerung(d)}
          kurzzeile={isPhone ? N.kurzzeile(d) : [N.kurzzeile(d), E.bezugWort(d.bezug)].join(' · ')}
          status={<StatusZeile zeichen={<NwZeichen art={status.zeichen} />} text={status.text} sub={status.sub} warn={status.warn} testId="dokument-status" />}
          menue={menue.length > 0 ? <RowMenu label="Weitere Aktionen" items={menue} /> : null}
          testId="dokument-kopf"
        />
        <div className="vp-nw-dok-raster">
          <div className="vp-nw-dok-a">
            {stufen.length > 0 && <Stufen stufen={stufen} testId="dokument-stufen" />}
            {(anlassKnopf || pruefKnopf) && (
              <div className="vp-nw-aktionen" data-entscheid="dokument_ueberpruefung" data-testid="dokument-aktionen">
                {anlass?.art === 'pruefen' ? pruefKnopf : anlassKnopf}
                {anlass?.art !== 'pruefen' && !isPhone && pruefKnopf}
              </div>
            )}
            <Weitergeben
              knoepfe={!isPhone && darfVerwalten && !aufgehoben && o?.status !== 'beantragt' ? [{ symbol: 'pencil', text: o ? 'Entwurf bearbeiten' : 'Neu fassen', onClick: () => setBlatt('neu'), testId: 'dokument-neu-fassen' }] : []}
              teilenLink={{ titel: d.titel, url: seitenLink(hashForRoute(dokumentRoute(d.id))) }}
              testId="dokument-weitergeben"
            />
          </div>
          {inhalt && <div className="vp-nw-dok-b">{inhalt}</div>}
          <div className="vp-nw-dok-c">{isPhone ? zeilen : <NwKarte titel="Stand">{zeilen}</NwKarte>}</div>
        </div>
        <GrenzHinweis />
      </div>
      {blatt === 'neu' && (
        <NeuFassenBlatt
          dokument={d}
          vierAugen={vierAugen}
          onClose={() => setBlatt(null)}
          onGespeichert={gespeichert}
          onFreigeben={(neu, nr) => {
            setD(neu);
            setFreigabeNr(nr);
            setBlatt('freigeben');
          }}
        />
      )}
      {blatt === 'freigeben' && (() => {
        const f = d.fassungen.find((x) => x.nr === (freigabeNr ?? o?.nr)) ?? o;
        return f ? <FreigebenBlatt dokument={d} fassung={f} vierAugen={vierAugen} onClose={() => setBlatt(null)} onGespeichert={freigegeben} /> : null;
      })()}
      {blatt === 'bestaetigen' && o && <BestaetigenBlatt dokument={d} fassung={o} onClose={() => setBlatt(null)} onGespeichert={freigegeben} />}
      {blatt === 'bekannt' && <BekanntmachenBlatt dokument={d} onClose={() => setBlatt(null)} onGespeichert={gespeichert} />}
      {blatt === 'pruefen' && <UeberpruefungBlatt dokument={d} onClose={() => setBlatt(null)} onGespeichert={gespeichert} onNeuFassen={() => setBlatt('neu')} />}
      {blatt === 'aufheben' && <AufhebenBlatt dokument={d} onClose={() => setBlatt(null)} onGespeichert={gespeichert} />}
      {blatt === 'wortlaut' && gezeigt && <WortlautBlatt dokument={d} fassung={gezeigt} onClose={() => setBlatt(null)} />}
      {blatt === 'fassungen' && <FassungenBlatt dokument={d} onClose={() => setBlatt(null)} />}
      {blatt === 'original' && original && <OriginalBlatt original={original} onClose={() => setBlatt(null)} />}
      {blatt === 'grund' && gezeigt && <GrundBlatt fassung={gezeigt} onClose={() => setBlatt(null)} />}
      {blatt === 'geltung' && gezeigt?.anwendungsbereich && (
        <NwBlatt open titel="Geltung" onClose={() => setBlatt(null)} breit testId="geltung-blatt">
          <div className="vp-nw-schritt-inhalt">
            <NwZeilen>
              <NwZeile titel="Standorte" unter={gezeigt.anwendungsbereich.standorte.map((s) => s.name ?? s.kurzzeichen).join(', ')} />
              <NwZeile titel="Energieträger" unter={gezeigt.anwendungsbereich.traeger.join(', ')} />
              <NwZeile titel="Ausschlüsse" unter={gezeigt.anwendungsbereich.ausschluesse.length ? gezeigt.anwendungsbereich.ausschluesse.map((a) => a.begruendung).join(' · ') : 'keine'} />
            </NwZeilen>
            {g && <AnwendungsbereichVergleich dokumentId={d.id} stand={g.nr} />}
          </div>
        </NwBlatt>
      )}
    </GrenzSatzBereich>
  );
}
