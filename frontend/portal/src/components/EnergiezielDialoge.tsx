import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Energieziel, type EnergiezielErgebnis, type EnergiezielStand, type Kennzahl, type VorgangAnstoss } from '../api';
import { heute } from '../bewertung';
import { basisZeile as bezugsbasisZeile, zeilenFassung } from '../bezugsbasisAnlegen';
import * as Z from '../energieziele';
import { anstossZeile } from '../massnahmeWirkung';
import { UEMS_ENERGIEZIEL, UEMS_NORMGRENZE, UEMS_VERANTWORTLICH, UEMS_ZIELPERIODE, UEMS_ZIELWERT } from '../glossar';
import { energiezielRoute, hashForRoute } from '../nav';
import type { BezugsbasisLage } from './BezugsbasisReiter';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

const ABBRECHEN = 'Abbrechen';

export function Begruendung({ id, wert, setze, fehler }: { id: string; wert: string; setze: (t: string) => void; fehler: string | null }) {
  return (
    <div className="vp-ez-feld">
      <label className="vp-ez-label" htmlFor={id}>
        Begründung
      </label>
      <textarea id={id} rows={3} value={wert} onChange={(e) => setze(e.target.value)} aria-invalid={!!fehler} />
      <p className={fehler ? 'vp-ez-fehler' : 'vp-ez-leise'}>{fehler ?? Z.BEGRUENDUNG_HINWEIS}</p>
    </div>
  );
}

export function Ablehnung({ satz }: { satz: string | null }) {
  return satz ? (
    <p className="vp-alert vp-alert-err" role="alert">
      {satz}
    </p>
  ) : null;
}

/**
 * „Energieziel setzen“ an der Kennzahl (AP-18 §5.1, Z1/Z2, E3 = A): die Basis-Zeile der freigegebenen Fassung, der
 * Zielwert in Prozent gegenüber dem Erwarteten, die Zielperiode aus ganzen Monaten (Vorgabe: das nächste volle
 * Kalenderjahr, nie rückwirkend), Wortlaut und Begründung. Verantwortlich ist, ohne Wahl, wer es für die Kennzahl ist
 * (die Route setzt die Vorgabe). Entschieden wird an der Route — ihr Satz steht nach dem Versuch.
 */
