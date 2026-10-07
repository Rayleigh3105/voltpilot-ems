import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type BerichtDetail, type BerichtEntwurf, type BerichtStand, type Managementbewertung, type ManagementbewertungBeschluss } from '../api';
import { EinsichtRecht } from '../components/EinsichtRecht';
import { GrenzHinweis, GrenzSatz, GrenzSatzBereich } from '../components/GrenzSatz';
import { ManagementbewertungEingaben } from '../components/ManagementbewertungEingaben';
import { FolgeDialog } from '../components/ManagementbewertungDialoge';
import { ManagementbewertungVorbereiten } from '../components/ManagementbewertungVorbereiten';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import { FolgenBalken } from '../components/nachweisen/FolgenBalken';
import { NwBlatt } from '../components/nachweisen/NwBlatt';
import { NwKopf } from '../components/nachweisen/NwKopf';
import { HinweisZeile, PruefZeilen } from '../components/nachweisen/NwSchritte';
import { StatusZeile, ZustandsZeichen } from '../components/nachweisen/NwStatus';
import { NwSymbol } from '../components/nachweisen/NwSymbol';
import { NwZeichen } from '../components/nachweisen/NwZeichen';
import { Fakt, Kuerzel, Nummer, NwKarte, NwZeile, NwZeilen, ZeilenZustand } from '../components/nachweisen/NwZeilen';
import { Stufen } from '../components/nachweisen/Stufen';
import { Weitergeben } from '../components/nachweisen/Weitergeben';
import { RowMenu } from '../components/RowMenu';
import * as E from '../energiemanagementPortal';
import * as M from '../managementbewertung';
import * as B from '../managementbewertungBild';
import { auditRoute, dokumentRoute, hashForRoute, massnahmeRoute } from '../nav';
import { useRollen } from '../rollen';
import { merkeAugenblick, routenHeute, tagDesAugenblicks } from '../routenUhr';
import { useIsPhone } from '../useIsPhone';
import '../components/nachweisen/NwZeilen.css';
import './Energiemanagement.css';

type Blatt = null | 'sitzung' | 'eingaben' | 'staende' | { beschluss: number } | { eingabe: string };
type Titel = { dokumente: Record<string, string>; massnahmen: Record<string, string> };

/**
 * Die Seite einer Managementbewertung (Konzept Nachweisen n1 Runde 2, §6.7, Mocks r2-M2, r2d-M2, MBV; vorher UEMS AP-19
 * IP-24, MG1–MG7): Kopf mit „Sitzung 12.02.2029 · Robert Falk“ und „● Stand 1 gilt“, der Folgen-Balken, PDF oben, die
 * Beschlüsse als Zeilen mit Kurztitel und ihrer Folge (erledigt mit Tag, läuft, ohne Folge) - der Wortlaut, die Folgen,
 * „Folge verknüpfen“ und „Maßnahme anlegen“ im Blatt des Beschlusses -, dann „Sitzung · 5 Personen“ und „Was die Leitung
 * sah · 10 Teile“ als Zeilen. Am Rechner links die Beschlüsse, rechts Folgen, Weitergeben und der Kasten „Sitzung“.
 *
 * Im Entwurf stehen die Stufen „Eingaben · Sitzung · Beschlüsse · Freigeben“ und „Vorbereiten“ öffnet das geführte Blatt
 * (`ManagementbewertungVorbereiten`). Die Seite ist ein Bericht der Vorlage `managementbewertung`: der Abzug eines Stands
 * ist das Dokument, nichts wird nachgebaut oder neu gerechnet; jeder PDF-Abruf wird protokolliert.
 */
