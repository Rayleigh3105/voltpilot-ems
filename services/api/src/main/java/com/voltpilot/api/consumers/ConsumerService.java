package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerRepository.PolicyRow;
import com.voltpilot.api.consumers.ConsumerRepository.ReportedSource;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.entities.EntityTypeCatalog.EntityType;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BerichtsBelege;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The consumer master-data + policy service (docs/verbrauchssteuerung.md §11,
 * Increment 1). A controllable consumer STAYS a v2 entity - it is created via
 * {@link EntityRegistryService} (so it gets proper capabilities/guards and a
 * registry push) and augmented with the extra facts in {@code consumer_profile}.
 * All reads/writes go through the RLS-scoped app datasource; the tenant is the
 * fence and comes from {@link TenantContext}, never from a body field (§16).
 *
 * <p>Increment 1 ships master data + CRUD + draft policies only: there is no
 * compiler, optimizer or edge command. The requested control kind is mapped onto
 * the INTERSECTION of the device type's reported capabilities (§16) - a customer
 * value can never widen a hardware capability. Every surface reports the control
 * activation as "not_activated" ("Steuerung noch nicht aktiviert").
 */
@Service
public class ConsumerService {

    /** Consumer entity types the assistant may create (catalog category=consumer, controllable). */
    private static final Set<String> STORAGE_RELATIONS = Set.of("consumer_first", "storage_first");
    private static final Set<String> GRID_POLICIES = Set.of("allow", "avoid", "forbid");
    private static final Set<String> FAILSAFES = Set.of("off", "release");
    private static final Set<String> CONTROL_KINDS = Set.of("on_off", "stepped", "continuous");

    private final ConsumerRepository repo;
    private final EntityRegistryService entities;
    private final EntityTypeCatalog catalog;
    private final ConsumerSignalCatalog signals;
    private final ConsumerPolicyValidator validator;
    private final ObjectMapper mapper;
    private final JdbcTemplate jdbc;
    private final ConsumerAuditRepository audit;
    private final ConsumerPolicyActivationService activation;
    private final BerichtsBelege berichtsBelege;

    public ConsumerService(ConsumerRepository repo, EntityRegistryService entities,
            EntityTypeCatalog catalog, ConsumerSignalCatalog signals,
            ConsumerPolicyValidator validator, ObjectMapper mapper, JdbcTemplate jdbc,
            ConsumerAuditRepository audit, ConsumerPolicyActivationService activation,
            BerichtsBelege berichtsBelege) {
        this.repo = repo;
        this.entities = entities;
        this.catalog = catalog;
        this.signals = signals;
        this.validator = validator;
        this.mapper = mapper;
        this.jdbc = jdbc;
        this.audit = audit;
        this.activation = activation;
        this.berichtsBelege = berichtsBelege;
    }

    // --- DTOs ----------------------------------------------------------------

    public record ConsumerDto(UUID id, String type, String typeLabel, String name,
            String controlKind, BigDecimal ratedPowerKw, BigDecimal minPowerKw, JsonNode levelsKw,
            BigDecimal resolutionKw, JsonNode powerRangesKw, String storageRelation,
            String defaultGridEnergyPolicy, boolean allowStorageDischarge, String failsafe,
            boolean enabled, long version, String connection, String edgeSourceId,
            String controlActivation, boolean hasDraftPolicy, Integer draftPolicyVersion,
            Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay,
            String confirmationChannel, UUID ioEntityId, Integer ioChannel) {}

    /**
     * {@code ioEntityId}/{@code ioChannel} binden den neuen Verbraucher an
     * einen Relais-Ausgang eines I/O-Moduls (Alternative zu
     * {@code edgeSourceId}: ein Modul ist EINE Quelle für N Verbraucher).
     */
    public record CreateConsumerRequest(String type, String name, BigDecimal ratedPowerKw,
            String controlKind, JsonNode levelsKw, BigDecimal minPowerKw, BigDecimal resolutionKw,
            JsonNode powerRangesKw, String storageRelation, String defaultGridEnergyPolicy,
            Boolean allowStorageDischarge, String failsafe, String edgeSourceId,
            Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay,
            UUID ioEntityId, Integer ioChannel) {

        /** The pre-binding request shape (no I/O-module channel). */
        public CreateConsumerRequest(String type, String name, BigDecimal ratedPowerKw,
                String controlKind, JsonNode levelsKw, BigDecimal minPowerKw,
                BigDecimal resolutionKw, JsonNode powerRangesKw, String storageRelation,
                String defaultGridEnergyPolicy, Boolean allowStorageDischarge, String failsafe,
                String edgeSourceId, Integer minOnSeconds, Integer minOffSeconds,
                Integer maxStartsPerDay) {
            this(type, name, ratedPowerKw, controlKind, levelsKw, minPowerKw, resolutionKw,
                    powerRangesKw, storageRelation, defaultGridEnergyPolicy, allowStorageDischarge,
                    failsafe, edgeSourceId, minOnSeconds, minOffSeconds, maxStartsPerDay, null,
                    null);
        }
    }

    public record PatchConsumerRequest(String name, BigDecimal ratedPowerKw, String controlKind,
            JsonNode levelsKw, BigDecimal minPowerKw, BigDecimal resolutionKw, JsonNode powerRangesKw,
            String storageRelation, String defaultGridEnergyPolicy, Boolean allowStorageDischarge,
            String failsafe, Boolean enabled, Long expectedVersion,
            Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay) {}

