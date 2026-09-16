import { useEffect, useState } from "react";
import { Button } from "../../designsystem/components/core/Button";
import { Input } from "../../designsystem/components/forms/Input";
import { Modal } from "../../designsystem/components/shell/Modal";
import {
  api,
  ApiError,
  type BerechneteMessstelleAnlegen,
  type Messstelle,
  type MessstelleGroesse,
} from "../api";
import { alsAnfrage, FAKTOR_ANTEIL_HINWEIS, leererFormelEntwurf, type AssistentTyp } from '../formelAssistent';
import { FormelMessstellen } from './FormelMessstellen';
import { hauptgroesse } from '../uemsMessstelleFormel';
import { SUMMENWERT } from "../glossar";
import { useRollen } from "../rollen";
import { VpDatePicker } from "./VpDatePicker";
import { VpPicker } from "./VpPicker";

type Term = BerechneteMessstelleAnlegen["terme"][number];

/** Tagesgültige Fortschreibung der bestehenden Formel, keine neue Identität. */
export function SummenwertFormelDialog({
  siteId,
  messstelle,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  messstelle: Messstelle;
  onClose: () => void;
  onGespeichert: () => void;
}) {
  const rechte = useRollen();
  const heute = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
  }).format(new Date());
  const [ab, setAb] = useState(heute);
  const [terme, setTerme] = useState<Term[] | null>(null);
  const [typ, setTyp] = useState<AssistentTyp>('gewichtete_summe');
  const [komponenten, setKomponenten] = useState<string[]>([]);
  const [groessen, setGroessen] = useState<Record<string, MessstelleGroesse>>({});
  const [quellen, setQuellen] = useState<
    Array<{ key: string; name: string; term: Term }>
  >([]);
  const [namen, setNamen] = useState<Record<string, string>>({});
  const [begruendung, setBegruendung] = useState("");
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = (t: Term) =>
    t.entity_id
      ? `${t.entity_id}:${t.point_key}`
      : `${t.quell_messstelle_id}:${t.verteilung_ziel ?? ""}`;
  useEffect(() => {
    let aktiv = true;
    void (async () => {
      try {
        const [f, geraete] = await Promise.all([
          api.messstelleFormel(messstelle.id, heute),
          api.siteEntities(siteId),
        ]);
        const listen = await Promise.all(
          geraete.entities.map(async (e) => {
            const liste = await api.komponenteMesskanaele(siteId, e.id);
            return liste.messkanaele.map((k) => ({
              key: `${e.id}:${k.kanal}`,
              name: `${e.label || e.typeLabel} · ${k.anzeigename || "Register"}`,
              term: {
                eingang_art: "messkanal",
                entity_id: e.id,
                point_key: k.kanal,
                vorzeichen: "+",
                faktor: 1,
              } as Term,
              groesse: k,
              passt:
                k.groesse === f.hauptgroesse?.groesse &&
                k.wertart === f.hauptgroesse?.wertart &&
                k.richtung === f.hauptgroesse?.richtung,
            }));
          }),
        );
        if (!aktiv) return;
        setTyp(f.fassung_am?.fassung?.formel_typ === 'saldo' || f.hauptgroesse?.richtung === 'saldiert' ? 'saldo' : 'gewichtete_summe');
        setKomponenten(geraete.entities.map(e => e.id));
        const ts: Term[] = f.terme.map((t) => ({
          eingang_art: t.eingang_art as Term["eingang_art"],
          ...(t.entity_id
            ? { entity_id: t.entity_id, point_key: t.point_key! }
            : { quell_messstelle_id: t.quell_messstelle_id! }),
          vorzeichen: t.vorzeichen as "+" | "-",
          faktor: t.faktor,
          ...(t.gilt_als_erzeugung ? { gilt_als_erzeugung: true } : {}),
          ...(t.verteilung_ziel ? { verteilung_ziel: t.verteilung_ziel } : {}),
          ...(t.anteil ? { anteil: t.anteil } : {}),
        }));
        const alle = listen.flat();
        setGroessen(Object.fromEntries([
          ...alle.filter(q => q.groesse.groesse && q.groesse.richtung && q.groesse.einheit && q.groesse.wertart).map(q => [q.key, q.groesse as MessstelleGroesse]),
          ...f.terme.filter(t => t.groesse).map(t => [key(t as Term), t.groesse!]),
        ]));
        setNamen(Object.fromEntries(alle.map((q) => [q.key, q.name])));
        setQuellen(alle.filter((q) => q.passt));
        setTerme(ts);
        if (ts.some(t => t.quell_messstelle_id)) {
          const register = await api.messstellenRegister({ anlage: siteId, stichtag: heute });
          const refs = await Promise.all(ts.filter(t => t.quell_messstelle_id).map(async t => {
            const m = register.register.find(m => m.id === t.quell_messstelle_id);
            if (!m) return null;
            const ziel = t.verteilung_ziel ? (await api.messstelleVerteilung(m.id, heute)).anteile.find(a => a.kostenstelle.id === t.verteilung_ziel) : null;
            return [key(t), `${ziel ? `${ziel.kostenstelle.kennzeichen} von ` : ''}${m.kennzeichen} · ${m.name ?? ''}`] as const;
          }));
          if (aktiv) setNamen(n => ({ ...n, ...Object.fromEntries(refs.filter(r => r !== null)) }));
        }
      } catch (e) {
        if (aktiv)
          setFehler(
            e instanceof ApiError
              ? e.message
              : "Die Formel konnte nicht geladen werden.",
          );
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [siteId, messstelle.id]);
  const ableitung = terme?.length && terme.every(t => groessen[key(t)])
    ? hauptgroesse(typ, 'berechnet', 'Intervallmenge', terme.map(t => ({ ...groessen[key(t)], vorzeichen: t.vorzeichen }))) : null;
  const faktorFehler = terme?.some(t => !Number.isFinite(t.faktor) || t.faktor === 0 || ((typ === 'saldo' || t.eingang_art === 'verteilung') && t.faktor !== 1));
  const saldoFehlt = typ === 'saldo' && (terme?.length !== 2 || !terme.some(t => t.vorzeichen === '+') || !terme.some(t => t.vorzeichen === '-'));
  async function speichern() {
    if (!terme?.length || busy || faktorFehler || saldoFehlt || ableitung?.fehler || !rechte.darf("messstelle.formel") || (ab < heute && !rechte.darf("aenderung.rueckwirkend"))) return;
    setBusy(true);
    setFehler(null);
    try {
      await api.messstelleFormelFassungEintragen(messstelle.id, {
        gueltig_ab: ab,
        ...(typ === 'saldo' ? { formel_typ: typ } : {}),
        terme,
        ...(begruendung.trim() ? { begruendung: begruendung.trim() } : {}),
      });
      onGespeichert();
      onClose();
    } catch (e) {
      setFehler(
        e instanceof ApiError
          ? e.message
          : "Die Formel konnte nicht gespeichert werden.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Formel ändern · ${messstelle.name || SUMMENWERT}`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Abbrechen
          </Button>
          {rechte.darf("messstelle.formel") && <Button
            disabled={
              busy ||
              !terme?.length ||
              !ab ||
              !!faktorFehler || saldoFehlt || !!ableitung?.fehler ||
              (ab < heute && (!begruendung.trim() || !rechte.darf("aenderung.rueckwirkend"))) ||
              !rechte.darf("messstelle.formel")
            }
            onClick={() => void speichern()}
          >
            Übernehmen
          </Button>}
        </>
      }
    >
      <div className="vp-summen-dialog">
        <VpDatePicker
          label="Gültig ab"
          value={ab}
          onChange={setAb}
          min={rechte.darf("aenderung.rueckwirkend") ? undefined : heute}
        />
        <p>
          Die bisherige Formel bleibt bis zum Vortag erhalten. Die Größe des
          Werts bleibt gleich.
        </p>
        <p>{typ === 'saldo' ? 'Saldo · Bezug − Abgabe' : 'Summe'}{ableitung?.hauptgroesse && ` · ${ableitung.hauptgroesse.groesse} · ${ableitung.hauptgroesse.richtung} · ${ableitung.hauptgroesse.einheit}`}</p>
        {ableitung?.fehler && <p role="alert">Die Messgrößen passen nicht zusammen ({ableitung.grund}).</p>}
        {saldoFehlt && <p>Ein Saldo braucht beide Hauptzähler: Bezug plus, Abgabe minus.</p>}
        {ab < heute && (
          <Input
            label="Begründung für die rückwirkende Änderung"
            value={begruendung}
            onChange={(e) => setBegruendung(e.target.value)}
          />
        )}
        {terme === null && !fehler && <p>Wird geladen …</p>}
        {terme?.map((t, i) => (
          <div key={`${key(t)}:${i}`} className="vp-summen-formelterm">
            <strong>{namen[key(t)] || `Eingang ${i + 1}`}</strong>
            <VpPicker
              label={`Rechenzeichen für Eingang ${i + 1}`}
              value={t.vorzeichen}
              disabled={typ === 'saldo'}
              options={[
                { value: "+", label: "plus" },
                { value: "-", label: "minus" },
              ]}
              onChange={(v) =>
                setTerme(
                  terme.map((x, n) =>
                    n === i ? { ...x, vorzeichen: v as "+" | "-" } : x,
                  ),
                )
              }
            />
            <details>
              <summary>Feineinstellung</summary>
              <p>Ein anderer Faktor verändert den Beitrag dieses Registers.</p>
              <Input
                label={`Faktor für Eingang ${i + 1}`}
                type="number"
                disabled={typ === 'saldo' || t.eingang_art === 'verteilung'}
                step="any"
                value={t.faktor}
                onChange={(e) =>
                  setTerme(
                    terme.map((x, n) =>
                      n === i ? { ...x, faktor: Number(e.target.value) } : x,
                    ),
                  )
                }
              />
            </details>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTerme(terme.filter((_, n) => n !== i))}
            >
              Eingang entfernen
            </Button>
          </div>
        ))}
        {terme?.some(t => t.eingang_art !== 'verteilung' && t.faktor === .7) && <p>{FAKTOR_ANTEIL_HINWEIS}</p>}
        {terme && <FormelMessstellen siteId={siteId} komponenten={komponenten} typ={typ} ab={ab} terme={[]}
          onRemove={() => {}} onAdd={t => {
            const term = alsAnfrage({ ...leererFormelEntwurf(), terme: [t] }).terme[0];
            if (terme.some(x => key(x) === key(term))) return;
            setNamen(n => ({ ...n, [key(term)]: t.quelle.name }));
            setGroessen(g => ({ ...g, [key(term)]: t.quelle as MessstelleGroesse }));
            setTerme([...terme, term]);
          }} />}
        {terme && typ !== 'saldo' && (
          <VpPicker
            label="Register hinzufügen"
            value=""
            options={quellen
              .filter((q) => !terme.some((t) => key(t) === q.key))
              .map((q) => ({ value: q.key, label: q.name }))}
            onChange={(v) => {
              const q = quellen.find((x) => x.key === v);
              if (q) setTerme([...terme, q.term]);
            }}
          />
        )}
        {fehler && <p role="alert">{fehler}</p>}
      </div>
    </Modal>
  );
}
