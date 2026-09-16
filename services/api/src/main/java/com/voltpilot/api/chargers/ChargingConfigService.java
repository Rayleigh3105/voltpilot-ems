package com.voltpilot.api.chargers;

import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.uems.AnlageStandortRepository;
import com.voltpilot.api.uems.NetzanschlussRepository;
import com.voltpilot.api.uems.StandortRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.fahrzeuge.SiteVehicleRepository;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.FahrzeugDto.VehicleProfileDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Lastmanagement-Konfiguration einer Anlage: die Anschlussgrenze und welche
 * Säulen Vorrang haben (Lastmanagement Stufe 3, PR 12).
 *
 * <p><b>Es entsteht kein zweiter Verteiler.</b> Gespeichert wird nur, was der
 * Kunde WÜNSCHT; gerechnet und durchgesetzt wird auf der Box - die
 * Anschlussgrenze ist eine physische Grenze, ihr Wächter darf nicht am WAN
 * hängen (Konzept E1). Der Weg ist der etablierte: Zeile → retained Dokument →
 * die Box übernimmt es in ihre Einstellungen (PATCH: was das Portal nicht
 * nennt, behält sie).
 *
 * <p><b>Was das Portal NICHT besitzt</b>, und zwar bewusst: Sicherheitsabstand,
 * Mindestleistung und die höchste bekannte Gebäudelast bleiben Einstellungen
 * der Box (die Mockups nennen sie „Von VoltPilot eingerichtet"). Der
 * Aktivieren-Dialog fragt genau die EINE Zahl ab, die dem Kunden gehört und
 * ohne die gar nichts geht.
 *
 * <p>Der Push ist BEST-EFFORT (das {@code EntityRegistryService}-Muster): eine
 * gespeicherte Grenze wird nie wegen eines Broker-Ausfalls abgelehnt. Der
 * ehrliche Ort dafür ist die Antwort - sie sagt, ob das Dokument hinausging.
 */
@Service
public class ChargingConfigService {

    private static final Logger log = LoggerFactory.getLogger(ChargingConfigService.class);

    /**
     * Die Obergrenze der Plausibilität. Sie ist absichtlich weit (ein
     * DC-Ladepark hängt an einem Mittelspannungs-Anschluss) und fängt nur den
     * Tippfehler ab, der aus 277 kW 277000 macht.
     */
    private static final double MAX_GRID_LIMIT_KW = 100_000;

    /**
     * Das Vokabular des Kontrakts. Es steht hier ein zweites Mal, weil eine
     * Ablehnung den ERLAUBTEN Satz nennen muss - „ungültig" ist auf einer
     * Kundenfläche keine Antwort.
     */
    private static final Set<String> POLICIES = Set.of("nur_sonne", "sonne_zuerst", "schnell");

    private static final Set<String> STORAGE = Set.of("speicher_vor_auto", "auto_vor_speicher");

    /**
     * Das Zeichen-Vokabular einer ChargePointId, wie der Kontrakt es führt (und
     * die Box an ihrem eigenen Formular prüft). Es ist zugleich das eines
     * MQTT-Topic-Segments.
     */
    private static final Pattern CHARGE_POINT_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    /** Die Deckel des Kontrakts - hier ein zweites Mal, damit die Ablehnung sie NENNT. */
    private static final int MAX_CHARGE_POINTS = 64;

    private static final double MAX_RATED_KW = 1000;

    private static final int MAX_CONNECTORS = 32;

    private final Geltungsbereich geltungsbereich;
    private final ChargingConfigRepository configs;
    private final DeviceChargerStatusRepository chargers;
    private final ObjectProvider<ChargingConfigPublisher> publisher;
    private final NetzanschlussRepository netzanschluesse;
    private final AnlageStandortRepository anlageStandorte;
    private final StandortRepository standorte;
    /**
     * Die Fahrzeug-Profile (P7). Als {@link ObjectProvider}, damit ein
     * Deployment ohne diese Bohne (ein Test-Kontext etwa) hier nichts anderes
     * tut als vorher - nie ein Pflicht-Glied fuer ein additives Feature.
     */
    private final ObjectProvider<SiteVehicleRepository> vehicles;

    public ChargingConfigService(Geltungsbereich geltungsbereich, ChargingConfigRepository configs,
            DeviceChargerStatusRepository chargers,
            ObjectProvider<ChargingConfigPublisher> publisher,
            ObjectProvider<SiteVehicleRepository> vehicles,
            NetzanschlussRepository netzanschluesse,
            AnlageStandortRepository anlageStandorte,
            StandortRepository standorte) {
        this.geltungsbereich = geltungsbereich;
        this.configs = configs;
        this.chargers = chargers;
        this.publisher = publisher;
        this.vehicles = vehicles;
        this.netzanschluesse = netzanschluesse;
        this.anlageStandorte = anlageStandorte;
        this.standorte = standorte;
    }

    /** Die gepflegte Konfiguration (leer = noch nichts gepflegt). */
    public ChargingConfigDto read(UUID siteId) {
        requireSite(siteId);
        return configs.forSite(siteId);
    }

    /**
     * Speichert die Konfiguration und schickt sie an jedes Gerät der Anlage.
     *
     * <p>PATCH-Semantik: ein abwesendes Feld BEHÄLT den gespeicherten Wert -
     * ein Dialog, der nur den Vorrang stellt, darf die Anschlussgrenze nicht
     * löschen.
     */
    @Transactional
    public ChargingConfigDto save(UUID siteId, Double gridLimitKw, List<String> priorities,
            String surplusPolicy, String storagePriority, String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        if (gridLimitKw != null) {
            if (gridLimitKw.isNaN() || !(gridLimitKw > 0) || gridLimitKw > MAX_GRID_LIMIT_KW) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Die Anschlussgrenze muss eine Leistung größer 0 kW sein.");
            }
            configs.saveGridLimit(tenantId, siteId, gridLimitKw, actor);
        }
        // ⚠ Ein unbekanntes Wort wird BENANNT abgelehnt, nie still auf eine
        // Vorgabe gedreht: hier entscheidet ein Kunde über seine eigene Anlage,
        // und ein stiller Rückfall ließe ihn glauben, er hätte etwas gesetzt,
        // was er nicht gesetzt hat.
        if (surplusPolicy != null && !POLICIES.contains(surplusPolicy)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Überschuss-Priorität. Möglich sind „Nur Sonnenstrom\", "
                            + "„Sonne zuerst\" und „Schnell laden\".");
        }
        if (storagePriority != null && !STORAGE.contains(storagePriority)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Speicher-Priorität. Möglich sind „Speicher vor Auto\" und "
                            + "„Auto vor Speicher\".");
        }
        if (surplusPolicy != null || storagePriority != null) {
            configs.saveSourceChoice(tenantId, siteId, surplusPolicy, storagePriority, actor);
        }
        List<String> cleaned = priorities == null ? null : clean(siteId, priorities);
        if (cleaned != null) {
            configs.replacePriorities(tenantId, siteId, cleaned);
        }
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    /**
     * Setzt die Anschlussgrenze über den Kunden-Schritt (AP-01 IP-13). Anders als der ältere,
     * allgemeine Konfigurationsweg prüft dieser Weg den Netzanschluss und das verbleibende
     * Ladebudget, bevor derselbe gespeicherte Wunsch zur Box reist.
     *
     * <p>Ist heute kein Netzanschluss gebunden, gilt der beschlossene Übergang: die vereinbarte
     * Leistung kommt ausdrücklich aus dem Dialog. Sobald eine Bindung besteht, ist ausschließlich
     * deren {@code vereinbart_kw} maßgeblich; ein mitgesendeter Übergangswert kann sie nie ersetzen.
     */
    @Transactional
    public ChargingConfigDto saveCustomerFrame(UUID siteId, Double gridLimitKw,
            Double vereinbartKwDialog, String actor) {
        requireSite(siteId);
        pruefeNetzgrenze(gridLimitKw);

        LocalDate heute = heuteAmStandort(siteId);
        NetzanschlussRepository.Bindung bindung = netzanschluesse.bindungenDerAnlage(siteId).stream()
                .filter(b -> b.laeuftAm(heute)).findFirst().orElse(null);
        BigDecimal vereinbart;
        String herkunft;
        if (bindung == null) {
            if (vereinbartKwDialog == null || vereinbartKwDialog.isNaN()
                    || !(vereinbartKwDialog > 0) || vereinbartKwDialog > MAX_GRID_LIMIT_KW) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "An diese Anlage ist heute kein Netzanschluss gebunden. Tragen Sie die vereinbarte Leistung im Dialog ein.");
            }
            vereinbart = BigDecimal.valueOf(vereinbartKwDialog);
            herkunft = "Ihrer Eingabe";
        } else {
            var anschluss = netzanschluesse.finde(bindung.netzanschlussId()).orElse(null);
            vereinbart = anschluss == null ? null : anschluss.vereinbartKw();
            herkunft = "Netzanschluss " + bindung.netzanschlussKennzeichen();
            if (vereinbart == null) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Beim Netzanschluss " + bindung.netzanschlussKennzeichen()
                                + " ist keine vereinbarte Leistung hinterlegt.");
            }
        }

        BigDecimal grenze = BigDecimal.valueOf(gridLimitKw);
        if (grenze.compareTo(vereinbart) > 0) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    kw(grenze) + " kW liegen über " + kw(vereinbart)
                            + " kW vereinbarter Leistung (" + herkunft + ") — bitte prüfen.");
        }

        ChargingConfigDto vorhanden = configs.forSite(siteId);
        var rahmen = vorhanden.frame();
        Double grundlast = rahmen == null ? null : rahmen.maxHouseLoadKw();
        Double reserve = rahmen == null ? null : rahmen.houseReserveKw();
        if (grundlast == null || reserve == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Für die Plausibilitätsprüfung fehlen die Grundlast der letzten 7 Tage oder die Hausreserve. VoltPilot richtet diese Werte ein.");
        }
        BigDecimal budget = grenze.subtract(BigDecimal.valueOf(grundlast))
                .subtract(BigDecimal.valueOf(reserve));
        if (budget.signum() <= 0) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Grundlast der letzten 7 Tage (" + kw(BigDecimal.valueOf(grundlast))
                            + " kW) und die Hausreserve (" + kw(BigDecimal.valueOf(reserve))
                            + " kW) lassen innerhalb von " + kw(grenze)
                            + " kW kein Ladebudget übrig.");
        }

        UUID tenantId = TenantContext.get();
        configs.saveGridLimit(tenantId, siteId, gridLimitKw, actor);
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    private void pruefeNetzgrenze(Double gridLimitKw) {
        if (gridLimitKw == null || gridLimitKw.isNaN() || !(gridLimitKw > 0)
                || gridLimitKw > MAX_GRID_LIMIT_KW) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Anschlussgrenze muss eine Leistung größer 0 kW sein.");
        }
    }

    /** Tagesbindungen gelten in der Zeitzone des zugeordneten Standorts, nie nach Server-Mitternacht. */
    private LocalDate heuteAmStandort(UUID siteId) {
        Instant jetzt = Instant.now();
        for (AnlageStandortRepository.Zuordnung z : anlageStandorte.fuerAnlage(siteId)) {
            if (z.aufgehoben()) {
                continue;
            }
            var standort = standorte.finde(z.standortId()).orElse(null);
            if (standort == null) {
                continue;
            }
            LocalDate tag = LocalDate.ofInstant(jetzt, ZoneId.of(standort.zeitzone()));
            if (!tag.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !tag.isAfter(z.gueltigBis()))) {
                return tag;
            }
        }
        return LocalDate.ofInstant(jetzt, ZoneOffset.UTC);
    }

    private static String kw(BigDecimal wert) {
        return wert.stripTrailingZeros().toPlainString().replace('.', ',');
    }

    /**
     * Der Schreibweg der RANGLISTE (P6) - Vorrang, Speicher-Frage und die zwei
     * P6-Zahlen in EINEM Vorgang, mit GENAU EINEM Push.
     *
     * <p>Er ist bewusst von {@link #save} getrennt: dort pflegt ein KUNDE
     * einzelne Felder seiner Anlage (die Anschlussgrenze, die Quellen-Wahl),
     * hier schreibt die Rangliste eine zusammenhaengende Reihenfolge zurueck.
     * Ein gemeinsamer Aufruf braeuchte fuer jedes Feld ein zweites Signal
     * „nicht anfassen" und waere an beiden Enden schwerer zu lesen.
     *
     * <p><b>⚠ PATCH-Semantik wie ueberall auf diesem Pfad:</b> {@code null}
     * heisst „dazu sagt die Rangliste nichts". Bei {@code chargePointRanks}
     * heisst eine LEERE Karte dagegen „keine Saeule hat mehr eine Position",
     * und dann darf auch {@code storageRank} auf {@code null} fallen - dort IST
     * die Abwesenheit die Aussage „es gibt kein Oben und Unten".
     */
    @Transactional
    public void saveRangliste(UUID siteId, List<String> priorities, String storagePriority,
            Map<String, Integer> chargePointRanks, Integer storageRank, String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        if (storagePriority != null) {
            if (!STORAGE.contains(storagePriority)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekannte Speicher-Priorität.");
            }
            configs.saveSourceChoice(tenantId, siteId, null, storagePriority, actor);
        }
        if (priorities != null) {
            configs.replacePriorities(tenantId, siteId, clean(siteId, priorities));
        }
        if (chargePointRanks != null) {
            configs.replaceChargePointRanks(tenantId, siteId, chargePointRanks);
            configs.saveStorageRank(tenantId, siteId, storageRank, actor);
        }
        push(tenantId, siteId, configs.forSite(siteId));
    }

    /**
     * Schickt die AKTUELL gespeicherte Konfiguration erneut hinaus - der Weg,
     * den ein Nachbar-Feature nimmt, das im selben Dokument mitreist (P7: die
     * Fahrzeug-Profile). Es gibt bewusst nur EINEN Kanal zur Box, also auch nur
     * einen Weg, ihn zu benutzen.
     */
    public void pushFor(UUID tenantId, UUID siteId) {
        push(tenantId, siteId, configs.forSite(siteId));
    }

    void push(UUID tenantId, UUID siteId, ChargingConfigDto config) {
        pushResult(tenantId, siteId, config);
    }

    /** Repeated delivery after a box succession must retain a failed transport as pending. */
    public boolean republishForSite(UUID tenantId, UUID siteId) {
        return pushResult(tenantId, siteId, configs.forSite(siteId));
    }

    private boolean pushResult(UUID tenantId, UUID siteId, ChargingConfigDto config) {
        return push(tenantId, siteId, config,
                zielBoxen(configs.deviceIds(siteId), configs.deviceIdsWithChargePoints(siteId)));
    }

    private boolean push(UUID tenantId, UUID siteId, ChargingConfigDto config,
            List<UUID> deviceIds) {
        ChargingConfigPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            log.debug("no charging-config publisher configured - nothing pushed for site {}",
                    siteId);
            return false;
        }
        if (deviceIds.isEmpty()) {
            log.warn("charging config for site {} not pushed: no unambiguous station box",
                    siteId);
            return false;
        }
        Instant now = Instant.now();
        // ⚠ Die FAHRZEUG-PROFILE (P7) werden hier GELESEN, nicht durchgereicht:
        // sie leben in ihrer eigenen Tabelle, weil eine Ladekarte ein anderer
        // Gegenstand ist als eine Anschlussgrenze - aber sie reisen im SELBEN
        // retained Dokument, weil die Box nur eines hat. Die Liste ist die
        // GANZE Aussage und geht deshalb auch LEER hinaus: nur so kommt eine
        // Rücknahme bei einer Box an, die gerade offline war.
        List<VehicleProfileDto> vehicles = vehicleProfiles(siteId);
        String control = configs.ocppControl(siteId);
        boolean delivered = true;
        for (UUID deviceId : deviceIds) {
            if (control != null) {
                delivered &= pub.publish(tenantId, siteId, deviceId, config.gridLimitKw(), config.priorityChargePointIds(),
                        config.surplusPolicy(), config.storagePriority(), config.chargePoints(), config.removedChargePointIds(),
                        config.frame(), config.storageRank(), config.wallboxes(), vehicles, control, now);
                continue;
            }
            delivered &= pub.publish(tenantId, siteId, deviceId, config.gridLimitKw(),
                    config.priorityChargePointIds(), config.surplusPolicy(),
                    config.storagePriority(), config.chargePoints(),
                    config.removedChargePointIds(), config.frame(), config.storageRank(),
                    config.wallboxes(), vehicles, now);
        }
        return delivered;
    }

    /**
     * Genau eine Box fuehrt den Ladepark. Solange noch keine Station gemeldet
     * ist, bleibt ausschliesslich die bestehende Ein-Box-Anlage auf ihrem
     * bisherigen Empfaenger; bei mehreren Boxen wird nie geraten.
     */
    static List<UUID> zielBoxen(List<UUID> aktiveBoxen, List<UUID> boxenMitLadepunkten) {
        if (boxenMitLadepunkten.size() == 1) {
            return List.of(boxenMitLadepunkten.get(0));
        }
        if (boxenMitLadepunkten.isEmpty() && aktiveBoxen.size() == 1) {
            return List.of(aktiveBoxen.get(0));
        }
        return List.of();
    }

    private UUID zielBoxFuerAnbinden(UUID siteId, UUID gewaehlt) {
        List<UUID> aktive = configs.deviceIds(siteId);
        List<UUID> belegt = configs.deviceIdsWithChargePoints(siteId);
        if (belegt.size() > 1) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Ladepunkte dieser Anlage sind bereits auf mehrere Boxen verteilt. "
                            + "VoltPilot sendet keine weitere Ladepark-Konfiguration, bis die "
                            + "Zuständigkeit geklärt ist.");
        }
        UUID vorhanden = belegt.isEmpty() ? null : belegt.get(0);
        UUID ziel = gewaehlt != null ? gewaehlt
                : vorhanden != null ? vorhanden
                : aktive.size() == 1 ? aktive.get(0) : null;
        if (ziel == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Wählen Sie die Box, mit der sich die Ladesäule verbinden soll.");
        }
        if (!aktive.contains(ziel)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die gewählte Box gehört nicht zu dieser Anlage oder ist nicht mehr eingebaut.");
        }
        if (vorhanden != null && !vorhanden.equals(ziel)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Ladepunkte dieser Anlage sind bereits an eine andere Box angebunden. "
                            + "Eine zweite Box für Ladepunkte ist erst mit der gemeinsamen "
                            + "Steuerung verfügbar.");
        }
        return ziel;
    }

    /**
     * Die Fahrzeug-Profile dieser Anlage in Draht-Form (P7).
     *
     * <p>⚠ Sie ist NIE {@code null}: das Portal besitzt die Menge allein, also
     * ist „keine Profile" eine Aussage und muss die Box erreichen. Nur ein
     * Deployment ohne die P7-Bohne (ein älterer Stand) sagt gar nichts.
     */
    private List<VehicleProfileDto> vehicleProfiles(UUID siteId) {
        SiteVehicleRepository repo = vehicles.getIfAvailable();
        if (repo == null) {
            return null;
        }
        List<VehicleProfileDto> out = new ArrayList<>();
        for (SiteVehicleRepository.Row r : repo.profilesForSite(siteId)) {
            out.add(new VehicleProfileDto(r.tagRef(), r.name(), r.source(),
                    r.minKw() == null ? null : r.minKw().doubleValue()));
        }
        return out;
    }

    /**
     * Trägt EINE Ladesäule in die Allowlist ein - der erste Schritt des
     * Anbinde-Assistenten.
     *
     * <p><b>⚠ Diese Route fügt nur HINZU.</b> Die Box übernimmt jeden Eintrag,
     * den sie noch nicht kennt, und überschreibt keinen bestehenden. Eine
     * Kennung zurückzunehmen ist eine eigene, AUSDRÜCKLICHE Handlung
     * ({@link #remove}) - ein Weglassen ist kein Löschen.
     *
     * <p><b>Die Allowlist bleibt die Allowlist</b>: eine unbekannte Kennung
     * wird von der Box weiterhin abgewiesen und protokolliert. Es wandert nur
     * ihr Pflege-Ort ins Portal, es entsteht kein Anlern-Fenster.
     *
     * <p>Ein erneutes Eintragen einer zurückgenommenen Kennung BELEBT sie
     * wieder - sie verschwindet aus der Grabstein-Liste und steht wieder in
     * {@code charge_points}.
     */
    /**
     * Das Anschluss-Vokabular des Kontrakts, hier ein zweites Mal festgenagelt
     * (die Box führt dieselben zwei Wörter): ein Wort, das wir nicht verstehen,
     * darf kein gespeicherter Zustand werden.
     */
    private static final java.util.Set<String> CONNECTIONS = java.util.Set.of("haus", "eigen");

    @Transactional
    public ChargingConfigDto admit(UUID siteId, String chargePointId, String label,
            Double ratedKw, Integer connectors, String source, Double minKw, String connection,
            UUID deviceId, String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        UUID zielBox = zielBoxFuerAnbinden(siteId, deviceId);
        String id = chargePointId == null ? "" : chargePointId.trim();
        // ⚠ Das Zeichen-Vokabular ist das des KONTRAKTS (und damit das der Box):
        // eine Kennung, die kein MQTT-Topic-Segment sein kann, erreichte die
        // Säule nie - und die Ablehnung nennt den erlaubten Satz, weil
        // „ungültig" auf einer Kundenfläche keine Antwort ist.
        if (!CHARGE_POINT_ID.matcher(id).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Ladepunkt-Kennung darf nur Buchstaben, Ziffern, Punkt, Bindestrich "
                            + "und Unterstrich enthalten (höchstens 64 Zeichen) - tragen Sie sie "
                            + "zeichengleich so ein, wie sie in der Säule steht.");
        }
        if (ratedKw != null && (ratedKw.isNaN() || ratedKw < 0 || ratedKw > MAX_RATED_KW)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Nennleistung je Stecker muss zwischen 0 und " + (long) MAX_RATED_KW
                            + " kW liegen.");
        }
        if (connectors != null && (connectors < 0 || connectors > MAX_CONNECTORS)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Eine Säule hat höchstens " + MAX_CONNECTORS + " Stecker.");
        }
        // ⚠ Der Deckel ist eine ABLEHNUNG, nie eine stille Kappung: der Kontrakt
        // trägt höchstens so viele Zeilen, und was hier still wegfiele, käme bei
        // der Box nie an, während das Portal es anzeigte.
        List<ChargingConfigDto.AllowedChargePointDto> existing = configs.allowlist(siteId);
        boolean known = existing.stream().anyMatch(c -> c.chargePointId().equals(id));
        if (!known && existing.size() >= MAX_CHARGE_POINTS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Anlage führt bereits " + MAX_CHARGE_POINTS + " Ladesäulen - mehr "
                            + "trägt das Konfigurations-Dokument nicht.");
        }
        // ⚠ Ein Wort ausserhalb des Vokabulars ist eine BENANNTE Ablehnung, nie
        // ein stiller Rückfall auf "haus": "haus" heisst "ihre Leistung wird in
        // der Bilanz der Box zurückaddiert", und ist die Wahrheit "eigen",
        // fiele das Budget zu gross aus - der Hausanschluss könnte um genau
        // ihre Leistung überschritten werden. null bleibt zulässig ("dazu wird
        // nichts gesagt", die PATCH-Semantik des Dokuments).
        String conn = connection == null || connection.isBlank() ? null : connection.trim();
        if (conn != null && !CONNECTIONS.contains(conn)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannter Anschluss \"" + conn + "\" - erlaubt sind \"haus\" (hinter dem "
                            + "Hausanschluss) und \"eigen\" (eigener Netzanschluss).");
        }
        String src = pruefeQuelle(source);
        pruefeMindestleistung(minKw);
        String name = label == null || label.isBlank() ? null : label.trim();
        configs.admitChargePoint(tenantId, siteId, id, name, ratedKw, connectors, src, minKw, conn,
                actor);
        ChargingConfigDto saved = configs.forSite(siteId);
        // Vor der ersten Meldung gibt es noch keinen device_charge_point-Beleg.
        // Genau dieser explizite Assistenten-Schritt darf deshalb an die
        // gewaehlte Box zustellen; alle spaeteren Pushes lesen den physischen
        // Beleg und raten bei mehreren Boxen nie.
        push(tenantId, siteId, saved, List.of(zielBox));
        return saved;
    }

    /**
     * Nimmt EINE Ladesäule aus der Allowlist (Captain-Order 24.08.2026:
     * „Ebenso will ich die möglichkeit haben eingebene kennungen zu löschen").
     *
     * <p><b>⚠ Die Rücknahme ist ein GRABSTEIN, kein Löschen.</b> Das retained
     * Dokument wird als Ganzes ersetzt, also würde eine Kennung nur wegzulassen
     * von einer Box, die gerade offline war, nie gesehen ({@code charge_points}
     * fügt nur hinzu). Sie wird deshalb dauerhaft geführt und in JEDEM folgenden
     * Dokument genannt, bis sie wieder eingetragen wird.
     *
     * <p><b>Die Folge am Gerät</b>, und sie steht wörtlich so im
     * Rückfrage-Dialog beider Flächen: die Säule wird getrennt und ein
     * Wiederverbinden abgewiesen. Ihr zuletzt hinterlegtes Sicherheitsprofil
     * behält sie - es liegt IN der Säule -, ein laufender Ladevorgang endet
     * dadurch also nicht, er fällt auf dieses Profil zurück.
     *
     * <p>Eine Kennung, die diese Anlage nicht (mehr) führt, ist ein 404 - nie
     * ein stiller Erfolg über etwas, das es nicht gab.
     */
    @Transactional
    public ChargingConfigDto remove(UUID siteId, String chargePointId, String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        String id = chargePointId == null ? "" : chargePointId.trim();
        if (!configs.removeChargePoint(siteId, id, actor)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Diese Anlage führt keine eingetragene Ladepunkt-Kennung \"" + id + "\".");
        }
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    /**
     * Die Vorrang-Liste, gesäubert: Leerzeichen weg, Duplikate weg,
     * Reihenfolge stabil. Eine unbekannte ChargePointId wird ABGELEHNT statt
     * still gespeichert - sie wäre ein Vorrang für eine Säule, die es nicht
     * gibt, und niemand fände den Tippfehler je wieder.
     */
    private List<String> clean(UUID siteId, List<String> raw) {
        Set<String> known = new LinkedHashSet<>();
        for (var c : chargers.forSite(siteId).chargers()) {
            known.add(c.chargePointId());
        }
        List<String> out = new ArrayList<>();
        for (String id : raw) {
            String v = id == null ? "" : id.trim();
            if (v.isEmpty() || out.contains(v)) {
                continue;
            }
            if (!known.contains(v)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Diese Anlage kennt keine Ladesäule \"" + v + "\". Vorrang lässt sich "
                                + "nur für eine Säule vergeben, die sich schon gemeldet hat.");
            }
            out.add(v);
        }
        return out;
    }

    /**
     * Setzt die STEUERART einer eingetragenen Säule (P5, Steuerart je
     * Ladepunkt).
     *
     * <p><b>⚠ Sie ändert KEINE Grenze.</b> Die Quelle sagt, WOHER der Ladestrom
     * dieser Säule kommen soll; die physische Bahn (Anschlussgrenze,
     * Sicherheitsabstand, §14a) bindet sie unverändert - die zwei komponieren
     * most-restrictive-wins, und keine kann die andere aufweichen.
     *
     * <p><b>⚠ Der ANLAGEN-STANDARD bleibt daneben stehen</b>
     * ({@code surplus_policy}): eine Säule OHNE eigene Wahl folgt ihm weiter.
     * Beides zu verschmelzen hiesse, eine Wahl für alle zu treffen.
     *
     * <p>Eine Kennung, die diese Anlage nicht (mehr) führt, ist ein 404 - das
     * Eintragen ist eine eigene, bewusste Handlung ({@link #admit}), keine
     * Nebenwirkung des Steuerart-Dialogs.
     */
    @Transactional
    public ChargingConfigDto setChargePointSource(UUID siteId, String chargePointId, String source,
            Double minKw) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        String id = chargePointId == null ? "" : chargePointId.trim();
        String src = pruefeQuelle(source);
        pruefeMindestleistung(minKw);
        if (src == null && minKw == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Es wurde weder eine Quelle noch eine Mindestleistung angegeben.");
        }
        if (!configs.saveChargePointSource(siteId, id, src, minKw)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Diese Anlage führt keine eingetragene Ladepunkt-Kennung \"" + id + "\".");
        }
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    /**
     * Setzt den Ladepark-RAHMEN (P5/E10).
     *
     * <p><b>⚠ Der Rahmen ist ADMIN-Ware, und das ist eine Entscheidung mit
     * Begründung</b> (Konzept E10): Sicherheitsabstand, Mindestleistung und die
     * höchste bekannte Gebäudelast sind Auslegungs-Zahlen des Anschlusses, die
     * VoltPilot beim Einrichten misst - der Kunde LIEST sie (bis P5 konnte er
     * das nicht einmal), geschrieben werden sie von uns. Die EINE Zahl, die ihm
     * gehört, bleibt die Anschlussgrenze ({@link #save}).
     *
     * <p>Die Plausibilität prüft am Ende die BOX ({@code lastmgmt.Settings.Apply}) -
     * sie kennt ihre Säulen, ihre Stecker und ihre gemessene Gebäudelast. Hier
     * stehen nur die Grenzen, die einen Tippfehler abfangen.
     */
    @Transactional
    public ChargingConfigDto saveFrame(UUID siteId, ChargingConfigDto.LadeparkRahmenDto frame,
            String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        if (frame == null || frame.leer()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Es wurde kein einziger Rahmen-Wert angegeben.");
        }
        pruefeSpanne("Die Hausreserve", frame.houseReserveKw(), 0, MAX_GRID_LIMIT_KW);
        pruefeSpanne("Der Sicherheitsabstand", frame.marginPct(), 0, 50);
        pruefeSpanne("Die Mindestleistung", frame.minPowerKw(), 0, MAX_RATED_KW);
        pruefeSpanne("Die höchste Gebäudelast", frame.maxHouseLoadKw(), 0, MAX_GRID_LIMIT_KW);
        if (frame.rotationMinutes() != null
                && (frame.rotationMinutes() < 1 || frame.rotationMinutes() > 240)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Wechsel-Takt muss zwischen 1 und 240 Minuten liegen.");
        }
        configs.saveFrame(tenantId, siteId, frame, actor);
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    /**
     * Das Quellen-Wort einer SÄULE. null bleibt null („dazu sagt das Portal
     * nichts"), ein unbekanntes Wort ist eine BENANNTE Ablehnung - nie ein
     * stiller Rückfall auf „schnell": das wäre eine Netzstrom-Freigabe, die der
     * Kunde nie erteilt hat.
     */
    private String pruefeQuelle(String source) {
        if (source == null || source.isBlank()) {
            return null;
        }
        String v = source.trim();
        if (!POLICIES.contains(v)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Quelle \"" + v + "\". Möglich sind „Nur Sonnenstrom\", "
                            + "„Sonne zuerst\" und „Schnell laden\".");
        }
        return v;
    }

    private void pruefeMindestleistung(Double minKw) {
        pruefeSpanne("Die Mindestleistung", minKw, 0, MAX_RATED_KW);
    }

    private void pruefeSpanne(String was, Double v, double min, double max) {
        if (v == null) {
            return;
        }
        if (v.isNaN() || v < min || v > max) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    was + " muss zwischen " + (long) min + " und " + (long) max + " liegen.");
        }
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }
}
