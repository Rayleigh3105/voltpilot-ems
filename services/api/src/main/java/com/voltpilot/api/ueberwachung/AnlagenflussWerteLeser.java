package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.topology.TopologyDeriver.FlowNode;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.TopologyResponse;
import com.voltpilot.api.uems.ZustandAbleitung;
import com.voltpilot.api.web.dto.PricePointDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargeConnectorDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargePointDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der {@code anlagenfluss}-Leser (Alerting Scheibe 2, Konzept §6.3): liest die Live-Flüsse einer
 * Anlage GENAU SO, wie das Cockpit sie zeigt - über {@link TopologyService#topology(UUID)}, also
 * dieselben 30-Sekunden-Mittel aus derselben Rollen-Ableitung ({@link TopologyDeriver}), nie eine
 * eigene Rohwert-Abfrage (§6.1 Nr. 3). Netz/PV/Speicher/Verbrauch sind Knoten dieser Topologie;
 * Ladepunkte kommen separat aus {@link DeviceChargerStatusRepository} (eigener Endpunkt, kein
 * Topologie-Knoten, derselbe Zustands-/Summen-Zuschnitt wie {@code ladepunkte.ts}/{@code ladenKachel.ts}
 * im Portal); der Börsenpreis aus {@link PriceRepository} (öffentliche Marktdaten je Gebotszone).
 *
 * <p>UNBEKANNT IST KEINE NULL (§6.1 Nr. 4): ein Knoten ohne aktuellen Wert ({@code value_kw = null},
 * weil keine Probe innerhalb von {@link com.voltpilot.api.topology.TopologyRepository#LATEST_VALUE_LOOKBACK})
 * oder eine fehlende Rolle (kein Speicher an dieser Anlage) liefert {@link Lesung#unbekannt()}.
 */
@Component
public class AnlagenflussWerteLeser implements WerteLeser {

    static final String FELD_NETZ = "netz";
    static final String FELD_PV = "pv";
    static final String FELD_SPEICHER_LEISTUNG = "speicher_leistung";
    static final String FELD_SPEICHER_LADESTAND = "speicher_ladestand";
    static final String FELD_VERBRAUCH = "verbrauch";
    static final String FELD_LADEPUNKTE = "ladepunkte";
    static final String FELD_PREIS = "preis";

    /** Unterhalb dieser Schwelle gilt ein Stecker als nicht wirklich ladend (Zwilling von {@code ladepunkte.ts}). */
    private static final double LADE_SCHWELLE_KW = 0.05;

    private final TopologyService topologie;
    private final DeviceChargerStatusRepository ladepunkte;
    private final PriceRepository preise;
    private final JdbcTemplate jdbc;

    public AnlagenflussWerteLeser(TopologyService topologie, DeviceChargerStatusRepository ladepunkte,
            PriceRepository preise, JdbcTemplate jdbc) {
        this.topologie = topologie;
        this.ladepunkte = ladepunkte;
        this.preise = preise;
        this.jdbc = jdbc;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        UUID anlageId = bezug.id();
        String feld = eintrag.leser().feld();
        return switch (feld) {
            case FELD_NETZ -> vorzeichenKnoten(anlageId, TopologyDeriver.ROLE_GRID, "out", jetzt);
            case FELD_PV -> betragKnoten(anlageId, TopologyDeriver.ROLE_PV, jetzt);
            case FELD_SPEICHER_LEISTUNG -> vorzeichenKnoten(anlageId, TopologyDeriver.ROLE_STORAGE, "in", jetzt);
            case FELD_SPEICHER_LADESTAND -> ladestand(anlageId, jetzt);
            case FELD_VERBRAUCH -> betragKnoten(anlageId, TopologyDeriver.ROLE_CONSUMER, jetzt);
            case FELD_LADEPUNKTE -> ladepunkteSumme(anlageId, jetzt);
            case FELD_PREIS -> preisJetzt(anlageId, jetzt);
            default -> throw new IllegalArgumentException("AnlagenflussWerteLeser: unbekanntes Feld '" + feld + "'");
        };
    }

    private FlowNode knoten(UUID anlageId, String rolle) {
        TopologyResponse resp = topologie.topology(anlageId);
        if (resp == null || resp.topology() == null) {
            return null;
        }
        for (FlowNode n : resp.topology().nodes()) {
            if (rolle.equals(n.role())) {
                return n;
            }
        }
        return null;
    }

    /** PV, Verbrauch: Beträge, kein Vorzeichen (§2.2: "Live-kW je Rolle"). */
    private Lesung betragKnoten(UUID anlageId, String rolle, Instant jetzt) {
        FlowNode n = knoten(anlageId, rolle);
        if (n == null || n.valueKw() == null) {
            return Lesung.unbekannt();
        }
        return Lesung.zahl(n.valueKw(), "kW", jetzt);
    }

    /**
     * Netz (positiv = Bezug) und Speicher (positiv = Laden): der Knoten trägt den Betrag plus eine
     * {@code direction}; {@code richtungNegativ} ist die Richtung, die das Vorzeichen umdreht
     * ({@code "out"} = Einspeisung beim Netz, {@code "in"} = Entladen beim Speicher -
     * {@code TopologyDeriver.gridNode}/{@code storageNode}).
     */
    private Lesung vorzeichenKnoten(UUID anlageId, String rolle, String richtungNegativ, Instant jetzt) {
        FlowNode n = knoten(anlageId, rolle);
        if (n == null || n.valueKw() == null) {
            return Lesung.unbekannt();
        }
        double wert = richtungNegativ.equals(n.direction()) ? -n.valueKw() : n.valueKw();
        return Lesung.zahl(wert, "kW", jetzt);
    }

    private Lesung ladestand(UUID anlageId, Instant jetzt) {
        FlowNode n = knoten(anlageId, TopologyDeriver.ROLE_STORAGE);
        if (n == null || n.socPct() == null) {
            return Lesung.unbekannt();
        }
        return Lesung.zahl(n.socPct(), "%", jetzt);
    }

    /**
     * Summe der Ladepunkte-Leistung, die WIRKLICH lädt (Zwilling der Fallunterscheidung aus
     * {@code frontend/portal/src/ladepunkte.ts:zustandKind} und {@code ladenKachel.ts}): nur
     * Stecker im OCPP-Status {@code Charging} (oder ohne Status mit {@code charging = true}) mit
     * einem FRISCHEN Messwert (sonst "lädt ohne Messung" - zählt nicht) über der Lade-Schwelle.
     * Keine ladende Säule überhaupt ist 0,0 kW (bekannt), keine Box/kein Ladepunkt ist UNBEKANNT.
     */
    private Lesung ladepunkteSumme(UUID anlageId, Instant jetzt) {
        List<ChargePointDto> boxen = ladepunkte.forSite(anlageId).chargers();
        if (boxen == null || boxen.isEmpty()) {
            return Lesung.unbekannt();
        }
        double summe = 0;
        for (ChargePointDto box : boxen) {
            for (ChargeConnectorDto c : box.connectors()) {
                boolean laedtLautStatus = "Charging".equals(c.status()) || (c.status() == null && c.charging());
                if (!laedtLautStatus) {
                    continue;
                }
                Double leistung = frischeLeistung(c, jetzt);
                if (leistung != null && leistung > LADE_SCHWELLE_KW) {
                    summe += leistung;
                }
            }
        }
        return Lesung.zahl(summe, "kW", jetzt);
    }

    /** Veraltet (älter als das Online-Fenster) zählt wie gar kein Messwert ({@code ladepunkte.ts:messwertAlter}). */
    private static Double frischeLeistung(ChargeConnectorDto c, Instant jetzt) {
        if (c.powerKw() == null) {
            return null;
        }
        if (c.meteredAt() == null) {
            return c.powerKw(); // kein Stempel (älterer Box-Stand) - byte-gleich zum Vor-Phase-1-Verhalten
        }
        long alterS = jetzt.getEpochSecond() - c.meteredAt().getEpochSecond();
        return alterS <= ZustandAbleitung.TOLERANZ_MINDESTENS_S ? c.powerKw() : null;
    }

    /**
     * Der Börsenpreis des laufenden Marktfensters (ct/kWh), dieselbe Zahl wie der Preis-Streifen
     * im Cockpit ({@code strompreis.ts:strompreisView}): der Day-Ahead-Schlitz, in dem {@code jetzt}
     * liegt, {@code price_eur_mwh / 10}. Kein Fenster gefunden (Datenlücke, unbekannte Gebotszone) ist
     * UNBEKANNT.
     */
    private Lesung preisJetzt(UUID anlageId, Instant jetzt) {
        String zone = biddingZone(anlageId);
        if (zone == null) {
            return Lesung.unbekannt();
        }
        List<PricePointDto> punkte = preise.findForZone(zone, jetzt.minusSeconds(7200), jetzt.plusSeconds(7200), 20);
        for (PricePointDto p : punkte) {
            if (!jetzt.isBefore(p.ts()) && jetzt.isBefore(p.end())) {
                if (p.priceEurMwh() == null) {
                    return Lesung.unbekannt();
                }
                double ctKwh = p.priceEurMwh().doubleValue() / 10.0;
                return Lesung.zahl(ctKwh, "ct/kWh", p.ts());
            }
        }
        return Lesung.unbekannt();
    }

    private String biddingZone(UUID anlageId) {
        List<String> zonen = jdbc.query("SELECT bidding_zone FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), anlageId);
        return zonen.isEmpty() ? null : zonen.get(0);
    }
}