export function EnergiezielSetzenDialog({
  kennzahl,
  basisZeile,
  onClose,
  onGesetzt,
  tagHeute = heute(),
}: {
  kennzahl: Pick<Kennzahl, 'id' | 'kennzeichen' | 'name'>;
  basisZeile: string;
  onClose: () => void;
  onGesetzt: (ez: Energieziel) => void;
  tagHeute?: string;
}) {
  const basis = `ez-${useId().replace(/:/g, '')}`;
  const [vorVon, vorBis] = Z.zielperiodeVorgabe(tagHeute).split('/');
  const [zielwert, setZielwert] = useState('');
  const [von, setVon] = useState(vorVon);
  const [bis, setBis] = useState(vorBis);
  const [wortlaut, setWortlaut] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ zielwert?: string; periode?: string; wortlaut?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const monate = Z.monatsWahl(tagHeute);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const wert = Z.zielwertAusEingabe(zielwert);
    const fehler = {
      ...(wert === null ? { zielwert: 'Eine Zahl zwischen 0 und 100 mit höchstens einer Nachkommastelle, zum Beispiel 5 oder 2,5.' } : {}),
      ...(!Z.zielperiodeOk(von, bis) ? { periode: 'Der letzte Monat liegt nicht vor dem ersten.' } : {}),
      ...(!wortlaut.trim() ? { wortlaut: `Bitte beschreiben Sie das ${UEMS_ENERGIEZIEL} in einem Satz.` } : {}),
      ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
    };
    setZeigen(fehler);
    const erstes = Object.keys(fehler)[0];
    if (erstes) {
      document.getElementById(`${basis}-${erstes}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onGesetzt(
        await api.energiezielAnlegen({
          kennzahl: kennzahl.id,
          zielwert_prozent: wert!,
          zielperiode: `${von}/${bis}`,
          wortlaut: wortlaut.trim(),
          begruendung: begruendung.trim(),
        }),
      );
    } catch (e) {
      setSatz(Z.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={Z.KNOPF_SETZEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="energieziel-setzen-senden">
            {Z.KNOPF_SETZEN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(e) => void senden(e)} data-testid="energieziel-setzen">
        <p className="vp-ez-kennzahl">
          {kennzahl.kennzeichen} {kennzahl.name}
        </p>
        <p className="vp-ez-basis" data-testid="energieziel-basis-zeile">
          {basisZeile}
        </p>
        <Input
          id={`${basis}-zielwert`}
          label={`${UEMS_ZIELWERT} in % weniger, als die Bezugsbasis erwarten lässt`}
          inputMode="decimal"
          value={zielwert}
          onChange={(e) => setZielwert(e.target.value)}
          hint="Eine Stelle nach dem Komma. Ein negativer Wert heißt „mehr“ — dann sagt der Wortlaut, warum."
          error={zeigen.zielwert ?? null}
        />
        <fieldset className="vp-ez-periode">
          <legend>{UEMS_ZIELPERIODE}</legend>
          <VpPicker id={`${basis}-periode`} label="Erster Monat" options={monate} value={von} onChange={setVon} />
          <VpPicker id={`${basis}-bis`} label="Letzter Monat" options={monate} value={bis} onChange={setBis} error={zeigen.periode ?? null} />
          <p className="vp-ez-leise">
            {Z.zielperiodeText(`${von}/${bis}`)} — ganze Monate, frühestens ab dem nächsten Monat.
          </p>
        </fieldset>
        <Input
          id={`${basis}-wortlaut`}
          label="Wortlaut"
          value={wortlaut}
          onChange={(e) => setWortlaut(e.target.value)}
          placeholder="zum Beispiel: Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt"
          error={zeigen.wortlaut ?? null}
        />
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <p className="vp-ez-leise">{UEMS_VERANTWORTLICH}: wer für die Kennzahl verantwortlich ist.</p>
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/**
 * Der Einstieg an der Kennzahl-Seite (§5.1): „Energieziel setzen“ nur bei einer Energieleistungskennzahl — einer
 * laufenden Bezugsbasis mit freigegebener Fassung (AP-17 IP-8) — und mit `verbesserung.verwalten`. Nach dem Setzen
 * führt ein Sprung zur Seite des neuen Energieziels.
 */
export function EnergiezielSetzen({
  kennzahl,
  lage,
}: {
  kennzahl: Pick<Kennzahl, 'id' | 'kennzeichen' | 'name' | 'standort_id' | 'einheit_anzeige'>;
  lage: BezugsbasisLage;
}) {
  const [offen, setOffen] = useState(false);
  const [gesetzt, setGesetzt] = useState<Energieziel | null>(null);
  if (lage.art !== 'da' || !lage.fassung || lage.basis.beendet_zum !== null) return null;
  if (zeilenFassung(lage.basis)?.freigabe_status !== 'freigegeben') return null;
  return (
    <div className="vp-ez-aktionen" data-testid="energieziel-setzen-einstieg">
      <Recht aktion="verbesserung.verwalten" standort={kennzahl.standort_id}>
        <Button variant="outline" size="sm" onClick={() => setOffen(true)} data-testid="energieziel-setzen-knopf">
          {Z.KNOPF_SETZEN}
        </Button>
      </Recht>
      {gesetzt && (
        <p className="vp-ez-leise" role="status" data-testid="energieziel-gesetzt">
          {`${UEMS_ENERGIEZIEL} ${gesetzt.kennzeichen} gesetzt — `}
          <a href={hashForRoute(energiezielRoute(gesetzt.id))}>{`${UEMS_ENERGIEZIEL} ${gesetzt.kennzeichen} öffnen`}</a>
        </p>
      )}
      {offen && (
        <EnergiezielSetzenDialog
          kennzahl={kennzahl}
          basisZeile={bezugsbasisZeile(lage.basis, lage.fassung, kennzahl.einheit_anzeige)}
          onClose={() => setOffen(false)}
          onGesetzt={(ez) => {
            setOffen(false);
            setGesetzt(ez);
          }}
        />
      )}
    </div>
  );
}

const ERGEBNIS_OPTIONEN = (Object.keys(Z.ERGEBNIS_WORT) as EnergiezielErgebnis[]).map((e) => ({ value: e, label: Z.ERGEBNIS_WORT[e] }));
const ERGEBNIS_AUS_VORSCHLAG: Record<'erreicht' | 'nicht_erreicht', EnergiezielErgebnis> = { erreicht: 'erreicht', nicht_erreicht: 'verfehlt' };

/**
 * „bewerten“ (Z4/Z5, IP-7): Ergebnis und Begründung einer Person; der Vorschlag des Lesers steht als Vorgabe und eine
 * Abweichung davon sichtbar daneben. Bei Vier-Augen wird daraus ein Antrag, den eine ZWEITE Person bestätigt oder
 * ablehnt (`schritt` `freigeben` · `ablehnen`, dann ohne Ergebnis-Wahl). Die Kopie mit Prüfsumme bildet die Route.
 * Aus einem Anstoß („neu bewerten“, IP-20) geht die Antwort an `…/anstoesse/{aid}/antwort` (IP-17-NAHT).
 */
export function EnergiezielBewertenDialog({
  ez,
  stand,
  schritt,
  anstoss,
  onClose,
  onFertig,
}: {
  ez: Energieziel;
  stand: EnergiezielStand | null;
  schritt: 'bewerten' | 'freigeben' | 'ablehnen';
  anstoss?: VorgangAnstoss | null;
  onClose: () => void;
  onFertig: (ez: Energieziel) => void;
}) {
  const basis = `ezb-${useId().replace(/:/g, '')}`;
  const vorschlag = stand && Z.vorschlagSatz(stand) ? stand.vorschlag : null;
  const [ergebnis, setErgebnis] = useState<EnergiezielErgebnis | null>(vorschlag ? ERGEBNIS_AUS_VORSCHLAG[vorschlag] : null);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ ergebnis?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const antrag = ez.bewertung?.status === 'beantragt' ? ez.bewertung : null;
  const titel = schritt === 'bewerten' ? `${UEMS_ENERGIEZIEL} ${ez.kennzeichen} ${Z.KNOPF_BEWERTEN}` : schritt === 'freigeben' ? Z.KNOPF_FREIGEBEN : Z.KNOPF_ABLEHNEN;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(schritt === 'bewerten' && !ergebnis ? { ergebnis: 'Bitte wählen Sie ein Ergebnis.' } : {}),
      // Beim Bestätigen ist die Begründung wahlfrei (IP-7); steht eine da, gilt dieselbe Länge.
      ...(!Z.begruendungOk(begruendung) && !(schritt === 'freigeben' && !begruendung.trim()) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
    };
    setZeigen(fehler);
    const erstes = Object.keys(fehler)[0];
    if (erstes) {
      document.getElementById(`${basis}-${erstes}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    const text = begruendung.trim();
    const body = schritt === 'bewerten' ? { ergebnis: ergebnis!, begruendung: text } : text ? { begruendung: text } : {};
    try {
      onFertig(
        anstoss && schritt === 'bewerten'
          ? await api.energiezielAnstossAntwort(ez.id, anstoss.id, { antwort: 'neu_bewertet', ergebnis: ergebnis!, begruendung: text })
          : await api.energiezielBewertung(ez.id, schritt, body),
      );
    } catch (e) {
      // Wie der Bezugsbasis-Assistent folgt der Dialog der Route: mit Vier-Augen wird „bewerten“ ein Antrag.
      if (schritt === 'bewerten' && !anstoss && Z.ablehnungCode(e) === 'vieraugen_beantragen') {
        try {
          onFertig(await api.energiezielBewertung(ez.id, 'beantragen', body));
        } catch (e2) {
          setSatz(Z.ablehnungSatz(e2));
        }
      } else {
        setSatz(Z.ablehnungSatz(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={titel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="energieziel-bewerten-senden">
            {schritt === 'bewerten' ? Z.KNOPF_BEWERTEN : titel}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(e) => void senden(e)} data-testid="energieziel-bewerten">
        {anstoss && <p className="vp-ez-leise">{anstossZeile(anstoss)}</p>}
        {stand?.satz && <p className="vp-ez-satz">{stand.satz}</p>}
        {schritt === 'bewerten' ? (
          <>
            {vorschlag && stand?.vorschlag_satz ? (
              <p className="vp-ez-vorschlag" data-testid="bewerten-vorschlag">
                {stand.vorschlag_satz}
              </p>
            ) : (
              <p className="vp-ez-leise" data-testid="bewerten-ohne-vorschlag">
                Kein Vorschlag — nicht jeder Monat der {UEMS_ZIELPERIODE} ist bewertbar. Die Bewertung trifft eine Person.
              </p>
            )}
            <VpPicker
              id={`${basis}-ergebnis`}
              label="Ergebnis"
              options={ERGEBNIS_OPTIONEN}
              value={ergebnis}
              onChange={(v) => setErgebnis(v as EnergiezielErgebnis)}
              placeholder="Ergebnis wählen"
              error={zeigen.ergebnis ?? null}
            />
            {vorschlag && Z.weichtAb(vorschlag, ergebnis) && (
              <p className="vp-ez-abweichung" data-testid="bewerten-abweichung">
                {Z.ABWEICHUNG_VOM_VORSCHLAG} — die Begründung sagt, warum.
              </p>
            )}
          </>
        ) : (
          antrag && <p className="vp-ez-leise">{Z.beantragtSatz(antrag.person.name, antrag.am, antrag.ergebnis)}</p>
        )}
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <p className="vp-ez-leise">Die Bewertung ist endgültig: eine Kopie des Stands mit Prüfsumme, nie zurückgenommen.</p>
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

/** „beenden“ (Z5): vorzeitig, mit Tag und Begründung — endgültig, nie gelöscht. */
export function EnergiezielBeendenDialog({
  ez,
  onClose,
  onBeendet,
  tagHeute = heute(),
}: {
  ez: Energieziel;
  onClose: () => void;
  onBeendet: (ez: Energieziel) => void;
  tagHeute?: string;
}) {
  const basis = `eze-${useId().replace(/:/g, '')}`;
  const [zum, setZum] = useState(tagHeute);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!Z.begruendungOk(begruendung)) {
      setZeigen(Z.BEGRUENDUNG_HINWEIS);
      document.getElementById(`${basis}-begruendung`)?.focus();
      return;
    }
    setZeigen(null);
    setBusy(true);
    setSatz(null);
    try {
      onBeendet(await api.energiezielBeenden(ez.id, { zum, begruendung: begruendung.trim() }));
    } catch (e) {
      setSatz(Z.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${UEMS_ENERGIEZIEL} ${ez.kennzeichen} ${Z.KNOPF_BEENDEN}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="energieziel-beenden-senden">
            {Z.KNOPF_BEENDEN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(e) => void senden(e)} data-testid="energieziel-beenden">
        <p className="vp-ez-leise">
          Ein beendetes {UEMS_ENERGIEZIEL} bleibt mit Verlauf und Stand lesbar; es wird nicht bewertet und nie gelöscht.
        </p>
        <VpDatePicker label="Beendet zum" value={zum} onChange={setZum} min={ez.angelegt_am} max={tagHeute} />
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen} />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
