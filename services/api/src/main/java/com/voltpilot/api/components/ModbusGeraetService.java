package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerAuditRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.web.dto.SiteComponentsDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das eigene Modbus-Gerät mit Lese- UND Schreibwerten (Steuerlogik K3,
 * {@code docs/contracts/v2/modbus-geraet.md}): anlegen, ändern, je Schreibwert
 * testen, freigeben, Freigabe zurücknehmen. Seit E8 (Pi-Ablösung-Konzept) auch
 * ein Gerät OHNE jeden Schreibwert (ein reines Selbstbau-Messgerät) - aber nur
 * für eine Anlage, deren führende Box den Go-Kern trägt (Edge Light oder Edge
 * Industrie, siehe {@link #speichern}): dort gibt es sonst keinen Weg, ein solches
 * Gerät zu lesen, da der Go-Kern kein Node-RED für den Lese-Flow der Selbstbau-Tür hat.
 *
 * <p>Es benutzt die Maschinerie der Selbstbau-Tür - Fassungen in
 * {@code connection_json}, Verbindungstest-Pflicht, Schalt-Test über den
 * Probe-Kanal, Freigabe nur mit bestandenem Test UND bestätigter Wirkung -
 * mit drei Unterschieden:
 *
 * <ul>
 *   <li><b>Die Box liest und schreibt selbst.</b> Für ein solches Gerät gibt es
 *       keinen Node-RED-Flow; der Core der Box (beide Box-Arten) hält die eine
 *       Verbindung. Darum geht es nur an eine Box, die {@code modbus_geraet}
 *       meldet.</li>
 *   <li><b>Jeder Schreibwert hat seinen Test.</b> Die Freigabe braucht einen
 *       bestandenen Test für JEDEN Schreibwert in genau dieser Form (Register,
 *       Werte, Band, Liste); ändert sich einer, entfällt die Freigabe.</li>
 *   <li><b>Die Ruhewerte statt „aus“.</b> Ohne Wunsch und bei einer Störung des
 *       Geräts gilt der Ruhewert je Schreibwert ({@code failsafe: rest}).</li>
 * </ul>
 */
@Service
public class ModbusGeraetService {

    private static final Logger log = LoggerFactory.getLogger(ModbusGeraetService.class);

    /** Der Beleg-Schlüssel des Tests eines Schreibwerts. */
    public static final String TEST_RECEIPT_REF = "custom:geraet";

    public record SpeichernRequest(String label, JsonNode definition) {
    }

    public record TestRequest(String slug, JsonNode wert) {
    }

    public record FreigabeRequest(Boolean physicallyConfirmed) {
    }

    private final Geltungsbereich geltungsbereich;
    private final EntityRegistryRepository entityRepo;
    private final EntityRegistryService entityRegistry;
    private final ComponentDefinitionRepository definitions;
    private final ComponentService components;
    private final ComponentConnectionReceipts receipts;
    private final FlowRepository flows;
    private final FlowActivationService deployments;
    private final ProbeService probes;
    private final ConsumerAuditRepository audit;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten faehigkeiten;
    private final UpdateStatusRepository updateStatus;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    public ModbusGeraetService(Geltungsbereich geltungsbereich, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, ComponentDefinitionRepository definitions,
            ComponentService components, ComponentConnectionReceipts receipts, FlowRepository flows,
            FlowActivationService deployments, ProbeService probes, ConsumerAuditRepository audit,
            LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten, UpdateStatusRepository updateStatus,
            ObjectMapper mapper) {
        this(geltungsbereich, entityRepo, entityRegistry, definitions, components, receipts, flows, deployments,
                probes, audit, leadDevices, faehigkeiten, updateStatus, mapper, Clock.systemUTC());
    }

    ModbusGeraetService(Geltungsbereich geltungsbereich, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, ComponentDefinitionRepository definitions,
            ComponentService components, ComponentConnectionReceipts receipts, FlowRepository flows,
            FlowActivationService deployments, ProbeService probes, ConsumerAuditRepository audit,
            LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten, UpdateStatusRepository updateStatus,
            ObjectMapper mapper, Clock clock) {
        this.geltungsbereich = geltungsbereich;
        this.entityRepo = entityRepo;
        this.entityRegistry = entityRegistry;
        this.definitions = definitions;
        this.components = components;
        this.receipts = receipts;
        this.flows = flows;
        this.deployments = deployments;
        this.probes = probes;
        this.audit = audit;
        this.leadDevices = leadDevices;
        this.faehigkeiten = faehigkeiten;
        this.updateStatus = updateStatus;
        this.mapper = mapper;
        this.clock = clock;
    }

    // ---- Anlegen / Ändern -------------------------------------------------

    /**
     * Legt ein Gerät an (entityId null) oder ersetzt die Definition eines
     * Selbstbau-Geräts - auch eines, das bisher nur gemessen hat. Bleiben die
     * Schreibwerte gleich, bleibt die Freigabe; ändert sich einer, entfällt
     * sie, denn sie belegte genau diese Register und Werte.
     *
     * <p>Seit E8 (Pi-Ablösung-Konzept) nimmt dieser Weg auch ein Gerät OHNE
     * jeden Schreibwert an - aber nur für eine Anlage, deren führende Box
     * Edge Light oder Edge Industrie ist: nur dort liest der Core ein solches Gerät selbst
     * ({@code AusEntity} ohne {@code controls}-Zweig); auf der Docker-Box
     * bliebe die Entität unlesbar, denn ihr generierter Lese-Flow entsteht
     * nur über die Selbstbau-Tür ({@link SelfBuildComponentService}), die
     * dort weiterhin der richtige Weg ist.
     */
    @Transactional
    public SiteComponentsDto speichern(UUID siteId, UUID entityId, SpeichernRequest req, String subject) {
        geltungsbereich.requireSite(siteId);
        requirePortalManaged(siteId);
        UUID box = requireBoxKann(siteId);
        ModbusGeraetDefinition.Ergebnis e = ModbusGeraetDefinition.pruefe(
                req == null ? null : req.definition(), mapper);
        if (!e.ok()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, String.join(" ", e.texte()));
        }
        ObjectNode def = e.definition();
        JsonNode values = def.path("controls").path("values");
        boolean hatSchreibwerte = values.isArray() && !values.isEmpty();
        if (!hatSchreibwerte) {
            if (!BoxArt.istGoKern(updateStatus.boxArt(box))) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Ein Gerät ohne Schreibwerte legen Sie über „Eigenes Gerät“ an.");
            }
            if (!def.path("controls").isObject()) {
                // Normalisiert: auch ohne Schreibwerte trägt die Definition
                // einen (leeren) controls-Block, damit die alte Selbstbau-Tür
                // dieses Gerät an "hat controls" erkennt (requireOhneSchreibwerte)
                // und seine Signale nie versehentlich verwirft.
                def.putObject("controls").putArray("values");
            }
        }
        requireTested(siteId, def);
        String label = req.label() == null || req.label().isBlank() ? "Eigenes Modbus-Gerät" : req.label().trim();
        UUID tenantId = TenantContext.get();

        boolean freigegeben = false;
        UUID id = entityId;
        if (id == null) {
            EntityRow row = entityRegistry.createEntity(siteId, SelfBuildDefinition.ENTITY_TYPE, label, null,
                    ModbusGeraetDefinition.faehigkeiten(def, false, mapper),
                    ModbusGeraetDefinition.schutz(def, false, mapper));
            id = row.id();
        } else {
            EntityRow row = requireSelfBuilt(siteId, id);
            JsonNode alt = parse(row.connectionJson());
            if (alt.has("switch")) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Dieses Gerät hat einen freigegebenen Schalter. Bitte nehmen Sie diese Freigabe zuerst "
                                + "zurück; danach lassen sich Schreibwerte festlegen.");
            }
            JsonNode altFreigabe = alt.path("controls").path("freigabe");
            if (altFreigabe.isObject() && gleicheSchreibwerte(alt, def)) {
                ((ObjectNode) def.path("controls")).set("freigabe", altFreigabe.deepCopy());
                freigegeben = true;
            } else if (altFreigabe.isObject()) {
                audit.append(siteId, id, "switch_revoked", null, null, subject,
                        "Freigabe entfällt: die Schreibwerte haben sich geändert");
            }
        }
        entityRegistry.updateEntity(siteId, id, label, null, null, null);
        entityRepo.setEntityConfig(id, freigegeben ? ModbusGeraetDefinition.ENTITY_TYPE
                : SelfBuildDefinition.ENTITY_TYPE,
                ModbusGeraetDefinition.faehigkeiten(def, freigegeben, mapper).toString(),
                ModbusGeraetDefinition.schutz(def, freigegeben, mapper).toString());
        schreibe(siteId, tenantId, id, label, def, subject, entityId == null ? "Angelegt" : "Geändert");
        return components.list(siteId);
    }

    // ---- Test je Schreibwert ----------------------------------------------

    /**
     * Der geführte Test EINES Schreibwerts: schreibt einmal den gewählten
     * Testwert, die Box armiert das automatische Zurück auf den Ruhewert nach
     * 30 s, und gespeichert wird nur der Beleg. Ein Testwert außerhalb des
     * Bands wird abgelehnt, nicht hineingeklemmt.
     */
    @Transactional // schreibt die Audit-Spur
    public SelfBuildComponentService.SwitchTestResult test(UUID siteId, UUID entityId, TestRequest req,
            String subject) {
        geltungsbereich.requireSite(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        JsonNode def = requireGeraet(row);
        JsonNode c = ModbusGeraetDefinition.control(def, req == null ? null : req.slug());
        if (c == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Diesen Schreibwert hat das Gerät nicht.");
        }
        JsonNode wert = req.wert();
        String fehler = ModbusGeraetDefinition.testwertFehler(c, wert);
        if (fehler != null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, fehler);
        }
        int raw = ModbusGeraetDefinition.roh(c, wert);
        int ruhe = ModbusGeraetDefinition.rohRuhe(c);
        JsonNode t = def.path("transport");
        String registerKind = c.path("register").path("kind").asText();
        Integer readback = null;
        JsonNode rb = c.path("readback");
        if (!rb.isObject()) {
            readback = c.path("register").path("address").asInt();
        } else if (registerKind.equals(rb.path("kind").asText())) {
            readback = rb.path("address").asInt();
        }
        ProbeResult res = probes.switchOp(siteId, null, entityId,
                new ProbePublisher.SwitchOp("switch_test", c.path("slug").asText(), t.path("host").asText(),
                        t.path("port").asInt(502), t.path("unit_id").asInt(1), registerKind,
                        c.path("register").path("address").asInt(), ModbusGeraetDefinition.effectiveFc(c), raw,
                        ruhe, SwitchDefinition.TEST_TTL_S, readback),
                subject);
        boolean bestanden = bestanden(res, raw);
        String evidenz = c.path("slug").asText() + ": Wert " + raw + rueckgelesen(res);
        if (bestanden) {
            receipts.record(siteId, TEST_RECEIPT_REF, testFelder(entityId, def, c), evidenz);
        }
        audit.append(siteId, entityId, "switch_tested", null, null, subject,
                (bestanden ? "bestanden" : "fehlgeschlagen") + ", " + evidenz);
        return new SelfBuildComponentService.SwitchTestResult(bestanden, SwitchDefinition.TEST_TTL_S,
                res.errorCode(), res.message(), switched(res));
    }

    // ---- Freigabe ---------------------------------------------------------

    /**
     * Die FREIGABE: ein bestandener Test für JEDEN Schreibwert in genau dieser
     * Form UND die Bestätigung, dass die Wirkung am Gerät gesehen wurde. Erst
     * danach trägt die Entität die Schreibwerte als Fähigkeiten, und erst
     * danach schreibt die Box.
     */
    @Transactional
    public SiteComponentsDto freigeben(UUID siteId, UUID entityId, FreigabeRequest req, String subject) {
        geltungsbereich.requireSite(siteId);
        requirePortalManaged(siteId);
        requireBoxKann(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        ObjectNode def = (ObjectNode) requireGeraet(row).deepCopy();
        List<String> evidenz = new ArrayList<>();
        boolean alleGetestet = true;
        for (JsonNode c : def.path("controls").path("values")) {
            Map<String, Object> felder = testFelder(entityId, def, c);
            if (!receipts.has(siteId, TEST_RECEIPT_REF, felder)) {
                alleGetestet = false;
                break;
            }
            evidenz.add(receipts.evidence(siteId, TEST_RECEIPT_REF, felder));
        }
        String ablehnung = SwitchDefinition.requireRelease(alleGetestet,
                req != null && Boolean.TRUE.equals(req.physicallyConfirmed()));
        if (ablehnung != null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, alleGetestet ? ablehnung
                    : "Bitte testen Sie zuerst jeden Schreibwert - erst danach lässt sich das Gerät freigeben.");
        }
        ObjectNode f = ((ObjectNode) def.path("controls")).putObject("freigabe");
        f.put("released_at", clock.instant().toString());
        f.put("released_by", subject == null ? "" : subject);
        f.put("evidence", String.join("; ", evidenz));
        entityRepo.setEntityConfig(entityId, ModbusGeraetDefinition.ENTITY_TYPE,
                ModbusGeraetDefinition.faehigkeiten(def, true, mapper).toString(),
                ModbusGeraetDefinition.schutz(def, true, mapper).toString());
        schreibe(siteId, TenantContext.get(), entityId, row.label(), def, subject, "Schreibwerte freigegeben");
        audit.append(siteId, entityId, "switch_released", null, null, subject,
                "Schreibwerte " + String.join(", ", slugs(def)) + " (" + String.join("; ", evidenz) + ")");
        return components.list(siteId);
    }

    /**
     * Nimmt die Freigabe zurück: die Box schreibt nichts mehr, die Messwerte
     * und Signale liest sie weiter. Die Definition bleibt; die Tests müssen
     * vor einer neuen Freigabe wiederholt werden.
     */
    @Transactional
    public SiteComponentsDto zuruecknehmen(UUID siteId, UUID entityId, String subject) {
        geltungsbereich.requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        ObjectNode def = (ObjectNode) requireGeraet(row).deepCopy();
        ((ObjectNode) def.path("controls")).remove("freigabe");
        entityRepo.setEntityConfig(entityId, SelfBuildDefinition.ENTITY_TYPE,
                ModbusGeraetDefinition.faehigkeiten(def, false, mapper).toString(),
                ModbusGeraetDefinition.schutz(def, false, mapper).toString());
        schreibe(siteId, TenantContext.get(), entityId, row.label(), def, subject, "Freigabe zurückgenommen");
        audit.append(siteId, entityId, "switch_revoked", null, null, subject, "Schreibwerte");
        return components.list(siteId);
    }

    // ---- Helfer -----------------------------------------------------------

    /**
     * Schreibt die Definition als neue Fassung, zieht einen Node-RED-Leseplan
     * zurück (die Box liest selbst) und schiebt die Registry.
     */
    private void schreibe(UUID siteId, UUID tenantId, UUID entityId, String label, ObjectNode def,
            String subject, String notiz) {
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId, entityId, label,
                null, null, null, SelfBuildDefinition.COMMUNICATION, def.toString(),
                SelfBuildDefinition.SOURCE_KIND, null, null);
        if (applied == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        definitions.recordStoredVersion(tenantId, siteId, entityId, applied.version(), subject, notiz);
        flows.retireActive(SelfBuildFlowCompiler.generatedFlowId(entityId));
        if (!deployments.republishForSite(siteId)) {
            log.warn("modbus device {}: read flow retired but the flow set did not re-publish", entityId);
        }
        entityRegistry.pushRegistryBestEffort(siteId);
    }

    private void requirePortalManaged(UUID siteId) {
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(siteId))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Geräte dieser Anlage werden derzeit direkt am Gerät verwaltet. "
                            + "Änderungen nehmen Sie dort vor.");
        }
    }

    /**
     * Nur eine Box, die solche Geräte selbst liest und schreibt, bekommt eins:
     * eine ältere Box hätte für dieses Gerät weder einen Leseplan noch einen
     * Schreibweg, und das Portal zeigte ein Gerät, das nichts liefert.
     */
    private UUID requireBoxKann(UUID siteId) {
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        if (box == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat keine eindeutige führende Box, die das Gerät lesen könnte.");
        }
        if (!faehigkeiten.kann(box, ModbusGeraetDefinition.FAEHIGKEIT)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Box dieser Anlage kann Geräte mit Schreibwerten noch nicht selbst lesen und schreiben "
                            + "(Fähigkeit modbus_geraet fehlt). Bitte erst die Box aktualisieren.");
        }
        return box;
    }

    private void requireTested(UUID siteId, JsonNode def) {
        JsonNode t = def.path("transport");
        SelfBuildDefinition.Transport transport = new SelfBuildDefinition.Transport(t.path("host").asText(),
                t.path("port").asInt(502), t.path("unit_id").asInt(1));
        if (!receipts.has(siteId, SelfBuildComponentService.RECEIPT_REF,
                SelfBuildComponentService.receiptFields(transport))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Bitte lesen Sie zuerst einen Messwert dieses Geräts - erst danach lässt es sich speichern.");
        }
    }

    private EntityRow requireSelfBuilt(UUID siteId, UUID entityId) {
        EntityRow row = entityRepo.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        if (!SelfBuildDefinition.COMMUNICATION.equals(row.communication())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Diese Komponente wurde nicht selbst angelegt und lässt sich hier nicht bearbeiten.");
        }
        return row;
    }

    private JsonNode requireGeraet(EntityRow row) {
        JsonNode def = parse(row.connectionJson());
        JsonNode values = def.path("controls").path("values");
        if (!values.isArray() || values.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieses Gerät hat keine Schreibwerte.");
        }
        return def;
    }

    /** Ob zwei Definitionen dieselben Schreibwerte an derselben Adresse haben. */
    private boolean gleicheSchreibwerte(JsonNode alt, JsonNode neu) {
        ObjectNode a = alt.path("controls").deepCopy();
        ObjectNode b = neu.path("controls").deepCopy();
        a.remove("freigabe");
        b.remove("freigabe");
        return a.equals(b) && alt.path("transport").equals(neu.path("transport"));
    }

    /**
     * Woran der Beleg eines Tests hängt: die Verbindung und die GANZE Form des
     * Schreibwerts. Ein anderes Register, ein anderer Ein-Wert, ein anderes Band
     * ist eine andere Zusage - und entwertet den Test.
     */
    private Map<String, Object> testFelder(UUID entityId, JsonNode def, JsonNode c) {
        JsonNode t = def.path("transport");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("host", t.path("host").asText("").trim());
        m.put("port", t.path("port").asInt(502));
        m.put("unit_id", t.path("unit_id").asInt(1));
        m.put("entity", entityId.toString());
        m.put("control", c.toString());
        return m;
    }

    private static List<String> slugs(JsonNode def) {
        List<String> out = new ArrayList<>();
        def.path("controls").path("values").forEach(c -> out.add(c.path("slug").asText()));
        return out;
    }

    /** Bestanden heißt: die Box meldet den Schreibvorgang, und ein Rücklesen widerspricht nicht. */
    private static boolean bestanden(ProbeResult res, int raw) {
        if (res.errorCode() != null || res.results() == null || res.results().isEmpty()) {
            return false;
        }
        ProbeResult.OpResult line = res.results().get(0);
        ProbeResult.Switched sw = line.switched();
        if (sw != null && Boolean.FALSE.equals(sw.readbackMatches())) {
            return false;
        }
        return line.ok() && sw != null;
    }

    private static String rueckgelesen(ProbeResult res) {
        ProbeResult.Switched sw = switched(res);
        if (sw == null || sw.readback() == null) {
            return ", ohne Rücklesen";
        }
        return ", zurückgelesen " + sw.readback()
                + (Boolean.FALSE.equals(sw.readbackMatches()) ? " (weicht ab)" : " (passt)");
    }

    private static ProbeResult.Switched switched(ProbeResult res) {
        return res.results() == null || res.results().isEmpty() ? null : res.results().get(0).switched();
    }

    private JsonNode parse(String json) {
        try {
            return json == null || json.isBlank() ? mapper.createObjectNode() : mapper.readTree(json);
        } catch (Exception e) {
            return mapper.createObjectNode();
        }
    }
}
