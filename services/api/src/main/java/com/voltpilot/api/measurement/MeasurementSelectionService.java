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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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

    /** Ein WAGO-Kartenpunkt mit Kartentyp und Index ({@code wago.pm495.karte[2].…} oder die Vorlage {@code [*]}). */
    private static final Pattern WAGO_KARTENPUNKT =
            Pattern.compile("^wago\\.pm(494|495)\\.karte\\[(\\d{1,3}|\\*)]\\.");
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

    /** Wer die Anstoß-Revision im Verlauf der Auswahl anfordert (AP-07 IP-18b Einschalten). */
    public static final String ANSTOSS_AKTEUR = "system:plan-je-komponente";
    public static final String ANSTOSS_NAME = "VoltPilot";
    public static final String ANSTOSS_GRUND =
            "Die Box hat ihre Fähigkeit für den Plan je Komponente geändert; der Plan wird neu ausgeliefert.";

    /**
     * Revisions-Anstoß (AP-07 IP-18b Einschalten): die Box hat
     * {@link MeasurementConfigPublisher#FAEHIGKEIT_JE_KOMPONENTE} neu gemeldet oder verloren. Ihr
     * Core weist dieselbe Revision mit anderem Inhalt als {@code stale revision} ab und kann selbst
     * keine erzeugen - darum legt die Cloud Revision + 1 an, und der
     * {@link MeasurementConfigReconciler} liefert den Plan in der Form aus, die die Box jetzt kann.
     *
     * <p>Nur wenn beide Formen verschieden sind, also ein geteilter Punkt besteht: sonst sind die
     * Bytes beider Formen gleich, und die Box behält ihre Revision. Die Revision trägt EIN Ereignis
     * {@code selection_requested} (der Schlüssel {@code (device_id, desired_revision, event_kind)}
     * erlaubt genau eines) an der ersten aktiven Zeile des geteilten Punkts mit ihren eigenen
     * Werten; keine Auswahlzeile wird geändert, und die Quittung dieser Revision schreibt ihr
     * {@code edge_ack} wie jede andere. Eigene Transaktion: der Aufruf kommt nach dem Commit der
     * Fähigkeitsmeldung ({@link MessplanRevisionsAnstoss}).
     *
     * @return die neue Revision, {@code 0} ohne Anstoß
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public long planNeuAusliefern(UUID deviceId) {
        DeviceScope scope = repository.lockDevice(deviceId);
        if (scope == null) return 0;
        List<SelectionPoint> punkte = forPublishing(deviceId).selections();
        List<MeasurementPlan.Entry> jeKomponente = MeasurementPlan.composeJeKomponente(punkte, Map.of());
        if (jeKomponente.equals(MeasurementPlan.compose(punkte, Map.of()))) return 0;
        Map<String, Long> vorkommen = new java.util.HashMap<>();
        for (MeasurementPlan.Entry e : jeKomponente) vorkommen.merge(e.pointKey(), 1L, Long::sum);
        Row anker = repository.current(deviceId).stream()
                .filter(r -> r.enabled() && r.entityId() != null && vorkommen.getOrDefault(r.pointKey(), 0L) > 1
                        && punkte.stream().anyMatch(p -> p.enabled() && r.entityId().equals(p.entityId())
                                && r.pointKey().equals(p.pointKey())))
                .min(java.util.Comparator.comparing((Row r) -> r.pointKey())
                        .thenComparing(r -> r.entityId().toString()))
                .orElse(null);
        if (anker == null) return 0;
        long next = repository.revision(deviceId) + 1;
        repository.appendEvent(scope, anker.entityId(), anker.pointKey(), next,
                UUID.nameUUIDFromBytes(("plan-je-komponente:" + deviceId + ":" + next)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                true, anker.cadenceS(), anker.enabledAt(), null, anker.catalogVersion(),
                ANSTOSS_AKTEUR, ANSTOSS_NAME, ANSTOSS_GRUND, anker.customDefinitionJson(),
                anker.retention());
        return next;
    }

    /** Wer die Katalogstand-Revision im Verlauf der Auswahl anfordert (Generalprobe B2). */
    public static final String KATALOGSTAND_AKTEUR = "system:katalogstand";
    public static final String KATALOGSTAND_GRUND = "Die VoltPilot-Box hat den Messplan wegen eines anderen "
            + "Katalogstands abgelehnt (etwa nach ihrem Update); der Plan wird im aktuellen Katalogstand neu "
            + "ausgeliefert.";
    /** Das Wort des Status-Vertrags, mit dem die Box einen Plan fremden Katalogstands ablehnt. */
    static final String UNSUPPORTED_CATALOG = "unsupported_catalog";

    /** Der Katalogstand, den der Publisher heute in jeden Plan schreibt. */
    public String katalogstand() {
        return catalog.version();
    }

    /**
     * Nachlieferung nach einem Box-Update (Generalprobe B2): die Box hat ihre letzte Revision mit
     * {@code unsupported_catalog} abgelehnt, und diese Revision trug einen ANDEREN Katalogstand als den,
     * den die Cloud heute ausliefert. So sieht es aus, wenn der Core nach dem Update den gespeicherten Plan
     * alten Stands wieder einspielt und die neue Palette ihn ablehnt: die Ablehnung zählt als Quittung,
     * nichts ist offen, und ohne neue Revision bliebe die Box ohne Messplan, bis jemand ihre Auswahl ändert.
     * Die Box nennt ihren Laufzeitstand nicht; das Urteil „ihr Stand passt nicht zu dieser Revision“ ist
     * die Ablehnung selbst.
     *
     * <p>Legt Revision + 1 an, deren EIN {@code selection_requested} den heutigen Katalogstand trägt; der
     * {@link MeasurementConfigReconciler} liefert sie aus. Keine Auswahlzeile ändert sich. Ohne Schleife:
     * lehnt die Box auch diese Revision ab (eine Box OHNE Update gegen die neue Cloud), trägt die letzte
     * Revision schon den heutigen Stand, und es kommt keine weitere. Nichts, solange eine Revision offen
     * ist - die liefert der Reconciler ohnehin im heutigen Stand aus.
     *
     * @return die neue Revision, {@code 0} ohne Nachlieferung
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public long planImKatalogstandNeuAusliefern(UUID deviceId) {
        DeviceScope scope = repository.lockDevice(deviceId);
        if (scope == null) return 0;
        long revision = repository.revision(deviceId);
        if (revision == 0 || repository.acknowledgedRevision(deviceId) < revision) return 0;
        if (catalog.version().equals(repository.katalogstandDerRevision(deviceId, revision))) return 0;
        Row anker = repository.current(deviceId).stream()
                .filter(r -> r.enabled() && "rejected".equals(r.applyStatus())
                        && UNSUPPORTED_CATALOG.equals(r.applyReason()))
                .min(java.util.Comparator.comparing((Row r) -> r.pointKey())
                        .thenComparing(r -> r.entityId() == null ? "" : r.entityId().toString()))
                .orElse(null);
        if (anker == null) return 0;
        long next = revision + 1;
        repository.appendEvent(scope, anker.entityId(), anker.pointKey(), next,
                UUID.nameUUIDFromBytes(("katalogstand:" + deviceId + ":" + next)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                true, anker.cadenceS(), anker.enabledAt(), null, catalog.version(),
                KATALOGSTAND_AKTEUR, ANSTOSS_NAME, KATALOGSTAND_GRUND, anker.customDefinitionJson(),
                anker.retention());
        return next;
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
        if (enabled) pointKey = wagoKartenIndex(entity, pointKey);
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
        // Abwählen bleibt immer möglich, auch für eine ältere Auswahl mit `karte[*]`.
        if (request.enabled()) pointKey = wagoKartenIndex(entity, pointKey);
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

    /**
     * Ein WAGO-Kartenpunkt wählt die Karte SEINER Komponente: Karte n im Registerbild = n-te heute
     * eingebaute Karte des Controllers nach Steckplatz. Die Vorlage {@code karte[*]} dehnte der Planer
     * mit {@code entity_id} auf ALLE Karten des Controllers aus (Befund PR 1139); sie wird hier zum
     * konkreten Index. Ein anderer Index, ein anderer Kartentyp oder eine Komponente ohne Karte mit
     * Steckplatz werden abgelehnt — nie geraten.
     */
    private String wagoKartenIndex(UUID entity, String pointKey) {
        Matcher m = WAGO_KARTENPUNKT.matcher(pointKey == null ? "" : pointKey);
        if (!m.find()) return pointKey;
        MeasurementSelectionRepository.WagoKarte karte = repository.wagoKarte(entity);
        if (karte == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Zuerst die Energiekarte mit ihrem Steckplatz zuordnen.");
        }
        Matcher typ = WagoRegisterbilder.TYP.matcher(karte.typ() == null ? "" : karte.typ());
        if (typ.find() && !typ.group(1).equals(m.group(1))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Diese Komponente steckt in einer 750-"
                    + typ.group(1) + ", der Messpunkt gehört zur 750-" + m.group(1) + ".");
        }
        if (!m.group(2).equals("*") && Integer.parseInt(m.group(2)) != karte.index()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Diese Komponente ist Karte "
                    + karte.index() + " im Registerbild ihres Controllers.");
        }
        return pointKey.substring(0, m.start(2)) + karte.index() + pointKey.substring(m.end(2));
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
