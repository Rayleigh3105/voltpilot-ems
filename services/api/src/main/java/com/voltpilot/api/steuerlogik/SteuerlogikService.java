package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.repo.FlowStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.web.dto.SiteDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Steuerlogik Stufe 2, zweiter Teil: VoltPilot gibt eine Logik als Datei ab, der Dienst neben der API liest und prüft
 * sie ({@link SteuerlogikDienst}), die API legt sie als neue Fassung ab und liefert sie im vollständigen Satz auf
 * {@code …/v2/flows} an die führende Box der Anlage ({@link SteuerlogikAuslieferung}). Dort läuft sie mit, ohne zu
 * schalten. Noch keine Oberfläche für Kunden: nur die Plattform ruft das hier auf.
 *
 * <p>Ehrliche Halte vor jeder Änderung: Anlage unbekannt, keine eindeutige führende Box, die Box meldet
 * {@code steuerlogik_mitlauf} nicht, der Dienst lehnt ab oder ist nicht erreichbar. Dann ändert sich nichts.
 */
@Service
public class SteuerlogikService {

    /** Uhrzeit und Tag der Anlage (die Flotte läuft in einer Zone; flexfallback, Tag der Anlage). */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    /** Höchstens so viele Zeichen nimmt die Annahme (der Dienst prüft dieselbe Grenze in Bytes). */
    static final int MAX_TEXT = 256 * 1024;
    /** Höchstens so viele Zeilen trägt ein Tag des Vergleichsprotokolls in der Antwort. */
    static final int MAX_WECHSEL = 2000;
    /** Wie lange das Vergleichsprotokoll bleibt. */
    public static final Duration PROTOKOLL_DAUER = Duration.ofDays(90);

    /** Ein ehrlicher Halt der Annahme: Code, Satz, bei einer Sperre der Prüfbericht. */
    public static final class Abgelehnt extends RuntimeException {
        private final String grund;
        private final transient JsonNode bericht;

        Abgelehnt(String grund, String message, JsonNode bericht) {
            super(message);
            this.grund = grund;
            this.bericht = bericht;
        }

        public String grund() {
            return grund;
        }

        public JsonNode bericht() {
            return bericht;
        }
    }

    /** Die angenommene Fassung. */
    public record Angenommen(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht,
            UUID box, boolean veroeffentlicht) {}

    private final SteuerlogikRepository logiken;
    private final SiteRepository sites;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten faehigkeiten;
    private final SteuerlogikDienst dienst;
    private final FlowActivationService auslieferung;
    private final FlowStatusRepository acks;
    private final EntityRegistryService registry;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public SteuerlogikService(SteuerlogikRepository logiken, SiteRepository sites, LeadDeviceService leadDevices,
            BoxFaehigkeiten faehigkeiten, SteuerlogikDienst dienst, FlowActivationService auslieferung,
            FlowStatusRepository acks, EntityRegistryService registry, TransactionTemplate tx, ObjectMapper json) {
        this(logiken, sites, leadDevices, faehigkeiten, dienst, auslieferung, acks, registry, tx, json,
                Clock.systemUTC());
    }

    SteuerlogikService(SteuerlogikRepository logiken, SiteRepository sites, LeadDeviceService leadDevices,
            BoxFaehigkeiten faehigkeiten, SteuerlogikDienst dienst, FlowActivationService auslieferung,
            FlowStatusRepository acks, EntityRegistryService registry, TransactionTemplate tx, ObjectMapper json,
            Clock clock) {
        this.logiken = logiken;
        this.sites = sites;
        this.leadDevices = leadDevices;
        this.faehigkeiten = faehigkeiten;
        this.dienst = dienst;
        this.auslieferung = auslieferung;
        this.acks = acks;
        this.registry = registry;
        this.tx = tx;
        this.json = json;
        this.clock = clock;
    }

