package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.HeizstabPush;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.RegelnImKern;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.repo.SteuerwegRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.web.dto.SiteDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Zusammenführen (Steuerlogik Stufe 6, zweiter Teil; Vertrag {@code docs/contracts/v2/steuerlogik.md}, Abschnitt
 * „Zusammenführen“): eine Regel des Regel-Baukastens läuft als Logik des Kerns - ihre Übersetzung ist eine abgeleitete
 * Logik ({@code steuerlogik.herkunft = 'regel'}), die Regel bleibt, was der Kunde bearbeitet.
 *
 * <ul>
 *   <li>Edge Light: es gibt keinen alten Weg. Eine Regel läuft, sobald sie eingeschaltet wird, als scharfe
 *       Übersetzung; was sich nicht übersetzen lässt, hält die Aktivierung mit Grund an (vorher: jede Regel).</li>
 *   <li>Docker-Box: der Steuerweg der Anlage, ab Werk {@code alt}. {@code mitlauf}: die Übersetzungen laufen auf der
 *       Box mit, Node-RED schaltet weiter, der Herzschlag vergleicht beide. {@code kern}: nach einem ausdrücklichen
 *       Schritt schalten die Übersetzungen, ihr Node-RED-Artefakt bleibt aus dem Satz. Zurück auf {@code alt} wirkt
 *       in derselben Anfrage. Eine Regel, die sich nicht übersetzen lässt, bleibt auf dem alten Weg.</li>
 * </ul>
 * Der Besitz der Geräte bleibt bei der Regel ({@code flow_claim}); die Übersetzung beansprucht nichts selbst.
 */
@Service
public class SteuerwegService implements RegelnImKern {

    private static final Logger log = LoggerFactory.getLogger(SteuerwegService.class);

    /** Wie viele Schritte am Schalter der Stand zeigt. */
    static final int SCHRITTE = 20;

    private final SteuerlogikRepository logiken;
    private final SteuerwegRepository wege;
    private final FlowRepository flows;
    private final SiteRepository sites;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten faehigkeiten;
    private final UpdateStatusRepository updateStatus;
    private final SteuerlogikDienst dienst;
    private final EntityRegistryService registry;
    private final HeizstabPush heizstab;
    private final ObjectProvider<FlowActivationService> auslieferung;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public SteuerwegService(SteuerlogikRepository logiken, SteuerwegRepository wege, FlowRepository flows,
            SiteRepository sites, LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten,
            UpdateStatusRepository updateStatus, SteuerlogikDienst dienst, EntityRegistryService registry,
            HeizstabPush heizstab, ObjectProvider<FlowActivationService> auslieferung, TransactionTemplate tx,
            ObjectMapper json) {
        this(logiken, wege, flows, sites, leadDevices, faehigkeiten, updateStatus, dienst, registry, heizstab,
                auslieferung, tx, json, Clock.systemUTC());
    }

    SteuerwegService(SteuerlogikRepository logiken, SteuerwegRepository wege, FlowRepository flows,
            SiteRepository sites, LeadDeviceService leadDevices, BoxFaehigkeiten faehigkeiten,
            UpdateStatusRepository updateStatus, SteuerlogikDienst dienst, EntityRegistryService registry,
            HeizstabPush heizstab, ObjectProvider<FlowActivationService> auslieferung, TransactionTemplate tx,
            ObjectMapper json, Clock clock) {
        this.logiken = logiken;
        this.wege = wege;
        this.flows = flows;
        this.sites = sites;
        this.leadDevices = leadDevices;
        this.faehigkeiten = faehigkeiten;
        this.updateStatus = updateStatus;
        this.dienst = dienst;
        this.registry = registry;
        this.heizstab = heizstab;
        this.auslieferung = auslieferung;
        this.tx = tx;
        this.json = json;
        this.clock = clock;
    }

    /** Die abgeleitete Logik einer Regel hat eine feste Kennung: eine Regel, eine Übersetzung mit Fassungen. */
    public static UUID logikIdFuer(UUID flowId) {
        return UUID.nameUUIDFromBytes(("steuerlogik-regel:" + flowId).getBytes(StandardCharsets.UTF_8));
    }

    // --- Was eine Aktivierung vorbereitet ------------------------------------------------------------------------

