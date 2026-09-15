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
import com.voltpilot.api.consumers.ConsumerAuditRepository;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.uems.BerichtsBelege;
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

    /** Die Anfrage eines Schalt-Tests bzw. seines Abbruchs. */
    public record SwitchTestRequest(SwitchDefinition.Switch switchDef, Double testValue) {
    }

    /**
     * Das Ergebnis eines Schalt-Tests. {@code passed} ist bewusst SCHMAL: es
     * heisst „der Schreibvorgang ist belegt", nie „das Geraet hat getan, was es
     * soll" - das kann nur der Mensch davor bestaetigen.
     */
    public record SwitchTestResult(boolean passed, int ttlSeconds, String errorCode,
            String message, ProbeResult.Switched switched) {
    }

    /** Die Freigabe: die Definition, die Verbraucher-Eckdaten, die Bestaetigung. */
    public record SwitchReleaseRequest(SwitchDefinition.Switch switchDef,
            SwitchDefinition.Consumer consumer, Boolean physicallyConfirmed) {
    }

    private final Geltungsbereich geltungsbereich;
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
    private final ConsumerAuditRepository audit;
    private final ObjectMapper mapper;
    private final BerichtsBelege berichtsBelege;

    public SelfBuildComponentService(Geltungsbereich geltungsbereich, EntityRegistryRepository entityRepo,
            EntityRegistryService entityRegistry, ComponentDefinitionRepository definitions,
            ComponentService components, ComponentConnectionReceipts receipts,
            SiteComponentTemplateRepository templates, SelfBuildFlowCompiler compiler,
            FlowRepository flows, FlowActivationService deployments,
            ObjectProvider<FlowCompiler> flowc, ProbeService probes,
            ConsumerAuditRepository audit, ObjectMapper mapper, BerichtsBelege berichtsBelege) {
        this.geltungsbereich = geltungsbereich;
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
        this.audit = audit;
        this.mapper = mapper;
        this.berichtsBelege = berichtsBelege;
    }

    // ---- Anlegen / Ändern -------------------------------------------------

    /** Legt ein selbst definiertes Modbus-Gerät an. */
    @Transactional
    public SiteComponentsDto create(UUID siteId, SaveSelfBuildRequest req, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        requireGateway(siteId);
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
        requireGateway(siteId);
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
        // UEMS AP-12 E13 S2: ein Beleg freigegebener Berichtsstände → 409, bevor irgendetwas geschrieben wird.
        berichtsBelege.pruefeKomponente(siteId, row.id());

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

    /**
     * Benennt eine private Vorlage um (Einheitsmodell Stufe 6).
     *
     * <p>Der erste Name entsteht beim Duplizieren automatisch („… (Vorlage)");
     * ohne diesen Weg müsste ein Kunde die Vorlage löschen und neu anlegen, um
     * sie „Wärmepumpe Keller" zu nennen - und verlöre dabei nichts als den
     * Namen, was den Umweg besonders sinnlos macht.
     *
     * <p>Ein leerer Name wird abgelehnt: eine namenlose Vorlage wäre in der
     * Auswahl nicht unterscheidbar. Eine leere Notiz LÖSCHT die Notiz.
     */
    @Transactional
    public List<SiteComponentTemplateDto> renameTemplate(UUID siteId, String templateRef,
            String label, String note) {
        requireSite(siteId);
        String name = label == null ? "" : label.trim();
        if (name.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Bitte geben Sie der Vorlage einen Namen.");
        }
        String text = note == null || note.isBlank() ? null : note.trim();
        if (templates.rename(siteId, templateRef, name, text) == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Vorlage nicht gefunden.");
        }
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
        geltungsbereich.requireSite(siteId);
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

    /**
     * Ohne verbundenes Gerät gibt es keine Box, die lesen könnte - und damit
     * nichts, wohin der Leseplan ausgerollt werden kann.
     *
     * <p>⚠ Die Prüfung steht VORNE, obwohl der Rollout am Ende ohnehin
     * scheitern würde: dort wäre sie ein 503 „konnte nicht verteilt werden",
     * also eine Aussage über eine Störung, wo in Wahrheit eine Voraussetzung
     * fehlt. Der Satz ist wörtlich der des Probe-Kanals, damit dieselbe Lücke
     * überall gleich heißt.
     */
    private void requireGateway(UUID siteId) {
        if (entityRepo.siteDeviceIds(siteId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat noch kein verbundenes Gerät, das lesen könnte.");
        }
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

    // ---- Steuern freigeben (Einheitsmodell Stufe 4) -----------------------

    /**
     * Der geführte Schalt-Test: schreibt EINMAL den freigegebenen Wert und
     * lässt die Box das automatische Aus armieren.
     *
     * <p>Er speichert NICHTS ausser dem Beleg - was getestet wurde, ist erst
     * mit der Bestätigung des Kunden eine Freigabe. Der Beleg haengt am
     * FINGERABDRUCK der Schalt-Definition (Verbindung + Register + Werte +
     * Art): eine geaenderte Adresse ist ein anderes Geraet, ein geaenderter
     * Ein-Wert eine andere Zusage - beides entwertet den Test, wie eine
     * geaenderte Verbindung den Verbindungstest entwertet.
     */
    @Transactional(readOnly = true)
    public SwitchTestResult switchTest(UUID siteId, UUID entityId, SwitchTestRequest req,
            String subject) {
        requireSite(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        SwitchDefinition.NormalizedSwitch sw = requireValidSwitch(req.switchDef());
        Transport transport = storedTransport(row);
        String valueError = SwitchDefinition.testValueError(sw, req.testValue());
        if (valueError != null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, valueError);
        }
        int raw = SwitchDefinition.testRaw(sw, req.testValue());
        ProbeResult res = probes.switchOp(siteId, null,
                new ProbePublisher.SwitchOp("switch_test", "schalten", transport.host(),
                        transport.effectivePort(), transport.effectiveUnitId(), sw.registerKind(),
                        sw.address(), sw.writeFc(), raw, sw.safeRaw(),
                        SwitchDefinition.TEST_TTL_S, sw.readbackAddress()),
                subject);
        boolean passed = switchPassed(res);
        String evidence = switchEvidence(res, raw);
        if (passed) {
            receipts.record(siteId, SWITCH_RECEIPT_REF,
                    switchReceiptFields(entityId, transport, sw), evidence);
        }
        // Ein Schreibvorgang an einer Kundenanlage bekommt seine Spur, auch
        // wenn er scheitert - eine Freigabe ist nur so glaubwuerdig wie das,
        // was vor ihr nachweisbar passiert ist.
        audit.append(siteId, entityId, "switch_tested", null, null, subject,
                (passed ? "bestanden" : "fehlgeschlagen") + ", " + evidence);
        return new SwitchTestResult(passed, SwitchDefinition.TEST_TTL_S,
                res.errorCode(), res.message(), switchedOf(res));
    }

    /** Bricht den laufenden Test ab und schreibt den Sicherheitswert SOFORT. */
    @Transactional(readOnly = true)
    public SwitchTestResult switchCancel(UUID siteId, UUID entityId, SwitchTestRequest req,
            String subject) {
        requireSite(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        SwitchDefinition.NormalizedSwitch sw = requireValidSwitch(req.switchDef());
        Transport transport = storedTransport(row);
        ProbeResult res = probes.switchOp(siteId, null,
                new ProbePublisher.SwitchOp("switch_cancel", "schalten", transport.host(),
                        transport.effectivePort(), transport.effectiveUnitId(), sw.registerKind(),
                        sw.address(), sw.writeFc(), null, sw.safeRaw(), null,
                        sw.readbackAddress()),
                subject);
        return new SwitchTestResult(false, 0, res.errorCode(), res.message(), switchedOf(res));
    }

    /**
     * Die FREIGABE. Sie braucht beides: einen bestandenen Test auf GENAU dieser
     * Schalt-Definition und die Bestätigung, dass der Kunde die Wirkung am
     * Gerät gesehen hat. Erst danach wird die Komponente ein schaltbares Gerät
     * (Typ, Fähigkeit, Verbraucher-Profil) und der Schalter in ihren Flow
     * kompiliert.
     */
    @Transactional
    public SiteComponentsDto switchRelease(UUID siteId, UUID entityId, SwitchReleaseRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        SwitchDefinition.NormalizedSwitch sw = requireValidSwitch(req.switchDef());
        List<String> consumerErrors = SwitchDefinition.validateConsumer(req.consumer());
        if (!consumerErrors.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    String.join(" ", consumerErrors));
        }
        Transport transport = storedTransport(row);
        Map<String, Object> receiptFields = switchReceiptFields(entityId, transport, sw);
        boolean tested = receipts.has(siteId, SWITCH_RECEIPT_REF, receiptFields);
        // Die Evidenz stammt aus dem BESTANDENEN Test, nicht aus dem Aufruf -
        // ein Nachweis, den der Client behaupten darf, ist keiner.
        String evidence = receipts.evidence(siteId, SWITCH_RECEIPT_REF, receiptFields);
        String refusal = SwitchDefinition.requireRelease(tested,
                Boolean.TRUE.equals(req.physicallyConfirmed()));
        if (refusal != null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, refusal);
        }

        UUID tenantId = TenantContext.get();
        // Der Typ wechselt von „Messgerät" zu „eigenes Schaltgerät": erst damit
        // ist die Entität auf der Box KEIN drop-everything mehr, und erst damit
        // greifen Verbraucher-Klemme und Zyklen-Guard im Arbiter.
        entityRepo.setEntityConfig(entityId, SWITCHABLE_ENTITY_TYPE,
                switchCapabilities(row, sw).toString(), switchGuards(req.consumer()).toString());
        writeSwitch(siteId, tenantId, entityId, row, sw, req.consumer(), subject, evidence,
                "Schalten freigegeben");
        audit.append(siteId, entityId, "switch_released", null, null, subject,
                sw.kind() + " auf Register " + sw.address()
                        + (evidence == null ? "" : " (" + evidence + ")"));
        return components.list(siteId);
    }

    /**
     * Nimmt die Freigabe zurück. Das Gerät ist danach wieder ein Sensor: der
     * Schalt-Knoten verschwindet aus dem Flow, die Fähigkeit aus der Entität,
     * und damit stoppen die Regeln, die auf ihn zeigten.
     *
     * <p>Die Definition BLEIBT gespeichert - eine Rücknahme ist keine
     * Beweisvernichtung, und wer erneut freigeben will, soll nicht alles neu
     * eintippen. Nur der TEST-Beleg fällt, denn er gehörte zu einem Zustand,
     * den es nicht mehr gibt.
     */
    @Transactional
    public SiteComponentsDto switchRevoke(UUID siteId, UUID entityId, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow row = requireSelfBuilt(siteId, entityId);
        UUID tenantId = TenantContext.get();
        entityRepo.setEntityConfig(entityId, SelfBuildDefinition.ENTITY_TYPE,
                capabilities(storedChannels(row)).toString(), guards().toString());
        writeSwitch(siteId, tenantId, entityId, row, null, null, subject, null,
                "Freigabe zurückgenommen");
        audit.append(siteId, entityId, "switch_revoked", null, null, subject, null);
        return components.list(siteId);
    }


    // ---- Helfer der Freigabe ----------------------------------------------

    /** Der Typ, den ein freigegebenes Gerät trägt (entitytypes-Katalog). */
    private static final String SWITCHABLE_ENTITY_TYPE = "modbus-load";

    /**
     * Der Beleg-Schlüssel des SCHALT-Tests. Bewusst ein anderer als der des
     * Lese-Tests: ein gelesener Messwert beweist nichts über einen Schalter,
     * und ein Beleg, der für beides gälte, wäre genau die Verwechslung, die
     * eine Freigabe nicht haben darf.
     */
    public static final String SWITCH_RECEIPT_REF = "custom:switch";

    /**
     * Woran der Beleg hängt: die Verbindung UND die ganze Schalt-Zusage. Eine
     * geänderte Adresse ist ein anderes Gerät, ein geänderter Ein-Wert eine
     * andere Zusage - beides entwertet den Test.
     */
    public static Map<String, Object> switchReceiptFields(UUID entityId, Transport t,
            SwitchDefinition.NormalizedSwitch s) {
        Map<String, Object> m = new LinkedHashMap<>(receiptFields(t));
        m.put("entity", entityId.toString());
        m.put("kind", s.kind());
        m.put("register_kind", s.registerKind());
        m.put("address", s.address());
        m.put("fc", s.writeFc());
        m.put("on", s.onValue());
        m.put("off", s.offValue());
        m.put("min", s.minValue());
        m.put("max", s.maxValue());
        m.put("safe", s.safeValue());
        m.put("scale", s.scale());
        m.put("offset", s.offset());
        return m;
    }

    private SwitchDefinition.NormalizedSwitch requireValidSwitch(SwitchDefinition.Switch raw) {
        SwitchDefinition.Result r = SwitchDefinition.validate(raw);
        if (!r.ok()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, String.join(" ", r.errors()));
        }
        return r.value();
    }

    /**
     * Die Verbindung kommt aus der GESPEICHERTEN Definition, nie aus dem
     * Anfrage-Rumpf: ein Schalt-Test darf nur das Gerät erreichen, das dieser
     * Komponente gehört - sonst wäre die Route ein freier Schreibbefehl an
     * jede LAN-Adresse (Leitplanke 1, „keine Adresse zur Laufzeit").
     */
    private Transport storedTransport(EntityRow row) {
        JsonNode def = parseDefinition(row);
        JsonNode t = def.path("transport");
        String host = t.path("host").asText("");
        if (host.isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für diese Komponente ist keine Verbindung gespeichert.");
        }
        return new Transport(host, t.path("port").asInt(502), t.path("unit_id").asInt(1));
    }

    private List<NormalizedChannel> storedChannels(EntityRow row) {
        List<NormalizedChannel> out = new ArrayList<>();
        for (JsonNode c : parseDefinition(row).path("channels")) {
            JsonNode reg = c.path("register");
            out.add(new NormalizedChannel(c.path("slug").asText(), c.path("label").asText(),
                    c.path("unit").asText(""), reg.path("kind").asText("holding"),
                    reg.path("address").asInt(), reg.path("data_type").asText("u16"),
                    reg.path("word_order").asText("big"), c.path("scale").asDouble(1),
                    c.path("offset").asDouble(0),
                    c.path("min_read_interval_s").asInt(SelfBuildDefinition.DEFAULT_INTERVAL_S)));
        }
        return out;
    }

    private JsonNode parseDefinition(EntityRow row) {
        try {
            String json = row.connectionJson();
            return json == null || json.isBlank() ? mapper.createObjectNode()
                    : mapper.readTree(json);
        } catch (Exception e) {
            return mapper.createObjectNode();
        }
    }

    /** Ein Test gilt nur als bestanden, wenn die Box den Schreibvorgang MELDET. */
    private static boolean switchPassed(ProbeResult res) {
        if (res.errorCode() != null || res.results() == null || res.results().isEmpty()) {
            return false;
        }
        ProbeResult.OpResult line = res.results().get(0);
        // Ein Rücklesen, das WIDERSPRICHT, ist kein bestandener Test - ohne
        // Rücklese-Register gibt es keines, dann trägt die Bestätigung des
        // Kunden allein.
        if (line.switched() != null && Boolean.FALSE.equals(line.switched().readbackMatches())) {
            return false;
        }
        return line.ok() && line.switched() != null;
    }

    /**
     * Die EVIDENZ eines Schalt-Tests, server-seitig aus dem Ergebnis gebildet
     * (Anforderung 3: wer/wann/Evidenz).
     *
     * <p>Sie sagt nur, was das Geraet wirklich geantwortet hat: den
     * geschriebenen Rohwert und - wenn es ein Rueckleseregister gibt - was
     * zurueckkam. Ohne Rueckleseregister wird KEIN Rueckleseergebnis behauptet;
     * dort traegt die Bestaetigung des Kunden allein.
     */
    private static String switchEvidence(ProbeResult res, int raw) {
        ProbeResult.Switched sw = switchedOf(res);
        StringBuilder b = new StringBuilder("Wert ").append(raw);
        if (sw != null && sw.readback() != null) {
            b.append(", zurueckgelesen ").append(sw.readback());
            if (sw.readbackMatches() != null) {
                b.append(Boolean.TRUE.equals(sw.readbackMatches()) ? " (passt)" : " (weicht ab)");
            }
        } else {
            b.append(", ohne Rueckleseregister");
        }
        return b.toString();
    }

    private static ProbeResult.Switched switchedOf(ProbeResult res) {
        if (res.results() == null || res.results().isEmpty()) {
            return null;
        }
        return res.results().get(0).switched();
    }

    /**
     * Die Fähigkeiten eines freigegebenen Geräts: die Messkanäle wie bisher,
     * PLUS genau das eine Kommando der Schalt-Art. Es ist diese Liste, die auf
     * der Box aus einem drop-everything-Sensor einen steuerbaren Verbraucher
     * macht.
     */
    private ObjectNode switchCapabilities(EntityRow row, SwitchDefinition.NormalizedSwitch sw) {
        ObjectNode caps = (ObjectNode) capabilities(storedChannels(row));
        ArrayNode actuate = caps.putArray("actuate");
        ObjectNode a = actuate.addObject();
        if (SwitchDefinition.KIND_SETPOINT.equals(sw.kind())) {
            a.put("command", "setpoint_kw");
            a.put("min", sw.minValue());
            a.put("max", sw.maxValue());
        } else {
            a.put("command", "on_off");
        }
        return caps;
    }

    /**
     * Klemme + Zyklen-Zeiten (Leitplanke 4). Sie stehen in
     * {@code guards.limits} und damit in DEM Block, den der Registry-Push
     * ohnehin trägt und aus dem der Arbiter seine Verbraucher-Klemme und den
     * {@code guards.CycleGuard} baut - der Baukasten fügt dem Steuerungsmodell
     * keine neue Semantik hinzu, er füllt die vorhandene.
     */
    private ObjectNode switchGuards(SwitchDefinition.Consumer c) {
        ObjectNode g = mapper.createObjectNode();
        ObjectNode limits = g.putObject("limits");
        limits.put("max_consumption_kw", c.ratedPowerKw());
        if (c.minOnSeconds() != null) {
            limits.put("min_on_seconds", c.minOnSeconds());
        }
        if (c.minOffSeconds() != null) {
            limits.put("min_off_seconds", c.minOffSeconds());
        }
        if (c.maxStartsPerDay() != null) {
            limits.put("max_starts_per_day", c.maxStartsPerDay());
        }
        // Ohne frischen Befehl faellt das Geraet aus - die Shelly-Regel: ein
        // Relais hat keine eigene Logik, in die es sich entlassen liesse.
        g.putObject("failsafe").put("behavior", "off");
        return g;
    }

    /**
     * Schreibt die Definition MIT (oder ohne) Schalter als neue Fassung und
     * rollt den Flow neu aus. Dieselbe Maschinerie wie jedes andere Speichern -
     * eine Freigabe ist eine Definitions-Aenderung, keine Sonderoperation.
     */
    private void writeSwitch(UUID siteId, UUID tenantId, UUID entityId, EntityRow row,
            SwitchDefinition.NormalizedSwitch sw, SwitchDefinition.Consumer consumer,
            String subject, String evidence, String note) {
        Transport transport = storedTransport(row);
        List<NormalizedChannel> channels = storedChannels(row);
        String label = row.label() == null ? "Eigenes Gerät" : row.label();
        String definitionJson = definitionJson(new Result(List.of(), transport, channels), sw,
                consumer, subject, evidence);
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, label, null, null, null, SelfBuildDefinition.COMMUNICATION,
                definitionJson, SelfBuildDefinition.SOURCE_KIND, null, null);
        if (applied == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        int version = applied.version();
        definitions.recordStoredVersion(tenantId, siteId, entityId, version, subject, note);
        deployFlow(siteId, tenantId, entityId, version, label, transport, channels, sw);
        entityRegistry.pushRegistryBestEffort(siteId);
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
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, label, null, null, null, SelfBuildDefinition.COMMUNICATION,
                definitionJson, SelfBuildDefinition.SOURCE_KIND, null, null);
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
     * (flowc → {@code upsertGenerated} → retained {@code v2/flows} → Geräte-Ack).
     *
     * <p>Ein Compiler-Ausfall ist ein 503 und lässt nichts zurück: eine
     * Komponente ohne Leseplan wäre eine Zeile, die ein Gerät verspricht, das
     * nichts liefert. Der Compiler wird deshalb VOR dem ersten Schreibvorgang
     * gefragt.
     *
     * <p><b>⚠ Das VERTEILEN ist dagegen best-effort</b> - wie der
     * Registry-Push eine Zeile weiter. Zwei Gründe: {@code republishForSite}
     * meldet {@code false} auch dann, wenn gar kein Broker konfiguriert ist
     * (die Vorgabe ohne {@code voltpilot.provisioning.*}), das wäre also ein
     * Fehler über eine Umgebung statt über diese Anfrage; und an dieser Stelle
     * sind Definition, Fassung und aktiver Flow bereits geschrieben - ein
     * Wurf danach BEHAUPTET ein Scheitern über eine Komponente, die es gibt,
     * und der nächste Versuch liefe in einen 409. Der ehrliche Ort dafür ist
     * das dreiwertige Soll/Ist: {@code unreported} heißt „die Box hat sich
     * noch nicht geäußert", NIE „die Änderung ist verloren".
     */
    private void deployReadFlow(UUID siteId, UUID tenantId, UUID entityId, int version,
            String label, Result def) {
        deployFlow(siteId, tenantId, entityId, version, label, def.transport(), def.channels(),
                null);
    }

    private void deployFlow(UUID siteId, UUID tenantId, UUID entityId, int version, String label,
            Transport transport, List<NormalizedChannel> channels,
            SwitchDefinition.NormalizedSwitch released) {
        ObjectNode document = compiler.compile(siteId, tenantId, entityId, version, label,
                transport, channels, released);
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
            log.warn("self-build read flow for {} stored but not distributed to site {} - the "
                    + "component reads as 'unreported' until the next publish", entityId, siteId);
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
        return definitionJson(def, null, null, null, null);
    }

    /**
     * Die gespeicherte Definition, seit Stufe 4 optional MIT Schalter. Der
     * Freigabe-Block {@code switch.freigabe} traegt wer/wann/Evidenz - er IST
     * der Nachweis, und weil er in der Definition wohnt, traegt ihn die
     * Fassungs-Historie ohne Zutun mit: „was war am 3. freigegeben" ist eine
     * Frage an die Fassung.
     */
    private String definitionJson(Result def, SwitchDefinition.NormalizedSwitch sw,
            SwitchDefinition.Consumer consumer, String subject, String evidence) {
        ObjectNode root = (ObjectNode) parseJson(definitionJsonRaw(def));
        if (sw != null) {
            ObjectNode n = root.putObject("switch");
            n.put("kind", sw.kind());
            n.put("register_kind", sw.registerKind());
            n.put("address", sw.address());
            n.put("write_fc", sw.writeFc());
            if (SwitchDefinition.KIND_ON_OFF.equals(sw.kind())) {
                n.put("on_value", sw.onValue());
                n.put("off_value", sw.offValue());
            } else {
                n.put("min_value", sw.minValue());
                n.put("max_value", sw.maxValue());
                n.put("safe_value", sw.safeValue());
                n.put("scale", sw.scale());
                n.put("offset", sw.offset());
                n.put("unit", sw.unit());
            }
            if (sw.readbackAddress() != null) {
                n.put("readback_address", sw.readbackAddress());
            }
            if (sw.watchdogAddress() != null) {
                n.put("watchdog_address", sw.watchdogAddress());
                n.put("watchdog_value", sw.watchdogValue());
            }
            if (consumer != null) {
                ObjectNode c = n.putObject("consumer");
                c.put("rated_power_kw", consumer.ratedPowerKw());
                if (consumer.minOnSeconds() != null) {
                    c.put("min_on_seconds", consumer.minOnSeconds());
                }
                if (consumer.minOffSeconds() != null) {
                    c.put("min_off_seconds", consumer.minOffSeconds());
                }
                if (consumer.maxStartsPerDay() != null) {
                    c.put("max_starts_per_day", consumer.maxStartsPerDay());
                }
                if (consumer.powerChannel() != null && !consumer.powerChannel().isBlank()) {
                    c.put("power_channel", consumer.powerChannel().trim());
                }
            }
            ObjectNode f = n.putObject("freigabe");
            f.put("released_at", java.time.Instant.now().toString());
            f.put("released_by", subject == null ? "" : subject);
            // Die EVIDENZ des bestandenen Tests (Anforderung 3). Sie wird nur
            // gesetzt, wenn es sie gibt - ein leeres Feld waere die Behauptung
            // eines Nachweises, den niemand gefuehrt hat.
            if (evidence != null && !evidence.isBlank()) {
                f.put("evidence", evidence);
            }
        }
        return root.toString();
    }

    private JsonNode parseJson(String json) {
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return mapper.createObjectNode();
        }
    }

    private String definitionJsonRaw(Result def) {
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
