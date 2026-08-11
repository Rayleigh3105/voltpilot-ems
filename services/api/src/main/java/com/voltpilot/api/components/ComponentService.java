package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.MeasurementPointRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ComponentDefinitionDto;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import com.voltpilot.api.web.dto.SiteComponentsDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der EINE Anlege-Weg, serverseitig (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 Teil 4): eine Komponente entsteht aus einer VORLAGE
 * plus ihrer Verbindung, bekommt eine ROLLE, und wird versioniert gespeichert.
 *
 * <p>Die Regeln, die hier und nur hier leben - jede einzelne, weil ihr Fehlen
 * eine belegte Fehlerklasse wäre:
 *
 * <ul>
 *   <li><b>Nur auf einer portal-verwalteten Anlage.</b> Auf einer Bestandsanlage
 *       (box-verwaltet, Stufe 2) würde ein gespeichertes Soll NIE wirken - ein
 *       Speichern, das folgenlos bleibt, ist schlimmer als eine ehrliche
 *       Ablehnung, die sagt, wo es heute geht.</li>
 *   <li><b>Verbindungstest-PFLICHT.</b> Das Soll IST seit dieser Stufe der
 *       Lesepfad; ein Tippfehler in der IP macht die Anlage blind. Genau diese
 *       Klasse fängt ein Test ab, also gibt es kein Blind-Soll
 *       ({@link ComponentConnectionReceipts}).</li>
 *   <li><b>Höchstens EIN Netz-Zähler je Anlage.</b> Bis heute prüfte das nur das
 *       Frontend der Box ({@code static/sources.js}); ein zweiter Zähler ließe
 *       die Topologie das Netz doppelt zählen.</li>
 *   <li><b>Genau EIN Wechselrichter.</b> Er ist die {@code battery-hybrid}-Zeile
 *       der Anlage - die Auto-Komposition legt sie an, dieser Weg füllt ihre
 *       Anbindung. Ein zweiter wäre auf der Box nicht entscheidbar (der Applier
 *       lehnt ihn dort noch einmal ab).</li>
 *   <li><b>Marke/Modell/Familie/Kommunikationsart kommen aus der VORLAGE</b>,
 *       nie aus dem Rumpf. Ein Client kann damit keine widersprüchliche Anbindung
 *       speichern - dieselbe Garantie, die die Box mit ihrer Katalog-
 *       Normalisierung gibt.</li>
 * </ul>
 *
 * <p>Alles läuft über den RLS-Pfad: eine fremde Anlage ist 404, bevor irgendetwas
 * geschrieben wird, und ein Portal-Admin erreicht jede Anlage über den
 * {@code X-Tenant-Id}-Umschalter wie bei jeder Kunden-Route.
 */
@Service
public class ComponentService {

    /** Die Rollen, die der Assistent anbietet. */
    public static final String ROLE_INVERTER = "inverter";
    public static final String ROLE_ERZEUGER = "pv-generation";
    public static final String ROLE_NETZ = "grid-meter";
    public static final String ROLE_CONSUMER = "consumer";

    private static final Set<String> ROLES =
            Set.of(ROLE_INVERTER, ROLE_ERZEUGER, ROLE_NETZ, ROLE_CONSUMER);

    /** Die Entitätstypen, die zu den vier Rollen gehören. */
    private static final Map<String, String> ROLE_ENTITY_TYPE = Map.of(
            ROLE_INVERTER, "battery-hybrid",
            ROLE_ERZEUGER, "producer",
            ROLE_NETZ, "grid-meter");

    private static final String SOURCE_KIND_BUILTIN = "builtin";
    private static final String SOURCE_KIND_CERTIFIED = "certified";