    /**
     * Die Vorbereitung einer Regel: {@code logik == null} heißt, sie läuft (nur) auf dem alten Weg, und eine
     * Übersetzung aus einer früheren Fassung hört auf.
     */
    record Plan(UUID flowId, int flowFassung, UUID logikId, int fassung, String name, String text,
            SteuerlogikDienst.Artefakt logik, String zustand, Halt halt, List<String> gruende)
            implements Vorbereitet {

        static Plan alterWeg(UUID flowId, List<String> gruende) {
            return new Plan(flowId, 0, null, 0, null, null, null, null, null, gruende);
        }

        static Plan angehalten(UUID flowId, Halt halt) {
            return new Plan(flowId, 0, null, 0, null, null, null, null, halt, List.of());
        }
    }

    @Override
    public Vorbereitet bereite(UUID siteId, FlowVersionRow version, JsonNode document, UUID gateway,
            boolean edgeLight) {
        String modus = wege.weg(siteId).modus();
        if (!edgeLight && SteuerwegRepository.ALT.equals(modus)) return Plan.alterWeg(version.flowId(), List.of());
        String zustand = edgeLight || SteuerwegRepository.KERN.equals(modus) ? SteuerlogikRepository.ZUSTAND_SCHARF
                : SteuerlogikRepository.ZUSTAND_MITLAUFEND;
        Plan p = plane(siteId, version, document, gateway, zustand);
        if (p.logik() != null) return p;
        if (!edgeLight) {
            // Auf der Docker-Box hält nichts die Regel an: sie bleibt auf dem alten Weg, der sie heute schon schaltet.
            return p.halt() == null ? p : Plan.alterWeg(version.flowId(), List.of(p.halt().message()));
        }
        return Plan.angehalten(version.flowId(), new Halt(p.halt() != null ? p.halt().reason() : "edge_light_unsupported",
                p.halt() != null ? p.halt().message()
                        : "Auf dieser Edge Light läuft eine Regel nur über den Kern der Box, und diese Regel lässt "
                                + "sich nicht dorthin übersetzen: " + String.join(" ", p.gruende())
                                + " Die Regel bleibt gespeichert, aber nicht ausgerollt."));
    }

    /**
     * Übersetzt eine Regel und lässt ihr Artefakt bauen; was dem entgegensteht, steht in {@code gruende} (alter Weg)
     * oder - wo die Box nicht kann oder der Dienst fehlt - in {@code halt}.
     */
    private Plan plane(UUID siteId, FlowVersionRow version, JsonNode document, UUID gateway, String zustand) {
        UUID flowId = version.flowId();
        if (document == null || document.has("origin")) return Plan.alterWeg(flowId, List.of());
        boolean scharf = SteuerlogikRepository.ZUSTAND_SCHARF.equals(zustand);
        if (!faehigkeiten.kann(gateway, SteuerlogikAuslieferung.FAEHIGKEIT)
                || !faehigkeiten.kann(gateway, SteuerlogikAuslieferung.FAEHIGKEIT_REGELN)
                || (scharf && !faehigkeiten.kann(gateway, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF))) {
            return Plan.angehalten(flowId, new Halt("box_ohne_regeln", "Die Box dieser Anlage kann Regeln noch nicht "
                    + "über ihren Kern ausführen (Fähigkeit steuerlogik_regeln fehlt). Bitte erst die Box "
                    + "aktualisieren."));
        }
        SiteDto site = sites.findById(siteId);
        String ansicht = registry.registryAnsicht(siteId, gateway);
        JsonNode antwort;
        try {
            antwort = dienst.ausRegel(document, version.name(), version.flowVersion(), ansicht);
        } catch (SteuerlogikDienstException e) {
            if (SteuerlogikDienstException.KEINE_REGEL.equals(e.grund())) {
                return Plan.alterWeg(flowId, List.of("Die Regel ist im freien Editor gebaut; übersetzen lassen "
                        + "sich nur Regeln des Regel-Baukastens."));
            }
            return Plan.angehalten(flowId, new Halt(e.grund(), e.getMessage()));
        }
        if (!antwort.path("uebersetzt").asBoolean()) {
            List<String> gruende = new ArrayList<>();
            for (JsonNode g : antwort.path("gruende")) gruende.add(g.path("text").asText());
            return Plan.alterWeg(flowId, gruende);
        }
        String text = antwort.path("text").asText();
        String konflikt = konflikt(siteId, gateway, antwort.path("bericht"));
        if (konflikt != null) return Plan.alterWeg(flowId, List.of(konflikt));
        UUID logikId = logikIdFuer(flowId);
        int fassung = logiken.naechsteFassung(logikId);
        SteuerlogikDienst.Artefakt artefakt;
        try {
            artefakt = dienst.artefakt(new SteuerlogikDienst.Auftrag(text, logikId, fassung, clock.instant(),
                    new SteuerlogikDienst.Ort(SteuerlogikService.ZONE.getId(), site == null ? null : site.latitude(),
                            site == null ? null : site.longitude()), ansicht, scharf, null, false));
        } catch (SteuerlogikDienstException e) {
            if (SteuerlogikDienstException.NICHT_ERREICHBAR.equals(e.grund())) {
                return Plan.angehalten(flowId, new Halt(e.grund(), e.getMessage()));
            }
            return Plan.alterWeg(flowId, List.of(e.getMessage()));
        }
        String name = artefakt.bericht().path("name").asText(version.name());
        return new Plan(flowId, version.flowVersion(), logikId, fassung, name, text, artefakt, zustand, null,
                List.of());
    }

