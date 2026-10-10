package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Empfang des Anteils-Verlusts aus dem Herzschlag-Block {@code gemeinsame_steuerung} (UEMS AP-15 IP-22, E1 = A, R2;
 * Vertrag {@code mqtt-plan-result.md} „Spiegel im Herzschlag“, Feld {@code anteil_verlust}). Die Box meldet den
 * laufenden Tag und den abgeschlossenen Vortag, NUR mit Anteils-Dokument; ohne das Feld geschieht hier nichts, und es
 * entsteht keine Zeile. Gefüttert vom {@link DataSourceStatusListener} nach der Topic-, Payload- und Standort-Prüfung,
 * unter dem {@code TenantContext} des Topics.
 *
 * <p>{@code kwh} ist eine UNTERGRENZE (die Box kennt die verfügbare Erzeugung einer abgeregelten PV nur aus gemessenen
 * Werten), {@code gebunden_s} ist exakt. Ein Tag außerhalb von gestern bis morgen (Uhr der Box falsch), eine negative
 * oder unlesbare Zahl: dieser Tag wird überlesen — unbekannt ist keine Null.
 */
@Component
public class AnteilVerlustAusHerzschlag {

    /** Der Tag der Anlage, wie ihn die Box zählt. */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /** Mehr Sekunden hat kein Tag (25-Stunden-Tag der Zeitumstellung). */
    static final int HOECHSTENS_S = 90_000;

    private final AnteilVerlustRepository repo;
    private Clock uhr = Clock.systemUTC();

    public AnteilVerlustAusHerzschlag(AnteilVerlustRepository repo) {
        this.repo = repo;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    /** Übernimmt {@code anteil_verlust} aus dem Block eines gültigen Herzschlags der Box. */
    public void merke(UUID tenantId, UUID siteId, UUID deviceId, JsonNode block) {
        JsonNode v = block == null ? null : block.get("anteil_verlust");
        if (tenantId == null || siteId == null || deviceId == null || v == null || !v.isObject()) {
            return;
        }
        tag(tenantId, siteId, deviceId, v);
        JsonNode vortag = v.get("vortag");
        if (vortag != null && vortag.isObject()) {
            tag(tenantId, siteId, deviceId, vortag);
        }
    }

    private void tag(UUID tenantId, UUID siteId, UUID deviceId, JsonNode n) {
        LocalDate tag;
        try {
            tag = LocalDate.parse(n.path("tag").asText(""));
        } catch (DateTimeParseException e) {
            return;
        }
        LocalDate heute = LocalDate.now(uhr.withZone(ZONE));
        if (tag.isBefore(heute.minusDays(1)) || tag.isAfter(heute.plusDays(1))) {
            return;
        }
        JsonNode kwh = n.get("kwh");
        JsonNode s = n.get("gebunden_s");
        if (kwh == null || !kwh.isNumber() || s == null || !s.canConvertToInt() || !s.isIntegralNumber()) {
            return;
        }
        BigDecimal k = kwh.decimalValue();
        int sek = s.intValue();
        if (k.signum() < 0 || sek < 0 || sek > HOECHSTENS_S) {
            return;
        }
        repo.melde(tenantId, siteId, deviceId, tag, k, sek);
    }
}