    private final SiteRepository sites;
    private final MeasurementPointRepository points;
    private final EntityRegistryRepository entityRepo;
    private final EntityRegistryService entityRegistry;
    private final ComponentDefinitionRepository definitions;
    private final ComponentApplyRepository applyState;
    private final ComponentTemplateRepository templates;
    private final ComponentConnectionReceipts receipts;
    private final AssetRepository assets;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComponentService(SiteRepository sites, MeasurementPointRepository points,
            EntityRegistryRepository entityRepo, EntityRegistryService entityRegistry,
            ComponentDefinitionRepository definitions, ComponentApplyRepository applyState,
            ComponentTemplateRepository templates, ComponentConnectionReceipts receipts,
            AssetRepository assets) {
        this.sites = sites;
        this.points = points;
        this.entityRepo = entityRepo;
        this.entityRegistry = entityRegistry;
        this.definitions = definitions;
        this.applyState = applyState;
        this.templates = templates;
        this.receipts = receipts;
        this.assets = assets;
    }

    // ---- Lesen ------------------------------------------------------------

    /** Die Komponenten dieser Anlage samt Soll/Ist-Stand. */
    public SiteComponentsDto list(UUID siteId) {
        requireSite(siteId);
        String authority = ComponentAuthority.of(definitions.componentAuthority(siteId));
        String soll = entityRepo.registryRevision(siteId);
        ComponentApplyRepository.ApplyState ist = applyState.forSite(siteId);

        String applied = ist == null ? null : ist.appliedRevision();
        List<SiteComponentsDto.ComponentRowDto> rows = new ArrayList<>();
        for (EntityRow row : entityRepo.entitiesForSite(siteId)) {
            rows.add(toRow(row, soll, applied));
        }
        return new SiteComponentsDto(authority, soll, applied,
                ist == null ? null : ist.appliedAt(),
                ist == null ? null : ist.refusedRevision(),
                ist == null ? null : ist.refusedReason(), rows);
    }

    /** Die Fassungen EINER Komponente, neueste zuerst. */
    public List<ComponentDefinitionDto> versions(UUID siteId, UUID entityId) {
        requireSite(siteId);
        requireComponent(siteId, entityId);
        return definitions.versions(siteId, entityId);
    }

    // ---- Schreiben --------------------------------------------------------