    /**
     * Nimmt eine Logik als Text an: {@code logikId == null} legt eine neue Logik an (Fassung 1), sonst eine neue
     * Fassung derselben Logik, die die laufende ablöst. Liefert danach den vollständigen Satz an die Box.
     */
    public Angenommen annehmen(UUID siteId, UUID logikId, String text, String von) {
        SiteDto site = sites.findById(siteId);
        if (site == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        if (text == null || text.isBlank()) {
            throw new Abgelehnt("text_fehlt", "Bitte den Text der Logik mitschicken.", null);
        }
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT) {
            throw new Abgelehnt("text_zu_gross", "Der Text ist größer als 256 KB.", null);
        }
        if (logikId != null && !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
        if (lead.box() == null) {
            throw new Abgelehnt("keine_box", "Die Anlage hat keine eindeutige führende Box, an die die Logik gehen "
                    + "könnte.", null);
        }
        if (!faehigkeiten.kann(lead.box(), SteuerlogikAuslieferung.FAEHIGKEIT)) {
            throw new Abgelehnt("box_ohne_mitlauf", "Die Box dieser Anlage kann noch keine Steuerlogik mitlaufen "
                    + "lassen (Fähigkeit steuerlogik_mitlauf fehlt). Bitte erst die Box aktualisieren.", null);
        }
        UUID id = logikId == null ? UUID.randomUUID() : logikId;
        int fassung = logiken.naechsteFassung(id);
        Instant jetzt = clock.instant();
        SteuerlogikDienst.Artefakt artefakt;
        try {
            artefakt = dienst.artefakt(new SteuerlogikDienst.Auftrag(text, id, fassung, jetzt,
                    new SteuerlogikDienst.Ort(ZONE.getId(), site.latitude(), site.longitude()),
                    registry.registryAnsicht(siteId, lead.box())));
        } catch (SteuerlogikDienstException e) {
            throw new Abgelehnt(e.grund(), e.getMessage(), e.bericht());
        }
        JsonNode bericht = artefakt.bericht();
        String name = bericht.path("name").asText("Logik");
        String kanonisch = artefakt.artefakt().path("bundle").path("logic").asText();
        String hash = artefakt.artefakt().path("content_hash").asText();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> logiken.legeAn(tenant, siteId, id, fassung, name, text, kanonisch,
                artefakt.artefakt().toString(), hash, bericht.toString(), von, jetzt));
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        return new Angenommen(id, fassung, name, hash, bericht, lead.box(), veroeffentlicht);
    }

    /** Legt die mitlaufende Fassung still und liefert den Satz ohne sie aus. {@code false} = nichts lief. */
    public boolean stilllegen(UUID siteId, UUID logikId) {
        if (sites.findById(siteId) == null || !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        int n = tx.execute(s -> logiken.stillegen(logikId, clock.instant()));
        if (n > 0) auslieferung.republishForSite(siteId);
        return n > 0;
    }

    /** Was die Plattform über die Logiken einer Anlage sieht. */
    public record Blatt(List<SteuerlogikRepository.Fassung> fassungen, List<SteuerlogikRepository.Lauf> laeufe,
            List<FlowStatusRepository.Ack> quittungen, UUID box, boolean boxKann) {}

    public Blatt blatt(UUID siteId) {
        if (sites.findById(siteId) == null) {
            throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        }
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        boolean kann = box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT);
        List<SteuerlogikRepository.Fassung> fassungen = logiken.fassungen(siteId);
        List<UUID> ids = fassungen.stream().map(SteuerlogikRepository.Fassung::logikId).distinct().toList();
        List<FlowStatusRepository.Ack> quittungen = acks.acksForSite(siteId).stream()
                .filter(a -> ids.contains(a.flowId())).toList();
        return new Blatt(fassungen, logiken.laeufe(siteId), quittungen, box, kann);
    }

    /** Das Vergleichsprotokoll eines Tages der Anlage (Tage der Anlage, Europe/Berlin). */
    public List<SteuerlogikRepository.Wechsel> wechsel(UUID siteId, UUID logikId, LocalDate tag) {
        if (sites.findById(siteId) == null || !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        Instant von = tag.atStartOfDay(ZONE).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(ZONE).toInstant();
        return logiken.wechsel(siteId, logikId, von, bis, MAX_WECHSEL);
    }
}
