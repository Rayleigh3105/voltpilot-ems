package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Canonical;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Definition;
import com.voltpilot.api.measurement.MeasurementCatalog.Point;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.Event;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.Row;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Revisioned desired-state API. This slice has deliberately no method that can
 * mark a row applied: only the later authenticated Edge-Ack consumer may do so.
 */
@Service
public class MeasurementSelectionService {

    public static final String PENDING_REASON =
            "Angefordert; wartet auf die Bestätigung der VoltPilot-Box.";

    public record Actor(String subject, String displayName) {}
    public record Change(long expectedRevision, UUID idempotencyKey, boolean enabled,
            Integer cadenceS) {}
    public record CustomChange(long expectedRevision, UUID idempotencyKey,
            Definition definition) {}

    public record SelectionPoint(String pointKey, boolean enabled, Integer cadenceS,
            long desiredRevision, Instant enabledAt, Instant disabledAt, String catalogVersion,
            String changedBy, String changedByName, Instant changedAt, String applyStatus,
            String applyReason, Instant appliedAt, JsonNode customDefinition,
            String retentionClass, int rawRetentionDays, Integer longTermCadenceS,
            String longTermStrategy, String label, String family, String group,
            String semanticStatus) {}

    public record SelectionEvent(long id, String pointKey, long desiredRevision, String eventKind,
            UUID idempotencyKey, Instant requestedAt, boolean requestedEnabled,
            Integer requestedCadenceS, Instant enabledAt, Instant disabledAt,
            String catalogVersion, String actor, String actorName, String applyStatus,
            String applyReason, Instant appliedAt, JsonNode customDefinition,
            String retentionClass, int rawRetentionDays, Integer longTermCadenceS,
            String longTermStrategy) {}

    public record State(UUID deviceId, UUID siteId, long desiredRevision, String catalogVersion,
            String status, String statusReason, String activationNotice, String disableNotice,
            List<SelectionPoint> selections, List<SelectionEvent> events,
            MeasurementBudget.Estimate volumeEstimate) {}

    private final MeasurementSelectionRepository repository;
    private final MeasurementCatalog catalog;
    private final ObjectMapper mapper;
    private final MeasurementBudgetProperties budgetProperties;

    public MeasurementSelectionService(MeasurementSelectionRepository repository,
            MeasurementCatalog catalog, ObjectMapper mapper,
            MeasurementBudgetProperties budgetProperties) {
        this.repository = repository;
        this.catalog = catalog;
        this.mapper = mapper;
        this.budgetProperties = budgetProperties;
    }