    /**
     * Was die Box der Übersetzung nicht gäbe, obwohl der alte Weg das Gerät schaltet: einen Heizstab, den ihr
     * Heizstab-Regler führt, gibt sie keiner Logik (zweiter Herr). Dann bleibt die Regel, wo sie ist.
     */
    private String konflikt(UUID siteId, UUID gateway, JsonNode bericht) {
        Map<UUID, ?> staebe = heizstab.fuerBox(siteId, gateway);
        for (JsonNode g : bericht.path("geraete")) {
            try {
                if (staebe.containsKey(UUID.fromString(g.path("entity_id").asText()))) {
                    return "„" + g.path("name").asText("Das Gerät") + "“ führt der Heizstab-Regler der Box; einen "
                            + "zweiten Herrn bekommt es von ihr nicht.";
                }
            } catch (IllegalArgumentException e) {
                // keine Kennung eines Geräts: die Prüfung des Dienstes hätte es gemeldet
            }
        }
        return null;
    }

    @Override
    public void schreibe(UUID siteId, Vorbereitet vorbereitet) {
        Plan p = (Plan) vorbereitet;
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        if (p.logik() == null) {
            stillegen(tenant, siteId, p.flowId(), jetzt, null, null);
            return;
        }
        SteuerlogikDienst.Artefakt a = p.logik();
        String kanonisch = a.artefakt().path("bundle").path("logic").asText();
        String hash = a.artefakt().path("content_hash").asText();
        logiken.legeRegelAn(tenant, siteId, p.logikId(), p.fassung(), p.name(), p.text(), kanonisch,
                a.artefakt().toString(), hash, a.bericht().toString(), p.zustand(), p.flowId(), p.flowFassung(), null,
                null, jetzt);
        ObjectNode daten = json.createObjectNode().put("regel", p.flowId().toString())
                .put("regel_fassung", p.flowFassung());
        logiken.protokolliere(tenant, siteId, p.logikId(), p.fassung(), "angenommen", null, null, daten.toString(),
                jetzt);
        if (SteuerlogikRepository.ZUSTAND_SCHARF.equals(p.zustand())) {
            logiken.protokolliere(tenant, siteId, p.logikId(), p.fassung(), "scharf", null, null, daten.toString(),
                    jetzt);
        }
    }

    @Override
    public void stillgelegt(UUID siteId, UUID flowId) {
        stillegen(TenantContext.get(), siteId, flowId, clock.instant(), null, null);
    }

    private void stillegen(UUID tenant, UUID siteId, UUID flowId, Instant jetzt, String von, String rolle) {
        UUID logikId = logikIdFuer(flowId);
        SteuerlogikRepository.Fassung aktiv = logiken.aktiveFassung(logikId);
        if (aktiv == null) return;
        logiken.stillegen(logikId, jetzt);
        logiken.protokolliere(tenant, siteId, logikId, aktiv.fassung(), "stillgelegt", von, rolle,
                json.createObjectNode().put("regel", flowId.toString()).toString(), jetzt);
    }