export function ManagementbewertungSeite({
  kennung,
  onListe,
  heute = routenHeute,
}: {
  kennung: string;
  onListe: () => void;
  /** Nur für Tests; sonst der Tag der Route (Konzept Nachweisen n1, Befund 3), den die Seite beim Laden merkt. */
  heute?: () => string;
}) {
  const rollen = useRollen();
  const isPhone = useIsPhone();
  const verwalten = rollen.darf(E.RECHT_VERWALTEN, null);
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [entwurf, setEntwurf] = useState<BerichtEntwurf | null>(null);
  const [stand, setStand] = useState<BerichtStand | null>(null);
  const [mb, setMb] = useState<Managementbewertung | null>(null);
  const [titel, setTitel] = useState<Titel>({ dokumente: {}, massnahmen: {} });
  const [fehler, setFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [blatt, setBlatt] = useState<Blatt>(null);
  const [vorbereiten, setVorbereiten] = useState<B.VorbereitenSchritt | null>(null);
  const [folge, setFolge] = useState<ManagementbewertungBeschluss | null>(null);
  const [abruf, setAbruf] = useState<{ satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState<number | null>(null);
  const [kopiert, setKopiert] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.bericht(kennung), api.managementbewertung(kennung)]).then(
      async ([d, m]) => {
        if (!aktiv) return;
        merkeAugenblick(d.abruf, d.bericht.zeitzone);
        setDetail(d);
        setMb(m);
        const g = M.gueltigerStand(d.staende);
        const [e, s] = await Promise.all([
          d.bericht.archiviert_am === null && !g ? api.berichtEntwurf(kennung).catch(() => null) : Promise.resolve(null),
          g ? api.berichtStand(kennung, g.nr).catch(() => null) : Promise.resolve(null),
        ]);
        if (!aktiv) return;
        setEntwurf(e);
        setStand(s);
      },
      (e) => aktiv && setFehler(E.ablehnungSatz(e) || M.LADEFEHLER),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, versuch]);

  // Die Namen hinter den Kennzeichen der Folgen (Entscheid 25: ein Kennzeichen ist kein Titel); fehlt ein Recht, bleibt
  // der Wortlaut des Beschlusses sein Titel.
  useEffect(() => {
    let aktiv = true;
    api.energiemanagementDokumente().then(
      (r) => aktiv && setTitel((t) => ({ ...t, dokumente: Object.fromEntries(r.dokumente.map((d) => [d.kennzeichen, d.titel])) })),
      () => undefined,
    );
    api.massnahmen().then(
      (r) => aktiv && setTitel((t) => ({ ...t, massnahmen: Object.fromEntries(r.massnahmen.map((m) => [m.kennzeichen, m.titel])) })),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  /** Eine Eingabe (Sitzung, Beschluss, Folge) ist gespeichert - der Entwurf ist neu gebildet, die Seite liest neu. */
  const neu = (m: Managementbewertung) => {
    setMb(m);
    setVersuch((v) => v + 1);
  };

  async function pdf(nr: number) {
    setLaeuft(nr);
    setAbruf(null);
    try {
      const blob = await api.berichtDatei(kennung, nr, 'pdf');
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${kennung}-stand-${nr}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 0);
      setAbruf({ satz: 'PDF abgerufen, der Abruf ist protokolliert.', fehler: false });
    } catch {
      setAbruf({ satz: M.PDF_FEHLER, fehler: true });
    } finally {
      setLaeuft(null);
    }
  }

  const b = detail?.bericht ?? null;
  const zone = b?.zeitzone ?? 'Europe/Berlin';
  const gueltig = detail ? M.gueltigerStand(detail.staende) : null;
  const freigegeben = !!gueltig || !!mb?.freigegeben;
  const zeigt = stand ? M.abzug(stand.abzug) : entwurf ? M.abzug(entwurf.abzug) : null;
  const eingaben = zeigt ? B.eingabenZeilen(zeigt) : null;
  const sitzung = mb?.sitzung ?? null;
  const personen = sitzung ? B.sitzungPersonen(sitzung) : [];
  const beschluesse = mb ? [...mb.beschluesse].sort((x, y) => x.nr - y.nr) : [];
  const offen = blatt && typeof blatt === 'object' && 'beschluss' in blatt ? (beschluesse.find((x) => x.nr === blatt.beschluss) ?? null) : null;
  const eingabe = blatt && typeof blatt === 'object' && 'eingabe' in blatt ? (eingaben?.find((z) => z.key === blatt.eingabe) ?? null) : null;

  if (fehler || !detail || !b || !mb) {
    return (
      <GrenzSatzBereich>
        <div className="vp-nw-seite" data-testid="managementbewertung-seite">
          <NwKopf titel="Managementbewertung" zurueck={{ label: M.ZUR_LISTE, onClick: onListe }} testId="mb-kopf" />
          {fehler ? (
            <p className="vp-ez-fehler" role="alert">
              {fehler}
            </p>
          ) : (
            <p className="vp-ez-leise">Wird geladen …</p>
          )}
        </div>
      </GrenzSatzBereich>
    );
  }

  const status = B.mbStatus({ freigegeben, stand_nr: gueltig?.nr ?? mb.stand_nr });
  const menue = (
    <RowMenu
      label="Weitere Aktionen"
      items={[
        {
          label: kopiert ? `${b.kennung} kopiert` : `Kennzeichen ${b.kennung}`,
          onClick: () => void navigator.clipboard?.writeText(b.kennung).then(() => setKopiert(true), () => undefined),
        },
        ...(detail.staende.length ? [{ label: M.STAENDE, onClick: () => setBlatt('staende') }] : []),
        ...(!freigegeben ? [{ label: B.KNOPF_VORBEREITEN, recht: E.RECHT_VERWALTEN, standort: null, onClick: () => setVorbereiten(B.vorbereitenStart(mb)) }] : []),
      ]}
    />
  );

  const weitergeben = gueltig && (
    <>
      <Weitergeben
        knoepfe={[{ symbol: 'speichern', text: M.KNOPF_PDF, onClick: () => void pdf(gueltig.nr), laeuft: laeuft !== null, testId: `mb-pdf-${gueltig.nr}` }]}
        testId="mb-weitergeben"
      />
      {abruf && (
        <p className={abruf.fehler ? 'vp-nw-feld-fehler' : 'vp-nw-leise'} role="status" data-testid="mb-abruf">
          {abruf.satz}
        </p>
      )}
    </>
  );

  const beschluesseKarte = (
    <NwKarte titel={M.BESCHLUESSE} zahl={beschluesse.length} testId="mb-beschluesse">
      {beschluesse.length === 0 ? (
        <p className="vp-nw-leise">{M.LEER.beschluesse}</p>
      ) : (
        <NwZeilen>
          {beschluesse.map((x) => {
            const z = B.beschlussZustand(x);
            return (
              <NwZeile
                key={x.nr}
                vorn={<Nummer nr={x.nr} />}
                titel={B.beschlussKurz(x, titel)}
                kurz
                rechts={
                  freigegeben ? (
                    <ZeilenZustand zeichen={<ZustandsZeichen art={z.art} stumm />} ton={z.art === 'ohne' ? 'leise' : undefined}>
                      {z.wort}
                    </ZeilenZustand>
                  ) : (
                    <Fakt>{B.BESCHLUSS_CHIP[x.art] ?? x.art}</Fakt>
                  )
                }
                onClick={() => setBlatt({ beschluss: x.nr })}
                testId={`mb-beschluss-${x.nr}`}
              />
            );
          })}
        </NwZeilen>
      )}
    </NwKarte>
  );

  const eingabenZeile = (
    <NwZeile
      titel={B.WAS_DIE_LEITUNG_SAH}
      rechts={eingaben ? <Fakt>{B.teileZahl(eingaben.length)}</Fakt> : undefined}
      onClick={() => setBlatt('eingaben')}
      testId="mb-eingaben-zeile"
    />
  );

  return (
    <GrenzSatzBereich>
      <div className="vp-nw-seite" data-testid="managementbewertung-seite">
        <NwKopf
          titel={`Managementbewertung ${b.zeitraum}`}
          kennzeichen={b.kennung}
          zurueck={{ label: M.ZUR_LISTE, onClick: onListe }}
          erklaerung={B.erklaerungManagementbewertung(mb)}
          kurzzeile={B.mbKurzzeile({ sitzung, freigegeben })}
          status={freigegeben ? <StatusZeile zeichen={<NwZeichen art={status.zeichen} />} text={status.text} testId="mb-status" /> : undefined}
          menue={menue}
          testId="mb-kopf"
        />

        <div className="vp-nw-zwei">
          <div className="vp-nw-spalte-seite">
            {freigegeben ? (
              <>
                {isPhone ? (
                  <FolgenBalken zustaende={B.folgenZustaende(mb)} testId="mb-folgen" />
                ) : (
                  <NwKarte titel={M.FOLGEN} testId="mb-folgen-karte">
                    <FolgenBalken zustaende={B.folgenZustaende(mb)} testId="mb-folgen" />
                  </NwKarte>
                )}
                {weitergeben}
              </>
            ) : (
              <>
                <Stufen stufen={B.mbStufen(mb, entwurf ? tagDesAugenblicks(entwurf.datenstand, zone) : null)} testId="mb-stufen" />
                {!b.archiviert_am && (
                  <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                    <div className="vp-nw-aktionen">
                      <Button onClick={() => setVorbereiten(B.vorbereitenStart(mb))} data-testid="mb-vorbereiten-knopf">
                        {sitzung ? B.KNOPF_WEITER_VORBEREITEN : B.KNOPF_VORBEREITEN}
                      </Button>
                    </div>
                  </EinsichtRecht>
                )}
              </>
            )}
          </div>
          <div className="vp-nw-spalte-haupt">{beschluesseKarte}</div>
          <div className="vp-nw-spalte-mehr">
            {isPhone ? (
              <NwZeilen testId="mb-angaben">
                <NwZeile
                  titel={M.SITZUNG}
                  rechts={<Fakt>{sitzung ? B.personenZahl(personen.length) : 'fehlt'}</Fakt>}
                  onClick={() => setBlatt('sitzung')}
                  testId="mb-sitzung-zeile"
                />
                {eingabenZeile}
              </NwZeilen>
            ) : (
              <NwKarte titel={M.SITZUNG} testId="mb-angaben">
                <NwZeilen>
                  <NwZeile titel="Tag" rechts={<Fakt>{sitzung ? E.tagText(sitzung.tag) : 'fehlt'}</Fakt>} onClick={() => setBlatt('sitzung')} testId="mb-sitzung-zeile" />
                  {sitzung && (
                    <NwZeile titel={M.LEITUNG} rechts={<Fakt warn={!sitzung.leitung_gilt}>{sitzung.leitung.name ?? '–'}</Fakt>} onClick={() => setBlatt('sitzung')} />
                  )}
                  {sitzung && sitzung.teilnehmende.length > 0 && (
                    <NwZeile
                      titel={M.TEILNEHMENDE}
                      rechts={<Kuerzel personen={sitzung.teilnehmende.filter((p) => p.name).map((p) => ({ name: p.name! }))} />}
                      onClick={() => setBlatt('sitzung')}
                    />
                  )}
                  {eingabenZeile}
                </NwZeilen>
              </NwKarte>
            )}
          </div>
        </div>
        <GrenzSatz verantwortung />
        <GrenzHinweis />

        {/* Ein Beschluss: Wortlaut, wer entschieden hat, seine Folgen - und was man daraus macht. */}
        <NwBlatt open={!!offen} titel={offen ? `Beschluss ${offen.nr}` : ''} onClose={() => setBlatt(null)} testId="mb-beschluss-blatt">
          {offen && (
            <div className="vp-nw-schritt-inhalt">
              <blockquote className="vp-nw-zitat" data-testid="mb-beschluss-wortlaut">
                {offen.wortlaut}
              </blockquote>
              <PruefZeilen
                zeilen={[
                  { etikett: M.ENTSCHIEDEN_VON.replace(/ von$/, ''), wert: offen.entschieden_von.name ?? '–' },
                  ...(offen.zustaendig?.name ? [{ etikett: 'Wer', wert: offen.zustaendig.name }] : []),
                  ...(offen.termin ? [{ etikett: 'Bis', wert: E.tagText(offen.termin) }] : []),
                ]}
              />
              {freigegeben && (
                <>
                  {offen.folgen.length > 0 ? (
                    <NwZeilen label={M.FOLGEN} testId={`mb-folgen-${offen.nr}`}>
                      {offen.folgen.map((f) => {
                        const ziel = f.objekt_id
                          ? f.art === 'dokument'
                            ? dokumentRoute(f.objekt_id)
                            : f.art === 'massnahme'
                              ? massnahmeRoute(f.objekt_id)
                              : f.art === 'audit'
                                ? auditRoute(f.objekt_id)
                                : null
                          : null;
                        return (
                          <NwZeile
                            key={`${f.art}/${f.objekt}/${f.wie}`}
                            vorn={<ZustandsZeichen art={B.folgeZustand(f)} stumm />}
                            titel={B.folgeKurz(f, titel)}
                            rechts={<Fakt>{M.zustandWort(f.zustand)}</Fakt>}
                            {...(ziel ? { href: hashForRoute(ziel) } : {})}
                            testId={`mb-folge-${offen.nr}-${f.objekt}`}
                          />
                        );
                      })}
                    </NwZeilen>
                  ) : (
                    <p className="vp-nw-leise" data-testid={`mb-ohne-folge-${offen.nr}`}>
                      {offen.satz ?? 'Ohne Folge in VoltPilot.'}
                    </p>
                  )}
                  <div className="vp-nw-blatt-zeile vp-nw-aktionen">
                    <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setBlatt(null);
                          setFolge(offen);
                        }}
                        data-testid={`mb-folge-knopf-${offen.nr}`}
                      >
                        {M.KNOPF_FOLGE}
                      </Button>
                    </EinsichtRecht>
                    {verwalten && (
                      <MassnahmeAnlegen
                        vorbelegung={{ herkunft: 'managementbewertung', herkunftKennung: offen.kennung, titel: offen.wortlaut.slice(0, 120) }}
                        standort={null}
                        onAngelegt={() => {
                          setBlatt(null);
                          setVersuch((v) => v + 1);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
              {!freigegeben && (
                <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                  <div className="vp-nw-blatt-zeile">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBlatt(null);
                        setVorbereiten('pruefen');
                      }}
                      data-testid={`mb-beschluss-aendern-${offen.nr}`}
                    >
                      {M.KNOPF_BESCHLUSS_AENDERN}
                    </Button>
                  </div>
                </EinsichtRecht>
              )}
            </div>
          )}
        </NwBlatt>

        <NwBlatt open={blatt === 'sitzung'} titel={M.SITZUNG} onClose={() => setBlatt(null)} testId="mb-sitzung-blatt">
          <div className="vp-nw-schritt-inhalt">
            {sitzung ? (
              <PruefZeilen
                testid="mb-sitzung"
                zeilen={[
                  { etikett: 'Tag', wert: E.tagText(sitzung.tag) },
                  { etikett: M.LEITUNG, wert: sitzung.leitung.name ?? '–' },
                  ...(sitzung.teilnehmende.length ? [{ etikett: M.TEILNEHMENDE, wert: sitzung.teilnehmende.map((p) => p.name).filter(Boolean).join(', ') }] : []),
                  ...(sitzung.ort ? [{ etikett: 'Ort', wert: sitzung.ort }] : []),
                  ...(sitzung.eingetragen_von ? [{ etikett: 'Eingetragen', wert: sitzung.eingetragen_von }] : []),
                ]}
              />
            ) : (
              <p className="vp-nw-leise">{M.LEER.sitzung}</p>
            )}
            {sitzung && !sitzung.leitung_gilt && (
              <p className="vp-nw-feld-fehler" data-testid="mb-leitung-gilt-nicht">
                {M.LEITUNG_GILT_NICHT}
              </p>
            )}
            {!freigegeben && (
              <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                <div className="vp-nw-blatt-zeile">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setBlatt(null);
                      setVorbereiten('sitzung');
                    }}
                    data-testid="mb-sitzung-knopf"
                  >
                    {sitzung ? M.KNOPF_SITZUNG_AENDERN : M.KNOPF_SITZUNG}
                  </Button>
                </div>
              </EinsichtRecht>
            )}
          </div>
        </NwBlatt>

        {/* „Was die Leitung sah“: die Abschnitte als Zeilen; ein Abschnitt öffnet sich im selben Blatt. */}
        <NwBlatt
          open={blatt === 'eingaben' || !!eingabe}
          titel={eingabe ? eingabe.titel : B.WAS_DIE_LEITUNG_SAH}
          onClose={() => setBlatt(null)}
          testId="mb-eingaben-blatt"
        >
          <div className="vp-nw-schritt-inhalt">
            {eingabe && zeigt ? (
              <>
                <button type="button" className="vp-nw-zurueck" onClick={() => setBlatt('eingaben')} data-testid="mb-eingaben-zurueck">
                  <NwSymbol name="chevron-left" size={16} />
                  Alle Teile
                </button>
                <ManagementbewertungEingaben abzug={zeigt} nur={eingabe.key} />
              </>
            ) : eingaben ? (
              <>
                <HinweisZeile
                  icon="calendar"
                  titel={`Eingaben vom ${M.zeitpunkt((stand ?? entwurf)!.datenstand, zone)}`}
                  testid="mb-eingaben-stand"
                />
                <NwZeilen testId="mb-eingaben">
                  {eingaben.map((z) => (
                    <NwZeile
                      key={z.key}
                      titel={z.titel}
                      rechts={z.zahl !== null ? <Fakt>{z.zahl}</Fakt> : undefined}
                      onClick={() => setBlatt({ eingabe: z.key })}
                      testId={`mb-eingabe-zeile-${z.key}`}
                    />
                  ))}
                </NwZeilen>
              </>
            ) : (
              <p className="vp-nw-leise">Wird geladen …</p>
            )}
          </div>
        </NwBlatt>

        <NwBlatt open={blatt === 'staende'} titel={M.STAENDE} onClose={() => setBlatt(null)} testId="mb-staende">
          <NwZeilen>
            {[...detail.staende]
              .sort((x, y) => y.nr - x.nr)
              .map((s) => (
                <NwZeile
                  key={s.nr}
                  titel={`Stand ${s.nr}`}
                  unter={`${E.tagText(tagDesAugenblicks(s.freigegeben_am, zone))} · ${s.freigegeben_von.name} · Prüfsumme ${M.pruefsummeKurz(s.pruefsumme)}`}
                  rechts={s.ersetzt_durch_nr ? <Fakt>ersetzt</Fakt> : undefined}
                  verb={M.KNOPF_PDF}
                  onClick={() => void pdf(s.nr)}
                  testId={`mb-stand-${s.nr}`}
                />
              ))}
          </NwZeilen>
        </NwBlatt>

        {vorbereiten && (
          <ManagementbewertungVorbereiten
            kennung={kennung}
            mb={mb}
            detail={detail}
            entwurf={entwurf}
            start={vorbereiten}
            heute={heute()}
            titel={titel}
            onMb={neu}
            onEntwurf={setEntwurf}
            onFreigegeben={() => {
              setVorbereiten(null);
              setVersuch((v) => v + 1);
            }}
            onClose={() => setVorbereiten(null)}
          />
        )}
        {folge && (
          <FolgeDialog
            kennung={kennung}
            beschluss={folge}
            onClose={() => setFolge(null)}
            onFertig={(m) => {
              setFolge(null);
              neu(m);
            }}
          />
        )}
      </div>
    </GrenzSatzBereich>
  );
}
