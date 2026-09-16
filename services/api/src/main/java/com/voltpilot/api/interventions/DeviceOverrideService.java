package com.voltpilot.api.interventions;

import com.voltpilot.api.consumers.ConsumerAuditRepository;
import com.voltpilot.api.consumers.ConsumerOverridePublisher;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.interventions.Handeingriff.Abgelehnt;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Handeingriff an einer KOMPONENTE und die „Automatik pausieren"-Sperre
 * einer Anlage (Steuerung Stufe 4, §3.7 B1/B2/B4/B5) - die
 * entitäts-agnostische Verallgemeinerung von
 * {@link com.voltpilot.api.consumers.ConsumerOverrideService}, das für
 * Verbraucher unverändert bestehen bleibt.
 *
 * <p><b>Es entsteht KEIN zweiter Steuerweg.</b> Der Speicher-Eingriff reist über
 * GENAU denselben {@code v2/desired}-Umschlag wie die Verbraucher-Sofortaktion
 * ({@link ConsumerOverridePublisher}, Quelle {@code local-ui}, Klasse
 * {@code flow} mit {@code override}, gebundener TTL) und wird auf dem Gerät
 * durch DIESELBE Guard-Kette geklemmt. Neu ist nur, WELCHE Komponente
 * angesprochen wird und dass eine Anlage als GANZES pausieren kann.
 *
 * <p><b>Die zwei Zusagen, die die Fläche daraus ableiten darf:</b>
 * <ol>
 *   <li>Ein Eingriff hat IMMER ein Ende (§16) - die Dauer ist Pflicht, die
 *       Rücknahme jederzeit möglich, und ohne Erneuerung verfällt der Wunsch
 *       auf dem Gerät von selbst.</li>
 *   <li>Er hebelt NICHTS aus: Netzvorgaben (§ 14a), die Einspeise-Wache, die
 *       Abregelung, der Geräteschutz und die EEG-Solarladen-Regel liegen alle
 *       UNTERHALB der Arbitrierung in der Guard-Kette und binden weiter.</li>
 * </ol>
 */
@Service
public class DeviceOverrideService {

    private static final Logger log = LoggerFactory.getLogger(DeviceOverrideService.class);

    /** Was ein Aufruf bewirkt hat - die Fläche rendert es wörtlich. */
    public record Outcome(boolean applied, boolean pushed, String kind, Instant endsAt,
            BigDecimal effectivePowerKw, boolean ttlRenewed, String message, String pushReason) {}

    private final DeviceOverrideRepository overrides;
    private final EntityRegistryRepository entities;
    private final com.voltpilot.api.entities.EinmalAuftragZiel ziel;
    private final ConsumerAuditRepository audit;
    private final ObjectProvider<ConsumerOverridePublisher> publisher;
    private final ObjectProvider<EntityRegistryService> registry;

    public DeviceOverrideService(DeviceOverrideRepository overrides,
            EntityRegistryRepository entities, ConsumerAuditRepository audit,
            ObjectProvider<ConsumerOverridePublisher> publisher,
            ObjectProvider<EntityRegistryService> registry, com.voltpilot.api.entities.EinmalAuftragZiel ziel) {
        this.overrides = overrides;
        this.entities = entities;
        this.ziel = ziel;
        this.audit = audit;
        this.publisher = publisher;
        this.registry = registry;
    }

    // -- Speicher: „Ladestand halten" / „Speicher jetzt laden" ----------------

    @Transactional
    public Outcome startBattery(UUID siteId, Handeingriff.Anfrage req, String actor) {
        String kind = req == null ? null : req.kind();
        if (!Handeingriff.istSpeicher(kind)) {
            throw badRequest("Unbekannter Eingriff. Erlaubt sind \"" + Handeingriff.HALTEN
                    + "\" und \"" + Handeingriff.LADEN + "\".");
        }
        EntityRegistryRepository.EntityRow battery = batteryEntity(siteId);
        EntityRegistryRepository.BatteryAsset asset = entities.batteryAsset(siteId);
        Instant now = Instant.now();
        Instant endsAt = refuseTo(() -> Handeingriff.ende(req, now));
        BigDecimal value = refuseTo(() -> Handeingriff.sollwert(kind, req.setpointKw(),
                asset == null ? null : asset.maxChargeKw()));

        UUID device = ziel.komponente(siteId, battery.id()).id();
        overrides.putForEntity(siteId, battery.id(), kind, value, endsAt, actor);
        audit.append(siteId, battery.id(), "device_override_started", null, null, actor,
                kind + " bis " + endsAt);

        String reason = publishBattery(siteId, battery.id(), device, value,
                Handeingriff.ttlSekunden(endsAt, now), now);
        boolean pushed = reason == null;
        boolean renewed = endsAt.isAfter(now.plus(Handeingriff.TTL_KAPPE));
        return new Outcome(true, pushed, kind, endsAt, value, renewed,
                message(kind, pushed, renewed) + deliveryMessage(reason), reason);
    }