    /**
     * {@code ratedPowerRequired} ist die SERVER-Wahrheit darüber, ob die
     * Nennleistung angegeben werden muss (P8): die SG-Ready-Wärmepumpe darf sie
     * weglassen, weil sie über sie nichts steuert und nichts nachweist. Das
     * Portal liest sie statt den Typ ein zweites Mal zu kennen; ein älterer
     * Client ohne das Feld verlangt sie weiterhin überall.
     */
    public record TypeOption(String type, String label, List<String> controlKinds,
            String defaultFailsafe, boolean releaseAllowed, List<String> intents,
            boolean ratedPowerRequired) {}

    public record SignalOption(String name, String label, String signalClass, String valueType) {}

    public record ReportedSourceDto(String sourceId, String label, String brand, String role,
            boolean measuresPower, String health) {}

    public record IntentOption(String key, String title, String customerLine) {}

    public record ConsumerOptionsDto(List<TypeOption> types, List<SignalOption> signals,
            List<IntentOption> intents, boolean hasStorage, List<ReportedSourceDto> reportedSources,
            String defaultStorageRelation, String defaultGridEnergyPolicy,
            boolean policyActivationEnabled, List<IoModuleOption> ioModules) {}

    /**
     * Ein I/O-Modul der Anlage als Schaltweg-Angebot. {@code outputs} ist die
     * Zahl der Relais-Ausgänge, die das Modul zuletzt GEMELDET hat - {@code null},
     * solange es nichts gemeldet hat (nie eine geratene 8). {@code used} nennt
     * die schon vergebenen Ausgänge samt Verbraucher.
     */
    public record IoModuleOption(UUID entityId, String label, Integer outputs,
            List<IoChannelUse> used) {}

    public record IoChannelUse(int channel, UUID consumerId, String consumerName) {}

    /**
     * Ein Kanal eines I/O-Moduls: {@code on} ist der zuletzt GEMELDETE Zustand
     * ({@code null} = im Fenster nicht gemeldet), bei einem Ausgang samt dem
     * Verbraucher, der ihn schaltet.
     */
    public record IoChannelState(int channel, Boolean on, UUID consumerId, String consumerName) {}

    /**
     * Der Zustand eines I/O-Moduls. {@code receivedAt} ist die jüngste Meldung
     * ({@code null} = seit zehn Minuten keine) - die Fläche nennt das Alter,
     * statt einen alten Zustand als aktuell zu zeigen.
     */
    public record IoModuleStateDto(UUID entityId, String label, List<IoChannelState> inputs,
            List<IoChannelState> outputs, java.time.Instant receivedAt) {}

    public record PolicyDto(UUID entityId, int version, String lifecycle, JsonNode document,
            String contentHash, String createdBy) {}

    public record SavePolicyRequest(JsonNode document) {}

    // --- reads ---------------------------------------------------------------

    public List<ConsumerDto> list(UUID siteId) {
        List<ConsumerDto> out = new ArrayList<>();
        for (ConsumerRow row : repo.listForSite(siteId)) {
            out.add(toDto(siteId, row));
        }
        return out;
    }

    public ConsumerDto get(UUID siteId, UUID entityId) {
        ConsumerRow row = repo.findForSite(siteId, entityId);
        if (row == null) {
            throw notFound();
        }
        return toDto(siteId, row);
    }

    /** Capability-/context-filtered options for the Anlagen-Modell assistant (§11/§14.4). */
    public ConsumerOptionsDto options(UUID siteId) {
        List<TypeOption> types = new ArrayList<>();
        for (EntityType t : catalog.all()) {
            if (!"consumer".equals(t.category()) || !t.controllable() || t.composed()) {
                continue;
            }
            types.add(new TypeOption(t.type(), t.label(), allowedControlKinds(t),
                    t.defaultFailsafe(), "release".equals(t.defaultFailsafe()), intentsFor(t.type()),
                    !SgReady.ratedPowerOptional(t.type())));
        }
        List<SignalOption> sig = signals.all().stream()
                .map(s -> new SignalOption(s.name(), s.label(), s.signalClass(), s.valueType()))
                .toList();
        List<ReportedSourceDto> reported = repo.reportedSources(siteId).stream()
                .filter(s -> !s.bound())
                .map(s -> new ReportedSourceDto(s.sourceId(), s.label(), s.brand(), s.role(),
                        s.measuresPower(), s.health()))
                .toList();
        List<IoModuleOption> ioModules = new ArrayList<>();
        for (ConsumerRepository.IoModule m : repo.ioModules(siteId)) {
            List<IoChannelUse> used = repo.ioChannelUses(siteId, m.entityId()).stream()
                    .map(u -> new IoChannelUse(u.channel(), u.consumerId(), u.consumerName()))
                    .toList();
            ioModules.add(new IoModuleOption(m.entityId(), m.label(), m.reportedOutputs(), used));
        }
        return new ConsumerOptionsDto(types, sig, INTENTS, siteHasStorage(siteId), reported,
                "consumer_first", "allow", activation.activationAvailable(), ioModules);
    }

    // --- create --------------------------------------------------------------

