package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.HeizstabImKern;
import com.voltpilot.api.consumers.HeizstabPush;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.repo.SteuerwegRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.verbraucher.VerbraucherService;
import com.voltpilot.api.web.dto.SiteDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
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
 * Zusammenführen, dritter Teil (Steuerlogik Stufe 6; Vertrag {@code docs/contracts/v2/steuerlogik.md}): die Gruppe
 * der Geräte am Schalter der Anlage - die Verbraucherregel einer Steuerart (der generierte Flow,
 * {@code origin.kind = consumer-policy}) und der Heizstab-Regler (der Parameterblock {@code heizstab} im
 * Registry-Push) als Logik des Kerns. Ihre Übersetzung ist eine abgeleitete Logik ({@code steuerlogik.herkunft} =
 * {@code steuerart} oder {@code heizstab}); bearbeitet wird die Steuerart.
 *
 * <ul>
 *   <li>Ab Werk {@code alt}, auf beiden Box-Arten: der alte Weg ist der Flow (Node-RED, auf Edge Light der Go-Zwilling)
 *       und der Regler der Box. {@code mitlauf}: die Übersetzungen laufen mit. {@code kern}: sie schalten; der
 *       generierte Flow bleibt aus dem Satz, der Block aus der Registry.</li>
 *   <li>Eine Übersetzung gilt nur, solange sie zu ihrer Quelle passt ({@code herkunft_stand}); vor jedem Satz und
 *       jedem Registry-Push übersetzt {@link #angleiche} neu. Geht das nicht, legt es die Übersetzung still und der
 *       alte Weg führt - nie zwei Wege für ein Gerät, nie keiner.</li>
 * </ul>
 */
@Service
public class SteuerwegGeraete implements HeizstabImKern {

    private static final Logger log = LoggerFactory.getLogger(SteuerwegGeraete.class);

    /** Das Wort in {@code supports[]}: der Kern kennt die Ergänzungen der Sprache für Steuerarten und Heizstab. */
    public static final String FAEHIGKEIT = "steuerlogik_steuerarten";

    private final SteuerlogikRepository logiken;
    private final SteuerwegRepository wege;
    private final FlowRepository flows;
    private final ConsumerRepository verbraucher;
    private final HeizstabPush heizstab;
    private final SiteRepository sites;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten faehigkeiten;
    private final SteuerlogikDienst dienst;
    private final ObjectProvider<EntityRegistryService> registry;
    private final ObjectProvider<FlowActivationService> auslieferung;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public SteuerwegGeraete(SteuerlogikRepository logiken, SteuerwegRepository wege, FlowRepository flows,
            ConsumerRepository verbraucher, HeizstabPush heizstab, SiteRepository sites, LeadDeviceService leadDevices,
            BoxFaehigkeiten faehigkeiten, SteuerlogikDienst dienst, ObjectProvider<EntityRegistryService> registry,
            ObjectProvider<FlowActivationService> auslieferung, TransactionTemplate tx, ObjectMapper json) {
        this(logiken, wege, flows, verbraucher, heizstab, sites, leadDevices, faehigkeiten, dienst, registry,
                auslieferung, tx, json, Clock.systemUTC());
    }

    SteuerwegGeraete(SteuerlogikRepository logiken, SteuerwegRepository wege, FlowRepository flows,
            ConsumerRepository verbraucher, HeizstabPush heizstab, SiteRepository sites, LeadDeviceService leadDevices,
            BoxFaehigkeiten faehigkeiten, SteuerlogikDienst dienst, ObjectProvider<EntityRegistryService> registry,
            ObjectProvider<FlowActivationService> auslieferung, TransactionTemplate tx, ObjectMapper json,
            Clock clock) {
        this.logiken = logiken;
        this.wege = wege;
        this.flows = flows;
        this.verbraucher = verbraucher;
        this.heizstab = heizstab;
        this.sites = sites;
        this.leadDevices = leadDevices;
        this.faehigkeiten = faehigkeiten;
        this.dienst = dienst;
        this.registry = registry;
        this.auslieferung = auslieferung;
        this.tx = tx;
        this.json = json;
        this.clock = clock;
    }

    /** Die abgeleitete Logik der Steuerart eines Geräts: eine je Gerät, mit Fassungen. */
    public static UUID logikIdSteuerart(UUID entityId) {
        return UUID.nameUUIDFromBytes(("steuerlogik-steuerart:" + entityId).getBytes(StandardCharsets.UTF_8));
    }

    /** Die abgeleitete Logik des Heizstab-Reglers eines Stabs. */
    public static UUID logikIdHeizstab(UUID entityId) {
        return UUID.nameUUIDFromBytes(("steuerlogik-heizstab:" + entityId).getBytes(StandardCharsets.UTF_8));
    }

    /** Ob die Box Übersetzungen dieser Gruppe mitlaufen lassen kann. */
    public boolean kann(UUID box) {
        return box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT)
                && faehigkeiten.kann(box, FAEHIGKEIT);
    }

    /** Ob die Box nach ihnen schalten kann. */
    public boolean kannScharf(UUID box) {
        return kann(box) && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
    }

    // --- Die Quellen ---------------------------------------------------------------------------------------------

    /**
     * Ein alter Weg der Gruppe an einem Gerät: der generierte Flow einer Steuerart oder der Block eines Heizstabs, mit
     * dem Fingerabdruck dessen, woraus seine Übersetzung entsteht; {@code nicht} ist der Grund, warum er auf dem alten
     * Weg bleibt, ohne erst zu übersetzen.
     */
    public record Quelle(String herkunft, UUID entityId, String name, UUID logikId, String stand, FlowVersionRow flow,
            JsonNode dokument, JsonNode block, String nicht) {}

    /** Die alten Wege der Gruppe an dieser Box, je Gerät höchstens einer; ein Gerät mit zwei bleibt, wie es ist. */
    public List<Quelle> quellen(UUID siteId, UUID box) {
        List<Quelle> out = new ArrayList<>();
        Map<UUID, HeizstabPush.Block> bloecke = heizstab.bloecke(siteId, box);
        for (FlowVersionRow r : flows.activeVersionsForSiteExcept(siteId, "edge", null)) {
            JsonNode doc = lies(r.documentJson());
            if (doc == null || !"consumer-policy".equals(doc.path("origin").path("kind").asText())) continue;
            UUID entity;
            try {
                entity = UUID.fromString(doc.path("origin").path("entity_id").asText());
            } catch (IllegalArgumentException e) {
                continue;
            }
            ConsumerRepository.ConsumerRow c = verbraucher.findForSite(siteId, entity);
            String name = c == null || c.label() == null || c.label().isBlank() ? "Gerät" : c.label();
            String nicht = null;
            if (c != null && VerbraucherService.istLadepunkt(c.entityType())) {
                nicht = "Ein Ladepunkt hat seinen eigenen Ort (Laden); eine Logik des Kerns beansprucht ihn nicht.";
            } else if (bloecke.containsKey(entity)) {
                nicht = "Dieses Gerät führen schon der Heizstab-Regler und eine Verbraucherregel; zwei Wege für ein "
                        + "Gerät bleiben, wie sie sind.";
            }
            out.add(new Quelle(SteuerlogikRepository.HERKUNFT_STEUERART, entity, name, logikIdSteuerart(entity),
                    "flow:" + r.flowId() + ":" + r.flowVersion(), r, doc, null, nicht));
        }
        Set<UUID> mitFlow = new HashSet<>();
        for (Quelle q : out) mitFlow.add(q.entityId());
        for (var e : bloecke.entrySet()) {
            ConsumerRepository.ConsumerRow c = verbraucher.findForSite(siteId, e.getKey());
            String name = c == null || c.label() == null || c.label().isBlank() ? "Heizstab" : c.label();
            String nicht = mitFlow.contains(e.getKey())
                    ? "Dieses Gerät führen schon der Heizstab-Regler und eine Verbraucherregel; zwei Wege für ein "
                            + "Gerät bleiben, wie sie sind." : null;
            out.add(new Quelle(SteuerlogikRepository.HERKUNFT_HEIZSTAB, e.getKey(), name,
                    logikIdHeizstab(e.getKey()), e.getValue().stand(), null, null, e.getValue().block(), nicht));
        }
        return out;
    }

    // --- Übersetzen ------------------------------------------------------------------------------------------------

    /**
     * Die Übersetzung einer Quelle für einen Zustand ({@code mitlaufend} oder {@code scharf}): {@code artefakt == null}
     * heißt, sie bleibt auf dem alten Weg, warum steht in {@code gruende}; {@code dienstFehlt}: der Dienst war nicht zu
     * erreichen.
     */
    public record Plan(Quelle quelle, int fassung, String name, String text, SteuerlogikDienst.Artefakt artefakt,
            String zustand, List<String> gruende, boolean dienstFehlt) {}

    /** Die Antwort des Dienstes auf eine Übersetzung, oder warum es keine gibt. */
    private record Uebersetzt(JsonNode antwort, List<String> gruende, boolean dienstFehlt) {}

    private Uebersetzt uebersetze(Quelle q, String ansicht) {
        if (q.nicht() != null) return new Uebersetzt(null, List.of(q.nicht()), false);
        JsonNode antwort;
        try {
            antwort = SteuerlogikRepository.HERKUNFT_STEUERART.equals(q.herkunft())
                    ? dienst.ausSteuerart(q.dokument(), q.flow().name(), q.flow().flowVersion(), ansicht)
                    : dienst.ausHeizstab(q.entityId(), q.block(), "Heizstab-Regler: " + q.name(), ansicht);
        } catch (SteuerlogikDienstException e) {
            return new Uebersetzt(null, List.of(e.getMessage()),
                    SteuerlogikDienstException.NICHT_ERREICHBAR.equals(e.grund()));
        }
        if (!antwort.path("uebersetzt").asBoolean()) {
            List<String> gruende = new ArrayList<>();
            for (JsonNode g : antwort.path("gruende")) gruende.add(g.path("text").asText());
            return new Uebersetzt(null, gruende, false);
        }
        return new Uebersetzt(antwort, List.of(), false);
    }

    /** Übersetzt und baut das Artefakt (Netzaufrufe, nichts wird geschrieben). */
    public Plan plane(UUID siteId, Quelle q, String zustand, String ansicht, SiteDto site) {
        Uebersetzt u = uebersetze(q, ansicht);
        if (u.antwort() == null) return new Plan(q, 0, null, null, null, zustand, u.gruende(), u.dienstFehlt());
        JsonNode antwort = u.antwort();
        String text = antwort.path("text").asText();
        int fassung = logiken.naechsteFassung(q.logikId());
        boolean scharf = SteuerlogikRepository.ZUSTAND_SCHARF.equals(zustand);
        SteuerlogikDienst.Artefakt artefakt;
        try {
            artefakt = dienst.artefakt(new SteuerlogikDienst.Auftrag(text, q.logikId(), fassung, clock.instant(),
                    new SteuerlogikDienst.Ort(SteuerlogikService.ZONE.getId(), site == null ? null : site.latitude(),
                            site == null ? null : site.longitude()), ansicht, scharf, null, false,
                    antwort.path("pflicht").asBoolean(false)));
        } catch (SteuerlogikDienstException e) {
            return new Plan(q, 0, null, null, null, zustand, List.of(e.getMessage()),
                    SteuerlogikDienstException.NICHT_ERREICHBAR.equals(e.grund()));
        }
        String name = artefakt.bericht().path("name").asText(q.name());
        return new Plan(q, fassung, name, text, artefakt, zustand, List.of(), false);
    }

    /** Schreibt eine Übersetzung als neue Fassung ihrer abgeleiteten Logik. In der Transaktion des Aufrufers. */
    public void schreibe(UUID siteId, Plan p, String von, String rolle) {
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        Quelle q = p.quelle();
        SteuerlogikDienst.Artefakt a = p.artefakt();
        String kanonisch = a.artefakt().path("bundle").path("logic").asText();
        UUID herkunft = SteuerlogikRepository.HERKUNFT_STEUERART.equals(q.herkunft()) ? q.flow().flowId()
                : q.entityId();
        Integer herkunftFassung = q.flow() == null ? null : q.flow().flowVersion();
        logiken.legeGeraetAn(tenant, siteId, q.logikId(), p.fassung(), p.name(), p.text(), kanonisch,
                a.artefakt().toString(), a.artefakt().path("content_hash").asText(), a.bericht().toString(),
                p.zustand(), q.herkunft(), herkunft, herkunftFassung, q.stand(), q.entityId(), jetzt);
        ObjectNode daten = json.createObjectNode().put(q.herkunft(), herkunft.toString())
                .put("geraet", q.entityId().toString());
        if (herkunftFassung != null) daten.put("fassung", herkunftFassung);
        logiken.protokolliere(tenant, siteId, q.logikId(), p.fassung(), "angenommen", von, rolle, daten.toString(),
                jetzt);
        if (SteuerlogikRepository.ZUSTAND_SCHARF.equals(p.zustand())) {
            logiken.protokolliere(tenant, siteId, q.logikId(), p.fassung(), "scharf", von, rolle, daten.toString(),
                    jetzt);
        }
    }

    /** Legt eine Übersetzung still. In der Transaktion des Aufrufers. */
    public void stillegen(UUID siteId, SteuerlogikRepository.Fassung f, String von, String rolle, String grund) {
        Instant jetzt = clock.instant();
        logiken.stillegen(f.logikId(), jetzt);
        ObjectNode daten = json.createObjectNode().put("geraet", String.valueOf(f.herkunftGeraet()));
        if (grund != null) daten.put("grund", grund);
        logiken.protokolliere(TenantContext.get(), siteId, f.logikId(), f.fassung(), "stillgelegt", von, rolle,
                daten.toString(), jetzt);
    }

    /**
     * Was ein Schritt am Schalter für die Gruppe tut: je Quelle der Plan für den Zielzustand (Netzaufrufe, vor der
     * Transaktion) und die Übersetzungen, die stillgelegt werden.
     */
    public record Vorhaben(List<Plan> plaene, List<SteuerlogikRepository.Fassung> still, boolean dienstFehlt) {

        boolean aendert() {
            return !plaene.isEmpty() || !still.isEmpty();
        }
    }

    /**
     * Bereitet die Gruppe auf {@code modus} vor: {@code alt} legt jede Übersetzung still; sonst wird jede Quelle,
     * deren Übersetzung fehlt, veraltet ist oder im anderen Zustand läuft, neu übersetzt, und jede Übersetzung ohne
     * Quelle (oder ohne Übersetzung) stillgelegt.
     */
    public Vorhaben vorbereiten(UUID siteId, UUID box, String modus) {
        Map<UUID, SteuerlogikRepository.Fassung> aktive = new LinkedHashMap<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveGeraete(siteId)) aktive.put(f.logikId(), f);
        if (SteuerwegRepository.ALT.equals(modus) || !kann(box)) {
            return new Vorhaben(List.of(), List.copyOf(aktive.values()), false);
        }
        String zustand = SteuerwegRepository.KERN.equals(modus) && kannScharf(box)
                ? SteuerlogikRepository.ZUSTAND_SCHARF : SteuerlogikRepository.ZUSTAND_MITLAUFEND;
        SiteDto site = sites.findById(siteId);
        String ansicht = null;
        List<Plan> plaene = new ArrayList<>();
        List<SteuerlogikRepository.Fassung> still = new ArrayList<>();
        boolean dienstFehlt = false;
        for (Quelle q : quellen(siteId, box)) {
            SteuerlogikRepository.Fassung f = aktive.remove(q.logikId());
            if (f != null && q.nicht() == null && q.stand().equals(f.herkunftStand()) && zustand.equals(f.zustand())) {
                continue;
            }
            if (ansicht == null) ansicht = registry.getObject().registryAnsicht(siteId, box);
            Plan p = plane(siteId, q, zustand, ansicht, site);
            dienstFehlt |= p.dienstFehlt();
            if (p.artefakt() != null) {
                plaene.add(p);
            } else if (f != null) {
                still.add(f);
            }
        }
        still.addAll(aktive.values());
        return new Vorhaben(plaene, still, dienstFehlt);
    }

    /** Schreibt ein Vorhaben. In der Transaktion des Aufrufers. */
    public void schreibe(UUID siteId, Vorhaben v, String von, String rolle) {
        for (SteuerlogikRepository.Fassung f : v.still()) stillegen(siteId, f, von, rolle, null);
        for (Plan p : v.plaene()) schreibe(siteId, p, von, rolle);
    }

    /**
     * Bringt die Übersetzungen auf den Stand ihrer Quellen im Modus der Anlage; {@code true}, wenn sich etwas
     * änderte. Ohne Dienst bleibt eine veraltete Übersetzung nicht stehen: sie wird stillgelegt, der alte Weg führt.
     */
    public boolean angleiche(UUID siteId) {
        String modus = wege.weg(siteId).geraeteModus();
        if (SteuerwegRepository.ALT.equals(modus) && logiken.aktiveGeraete(siteId).isEmpty()) return false;
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        Vorhaben v = vorbereiten(siteId, box, modus);
        if (!v.aendert()) return false;
        if (v.dienstFehlt()) {
            log.warn("steuerweg: Dienst nicht erreichbar - Übersetzungen der Geräte an Anlage {} folgen dem alten Weg",
                    siteId);
        }
        tx.executeWithoutResult(s -> schreibe(siteId, v, null, null));
        return true;
    }

    @Override
    public void angleichen(UUID siteId) {
        boolean geaendert;
        try {
            geaendert = angleiche(siteId);
        } catch (RuntimeException e) {
            // Bestmöglich wie jeder Push: der Block bleibt, solange keine aktuelle scharfe Übersetzung ihn ersetzt.
            log.warn("steuerweg: Angleichen der Geräte an Anlage {} gescheitert: {}", siteId, e.toString());
            return;
        }
        if (!geaendert) return;
        FlowActivationService a = auslieferung.getIfAvailable();
        if (a != null && !a.republishForSite(siteId)) {
            log.warn("steuerweg: Satz der Anlage {} nach dem Angleichen nicht veröffentlicht", siteId);
        }
    }

    // --- Was im Kern schaltet ------------------------------------------------------------------------------------

    /** Die generierten Flows, deren Übersetzung scharf und aktuell an diese Box geht: sie bleiben aus dem Satz. */
    public Set<UUID> ersetzteFlows(UUID siteId, UUID box) {
        if (!kannScharf(box)) return Set.of();
        Map<UUID, Integer> aktiveFlows = new HashMap<>();
        for (FlowVersionRow r : flows.activeVersionsForSiteExcept(siteId, "edge", null)) {
            aktiveFlows.put(r.flowId(), r.flowVersion());
        }
        Set<UUID> out = new HashSet<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveGeraete(siteId)) {
            if (f.scharf() && SteuerlogikRepository.HERKUNFT_STEUERART.equals(f.herkunft())
                    && f.herkunftFassung() != null
                    && f.herkunftFassung().equals(aktiveFlows.get(f.herkunftFlowId()))) {
                out.add(f.herkunftFlowId());
            }
        }
        return out;
    }

    @Override
    public Set<UUID> imKern(UUID siteId, UUID box) {
        if (!kannScharf(box)) return Set.of();
        Map<UUID, HeizstabPush.Block> bloecke = null;
        Set<UUID> out = new HashSet<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveGeraete(siteId)) {
            if (!f.scharf() || !SteuerlogikRepository.HERKUNFT_HEIZSTAB.equals(f.herkunft())) continue;
            if (bloecke == null) bloecke = heizstab.bloecke(siteId, box);
            HeizstabPush.Block b = bloecke.get(f.herkunftGeraet());
            if (b != null && b.stand().equals(f.herkunftStand())) out.add(f.herkunftGeraet());
        }
        return out;
    }

    // --- Der Stand für Portal und Plattform ----------------------------------------------------------------------

    /**
     * Ein Gerät der Gruppe: {@code art} ({@code steuerart}, {@code heizstab}), wo es läuft ({@code alt},
     * {@code mitlauf}, {@code kern}), warum nicht im Kern, die Übersetzung und der Vergleich der Box.
     */
    public record GeraetWeg(String art, UUID entityId, String name, String weg, List<String> gruende, UUID logikId,
            Integer logikFassung, JsonNode vergleich, Instant gemeldetAm) {}

    /** Je Gerät der Gruppe, wo es läuft. */
    public List<GeraetWeg> stand(UUID siteId, UUID box, String modus,
            java.util.function.Function<SteuerlogikRepository.Lauf, JsonNode> vergleich) {
        Map<UUID, SteuerlogikRepository.Fassung> aktive = new HashMap<>();
        for (SteuerlogikRepository.Fassung f : logiken.aktiveGeraete(siteId)) aktive.put(f.logikId(), f);
        Set<UUID> flowsImKern = ersetzteFlows(siteId, box);
        Set<UUID> staebeImKern = imKern(siteId, box);
        List<SteuerlogikRepository.Lauf> laeufe = logiken.laeufe(siteId);
        List<GeraetWeg> out = new ArrayList<>();
        for (Quelle q : quellen(siteId, box)) {
            SteuerlogikRepository.Fassung f = aktive.get(q.logikId());
            String w;
            if (f == null) {
                w = "alt";
            } else if (SteuerlogikRepository.HERKUNFT_STEUERART.equals(q.herkunft())
                    ? flowsImKern.contains(q.flow().flowId()) : staebeImKern.contains(q.entityId())) {
                w = "kern";
            } else {
                w = "mitlauf";
            }
            List<String> gruende = List.of();
            if (f == null && !SteuerwegRepository.ALT.equals(modus)) {
                gruende = q.nicht() != null ? List.of(q.nicht()) : !kann(box)
                        ? List.of("Die Box kann Steuerarten noch nicht über ihren Kern ausführen (Fähigkeit "
                                + FAEHIGKEIT + " fehlt). Bitte erst die Box aktualisieren.")
                        : gruende(siteId, q, box);
            }
            SteuerlogikRepository.Lauf lauf = f == null ? null : laeufe.stream()
                    .filter(l -> l.logikId().equals(f.logikId())).findFirst().orElse(null);
            out.add(new GeraetWeg(q.herkunft(), q.entityId(), q.name(), w, gruende, f == null ? null : f.logikId(),
                    f == null ? null : f.fassung(), lauf == null ? null : vergleich.apply(lauf),
                    lauf == null ? null : lauf.gemeldetAm()));
        }
        return out;
    }

    /** Warum ein Gerät nicht im Kern läuft (fragt den Dienst; ohne ihn ein ehrlicher Satz). */
    private List<String> gruende(UUID siteId, Quelle q, UUID box) {
        Uebersetzt u = uebersetze(q, registry.getObject().registryAnsicht(siteId, box));
        if (!u.gruende().isEmpty()) return u.gruende();
        return List.of("Die Steuerart wurde vor dem Einschalten des neuen Wegs nicht übersetzt; der nächste Schritt am "
                + "Schalter übersetzt sie.");
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