    /**
     * Legt eine Komponente an. Beim Wechselrichter und beim Netz-Zähler wird die
     * SCHON EXISTIERENDE, von der Plattform komponierte Zeile befüllt statt eine
     * zweite anzulegen - die Topologie summiert je Rolle, zwei Zeilen wären
     * Doppelzählung.
     */
    @Transactional
    public SiteComponentsDto create(UUID siteId, SaveComponentRequest req, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        String role = requireRole(req.role());
        ComponentTemplateDto template = requireTemplate(req.templateRef());
        Map<String, Object> connection = requireTestedConnection(siteId, req, template);

        UUID tenantId = TenantContext.get();
        UUID entityId = resolveOrCreatePoint(siteId, tenantId, role, req, template);
        writeDefinition(siteId, tenantId, entityId, role, req, template, connection, subject,
                "Angelegt");
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    /**
     * Ändert die Anbindung einer bestehenden Komponente - eine NEUE Fassung, mit
     * der alten weiterhin abrufbar. Der Verbindungstest ist auch hier Pflicht:
     * eine Änderung kann eine laufende Anlage genauso blind machen wie eine
     * Erstanlage.
     */
    @Transactional
    public SiteComponentsDto update(UUID siteId, UUID entityId, SaveComponentRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow existing = requireComponent(siteId, entityId);
        String role = requireRole(req.role());
        if (!role.equals(roleOf(existing))) {
            // Die Rolle einer Komponente zu wechseln hieße, sie in einen anderen
            // Teil der Energiebilanz zu verschieben - das ist ein Löschen plus
            // ein Anlegen, kein Bearbeiten, und darf nicht als eine Fassung
            // durchgehen.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Art dieser Komponente lässt sich nicht ändern. Bitte legen Sie sie neu an.");
        }
        ComponentTemplateDto template = requireTemplate(req.templateRef());
        Map<String, Object> connection = requireTestedConnection(siteId, req, template);

        writeDefinition(siteId, TenantContext.get(), entityId, role, req, template, connection,
                subject, "Verbindung geändert");
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    /**
     * Setzt eine Komponente auf eine frühere Fassung zurück - der Ein-Klick-Weg
     * aus einem falschen Soll heraus (Risiko 2 des Konzepts).
     *
     * <p>Er SCHREIBT eine neue Fassung mit dem alten Inhalt statt eine zu
     * löschen: „was lief letzte Woche" bleibt beantwortbar, und der Weg zurück
     * ist derselbe Weg wie jede andere Änderung.
     *
     * <p>Ein Verbindungstest wird hier NICHT verlangt, und das ist Absicht: diese
     * Verbindung war schon einmal gespeichert und hat damals ihren Test bestanden.
     * Einen zweiten zu erzwingen hieße, den Rückweg aus einem Fehler genau dann zu
     * versperren, wenn das Gerät gerade nicht antwortet - also im Notfall.
     */
    @Transactional
    public SiteComponentsDto rollback(UUID siteId, UUID entityId, int version, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        requireComponent(siteId, entityId);
        ComponentDefinitionDto old = definitions.version(siteId, entityId, version);
        if (old == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Diese Fassung gibt es nicht.");
        }
        int newVersion = definitions.applyDefinition(siteId, entityId, old.label(), old.brand(),
                old.model(), old.family(), old.communication(), old.connection(), old.sourceKind(),
                old.templateRef(), old.templateVersion());
        if (newVersion == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        definitions.recordVersion(TenantContext.get(), siteId, entityId, newVersion, old.role(),
                old.label(), old.brand(), old.model(), old.family(), old.communication(),
                old.connection(), old.sourceKind(), old.templateRef(), old.templateVersion(),
                subject, "Zurück auf Fassung " + version);
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    // ---- Regeln -----------------------------------------------------------

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /**
     * Auf einer box-verwalteten Anlage wird hier NICHT geschrieben. Der Satz
     * nennt den Zustand, nicht nur die Ablehnung - und verspricht nichts über
     * einen Zeitpunkt.
     */
    private void requirePortalManaged(UUID siteId) {
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(siteId))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Geräte dieser Anlage werden derzeit direkt am Gerät verwaltet. "
                            + "Änderungen nehmen Sie dort vor.");
        }
    }

    private String requireRole(String raw) {
        String role = raw == null ? "" : raw.trim();
        if (!ROLES.contains(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Art von Komponente wird nicht unterstützt.");
        }
        return role;
    }

    private ComponentTemplateDto requireTemplate(String ref) {
        return templates.findNewestByRef(BuiltinComponentTemplates.PUBLIC_KINDS,
                        ref == null ? "" : ref.trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Dieses Gerät kennen wir nicht."));
    }

    /**
     * Die Verbindungstest-Pflicht. Ohne einen gültigen Beleg für GENAU diese
     * Anlage, Vorlage und Verbindung wird nichts gespeichert.
     */
    private Map<String, Object> requireTestedConnection(UUID siteId, SaveComponentRequest req,
            ComponentTemplateDto template) {
        Map<String, Object> connection =
                req.connection() == null ? Map.of() : new LinkedHashMap<>(req.connection());
        if (connection.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Es fehlen die Verbindungsdaten des Geräts.");
        }
        if (!receipts.has(siteId, template.templateRef(), connection)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät - erst danach lässt "
                            + "sie sich speichern.");
        }
        return connection;
    }

    private EntityRow requireComponent(UUID siteId, UUID entityId) {
        EntityRow row = entityRepo.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        return row;
    }

    /**
     * Findet die Zeile, in die diese Komponente gehört - oder legt sie an.
     *
     * <p>Wechselrichter und Netz-Zähler sind PLATTFORM-KOMPONIERT: die
     * Auto-Komposition legt sie beim Geräte-Claim an, dieser Weg füllt ihre
     * Anbindung. Erzeuger und Verbraucher entstehen hier neu.
     */
    private UUID resolveOrCreatePoint(UUID siteId, UUID tenantId, String role,
            SaveComponentRequest req, ComponentTemplateDto template) {
        String label = label(req, template);
        String entityType = ROLE_ENTITY_TYPE.get(role);

        // Wechselrichter und Netz-Zähler sind PLATTFORM-KOMPONIERT: die
        // Auto-Komposition legt sie beim Geräte-Claim an, dieser Weg füllt ihre
        // Anbindung. Eine zweite Zeile wäre Doppelzählung (die Topologie
        // summiert je Rolle).
        //
        // ⚠ Die 0-1-Regel hängt an der ANBINDUNG, nicht an der Existenz der
        // Zeile: die komponierte Zeile ist noch KEIN eingerichtetes Gerät, ein
        // Zähler MIT Anbindung ist einer. Nur so lässt sich der erste Zähler
        // anlegen UND der zweite abweisen.
        if (ROLE_INVERTER.equals(role) || ROLE_NETZ.equals(role)) {
            UUID existing = entityRepo.firstEntityOfType(siteId, entityType);
            if (existing != null) {
                EntityRow row = entityRepo.entityForSite(siteId, existing);
                if (row != null && row.connectionJson() != null
                        && !row.connectionJson().isBlank()) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            ROLE_INVERTER.equals(role)
                                    ? "Diese Anlage hat bereits einen Wechselrichter. Bitte "
                                            + "bearbeiten Sie ihn statt einen zweiten anzulegen."
                                    : "Diese Anlage hat bereits einen Netz-Zähler. Es ist nur "
                                            + "einer möglich.");
                }
                return existing;
            }
            if (ROLE_INVERTER.equals(role)) {
                // Ohne komponierte Zeile fehlt der Anlage der Speicher-Stammsatz,
                // aus dem sie entsteht. Das ist eine Aussage über die
                // Reihenfolge des Einrichtens, kein Fehler des Kunden.
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Für diese Anlage ist noch kein Wechselrichter angelegt. Bitte tragen Sie "
                                + "zuerst die Eckdaten Ihres Speichers ein.");
            }
        }
        if (ROLE_NETZ.equals(role) && points.countByRole(siteId, ROLE_NETZ) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat bereits einen Netz-Zähler. Es ist nur einer möglich.");
        }