    @Transactional
    public Outcome clearBattery(UUID siteId, String actor) {
        EntityRegistryRepository.EntityRow battery = batteryEntity(siteId);
        UUID device = ziel.komponente(siteId, battery.id()).id();
        overrides.clearEntity(siteId, battery.id());
        audit.append(siteId, battery.id(), "device_override_cleared", null, null, actor, null);
        String reason = withdraw(siteId, battery.id(), device);
        boolean pushed = reason == null;
        return new Outcome(true, pushed, "resume", null, null, false,
                pushed ? "Der Eingriff ist beendet. Fahrplan und Regeln übernehmen wieder."
                        : "Das Beenden ist notiert." + deliveryMessage(reason), reason);
    }

    // -- Anlage: „Automatik pausieren" ---------------------------------------

    /**
     * Pausiert Fahrplan UND Regeln der ganzen Anlage für die gewählte Dauer.
     *
     * <p><b>⚠ Der Weg ist der REGISTRY-PUSH, nicht ein Wunsch je Komponente</b>
     * (eine argumentierte Abweichung von der Skizze in §3.7 B5): der Speicher
     * soll in der Pause den EIGENVERBRAUCH fahren („so, als gäbe es VoltPilot
     * nicht"), und diese Zahl (PV − Last) kann nur die Box rechnen - die Cloud
     * hätte einen Wert erfinden müssen. Über die Sperre im Push fällt jede
     * Komponente stattdessen auf ihren REGISTRY-FAILSAFE, und der ist für den
     * Speicher genau `self-consumption` und für ein Gerät `release`/`off`.
     * Zusätzlich ist die Sperre damit dieselbe Mechanik wie die Stufe-3-
     * Beanspruchung - eine Sache, nicht zwei.
     *
     * <p><b>Was NICHT pausiert:</b> Messen, die Guard-Kette, § 14a, die
     * Abregelung und die Einspeise-Wache. Sie liegen unterhalb der
     * Arbitrierung und werden von der Sperre nicht einmal berührt.
     *
     * <p><b>⚠ Ruht die Anlage bis zum Start (R0, UEMS AP-01 IP-4), gibt es hier nichts zu
     * pausieren:</b> eine Pause mit Ende würde die Ruhe bis auf Widerruf VERKÜRZEN. Die Zeile
     * bleibt unberührt, und die Antwort ist 409 statt einer Erfolgsmeldung, die nicht stimmt.
     */
    @Transactional
    public Outcome pause(UUID siteId, Handeingriff.Anfrage req, String actor) {
        Instant now = Instant.now();
        Instant endsAt = refuseTo(() -> Handeingriff.ende(req, now));
        if (!overrides.putPause(siteId, endsAt, actor)) {
            throw inRuhe();
        }
        audit.append(siteId, null, "automation_paused", null, null, actor, "bis " + endsAt);
        String reason = pushRegistry(siteId);
        boolean pushed = reason == null;
        return new Outcome(true, pushed, Handeingriff.PAUSE, endsAt, null, false,
                pushed
                        ? "Die Automatik pausiert. Ihre Anlage versorgt sich weiter selbst, "
                                + "Schutz und Netzvorgaben bleiben aktiv."
                        : "Die Pause ist notiert, konnte aber gerade nicht an Ihre Anlage "
                                + "gesendet werden." + deliveryMessage(reason), reason);
    }