    @Transactional
    public ConsumerDto create(UUID siteId, CreateConsumerRequest req) {
        EntityType type = catalog.find(req.type());
        if (type == null || !"consumer".equals(type.category()) || !type.controllable()
                || type.composed()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Verbraucherart kennt VoltPilot nicht.");
        }
        String controlKind = req.controlKind() == null ? defaultControlKind(type) : req.controlKind();
        if (!CONTROL_KINDS.contains(controlKind)) {
            throw badRequest("Unbekannte Regelart.");
        }
        if (!allowedControlKinds(type).contains(controlKind)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieses Gerät kann diese Regelart nicht ausführen.");
        }
        // ⚠ Die Nennleistung ist für die SG-Ready-Wärmepumpe OPTIONAL (P8): sie
        // ist eine Angabe ÜBER die Pumpe, kein Steuerwert - geschaltet wird ein
        // Freigabe-Kontakt, und "Nennleistung × Zeit" wäre dort eine erfundene
        // Energie. Für jeden anderen Typ bleibt sie Pflicht.
        BigDecimal rated = req.ratedPowerKw();
        if (rated != null && rated.signum() <= 0) {
            throw badRequest("Die Nennleistung muss größer als 0 sein.");
        }
        if (rated == null && !SgReady.ratedPowerOptional(req.type())) {
            throw badRequest("Die Nennleistung muss größer als 0 sein.");
        }
        String failsafe = req.failsafe() == null ? type.defaultFailsafe() : req.failsafe();
        if (!FAILSAFES.contains(failsafe)) {
            throw badRequest("Unbekanntes Ausfallverhalten.");
        }
        if ("release".equals(failsafe) && !"release".equals(type.defaultFailsafe())) {
            throw badRequest("Dieses Gerät erlaubt kein \"Weiterlaufen\" bei Ausfall.");
        }
        String storageRelation = orDefault(req.storageRelation(), "consumer_first");
        if (!STORAGE_RELATIONS.contains(storageRelation)) {
            throw badRequest("Unbekannte Speicher-Reihenfolge.");
        }
        String gridPolicy = orDefault(req.defaultGridEnergyPolicy(), "allow");
        if (!GRID_POLICIES.contains(gridPolicy)) {
            throw badRequest("Unbekannte Netzstrom-Einstellung.");
        }
        // Validate the control-profile shape (levels / ranges / D4) via the ONE
        // validator, exactly the rules the TS twin enforces.
        validateProfileShape(controlKind, rated, req.minPowerKw(), req.levelsKw(),
                req.resolutionKw(), req.powerRangesKw());

        String name = req.name() == null || req.name().isBlank() ? type.label() : req.name().trim();

        if (req.edgeSourceId() != null && !req.edgeSourceId().isBlank()
                && repo.edgeSourceBound(siteId, req.edgeSourceId())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieses Gerät ist bereits einem Verbraucher zugeordnet.");
        }
        boolean ioBound = requireFreeIoChannel(siteId, req);

        Integer minOn = validatedCycleSeconds(req.minOnSeconds(), "Mindestlaufzeit");
        Integer minOff = validatedCycleSeconds(req.minOffSeconds(), "Mindestpause");
        Integer maxStarts = validatedMaxStarts(req.maxStartsPerDay());

        EntityRow entity = entities.createEntity(siteId, req.type(), name, rated, null, null);
        UUID entityId = entity.id();

        String confirmationChannel = null;
        if (req.edgeSourceId() != null && !req.edgeSourceId().isBlank()) {
            repo.bindEdgeSource(siteId, entityId, req.edgeSourceId().trim());
            confirmationChannel =
                    confirmationChannelFor(siteId, req.type(), req.edgeSourceId().trim());
        } else if (ioBound) {
            // Ein Relais-Ausgang misst keine Leistung: die Laufzeit bestätigt
            // der Rücklese-Zustand des Ausgangs (Stufe 3), die Energie bleibt
            // angenommen - und ein SG-Ready-Kontakt behält seine eigene Stufe.
            String typeChannel = SgReady.confirmationChannel(req.type());
            confirmationChannel = typeChannel != null ? typeChannel : "relay_state";
        }

        repo.insertProfile(entityId, TenantContext.get(), siteId, controlKind, rated,
                req.minPowerKw(), toJsonText(req.levelsKw()), req.resolutionKw(),
                toJsonText(req.powerRangesKw()), storageRelation, gridPolicy,
                Boolean.TRUE.equals(req.allowStorageDischarge()), failsafe,
                minOn, minOff, maxStarts, confirmationChannel);
        if (ioBound) {
            repo.bindIoChannel(siteId, entityId, req.ioEntityId(), req.ioChannel());
        }

        // createEntity pushed the registry BEFORE the profile existed; the
        // cycle-guard limits ride the push (D-9), and a channel binding IS the
        // consumer's driver - push again so the edge knows both from the start.
        if (minOn != null || minOff != null || maxStarts != null || ioBound) {
            entities.pushRegistryBestEffort(siteId);
        }

        return get(siteId, entityId);
    }

