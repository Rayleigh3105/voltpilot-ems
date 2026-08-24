package com.voltpilot.api.chargers;

import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
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

    private final SiteRepository sites;
    private final ChargingConfigRepository configs;
    private final DeviceChargerStatusRepository chargers;
    private final ObjectProvider<ChargingConfigPublisher> publisher;

    public ChargingConfigService(SiteRepository sites, ChargingConfigRepository configs,
            DeviceChargerStatusRepository chargers,
            ObjectProvider<ChargingConfigPublisher> publisher) {
        this.sites = sites;
        this.configs = configs;
        this.chargers = chargers;
        this.publisher = publisher;
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
     * Schickt die gespeicherte Konfiguration an jedes Gerät der Anlage.
     *
     * <p>An JEDES, nicht nur an das mit den Ladesäulen: welches Gerät das CSMS
     * fährt, weiß nur die Box selbst, und eine Box ohne Ladepunkte übernimmt
     * eine Anschlussgrenze folgenlos (ihr Budget verteilt sie an niemanden).
     * Raten wäre die schlechtere Hälfte.
     */
    void push(UUID tenantId, UUID siteId, ChargingConfigDto config) {
        ChargingConfigPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            log.debug("no charging-config publisher configured - nothing pushed for site {}",
                    siteId);
            return;
        }
        Instant now = Instant.now();
        for (UUID deviceId : configs.deviceIds(siteId)) {
            pub.publish(tenantId, siteId, deviceId, config.gridLimitKw(),
                    config.priorityChargePointIds(), config.surplusPolicy(),
                    config.storagePriority(), config.chargePoints(),
                    config.removedChargePointIds(), now);
        }
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
    @Transactional
    public ChargingConfigDto admit(UUID siteId, String chargePointId, String label,
            Double ratedKw, Integer connectors, String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
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
        String name = label == null || label.isBlank() ? null : label.trim();
        configs.admitChargePoint(tenantId, siteId, id, name, ratedKw, connectors, actor);
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
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

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }
}
