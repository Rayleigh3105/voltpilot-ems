package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.repo.FlowClaimRepository;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Steuerlogik in der Cloud: VoltPilot gibt eine Logik als Datei ab, der Dienst neben der API liest und prüft sie
 * ({@link SteuerlogikDienst}), die API legt sie als neue Fassung ab und liefert sie im vollständigen Satz auf
 * {@code …/v2/flows} an die führende Box der Anlage ({@link SteuerlogikAuslieferung}).
 *
 * <p>Stufe 2 (Mitlauf): die Box rechnet mit, ohne zu schalten. Stufe 3 (Scharf): ein eigener, protokollierter Schritt
 * je Fassung - die Box gibt die Wünsche an Schiedsrichter und Schutzgrenzen, und die Logik beansprucht ihre Geräte.
 * Vor dem Scharfschalten ist nur die Prüfung Pflicht (E5 = C): die Hinweise stehen gesammelt im Dialog, eine
 * Bestätigung genügt und wird mit der Fassung gespeichert. Ein Gerät hat nie zwei Herren ({@link SteuerlogikBesitz});
 * ein Konflikt wird gemeldet, nie still aufgelöst. "Zurück zur vorigen Fassung" und "Stilllegen" wirken sofort: der
 * neue Satz geht in derselben Anfrage an die Box. Gestellte Werte reisen im Bündel und sind keine Fassung.
 *
 * <p>Scharfschalten, Zurücknehmen und Stilllegen bleiben in dieser Stufe Sache der Plattform; gestellte Werte ändern
 * Kunden selbst, nach {@code editable_by} und den Rollen des Portals (E2 = B: einen Zielwert in °C immer).
 *
 * <p>Ehrliche Halte vor jeder Änderung: Anlage unbekannt, keine eindeutige führende Box, die Box meldet die Fähigkeit
 * nicht, der Dienst lehnt ab oder ist nicht erreichbar, ein zweiter Herr. Dann ändert sich nichts.
 */
@Service
public class SteuerlogikService {

    /** Uhrzeit und Tag der Anlage (die Flotte läuft in einer Zone; flexfallback, Tag der Anlage). */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    /** Höchstens so viele Zeichen nimmt die Annahme (der Dienst prüft dieselbe Grenze in Bytes). */
    static final int MAX_TEXT = 256 * 1024;
    /** Höchstens so viele Zeilen trägt ein Tag des Vergleichsprotokolls in der Antwort. */
    static final int MAX_WECHSEL = 2000;
    /** Höchstens so viele Schritte des Protokolls trägt ein Tag in der Antwort. */
    static final int MAX_SCHRITTE = 500;
    /** Wie lange das Vergleichsprotokoll bleibt. */
    public static final Duration PROTOKOLL_DAUER = Duration.ofDays(90);
    /** Ohne Herzschlag mit der Logik so lange gilt ihr Lauf als nicht gemeldet ("Logik hält an"). */
    static final Duration LAUF_STILL = Duration.ofMinutes(3);
    /** Die Rolle im Protokoll, wenn die Plattform handelt. */
    public static final String ROLLE_PLATTFORM = "voltpilot_betrieb";

    /** Der Hinweis, den das Portal nicht prüfen kann (Bericht 8.5 Schritt 3). */
    static final String HINWEIS_ALTE_STEUERUNG = "Die bisherige Steuerung dieser Geräte (etwa Home Assistant) muss aus "
            + "sein. Das Portal kann das nicht prüfen.";
    /** Was die Prüfung in dieser Stufe nicht kann (Prüfpunkte 4 bis 6 kommen mit Stufe 4). */
    static final String HINWEIS_NICHT_GEPRUEFT = "Nicht geprüft: was bei Ausfall eines Fühlers weiterläuft, wie oft ein "
            + "Gerät schaltet und ob die Zeiten der Logik zu den Schutzzeiten der Geräte passen.";

    /** Ein ehrlicher Halt: Code, Satz, bei einer Sperre der Prüfbericht, bei einem zweiten Herrn die Konflikte. */
    public static final class Abgelehnt extends RuntimeException {
        private final String grund;
        private final transient JsonNode bericht;
        private final transient List<SteuerlogikBesitz.Konflikt> konflikte;
        private transient JsonNode meldungen;

        Abgelehnt(String grund, String message, JsonNode bericht) {
            this(grund, message, bericht, List.of());
        }

        Abgelehnt(String grund, String message, JsonNode bericht, List<SteuerlogikBesitz.Konflikt> konflikte) {
            super(message);
            this.grund = grund;
            this.bericht = bericht;
            this.konflikte = konflikte;
        }

        /** Bei einem unlesbaren Text die Meldung des Lesers an ihrer Zeile; sonst null (sie stehen im Bericht). */
        public JsonNode meldungen() {
            return meldungen;
        }

        public String grund() {
            return grund;
        }

        public JsonNode bericht() {
            return bericht;
        }

        public List<SteuerlogikBesitz.Konflikt> konflikte() {
            return konflikte;
        }
    }

    /** Die angenommene (oder geänderte) Fassung. */
    public record Angenommen(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht,
            UUID box, boolean veroeffentlicht, String zustand, List<SteuerlogikDienst.Verworfen> verworfen) {

        public Angenommen(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht, UUID box,
                boolean veroeffentlicht) {
            this(logikId, fassung, name, contentHash, bericht, box, veroeffentlicht,
                    SteuerlogikRepository.ZUSTAND_MITLAUFEND, List.of());
        }
    }

    /** Was der Dialog "Scharf schalten" zeigt, bevor jemand bestätigt. */
    public record Vorschau(UUID logikId, int fassung, String name, String zustand, boolean boxKann,
            JsonNode bericht, List<String> hinweise, List<SteuerlogikBesitz.Konflikt> konflikte,
            List<String> geraete, List<String> kundeStellt, boolean moeglich) {}

    /** Ein gestellter Wert ist angekommen: der neue Stand und ob der Satz an die Box ging. */
    public record Gestellt(UUID logikId, String kennung, JsonNode wert, long stand, boolean veroeffentlicht) {}

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
    private SteuerlogikBesitz besitz;
    private FlowClaimRepository claims;

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

    /** Stufe 3: Besitz der Geräte und seine Materialisierung in {@code flow_claim} (Setter wie HeizstabPush). */
    @Autowired
    void setBesitz(SteuerlogikBesitz besitz, FlowClaimRepository claims) {
        this.besitz = besitz;
        this.claims = claims;
    }

    // --- Annahme -------------------------------------------------------------------------------------------------

    /**
     * Nimmt eine Logik als Text an: {@code logikId == null} legt eine neue Logik an (Fassung 1), sonst eine neue
     * Fassung derselben Logik, die die aktive ablöst. Liefert danach den vollständigen Satz an die Box.
     */
    public Angenommen annehmen(UUID siteId, UUID logikId, String text, String von) {
        return annehmen(siteId, logikId, text, von, ROLLE_PLATTFORM, false, false);
    }