    /**
     * „Automatik fortsetzen" beendet NUR die Pause von Hand. Die Ruhe bis zum Start (R0) hebt
     * allein „Steuerung starten“ auf - hier bleibt sie stehen, und die Antwort ist 409.
     */
    @Transactional
    public Outcome resume(UUID siteId, String actor) {
        if (overrides.clearPause(siteId) == 0
                && overrides.activePause(siteId).filter(DeviceOverrideRepository.Row::ausFunktion)
                        .isPresent()) {
            throw inRuhe();
        }
        audit.append(siteId, null, "automation_resumed", null, null, actor, null);
        String reason = pushRegistry(siteId);
        boolean pushed = reason == null;
        return new Outcome(true, pushed, "resume", null, null, false,
                pushed ? "Die Automatik läuft wieder. Der nächste Fahrplan greift sofort."
                        : "Das Fortsetzen ist notiert." + deliveryMessage(reason), reason);
    }

    // -- Lesepfad -------------------------------------------------------------

    /** Jeder LEBENDE Eingriff dieser Anlage (abgelaufene lesen als abwesend). */
    public List<DeviceOverrideRepository.Row> active(UUID siteId) {
        return overrides.active(siteId);
    }

    /** Läuft gerade eine Pause? Der Registry-Push fragt genau das. */
    public boolean paused(UUID siteId) {
        return overrides.activePause(siteId).isPresent();
    }

    // -- helpers ---------------------------------------------------------------

    private static ResponseStatusException inRuhe() {
        return new ResponseStatusException(HttpStatus.CONFLICT,
                "Diese Anlage ist in Ruhe, bis ihre Steuerung gestartet wird.");
    }

    private EntityRegistryRepository.EntityRow batteryEntity(UUID siteId) {
        for (EntityRegistryRepository.EntityRow row : entities.entitiesForSite(siteId)) {
            if ("battery-hybrid".equals(row.entityType())) {
                return row;
            }
        }
        throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Diese Anlage hat keinen steuerbaren Speicher.");
    }

    private String publishBattery(UUID siteId, UUID entityId, UUID device,
            BigDecimal value, int ttlSeconds, Instant now) {
        ConsumerOverridePublisher pub = publisher.getIfAvailable();
        if (pub == null) return "publisher_unavailable";
        return pub.publishOverride(TenantContext.get(), siteId, device, entityId, null, value,
                ttlSeconds, now) ? null : "publish_failed";
    }

    private String withdraw(UUID siteId, UUID entityId, UUID device) {
        ConsumerOverridePublisher pub = publisher.getIfAvailable();
        if (pub == null) return "publisher_unavailable";
        return pub.publishWithdraw(TenantContext.get(), siteId, device, entityId)
                ? null : "publish_failed";
    }

    /** Die Sperre reist weiterhin an alle zuständigen Boxen im Registry-Push. */
    private String pushRegistry(UUID siteId) {
        ziel.fuehrend(siteId);
        EntityRegistryService svc = registry.getIfAvailable();
        if (svc == null) return "publisher_unavailable";
        EntityRegistryService.PushOutcome outcome = svc.pushRegistryBestEffort(siteId);
        if (!outcome.published()) {
            log.warn("device override for site {} not pushed: {}", siteId, outcome.reason());
            return outcome.reason() == null ? "publish_failed" : outcome.reason();
        }
        return null;
    }

    private static String deliveryMessage(String reason) {
        if (reason == null) return "";
        return "publisher_unavailable".equals(reason)
                ? " Die Zustellung ist derzeit nicht verfügbar."
                : " Die Zustellung an die Box ist fehlgeschlagen; die Ausführung ist nicht bestätigt.";
    }

    private static String message(String kind, boolean pushed, boolean renewed) {
        if (!pushed) {
            return "Der Eingriff ist notiert, konnte aber gerade nicht an Ihre Anlage gesendet "
                    + "werden. VoltPilot versucht es weiter.";
        }
        String base = Handeingriff.HALTEN.equals(kind)
                ? "Der Speicher hält seinen Ladestand."
                : "Der Speicher lädt jetzt.";
        return renewed
                ? base + " VoltPilot hält den Eingriff bis zum gewählten Ende aufrecht."
                : base;
    }

    private static <T> T refuseTo(Supplier<T> body) {
        try {
            return body.get();
        } catch (Abgelehnt e) {
            throw badRequest(e.getMessage());
        }
    }

    private static ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
