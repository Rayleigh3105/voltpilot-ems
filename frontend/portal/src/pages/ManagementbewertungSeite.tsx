import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type BerichtDetail, type BerichtEntwurf, type BerichtStand, type Managementbewertung, type ManagementbewertungBeschluss } from '../api';
import { BerichtFreigebenDialog } from '../components/BerichtFreigebenDialog';
import { EinsichtRecht } from '../components/EinsichtRecht';
import { ManagementbewertungEingaben } from '../components/ManagementbewertungEingaben';
import { BeschlussDialog, FolgeDialog, SitzungDialog } from '../components/ManagementbewertungDialoge';
import { MassnahmeAnlegen } from '../components/MassnahmeDialoge';
import * as E from '../energiemanagementPortal';
import { UEMS_MANAGEMENTBEWERTUNG, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import * as M from '../managementbewertung';

type Dialog = { art: 'sitzung' } | { art: 'beschluss'; beschluss: ManagementbewertungBeschluss | null } | { art: 'folge'; beschluss: ManagementbewertungBeschluss } | { art: 'freigeben' };

/**
 * Die Seite einer Managementbewertung (UEMS AP-19 IP-24, §5.5, MG1–MG7, R13, R14): Kopf (§5.8), die Eingaben — ohne
 * Stand der Entwurf von heute, mit Stand die Eingaben seines Tages und der Satz „Dieser Stand zeigt die Eingaben vom …“ —,
 * „Sitzung festhalten“ und „Beschluss festhalten“ bis zur Freigabe (IP-23, `energiemanagement.verwalten`), „freigeben“
 * über den Freigabe-Dialog der Berichte (AP-12, `energiemanagement.freigeben`; die Route verlangt Sitzung, Leitung und
 * einen Beschluss), danach je Beschluss seine Folgen mit dem Zustand von heute, „Folge verknüpfen“ und „Maßnahme anlegen“
 * mit der Herkunft des Beschlusses; die Stände mit Freigabe, Prüfsumme und PDF auf Abruf (jeder Abruf protokolliert).
 * Die Seite ist ein Bericht der Vorlage `managementbewertung` — nichts ist nachgebaut, nichts wird neu gerechnet.
 */
export function ManagementbewertungSeite({
  kennung,
  onListe,
  heute = () => new Date().toISOString().slice(0, 10),
}: {
  kennung: string;
  onListe: () => void;
  heute?: () => string;
}) {
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [entwurf, setEntwurf] = useState<BerichtEntwurf | null>(null);
  const [stand, setStand] = useState<BerichtStand | null>(null);
  const [mb, setMb] = useState<Managementbewertung | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [abruf, setAbruf] = useState<{ satz: string; fehler: boolean } | null>(null);
  const [laeuft, setLaeuft] = useState<number | null>(null);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    Promise.all([api.bericht(kennung), api.managementbewertung(kennung)]).then(
      async ([d, m]) => {
        if (!aktiv) return;
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
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, versuch]);

  /** Eine Eingabe (Sitzung, Beschluss, Folge) ist gespeichert — der Entwurf ist neu gebildet, die Seite liest neu. */
  const neu = (m: Managementbewertung) => {
    setMb(m);
    setDialog(null);
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
      setAbruf({ satz: `PDF von Stand Nr. ${nr} abgerufen — der Abruf ist protokolliert.`, fehler: false });
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
  const sitzung = mb?.sitzung ?? null;

  const sitzungTeil = (
    <div data-testid="mb-sitzung">
      {sitzung ? (
        <>
          <p className="vp-ez-satz" data-testid="mb-sitzung-satz">{M.sitzungSatz(sitzung)}</p>
          {!sitzung.leitung_gilt && <p className="vp-ez-fehler" data-testid="mb-leitung-gilt-nicht">{M.LEITUNG_GILT_NICHT}</p>}
          {sitzung.eingetragen_von && <p className="vp-ez-leise">{`eingetragen von ${sitzung.eingetragen_von}${sitzung.eingetragen_am ? ` am ${M.tag(sitzung.eingetragen_am)}` : ''}`}</p>}
        </>
      ) : (
        <p className="vp-ez-leise">{M.LEER.sitzung}</p>
      )}
      {!freigegeben && (
        <div className="vp-ez-aktionen">
          <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
            <Button size="sm" variant="outline" onClick={() => setDialog({ art: 'sitzung' })} data-testid="mb-sitzung-knopf">
              {sitzung ? M.KNOPF_SITZUNG_AENDERN : M.KNOPF_SITZUNG}
            </Button>
          </EinsichtRecht>
        </div>
      )}
    </div>
  );

  const beschluesseTeil = (
    <div data-testid="mb-beschluesse">
      {!mb || mb.beschluesse.length === 0 ? (
        <p className="vp-ez-leise">{M.LEER.beschluesse}</p>
      ) : (
        <ul className="vp-mb-zeilen">
          {mb.beschluesse.map((x) => (
            <li key={x.nr} data-testid={`mb-beschluss-${x.nr}`}>
              <span className="vp-mb-gegenstand">{M.beschlussSatz(x)}</span>
              <span className="vp-mb-zustand">{M.beschlussAngaben(x)}</span>
              {freigegeben && (
                <div className="vp-mb-folgen" data-testid={`mb-folgen-${x.nr}`}>
                  <span className="vp-mb-folgen-titel">{M.FOLGEN}</span>
                  {x.folgen.length > 0 ? (
                    <ul className="vp-em-kurzliste">
                      {x.folgen.map((f) => (
                        <li key={`${f.art}/${f.objekt}/${f.wie}`} data-testid={`mb-folge-${x.nr}-${f.objekt}`}>{M.folgeZeile(f)}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="vp-ez-leise" data-testid={`mb-ohne-folge-${x.nr}`}>{x.satz ?? '—'}</span>
                  )}
                  <div className="vp-ez-aktionen">
                    <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                      <Button size="sm" variant="outline" onClick={() => setDialog({ art: 'folge', beschluss: x })} data-testid={`mb-folge-knopf-${x.nr}`}>
                        {M.KNOPF_FOLGE}
                      </Button>
                    </EinsichtRecht>
                    <MassnahmeAnlegen
                      vorbelegung={{ herkunft: 'managementbewertung', herkunftKennung: x.kennung }}
                      standort={null}
                      onAngelegt={() => setVersuch((v) => v + 1)}
                    />
                  </div>
                </div>
              )}
              {!freigegeben && (
                <div className="vp-ez-aktionen">
                  <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ art: 'beschluss', beschluss: x })} data-testid={`mb-beschluss-aendern-${x.nr}`}>
                      {M.KNOPF_BESCHLUSS_AENDERN}
                    </Button>
                  </EinsichtRecht>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!freigegeben && sitzung && (
        <div className="vp-ez-aktionen">
          <EinsichtRecht aktion={E.RECHT_VERWALTEN} standort={null}>
            <Button size="sm" variant="outline" onClick={() => setDialog({ art: 'beschluss', beschluss: null })} data-testid="mb-beschluss-knopf">
              {M.KNOPF_BESCHLUSS}
            </Button>
          </EinsichtRecht>
        </div>
      )}
    </div>
  );

  return (
    <div className="vp-ez" data-testid="managementbewertung-seite">
      <button type="button" className="vp-em-hilfe" onClick={onListe} data-testid="mb-zur-liste">
        ← {M.ZUR_LISTE}
      </button>
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : !detail || !b ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <>
          <div className="vp-em-kopf">
            <h1>{`${UEMS_MANAGEMENTBEWERTUNG} ${b.zeitraum}`}</h1>
            <span className="vp-wv-kz">{b.kennung}</span>
          </div>
          <p className="vp-ez-satz" data-testid="mb-kopf">
            {M.kopfSatz(b.zeitraum, sitzung ? { tag: sitzung.tag, leitung: sitzung.leitung.name ?? '—' } : null, gueltig, zone)}
          </p>

          {gueltig && stand ? (
            <p className="vp-ez-satz" data-testid="mb-stand-seines-tages">
              {M.standSeinesTages(stand.datenstand, zone)}
            </p>
          ) : (
            <section className="vp-ez-karte vp-mb-entwurf" aria-label={M.ENTWURF} data-testid="mb-entwurf">
              <div className="vp-em-kopf">
                <p>{entwurf ? M.entwurfZeile(entwurf.datenstand, zone) : M.KEIN_STAND}</p>
                {entwurf && (
                  <EinsichtRecht aktion={E.RECHT_FREIGEBEN} standort={null}>
                    <Button onClick={() => setDialog({ art: 'freigeben' })} disabled={!M.freigabeBereit(mb)} data-testid="mb-freigeben">
                      {M.KNOPF_FREIGEBEN}
                    </Button>
                  </EinsichtRecht>
                )}
              </div>
              {!M.freigabeBereit(mb) && (
                <p className="vp-ez-leise" data-testid="mb-freigabe-voraussetzung">{M.FREIGABE_VORAUSSETZUNG}</p>
              )}
            </section>
          )}

          {/* Variante A (PR-Ansicht): was die Leitung entschieden hat, steht über den Eingaben — dort wird gehandelt;
              die Eingaben folgen in der Reihenfolge der Vorlage (das PDF behält alle zwölf Abschnitte in ihrer Reihenfolge). */}
          <section className="vp-ez-karte" aria-label={M.SITZUNG_UND_BESCHLUESSE} data-testid="mb-sitzung-beschluesse">
            <h2>{M.SITZUNG_UND_BESCHLUESSE}</h2>
            <h3 className="vp-wv-titel">{M.SITZUNG}</h3>
            {sitzungTeil}
            <h3 className="vp-wv-titel">{M.BESCHLUESSE}</h3>
            {beschluesseTeil}
          </section>

          <section className="vp-ez-karte" aria-label={M.EINGABEN}>
            <h2>{M.EINGABEN}</h2>
            {zeigt ? (
              <ManagementbewertungEingaben abzug={zeigt} ohne={['beschluesse', 'sitzung']} />
            ) : (
              <p className="vp-ez-leise">Wird geladen …</p>
            )}
          </section>

          <section className="vp-ez-karte" aria-label={M.STAENDE} data-testid="mb-staende">
            <h2>{M.STAENDE}</h2>
            {detail.staende.length === 0 ? (
              <p className="vp-ez-leise">{M.KEIN_STAND}</p>
            ) : (
              <ul className="vp-mb-zeilen">
                {[...detail.staende].sort((x, y) => y.nr - x.nr).map((s) => (
                  <li key={s.nr} data-testid={`mb-stand-${s.nr}`}>
                    <span className="vp-mb-gegenstand">{M.standZeile(s, zone)}</span>
                    <span className="vp-mb-pruef" title={s.pruefsumme}>
                      Prüfsumme {M.pruefsummeKurz(s.pruefsumme)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      iconLeft={<Icon name="file-text" size={16} />}
                      disabled={laeuft !== null}
                      onClick={() => void pdf(s.nr)}
                      aria-label={`PDF von Stand Nr. ${s.nr}`}
                      data-testid={`mb-pdf-${s.nr}`}
                    >
                      {M.KNOPF_PDF}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {abruf && (
              <p className={`vp-alert ${abruf.fehler ? 'vp-alert-err' : 'vp-alert-ok'}`} role="status" data-testid="mb-abruf">
                {abruf.satz}
              </p>
            )}
          </section>
        </>
      )}
      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
      {dialog?.art === 'sitzung' && (
        <SitzungDialog kennung={kennung} heute={heute()} vorher={sitzung} onClose={() => setDialog(null)} onFertig={neu} />
      )}
      {dialog?.art === 'beschluss' && mb && (
        <BeschlussDialog kennung={kennung} mb={mb} beschluss={dialog.beschluss} onClose={() => setDialog(null)} onFertig={neu} />
      )}
      {dialog?.art === 'folge' && (
        <FolgeDialog kennung={kennung} beschluss={dialog.beschluss} onClose={() => setDialog(null)} onFertig={neu} />
      )}
      {dialog?.art === 'freigeben' && detail && entwurf && (
        <BerichtFreigebenDialog
          open
          onClose={() => setDialog(null)}
          detail={detail}
          entwurf={entwurf}
          onEntwurf={setEntwurf}
          onFreigegeben={() => {
            setDialog(null);
            setVersuch((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
