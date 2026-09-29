package com.voltpilot.api.szenen;

import com.voltpilot.api.consumers.ConsumerPolicyActivationService;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService.ActivationOutcome;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.repo.SiteSceneRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Szenen (Konzept `docs/konzepte/steuerung`, E6): ein Tipp pausiert mehrere
 * Geräte, bis der Kunde die Szene beendet.
 *
 * <p>Die Szene erfindet keinen zweiten Schaltweg. Sie ruft je Gerät den
 * bestehenden Pausenweg ({@link ConsumerPolicyActivationService#pause}: Regel
 * zurückgezogen, Failsafe des Geräts) und beim Beenden den Fortsetzungsweg
 * ({@link ConsumerPolicyActivationService#resume}). Gemerkt wird, WELCHE
 * Geräte die Szene selbst pausiert hat: ein Gerät, das schon vorher pausiert
 * war, bleibt es auch nach dem Ende, und eines, das der Kunde zwischendurch
 * selbst fortgesetzt hat, wird nicht angefasst.
 *
 * <p>Jeder Pausen-/Fortsetzungsschritt ist seine eigene Transaktion (die des
 * Aktivierungsdienstes) - ein Schritt, der schon an die Box verteilt ist, darf
 * nicht mit einem späteren Fehler zurückrollen. Die Szene hält deshalb nach
 * jedem Lauf fest, was tatsächlich pausiert ist.
 */
@Service
public class SzenenService {

    /** {@code pausedEntityIds}: genau die Geräte, die DIESE Szene pausiert hat. */
    public record SzeneDto(String key, Instant since, List<UUID> pausedEntityIds) {}

    /**
     * Das Ergebnis eines Schaltens. {@code offen} nennt Geräte, die nicht wie
     * gewünscht folgten - mit Grund, nie still.
     */
    public record Ergebnis(SzeneDto szene, List<String> offen, String message) {}

    private final ConsumerRepository consumers;
    private final ConsumerPolicyActivationService activation;
    private final SiteSceneRepository store;

    public SzenenService(ConsumerRepository consumers, ConsumerPolicyActivationService activation,
            SiteSceneRepository store) {
        this.consumers = consumers;
        this.activation = activation;
        this.store = store;
    }

    public SzeneDto aktuell(UUID siteId) {
        return dto(store.find(siteId));
    }

    /**
     * Eine Szene einschalten. Eine laufende wird vorher beendet (höchstens eine
     * je Anlage). Alle Geräte werden VOR dem ersten Schalten geprüft, damit
     * ein unbekanntes Gerät keine halbe Szene hinterlässt.
     */
    public Ergebnis starten(UUID siteId, String key, List<UUID> geraete, String actor) {
        String wort;
        List<UUID> auswahl;
        try {
            wort = Szenen.pruefeSchluessel(key);
            auswahl = Szenen.pruefeGeraete(geraete);
        } catch (Szenen.Abgelehnt e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        if (!activation.resumeAvailable()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Verbrauchersteuerung ist auf dieser Umgebung noch nicht aktiviert - "
                            + "eine Szene könnte die Geräte danach nicht wieder fortsetzen.");
        }
        List<ConsumerRow> rows = new ArrayList<>();
        for (UUID id : auswahl) {
            ConsumerRow row = consumers.findForSite(siteId, id);
            if (row == null) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
            }
            if (consumers.activePolicy(siteId, id) == null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "„" + row.label()
                        + "\" hat noch keinen Auftrag - eine Szene schaltet nur gesteuerte Geräte aus.");
            }
            rows.add(row);
        }
        if (store.find(siteId) != null) {
            Ergebnis ende = beenden(siteId, actor);
            if (ende.szene() != null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Die laufende Szene ließ sich nicht vollständig beenden: "
                                + String.join("; ", ende.offen()));
            }
        }
        List<UUID> pausiert = new ArrayList<>();
        try {
            for (ConsumerRow row : rows) {
                if (!row.enabled()) {
                    continue; // schon vorher pausiert - bleibt es auch nach der Szene
                }
                activation.pause(siteId, row.entityId(), actor);
                pausiert.add(row.entityId());
            }
        } finally {
            // Auch bei einem Fehler mitten im Lauf: was pausiert ist, gehört der
            // Szene - sonst ließe es sich nie wieder über „Beenden" fortsetzen.
            store.upsert(siteId, wort, pausiert, actor);
        }
        return new Ergebnis(aktuell(siteId), List.of(), pausiert.isEmpty()
                ? "Szene ist an. Die gewählten Geräte waren schon pausiert."
                : "Szene ist an. " + pausiert.size() + (pausiert.size() == 1 ? " Gerät" : " Geräte")
                        + " pausiert; der sichere Zustand des Geräts gilt.");
    }

    /**
     * Die Szene beenden: genau die Geräte fortsetzen, die sie pausiert hat und
     * die noch pausiert sind. Idempotent - ohne Szene passiert nichts. Was
     * nicht fortgesetzt werden kann, bleibt in der Szene und wird benannt.
     */
    public Ergebnis beenden(UUID siteId, String actor) {
        SiteSceneRepository.Row szene = store.find(siteId);
        if (szene == null) {
            return new Ergebnis(null, List.of(), "Es ist keine Szene an.");
        }
        List<UUID> bleibt = new ArrayList<>();
        List<String> offen = new ArrayList<>();
        for (UUID id : szene.pausiert()) {
            ConsumerRow row = consumers.findForSite(siteId, id);
            if (row == null || row.enabled()) {
                continue; // gelöscht oder schon fortgesetzt
            }
            try {
                ActivationOutcome res = activation.resume(siteId, id, actor);
                if (!res.activated()) {
                    bleibt.add(id);
                    offen.add(row.label() + ": " + res.message());
                }
            } catch (ResponseStatusException e) {
                if (e.getStatusCode().value() == HttpStatus.CONFLICT.value()) {
                    // Die Regel wurde während der Szene beendet: es gibt nichts
                    // fortzusetzen, und die Szene hält das Gerät nicht länger.
                    offen.add(row.label() + ": " + e.getReason());
                } else {
                    bleibt.add(id);
                    offen.add(row.label() + ": " + e.getReason());
                }
            }
        }
        if (bleibt.isEmpty()) {
            store.delete(siteId);
        } else {
            store.setzePausiert(siteId, bleibt);
        }
        String msg = offen.isEmpty()
                ? "Szene beendet. Alles wieder wie vorher."
                : bleibt.isEmpty()
                        ? "Szene beendet. Nicht fortgesetzt: " + String.join("; ", offen)
                        : "Szene noch nicht ganz beendet: " + String.join("; ", offen);
        return new Ergebnis(bleibt.isEmpty() ? null : aktuell(siteId), offen, msg);
    }

    private static SzeneDto dto(SiteSceneRepository.Row row) {
        return row == null ? null : new SzeneDto(row.key(), row.seit(), row.pausiert());
    }
}