    /**
     * Wie {@link #annehmen(UUID, UUID, String, String)}; mit {@code scharf} geht die neue Fassung gleich scharf - ein
     * protokollierter Schritt, der die Bestätigung der Hinweise braucht. Eine scharfe Fassung löst nur eine neue
     * scharfe ab: sonst fielen ihre Geräte still aus der Steuerung.
     */
    public Angenommen annehmen(UUID siteId, UUID logikId, String text, String von, String rolle, boolean scharf,
            boolean bestaetigt) {
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
        SteuerlogikRepository.Fassung aktiv = logikId == null ? null : logiken.aktiveFassung(logikId);
        if (aktiv != null && aktiv.scharf() && !scharf) {
            throw new Abgelehnt("scharf_abloesen", "Die laufende Fassung ist scharf. Eine neue Fassung löst sie nur "
                    + "scharf ab; sonst bitte die Logik erst stilllegen.", null);
        }
        UUID box = fuehrendeBox(siteId, scharf);
        if (scharf && !bestaetigt) {
            throw new Abgelehnt("bestaetigung_fehlt", "Bitte die Hinweise bestätigen, bevor die Logik scharf geht.",
                    null);
        }
        UUID id = logikId == null ? UUID.randomUUID() : logikId;
        int fassung = logiken.naechsteFassung(id);
        Instant jetzt = clock.instant();
        SteuerlogikRepository.Einstellung einstellung = logiken.einstellung(id);
        SteuerlogikDienst.Werte werte = werte(einstellung);
        String ansicht = registry.registryAnsicht(siteId, box);
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(text, id, fassung, jetzt,
                ort(site), ansicht, scharf, werte, true));
        JsonNode bericht = artefakt.bericht();
        if (scharf) pruefeBesitz(siteId, id, artefakt, ansicht);
        String name = bericht.path("name").asText("Logik");
        String kanonisch = artefakt.artefakt().path("bundle").path("logic").asText();
        String hash = artefakt.artefakt().path("content_hash").asText();
        String zustand = scharf ? SteuerlogikRepository.ZUSTAND_SCHARF : SteuerlogikRepository.ZUSTAND_MITLAUFEND;
        List<String> hinweise = scharf ? hinweise(bericht) : List.of();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            logiken.legeAn(tenant, siteId, id, fassung, name, text, kanonisch, artefakt.artefakt().toString(), hash,
                    bericht.toString(), von, jetzt);
            logiken.protokolliere(tenant, siteId, id, fassung, "angenommen", von, rolle, null, jetzt);
            uebernimmVerworfene(tenant, siteId, id, fassung, einstellung, artefakt, von, rolle, jetzt);
            if (scharf) {
                logiken.aktiviere(id, fassung, zustand, artefakt.artefakt().toString(), hash, jetzt, von,
                        json.valueToTree(hinweise).toString());
                logiken.protokolliere(tenant, siteId, id, fassung, "scharf", von, rolle,
                        json.createObjectNode().set("hinweise", json.valueToTree(hinweise)).toString(), jetzt);
                beanspruche(tenant, siteId, id, fassung, name, artefakt.artefakt());
            }
        });
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        if (scharf) registry.pushRegistryBestEffort(siteId);
        return new Angenommen(id, fassung, name, hash, bericht, box, veroeffentlicht, zustand, artefakt.verworfen());
    }

    // --- Scharf schalten -----------------------------------------------------------------------------------------

    /**
     * Was vor dem Scharfschalten der aktiven Fassung zu sehen ist: Prüfbericht, die gesammelten Hinweise, Konflikte
     * mit anderen Herren, welche Geräte die Logik dann führt und welche Werte der Kunde stellt.
     */
    public Vorschau scharfVorschau(UUID siteId, UUID logikId) {
        return scharfVorschau(siteId, logikId, null);
    }

    /**
     * Wie {@link #scharfVorschau(UUID, UUID)} für eine bestimmte Fassung (Stufe 4: eine vorgelegte, die die aktive
     * ablösen soll); {@code null} = die aktive.
     */
    public Vorschau scharfVorschau(UUID siteId, UUID logikId, Integer fassung) {
        SiteDto site = requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung f = fassung == null ? logiken.aktiveFassung(logikId)
                : requireFassung(logikId, fassung);
        if (f == null) {
            throw new Abgelehnt("nichts_aktiv", "Diese Logik läuft gerade nicht; erst eine Fassung annehmen.", null);
        }
        JsonNode bericht = lies(f.berichtJson());
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        boolean boxKann = box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        List<SteuerlogikBesitz.Konflikt> konflikte;
        if (boxKann && !f.scharf()) {
            // Genau die Prüfung des Scharfschaltens: das scharfe Artefakt verlangt je Gerät den Befehl, mit dem die
            // Box es schaltet, und der Registry-Push sagt, ob das Gerät ihn ausführt.
            String ansicht = registry.registryAnsicht(siteId, box);
            SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(
                    logiken.quelltext(logikId, f.fassung()), logikId, f.fassung(), clock.instant(),
                    ort(site), ansicht, true, werte(logiken.einstellung(logikId)), !f.aktiv()));
            konflikte = konflikte(siteId, logikId, artefakt, ansicht);
        } else {
            konflikte = besitz.pruefe(siteId, logikId, bericht);
        }
        List<String> geraete = new ArrayList<>();
        for (JsonNode g : bericht.path("geraete")) geraete.add(g.path("name").asText(g.path("kennung").asText()));
        List<String> kunde = new ArrayList<>();
        for (JsonNode s : bericht.path("stellwerte")) {
            if (s.path("zielwert").asBoolean() || "customer".equals(s.path("darf").asText())) {
                kunde.add(s.path("name").asText());
            }
        }
        return new Vorschau(logikId, f.fassung(), f.name(), f.zustand(), boxKann, bericht, hinweise(bericht),
                konflikte, geraete, kunde, boxKann && konflikte.isEmpty() && !f.scharf());
    }

    /**
     * Schaltet eine Fassung scharf - die mitlaufende oder (Stufe 4) eine gespeicherte, etwa eine vorgelegte, die die
     * aktive ablöst: Prüfung (beim Dienst), Bestätigung der Hinweise, kein zweiter Herr, eine Box mit
     * {@code steuerlogik_scharf}. Protokolliert mit wer, wann und den Hinweisen; die Geräte gehören ab jetzt der
     * Logik ({@code flow_claim}, im Registry-Push {@code owner_claimed}).
     */
    public Angenommen scharfSchalten(UUID siteId, UUID logikId, int fassung, boolean bestaetigt, String von,
            String rolle) {
        SiteDto site = requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung f = requireFassung(logikId, fassung);
        SteuerlogikRepository.Fassung aktiv = logiken.aktiveFassung(logikId);
        if (f.scharf()) {
            throw new Abgelehnt("schon_scharf", "Fassung " + f.fassung() + " ist schon scharf.", null);
        }
        UUID box = fuehrendeBox(siteId, true);
        if (!bestaetigt) {
            throw new Abgelehnt("bestaetigung_fehlt", "Bitte die Hinweise bestätigen, bevor die Logik scharf geht.",
                    null);
        }
        Instant jetzt = clock.instant();
        SteuerlogikRepository.Einstellung einstellung = logiken.einstellung(logikId);
        String ansicht = registry.registryAnsicht(siteId, box);
        // Eine andere Fassung als die laufende übernimmt die gestellten Werte, die passen (Bericht 8.9).
        boolean andere = aktiv == null || aktiv.fassung() != fassung;
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(
                logiken.quelltext(logikId, fassung), logikId, fassung, jetzt, ort(site), ansicht, true,
                werte(einstellung), andere));
        pruefeBesitz(siteId, logikId, artefakt, ansicht);
        List<String> hinweise = hinweise(artefakt.bericht());
        String hash = artefakt.artefakt().path("content_hash").asText();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            if (aktiv != null && aktiv.fassung() != fassung) logiken.stillegen(logikId, jetzt);
            logiken.aktiviere(logikId, fassung, SteuerlogikRepository.ZUSTAND_SCHARF,
                    artefakt.artefakt().toString(), hash, jetzt, von, json.valueToTree(hinweise).toString());
            ObjectNode daten = json.createObjectNode();
            daten.set("hinweise", json.valueToTree(hinweise));
            if (aktiv != null && aktiv.fassung() != fassung) daten.put("von", aktiv.fassung());
            logiken.protokolliere(tenant, siteId, logikId, fassung, "scharf", von, rolle, daten.toString(), jetzt);
            uebernimmVerworfene(tenant, siteId, logikId, fassung, einstellung, artefakt, von, rolle, jetzt);
            beanspruche(tenant, siteId, logikId, fassung, f.name(), artefakt.artefakt());
        });
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        registry.pushRegistryBestEffort(siteId);
        return new Angenommen(logikId, fassung, f.name(), hash, artefakt.bericht(), box, veroeffentlicht,
                SteuerlogikRepository.ZUSTAND_SCHARF, List.of());
    }

    /**
     * "Zurück zur vorigen Fassung": die Fassung vor der aktiven wird erneut ausgeliefert, im selben Zustand
     * (scharf bleibt scharf), mit den gestellten Werten, die zu ihr passen. Wirkt sofort: der Satz geht in dieser
     * Anfrage an die Box, die die Zustände gleichen Namens übernimmt (Bericht 8.9).
     */
    public Angenommen zurueck(UUID siteId, UUID logikId, String von, String rolle) {
        requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung f = logiken.aktiveFassung(logikId);
        if (f == null) {
            throw new Abgelehnt("nichts_aktiv", "Diese Logik läuft gerade nicht.", null);
        }
        SteuerlogikRepository.Fassung vorige = logiken.vorige(logikId, f.fassung());
        if (vorige == null) {
            throw new Abgelehnt("keine_vorige", "Fassung " + f.fassung() + " ist die erste; es gibt keine vorige.",
                    null);
        }
        return wechsleAuf(siteId, logikId, f, vorige, von, rolle);
    }

    /**
     * Rücknahme auf eine bestimmte Fassung (Stufe 4, Ansicht "Fassungen"): sie löst die aktive ab, im selben Zustand.
     * Ist die Logik scharf, nimmt ein Kunde nur auf eine Fassung zurück, die schon einmal scharf war - Scharfschalten
     * bleibt in Stufe 4 Sache der Plattform ({@code plattform}).
     */
    public Angenommen zurueckAuf(UUID siteId, UUID logikId, int fassung, boolean plattform, String von,
            String rolle) {
        requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung ziel = requireFassung(logikId, fassung);
        SteuerlogikRepository.Fassung f = logiken.aktiveFassung(logikId);
        if (f == null) {
            throw new Abgelehnt("nichts_aktiv", "Die Logik läuft gerade nicht. „Mitlaufen“ startet eine Fassung.",
                    null);
        }
        if (f.fassung() == fassung) {
            throw new Abgelehnt("laeuft_schon", "Fassung " + fassung + " läuft schon.", null);
        }
        if (f.scharf() && !plattform && ziel.scharfAm() == null) {
            throw new Abgelehnt("nicht_freigegeben", "Fassung " + fassung + " war noch nie scharf. Zurück geht nur auf "
                    + "eine Fassung, die VoltPilot schon einmal scharf geschaltet hat.", null);
        }
        return wechsleAuf(siteId, logikId, f, ziel, von, rolle);
    }

    /** Liefert {@code ziel} statt der aktiven Fassung {@code f} aus, im Zustand von {@code f}; protokolliert. */
    private Angenommen wechsleAuf(UUID siteId, UUID logikId, SteuerlogikRepository.Fassung f,
            SteuerlogikRepository.Fassung ziel, String von, String rolle) {
        SiteDto site = sites.findById(siteId);
        boolean scharf = f.scharf();
        UUID box = fuehrendeBox(siteId, scharf);
        Instant jetzt = clock.instant();
        SteuerlogikRepository.Einstellung einstellung = logiken.einstellung(logikId);
        String ansicht = registry.registryAnsicht(siteId, box);
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(
                logiken.quelltext(logikId, ziel.fassung()), logikId, ziel.fassung(), jetzt, ort(site),
                ansicht, scharf, werte(einstellung), true));
        if (scharf) pruefeBesitz(siteId, logikId, artefakt, ansicht);
        String hash = artefakt.artefakt().path("content_hash").asText();
        String zustand = scharf ? SteuerlogikRepository.ZUSTAND_SCHARF : SteuerlogikRepository.ZUSTAND_MITLAUFEND;
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            logiken.stillegen(logikId, jetzt);
            logiken.aktiviere(logikId, ziel.fassung(), zustand, artefakt.artefakt().toString(), hash,
                    scharf ? jetzt : null, scharf ? von : null, null);
            ObjectNode daten = json.createObjectNode();
            daten.put("von", f.fassung());
            daten.put("auf", ziel.fassung());
            logiken.protokolliere(tenant, siteId, logikId, ziel.fassung(), "zurueck", von, rolle,
                    daten.toString(), jetzt);
            uebernimmVerworfene(tenant, siteId, logikId, ziel.fassung(), einstellung, artefakt, von, rolle, jetzt);
            if (scharf) {
                beanspruche(tenant, siteId, logikId, ziel.fassung(), ziel.name(), artefakt.artefakt());
            }
        });
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        if (scharf) registry.pushRegistryBestEffort(siteId);
        return new Angenommen(logikId, ziel.fassung(), ziel.name(), hash, artefakt.bericht(), box,
                veroeffentlicht, zustand, artefakt.verworfen());
    }

    /** Legt die aktive Fassung still und liefert den Satz ohne sie aus. {@code false} = nichts lief. */
    public boolean stilllegen(UUID siteId, UUID logikId) {
        return stilllegen(siteId, logikId, null, ROLLE_PLATTFORM);
    }

    /**
     * Legt die aktive Fassung still (mitlaufend oder scharf): die Box hört sofort auf, ihre Geräte sind frei.
     * {@code false} = nichts lief.
     */
    public boolean stilllegen(UUID siteId, UUID logikId, String von, String rolle) {
        if (sites.findById(siteId) == null || !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        SteuerlogikRepository.Fassung f = logiken.aktiveFassung(logikId);
        if (f == null) return false;
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        int n = tx.execute(s -> {
            int z = logiken.stillegen(logikId, jetzt);
            if (z > 0) {
                logiken.protokolliere(tenant, siteId, logikId, f.fassung(), "stillgelegt", von, rolle, null, jetzt);
                if (f.scharf()) claims.replaceForFlow(tenant, siteId, logikId, f.fassung(), f.name(), List.of());
            }
            return z;
        });
        if (n > 0) {
            auslieferung.republishForSite(siteId);
            if (f.scharf()) registry.pushRegistryBestEffort(siteId);
        }
        return n > 0;
    }

    // --- Stufe 4: Aufbau und Text --------------------------------------------------------------------------------

    /** Höchstens so viele Zeichen trägt die Notiz einer Fassung. */
    static final int MAX_NOTIZ = 500;
    /** Höchstens so viele Zeichen trägt eine Anfrage. */
    static final int MAX_ANFRAGE = 1000;

    /**
     * Prüft einen Text mit denselben Regeln wie Dienst und Box, ohne etwas zu speichern (Ansicht "Text"): die Geräte
     * der Proben aus dem Registry-Inhalt der Anlage, so wie die Box ihn bekommt.
     */
    public SteuerlogikDienst.Geprueft pruefe(UUID siteId, String text) {
        if (sites.findById(siteId) == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        pruefeText(text);
        try {
            return dienst.pruefe(text, registryOderNull(siteId));
        } catch (SteuerlogikDienstException e) {
            throw new Abgelehnt(e.grund(), e.getMessage(), e.bericht());
        }
    }

    /** Was eine Logik an der Anlage lesen und schalten kann (Auswahl im Aufbau). */
    public JsonNode quellen(UUID siteId) {
        if (sites.findById(siteId) == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        try {
            return dienst.quellen(registryOderNull(siteId));
        } catch (SteuerlogikDienstException e) {
            throw new Abgelehnt(e.grund(), e.getMessage(), e.bericht());
        }
    }

    /** Eine gespeicherte Fassung. */
    public record Gespeichert(UUID logikId, int fassung, String name, String contentHash, JsonNode bericht) {}

    /**
     * Speichert einen Text als neue Fassung, die noch nicht läuft (Zustand {@code geprueft}): {@code logikId == null}
     * legt eine neue Logik an. Gespeichert wird nur, was die Prüfung nicht sperrt - der Dienst baut dafür das
     * Artefakt, wie er es zum Mitlaufen baut. {@code basis} ist die Fassung, von der die Änderung ausging: gibt es
     * inzwischen eine neuere, ist das ein ehrlicher Halt statt eines stillen Überschreibens.
     */
    public Gespeichert speichere(UUID siteId, UUID logikId, String text, String notiz, Integer basis, String von,
            String rolle) {
        SiteDto site = sites.findById(siteId);
        if (site == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        pruefeText(text);
        String n = notiz == null || notiz.isBlank() ? null : notiz.strip();
        if (n != null && n.length() > MAX_NOTIZ) {
            throw new Abgelehnt("notiz_zu_lang", "Die Notiz hat höchstens " + MAX_NOTIZ + " Zeichen.", null);
        }
        if (logikId != null && !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        UUID id = logikId == null ? UUID.randomUUID() : logikId;
        int neueste = logikId == null ? 0 : logiken.neuesteFassung(id);
        if (basis != null && basis != neueste) {
            throw new Abgelehnt("fassung_veraltet", "Inzwischen gibt es Fassung " + neueste + ". Bitte die Logik neu "
                    + "laden; Ihr Entwurf bleibt erhalten.", null);
        }
        int fassung = neueste + 1;
        Instant jetzt = clock.instant();
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(text, id, fassung, jetzt, ort(site),
                registryOderNull(siteId), false, werte(logiken.einstellung(id)), true));
        JsonNode bericht = artefakt.bericht();
        String name = bericht.path("name").asText("Logik");
        String kanonisch = artefakt.artefakt().path("bundle").path("logic").asText();
        String hash = artefakt.artefakt().path("content_hash").asText();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(st -> {
            logiken.speichere(tenant, siteId, id, fassung, name, text, kanonisch, artefakt.artefakt().toString(),
                    hash, bericht.toString(), von, rolle, n, jetzt);
            ObjectNode daten = json.createObjectNode();
            if (n != null) daten.put("notiz", n);
            logiken.protokolliere(tenant, siteId, id, fassung, "gespeichert", von, rolle,
                    daten.isEmpty() ? null : daten.toString(), jetzt);
        });
        return new Gespeichert(id, fassung, name, hash, bericht);
    }

    /**
     * Lässt eine gespeicherte Fassung mitlaufen (Bericht 8.4): sie löst die aktive ab und geht in dieser Anfrage an
     * die Box, die mit den echten Werten rechnet, ohne zu schalten. Eine scharfe Logik löst nur eine scharfe Fassung
     * ab - in Stufe 4 schaltet die Plattform scharf; der Kunde legt die Fassung dafür vor.
     */
    public Angenommen mitlaufen(UUID siteId, UUID logikId, int fassung, String von, String rolle) {
        SiteDto site = requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung ziel = requireFassung(logikId, fassung);
        SteuerlogikRepository.Fassung aktiv = logiken.aktiveFassung(logikId);
        if (aktiv != null && aktiv.fassung() == fassung) {
            throw new Abgelehnt("laeuft_schon", "Fassung " + fassung + " läuft schon.", null);
        }
        if (aktiv != null && aktiv.scharf()) {
            throw new Abgelehnt("scharf_abloesen", "Die Logik ist scharf (Fassung " + aktiv.fassung() + "). Eine neue "
                    + "Fassung löst sie nur scharf ab: bitte zur Freigabe vorlegen.", null);
        }
        UUID box = fuehrendeBox(siteId, false);
        Instant jetzt = clock.instant();
        SteuerlogikRepository.Einstellung einstellung = logiken.einstellung(logikId);
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(logiken.quelltext(logikId, fassung),
                logikId, fassung, jetzt, ort(site), registry.registryAnsicht(siteId, box), false, werte(einstellung),
                true));
        String hash = artefakt.artefakt().path("content_hash").asText();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(st -> {
            logiken.stillegen(logikId, jetzt);
            logiken.aktiviere(logikId, fassung, SteuerlogikRepository.ZUSTAND_MITLAUFEND,
                    artefakt.artefakt().toString(), hash, null, null, null);
            ObjectNode daten = json.createObjectNode();
            if (aktiv != null) daten.put("von", aktiv.fassung());
            logiken.protokolliere(tenant, siteId, logikId, fassung, "mitlaufen", von, rolle,
                    daten.isEmpty() ? null : daten.toString(), jetzt);
            uebernimmVerworfene(tenant, siteId, logikId, fassung, einstellung, artefakt, von, rolle, jetzt);
        });
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        return new Angenommen(logikId, fassung, ziel.name(), hash, artefakt.bericht(), box, veroeffentlicht,
                SteuerlogikRepository.ZUSTAND_MITLAUFEND, artefakt.verworfen());
    }

    /**
     * "Zur Freigabe vorlegen" (Stufe 4): Scharfschalten bleibt Sache der Plattform; eine Fassung, die scharf gehen
     * soll, legt der Kunde ihr vor. Protokolliert; ein zweites Vorlegen derselben Fassung ändert nichts.
     */
    public void vorlegen(UUID siteId, UUID logikId, int fassung, String von, String rolle) {
        requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung ziel = requireFassung(logikId, fassung);
        if (ziel.scharf()) {
            throw new Abgelehnt("schon_scharf", "Fassung " + fassung + " ist schon scharf.", null);
        }
        if (ziel.vorgelegtAm() != null) return;
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(st -> {
            logiken.legeVor(logikId, fassung, von, jetzt);
            logiken.protokolliere(tenant, siteId, logikId, fassung, "vorgelegt", von, rolle, null, jetzt);
        });
    }

    /** Eine Anfrage ist angekommen. */
    public record Angefragt(UUID id, UUID logikId) {}

    /**
     * "Änderung anfragen" (Bericht 6.5, 8.8): wer die Logik sieht und Werte stellt, aber den Text nicht schreibt, fragt
     * eine Änderung an - zu einem Wert ({@code kennung}) oder zur ganzen Logik.
     */
    public Angefragt frageAn(UUID siteId, UUID logikId, String kennung, String text, String von, String rolle) {
        requireLogik(siteId, logikId);
        String t = text == null ? "" : text.strip();
        if (t.isEmpty()) throw new Abgelehnt("text_fehlt", "Bitte kurz schreiben, was sich ändern soll.", null);
        if (t.length() > MAX_ANFRAGE) {
            throw new Abgelehnt("text_zu_gross", "Eine Anfrage hat höchstens " + MAX_ANFRAGE + " Zeichen.", null);
        }
        String k = kennung == null || kennung.isBlank() ? null : kennung;
        SteuerlogikRepository.Fassung neueste = logiken.fassung(logikId, logiken.neuesteFassung(logikId));
        if (k != null) {
            boolean da = false;
            for (JsonNode sw : lies(neueste.berichtJson()).path("stellwerte")) {
                if (sw.path("kennung").asText().equals(k)) da = true;
            }
            if (!da) {
                throw new Abgelehnt("stellwert_unbekannt", "Einen Wert „" + k + "“ gibt es in dieser Logik nicht.",
                        null);
            }
        }
        UUID id = UUID.randomUUID();
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(st -> {
            logiken.frageAn(tenant, siteId, id, logikId, k, t, von, rolle, jetzt);
            ObjectNode daten = json.createObjectNode();
            daten.put("anfrage", id.toString());
            if (k != null) daten.put("kennung", k);
            daten.put("text", t);
            logiken.protokolliere(tenant, siteId, logikId, neueste.fassung(), "anfrage", von, rolle,
                    daten.toString(), jetzt);
        });
        return new Angefragt(id, logikId);
    }

    /** Hakt eine Anfrage ab. */
    public void erledige(UUID siteId, UUID logikId, UUID anfrageId, String von, String rolle) {
        requireLogik(siteId, logikId);
        Instant jetzt = clock.instant();
        UUID tenant = TenantContext.get();
        int fassung = logiken.neuesteFassung(logikId);
        tx.executeWithoutResult(st -> {
            if (!logiken.erledige(logikId, anfrageId, von, jetzt)) {
                throw new Abgelehnt("anfrage_unbekannt", "Diese Anfrage ist nicht (mehr) offen.", null);
            }
            ObjectNode daten = json.createObjectNode();
            daten.put("anfrage", anfrageId.toString());
            logiken.protokolliere(tenant, siteId, logikId, fassung, "erledigt", von, rolle, daten.toString(), jetzt);
        });
    }

    /** Eine Logik der Anlage im Überblick (Reiter "Regeln"). */
    public record Kopf(UUID logikId, String name, SteuerlogikRepository.Fassung neueste,
            SteuerlogikRepository.Fassung aktiv, SteuerlogikRepository.Fassung vorgelegt, int offeneAnfragen,
            SteuerlogikRepository.Lauf lauf) {}

    /** Alle Logiken der Anlage, je mit neuester, aktiver und vorgelegter Fassung. */
    public List<Kopf> koepfe(UUID siteId) {
        if (sites.findById(siteId) == null) throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        Map<UUID, List<SteuerlogikRepository.Fassung>> je = new LinkedHashMap<>();
        for (SteuerlogikRepository.Fassung f : logiken.fassungen(siteId)) {
            je.computeIfAbsent(f.logikId(), k -> new ArrayList<>()).add(f);
        }
        Map<UUID, Integer> anfragen = logiken.offeneAnfragen(siteId);
        List<SteuerlogikRepository.Lauf> laeufe = logiken.laeufe(siteId);
        List<Kopf> out = new ArrayList<>();
        for (var e : je.entrySet()) {
            List<SteuerlogikRepository.Fassung> fs = new ArrayList<>(e.getValue());
            fs.sort((a, b) -> Integer.compare(b.fassung(), a.fassung()));
            SteuerlogikRepository.Fassung aktiv = fs.stream().filter(SteuerlogikRepository.Fassung::aktiv)
                    .findFirst().orElse(null);
            SteuerlogikRepository.Fassung vorgelegt = vorgelegt(fs);
            SteuerlogikRepository.Lauf lauf = laeufe.stream().filter(l -> l.logikId().equals(e.getKey()))
                    .findFirst().orElse(null);
            out.add(new Kopf(e.getKey(), (aktiv != null ? aktiv : fs.get(0)).name(), fs.get(0), aktiv, vorgelegt,
                    anfragen.getOrDefault(e.getKey(), 0), lauf));
        }
        return out;
    }

    /** Die jüngste vorgelegte Fassung, die noch auf die Freigabe wartet (neuer als jede scharfe), sonst null. */
    static SteuerlogikRepository.Fassung vorgelegt(List<SteuerlogikRepository.Fassung> jungZuerst) {
        for (SteuerlogikRepository.Fassung f : jungZuerst) {
            if (f.scharfAm() != null) return null;
            if (f.vorgelegtAm() != null) return f;
        }
        return null;
    }

    /** Eine Logik mit allen Fassungen, Anfragen und gestellten Werten. */
    public record Logik(UUID logikId, List<SteuerlogikRepository.Fassung> fassungen,
            List<SteuerlogikRepository.Anfrage> anfragen, SteuerlogikRepository.Einstellung einstellung,
            SteuerlogikRepository.Lauf lauf) {}

    public Logik logik(UUID siteId, UUID logikId) {
        requireLogik(siteId, logikId);
        SteuerlogikRepository.Lauf lauf = logiken.laeufe(siteId).stream()
                .filter(l -> l.logikId().equals(logikId)).findFirst().orElse(null);
        return new Logik(logikId, logiken.fassungenDerLogik(logikId), logiken.anfragen(logikId, 50),
                logiken.einstellung(logikId), lauf);
    }

    /** Was die führende Box der Anlage kann: mitlaufen lassen, scharf schalten. */
    public record BoxStand(boolean mitlauf, boolean scharf) {}

    public BoxStand boxStand(UUID siteId) {
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        return new BoxStand(box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT),
                box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF));
    }

    /** Der Text einer Fassung, wie er gespeichert wurde, mit ihrem Bericht. */
    public record Text(SteuerlogikRepository.Fassung fassung, String text) {}

    public Text text(UUID siteId, UUID logikId, int fassung) {
        requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung f = requireFassung(logikId, fassung);
        return new Text(f, logiken.quelltext(logikId, fassung));
    }

    /** Das Protokoll einer Logik über einen Zeitraum der Anlage (Tage, letzter eingeschlossen), jüngstes zuerst. */
    public List<SteuerlogikRepository.Schritt> protokoll(UUID siteId, UUID logikId, LocalDate von, LocalDate bis) {
        requireLogik(siteId, logikId);
        if (bis.isBefore(von)) throw new Abgelehnt("zeitraum", "Der Zeitraum endet vor seinem Anfang.", null);
        return logiken.protokoll(logikId, von.atStartOfDay(ZONE).toInstant(),
                bis.plusDays(1).atStartOfDay(ZONE).toInstant(), MAX_SCHRITTE);
    }

    private void pruefeText(String text) {
        if (text == null || text.isBlank()) {
            throw new Abgelehnt("text_fehlt", "Bitte den Text der Logik mitschicken.", null);
        }
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT) {
            throw new Abgelehnt("text_zu_gross", "Der Text ist größer als 256 KB.", null);
        }
    }

    private SteuerlogikRepository.Fassung requireFassung(UUID logikId, int fassung) {
        SteuerlogikRepository.Fassung f = logiken.fassung(logikId, fassung);
        if (f == null) {
            throw new Abgelehnt("fassung_unbekannt", "Fassung " + fassung + " gibt es nicht.", null);
        }
        return f;
    }

    /**
     * Der Registry-Inhalt der Anlage für die Proben, so wie die führende Box ihn bekommt; ohne eindeutige Box
     * {@code null} - die Proben rechnen dann mit ihren Vorgaben, und Speichern geht trotzdem.
     */
    private String registryOderNull(UUID siteId) {
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        return box == null ? null : registry.registryAnsicht(siteId, box);
    }

    // --- Gestellte Werte -----------------------------------------------------------------------------------------

    /**
     * Stellt einen Wert der aktiven Fassung. Wer was darf: einen Zielwert (°C) und einen Wert mit
     * {@code editable_by: customer} jeder, der die Betriebsweise ändern darf (E2 = B); die übrigen nur, wer
     * {@code darfFachbetriebWerte} (Kundenadministrator, Unterstützer, Plattform; E3 = B). Bereich, Schritt und
     * die Bedingungen zwischen den Werten prüft der Dienst; die Logik läuft weiter und behält ihren Zustand.
     */
    public Gestellt stelleWert(UUID siteId, UUID logikId, String kennung, JsonNode wert, boolean darfFachbetriebWerte,
            String von, String rolle) {
        SiteDto site = requireLogik(siteId, logikId);
        SteuerlogikRepository.Fassung f = logiken.aktiveFassung(logikId);
        if (f == null) {
            throw new Abgelehnt("nichts_aktiv", "Diese Logik läuft gerade nicht.", null);
        }
        JsonNode bericht = lies(f.berichtJson());
        JsonNode gefunden = null;
        for (JsonNode s : bericht.path("stellwerte")) {
            if (s.path("kennung").asText().equals(kennung)) gefunden = s;
        }
        final JsonNode info = gefunden;
        if (info == null) {
            throw new Abgelehnt("stellwert_unbekannt", "Einen Wert „" + kennung + "“ gibt es in dieser Logik nicht.",
                    null);
        }
        if (!darfStellen(info, darfFachbetriebWerte)) {
            throw new Abgelehnt("recht_fehlt", "„" + info.path("name").asText() + "“ legt Ihr Fachbetrieb fest.",
                    null);
        }
        if (wert == null || wert.isNull() || wert.isMissingNode()) {
            throw new Abgelehnt("wert_fehlt", "Bitte einen Wert mitschicken.", null);
        }
        UUID box = fuehrendeBox(siteId, f.scharf());
        Instant jetzt = clock.instant();
        SteuerlogikRepository.Einstellung einstellung = logiken.einstellung(logikId);
        SteuerlogikDienst.Werte bisher = werte(einstellung);
        Map<String, JsonNode> neu = new LinkedHashMap<>(bisher == null ? Map.of() : bisher.werte());
        JsonNode alt = neu.containsKey(kennung) ? neu.get(kennung) : info.path("vorgabe");
        neu.put(kennung, wert);
        long stand = einstellung.stand() + 1;
        SteuerlogikDienst.Artefakt artefakt = baue(new SteuerlogikDienst.Auftrag(
                logiken.quelltext(logikId, f.fassung()), logikId, f.fassung(), jetzt, ort(site),
                registry.registryAnsicht(siteId, box), f.scharf(), new SteuerlogikDienst.Werte(stand, neu), false));
        SteuerlogikDienst.Werte genommen = artefakt.werte() == null ? new SteuerlogikDienst.Werte(stand, neu)
                : artefakt.werte();
        String hash = artefakt.artefakt().path("content_hash").asText();
        UUID tenant = TenantContext.get();
        tx.executeWithoutResult(s -> {
            if (!logiken.setzeEinstellungWennStand(tenant, siteId, logikId, einstellung.stand(), stand,
                    json.valueToTree(genommen.werte()).toString(), jetzt)) {
                throw new Abgelehnt("gleichzeitig", "Gerade wurde ein anderer Wert dieser Logik gestellt. Bitte noch "
                        + "einmal versuchen.", null);
            }
            logiken.aktiviere(logikId, f.fassung(), f.zustand(), artefakt.artefakt().toString(), hash, null, null,
                    null);
            ObjectNode daten = json.createObjectNode();
            daten.put("kennung", kennung);
            daten.put("name", info.path("name").asText());
            daten.set("alt", alt);
            daten.set("neu", genommen.werte().getOrDefault(kennung, wert));
            daten.put("stand", stand);
            logiken.protokolliere(tenant, siteId, logikId, f.fassung(), "stellwert", von, rolle, daten.toString(),
                    jetzt);
        });
        boolean veroeffentlicht = auslieferung.republishForSite(siteId);
        return new Gestellt(logikId, kennung, genommen.werte().getOrDefault(kennung, wert), stand, veroeffentlicht);
    }

    /** Ob ein Wert gestellt werden darf: Zielwert und {@code customer} immer, sonst nur die Fachbetrieb-Rollen. */
    public static boolean darfStellen(JsonNode info, boolean darfFachbetriebWerte) {
        return info.path("zielwert").asBoolean() || "customer".equals(info.path("darf").asText())
                || darfFachbetriebWerte;
    }

    // --- Lesen ---------------------------------------------------------------------------------------------------

    /** Was die Plattform über die Logiken einer Anlage sieht. */
    public record Blatt(List<SteuerlogikRepository.Fassung> fassungen, List<SteuerlogikRepository.Lauf> laeufe,
            List<FlowStatusRepository.Ack> quittungen, UUID box, boolean boxKann, boolean boxKannScharf,
            Map<UUID, SteuerlogikRepository.Einstellung> einstellungen) {}

    public Blatt blatt(UUID siteId) {
        if (sites.findById(siteId) == null) {
            throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        }
        UUID box = leadDevices.fuehrendeBox(siteId).box();
        boolean kann = box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT);
        boolean kannScharf = box != null && faehigkeiten.kann(box, SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF);
        List<SteuerlogikRepository.Fassung> fassungen = logiken.fassungen(siteId);
        List<UUID> ids = fassungen.stream().map(SteuerlogikRepository.Fassung::logikId).distinct().toList();
        List<FlowStatusRepository.Ack> quittungen = acks.acksForSite(siteId).stream()
                .filter(a -> ids.contains(a.flowId())).toList();
        Map<UUID, SteuerlogikRepository.Einstellung> einstellungen = new LinkedHashMap<>();
        for (UUID id : ids) einstellungen.put(id, logiken.einstellung(id));
        return new Blatt(fassungen, logiken.laeufe(siteId), quittungen, box, kann, kannScharf, einstellungen);
    }

    /** Das Vergleichsprotokoll eines Tages der Anlage (Tage der Anlage, Europe/Berlin). */
    public List<SteuerlogikRepository.Wechsel> wechsel(UUID siteId, UUID logikId, LocalDate tag) {
        requireLogik(siteId, logikId);
        Instant von = tag.atStartOfDay(ZONE).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(ZONE).toInstant();
        return logiken.wechsel(siteId, logikId, von, bis, MAX_WECHSEL);
    }

    /** Das Protokoll der Schritte an einer Logik an einem Tag der Anlage, jüngster zuerst. */
    public List<SteuerlogikRepository.Schritt> schritte(UUID siteId, UUID logikId, LocalDate tag) {
        requireLogik(siteId, logikId);
        Instant von = tag.atStartOfDay(ZONE).toInstant();
        Instant bis = tag.plusDays(1).atStartOfDay(ZONE).toInstant();
        return logiken.protokoll(logikId, von, bis, MAX_SCHRITTE);
    }

    /** Eine scharfe Logik, wie der Kunde sie sieht (Karte und Blatt "Warum?"). */
    public record Karte(SteuerlogikRepository.Fassung fassung, JsonNode bericht,
            SteuerlogikRepository.Einstellung einstellung, SteuerlogikRepository.Lauf lauf, JsonNode rueckmeldung,
            FlowStatusRepository.Ack quittung, List<Stoerung> stoerungen) {}

    /** Eine Störung in Code und Satz; die erste ist die, die die Karte zeigt. */
    public record Stoerung(String code, String text) {}

    /** Die scharfen Logiken der Anlage für die Karte des Kunden. */
    public List<Karte> karten(UUID siteId) {
        if (sites.findById(siteId) == null) {
            throw new Abgelehnt("anlage_unbekannt", "Diese Anlage gibt es nicht.", null);
        }
        Instant jetzt = clock.instant();
        List<SteuerlogikRepository.Lauf> laeufe = logiken.laeufe(siteId);
        List<FlowStatusRepository.Ack> quittungen = acks.acksForSite(siteId);
        List<Karte> out = new ArrayList<>();
        for (SteuerlogikRepository.Fassung f : logiken.fassungen(siteId)) {
            if (!f.scharf()) continue;
            SteuerlogikRepository.Lauf lauf = laeufe.stream().filter(l -> l.logikId().equals(f.logikId()))
                    .max((a, b) -> a.gemeldetAm() == null ? -1 : b.gemeldetAm() == null ? 1
                            : a.gemeldetAm().compareTo(b.gemeldetAm()))
                    .orElse(null);
            FlowStatusRepository.Ack quittung = quittungen.stream().filter(a -> a.flowId().equals(f.logikId()))
                    .findFirst().orElse(null);
            JsonNode bericht = lies(f.berichtJson());
            JsonNode rueckmeldung = lauf == null ? null : lies(lauf.rueckmeldungJson());
            out.add(new Karte(f, bericht, logiken.einstellung(f.logikId()), lauf, rueckmeldung, quittung,
                    stoerungen(f, bericht, lauf, rueckmeldung, quittung, jetzt)));
        }
        return out;
    }

    /**
     * Was an einer scharfen Logik gerade nicht stimmt, wichtigstes zuerst: die Box lehnt sie ab, meldet sie nicht
     * (mehr) - die Logik hält an -, schaltet nicht (Schalter der Box, Pause), die Lage ist eine Störung, ein Eingang
     * hat keinen Wert, ein Gerät wird nicht geschaltet.
     */
    static List<Stoerung> stoerungen(SteuerlogikRepository.Fassung f, JsonNode bericht,
            SteuerlogikRepository.Lauf lauf, JsonNode r, FlowStatusRepository.Ack quittung, Instant jetzt) {
        List<Stoerung> out = new ArrayList<>();
        if (quittung != null && quittung.flowVersion() == f.fassung() && f.contentHash().equals(quittung.contentHash())
                && !"active".equals(quittung.state())) {
            out.add(new Stoerung("box_lehnt_ab", "Die Box hat diese Fassung nicht übernommen"
                    + (quittung.detail() == null ? "." : ": " + quittung.detail())));
        }
        boolean laeuft = lauf != null && lauf.fassung() == f.fassung() && "scharf".equals(lauf.zustand());
        if (!laeuft) {
            out.add(new Stoerung("haelt_an", "Die Logik läuft auf der Box nicht. Ihre Geräte schalten gerade "
                    + "nicht nach ihr."));
            return out;
        }
        if (lauf.gemeldetAm() != null && lauf.gemeldetAm().isBefore(jetzt.minus(LAUF_STILL))) {
            out.add(new Stoerung("keine_meldung", "Die Box meldet sich seit "
                    + java.time.format.DateTimeFormatter.ofPattern("HH:mm").format(lauf.gemeldetAm().atZone(ZONE))
                    + " Uhr nicht. Was die Logik tut, ist nicht bekannt."));
        }
        JsonNode halt = r.path("halt");
        if (halt.isObject() && halt.path("text").isTextual()) {
            out.add(new Stoerung(halt.path("code").asText("halt"), halt.path("text").asText()));
        }
        if ("fault".equals(r.path("lage").path("art").asText())) {
            out.add(new Stoerung("lage", r.path("lage").path("titel").asText("Störung")));
        }
        List<String> fehlen = new ArrayList<>();
        for (JsonNode u : r.path("unbekannt")) {
            String name = u.asText();
            for (JsonNode e : bericht.path("eingaenge")) {
                if (e.path("kennung").asText().equals(u.asText())) name = e.path("name").asText(name);
            }
            fehlen.add(name);
        }
        if (!fehlen.isEmpty()) {
            out.add(new Stoerung("wert_fehlt", "Ohne Wert: " + String.join(", ", fehlen) + "."));
        }
        r.path("geraete").fields().forEachRemaining(e -> {
            JsonNode k = e.getValue().path("konflikt");
            if (k.isObject() && k.path("text").isTextual()) {
                out.add(new Stoerung(k.path("code").asText("konflikt"), k.path("text").asText()));
            }
        });
        return out;
    }

    // --- Hilfen --------------------------------------------------------------------------------------------------

    /** Die gesammelten Hinweise des Dialogs "Scharf schalten" (E5 = C: eine Bestätigung für alle). */
    List<String> hinweise(JsonNode bericht) {
        List<String> out = new ArrayList<>();
        for (JsonNode h : bericht.path("hinweise")) out.add(h.asText());
        for (JsonNode z : bericht.path("zusammen")) {
            if (z.path("im_bereich_verletzbar").asBoolean()) {
                out.add("„" + z.path("name").asText() + "“ ließe sich im erlaubten Bereich verletzen; die Regler "
                        + "lassen nur Werte zu, die passen.");
            }
        }
        out.add(HINWEIS_ALTE_STEUERUNG);
        out.add(HINWEIS_NICHT_GEPRUEFT);
        return out;
    }

    private SteuerlogikDienst.Artefakt baue(SteuerlogikDienst.Auftrag auftrag) {
        try {
            return dienst.artefakt(auftrag);
        } catch (SteuerlogikDienstException e) {
            Abgelehnt a = new Abgelehnt(e.grund(), e.getMessage(), e.bericht());
            a.meldungen = e.meldungen();
            throw a;
        }
    }

    /** Kein zweiter Herr, und jedes Gerät kennt die Box mit dem Befehl, mit dem sie es schaltet. */
    /**
     * Was dem Scharfschalten entgegensteht: die Herren und Ausschlüsse ({@link SteuerlogikBesitz#pruefe}) und je Gerät
     * die Befehle, die das scharfe Artefakt verlangt ({@code required_entities}), gegen die Fähigkeiten im
     * Registry-Push dieser Box - dieselbe Prüfung, mit der die Box das Bündel annimmt. Ohne Befehl kennt die Registry
     * das Gerät nicht.
     */
    private List<SteuerlogikBesitz.Konflikt> konflikte(UUID siteId, UUID logikId, SteuerlogikDienst.Artefakt artefakt,
            String ansicht) {
        List<SteuerlogikBesitz.Konflikt> konflikte = new ArrayList<>(besitz.pruefe(siteId, logikId,
                artefakt.bericht()));
        Map<String, Set<String>> kann = befehleDerRegistry(ansicht);
        for (JsonNode r : artefakt.artefakt().path("required_entities")) {
            String entity = r.path("entity_id").asText();
            if (konflikte.stream().anyMatch(k -> entity.equals(String.valueOf(k.entityId())))) continue;
            String name = entity;
            for (JsonNode g : artefakt.bericht().path("geraete")) {
                if (g.path("entity_id").asText().equals(entity)) name = g.path("name").asText(entity);
            }
            UUID id;
            try {
                id = UUID.fromString(entity);
            } catch (IllegalArgumentException e) {
                id = null;
            }
            if (r.path("capabilities").isEmpty()) {
                konflikte.add(new SteuerlogikBesitz.Konflikt(id, name, "geraet_unbekannt",
                        "Die Box kennt „" + name + "“ nicht oder kann es nicht schalten."));
                continue;
            }
            for (JsonNode c : r.path("capabilities")) {
                String befehl = c.asText().replaceFirst("^actuate:", "");
                if (!kann.getOrDefault(entity, Set.of()).contains(befehl)) {
                    konflikte.add(new SteuerlogikBesitz.Konflikt(id, name, "ausgang_offen", "„" + name + "“ führt „"
                            + befehlsWort(befehl) + "“ nicht aus; so kann die Logik es nicht schalten."));
                    break;
                }
            }
        }
        return konflikte;
    }

    /** Je Gerät die Befehle, die es laut Registry-Push ausführt ({@code capabilities.actuate[].command}). */
    private Map<String, Set<String>> befehleDerRegistry(String ansicht) {
        Map<String, Set<String>> out = new HashMap<>();
        for (JsonNode e : lies(ansicht).path("entities")) {
            Set<String> befehle = new HashSet<>();
            for (JsonNode a : e.path("capabilities").path("actuate")) befehle.add(a.path("command").asText());
            out.put(e.path("entity_id").asText(), befehle);
        }
        return out;
    }

    /** Ein Befehl in Kundenwörtern (wie die Box ihn im Herzschlag nennt, agent/steuerlogik_scharf.go). */
    static String befehlsWort(String befehl) {
        return switch (befehl) {
            case "on_off" -> "Ein/Aus";
            case "setpoint_c" -> "Sollwert in °C";
            case "setpoint_kw" -> "Leistung in kW";
            case "mode" -> "Betriebsart";
            default -> befehl;
        };
    }

    private void pruefeBesitz(UUID siteId, UUID logikId, SteuerlogikDienst.Artefakt artefakt, String ansicht) {
        List<SteuerlogikBesitz.Konflikt> konflikte = konflikte(siteId, logikId, artefakt, ansicht);
        if (!konflikte.isEmpty()) {
            throw new Abgelehnt("zweiter_herr", konflikte.size() == 1 ? konflikte.get(0).text()
                    : konflikte.size() + " Geräte kann die Logik nicht übernehmen.", artefakt.bericht(), konflikte);
        }
    }

    /** Materialisiert den Besitz: je Gerät der Befehl, mit dem die Box es schaltet (aus required_entities). */
    private void beanspruche(UUID tenant, UUID siteId, UUID logikId, int fassung, String name, JsonNode artefakt) {
        List<FlowClaimRepository.ClaimRow> rows = new ArrayList<>();
        for (JsonNode r : artefakt.path("required_entities")) {
            UUID entity = UUID.fromString(r.path("entity_id").asText());
            for (JsonNode c : r.path("capabilities")) {
                String cap = c.asText();
                if (cap.startsWith("actuate:")) {
                    rows.add(new FlowClaimRepository.ClaimRow(entity, cap.substring("actuate:".length()), logikId,
                            fassung, name, false, null));
                }
            }
        }
        claims.replaceForFlow(tenant, siteId, logikId, fassung, name, rows);
    }

    /** Werte, die eine neue Fassung nicht übernimmt, fallen auf ihre Vorgabe; das Protokoll nennt jeden. */
    private void uebernimmVerworfene(UUID tenant, UUID siteId, UUID logikId, int fassung,
            SteuerlogikRepository.Einstellung einstellung, SteuerlogikDienst.Artefakt artefakt, String von,
            String rolle, Instant jetzt) {
        if (artefakt.verworfen().isEmpty() || artefakt.werte() == null) return;
        logiken.setzeEinstellung(tenant, siteId, logikId, einstellung.stand(),
                json.valueToTree(artefakt.werte().werte()).toString(), jetzt);
        for (SteuerlogikDienst.Verworfen v : artefakt.verworfen()) {
            ObjectNode daten = json.createObjectNode();
            daten.put("kennung", v.kennung());
            daten.put("grund", v.grund());
            daten.put("verworfen", true);
            logiken.protokolliere(tenant, siteId, logikId, fassung, "stellwert", von, rolle, daten.toString(),
                    jetzt);
        }
    }

    /** Die gestellten Werte für den Dienst; {@code null} ohne - das Bündel bleibt dann, wie es in Stufe 2 war. */
    private SteuerlogikDienst.Werte werte(SteuerlogikRepository.Einstellung e) {
        JsonNode werte = lies(e.werteJson());
        if (e.stand() == 0 && (werte == null || werte.isEmpty())) return null;
        Map<String, JsonNode> m = new LinkedHashMap<>();
        if (werte != null) werte.fields().forEachRemaining(x -> m.put(x.getKey(), x.getValue()));
        return new SteuerlogikDienst.Werte(e.stand(), m);
    }

    private UUID fuehrendeBox(UUID siteId, boolean scharf) {
        LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
        if (lead.box() == null) {
            throw new Abgelehnt("keine_box", "Die Anlage hat keine eindeutige führende Box, an die die Logik gehen "
                    + "könnte.", null);
        }
        if (!faehigkeiten.kann(lead.box(), SteuerlogikAuslieferung.FAEHIGKEIT)) {
            throw new Abgelehnt("box_ohne_mitlauf", "Die Box dieser Anlage kann noch keine Steuerlogik mitlaufen "
                    + "lassen (Fähigkeit steuerlogik_mitlauf fehlt). Bitte erst die Box aktualisieren.", null);
        }
        if (scharf && !faehigkeiten.kann(lead.box(), SteuerlogikAuslieferung.FAEHIGKEIT_SCHARF)) {
            throw new Abgelehnt("box_ohne_scharf", "Die Box dieser Anlage kann noch nicht nach einer Logik schalten "
                    + "(Fähigkeit steuerlogik_scharf fehlt). Bitte erst die Box aktualisieren.", null);
        }
        return lead.box();
    }

    private SiteDto requireLogik(UUID siteId, UUID logikId) {
        SiteDto site = sites.findById(siteId);
        if (site == null || !logiken.gehoertZu(logikId, siteId)) {
            throw new Abgelehnt("logik_unbekannt", "Diese Logik gibt es an dieser Anlage nicht.", null);
        }
        return site;
    }

    private static SteuerlogikDienst.Ort ort(SiteDto site) {
        return new SteuerlogikDienst.Ort(ZONE.getId(), site.latitude(), site.longitude());
    }

    private JsonNode lies(String text) {
        if (text == null) return json.createObjectNode();
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return json.createObjectNode();
        }
    }

    /** Für Tests und Leser: eine leere Liste als Knoten. */
    ArrayNode leer() {
        return json.createArrayNode();
    }
}
