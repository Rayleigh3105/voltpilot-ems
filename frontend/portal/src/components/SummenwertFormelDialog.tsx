import { useEffect, useState } from "react";
import { Button } from "../../designsystem/components/core/Button";
import { Input } from "../../designsystem/components/forms/Input";
import { Modal } from "../../designsystem/components/shell/Modal";
import {
  api,
  ApiError,
  type BerechneteMessstelleAnlegen,
  type Messstelle,
} from "../api";
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
          api.messstelleFormel(messstelle.id),
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
              passt:
                k.groesse === f.hauptgroesse?.groesse &&
                k.wertart === f.hauptgroesse?.wertart &&
                k.richtung === f.hauptgroesse?.richtung,
            }));
          }),
        );
        if (!aktiv) return;
        const ts = f.terme.map((t) => ({
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
        setNamen(Object.fromEntries(alle.map((q) => [q.key, q.name])));
        setQuellen(alle.filter((q) => q.passt));
        setTerme(ts);
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
  async function speichern() {
    if (!terme?.length || busy || !rechte.darf("messstelle.formel") || (ab < heute && !rechte.darf("aenderung.rueckwirkend"))) return;
    setBusy(true);
    setFehler(null);
    try {
      await api.messstelleFormelFassungEintragen(messstelle.id, {
        gueltig_ab: ab,
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
                min="0"
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
        {terme && (
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
