import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../designsystem/components/core/Button";
import { Card } from "../../designsystem/components/core/Card";
import { Input } from "../../designsystem/components/forms/Input";
import { Modal } from "../../designsystem/components/shell/Modal";
import { api, ApiError, type GeraetSummenwert } from "../api";
import { SUMMENWERT } from "../glossar";
import { wertText } from "../gesamtwert";
import { useRollen } from "../rollen";
import { ROLLEN } from "../uemsRollen";
import { RowMenu } from "./RowMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProtokollDialog, PROTOKOLL_LABEL } from "./ProtokollDialog";
import { RolleAendernDialog } from "./RolleAendernDialog";
import { SummenwertFormelDialog } from "./SummenwertFormelDialog";
import { SummenwertAssistent } from "./SummenwertAssistent";
import "./GeraetSummenwerte.css";

type Zeile = GeraetSummenwert & { entityId: string };

export function GeraetSummenwerte({
  siteId,
  deviceId,
  entityId,
  entityIds,
  geraetName,
  onZuordnungGeaendert,
}: {
  siteId: string;
  deviceId: string;
  entityId: string;
  entityIds?: string[];
  geraetName: string;
  onZuordnungGeaendert?: () => void;
}) {
  const rechte = useRollen();
  const [zeilen, setZeilen] = useState<Zeile[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [offen, setOffen] = useState(false);
  const [rolle, setRolle] = useState<Zeile | null>(null);
  const [formel, setFormel] = useState<Zeile | null>(null);
  const [name, setName] = useState<{ zeile: Zeile; name: string } | null>(null);
  const [archiv, setArchiv] = useState<Zeile | null>(null);
  const [protokoll, setProtokoll] = useState(false);
  const [busy, setBusy] = useState(false);
  const wurzel = useRef<HTMLDivElement>(null);
  const ladeVersion = useRef(0);
  const ids = [...new Set(entityIds?.length ? entityIds : [entityId])]
    .sort()
    .join(",");
  const laden = useCallback(async () => {
    const version = ++ladeVersion.current;
    setFehler(null);
    try {
      const listen = await Promise.all(
        ids
          .split(",")
          .map(async (id) =>
            (await api.geraetSummenwerte(siteId, id)).map((z) => ({
              ...z,
              entityId: id,
            })),
          ),
      );
      if (version !== ladeVersion.current) return;
      const aus = new Map<string, Zeile>();
      for (const z of listen.flat())
        if (!aus.has(z.messstelle.id) || z.rolle) aus.set(z.messstelle.id, z);
      setZeilen([...aus.values()]);
    } catch (e) {
      if (version === ladeVersion.current)
        setFehler(
          e instanceof ApiError
            ? e.message
            : "Die Summenwerte konnten nicht geladen werden.",
        );
    }
  }, [siteId, ids]);
  useEffect(() => {
    setZeilen(null);
    void laden();
    return () => {
      ladeVersion.current++;
    };
  }, [laden]);
  // Bis der gemeinsame Öffnen-Hook auf uems liegt, bleibt der heutige Assistent gekapselt.
  function oeffneSummenwertAssistent() {
    setOffen(true);
  }
  function geaendert() {
    void laden();
    onZuordnungGeaendert?.();
  }
  function oeffne(z: Zeile, aktion: () => void) {
    // Der Menüeintrag verschwindet. Das bleibende Zeilenmenü ist der Rückkehr-Auslöser, auch auf iOS.
    wurzel.current
      ?.querySelector<HTMLElement>(
        `[data-summenwert="${z.messstelle.id}"] button[aria-haspopup="menu"]`,
      )
      ?.focus();
    aktion();
  }
  async function speichern(aktion: () => Promise<unknown>, danach: () => void) {
    setBusy(true);
    setFehler(null);
    try {
      await aktion();
      danach();
      geaendert();
    } catch (e) {
      setFehler(
        e instanceof ApiError
          ? e.message
          : "Die Änderung konnte nicht gespeichert werden.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div ref={wurzel}>
      <Card padding="md" radius="md">
        <div className="vp-summen-head">
          <h3>Summenwerte dieses Geräts</h3>
          {rechte.darf("messstelle.formel") && (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.currentTarget.focus();
                oeffneSummenwertAssistent();
              }}
            >
              {SUMMENWERT} anlegen
            </Button>
          )}
        </div>
        {fehler && <p role="alert">{fehler}</p>}
        {zeilen === null && !fehler && (
          <p className="vp-muted">Wird geladen …</p>
        )}
        {zeilen?.length === 0 && (
          <p className="vp-muted">
            Aus den Registern dieses Geräts einen {SUMMENWERT} bilden.
          </p>
        )}
        <ul className="vp-summen-liste">
          {zeilen?.map((z) => (
            <li
              key={z.messstelle.id}
              data-summenwert={z.messstelle.id}
              className="vp-summen-zeile"
            >
              <div className="vp-summen-inhalt">
                <strong>{z.messstelle.name || SUMMENWERT}</strong>
                <div>
                  {z.wert.wert === null
                    ? "—"
                    : wertText(z.wert.wert, z.wert.einheit ?? "")}
                  {z.wert.unvollstaendig && " · unvollständig"}
                  {" · "}
                  {z.wert.stand
                    ? `Stand ${new Date(z.wert.stand).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} Uhr`
                    : "Stand unbekannt"}
                </div>
                <div className="vp-summen-meta">
                  <span className="vp-summen-chip">
                    {z.rolle ? ROLLEN[z.rolle] : "ohne Rolle"}
                  </span>
                  <span>berechnet</span>
                  <span>{z.messstelle.kennzeichen}</span>
                </div>
              </div>
              {[
                "geraet.einrichten",
                "messstelle.formel",
                "messstelle.bearbeiten",
              ].some((a) => rechte.darf(a)) && (
                <RowMenu
                  label={`Aktionen für ${z.messstelle.name || SUMMENWERT}`}
                  items={[
                    {
                      recht: "geraet.einrichten",
                      label: "Rolle ändern",
                      icon: "sliders",
                      onClick: () => oeffne(z, () => setRolle(z)),
                    },
                    {
                      recht: "messstelle.formel",
                      label: "Formel ändern ab Tag",
                      icon: "calendar",
                      onClick: () => oeffne(z, () => setFormel(z)),
                    },
                    {
                      recht: "messstelle.bearbeiten",
                      label: "Umbenennen",
                      icon: "pencil",
                      onClick: () =>
                        oeffne(z, () =>
                          setName({ zeile: z, name: z.messstelle.name ?? "" }),
                        ),
                    },
                    {
                      recht: "messstelle.bearbeiten",
                      label: "Archivieren",
                      icon: "trash",
                      danger: true,
                      onClick: () => oeffne(z, () => setArchiv(z)),
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
        {rechte.darf("aenderungsprotokoll.lesen") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.currentTarget.focus();
              setProtokoll(true);
            }}
          >
            {PROTOKOLL_LABEL} der Anlage
          </Button>
        )}
        {rolle && (
          <RolleAendernDialog
            key={rolle.messstelle.id}
            siteId={siteId}
            entityId={rolle.entityId}
            zeile={rolle}
            onClose={() => setRolle(null)}
            onGespeichert={geaendert}
          />
        )}
        {formel && (
          <SummenwertFormelDialog
            siteId={siteId}
            messstelle={formel.messstelle}
            onClose={() => setFormel(null)}
            onGespeichert={geaendert}
          />
        )}
        {name && (
          <Modal
            open
            title={`${SUMMENWERT} umbenennen`}
            onClose={() => {
              if (!busy) setName(null);
            }}
            footer={
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setName(null)}
                >
                  Abbrechen
                </Button>
                <Button
                  disabled={busy || !name.name.trim()}
                  onClick={() =>
                    void speichern(
                      () =>
                        api.messstelleBearbeiten(name.zeile.messstelle.id, {
                          kennzeichen: name.zeile.messstelle.kennzeichen,
                          name: name.name.trim(),
                          notiz: name.zeile.messstelle.notiz ?? undefined,
                          anschlussleistung_kw:
                            name.zeile.messstelle.anschlussleistung_kw,
                        }),
                      () => setName(null),
                    )
                  }
                >
                  Speichern
                </Button>
              </>
            }
          >
            <Input
              label="Name"
              value={name.name}
              onChange={(e) => setName({ ...name, name: e.target.value })}
            />
            {fehler && <p role="alert">{fehler}</p>}
          </Modal>
        )}
        <ConfirmDialog
          open={!!archiv}
          title={`„${archiv?.messstelle.name || SUMMENWERT}“ archivieren?`}
          intro="Der Wert verschwindet aus der Liste. Seine bisherigen Werte bleiben erhalten."
          consequences={[
            "Eine zugeordnete Rolle liefert danach keinen aktuellen Wert mehr. Entziehen Sie die Rolle vorher, wenn wieder der ursprüngliche Wert gelten soll.",
          ]}
          confirmLabel="Archivieren"
          busy={busy}
          tone="danger"
          onCancel={() => setArchiv(null)}
          extra={fehler ? <p role="alert">{fehler}</p> : undefined}
          onConfirm={() => {
            if (archiv)
              void speichern(
                () => api.messstelleArchivieren(archiv.messstelle.id),
                () => setArchiv(null),
              );
          }}
        />
        <ProtokollDialog
          open={protokoll}
          titel="Anlage"
          ziel={protokoll ? { art: "anlage", id: siteId } : null}
          optionen={{ achse: "eintrag" }}
          onClose={() => setProtokoll(false)}
        />
        <SummenwertAssistent
          open={offen}
          siteId={siteId}
          deviceId={deviceId}
          entityId={entityId}
          geraetName={geraetName}
          bestehend={null}
          onClose={() => setOffen(false)}
          onGespeichert={geaendert}
        />
      </Card>
    </div>
  );
}