    /**
     * Prüft die Kanal-Bindung eines neuen Verbrauchers: das Ziel ist ein
     * I/O-Modul DIESER Anlage, der Ausgang liegt im Bereich und gehört noch
     * keinem anderen Verbraucher. Eine Bindung schließt die Quellen-Nadel aus
     * (ein Verbraucher hat genau EINEN Schaltweg).
     *
     * @return ob der Verbraucher an einen Ausgang gebunden wird
     */
    private boolean requireFreeIoChannel(UUID siteId, CreateConsumerRequest req) {
        if (req.ioEntityId() == null && req.ioChannel() == null) {
            return false;
        }
        if (req.ioEntityId() == null || req.ioChannel() == null) {
            throw badRequest("Für einen Ausgang des I/O-Moduls werden Modul und Ausgang benötigt.");
        }
        if (req.edgeSourceId() != null && !req.edgeSourceId().isBlank()) {
            throw badRequest("Ein Verbraucher wird entweder über ein eigenes Gerät oder über "
                    + "einen Ausgang des I/O-Moduls geschaltet, nicht über beides.");
        }
        if (req.ioChannel() < 1 || req.ioChannel() > 256) {
            throw badRequest("Den Ausgang " + req.ioChannel() + " gibt es nicht.");
        }
        List<String> type = jdbc.queryForList(
                "SELECT entity_type FROM measurement_point WHERE site_id = ? AND id = ?",
                String.class, siteId, req.ioEntityId());
        if (type.isEmpty() || !IO_MODULE_TYPE.equals(type.get(0))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Das gewählte Gerät ist kein I/O-Modul dieser Anlage.");
        }
        if (repo.ioChannelOwner(siteId, req.ioEntityId(), req.ioChannel()) != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Ausgang " + req.ioChannel() + " ist bereits einem Verbraucher zugeordnet.");
        }
        return true;
    }

    /** Der Entitätstyp eines I/O-Moduls (entitytypes/catalog.json). */
    static final String IO_MODULE_TYPE = "io-module";

