package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.SelfBuildDefinition.Channel;
import com.voltpilot.api.components.SelfBuildDefinition.NormalizedChannel;
import com.voltpilot.api.components.SelfBuildDefinition.Result;
import com.voltpilot.api.components.SelfBuildDefinition.Transport;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowCompilerException;
import com.voltpilot.api.flows.FlowDeployment;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SaveSelfBuildRequest;
import com.voltpilot.api.web.dto.SelfBuildReadResult;
import com.voltpilot.api.web.dto.SiteComponentTemplateDto;
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
 * Die SELBSTBAU-TÜR, serverseitig (Einheitsmodell Stufe 3; Konzepte
 * vp-modbus-baukasten-k6 §2.2/§2.3 und vp-komponenten-einheit-h2 §4.1 Tür c):
 * der Kunde beschreibt sein eigenes Modbus-Gerät, und daraus entsteht eine
 * ganz normale Komponente samt ihrem generierten Lese-Flow.
 *
 * <p><b>Es gibt keinen Sonderpfad.</b> Was hier entsteht, ist eine v2-Entität
 * vom Typ {@code modbus-generic} mit frei benannten Messkanälen - alles
 * dahinter ist die bewiesene Maschinerie: der Registry-Push kennt sie, der
 * generierte Flow rollt über flowc und {@code v2/flows} aus, die Messwerte
 * laufen über {@code telemetry_v2} in Rollups, Historie und Explorer.
 *
 * <p><b>Die Regeln, die hier und nur hier leben:</b>
 *
 * <ul>
 *   <li><b>Nur „Nur messen" (Sensor).</b> Diese Stufe legt ausschließlich
 *       messende Geräte an; der Typ ist measure-only, die Box ist damit
 *       strukturell unfähig, so ein Gerät zu schalten. Schalten samt seinem
 *       Freigabe-Test ist die nächste Stufe - und bis dahin gibt es keinen
 *       halben Schreibpfad, den man später absichern müsste.</li>
 *   <li><b>Verbindungstest-PFLICHT</b>, wie in Stufe 1: das gespeicherte Soll
 *       IST der Lesepfad, ein Tippfehler in der IP macht das Gerät blind. Beleg
 *       ist ein erfolgreiches „Jetzt lesen" für genau diese Anlage + Verbindung
 *       ({@link ComponentConnectionReceipts}).</li>
 *   <li><b>Der Flow wird VOR dem ersten Schreibvorgang kompiliert</b>
 *       (das {@code ConsumerPolicyActivationService}-Muster). Eine Komponente,
 *       deren Leseplan nicht gebaut werden konnte, liest nichts - sie wäre eine
 *       Zeile, die ein Gerät verspricht, das es nicht gibt.</li>
 *   <li><b>Die Bilanz bleibt unberührt.</b> Ein Selbstbau-Sensor ist ein
 *       Topologie-Knoten mit eigenen Messwerten und geht NICHT in die
 *       Energiebilanz ein (§2.6): Haus/Netz/PV tragen weiterhin die
 *       Wechselrichter und Zähler. Der Heizstab hinter dem Modbus-Relais steckt
 *       im gemessenen Hausverbrauch längst drin; ihn ein zweites Mal zu zählen
 *       wäre schlicht falsch.</li>
 * </ul>
 */
@Service
public class SelfBuildComponentService {

    private static final Logger log = LoggerFactory.getLogger(SelfBuildComponentService.class);

    /**
     * Die Vorlagen-Kennung, unter der ein Selbstbau-Verbindungstest seinen Beleg
     * ablegt. Sie ist konstant, weil ein Selbstbau-Gerät bis zum Speichern noch
     * zu gar keiner Vorlage gehört - der Fingerabdruck lebt ohnehin von der
     * Anlage plus den Verbindungsfeldern.
     */
    public static final String RECEIPT_REF = "custom:modbus";

    private final SiteRepository sites;
    private final EntityRegistryRepository entityRepo;
    private final EntityRegistryService entityRegistry;
    private final ComponentDefinitionRepository definitions;
    private final ComponentService components;
    private final ComponentConnectionReceipts receipts;
    private final SiteComponentTemplateRepository templates;
    private final SelfBuildFlowCompiler compiler;
    private final FlowRepository flows;
    private final FlowActivationService deployments;
    private final ObjectProvider<FlowCompiler> flowc;
    private final ProbeService probes;
    private final ObjectMapper mapper;

