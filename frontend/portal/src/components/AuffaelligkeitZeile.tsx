import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import * as A from '../abweichungen';
import { api, type Abweichung, type Auffaelligkeit } from '../api';
import { benutzerApi, type BenutzerEintrag } from '../benutzer';
import { heute, verantwortlichOptionen } from '../bewertung';
import { monatWort } from '../bezugsbasisVergleich';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTLICH } from '../glossar';
import { abweichungRoute, hashForRoute } from '../nav';
import { Ablehnung, Begruendung } from './EnergiezielDialoge';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

const ABBRECHEN = 'Abbrechen';

/** Die aktiven Konten des Kundenbereichs (A3, RE3); `null` = nicht lesbar — dann ein Satz statt der Wahl. */
export function useAktiveKonten(): { geladen: boolean; konten: { value: string; label: string }[] | null } {
  const [lage, setLage] = useState<{ geladen: boolean; konten: { value: string; label: string }[] | null }>({ geladen: false, konten: [] });
  useEffect(() => {
    let aktiv = true;
    benutzerApi.liste().then(
      (b: BenutzerEintrag[]) => aktiv && setLage({ geladen: true, konten: verantwortlichOptionen(b.filter((x) => x.zustand === 'aktiv')) }),
      () => aktiv && setLage({ geladen: true, konten: null }),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return lage;
}

/** Wahl des Verantwortlichen aus den aktiven Konten; ohne lesbare Konten ein ehrlicher Satz. */
export function VerantwortlichWahl({ id, wert, setze, fehler }: { id: string; wert: string; setze: (v: string) => void; fehler: string | null }) {
  const { geladen, konten } = useAktiveKonten();
  if (konten === null) {
    return <p className="vp-ez-fehler">{`Die Konten Ihres Kundenbereichs sind gerade nicht abrufbar — ohne ${UEMS_VERANTWORTLICH} lässt sich nichts eröffnen.`}</p>;
  }
  return (
    <VpPicker
      id={id}
      label={UEMS_VERANTWORTLICH}
      options={konten}
      loading={!geladen}
      value={wert || null}
      onChange={(v) => setze(v ?? '')}
      hint="Aus den aktiven Konten Ihres Kundenbereichs. Verantwortung verleiht kein Recht."
      error={fehler}
    />
  );
}

/**
 * Die Antwort auf eine Auffälligkeit (A2, §5.2) — einmalig: „Abweichung eröffnen“ (Verantwortlich aus den aktiven
 * Konten, Frist mit Vorgabe dreißig Tage; alle offenen Vermerke derselben Kennzahl × Fassung gehen hinein) oder „zur
 * Kenntnis nehmen“ mit Pflicht-Begründung. Keine Antwort ändert eine Zahl (A5).
 */
export function AuffaelligkeitAntwortDialog({
  vermerk,
  mit,
  art,
  onClose,
  onFertig,
  tagHeute = heute(),
}: {
  vermerk: Auffaelligkeit;
  /** Die offenen Vermerke derselben Kennzahl × Fassung (samt diesem) — sie werden genannt und übernommen. */
  mit: Auffaelligkeit[];
  art: 'abweichung' | 'zur_kenntnis';
  onClose: () => void;
  onFertig: (x: { vermerk: Auffaelligkeit; abweichung: Abweichung | null }) => void;
  tagHeute?: string;
}) {
  const basis = `aa-${useId().replace(/:/g, '')}`;
  const [verantwortlich, setVerantwortlich] = useState('');
  const [frist, setFrist] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ verantwortlich?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titel = art === 'abweichung' ? A.KNOPF_EROEFFNEN : A.KNOPF_ZUR_KENNTNIS;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler =
      art === 'abweichung'
        ? { ...(!verantwortlich ? { verantwortlich: 'Bitte wählen Sie, wer verantwortlich ist.' } : {}) }
        : { ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}) };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.auffaelligkeitAntworten(
          vermerk.kennzahl.id,
          vermerk.id,
          art === 'abweichung' ? { antwort: 'abweichung', verantwortlich, ...(frist ? { frist } : {}) } : { antwort: 'zur_kenntnis', begruendung: begruendung.trim() },
        ),
      );
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const saetze = A.anlassSaetze(vermerk.anlass_inhalt);
  return (
    <Modal
      open
      onClose={onClose}
      title={`${monatWort(vermerk.periode)}: ${titel}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="auffaelligkeit-antwort-senden">
            {titel}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid={`auffaelligkeit-antwort-${art}`}>
        <p className="vp-ez-leise">{A.vermerktAm(Z.tag(vermerk.vermerkt_am))}</p>
        {saetze.map((s) => (
          <p key={s} className="vp-ez-satz">
            {s}
          </p>
        ))}
        {art === 'abweichung' ? (
          <>
            {mit.length > 0 && (
              <p className="vp-ez-basis" data-testid="auffaelligkeit-mitgenommen">
                {A.mitgenommen(mit.map((v) => monatWort(v.periode)))}
              </p>
            )}
            <VerantwortlichWahl id={`${basis}-verantwortlich`} wert={verantwortlich} setze={setVerantwortlich} fehler={zeigen.verantwortlich ?? null} />
            <VpDatePicker id={`${basis}-frist`} label={`${A.FRIST} (wahlfrei)`} value={frist} onChange={setFrist} min={tagHeute} />
            <p className="vp-ez-leise">{A.FRIST_HINWEIS}</p>
          </>
        ) : (
          <>
            <p className="vp-ez-leise">Einmalig. Der Vermerk bleibt mit Ihrer Begründung lesbar; der Monat zählt weiter, wie er ist.</p>
            <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
          </>
        )}
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * Die Vermerk-Zeile am Monat in der Vergleichs-Fläche (§5.2, A1, A2): „Auffälligkeit — vermerkt am …“, die Vorbehalte
 * aus der Kopie und die Antwort — offen mit den zwei Knöpfen, beantwortet mit ihrem Satz bzw. dem Sprung zur
 * Abweichung. Ein Monat kann je Fassung einen Vermerk haben.
 */
export function VermerkZeile({
  vermerke,
  alle,
  onNeu,
}: {
  vermerke: Auffaelligkeit[];
  /** Alle Vermerke der Kennzahl — für „alle offenen gehen hinein“. */
  alle: Auffaelligkeit[];
  onNeu: () => void;
}) {
  const [dialog, setDialog] = useState<{ v: Auffaelligkeit; art: 'abweichung' | 'zur_kenntnis' } | null>(null);
  return (
    <div className="vp-aw-vermerke" data-testid="vermerk-zeile">
      {vermerke.map((v) => (
        <div key={v.id} className={`vp-aw-vermerk is-${v.zustand}`} data-testid={`vermerk-${v.periode}`}>
          <p className="vp-aw-vermerk-kopf">
            <strong>{A.vermerktAm(Z.tag(v.vermerkt_am))}</strong>
            {v.vorbehalte.map((x) => (
              <span key={x} className="vp-aw-vorbehalt">
                {x}
              </span>
            ))}
          </p>
          {v.zustand === 'offen' ? (
            <>
              <p className="vp-ez-leise">{A.OFFEN_FRAGE}</p>
              <div className="vp-ez-aktionen">
                <Recht aktion="verbesserung.verwalten" standort={v.standort_id}>
                  <Button size="sm" onClick={() => setDialog({ v, art: 'abweichung' })} data-testid="vermerk-eroeffnen">
                    {A.KNOPF_EROEFFNEN}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ v, art: 'zur_kenntnis' })} data-testid="vermerk-zur-kenntnis">
                    {A.KNOPF_ZUR_KENNTNIS}
                  </Button>
                </Recht>
              </div>
            </>
          ) : v.antwort === 'abweichung' && v.abweichung ? (
            <p className="vp-ez-leise" data-testid="vermerk-antwort">
              {`${A.eroeffnetAls(v.abweichung.kennzeichen ?? '')} — `}
              <a href={hashForRoute(abweichungRoute(v.abweichung.id))} data-testid="vermerk-sprung-abweichung">{`${v.abweichung.kennzeichen} öffnen`}</a>
            </p>
          ) : (
            <p className="vp-ez-leise" data-testid="vermerk-antwort">
              {v.satz ?? A.zurKenntnisVon(v.beantwortet_von ?? '', Z.tag(v.beantwortet_am), v.antwort_begruendung)}
            </p>
          )}
        </div>
      ))}
      {dialog && (
        <AuffaelligkeitAntwortDialog
          vermerk={dialog.v}
          art={dialog.art}
          mit={A.offeneDerFassung(alle, dialog.v)}
          onClose={() => setDialog(null)}
          onFertig={(x) => {
            setDialog(null);
            onNeu();
            if (x.abweichung) location.hash = hashForRoute(abweichungRoute(x.abweichung.id));
          }}
        />
      )}
    </div>
  );
}

/**
 * „Abweichung eröffnen“ von Hand an einer Vergleichszeile (A3): auch an „im Rahmen“; der Anlass ist die Kopie des
 * Vergleich-Lesers über diesen Monat (die Route liest ihn selbst), dazu ein Wortlaut, warum, Verantwortlich und Frist.
 */
export function AbweichungVonHand({
  kennzahlId,
  periode,
  basis: basisKennzeichen,
  standort,
  tagHeute = heute(),
}: {
  kennzahlId: string;
  periode: string;
  /** BB-… der Basis, die der Vergleich gerade zeigt. */
  basis: string | null;
  standort?: string | null;
  tagHeute?: string;
}) {
  const basis = `ah-${useId().replace(/:/g, '')}`;
  const [offen, setOffen] = useState(false);
  const [wortlaut, setWortlaut] = useState('');
  const [verantwortlich, setVerantwortlich] = useState('');
  const [frist, setFrist] = useState('');
  const [zeigen, setZeigen] = useState<{ wortlaut?: string; verantwortlich?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(!A.wortlautOk(wortlaut) ? { wortlaut: A.WORTLAUT_HINWEIS } : {}),
      ...(!verantwortlich ? { verantwortlich: 'Bitte wählen Sie, wer verantwortlich ist.' } : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      const a = await api.abweichungEroeffnen({
        kennzahl: kennzahlId,
        ...(basisKennzeichen ? { bezugsbasis: basisKennzeichen } : {}),
        monate: periode,
        wortlaut: wortlaut.trim(),
        verantwortlich,
        ...(frist ? { frist } : {}),
      });
      setOffen(false);
      location.hash = hashForRoute(abweichungRoute(a.id));
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Recht aktion="verbesserung.verwalten" standort={standort}>
        <Button size="sm" variant="ghost" onClick={() => setOffen(true)} data-testid={`von-hand-${periode}`}>
          {A.KNOPF_EROEFFNEN}
        </Button>
      </Recht>
      {offen && (
        <Modal
          open
          onClose={() => setOffen(false)}
          title={`${monatWort(periode)}: ${A.KNOPF_EROEFFNEN}`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOffen(false)}>
                {ABBRECHEN}
              </Button>
              <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="von-hand-senden">
                {A.KNOPF_EROEFFNEN}
              </Button>
            </>
          }
        >
          <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="abweichung-von-hand">
            <p className="vp-ez-basis">{A.VON_HAND_HINWEIS}</p>
            <div className="vp-ez-feld">
              <label className="vp-ez-label" htmlFor={`${basis}-wortlaut`}>
                Warum
              </label>
              <textarea id={`${basis}-wortlaut`} rows={3} value={wortlaut} onChange={(x) => setWortlaut(x.target.value)} aria-invalid={!!zeigen.wortlaut} />
              <p className={zeigen.wortlaut ? 'vp-ez-fehler' : 'vp-ez-leise'}>{A.WORTLAUT_HINWEIS}</p>
            </div>
            <VerantwortlichWahl id={`${basis}-verantwortlich`} wert={verantwortlich} setze={setVerantwortlich} fehler={zeigen.verantwortlich ?? null} />
            <VpDatePicker id={`${basis}-frist`} label={`${A.FRIST} (wahlfrei)`} value={frist} onChange={setFrist} min={tagHeute} />
            <p className="vp-ez-leise">{A.FRIST_HINWEIS}</p>
            <Ablehnung satz={satz} />
            <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
          </form>
        </Modal>
      )}
    </>
  );
}