    public DeviceScope requireDevice(UUID deviceId) {
        DeviceScope scope = repository.deviceScope(deviceId);
        if (scope == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        return scope;
    }

    public State state(UUID deviceId) {
        DeviceScope scope = requireDevice(deviceId);
        return state(scope);
    }

    public Set<String> availableFamilies(UUID deviceId) {
        requireDevice(deviceId);
        return MeasurementCatalogFamilies.expand(repository.availableFamilies(deviceId),
                catalog.families());
    }

    public Map<String, Integer> selectedCadences(UUID deviceId) {
        requireDevice(deviceId);
        return repository.selectedCadences(deviceId);
    }

    public Set<String> recordedPointKeys(UUID deviceId) {
        requireDevice(deviceId);
        return repository.recordedPointKeys(deviceId);
    }

    public Map<String, MeasurementSelectionRepository.Observation> latestObservations(UUID deviceId) {
        requireDevice(deviceId);
        return repository.latestObservations(deviceId);
    }

    /** Preview one catalog-point change without writing or incrementing revision. */
    public MeasurementBudget.Estimate preview(UUID deviceId, String pointKey, boolean enabled,
            Integer cadenceS) {
        requireDevice(deviceId);
        List<Row> current = repository.current(deviceId);
        Row old = find(current, pointKey);
        Resolved resolved = resolveForChange(pointKey, enabled, cadenceS, old);
        Integer effective = enabled ? resolved.cadenceS() : old == null ? null : old.cadenceS();
        List<MeasurementBudget.Candidate> candidates = candidates(current);
        replace(candidates, new MeasurementBudget.Candidate(pointKey, enabled, effective,
                resolved.pollGroup(), resolved.requestCostMs(), resolved.retention(),
                resolved.family()));
        return estimate(candidates);
    }

    /** Preview a free register with the exact same validation/budget as create. */
    public MeasurementBudget.Estimate previewCustom(UUID deviceId, Definition definition) {
        requireDevice(deviceId);
        Canonical custom;
        MeasurementRetention retention;
        try {
            custom = CustomMeasurementPoint.validate(definition);
            retention = MeasurementRetention.ofCustomClass(custom.retentionClass());
        } catch (IllegalArgumentException e) {
            throw bad(e.getMessage());
        }
        List<MeasurementBudget.Candidate> candidates = candidates(repository.current(deviceId));
        candidates.add(new MeasurementBudget.Candidate("custom.preview", true,
                custom.cadenceS(), customPollGroup(custom), custom.requestCostMs(), retention,
                "custom"));
        return estimate(candidates);
    }

    @Transactional
    public State change(UUID deviceId, String pointKey, Change request, Actor actor) {
        if (request == null || request.idempotencyKey() == null) {
            throw bad("Für eine Auswahländerung fehlt der Idempotenzschlüssel.");
        }
        DeviceScope scope = lock(deviceId);
        List<Row> current = repository.current(deviceId);
        Row old = find(current, pointKey);
        Event previous = repository.eventByRequest(deviceId, request.idempotencyKey());
        if (previous != null) {
            // A retry must remain stable even if the canonical catalog changed
            // after the first request. A missing cadence means “the default
            // resolved by the original request”, which is the cadence stored in
            // its immutable event.
            Integer replayCadence = request.enabled()
                    ? request.cadenceS() == null ? previous.requestedCadenceS()
                            : request.cadenceS()
                    : previous.requestedCadenceS();
            ensureSame(previous, pointKey, request.enabled(), replayCadence,
                    old == null ? null : old.customDefinitionJson());
            return state(scope);
        }
        if (!request.enabled() && old == null) {
            throw bad("Dieser Messpunkt ist nicht ausgewählt.");
        }
        Integer wantedCadence = request.enabled() ? request.cadenceS() : old.cadenceS();
        Resolved resolved = resolveForChange(pointKey, request.enabled(), wantedCadence, old);
        Integer effectiveCadence = request.enabled() ? resolved.cadenceS() : old.cadenceS();

        checkRevision(deviceId, request.expectedRevision());
        List<MeasurementBudget.Candidate> candidates = candidates(current);
        replace(candidates, resolved.candidate(pointKey, request.enabled(), effectiveCadence));
        MeasurementBudget.Estimate budget = estimate(candidates);
        rejectHardBudget(budget);

        long next = request.expectedRevision() + 1;
        String version = old != null && !request.enabled()
                ? old.catalogVersion() : catalog.version();
        Row saved = repository.save(scope, pointKey, request.enabled(), effectiveCadence, next, version,
                subject(actor), display(actor), PENDING_REASON, resolved.customJson(),
                resolved.retention());
        repository.appendEvent(scope, pointKey, next, request.idempotencyKey(), request.enabled(),
                effectiveCadence, saved.enabledAt(), saved.disabledAt(), version, subject(actor),
                display(actor), PENDING_REASON, resolved.customJson(), resolved.retention());
        return state(scope);
    }

    /** Creates and enables one server-keyed, read-only free register. */
    @Transactional
    public State addCustom(UUID deviceId, CustomChange request, Actor actor) {
        if (request == null || request.idempotencyKey() == null) {
            throw bad("Für den eigenen Messwert fehlt der Idempotenzschlüssel.");
        }
        Canonical custom;
        try {
            custom = CustomMeasurementPoint.validate(request.definition());
        } catch (IllegalArgumentException e) {
            throw bad(e.getMessage());
        }
        String pointKey = "custom." + request.idempotencyKey().toString().replace("-", "");
        String customJson = json(custom);
        MeasurementRetention retention;
        try {
            retention = MeasurementRetention.ofCustomClass(custom.retentionClass());
        } catch (IllegalArgumentException e) {
            throw bad(e.getMessage());
        }
        DeviceScope scope = lock(deviceId);
        Event previous = repository.eventByRequest(deviceId, request.idempotencyKey());
        if (previous != null) {
            ensureSame(previous, pointKey, true, custom.cadenceS(), customJson);
            return state(scope);
        }
        checkRevision(deviceId, request.expectedRevision());
        List<MeasurementBudget.Candidate> candidates = candidates(repository.current(deviceId));
        MeasurementBudget.Candidate candidate = new MeasurementBudget.Candidate(pointKey, true,
                custom.cadenceS(), customPollGroup(custom), custom.requestCostMs(), retention,
                "custom");
        replace(candidates, candidate);
        MeasurementBudget.Estimate budget = estimate(candidates);
        rejectHardBudget(budget);

        long next = request.expectedRevision() + 1;
        Row saved = repository.save(scope, pointKey, true, custom.cadenceS(), next, catalog.version(),
                subject(actor), display(actor), PENDING_REASON, customJson, retention);
        repository.appendEvent(scope, pointKey, next, request.idempotencyKey(), true,
                custom.cadenceS(), saved.enabledAt(), saved.disabledAt(), catalog.version(),
                subject(actor), display(actor), PENDING_REASON, customJson, retention);
        return state(scope);
    }

    private State state(DeviceScope scope) {
        List<Row> rows = repository.current(scope.deviceId());
        List<SelectionEvent> events = repository.events(scope.deviceId(), 100).stream()
                .map(this::eventView).toList();
        long revision = events.isEmpty() ? 0 : events.get(0).desiredRevision();
        boolean pending = rows.stream().anyMatch(r -> "pending_edge".equals(r.applyStatus()));
        boolean rejected = rows.stream().anyMatch(r -> "rejected".equals(r.applyStatus()));
        List<Row> enabledRows = rows.stream().filter(Row::enabled).toList();
        boolean firstSample = !enabledRows.isEmpty() && enabledRows.stream()
                .allMatch(r -> "first_sample".equals(r.applyStatus()));
        String status = rows.isEmpty() ? "no_selection"
                : pending ? "pending_edge" : rejected ? "rejected"
                : firstSample ? "first_sample" : "applied";
        String reason = rows.isEmpty() ? "Noch keine zusätzlichen Messwerte ausgewählt."
                : pending ? PENDING_REASON
                : rejected ? rows.stream().filter(r -> "rejected".equals(r.applyStatus()))
                        .map(Row::applyReason).filter(Objects::nonNull).findFirst()
                        .orElse("Die VoltPilot-Box hat die Auswahl abgelehnt.")
                : firstSample ? "Der erste Wert aller aktiven zusätzlichen Messpunkte wurde gespeichert."
                : "Von der VoltPilot-Box bestätigt.";
        return new State(scope.deviceId(), scope.siteId(), revision, catalog.version(), status,
                reason,
                "Aufzeichnung startet serverseitig ab enabledAt; frühere Werte werden nicht ergänzt.",
                "Eine Abwahl stoppt zukünftige Proben; bisherige Werte und Auswahlereignisse bleiben erhalten.",
                rows.stream().map(this::pointView).toList(), events,
                estimate(candidates(rows)));
    }

    private SelectionPoint pointView(Row row) {
        Point p = row.customDefinitionJson() == null ? catalog.resolve(row.pointKey()) : null;
        JsonNode custom = parse(row.customDefinitionJson());
        String label = p == null ? custom == null ? null : custom.path("label").asText(null)
                : p.labelDe() == null ? p.labelSource() : p.labelDe();
        return new SelectionPoint(row.pointKey(), row.enabled(), row.cadenceS(),
                row.desiredRevision(), row.enabledAt(), row.disabledAt(), row.catalogVersion(),
                row.changedBy(), row.changedByName(), row.changedAt(), row.applyStatus(),
                row.applyReason(), row.appliedAt(), custom, row.retentionClass(),
                row.rawRetentionDays(), row.longTermCadenceS(), row.longTermStrategy(), label,
                p == null ? null : p.family(), p == null
                        ? custom == null ? "Nicht mehr im Katalog" : "Eigene Messwerte"
                        : p.group(),
                p == null ? "unknown" : p.semanticStatus());
    }

    private SelectionEvent eventView(Event e) {
        return new SelectionEvent(e.id(), e.pointKey(), e.desiredRevision(), e.eventKind(),
                e.idempotencyKey(),
                e.requestedAt(), e.requestedEnabled(), e.requestedCadenceS(), e.enabledAt(),
                e.disabledAt(), e.catalogVersion(), e.actor(), e.actorName(), e.applyStatus(),
                e.applyReason(), e.appliedAt(),
                parse(e.customDefinitionJson()), e.retentionClass(), e.rawRetentionDays(),
                e.longTermCadenceS(), e.longTermStrategy());
    }

    private List<MeasurementBudget.Candidate> candidates(List<Row> rows) {
        List<MeasurementBudget.Candidate> out = new ArrayList<>();
        for (Row row : rows) {
            if (row.customDefinitionJson() != null) {
                Resolved c = resolveCustom(row);
                out.add(c.candidate(row.pointKey(), row.enabled(), row.cadenceS()));
                continue;
            }
            Point p = catalog.resolve(row.pointKey());
            if (p == null) {
                // A removed historical catalog point remains visible but does not
                // acquire an invented request cost. Existing cadence still counts.
                out.add(new MeasurementBudget.Candidate(row.pointKey(), row.enabled(),
                        row.cadenceS(), null, MeasurementBudget.requestCostMs(null), row.retention(), null));
            } else {
                out.add(new MeasurementBudget.Candidate(row.pointKey(), row.enabled(),
                        row.cadenceS(), p.pollGroup(),
                        MeasurementBudget.requestCostMs(p.sourceKind()), row.retention(),
                        p.family()));
            }
        }
        return out;
    }

    private Resolved resolveCatalog(String pointKey, Integer requestedCadence) {
        Point point = catalog.resolve(pointKey);
        if (point == null || !point.readable()) {
            throw bad("Dieser Katalog-Messpunkt ist nicht lesbar oder unbekannt.");
        }
        Integer cadence = requestedCadence == null ? point.defaultCadenceS() : requestedCadence;
        if (cadence != null && (cadence < 1 || cadence > 86400)) {
            throw bad("Die Kadenz muss zwischen 1 Sekunde und 24 Stunden liegen.");
        }
        if (cadence != null && point.minCadenceS() != null
                && cadence < point.minCadenceS()) {
            throw bad("Die Kadenz unterschreitet die sichere Geräteempfehlung von "
                    + point.minCadenceS() + " Sekunden.");
        }
        MeasurementRetention retention = new MeasurementRetention(
                point.retention().retentionClass(), point.retention().rawRetentionDays(),
                point.retention().longTermCadenceS(), point.retention().longTermStrategy());
        return new Resolved(cadence, point.pollGroup(),
                MeasurementBudget.requestCostMs(point.sourceKind()), retention, null,
                point.family());
    }

    private Resolved resolveForChange(String pointKey, boolean enabled, Integer cadence,
            Row old) {
        if (old != null && old.customDefinitionJson() != null) {
            return resolveCustom(old);
        }
        if (!enabled && old != null) {
            // A historical catalog point may have disappeared in a later
            // catalog. Deselect must ALWAYS remain possible and must not invent
            // new metadata merely to remove its future load.
            Point known = catalog.resolve(pointKey);
            return new Resolved(old.cadenceS(), known == null ? null : known.pollGroup(),
                    known == null ? MeasurementBudget.requestCostMs(null)
                            : MeasurementBudget.requestCostMs(known.sourceKind()),
                    old.retention(), null, known == null ? null : known.family());
        }
        return resolveCatalog(pointKey, cadence);
    }

    private Resolved resolveCustom(Row row) {
        try {
            Canonical custom = mapper.readValue(row.customDefinitionJson(), Canonical.class);
            return new Resolved(row.cadenceS(), customPollGroup(custom),
                    // Never trust even a persisted/client-shaped JSON cost:
                    // re-derive the server policy on every preview/apply path.
                    MeasurementBudget.customRegisterRequestCostMs(), row.retention(),
                    row.customDefinitionJson(),
                    "custom");
        } catch (Exception e) {
            throw new IllegalStateException("stored custom measurement definition unreadable", e);
        }
    }

    private record Resolved(Integer cadenceS, String pollGroup, int requestCostMs,
            MeasurementRetention retention, String customJson, String family) {
        MeasurementBudget.Candidate candidate(String pointKey, boolean enabled, Integer cadence) {
            return new MeasurementBudget.Candidate(pointKey, enabled, cadence, pollGroup,
                    requestCostMs, retention, family);
        }
    }

    private DeviceScope lock(UUID deviceId) {
        DeviceScope scope = repository.lockDevice(deviceId);
        if (scope == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        return scope;
    }

    private void checkRevision(UUID deviceId, long expected) {
        long actual = repository.revision(deviceId);
        if (expected != actual) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Messwertauswahl wurde inzwischen geändert (erwartet " + expected
                            + ", aktuell " + actual + "). Bitte Status neu laden.");
        }
    }

    private void ensureSame(Event previous, String pointKey, boolean enabled,
            Integer cadence, String customJson) {
        if (!previous.pointKey().equals(pointKey)
                || previous.requestedEnabled() != enabled
                || !Objects.equals(previous.requestedCadenceS(), cadence)
                || !jsonEquals(previous.customDefinitionJson(), customJson)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Idempotenzschlüssel wurde bereits für eine andere Änderung verwendet.");
        }
    }

    private boolean jsonEquals(String a, String b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        try {
            // jsonb is free to reorder object keys. Idempotency compares the
            // definition semantically, never by serialization order.
            return mapper.readTree(a).equals(mapper.readTree(b));
        } catch (Exception e) {
            return false;
        }
    }

    private static void rejectHardBudget(MeasurementBudget.Estimate budget) {
        if (budget.hardRejected()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Technisches Messwertbudget überschritten: "
                            + String.join(" ", budget.reasons())
                            + " Bitte eine langsamere Kadenz wählen; es gibt kein Punktzahl-Limit.");
        }
    }

    private MeasurementBudget.Estimate estimate(List<MeasurementBudget.Candidate> candidates) {
        return MeasurementBudget.estimate(candidates, budgetProperties.driverSampleLimits());
    }

    private static Row find(List<Row> rows, String pointKey) {
        return rows.stream().filter(r -> r.pointKey().equals(pointKey)).findFirst().orElse(null);
    }

    private static void replace(List<MeasurementBudget.Candidate> list,
            MeasurementBudget.Candidate candidate) {
        list.removeIf(c -> c.pointKey().equals(candidate.pointKey()));
        list.add(candidate);
    }

    private String json(Canonical value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("custom measurement definition not serializable", e);
        }
    }

    private JsonNode parse(String json) {
        if (json == null) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private static String customPollGroup(Canonical c) {
        return "custom:" + c.sourceKind() + ":" + c.address();
    }

    private static String subject(Actor actor) {
        return actor == null || actor.subject() == null ? "unbekannt" : actor.subject();
    }

    private static String display(Actor actor) {
        return actor == null ? null : actor.displayName();
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