    public SelfBuildComponentService(SiteRepository sites, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, ComponentDefinitionRepository definitions,
            ComponentService components, ComponentConnectionReceipts receipts,
            SiteComponentTemplateRepository templates, SelfBuildFlowCompiler compiler,
            FlowRepository flows, FlowActivationService deployments,
            ObjectProvider<FlowCompiler> flowc, ProbeService probes,
            ObjectMapper mapper) {
        this.sites = sites;
        this.entityRepo = entityRepo;
        this.entityRegistry = entityRegistry;
        this.definitions = definitions;
        this.components = components;
        this.receipts = receipts;
        this.templates = templates;
        this.compiler = compiler;
        this.flows = flows;
        this.deployments = deployments;
        this.flowc = flowc;
        this.probes = probes;
        this.mapper = mapper;
    }

    // ---- Anlegen / Ändern -------------------------------------------------

    /** Legt ein selbst definiertes Modbus-Gerät an. */
    @Transactional
    public SiteComponentsDto create(UUID siteId, SaveSelfBuildRequest req, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        Result def = requireValid(req);
        requireTested(siteId, def.transport());

        UUID tenantId = TenantContext.get();
        String label = label(req);
        EntityRow row = entityRegistry.createEntity(siteId, SelfBuildDefinition.ENTITY_TYPE, label,
                null, capabilities(def.channels()), guards());

        write(siteId, tenantId, row.id(), def, label, req.note(), subject, "Angelegt");
        return components.list(siteId);
    }

    /**
     * Ändert ein selbst definiertes Gerät - eine NEUE Fassung, die alte bleibt
     * abrufbar und per Rollback erreichbar (die Stufe-1-Maschinerie).
     */
    @Transactional
    public SiteComponentsDto update(UUID siteId, UUID entityId, SaveSelfBuildRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow existing = requireSelfBuilt(siteId, entityId);
        Result def = requireValid(req);
        requireTested(siteId, def.transport());

        String label = label(req);
        // Die Kanal-Liste ist zugleich die Fähigkeiten-Liste der Komponente:
        // ein entfernter Kanal muss auch als Messwert verschwinden, sonst
        // verspräche die Entität einen Wert, den niemand mehr liest.
        entityRegistry.updateEntity(siteId, existing.id(), label, null,
                capabilities(def.channels()), null);
        write(siteId, TenantContext.get(), existing.id(), def, label, req.note(), subject,
                "Geändert");
        return components.list(siteId);
    }

    /**
     * Entfernt ein selbst definiertes Gerät samt seinem Lese-Flow.
     *
     * <p>Die aufgezeichneten Messwerte bleiben in der Historie - sie sind
     * gemessen worden, und ein Gerät zu entfernen macht seine Vergangenheit
     * nicht ungeschehen.
     */
    @Transactional
    public SiteComponentsDto delete(UUID siteId, UUID entityId, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);

