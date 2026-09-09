package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowCompilerException;
import com.voltpilot.api.flows.FlowDeployment;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SaveUserDefinedBatteryRequest;
import com.voltpilot.api.web.dto.SiteComponentsDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der BMS-UNABHÄNGIGE BATTERIE-ANSCHLUSS, serverseitig - Ebene 1 „Transport /
 * Read" (Konzept {@code vp-deye-diybms-luecke-l5} §3.2b, Paket P5).
 *
 * <p><b>Es gibt keinen Sonderpfad.</b> Was hier entsteht, ist eine ganz normale
 * v2-Entität vom Typ {@code user-defined-battery} mit den Standard-Kanälen, die
 * der Kunde WIRKLICH zugeordnet hat - alles dahinter ist die bewiesene
 * Maschinerie der Selbstbau-Tür ({@link SelfBuildComponentService}): der
 * Registry-Push kennt sie, der generierte Flow rollt über flowc und
 * {@code v2/flows} aus, die Messwerte laufen über {@code telemetry_v2} in
 * Rollups, Historie und Explorer.
 *
 * <p><b>Die Regeln, die hier und nur hier leben:</b>
 *
 * <ul>
 *   <li><b>Die Fähigkeiten sind die ZUGEORDNETEN Kanäle</b>, nie die ganze
 *       Standardliste. Wer nur Zellspannungen abbildet, hat eine Batterie mit
 *       {@code cell_min_mv}/{@code cell_max_mv} - einen Ladestand zu
 *       versprechen, den niemand liest, wäre eine erfundene Messung. Der
 *       Katalog liefert dabei die erlaubten Kanäle SAMT Einheit; es gibt keine
 *       zweite Liste.</li>
 *   <li><b>Nur messend.</b> {@code measure-only} ist auf der Box die
 *       Schutz-Semantik „verwirf jedes Kommando" - die Batterie ist also nicht
 *       bloß ungesteuert, sondern strukturell unsteuerbar. Die BMS-Grenzen als
 *       Wächter-Eingabe (P5c) und die Speiser-Bindung an einen
 *       Hybrid-Wechselrichter (P6) sind ausdrücklich spätere Pakete.</li>
 *   <li><b>KEINE Verbindungstest-Pflicht - und zwar mit Grund.</b> Der
 *       Modbus-Baukasten fordert einen Beleg, weil er einen Test ANBIETET
 *       („Jetzt lesen" über den Probe-Kanal). Für MQTT gäbe es den noch nicht:
 *       eine Vorschau braucht ein Lauschfenster statt einer Einmal-Lesung, und
 *       die ist Teil des Zuordnungs-Assistenten (P5d). Eine Pflicht ohne Tür
 *       wäre eine Sackgasse, kein Schutz. Was bleibt, ist die LAN-Regel - der
 *       Zaun, der wirklich einen Schaden verhindert.</li>
 *   <li><b>Der Flow wird VOR dem ersten Schreibvorgang kompiliert</b> (das
 *       {@code ConsumerPolicyActivationService}-Muster). Eine Batterie, deren
 *       Leseplan nicht gebaut werden konnte, liest nichts.</li>
 *   <li><b>Die Bilanz bleibt unberührt.</b> Diese Batterie ist ein
 *       Topologie-Knoten mit eigenen Messwerten; ihre LEISTUNG kommt bei einer
 *       Hybrid-Anlage weiterhin vom Wechselrichter, wo sie gemessen wird. Sie
 *       ein zweites Mal zu zählen wäre schlicht falsch - die ausdrückliche
 *       Bindung an den Speicherknoten ist P6.</li>
 * </ul>
 */
@Service
public class UserDefinedBatteryService {

    private static final Logger log = LoggerFactory.getLogger(UserDefinedBatteryService.class);

    private final SiteRepository sites;
    private final EntityRegistryRepository entityRepo;
    private final EntityRegistryService entityRegistry;
    private final EntityTypeCatalog typeCatalog;
    private final ComponentDefinitionRepository definitions;
    private final ComponentService components;
    private final UserDefinedBatteryFlowCompiler compiler;
    private final FlowRepository flows;
    private final FlowActivationService deployments;
    private final ObjectProvider<FlowCompiler> flowc;
    private final ObjectMapper mapper;

    public UserDefinedBatteryService(SiteRepository sites, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, EntityTypeCatalog typeCatalog,
            ComponentDefinitionRepository definitions, ComponentService components,
            UserDefinedBatteryFlowCompiler compiler, FlowRepository flows,
            FlowActivationService deployments, ObjectProvider<FlowCompiler> flowc,
            ObjectMapper mapper) {
        this.sites = sites;
        this.entityRepo = entityRepo;
        this.entityRegistry = entityRegistry;
        this.typeCatalog = typeCatalog;
        this.definitions = definitions;
        this.components = components;
        this.compiler = compiler;
        this.flows = flows;
        this.deployments = deployments;
        this.flowc = flowc;
        this.mapper = mapper;
    }

    // ---- Anlegen / Ändern -------------------------------------------------

    /** Legt eine selbst angebundene Batterie an. */
    @Transactional
    public SiteComponentsDto create(UUID siteId, SaveUserDefinedBatteryRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        requireGateway(siteId);
        Result def = requireValid(req);

        UUID tenantId = TenantContext.get();
        String label = label(req);
        EntityRow row = entityRegistry.createEntity(siteId,
                UserDefinedBatteryDefinition.ENTITY_TYPE, label, null,
                capabilities(def.mappings()), guards());

        write(siteId, tenantId, row.id(), def, label, req.note(), subject, "Angelegt");
        return components.list(siteId);
    }

    /**
     * Ändert eine selbst angebundene Batterie - eine NEUE Fassung, die alte
     * bleibt abrufbar und per Rollback erreichbar.
     */
    @Transactional
    public SiteComponentsDto update(UUID siteId, UUID entityId, SaveUserDefinedBatteryRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        requireGateway(siteId);
        EntityRow existing = requireUserDefinedBattery(siteId, entityId);
        Result def = requireValid(req);

        String label = label(req);
        // Die Zuordnungs-Liste ist zugleich die Fähigkeiten-Liste: ein
        // entferntes Ziel muss auch als Messwert verschwinden, sonst verspräche
        // die Batterie einen Wert, den niemand mehr liest.
        entityRegistry.updateEntity(siteId, existing.id(), label, null,
                capabilities(def.mappings()), null);
        write(siteId, TenantContext.get(), existing.id(), def, label, req.note(), subject,
                "Geändert");
        return components.list(siteId);
    }

    /**
     * Entfernt eine selbst angebundene Batterie samt ihrem Lese-Flow.
     *
     * <p>Die aufgezeichneten Messwerte bleiben in der Historie - sie sind
     * gemessen worden, und ein Gerät zu entfernen macht seine Vergangenheit
     * nicht ungeschehen.
     */
    @Transactional
    public SiteComponentsDto delete(UUID siteId, UUID entityId, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow row = requireUserDefinedBattery(siteId, entityId);

        // Erst den Leseplan zurückziehen, dann die Komponente: andersherum
        // bliebe für einen Moment ein Flow ausgerollt, dessen Ziel-Entität es
        // nicht mehr gibt.
        flows.retireActive(UserDefinedBatteryFlowCompiler.generatedFlowId(row.id()));
        entityRegistry.deleteEntity(siteId, row.id(), true);
        if (!deployments.republishForSite(siteId)) {
            log.warn("user-defined battery {} removed, but the flow set did not re-publish",
                    entityId);
        }
        return components.list(siteId);
    }

    // ---- Regeln -----------------------------------------------------------

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private void requirePortalManaged(UUID siteId) {
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(siteId))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Geräte dieser Anlage werden derzeit direkt am Gerät verwaltet. "
                            + "Änderungen nehmen Sie dort vor.");
        }
    }

    /**
     * Ohne verbundenes Gerät gibt es keine Box, die lesen könnte - und damit
     * nichts, wohin der Leseplan ausgerollt werden kann. Wörtlich der Satz der
     * Selbstbau-Tür, damit dieselbe Lücke überall gleich heißt.
     */
    private void requireGateway(UUID siteId) {
        if (entityRepo.siteDeviceIds(siteId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat noch kein verbundenes Gerät, das lesen könnte.");
        }
    }

    /**
     * Nur eine Komponente, die WIRKLICH aus diesem Weg stammt, wird hier
     * geändert oder gelöscht. Sonst könnte er eine plattform-komponierte Zeile
     * unter der Hand in eine MQTT-Batterie verwandeln.
     */
    private EntityRow requireUserDefinedBattery(UUID siteId, UUID entityId) {
        EntityRow row = entityRepo.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        if (!UserDefinedBatteryDefinition.COMMUNICATION.equals(row.communication())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente wurde nicht als eigene Batterie angebunden und lässt sich "
                            + "hier nicht bearbeiten.");
        }
        return row;
    }

    private Result requireValid(SaveUserDefinedBatteryRequest req) {
        Result def = UserDefinedBatteryDefinition.validate(broker(req), mappings(req),
                req == null ? null : req.publishIntervalS(), soc(req), allowedChannels());
        if (!def.ok()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    String.join(" ", def.errors()));
        }
        return def;
    }

    /**
     * Die erlaubten Ziel-Kanäle SAMT Einheit - wörtlich das
     * {@code default_measure} des Typkatalogs.
     *
     * <p>⚠ Es gibt bewusst keine Kopie dieser Liste im Code: der Katalog ist
     * seit dem 09.09.2026 die EINE Wahrheit über die Fähigkeiten eines Typs
     * ({@link ComponentDefaults}), und eine zweite Liste hier liefe genau so
     * lautlos auseinander wie der Rollen-Default, den jene Korrektur beseitigt
     * hat.
     */
    private Map<String, String> allowedChannels() {
        EntityTypeCatalog.EntityType type =
                typeCatalog.find(UserDefinedBatteryDefinition.ENTITY_TYPE);
        if (type == null) {
            throw new IllegalStateException("entity type "
                    + UserDefinedBatteryDefinition.ENTITY_TYPE + " missing from the catalog");
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode m : type.defaultMeasure()) {
            out.put(m.path("channel").asText(), m.path("unit").asText(""));
        }
        return out;
    }

    // ---- Schreiben --------------------------------------------------------

    /**
     * Schreibt Definition + Fassung und rollt den Leseplan aus.
     *
     * <p>Reihenfolge mit Absicht: erst die Fassung schreiben (sie IST die
     * Flow-Version), dann kompilieren, dann ausrollen. Scheitert der Compiler,
     * wirft diese Methode - und weil der Aufrufer {@code @Transactional} ist,
     * bleibt weder eine Komponente noch eine Fassung zurück.
     */
    private void write(UUID siteId, UUID tenantId, UUID entityId, Result def, String label,
            String note, String subject, String defaultNote) {
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, label, null, null, null, UserDefinedBatteryDefinition.COMMUNICATION,
                definitionJson(def), UserDefinedBatteryDefinition.SOURCE_KIND, null, null);
        if (applied == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        int version = applied.version();
        String text = note == null || note.isBlank() ? defaultNote : note.trim();
        definitions.recordStoredVersion(tenantId, siteId, entityId, version, subject, text);

        deployReadFlow(siteId, tenantId, entityId, version, label, def);
        entityRegistry.pushRegistryBestEffort(siteId);
    }

    /**
     * Kompiliert den Lese-Flow und rollt ihn über die BESTEHENDE Kette aus
     * (flowc → {@code upsertGenerated} → retained {@code v2/flows} →
     * Geräte-Ack). Ein Compiler-Ausfall ist ein 503 und lässt nichts zurück;
     * das VERTEILEN ist dagegen best-effort - dieselbe Begründung wie bei
     * {@link SelfBuildComponentService}: {@code republishForSite} meldet
     * {@code false} auch ohne konfigurierten Broker, und an dieser Stelle sind
     * Definition, Fassung und aktiver Flow bereits geschrieben.
     */
    private void deployReadFlow(UUID siteId, UUID tenantId, UUID entityId, int version,
            String label, Result def) {
        ObjectNode document = compiler.compile(siteId, tenantId, entityId, version, label,
                def.broker(), def.mappings(), def.publishIntervalS());
        FlowCompiler compilerBean = flowc.getIfAvailable();
        if (compilerBean == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Lese-Plan konnte gerade nicht gebaut werden. Bitte in einem Moment "
                            + "erneut versuchen.");
        }
        JsonNode artifact;
        try {
            artifact = compilerBean.compile(document);
            FlowDeployment.requireArtifactShape(artifact);
        } catch (FlowCompilerException e) {
            log.warn("user-defined battery read flow for {} did not compile: {} ({})", entityId,
                    e.getMessage(), e.reason());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Lese-Plan konnte nicht gebaut werden: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der gebaute Lese-Plan ist ungültig: " + e.getMessage());
        }

        UUID flowId = UserDefinedBatteryFlowCompiler.generatedFlowId(entityId);
        flows.upsertGenerated(tenantId, siteId, flowId, version,
                UserDefinedBatteryFlowCompiler.flowName(label), "edge", document.toString());
        flows.retireActive(flowId);
        flows.markActive(flowId, version, artifact.toString());
        if (!deployments.republishForSite(siteId)) {
            log.warn("user-defined battery read flow for {} stored but not distributed to site "
                    + "{} - the component reads as 'unreported' until the next publish",
                    entityId, siteId);
        }
    }

    // ---- Formen -----------------------------------------------------------

    /**
     * Die gespeicherte Definition - sie wohnt in {@code connection_json} und ist
     * die EINE Wahrheit über diesen Anschluss. Der Registry-Push reicht sie als
     * {@code driver.connection} an die Box weiter (die sie überspringt, weil
     * {@code communication} sie als selbst angebunden markiert); der LESEPLAN
     * reist dagegen im Flow, nicht hier.
     *
     * <p>{@code soc_derivation} ist der ANDOCKPUNKT für P5b: der Block wird
     * schon heute geschrieben, wenn es einen gemessenen Ladestand gibt, damit
     * die spätere Kennlinien-Methode ein Feld vorfindet statt eines zu
     * erfinden. Fehlt der Ladestand, fehlt der Block - eine Ableitung ohne
     * Eingang wäre eine Behauptung.
     */
    private String definitionJson(Result def) {
        ObjectNode root = mapper.createObjectNode();
        root.put("schema_version", "1.0");
        root.put("transport", "mqtt_local");
        ObjectNode broker = root.putObject("broker");
        broker.put("host", def.broker().host().trim());
        broker.put("port", def.broker().effectivePort());
        root.put("publish_interval_s", def.publishIntervalS());
        ArrayNode mappings = root.putArray("mappings");
        for (NormalizedMapping m : def.mappings()) {
            ObjectNode n = mappings.addObject();
            n.put("channel", m.channel());
            n.put("unit", m.unit());
            n.put("topic", m.topic());
            n.put("path", m.path());
            n.put("aggregate", m.aggregate());
            n.put("value_type", m.valueType());
            n.put("scale", m.scale());
            n.put("offset", m.offset());
            if (m.sentinel() != null) {
                n.put("sentinel", m.sentinel());
            }
            n.put("stale_s", m.staleS());
            if (!m.trueValues().isEmpty()) {
                ArrayNode t = n.putArray("true_values");
                m.trueValues().forEach(t::add);
            }
            if (!m.falseValues().isEmpty()) {
                ArrayNode f = n.putArray("false_values");
                m.falseValues().forEach(f::add);
            }
        }
        SocDerivation soc = def.socDerivation();
        if (soc != null) {
            root.putObject("soc_derivation").put("method", soc.method());
        }
        return root.toString();
    }

    /**
     * Die Messkanäle der Batterie - die ZUGEORDNETEN, samt ihrer
     * Standard-Einheit aus dem Typkatalog.
     */
    private JsonNode capabilities(List<NormalizedMapping> mappings) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        for (NormalizedMapping m : mappings) {
            measure.addObject().put("channel", m.channel()).put("unit", m.unit());
        }
        return caps;
    }

    /**
     * Diese Stufe ist NUR-LESEND. {@code measure-only} ist auf der Box die
     * Schutz-Semantik „verwirf jedes Kommando".
     */
    private JsonNode guards() {
        ObjectNode guards = mapper.createObjectNode();
        guards.putObject("limits");
        guards.putObject("failsafe").put("behavior", "measure-only");
        return guards;
    }

    private static String label(SaveUserDefinedBatteryRequest req) {
        String l = req == null || req.label() == null ? "" : req.label().trim();
        return l.isEmpty() ? "Eigene Batterie" : l;
    }

    private static Broker broker(SaveUserDefinedBatteryRequest req) {
        SaveUserDefinedBatteryRequest.Broker b = req == null ? null : req.broker();
        return b == null ? new Broker(null, null) : new Broker(b.host(), b.port());
    }

    private static SocDerivation soc(SaveUserDefinedBatteryRequest req) {
        SaveUserDefinedBatteryRequest.SocDerivationRequest s =
                req == null ? null : req.socDerivation();
        return s == null ? null : new SocDerivation(s.method());
    }

    private static List<Mapping> mappings(SaveUserDefinedBatteryRequest req) {
        List<Mapping> out = new ArrayList<>();
        if (req == null || req.mappings() == null) {
            return out;
        }
        for (SaveUserDefinedBatteryRequest.MappingRequest m : req.mappings()) {
            if (m == null) {
                out.add(null);
                continue;
            }
            out.add(new Mapping(m.channel(), m.topic(), m.path(), m.aggregate(), m.valueType(),
                    m.scale(), m.offset(), m.sentinel(), m.staleS(), m.trueValues(),
                    m.falseValues()));
        }
        return out;
    }
}