        BigDecimal capacity = ROLE_ERZEUGER.equals(role) ? req.capacityKwp() : null;
        UUID id = points.create(tenantId, siteId, role, label, template.brand(), template.model(),
                capacity, null);
        if (ROLE_ERZEUGER.equals(role)) {
            assets.addPvCapacity(tenantId, siteId, capacity);
        }
        if (entityType != null) {
            entityRepo.setEntityConfig(id, entityType, defaultCapabilities(role),
                    defaultGuards(role, req.capacityKwp()));
        }
        return id;
    }

    /** Schreibt die geltende Anbindung + ihre Fassung in die Historie. */
    private void writeDefinition(UUID siteId, UUID tenantId, UUID entityId, String role,
            SaveComponentRequest req, ComponentTemplateDto template,
            Map<String, Object> connection, String subject, String defaultNote) {
        String connJson = writeJson(driverConnection(connection, req));
        String sourceKind = SOURCE_KIND_CERTIFIED.equals(template.kind())
                ? SOURCE_KIND_CERTIFIED : SOURCE_KIND_BUILTIN;
        String label = label(req, template);
        int version = definitions.applyDefinition(siteId, entityId, label, template.brand(),
                template.model(), template.family(), template.communication(), connJson,
                sourceKind, template.templateRef(), template.version());
        if (version == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        String note = req.note() == null || req.note().isBlank() ? defaultNote : req.note().trim();
        definitions.recordVersion(tenantId, siteId, entityId, version, role, label,
                template.brand(), template.model(), template.family(), template.communication(),
                connJson, sourceKind, template.templateRef(), template.version(), subject, note);
    }

    /**
     * Baut den {@code connection}-Block, den der Registry-Push als
     * {@code driver.connection} an die Box weiterreicht. Die Rolle und die
     * Zusatzfakten (kWp, Lese-Abstand) reisen MIT - der Applier braucht sie, um
     * daraus einen Quellen-Eintrag zu bauen, und sie stehen bewusst nicht in
     * einem zweiten Kanal.
     */
    private Map<String, Object> driverConnection(Map<String, Object> connection,
            SaveComponentRequest req) {
        Map<String, Object> out = new LinkedHashMap<>(connection);
        if (req.intervalS() != null && req.intervalS() > 0) {
            out.put("interval_s", req.intervalS());
        }
        return out;
    }

    private static String label(SaveComponentRequest req, ComponentTemplateDto template) {
        String l = req.label() == null ? "" : req.label().trim();
        return l.isEmpty() ? template.modelLabel() : l;
    }

    private static String roleOf(EntityRow row) {
        return row.role();
    }

    private SiteComponentsDto.ComponentRowDto toRow(EntityRow row, String soll, String applied) {
        return new SiteComponentsDto.ComponentRowDto(row.id(), row.role(), row.entityType(),
                row.label(), row.brand(), row.model(), row.family(), row.communication(),
                row.connectionJson(), row.sourceKind(), row.templateRef(), row.templateVersion(),
                row.definitionVersion(), row.capacityKwp(), row.edgeSourceId(),
                syncStatus(soll, applied));
    }

    /**
     * Soll gegen Ist, ohne zu raten.
     *
     * <ul>
     *   <li>{@code unreported} - die Box hat sich zur Geräte-Konfiguration nie
     *       geäußert (ältere Software, oder noch kein Herzschlag). „Unbekannt",
     *       nie „nicht angekommen".</li>
     *   <li>{@code in_sync} - die angewandte Revision IST die komponierte.</li>
     *   <li>{@code pending} - es liegt eine neuere Fassung an, die die Box noch
     *       nicht angewandt hat.</li>
     * </ul>
     */
    static String syncStatus(String soll, String applied) {
        if (applied == null || applied.isBlank()) {
            return "unreported";
        }
        if (soll == null || soll.isBlank()) {
            return "unreported";
        }
        return soll.equals(applied) ? "in_sync" : "pending";
    }

    private String writeJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize component definition", e);
        }
    }

    /** Die Messkanäle, die eine Komponente dieser Rolle liefert. */
    private String defaultCapabilities(String role) {
        JsonNode caps = switch (role) {
            case ROLE_ERZEUGER -> mapper.createObjectNode().set("measure",
                    mapper.createArrayNode().add(measure("pv_power_kw", "kW")));
            case ROLE_NETZ -> mapper.createObjectNode().set("measure",
                    mapper.createArrayNode().add(measure("power_kw", "kW")));
            default -> mapper.createObjectNode().set("measure",
                    mapper.createArrayNode().add(measure("power_kw", "kW")));
        };
        return writeJson(caps);
    }

    private JsonNode measure(String channel, String unit) {
        return mapper.createObjectNode().put("channel", channel).put("unit", unit);
    }

    /**
     * Die Schutz-Konfiguration. Eine über diesen Weg angelegte Komponente ist
     * NUR-LESEND ({@code failsafe} measure-only bzw. release) - „Steuern
     * freigeben" ist der bewusst GETRENNTE Schritt einer späteren Stufe.
     */
    private String defaultGuards(String role, BigDecimal capacityKwp) {
        var guards = mapper.createObjectNode();
        var limits = guards.putObject("limits");
        if (ROLE_ERZEUGER.equals(role) && capacityKwp != null) {
            limits.put("max_generation_kw", capacityKwp.doubleValue());
        }
        guards.putObject("failsafe").put("behavior",
                ROLE_ERZEUGER.equals(role) ? "release" : "measure-only");
        return writeJson(guards);
    }
}
