package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Binding;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Broker;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Mapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.NormalizedMapping;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.Result;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocAnchor;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocDerivation;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocParams;
import com.voltpilot.api.components.UserDefinedBatteryDefinition.SocRecalibrate;
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
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.topology.TopologyRepository;
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
    private final SocCurveTemplateCatalog curves;
    private final UserDefinedBatteryFlowCompiler compiler;
    private final FlowRepository flows;
    private final FlowActivationService deployments;
    private final ObjectProvider<FlowCompiler> flowc;
    private final TopologyRepository topology;
    private final ObjectMapper mapper;

    public UserDefinedBatteryService(SiteRepository sites, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, EntityTypeCatalog typeCatalog,
            ComponentDefinitionRepository definitions, ComponentService components,
            SocCurveTemplateCatalog curves, UserDefinedBatteryFlowCompiler compiler,
            FlowRepository flows,
            FlowActivationService deployments, ObjectProvider<FlowCompiler> flowc,
            TopologyRepository topology, ObjectMapper mapper) {
        this.sites = sites;
        this.entityRepo = entityRepo;
        this.entityRegistry = entityRegistry;
        this.typeCatalog = typeCatalog;
        this.definitions = definitions;
        this.components = components;
        this.curves = curves;
        this.compiler = compiler;
        this.flows = flows;
        this.deployments = deployments;
        this.flowc = flowc;
        this.topology = topology;
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
        requireBindingTarget(siteId, null, def.bindingOrUnbound());

        UUID tenantId = TenantContext.get();
        String label = label(req);
        EntityRow row = entityRegistry.createEntity(siteId,
                UserDefinedBatteryDefinition.ENTITY_TYPE, label, null,
                capabilities(def), guards());

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
        requireBindingTarget(siteId, existing.id(), def.bindingOrUnbound());

        String label = label(req);
        // Die Zuordnungs-Liste ist zugleich die Fähigkeiten-Liste: ein
        // entferntes Ziel muss auch als Messwert verschwinden, sonst verspräche
        // die Batterie einen Wert, den niemand mehr liest.
        entityRegistry.updateEntity(siteId, existing.id(), label, null,
                capabilities(def), null);
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
                req == null ? null : req.publishIntervalS(), soc(req), allowedChannels(),
                binding(req));
        if (!def.ok()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    String.join(" ", def.errors()));
        }
        return def;
    }

    private static Binding binding(SaveUserDefinedBatteryRequest req) {
        SaveUserDefinedBatteryRequest.BindingRequest b = req == null ? null : req.binding();
        return b == null ? null : new Binding(b.mode(), b.inverterEntityId());
    }

    /**
     * Der gebundene Wechselrichter muss EXISTIEREN und ein Speicher sein.
     *
     * <p>Zwei Prüfungen, zwei Gründe. Die Existenz, weil eine Bindung an eine
     * fremde oder gelöschte Entität eine Anzeige „Ladestand von: …" ergäbe, die
     * ins Leere zeigt - und weil RLS eine fremde Anlage ohnehin verbirgt, ist
     * die ehrliche Antwort dort 404, nie 403. Die KATEGORIE, weil ein Speiser
     * einen Speicher speist: eine Batterie an eine Wallbox zu hängen wäre eine
     * Aussage über die Anlage, die niemand belegen kann.
     *
     * <p>Und sie darf nicht sie selbst sein: eine Batterie, die sich an sich
     * selbst hängt, ist der eigenständige Fall - dafür gibt es
     * {@code standalone}, und die beiden Wege auseinanderzuhalten ist genau
     * der Punkt der ausdrücklichen Bindung.
     */
    private void requireBindingTarget(UUID siteId, UUID selfEntityId, Binding binding) {
        if (binding == null
                || !UserDefinedBatteryDefinition.BINDING_FEEDS_INVERTER.equals(binding.mode())) {
            return;
        }
        UUID target;
        try {
            target = UUID.fromString(binding.inverterEntityId());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der gewählte Wechselrichter ist keine gültige Gerätekennung.");
        }
        if (target.equals(selfEntityId)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Eine Batterie kann nicht an sich selbst hängen. Wenn es keinen "
                            + "Wechselrichter gibt, ist sie selbst der Speicher.");
        }
        EntityRow row = entityRepo.entityForSite(siteId, target);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Der gewählte Wechselrichter gehört nicht zu dieser Anlage.");
        }
        EntityTypeCatalog.EntityType type = typeCatalog.find(row.entityType());
        if (type == null || !"storage".equals(type.category())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "„" + (row.label() == null ? row.entityType() : row.label())
                            + "“ ist kein Speicher-Wechselrichter - eine Batterie kann nur an "
                            + "einem hängen.");
        }
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

        applyBinding(siteId, tenantId, entityId, def);
        deployReadFlow(siteId, tenantId, entityId, version, label, def);
        entityRegistry.pushRegistryBestEffort(siteId);
    }

    /**
     * Die SPEISER-BINDUNG (P6) als das, was sie IST: eine ausdrückliche
     * Rollen-Zuordnung.
     *
     * <p><b>Warum sie in {@code entity_role_assignment} landet und nicht in
     * einem eigenen Mechanismus:</b> die Tabelle ist genau dafür da („diese
     * Fähigkeit gehört zu …", AE1) und ihre Kette ist bewiesen - das
     * Lesemodell löst sie vor der Vorgabe auf, und der Registry-Push trägt sie
     * als {@code role_assignment} zur Box (Befund L4), damit {@code :8484}
     * denselben Energiefluss zeichnet wie das Portal. Ein zweiter Weg zum
     * selben Ziel wären zwei Wahrheiten über einen Speicher-Knoten.
     *
     * <p><b>Was hier NICHT passiert:</b> ein Kanal bekommt nie eine Rolle,
     * weil er so heißt. Die Vorgabe für diesen Typ ist seit P6 „keine Rolle"
     * ({@code TopologyDeriver.isSelfBuiltType}), und nur diese Zeilen holen ihn
     * in die Bilanz - genau der Captain-Entscheid E6 (a).
     *
     * <p><b>Aufgeräumt wird immer vollständig:</b> jeder Kanal, der nicht mehr
     * eingespeist wird, verliert seine Zeile. Sonst überlebte die Zuordnung
     * einer entfernten Feld-Abbildung ihre Quelle und der Speicher-Knoten
     * behielte einen Ladestand, den niemand mehr liefert.
     */
    private void applyBinding(UUID siteId, UUID tenantId, UUID entityId, Result def) {
        List<String> bound = def.boundChannels();
        for (String channel : UserDefinedBatteryDefinition.BOUND_CHANNELS) {
            if (!bound.contains(channel)) {
                topology.deleteOverride(siteId, entityId, channel);
            }
        }
        if (!bound.contains(UserDefinedBatteryDefinition.POWER_CHANNEL)) {
            topology.deleteOverride(siteId, entityId,
                    UserDefinedBatteryDefinition.POWER_CHANNEL);
        }
        for (String channel : bound) {
            // maßgeblich, und das ist die halbe Aussage der Bindung: der Kunde
            // sagt, DIESE Batterie liefert den Ladestand des Speichers - ein
            // Hybrid-Wechselrichter, der daneben einen eigenen (im
            // Spannungsmodus erfundenen) meldet, darf ihn nicht überstimmen.
            topology.upsertOverride(tenantId, siteId, entityId, channel,
                    TopologyDeriver.ROLE_STORAGE, true);
        }
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
                def.broker(), def.mappings(), def.publishIntervalS(), def.socDerivation());
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

    // ---- Vorschau (P5d) ---------------------------------------------------

    /**
     * Wie lange die Box lauscht, bevor sie die Vorschau beantwortet.
     *
     * <p>Der Grund für ein FENSTER statt einer Einmal-Lesung: MQTT wird nicht
     * abgefragt, es kommt an. Ein BMS, das alle 10 s sendet, hätte auf eine
     * Momentaufnahme in aller Regel nichts zu sagen - und „nichts empfangen"
     * wäre dann eine Aussage über den Zeitpunkt, nicht über die Zuordnung.
     * Kurz genug, dass der Assistent nicht einfriert (der Probe-Kanal wartet
     * ohnehin nur wenige Sekunden auf eine Antwort).
     */
    public static final int PREVIEW_LISTEN_S = 8;

    /**
     * Die Zuordnungs-VORSCHAU (P5d): dieselbe geprüfte Definition, die ein
     * Speichern schreiben würde, als {@code connection}-Block einer
     * {@code test_connection}-Anfrage an die Box.
     *
     * <p><b>Sie schreibt NICHTS</b> - keine Entität, keine Fassung, kein Flow,
     * kein Beleg. Sie beantwortet genau eine Frage: „kommt unter diesem Topic
     * mit diesem Wertepfad wirklich etwas an, und ergibt meine Skalierung eine
     * plausible Zahl?" Genau der Moment, in dem ein Skalierungsfehler sichtbar
     * wird, den der Modbus-Baukasten mit „Jetzt lesen" hat.
     *
     * <p><b>Sie ist bewusst KEINE Pflicht.</b> Anders als beim Katalog-Gerät
     * gibt es hier keinen Verbindungstest-Zwang: eine Box, die noch nicht
     * lauschen kann, würde ihn zur Sackgasse machen, und eine Pflicht ohne Tür
     * ist kein Schutz. Sie ist ein ANGEBOT - und ihr Ausbleiben ist nie ein
     * bewiesener Fehlschlag.
     *
     * <p>Der Block ist WÖRTLICH die gespeicherte Definition (plus dem
     * Lauschfenster): eine zweite, nur für die Vorschau gebaute Form wäre ein
     * Zwilling, der von dem abdriften darf, was hinterher wirklich gelesen
     * wird - und damit eine Vorschau auf etwas anderes als das Ergebnis.
     */
    public Map<String, Object> previewConnection(UUID siteId,
            SaveUserDefinedBatteryRequest req) {
        requireSite(siteId);
        Result def = requireValid(req);
        try {
            ObjectNode root = (ObjectNode) mapper.readTree(definitionJson(def));
            root.put("listen_s", PREVIEW_LISTEN_S);
            return mapper.convertValue(root, new com.fasterxml.jackson.core.type
                    .TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Die Vorschau konnte nicht vorbereitet werden.");
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
            root.set("soc_derivation", socJson(soc));
        }
        // Die SPEISER-BINDUNG (P6) reist immer mit - auch als „unbound". Sie
        // ist eine ANTWORT des Kunden, und ein fehlender Block hiesse „nicht
        // gefragt"; das Bearbeiten-Formular könnte die beiden dann nicht
        // auseinanderhalten.
        Binding binding = def.bindingOrUnbound();
        ObjectNode bind = root.putObject("binding");
        bind.put("mode", binding.mode());
        if (binding.inverterEntityId() != null) {
            bind.put("inverter_entity_id", binding.inverterEntityId());
        }
        return root.toString();
    }

    /**
     * Die Messkanäle der Batterie - die ZUGEORDNETEN, samt ihrer
     * Standard-Einheit aus dem Typkatalog.
     *
     * <p><b>Seit P5b kommen ABGELEITETE Kanäle dazu, und zwar aus demselben
     * Grund, aus dem die Liste sonst so knapp ist:</b> sie nennt, was die
     * Batterie WIRKLICH liefert. Rechnet eine Kennlinie oder eine
     * Ladungszählung den Ladestand aus, dann liefert diese Batterie
     * {@code soc_pct} - er steht nur nicht in der Zuordnung, weil ihn niemand
     * sendet. Ihn zu verschweigen wäre derselbe Fehler wie ihn zu versprechen,
     * bloß mit umgekehrtem Vorzeichen: der generierte Flow fordert
     * {@code measure:soc_pct} an, und ohne die Fähigkeit fiele er bei der
     * Aktivierung durch.
     *
     * <p>{@code soc_source_code} reist immer mit, sobald es überhaupt einen
     * Ladestand gibt - er ist die HERKUNFT dieses Wertes, je Messzeitpunkt, und
     * damit das, was die Historie später die damalige Quelle nennen lässt.
     */
    private JsonNode capabilities(Result def) {
        Map<String, String> allowed = allowedChannels();
        Map<String, String> out = new LinkedHashMap<>();
        for (NormalizedMapping m : def.mappings()) {
            out.put(m.channel(), m.unit());
        }
        if (def.socDerivation() != null) {
            out.put(UserDefinedBatteryDefinition.SOC_CHANNEL,
                    allowed.getOrDefault(UserDefinedBatteryDefinition.SOC_CHANNEL, "%"));
            out.put(UserDefinedBatteryDefinition.SOC_SOURCE_CHANNEL,
                    allowed.getOrDefault(UserDefinedBatteryDefinition.SOC_SOURCE_CHANNEL, ""));
        }
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        out.forEach((channel, unit) ->
                measure.addObject().put("channel", channel).put("unit", unit));
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

    /**
     * Die gespeicherte Form der SoC-Ableitung - VOLLSTÄNDIG ausgeschrieben.
     *
     * <p>Sie reist als {@code driver.connection} zur Box (die sie überspringt)
     * und ist die Anzeige-Wahrheit über diesen Anschluss; der ausführende
     * Leseplan reist im Flow. Beide entstehen aus DERSELBEN geprüften
     * {@code SocDerivation} - eine zweite Ableitung der Felder hier wäre eine
     * zweite Wahrheit.
     */
    private ObjectNode socJson(SocDerivation soc) {
        ObjectNode root = mapper.createObjectNode();
        root.put("method", soc.method());
        root.put("prefer_direct", soc.preferDirect());
        root.put("hold_s", soc.holdS());
        if (soc.template() != null) {
            root.put("template", soc.template());
        }
        ObjectNode inputs = root.putObject("inputs");
        new java.util.TreeMap<>(soc.inputs()).forEach(inputs::put);
        ObjectNode params = root.putObject("params");
        SocParams p = soc.params();
        putCurve(params, "curve_charge", p.curveCharge());
        putCurve(params, "curve_discharge", p.curveDischarge());
        if (p.cellsInSeries() != null) {
            params.put("cells_in_series", p.cellsInSeries());
        }
        params.put("conservative_min", p.conservativeMin());
        params.put("round_pct", p.roundPct());
        if (p.capacityKwh() != null) {
            params.put("capacity_kwh", p.capacityKwh());
        }
        if (p.efficiencyPct() != null) {
            params.put("efficiency_pct", p.efficiencyPct());
        }
        if (p.nominalVoltageV() != null) {
            params.put("nominal_voltage_v", p.nominalVoltageV());
        }
        if (p.refTempC() != null) {
            params.put("ref_temp_c", p.refTempC());
        }
        if (p.anchor() != null) {
            ObjectNode anchor = params.putObject("anchor");
            anchor.put("soc_pct", p.anchor().socPct());
            if (p.anchor().at() != null && !p.anchor().at().isBlank()) {
                anchor.put("at", p.anchor().at().trim());
            }
        }
        if (p.recalibrate() != null) {
            ObjectNode r = params.putObject("recalibrate");
            if (p.recalibrate().fullCellMv() != null) {
                r.put("full_cell_mv", p.recalibrate().fullCellMv());
                r.put("full_soc_pct", p.recalibrate().fullSocPct());
            }
            if (p.recalibrate().emptyCellMv() != null) {
                r.put("empty_cell_mv", p.recalibrate().emptyCellMv());
                r.put("empty_soc_pct", p.recalibrate().emptySocPct());
            }
        }
        return root;
    }

    private static void putCurve(ObjectNode params, String field, List<double[]> curve) {
        if (curve == null || curve.isEmpty()) {
            return;
        }
        ArrayNode out = params.putArray(field);
        for (double[] point : curve) {
            ArrayNode pair = out.addArray();
            pair.add(point[0]);
            pair.add(point[1]);
        }
    }

    /**
     * Die Anfrage-Form der Ableitung in die geprüfte Form - inklusive der
     * KURVEN-VORLAGE.
     *
     * <p>Eine Vorlage FÜLLT nur, was leer ist: eigene Stützpunkte gewinnen
     * immer. Ein unbekannter Vorlagen-Name wird BENANNT abgelehnt statt
     * stillschweigend ignoriert - sonst hätte der Kunde eine Kurve gewählt und
     * eine leere Kennlinie bekommen.
     */
    private SocDerivation soc(SaveUserDefinedBatteryRequest req) {
        SaveUserDefinedBatteryRequest.SocDerivationRequest s =
                req == null ? null : req.socDerivation();
        if (s == null) {
            return null;
        }
        SaveUserDefinedBatteryRequest.SocParamsRequest p = s.params();
        List<double[]> charge = pairs(p == null ? null : p.curveCharge());
        List<double[]> discharge = pairs(p == null ? null : p.curveDischarge());
        Integer cells = p == null ? null : p.cellsInSeries();
        Double refTemp = p == null ? null : p.refTempC();

        String templateId = s.template() == null || s.template().isBlank() ? null
                : s.template().trim();
        if (templateId != null) {
            SocCurveTemplateCatalog.Template t = curves.find(templateId);
            if (t == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Diese Kennlinien-Vorlage kennen wir nicht.");
            }
            if (charge == null) {
                charge = t.curveCharge();
            }
            if (discharge == null) {
                discharge = t.curveDischarge();
            }
            if (cells == null) {
                cells = t.cellsInSeries();
            }
            if (refTemp == null) {
                refTemp = t.refTempC();
            }
        }

        Map<String, String> inputs = new LinkedHashMap<>();
        SaveUserDefinedBatteryRequest.SocInputsRequest in = s.inputs();
        if (in != null) {
            putInput(inputs, "soc", in.soc());
            putInput(inputs, "cell_min", in.cellMin());
            putInput(inputs, "cell_max", in.cellMax());
            putInput(inputs, "voltage", in.voltage());
            putInput(inputs, "current", in.current());
            putInput(inputs, "power", in.power());
        }

        SocAnchor anchor = p == null || p.anchor() == null || p.anchor().socPct() == null ? null
                : new SocAnchor(p.anchor().socPct(), p.anchor().at());
        SocRecalibrate recal = p == null || p.recalibrate() == null ? null
                : new SocRecalibrate(p.recalibrate().fullCellMv(), p.recalibrate().fullSocPct(),
                        p.recalibrate().emptyCellMv(), p.recalibrate().emptySocPct());

        SocParams params = new SocParams(charge, discharge, cells,
                p == null || p.conservativeMin() == null || p.conservativeMin(),
                p == null || p.roundPct() == null
                        ? UserDefinedBatteryDefinition.DEFAULT_ROUND_PCT : p.roundPct(),
                p == null ? null : p.capacityKwh(),
                p == null ? null : p.efficiencyPct(),
                p == null ? null : p.nominalVoltageV(),
                refTemp, anchor, recal);
        return new SocDerivation(s.method(), s.preferDirect() == null || s.preferDirect(),
                inputs, params, templateId,
                s.holdS() == null ? UserDefinedBatteryDefinition.DEFAULT_HOLD_S : s.holdS());
    }

    private static void putInput(Map<String, String> out, String role, String channel) {
        if (channel != null && !channel.isBlank()) {
            out.put(role, channel.trim());
        }
    }

    /** Kennlinien-Paare aus der Anfrage; ein unvollständiges Paar bleibt drin. */
    private static List<double[]> pairs(List<List<Double>> raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        List<double[]> out = new ArrayList<>();
        for (List<Double> p : raw) {
            if (p == null || p.size() < 2 || p.get(0) == null || p.get(1) == null) {
                // Ein kaputtes Paar wird NICHT verschluckt - es reist als
                // leeres Paar weiter und die Prüfung nennt es beim Namen.
                out.add(new double[0]);
                continue;
            }
            out.add(new double[] {p.get(0), p.get(1)});
        }
        return out;
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