        // Erst den Leseplan zurückziehen, dann die Komponente: andersherum
        // bliebe für einen Moment ein Flow ausgerollt, dessen Ziel-Entität es
        // nicht mehr gibt.
        flows.retireActive(SelfBuildFlowCompiler.generatedFlowId(row.id()));
        entityRegistry.deleteEntity(siteId, row.id(), true);
        boolean published = deployments.republishForSite(siteId);
        if (!published) {
            log.warn("self-build component {} removed, but the flow set did not re-publish", entityId);
        }
        return components.list(siteId);
    }


    // ---- „Jetzt lesen" ----------------------------------------------------

    /**
     * Liest EINEN Kanal einmal am echten Gerät und gibt Roh- UND skalierten
     * Wert zurück (§2.3 Schritt 2, §2.5).
     *
     * <p>Es ist zugleich der Verbindungstest von Schritt 1 und die Live-Vorschau
     * von Schritt 2 - dieselbe Frage, dieselbe Antwort. Ein Erfolg hinterlegt
     * den Beleg, der das Speichern freigibt; ein Fehlschlag hinterlegt nichts.
     *
     * <p>Die LAN-Regel wird HIER schon geprüft, obwohl die Box sie unabhängig
     * noch einmal prüft: so bekommt ein Tippfehler seine Antwort sofort statt
     * nach einer Broker-Runde, und ein öffentliches Ziel wird nie angeklopft.
     */
    public SelfBuildReadResult read(UUID siteId, UUID deviceId, SaveSelfBuildRequest.Connection conn,
            SaveSelfBuildRequest.ChannelRequest channel, String subject) {
        requireSite(siteId);
        Transport transport = new Transport(conn == null ? null : conn.host(),
                conn == null ? null : conn.port(), conn == null ? null : conn.unitId());
        Channel c = new Channel(
                channel == null || channel.label() == null || channel.label().isBlank()
                        ? "Probe" : channel.label(),
                channel == null ? "" : channel.unit(),
                channel == null ? null : channel.registerKind(),
                channel == null ? null : channel.address(),
                channel == null ? null : channel.dataType(),
                channel == null ? null : channel.wordOrder(),
                channel == null ? null : channel.scale(),
                channel == null ? null : channel.offset(),
                // Der Mindestabstand ist eine Poll-Eigenschaft und für eine
                // EINZELNE Lesung bedeutungslos - hier würde er nur eine
                // Ablehnung erzeugen, die mit dem Gerät nichts zu tun hat.
                SelfBuildDefinition.DEFAULT_INTERVAL_S);
        Result def = SelfBuildDefinition.validate(transport, List.of(c));
        if (!def.ok()) {
            return new SelfBuildReadResult(false, null, null, null, null, null, "invalid_request",
                    String.join(" ", def.errors()), false);
        }
        NormalizedChannel n = def.channels().get(0);

        ProbeResult probe = probes.probe(siteId, new ProbeRequest(deviceId, List.of(
                new ProbeRequest.Op("probe", transport.host().trim(), transport.effectivePort(),
                        transport.effectiveUnitId(), n.registerKind(), n.address(), n.dataType(),
                        n.wordOrder(), n.scale(), n.offset()))), subject);

        if (probe.errorCode() != null || probe.results() == null || probe.results().isEmpty()) {
            return new SelfBuildReadResult(false, null, null, null, n.unit(), null,
                    probe.errorCode() == null ? "no_answer" : probe.errorCode(), probe.message(),
                    false);
        }
        ProbeResult.OpResult line = probe.results().get(0);
        if (!line.ok()) {
            return new SelfBuildReadResult(false, null, null, null, n.unit(), null,
                    line.errorCode(), line.message(), false);
        }
        // Erst JETZT gilt die Verbindung als belegt - und der Beleg hängt an der
        // Verbindung, nicht am Kanal: eine geänderte Skalierung erzwingt keinen
        // neuen Test, eine geänderte Adresse sehr wohl.
        receipts.record(siteId, RECEIPT_REF, receiptFields(transport));
        return new SelfBuildReadResult(true, line.raw(), line.registers(), line.value(), n.unit(),
                SelfBuildDefinition.hint(n.unit(), line.value()), null, null, true);
    }

    // ---- Private Vorlagen („Duplizieren") ---------------------------------

    /** Die privaten Vorlagen dieser Anlage. */
    public List<SiteComponentTemplateDto> templates(UUID siteId) {
        requireSite(siteId);
        return templates.forSite(siteId);
    }

    /**
     * Legt eine private Vorlage aus einem bestehenden Gerät an (Captain-Scope 4:
     * NUR je Anlage, privat - kein Katalog, kein Teilen).
     *
     * <p><b>Die Adresse reist NICHT mit.</b> Eine Vorlage beschreibt einen
     * GERÄTETYP, kein Exemplar; würde der Host mitkopiert, zeigte das zweite
     * Gerät auf das erste, und das fiele erst auf, wenn beide dieselben Werte
     * melden.
     */
    @Transactional
    public List<SiteComponentTemplateDto> duplicate(UUID siteId, UUID entityId, String label,
            String subject) {
        requireSite(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        JsonNode def = parse(row.connectionJson());

        ObjectNode connection = mapper.createObjectNode();
        JsonNode transport = def.path("transport");
        // Port und Unit-ID sind Eigenschaften des GERÄTETYPS und bleiben; der
        // Host ist die Adresse dieses einen Exemplars und bleibt leer.
        connection.put("port", transport.path("port").asInt(502));
        connection.put("unit_id", transport.path("unit_id").asInt(1));

        String name = label == null || label.isBlank()
                ? row.label() + " (Vorlage)" : label.trim();
        templates.create(TenantContext.get(), siteId, newTemplateRef(), name,
                SelfBuildDefinition.COMMUNICATION, connection.toString(),
                def.path("channels").toString(), null, subject);
        return templates.forSite(siteId);
    }

    /** Entfernt eine private Vorlage. Geräte, die daraus entstanden, bleiben. */
    @Transactional
    public List<SiteComponentTemplateDto> deleteTemplate(UUID siteId, String templateRef) {
        requireSite(siteId);
        if (templates.delete(siteId, templateRef) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Vorlage nicht gefunden.");
        }
        return templates.forSite(siteId);
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
     * Nur eine Komponente, die WIRKLICH aus der Selbstbau-Tür stammt, wird hier
     * geändert oder gelöscht. Sonst könnte dieser Weg eine plattform-komponierte
     * Zeile (Wechselrichter, Netz-Zähler) unter der Hand in ein Modbus-Gerät
     * verwandeln.
     */
    private EntityRow requireSelfBuilt(UUID siteId, UUID entityId) {
        EntityRow row = entityRepo.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        if (!SelfBuildDefinition.COMMUNICATION.equals(row.communication())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente wurde nicht selbst angelegt und lässt sich hier nicht "
                            + "bearbeiten.");
        }
        return row;
    }

    private Result requireValid(SaveSelfBuildRequest req) {
        Result def = SelfBuildDefinition.validate(transport(req), channels(req));
        if (!def.ok()) {
            // Der erste Satz ist die Überschrift der Ablehnung; die weiteren
            // hängen dran, damit ein Formular seine Mängel in EINER Runde sieht.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    String.join(" ", def.errors()));
        }
        return def;
    }

    private void requireTested(UUID siteId, Transport transport) {
        if (!receipts.has(siteId, RECEIPT_REF, receiptFields(transport))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bitte lesen Sie zuerst einen Messwert dieses Geräts - erst danach lässt es "
                            + "sich speichern.");
        }
    }

    /**
     * Die Felder, über die der Beleg eines Selbstbau-Tests läuft. Nur die
     * VERBINDUNG zählt: ein Test beweist, dass unter dieser Adresse ein Gerät
     * antwortet - er sagt nichts über die Kanäle, und eine geänderte Skalierung
     * darf keinen neuen Test erzwingen.
     */
    public static Map<String, Object> receiptFields(Transport t) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("host", t.host() == null ? "" : t.host().trim());
        m.put("port", t.effectivePort());
        m.put("unit_id", t.effectiveUnitId());
        return m;
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
        String definitionJson = definitionJson(def);
        int version = definitions.applyDefinition(siteId, entityId, label, null, null, null,
                SelfBuildDefinition.COMMUNICATION, definitionJson,
                SelfBuildDefinition.SOURCE_KIND, null, null);
        if (version == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        String text = note == null || note.isBlank() ? defaultNote : note.trim();
        // Die Rolle der Zeile IST ihr Entitätstyp (die Konvention jeder
        // v2-nativen Entität) - die Fassungs-Historie erfindet dafür kein
        // zweites Wort.
        definitions.recordVersion(tenantId, siteId, entityId, version,
                SelfBuildDefinition.ENTITY_TYPE, label, null, null, null,
                SelfBuildDefinition.COMMUNICATION, definitionJson,
                SelfBuildDefinition.SOURCE_KIND, null, null, subject, text);

        deployReadFlow(siteId, tenantId, entityId, version, label, def);
        entityRegistry.pushRegistryBestEffort(siteId);
    }

    /**
     * Kompiliert den Lese-Flow und rollt ihn über die BESTEHENDE Kette aus
     * (flowc → {@code upsertGenerated} → retained {@code v2/flows} → Geräte-Ack).
     *
     * <p>Ein Compiler-Ausfall ist ein 503 und lässt nichts zurück: eine
     * Komponente ohne Leseplan wäre eine Zeile, die ein Gerät verspricht, das
     * nichts liefert.
     */
    private void deployReadFlow(UUID siteId, UUID tenantId, UUID entityId, int version,
            String label, Result def) {
        ObjectNode document = compiler.compile(siteId, tenantId, entityId, version, label,
                def.transport(), def.channels());
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
            log.warn("self-build read flow for {} did not compile: {} ({})", entityId,
                    e.getMessage(), e.reason());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Lese-Plan konnte nicht gebaut werden: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der gebaute Lese-Plan ist ungültig: " + e.getMessage());
        }

        UUID flowId = SelfBuildFlowCompiler.generatedFlowId(entityId);
        flows.upsertGenerated(tenantId, siteId, flowId, version,
                SelfBuildFlowCompiler.flowName(label), "edge", document.toString());
        flows.retireActive(flowId);
        flows.markActive(flowId, version, artifact.toString());
        if (!deployments.republishForSite(siteId)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Der Lese-Plan konnte nicht an Ihre VoltPilot-Box verteilt werden - bitte "
                            + "später erneut versuchen.");
        }
    }

    // ---- Formen -----------------------------------------------------------

    /**
     * Die gespeicherte Definition - sie wohnt in {@code connection_json} und ist
     * die EINE Wahrheit über dieses Gerät (k6 §2.2). Der Registry-Push reicht
     * sie als {@code driver.connection} an die Box weiter; der LESEPLAN reist
     * dagegen im Flow, nicht hier.
     */
    private String definitionJson(Result def) {
        ObjectNode root = mapper.createObjectNode();
        root.put("schema_version", "1.0");
        ObjectNode transport = root.putObject("transport");
        transport.put("host", def.transport().host().trim());
        transport.put("port", def.transport().effectivePort());
        transport.put("unit_id", def.transport().effectiveUnitId());
        ArrayNode channels = root.putArray("channels");
        for (NormalizedChannel c : def.channels()) {
            ObjectNode n = channels.addObject();
            n.put("slug", c.slug());
            n.put("label", c.label());
            n.put("unit", c.unit());
            ObjectNode register = n.putObject("register");
            register.put("kind", c.registerKind());
            register.put("address", c.address());
            register.put("data_type", c.dataType());
            register.put("word_order", c.wordOrder());
            n.put("scale", c.scale());
            n.put("offset", c.offset());
            n.put("min_read_interval_s", c.minReadIntervalS());
        }
        return root.toString();
    }

    /**
     * Die Messkanäle der Komponente, aus den Kanälen der Definition.
     *
     * <p>Das additive {@code label} reist mit: {@code validatedCapabilities}
     * speichert die Einträge VERBATIM, also erreicht der Klartext-Name des
     * Kunden jede Oberfläche - ohne dass irgendwo eine zweite Namenstabelle
     * gepflegt werden müsste.
     */
    private JsonNode capabilities(List<NormalizedChannel> channels) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        for (NormalizedChannel c : channels) {
            ObjectNode m = measure.addObject();
            m.put("channel", c.slug());
            m.put("unit", c.unit());
            m.put("label", c.label());
        }
        return caps;
    }

    /**
     * Ein Selbstbau-Gerät ist in dieser Stufe NUR-LESEND. {@code measure-only}
     * ist auf der Box die Schutz-Semantik „verwirf jedes Kommando" - die
     * Komponente ist also nicht bloß ungesteuert, sondern strukturell
     * unsteuerbar.
     */
    private JsonNode guards() {
        ObjectNode guards = mapper.createObjectNode();
        guards.putObject("limits");
        guards.putObject("failsafe").put("behavior", "measure-only");
        return guards;
    }

    private static String label(SaveSelfBuildRequest req) {
        String l = req.label() == null ? "" : req.label().trim();
        return l.isEmpty() ? "Eigenes Modbus-Gerät" : l;
    }

    private static Transport transport(SaveSelfBuildRequest req) {
        SaveSelfBuildRequest.Connection c = req.connection();
        return c == null ? new Transport(null, null, null)
                : new Transport(c.host(), c.port(), c.unitId());
    }

    private static List<Channel> channels(SaveSelfBuildRequest req) {
        List<Channel> out = new ArrayList<>();
        if (req.channels() == null) {
            return out;
        }
        for (SaveSelfBuildRequest.ChannelRequest c : req.channels()) {
            out.add(new Channel(c.label(), c.unit(), c.registerKind(), c.address(), c.dataType(),
                    c.wordOrder(), c.scale(), c.offset(), c.minReadIntervalS()));
        }
        return out;
    }

    private static String newTemplateRef() {
        return "custom:" + UUID.randomUUID();
    }

    private JsonNode parse(String json) {
        try {
            return json == null || json.isBlank() ? mapper.createObjectNode()
                    : mapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("stored definition unreadable", e);
        }
    }
}