    @Override
    public Set<UUID> ersetzt(UUID siteId, UUID gateway) {
        if (gateway == null || !faehigkeiten.kann(gateway, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF)
                || !faehigkeiten.kann(gateway, SteuerlogikAuslieferung.FAEHIGKEIT_REGELN)) {
            // Ginge die Übersetzung nicht an die Box, bliebe die Regel sonst ohne jeden Weg.
            return Set.of();
        }
        Set<UUID> out = new HashSet<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveRegeln(siteId)) {
            if (f.scharf()) out.add(f.herkunftFlowId());
        }
        return out;
    }

    // --- Der Schalter der Anlage ---------------------------------------------------------------------------------

    /** Ein Halt am Schalter: Grund als Code, deutscher Satz (409 am Controller). */
    public static final class Abgelehnt extends RuntimeException {

        private final String grund;

        public Abgelehnt(String grund, String message) {
            super(message);
            this.grund = grund;
        }

        public String grund() {
            return grund;
        }
    }

    /** Schaltet den neuen Weg ein: die Regeln laufen im Kern mit, Node-RED schaltet weiter. */
    public Stand mitlaufen(UUID siteId, String von, String rolle) {
        UUID box = dockerBox(siteId);
        if (!SteuerwegRepository.ALT.equals(wege.weg(siteId).modus())) {
            throw new Abgelehnt("schon_an", "Der neue Weg ist an dieser Anlage schon eingeschaltet.");
        }
        stelle(siteId, box, SteuerwegRepository.MITLAUF, "mitlauf", SteuerlogikRepository.ZUSTAND_MITLAUFEND, von,
                rolle);
        return stand(siteId);
    }

    /** Der ausdrückliche Schritt: die Übersetzungen schalten, Node-RED gibt diese Regeln ab. */
    public Stand uebernehmen(UUID siteId, String von, String rolle) {
        UUID box = dockerBox(siteId);
        String modus = wege.weg(siteId).modus();
        if (SteuerwegRepository.ALT.equals(modus)) {
            throw new Abgelehnt("erst_mitlaufen", "Bitte den neuen Weg zuerst mitlaufen lassen und den Vergleich "
                    + "ansehen; erst dann übernimmt er.");
        }
        if (SteuerwegRepository.KERN.equals(modus)) {
            throw new Abgelehnt("schon_uebernommen", "Der neue Weg hat an dieser Anlage schon übernommen.");
        }
        if (!faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF)) {
            throw new Abgelehnt("box_ohne_scharf", "Die Box dieser Anlage kann noch nicht nach einer Logik schalten "
                    + "(Fähigkeit steuerlogik_scharf fehlt). Bitte erst die Box aktualisieren.");
        }
        stelle(siteId, box, SteuerwegRepository.KERN, "kern", SteuerlogikRepository.ZUSTAND_SCHARF, von, rolle);
        return stand(siteId);
    }

    /** Zurück auf den alten Weg, sofort: die Übersetzungen hören auf, Node-RED schaltet wieder alle Regeln. */
    public Stand zurueck(UUID siteId, String von, String rolle) {
        UUID box = dockerBox(siteId);
        if (SteuerwegRepository.ALT.equals(wege.weg(siteId).modus())) {
            throw new Abgelehnt("schon_alt", "An dieser Anlage gilt schon der alte Weg.");
        }
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            ArrayNode regeln = json.createArrayNode();
            for (SteuerlogikRepository.Fassung f : logiken.aktiveRegeln(siteId)) {
                stillegen(tenant, siteId, f.herkunftFlowId(), jetzt, von, rolle);
                regeln.add(f.herkunftFlowId().toString());
            }
            ObjectNode daten = json.createObjectNode();
            daten.set("regeln", regeln);
            wege.stelle(tenant, siteId, SteuerwegRepository.ALT, "zurueck", von, rolle, daten.toString(), jetzt);
        });
        veroeffentliche(siteId, box);
        return stand(siteId);
    }

    /**
     * Stellt den Schalter: übersetzt jede eingeschaltete Regel der Anlage (außerhalb der Transaktion, der Dienst ist
     * ein Netzaufruf), schreibt Schalter, Schritt und Übersetzungen zusammen und liefert den Satz aus.
     */
    private void stelle(UUID siteId, UUID box, String modus, String was, String zustand, String von, String rolle) {
        List<Plan> plaene = new ArrayList<>();
        ArrayNode regeln = json.createArrayNode();
        for (FlowVersionRow r : aktiveRegeln(siteId)) {
            JsonNode doc = lies(r.documentJson());
            Plan p = plane(siteId, r, doc, box, zustand);
            if (p.halt() != null && SteuerlogikDienstException.NICHT_ERREICHBAR.equals(p.halt().reason())) {
                throw new Abgelehnt(p.halt().reason(), p.halt().message());
            }
            plaene.add(p);
            ObjectNode eintrag = regeln.addObject().put("regel", r.flowId().toString()).put("name", r.name())
                    .put("uebersetzt", p.logik() != null);
            if (p.logik() == null) {
                eintrag.put("grund", String.join(" ", p.gruende().isEmpty() && p.halt() != null
                        ? List.of(p.halt().message()) : p.gruende()));
            }
        }
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            ObjectNode daten = json.createObjectNode();
            daten.set("regeln", regeln);
            wege.stelle(tenant, siteId, modus, was, von, rolle, daten.toString(), jetzt);
            for (Plan p : plaene) schreibe(siteId, p);
        });
        veroeffentliche(siteId, box);
    }

    /** Liefert den vollständigen Satz an die Box; ohne Broker bleibt es beim gespeicherten Stand (wie überall). */
    private void veroeffentliche(UUID siteId, UUID box) {
        FlowActivationService a = auslieferung.getIfAvailable();
        if (a != null && !a.republishForSite(siteId)) {
            log.warn("steuerweg: Satz der Anlage {} (Box {}) nicht veröffentlicht", siteId, box);
        }
    }

    /** Die Docker-Box der Anlage; auf Edge Light gibt es keinen alten Weg für Regeln und also keinen Schalter. */
    private UUID dockerBox(UUID siteId) {
        if (sites.findById(siteId) == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.");
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        if (box == null) {
            throw new Abgelehnt("keine_box", "Die Anlage hat keine eindeutige führende Box.");
        }
        if (BoxArt.LIGHT.equals(updateStatus.boxArt(box))) {
            throw new Abgelehnt("edge_light", "Auf einer Edge Light laufen Regeln immer über den Kern der Box; einen "
                    + "alten Weg gibt es dort nicht.");
        }
        if (!faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT)
                || !faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_REGELN)) {
            throw new Abgelehnt("box_ohne_regeln", "Die Box dieser Anlage kann Regeln noch nicht über ihren Kern "
                    + "ausführen (Fähigkeit steuerlogik_regeln fehlt). Bitte erst die Box aktualisieren.");
        }
        return box;
    }

    /** Die eingeschalteten Regeln der Anlage (ohne die erzeugten Flows der Steuerarten). */
    private List<FlowVersionRow> aktiveRegeln(UUID siteId) {
        List<FlowVersionRow> out = new ArrayList<>();
        for (FlowVersionRow r : flows.activeVersionsForSiteExcept(siteId, "edge", null)) {
            JsonNode doc = lies(r.documentJson());
            if (doc != null && !doc.has("origin")) out.add(r);
        }
        return out;
    }

    // --- Der Stand für Portal und Plattform ----------------------------------------------------------------------

    /**
     * Eine eingeschaltete Regel: wo sie läuft ({@code alt}: Node-RED; {@code mitlauf}: Node-RED schaltet, der Kern
     * läuft mit; {@code kern}: der Kern schaltet; {@code aus}: auf dieser Box läuft sie nicht), warum nicht im Kern,
     * und der Vergleich der Box ({@code vergleich}: Wunsch, Ist, Sekunden verglichen und abweichend, Lage).
     */
    public record RegelWeg(UUID flowId, String name, String weg, List<String> gruende, UUID logikId,
            Integer logikFassung, JsonNode vergleich, Instant gemeldetAm) {}

    /** Ein Schritt am Schalter, wie Menschen ihn lesen: was, wann, wer (Anzeigename), Rolle und die Regeln dabei. */
    public record Schritt(String was, Instant am, String wer, String rolle, JsonNode daten) {}

    /** Der Schalter der Anlage mit ihren Regeln. */
    public record Stand(String modus, Instant seit, String boxArt, boolean boxKannMitlauf, boolean boxKannScharf,
            List<RegelWeg> regeln, List<Schritt> schritte) {}

    public Stand stand(UUID siteId) {
        if (sites.findById(siteId) == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.");
        SteuerwegRepository.Weg weg = wege.weg(siteId);
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        boolean light = box != null && BoxArt.LIGHT.equals(updateStatus.boxArt(box));
        boolean regelnKann = box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT)
                && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_REGELN);
        boolean scharfKann = regelnKann && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        Set<UUID> ersetzt = ersetzt(siteId, box);
        Map<UUID, SteuerlogikRepository.Fassung> uebersetzt = new java.util.HashMap<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveRegeln(siteId)) uebersetzt.put(f.herkunftFlowId(), f);
        List<SteuerlogikRepository.Lauf> laeufe = logiken.laeufe(siteId);
        List<RegelWeg> regeln = new ArrayList<>();
        for (FlowVersionRow r : aktiveRegeln(siteId)) {
            SteuerlogikRepository.Fassung f = uebersetzt.get(r.flowId());
            String w;
            if (light) {
                w = f != null && f.scharf() ? "kern" : "aus";
            } else if (f == null) {
                w = "alt";
            } else {
                w = ersetzt.contains(r.flowId()) ? "kern" : "mitlauf";
            }
            List<String> gruende = List.of();
            if (f == null && box != null && (light || !SteuerwegRepository.ALT.equals(weg.modus()))) {
                gruende = gruende(siteId, r, box);
            }
            SteuerlogikRepository.Lauf lauf = f == null ? null : laeufe.stream()
                    .filter(l -> l.logikId().equals(f.logikId())).findFirst().orElse(null);
            regeln.add(new RegelWeg(r.flowId(), r.name(), w, gruende, f == null ? null : f.logikId(),
                    f == null ? null : f.fassung(), lauf == null ? null : vergleich(lauf),
                    lauf == null ? null : lauf.gemeldetAm()));
        }
        return new Stand(light ? "kern" : weg.modus(), weg.seit(), light ? BoxArt.LIGHT : box == null ? null
                : BoxArt.DOCKER, regelnKann, scharfKann, regeln, wege.schritte(siteId, SCHRITTE).stream()
                .map(x -> new Schritt(x.was(), x.am(), x.vonName(), x.rolle(), lies(x.datenJson()))).toList());
    }

    /** Warum eine Regel nicht im Kern läuft (fragt den Dienst; ohne ihn ein ehrlicher Satz). */
    private List<String> gruende(UUID siteId, FlowVersionRow r, UUID box) {
        if (!faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_REGELN)) {
            return List.of("Die Box kann Regeln noch nicht über ihren Kern ausführen (Fähigkeit steuerlogik_regeln "
                    + "fehlt).");
        }
        try {
            JsonNode a = dienst.ausRegel(lies(r.documentJson()), r.name(), r.flowVersion(),
                    registry.registryAnsicht(siteId, box));
            List<String> out = new ArrayList<>();
            for (JsonNode g : a.path("gruende")) out.add(g.path("text").asText());
            if (out.isEmpty() && a.path("uebersetzt").asBoolean()) {
                String k = konflikt(siteId, box, a.path("bericht"));
                if (k != null) out.add(k);
                else out.add("Die Regel wurde vor dem Einschalten des neuen Wegs nicht übersetzt; einmal aus- und "
                        + "wieder einschalten übersetzt sie.");
            }
            return out;
        } catch (SteuerlogikDienstException e) {
            if (SteuerlogikDienstException.KEINE_REGEL.equals(e.grund())) {
                return List.of("Die Regel ist im freien Editor gebaut; übersetzen lassen sich nur Regeln des "
                        + "Regel-Baukastens.");
            }
            return List.of(e.getMessage());
        }
    }

    /** Aus dem gemeldeten Lauf das, was eine Regel-Karte zeigt: das Gerät der Regel und die Lage. */
    private JsonNode vergleich(SteuerlogikRepository.Lauf lauf) {
        JsonNode r = lies(lauf.rueckmeldungJson());
        if (r == null) return null;
        ObjectNode out = json.createObjectNode();
        out.put("zustand", lauf.zustand());
        JsonNode g = r.path("geraete").path("geraet");
        for (String k : List.of("wunsch", "ist", "befehl", "halter", "schutz", "konflikt")) {
            if (g.has(k)) out.set(k, g.get(k));
        }
        for (String k : List.of("verglichen_s", "abweichend_s", "laengste_abweichung_s")) {
            if (g.has(k)) out.set(k, g.get(k));
        }
        if (r.has("lage")) out.set("lage", r.get("lage"));
        if (r.has("halt")) out.set("halt", r.get("halt"));
        if (r.has("unbekannt")) out.set("unbekannt", r.get("unbekannt"));
        return out;
    }

    private JsonNode lies(String text) {
        if (text == null) return null;
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }
}