    /** Die zuletzt gemeldeten Ein-/Ausgänge eines I/O-Moduls samt Zuordnung. */
    public IoModuleStateDto ioModuleState(UUID siteId, UUID ioEntityId) {
        String label = repo.ioModuleLabel(siteId, ioEntityId);
        if (label == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "I/O-Modul nicht gefunden.");
        }
        java.util.Map<Integer, Boolean> in = new java.util.TreeMap<>();
        java.util.Map<Integer, Boolean> out = new java.util.TreeMap<>();
        java.time.Instant latest = null;
        for (ConsumerRepository.IoChannelSample s : repo.ioModuleSamples(siteId, ioEntityId)) {
            Integer k = channelIndex(s.channel());
            if (k == null) {
                continue;
            }
            (s.channel().startsWith("di_") ? in : out).put(k, s.value() >= 0.5);
            if (latest == null || s.receivedAt().isAfter(latest)) {
                latest = s.receivedAt();
            }
        }
        java.util.Map<Integer, ConsumerRepository.IoChannelUse> used = new java.util.HashMap<>();
        for (ConsumerRepository.IoChannelUse u : repo.ioChannelUses(siteId, ioEntityId)) {
            used.put(u.channel(), u);
            out.putIfAbsent(u.channel(), null);
        }
        List<IoChannelState> inputs = new ArrayList<>();
        in.forEach((k, v) -> inputs.add(new IoChannelState(k, v, null, null)));
        List<IoChannelState> outputs = new ArrayList<>();
        out.forEach((k, v) -> {
            ConsumerRepository.IoChannelUse u = used.get(k);
            outputs.add(new IoChannelState(k, v, u == null ? null : u.consumerId(),
                    u == null ? null : u.consumerName()));
        });
        return new IoModuleStateDto(ioEntityId, label.isBlank() ? null : label, inputs, outputs,
                latest);
    }

    /** {@code di_12} -> 12; {@code null} für alles andere. */
    private static Integer channelIndex(String channel) {
        int u = channel == null ? -1 : channel.indexOf('_');
        if (u < 0) {
            return null;
        }
        try {
            int k = Integer.parseInt(channel.substring(u + 1));
            return k >= 1 && k <= 256 ? k : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * Cycle-guard bounds (§4.2/§13.1): optional, non-negative, sanity-capped
     * (a week of seconds). 0 clears the bound (no invented protection).
     */
    private static Integer validatedCycleSeconds(Integer v, String label) {
        if (v == null) {
            return null;
        }
        if (v < 0 || v > 7 * 86400) {
            throw badRequest("Die " + label + " muss zwischen 0 und 604800 Sekunden liegen.");
        }
        return v == 0 ? null : v;
    }

    private static Integer validatedMaxStarts(Integer v) {
        if (v == null) {
            return null;
        }
        if (v < 0 || v > 1000) {
            throw badRequest("Die maximale Anzahl Starts pro Tag muss zwischen 0 und 1000 liegen.");
        }
        return v == 0 ? null : v;
    }

    // --- patch ---------------------------------------------------------------

    @Transactional
    public ConsumerDto patch(UUID siteId, UUID entityId, PatchConsumerRequest req) {
        ConsumerRow cur = repo.findForSite(siteId, entityId);
        if (cur == null) {
            throw notFound();
        }
        if (req.expectedVersion() != null && req.expectedVersion() != cur.version()) {
            throw versionConflict(cur.version());
        }
        EntityType type = catalog.find(cur.entityType());
        String controlKind = orDefault(req.controlKind(), cur.controlKind());
        if (!CONTROL_KINDS.contains(controlKind)) {
            throw badRequest("Unbekannte Regelart.");
        }
        if (type != null && !allowedControlKinds(type).contains(controlKind)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieses Gerät kann diese Regelart nicht ausführen.");
        }
        BigDecimal rated = req.ratedPowerKw() != null ? req.ratedPowerKw() : cur.ratedPowerKw();
        if (rated != null && rated.signum() <= 0) {
            throw badRequest("Die Nennleistung muss größer als 0 sein.");
        }
        if (rated == null && !SgReady.ratedPowerOptional(cur.entityType())) {
            throw badRequest("Die Nennleistung muss größer als 0 sein.");
        }
        String failsafe = orDefault(req.failsafe(), cur.failsafe());
        if (!FAILSAFES.contains(failsafe)) {
            throw badRequest("Unbekanntes Ausfallverhalten.");
        }
        if ("release".equals(failsafe) && type != null
                && !"release".equals(type.defaultFailsafe())) {
            throw badRequest("Dieses Gerät erlaubt kein \"Weiterlaufen\" bei Ausfall.");
        }
        String storageRelation = orDefault(req.storageRelation(), cur.storageRelation());
        if (!STORAGE_RELATIONS.contains(storageRelation)) {
            throw badRequest("Unbekannte Speicher-Reihenfolge.");
        }
        String gridPolicy = orDefault(req.defaultGridEnergyPolicy(), cur.defaultGridEnergyPolicy());
        if (!GRID_POLICIES.contains(gridPolicy)) {
            throw badRequest("Unbekannte Netzstrom-Einstellung.");
        }
        JsonNode levels = req.levelsKw() != null ? req.levelsKw() : parse(cur.levelsKwJson());
        JsonNode ranges = req.powerRangesKw() != null ? req.powerRangesKw()
                : parse(cur.powerRangesKwJson());
        BigDecimal minPower = req.minPowerKw() != null ? req.minPowerKw() : cur.minPowerKw();
        BigDecimal resolution = req.resolutionKw() != null ? req.resolutionKw() : cur.resolutionKw();
        validateProfileShape(controlKind, rated, minPower, levels, resolution, ranges);

        boolean enabled = req.enabled() != null ? req.enabled() : cur.enabled();
        boolean allowDischarge = req.allowStorageDischarge() != null
                ? req.allowStorageDischarge() : cur.allowStorageDischarge();
        // PATCH semantics like every other field: absent keeps the stored
        // value; an explicit 0 clears the bound (validatedCycleSeconds).
        Integer minOn = req.minOnSeconds() != null
                ? validatedCycleSeconds(req.minOnSeconds(), "Mindestlaufzeit") : cur.minOnSeconds();
        Integer minOff = req.minOffSeconds() != null
                ? validatedCycleSeconds(req.minOffSeconds(), "Mindestpause") : cur.minOffSeconds();
        Integer maxStarts = req.maxStartsPerDay() != null
                ? validatedMaxStarts(req.maxStartsPerDay()) : cur.maxStartsPerDay();
        boolean cycleChanged = !java.util.Objects.equals(minOn, cur.minOnSeconds())
                || !java.util.Objects.equals(minOff, cur.minOffSeconds())
                || !java.util.Objects.equals(maxStarts, cur.maxStartsPerDay());
        long expected = req.expectedVersion() != null ? req.expectedVersion() : cur.version();
        long newVersion = repo.updateProfile(siteId, entityId, expected, controlKind, rated,
                minPower, toJsonText(levels), resolution, toJsonText(ranges), storageRelation,
                gridPolicy, allowDischarge, failsafe, enabled, minOn, minOff, maxStarts);
        if (newVersion < 0) {
            throw versionConflict(cur.version());
        }
        if (req.name() != null && !req.name().isBlank()) {
            jdbc.update("UPDATE measurement_point SET label = ? WHERE site_id = ? AND id = ?",
                    req.name().trim(), siteId, entityId);
        }
        // The cycle-guard limits ride the registry push (D-9): a change must
        // reach the device, or its temporal guard enforces yesterday's bounds.
        if (cycleChanged) {
            entities.pushRegistryBestEffort(siteId);
        }
        return get(siteId, entityId);
    }

    // --- delete --------------------------------------------------------------

    /**
     * Fachlich stilllegen (§11): a still-CONNECTED consumer is 409 (disconnect
     * first - physische Registry-Bereinigung erst nach Deaktivierung); an
     * unconnected one is removed, returning the site to its pre-consumer state
     * (no audit/fulfilment data exists in Increment 1). An unconnected consumer that
     * is a Beleg of released Berichtsstände (UEMS AP-12 E13 S2: it fed a cited
     * Messstelle - e.g. read by a box that was abgemeldet since) is 409
     * {@code berichts_belege} with the list, before anything is written.
     */
    @Transactional
    public void delete(UUID siteId, UUID entityId) {
        ConsumerRow row = repo.findForSite(siteId, entityId);
        if (row == null) {
            throw notFound();
        }
        if (row.deviceId() != null || row.edgeSourceId() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Verbraucher ist noch mit einem Gerät verbunden. Bitte zuerst trennen.");
        }
        berichtsBelege.pruefeKomponente(siteId, entityId);
        entities.deleteEntity(siteId, entityId);
    }

    // --- policy --------------------------------------------------------------

    public PolicyDto getPolicy(UUID siteId, UUID entityId) {
        if (repo.findForSite(siteId, entityId) == null) {
            throw notFound();
        }
        PolicyRow row = repo.latestPolicy(siteId, entityId);
        if (row == null) {
            return null;
        }
        return new PolicyDto(entityId, row.version(), row.lifecycle(), parse(row.documentJson()),
                row.contentHash(), row.createdBy());
    }

    /**
     * <b>Verbrauchsmanagement v1 P2:</b> das Profil einer Komponente, die noch
     * keines hat - der zweite Einstieg neben {@link #create}.
     *
     * <p>Er ist noetig, weil {@code create} IMMER eine neue Entitaet mintet
     * ({@code entities.createEntity}) und {@code repo.insertProfile} genau
     * diesen einen Aufrufer hatte: eine Komponente, die auf einem anderen Weg
     * entstanden ist (der Anlege-Assistent des Anlagen-Modells, eine
     * Bestands-Uebernahme), konnte deshalb nie eine Steuerart bekommen. Er legt
     * NUR das Profil an - keine Entitaet, keine Policy, kein Push.
     *
     * <p><b>⚠ Jeder Wert ist eine VORGABE aus Katalog und Entitaet, nie eine
     * Angabe des Aufrufers</b> - die Steuerart entscheidet nicht, was ein
     * Geraet KANN. Die Nennleistung ist die gepflegte {@code capacity_kwp} der
     * Komponente ({@code null} bleibt {@code null}, nie eine 0); der
     * D3-Nachweiskanal folgt derselben Ableitung wie beim Anlegen.
     *
     * @return die Profilzeile - die vorhandene, wenn es schon eine gab
     */
    @Transactional
    public ConsumerRow ensureProfile(UUID siteId, EntityRow entity) {
        ConsumerRow vorhanden = repo.findForSite(siteId, entity.id());
        if (vorhanden != null) {
            return vorhanden;
        }
        EntityType type = catalog.find(entity.entityType());
        if (type == null || !"consumer".equals(type.category()) || !type.controllable()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente lässt sich nicht steuern.");
        }
        String confirmationChannel = null;
        if (entity.edgeSourceId() != null && !entity.edgeSourceId().isBlank()) {
            confirmationChannel = confirmationChannelFor(siteId, entity.entityType(),
                    entity.edgeSourceId());
        } else {
            // Ohne gebundene Quelle entscheidet nur der TYP (SG-Ready) - sonst
            // bleibt der Kanal NULL, und das Erfuellungs-Ledger behauptet
            // niemals „fertig" (D3 Stufe 4).
            confirmationChannel = SgReady.confirmationChannel(entity.entityType());
        }
        repo.insertProfile(entity.id(), TenantContext.get(), siteId, defaultControlKind(type),
                entity.capacityKwp(), null, null, null, null, "consumer_first", "allow", false,
                type.defaultFailsafe(), null, null, null, confirmationChannel);
        return repo.findForSite(siteId, entity.id());
    }

    /**
     * <b>P2:</b> die Profil-Felder, die zu einer Steuerart gehoeren -
     * Mindestlaufzeit und Sperrzeit ({@code min_on_seconds}/
     * {@code min_off_seconds}, die Folgefragen aus §3.2). Sie sind KEINE
     * Dokument-Felder: der Zyklen-Waechter der Box liest sie aus dem
     * Registry-Push, nicht aus der Policy.
     *
     * <p>{@code null} laesst den gespeicherten Wert stehen (die PATCH-Semantik
     * des Hauses); {@code 0} loescht ihn - „keine erfundene Schonung".
     */
    @Transactional
    public void updateZyklus(UUID siteId, UUID entityId, Integer minOnSeconds,
            Integer minOffSeconds) {
        ConsumerRow row = repo.findForSite(siteId, entityId);
        if (row == null) {
            throw notFound();
        }
        Integer minOn = minOnSeconds == null ? row.minOnSeconds()
                : validatedCycleSeconds(minOnSeconds, "Mindestlaufzeit");
        Integer minOff = minOffSeconds == null ? row.minOffSeconds()
                : validatedCycleSeconds(minOffSeconds, "Mindestpause");
        if (java.util.Objects.equals(minOn, row.minOnSeconds())
                && java.util.Objects.equals(minOff, row.minOffSeconds())) {
            return;
        }
        long v = repo.updateProfile(siteId, entityId, row.version(), row.controlKind(),
                row.ratedPowerKw(), row.minPowerKw(), row.levelsKwJson(), row.resolutionKw(),
                row.powerRangesKwJson(), row.storageRelation(), row.defaultGridEnergyPolicy(),
                row.allowStorageDischarge(), row.failsafe(), row.enabled(), minOn, minOff,
                row.maxStartsPerDay());
        if (v < 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Verbraucher wurde gerade an anderer Stelle geändert.");
        }
    }

    /** Save a NEW draft policy version (§11). Lifecycle stays draft in Increment 1. */
    @Transactional
    public PolicyDto savePolicyDraft(UUID siteId, UUID entityId, JsonNode document, String createdBy) {
        if (repo.findForSite(siteId, entityId) == null) {
            throw notFound();
        }
        if (document == null || !document.isObject()) {
            throw badRequest("Das Regeldokument fehlt.");
        }
        ObjectNode doc = ((ObjectNode) document).deepCopy();
        // Stamp the identity from the path; the body can never target another entity (§16).
        doc.put("entity_id", entityId.toString());
        if (!doc.has("schema_version")) {
            doc.put("schema_version", "1.0");
        }
        List<ConsumerFinding> findings = new ArrayList<>(validator.validate(doc));
        // ⚠ Die TYP-scharfen Regeln stehen NEBEN dem generischen Validator, nie
        // darin: der ist ein Dokument-Validator mit einem TS-Zwilling und
        // geteilten Vektoren und kennt den Verbrauchertyp per Konstruktion
        // nicht (P8). Für jeden anderen Typ ist die Liste leer.
        ConsumerRow consumer = repo.findForSite(siteId, entityId);
        findings.addAll(SgReady.findings(consumer == null ? null : consumer.entityType(), doc));
        List<ConsumerFinding> errors = findings.stream().filter(ConsumerFinding::isError).toList();
        if (!errors.isEmpty()) {
            throw badRequest(errors.get(0).message());
        }
        String hash = contentHash(doc);
        int next = repo.maxPolicyVersion(siteId, entityId) + 1;
        PolicyRow row = repo.insertPolicyDraft(entityId, TenantContext.get(), siteId, next,
                doc.toString(), hash, createdBy);
        audit.append(siteId, entityId, "policy_saved", row.policyId(), row.version(), createdBy,
                null);
        return new PolicyDto(entityId, row.version(), row.lifecycle(), doc, row.contentHash(),
                row.createdBy());
    }

    // --- helpers -------------------------------------------------------------

    /**
     * The D3 confirmation channel a bound edge source honestly supports
     * (Bestätigungshierarchie §9.4): a source that PROVABLY measures power
     * (its reported reading carries load_kw - e.g. a go-e wallbox or a
     * metering Shelly 1PM/Plug S) confirms via power telemetry -> Stufe 2
     * (runtime exact, energy integrated); a driver-backed source without
     * proven measurement (a bare Shelly relay, or one that has not reported
     * yet) confirms via its relay/state readback -> Stufe 3 (runtime
     * confirmed, energy "angenommen" = Nennleistung x Zeit, labeled so by the
     * fulfilment ledger). An UNBOUND consumer keeps NULL -> the ledger never
     * claims fulfilment (Stufe 4). The ledger additionally downgrades a
     * power_kw channel per period when no telemetry covered it - so this can
     * overstate nothing.
     */
    private String confirmationChannelFor(UUID siteId, String entityType, String edgeSourceId) {
        // ⚠ Der SG-Ready-Typ entscheidet VOR dem Gerät (P8, §3.4): auf einem
        // potentialfreien Freigabe-Kontakt misst auch ein messender Shelly
        // nichts - der Strom der Wärmepumpe fließt woanders. Er bekommt deshalb
        // die eigene Stufe `freigabe`, die nie eine Energie behauptet.
        String typeChannel = SgReady.confirmationChannel(entityType);
        if (typeChannel != null) {
            return typeChannel;
        }
        for (ConsumerRepository.ReportedSource s : repo.reportedSources(siteId)) {
            if (s.sourceId().equals(edgeSourceId)) {
                return s.measuresPower() ? "power_kw" : "relay_state";
            }
        }
        // Bound but never reported: the driver's readback still confirms the
        // runtime, only the energy stays assumed until measurement is proven.
        return "relay_state";
    }

    private ConsumerDto toDto(UUID siteId, ConsumerRow row) {
        int maxPolicy = repo.maxPolicyVersion(siteId, row.entityId());
        String connection = (row.deviceId() != null || row.edgeSourceId() != null
                || row.ioBound()) ? "connected" : "disconnected";
        // Derived, never stored: an ACTIVE policy while enabled = "active",
        // while disabled = "paused" (the pause failsafe), else "not_activated".
        // Without this the row would keep claiming "Steuerung noch nicht
        // aktiviert" right after a successful activation.
        ConsumerRepository.PolicyRow activePolicy = repo.activePolicy(siteId, row.entityId());
        String activation = activePolicy == null ? "not_activated"
                : (row.enabled() ? "active" : "paused");
        return new ConsumerDto(row.entityId(), row.entityType(), catalog.labelFor(row.entityType()),
                row.label(), row.controlKind(), row.ratedPowerKw(), row.minPowerKw(),
                parse(row.levelsKwJson()), row.resolutionKw(), parse(row.powerRangesKwJson()),
                row.storageRelation(), row.defaultGridEnergyPolicy(), row.allowStorageDischarge(),
                row.failsafe(), row.enabled(), row.version(), connection, row.edgeSourceId(),
                activation, maxPolicy > 0, maxPolicy > 0 ? maxPolicy : null,
                row.minOnSeconds(), row.minOffSeconds(), row.maxStartsPerDay(),
                row.confirmationChannel(), row.ioEntityId(), row.ioChannel());
    }

    /** control kind => the actuate commands that back it (the §16 capability map). */
    private List<String> allowedControlKinds(EntityType type) {
        Set<String> actuate = new java.util.HashSet<>();
        for (JsonNode a : type.defaultActuate()) {
            actuate.add(a.path("command").asText(""));
        }
        List<String> kinds = new ArrayList<>();
        if (actuate.contains("on_off")) {
            kinds.add("on_off");
        }
        // stepped/continuous both need a positive setpoint; a bare limit is reduce-only.
        if (actuate.contains("setpoint_kw")) {
            kinds.add("stepped");
            kinds.add("continuous");
        }
        if (kinds.isEmpty()) {
            kinds.add("on_off");
        }
        return kinds;
    }

    private String defaultControlKind(EntityType type) {
        List<String> allowed = allowedControlKinds(type);
        return allowed.contains("on_off") ? "on_off" : allowed.get(0);
    }

    /**
     * Die Leistungs-FORM eines Verbraucherprofils - mit ODER ohne Nennleistung.
     *
     * <p>⚠ Ohne Nennleistung wird der Profil-Validator GAR NICHT gefragt: er
     * verlangt {@code rated_power_kw} (zu Recht - eine Stufe/ein Bereich ohne
     * Bezugsgröße bedeutet nichts), und er ist der Zwilling mit den geteilten
     * Vektoren, der dafür NICHT aufgeweicht wird. Stattdessen gilt hier die
     * strengere Regel: ohne Nennleistung darf es AUCH KEINE Leistungsform
     * geben - Stufen, Bereiche, Mindest- und Auflösungsleistung beschreiben
     * alle eine Leistung, die dieser Verbraucher (SG-Ready-Freigabe, P8) gar
     * nicht hat. So kann nichts still ungeprüft durchrutschen.
     */
    private void validateProfileShape(String controlKind, BigDecimal rated,
            BigDecimal minPower, JsonNode levels, BigDecimal resolution, JsonNode ranges) {
        if (rated != null) {
            validateControlProfileOrThrow(controlKind, rated, minPower, levels, resolution, ranges);
            return;
        }
        boolean form = (levels != null && !levels.isNull() && !levels.isEmpty())
                || (ranges != null && !ranges.isNull() && !ranges.isEmpty())
                || minPower != null || resolution != null;
        if (form) {
            throw badRequest("Ohne Nennleistung lassen sich keine Leistungsstufen oder "
                    + "-bereiche angeben.");
        }
    }

    private void validateControlProfileOrThrow(String controlKind, BigDecimal rated,
            BigDecimal minPower, JsonNode levels, BigDecimal resolution, JsonNode ranges) {
        ObjectNode profile = mapper.createObjectNode();
        profile.put("control_kind", controlKind);
        profile.put("rated_power_kw", rated);
        if (minPower != null) {
            profile.put("min_power_kw", minPower);
        }
        if (resolution != null) {
            profile.put("resolution_kw", resolution);
        }
        if (levels != null && !levels.isNull()) {
            profile.set("levels_kw", levels);
        }
        if (ranges != null && !ranges.isNull()) {
            profile.set("power_ranges_kw", ranges);
        }
        List<ConsumerFinding> errors = validator.validateControlProfile(profile).stream()
                .filter(ConsumerFinding::isError).toList();
        if (!errors.isEmpty()) {
            throw badRequest(errors.get(0).message());
        }
    }

    private boolean siteHasStorage(UUID siteId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM asset WHERE site_id = ? AND type = 'battery'",
                Integer.class, siteId);
        return n != null && n > 0;
    }

    private String toJsonText(JsonNode node) {
        return node == null || node.isNull() ? null : node.toString();
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

    private static String orDefault(String v, String d) {
        return v == null || v.isBlank() ? d : v;
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Verbraucher nicht gefunden.");
    }

    private static ResponseStatusException badRequest(String msg) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, msg);
    }

    private static ResponseStatusException versionConflict(long current) {
        return new ResponseStatusException(HttpStatus.CONFLICT,
                "Der Verbraucher wurde zwischenzeitlich geändert (aktuelle Version " + current
                        + "). Bitte neu laden.");
    }

    /** sha256 of the canonical JSON (§10: content_hash aus kanonischem JSON). */
    static String contentHash(JsonNode node) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(canonicalize(node).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("sha256:");
            for (byte b : h) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String canonicalize(JsonNode n) {
        if (n == null || n.isNull()) {
            return "null";
        }
        if (n.isObject()) {
            TreeMap<String, JsonNode> sorted = new TreeMap<>();
            n.fields().forEachRemaining(e -> sorted.put(e.getKey(), e.getValue()));
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (var e : sorted.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                sb.append('"').append(e.getKey()).append("\":").append(canonicalize(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (n.isArray()) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < n.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(canonicalize(n.get(i)));
            }
            return sb.append(']').toString();
        }
        return n.toString();
    }

    // The four intent cards (§14.3 Teil B). Templates for the question tree; the
    // portal renders these + the per-type suggestions, never a technical term.
    private static final List<IntentOption> INTENTS = List.of(
            new IntentOption("react", "Sofort reagieren",
                    "Wenn etwas passiert, soll der Verbraucher reagieren."),
            new IntentOption("schedule", "Feste Zeiten",
                    "Der Verbraucher soll zu bestimmten Zeiten laufen."),
            new IntentOption("deadline", "Bis zu einer Frist erledigen",
                    "VoltPilot darf den besten Zeitpunkt wählen."),
            new IntentOption("cheap", "Günstige Energie nutzen",
                    "Nur bei passendem Preis, PV-Überschuss oder Ladestand."));

    private static List<String> intentsFor(String type) {
        return switch (type) {
            case "wallbox" -> List.of("react", "cheap");
            case "heating-rod" -> List.of("schedule", "cheap");
            case "pump" -> List.of("deadline", "schedule");
            default -> List.of("react", "schedule", "deadline", "cheap");
        };
    }
}
