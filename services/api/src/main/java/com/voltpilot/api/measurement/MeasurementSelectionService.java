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

    public record SelectionPoint(UUID entityId, String pointKey, boolean enabled, Integer cadenceS,
            long desiredRevision, Instant enabledAt, Instant disabledAt, String catalogVersion,
            String changedBy, String changedByName, Instant changedAt, String applyStatus,
            String applyReason, Instant appliedAt, JsonNode customDefinition,
            String retentionClass, int rawRetentionDays, Integer longTermCadenceS,
            String longTermStrategy, String label, String family, String group,
            String semanticStatus) {}

    public record SelectionEvent(long id, UUID entityId, String pointKey, long desiredRevision,
            String eventKind,
            UUID idempotencyKey, Instant requestedAt, boolean requestedEnabled,
            Integer requestedCadenceS, Instant enabledAt, Instant disabledAt,
            String catalogVersion, String actor, String actorName, String applyStatus,
            String applyReason, Instant appliedAt, JsonNode customDefinition,
            String retentionClass, int rawRetentionDays, Integer longTermCadenceS,
            String longTermStrategy) {}

    /**
     * {@code entityId} echoes the component this view is scoped to; null means
     * the whole device (the pre-3b box semantics). {@code desiredRevision} and
     * {@code volumeEstimate} stay DEVICE-wide even in a component view: the
     * revision is the optimistic-concurrency token of the one published plan,
     * and the budget is the physical load of the one bus.
     */
    public record State(UUID deviceId, UUID siteId, UUID entityId, long desiredRevision,
            String catalogVersion,
            String status, String statusReason, String activationNotice, String disableNotice,
            List<SelectionPoint> selections, List<SelectionEvent> events,
            MeasurementBudget.Estimate volumeEstimate) {}

    private final MeasurementSelectionRepository repository;
    private final com.voltpilot.api.entities.EinmalAuftragZiel ziel;
    private final MeasurementCatalog catalog;
    private final ObjectMapper mapper;
    private final MeasurementBudgetProperties budgetProperties;

    public MeasurementSelectionService(MeasurementSelectionRepository repository,
            MeasurementCatalog catalog, ObjectMapper mapper,
            MeasurementBudgetProperties budgetProperties, com.voltpilot.api.entities.EinmalAuftragZiel ziel) {
        this.repository = repository;
        this.ziel = ziel;
        this.catalog = catalog;
        this.mapper = mapper;
        this.budgetProperties = budgetProperties;
    }

    public DeviceScope requireDevice(UUID deviceId) {
        DeviceScope scope = repository.aktiverDeviceScope(deviceId);
        if (scope == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        return scope;
    }

    /**
     * Resolves the optional component a selection belongs to. It must be
     * RLS-visible AND stand at the device's own site; a component of another
     * plant is 404, never a silently accepted owner. It deliberately does NOT
     * require {@code measurement_point.device_id} to match: every component the
     * assistant or a takeover creates carries no device_id at all, and those are
     * exactly the ones a device page must be able to observe.
     */
    public UUID requireEntity(DeviceScope scope, UUID entityId) {
        if (entityId == null) {
            return null;
        }
        UUID siteId = repository.entitySiteId(entityId);
        if (siteId == null || !siteId.equals(scope.siteId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Komponente nicht gefunden.");
        }
        return entityId;
    }

    /** Validate the requested box/site fence first, then follow the component's execution. */
    public UUID deviceForEntity(UUID deviceId, UUID entityId) {
        DeviceScope scope = requireDevice(deviceId);
        requireEntity(scope, entityId);
        return entityId == null ? deviceId : ziel.komponente(scope.siteId(), entityId).id();
    }

    /** Retained full plans must never re-enable a component on its former box. */
    public State forPublishing(UUID deviceId) {
        State state = state(deviceId);
        Map<UUID, Boolean> owners = new java.util.HashMap<>();
        List<SelectionPoint> points = state.selections().stream().filter(p -> p.entityId() == null
                || owners.computeIfAbsent(p.entityId(), entity -> {
                    try {
                        return deviceId.equals(ziel.komponente(state.siteId(), entity).id());
                    } catch (ResponseStatusException e) {
                        if (e.getStatusCode().value() != 404 && e.getStatusCode().value() != 409) throw e;
                        return false;
                    }
                })).toList();
        return new State(state.deviceId(), state.siteId(), state.entityId(), state.desiredRevision(),
                state.catalogVersion(), state.status(), state.statusReason(), state.activationNotice(),
                state.disableNotice(), points, state.events(), state.volumeEstimate());
    }

    public static State notDelivered(State state, String reason) {
        return new State(state.deviceId(), state.siteId(), state.entityId(), state.desiredRevision(),
                state.catalogVersion(), state.status(), reason, state.activationNotice(),
                state.disableNotice(), state.selections(), state.events(), state.volumeEstimate());
    }

    /** The whole device (the pre-3b box semantics). */
    public State state(UUID deviceId) {
        return state(deviceId, null);
    }

    public State state(UUID deviceId, UUID entityId) {
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = requireDevice(deviceId);
        return state(scope, requireEntity(scope, entityId));
    }

    public Set<String> availableFamilies(UUID deviceId, UUID entityId) {
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = requireDevice(deviceId);
        return MeasurementCatalogFamilies.expand(
                repository.availableFamilies(deviceId, requireEntity(scope, entityId)),
                catalog.families());
    }

    public Map<String, Integer> selectedCadences(UUID deviceId, UUID entityId) {
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = requireDevice(deviceId);
        return repository.selectedCadences(deviceId, requireEntity(scope, entityId));
    }

    /**
     * Device-wide on purpose: samples are stored per (device, point_key) and
     * carry no component dimension before Stufe 3c. Claiming a per-component
     * "already recorded" would be an invented precision.
     */
    public Set<String> recordedPointKeys(UUID deviceId) {
        requireDevice(deviceId);
        return repository.recordedPointKeys(deviceId);
    }

    public Map<String, MeasurementSelectionRepository.Observation> latestObservations(UUID deviceId) {
        requireDevice(deviceId);
        return repository.latestObservations(deviceId);
    }

    /**
     * Preview one catalog-point change without writing or incrementing revision.
     * The candidate set stays DEVICE-wide - the bus budget is physical - while
     * the replaced candidate is the one of THIS component.
     */
    public MeasurementBudget.Estimate preview(UUID deviceId, UUID entityId, String pointKey,
            boolean enabled, Integer cadenceS) {
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = requireDevice(deviceId);
        UUID entity = requireEntity(scope, entityId);
        List<Row> current = repository.current(deviceId);
        Row old = find(current, entity, pointKey);
        Resolved resolved = resolveForChange(pointKey, enabled, cadenceS, old);
        Integer effective = enabled ? resolved.cadenceS() : old == null ? null : old.cadenceS();
        List<MeasurementBudget.Candidate> candidates = candidates(current);
        replace(candidates, new MeasurementBudget.Candidate(candidateKey(entity, pointKey),
                enabled, effective,
                resolved.pollGroup(), resolved.requestCostMs(), resolved.retention(),
                resolved.family()));
        return estimate(candidates);
    }

    /** Preview a free register with the exact same validation/budget as create. */
    public MeasurementBudget.Estimate previewCustom(UUID deviceId, UUID entityId,
            Definition definition) {
        deviceId = deviceForEntity(deviceId, entityId);
        requireEntity(requireDevice(deviceId), entityId);
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
    public State change(UUID deviceId, UUID entityId, String pointKey, Change request,
            Actor actor) {
        if (request == null || request.idempotencyKey() == null) {
            throw bad("Für eine Auswahländerung fehlt der Idempotenzschlüssel.");
        }
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = lock(deviceId);
        UUID entity = requireEntity(scope, entityId);
        List<Row> current = repository.current(deviceId);
        Row old = find(current, entity, pointKey);
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
            ensureSame(previous, entity, pointKey, request.enabled(), replayCadence,
                    old == null ? null : old.customDefinitionJson());
            return state(scope, entity);
        }
        if (!request.enabled() && old == null) {
            throw bad("Dieser Messpunkt ist nicht ausgewählt.");
        }
        Integer wantedCadence = request.enabled() ? request.cadenceS() : old.cadenceS();
        Resolved resolved = resolveForChange(pointKey, request.enabled(), wantedCadence, old);
        Integer effectiveCadence = request.enabled() ? resolved.cadenceS() : old.cadenceS();

        checkRevision(deviceId, request.expectedRevision());
        List<MeasurementBudget.Candidate> candidates = candidates(current);
        replace(candidates, resolved.candidate(candidateKey(entity, pointKey), request.enabled(),
                effectiveCadence));
        MeasurementBudget.Estimate budget = estimate(candidates);
        rejectHardBudget(budget);

        long next = request.expectedRevision() + 1;
        String version = old != null && !request.enabled()
                ? old.catalogVersion() : catalog.version();
        Row saved = repository.save(scope, entity, pointKey, request.enabled(), effectiveCadence,
                next, version,
                subject(actor), display(actor), PENDING_REASON, resolved.customJson(),
                resolved.retention());
        repository.appendEvent(scope, entity, pointKey, next, request.idempotencyKey(),
                request.enabled(),
                effectiveCadence, saved.enabledAt(), saved.disabledAt(), version, subject(actor),
                display(actor), PENDING_REASON, resolved.customJson(), resolved.retention());
        return state(scope, entity);
    }

    /** Creates and enables one server-keyed, read-only free register. */
    @Transactional
    public State addCustom(UUID deviceId, UUID entityId, CustomChange request, Actor actor) {
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
        deviceId = deviceForEntity(deviceId, entityId);
        DeviceScope scope = lock(deviceId);
        UUID entity = requireEntity(scope, entityId);
        Event previous = repository.eventByRequest(deviceId, request.idempotencyKey());
        if (previous != null) {
            ensureSame(previous, entity, pointKey, true, custom.cadenceS(), customJson);
            return state(scope, entity);
        }
        checkRevision(deviceId, request.expectedRevision());
        List<MeasurementBudget.Candidate> candidates = candidates(repository.current(deviceId));
        MeasurementBudget.Candidate candidate = new MeasurementBudget.Candidate(
                candidateKey(entity, pointKey), true,
                custom.cadenceS(), customPollGroup(custom), custom.requestCostMs(), retention,
                "custom");
        replace(candidates, candidate);
        MeasurementBudget.Estimate budget = estimate(candidates);
        rejectHardBudget(budget);

        long next = request.expectedRevision() + 1;
        Row saved = repository.save(scope, entity, pointKey, true, custom.cadenceS(), next,
                catalog.version(),
                subject(actor), display(actor), PENDING_REASON, customJson, retention);
        repository.appendEvent(scope, entity, pointKey, next, request.idempotencyKey(), true,
                custom.cadenceS(), saved.enabledAt(), saved.disabledAt(), catalog.version(),
                subject(actor), display(actor), PENDING_REASON, customJson, retention);
        return state(scope, entity);
    }

    private State state(DeviceScope scope, UUID entityId) {
        List<Row> all = repository.current(scope.deviceId());
        List<Row> rows = entityId == null ? all
                : all.stream().filter(r -> entityId.equals(r.entityId())).toList();
        List<SelectionEvent> events = repository.events(scope.deviceId(), entityId, 100).stream()
                .map(this::eventView).toList();
        // The revision is the DEVICE-wide concurrency token of the one published
        // plan, so a component view must not report its own last event number.
        long revision = repository.revision(scope.deviceId());
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
        return new State(scope.deviceId(), scope.siteId(), entityId, revision, catalog.version(),
                status,
                reason,
                "Aufzeichnung startet serverseitig ab enabledAt; frühere Werte werden nicht ergänzt.",
                "Eine Abwahl stoppt zukünftige Proben; bisherige Werte und Auswahlereignisse bleiben erhalten.",
                rows.stream().map(this::pointView).toList(), events,
                // The bus budget is physical: it always counts the whole device.
                estimate(candidates(all)));
    }

    private SelectionPoint pointView(Row row) {
        Point p = row.customDefinitionJson() == null ? catalog.resolve(row.pointKey()) : null;
        JsonNode custom = parse(row.customDefinitionJson());
        String label = p == null ? custom == null ? null : custom.path("label").asText(null)
                : p.labelDe() == null ? p.labelSource() : p.labelDe();
        return new SelectionPoint(row.entityId(), row.pointKey(), row.enabled(), row.cadenceS(),
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
        return new SelectionEvent(e.id(), e.entityId(), e.pointKey(), e.desiredRevision(),
                e.eventKind(),
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
            String key = candidateKey(row.entityId(), row.pointKey());
            if (row.customDefinitionJson() != null) {
                Resolved c = resolveCustom(row);
                out.add(c.candidate(key, row.enabled(), row.cadenceS()));
                continue;
            }
            Point p = catalog.resolve(row.pointKey());
            if (p == null) {
                // A removed historical catalog point remains visible but does not
                // acquire an invented request cost. Existing cadence still counts.
                out.add(new MeasurementBudget.Candidate(key, row.enabled(),
                        row.cadenceS(), null, MeasurementBudget.requestCostMs(null), row.retention(), null));
            } else {
                out.add(new MeasurementBudget.Candidate(key, row.enabled(),
                        row.cadenceS(), p.pollGroup(),
                        MeasurementBudget.requestCostMs(p.sourceKind(), p.family()), row.retention(),
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
                MeasurementBudget.requestCostMs(point.sourceKind(), point.family()), retention, null,
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
                            : MeasurementBudget.requestCostMs(known.sourceKind(), known.family()),
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
        MeasurementBudget.Candidate candidate(String candidateKey, boolean enabled,
                Integer cadence) {
            return new MeasurementBudget.Candidate(candidateKey, enabled, cadence, pollGroup,
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

    private void ensureSame(Event previous, UUID entityId, String pointKey, boolean enabled,
            Integer cadence, String customJson) {
        if (!previous.pointKey().equals(pointKey)
                || !Objects.equals(previous.entityId(), entityId)
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

    private static Row find(List<Row> rows, UUID entityId, String pointKey) {
        return rows.stream()
                .filter(r -> r.pointKey().equals(pointKey)
                        && Objects.equals(r.entityId(), entityId))
                .findFirst().orElse(null);
    }

    /**
     * The identity a budget candidate is deduplicated by. Without a component
     * it is the bare point key - byte-identical to the pre-3b budget - and with
     * one it is scoped, so two identical inverters behind one box are counted
     * as the two reads they will be from Stufe 3c on.
     */
    private static String candidateKey(UUID entityId, String pointKey) {
        return entityId == null ? pointKey : entityId + "|" + pointKey;
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
