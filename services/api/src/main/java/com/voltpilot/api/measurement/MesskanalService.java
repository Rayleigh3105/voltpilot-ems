package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog.Semantik;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Messkanal-Read-Model je Komponente (UEMS AP-04 IP-9): jede Zeile der Mess-Selektion der
 * Komponente mit den Fakten, die eine Quellenbindung braucht — aus dem Katalog Anzeigename,
 * Einheit, Wertart, Größe und Richtung ({@link MesskanalAbbildung}), aus der Selektion Kadenz,
 * Zustand und lesende Box.
 *
 * <p>Der Mandant ist die RLS: die App-Rolle sieht nur die eigenen Standorte, Komponenten und
 * Selektionen, eine fremde Komponente ist 404, nie 403 — und eine Komponente eines ANDEREN
 * eigenen Standorts unter diesem Standort ebenso. Die Selektion wird bewusst nur über
 * {@code entity_id} gelesen: sie ist an (Komponente, Mandant) gebunden, nicht an den Standort
 * (V20260855000000 — eine Komponente behält ihre Kanäle über einen Umzug).
 */
@Service
public class MesskanalService {

    private final JdbcTemplate jdbc;
    private final SiteRepository sites;
    private final MeasurementCatalog catalog;
    private final ObjectMapper json;

    public MesskanalService(JdbcTemplate jdbc, SiteRepository sites, MeasurementCatalog catalog,
            ObjectMapper json) {
        this.jdbc = jdbc;
        this.sites = sites;
        this.catalog = catalog;
        this.json = json;
    }

    private record Zeile(UUID deviceId, String pointKey, boolean enabled, Integer cadenceS,
            String customDefinition) {}

    public MesskanalDto.Liste messkanaele(UUID siteId, UUID komponente) {
        List<UUID> standort = jdbc.query("SELECT site_id FROM measurement_point WHERE id = ?",
                (rs, n) -> rs.getObject(1, UUID.class), komponente);
        if (!sites.existsForCurrentTenant(siteId) || standort.isEmpty() || !siteId.equals(standort.get(0))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        List<Zeile> zeilen = jdbc.query("""
                SELECT device_id, point_key, enabled, cadence_s, custom_definition::text AS custom
                  FROM device_measurement_selection
                 WHERE entity_id = ?
                 ORDER BY point_key, device_id
                """, (rs, n) -> new Zeile(rs.getObject("device_id", UUID.class),
                        rs.getString("point_key"), rs.getBoolean("enabled"),
                        (Integer) rs.getObject("cadence_s"), rs.getString("custom")), komponente);
        return new MesskanalDto.Liste(siteId, komponente, catalog.inhaltsstand(),
                zeilen.stream().map(this::kanal).toList());
    }

    private MesskanalDto.Messkanal kanal(Zeile z) {
        if (z.customDefinition() != null) {
            // Selbstbau: Name und Einheit aus der eigenen Definition; eine Wertart, Größe oder
            // Richtung trägt sie (noch) nicht — also keine.
            JsonNode d = lesen(z.customDefinition());
            return new MesskanalDto.Messkanal(z.pointKey(), text(d, "label"), text(d, "unit"),
                    null, null, null, null, null, z.cadenceS(), z.enabled(), z.deviceId(), null, List.of());
        }
        MeasurementCatalog.Point p = catalog.resolve(z.pointKey());
        Semantik s = catalog.semantik(z.pointKey());
        String quantity = s == null ? null : s.quantity();
        String direction = s == null ? null : s.direction();
        String anzeigename = p == null ? null : p.labelDe() == null ? p.labelSource() : p.labelDe();
        return new MesskanalDto.Messkanal(z.pointKey(), anzeigename, p == null ? null : p.unit(),
                p == null ? null : MesskanalAbbildung.wertart(p.aggregationKind()),
                MesskanalAbbildung.groesse(quantity), MesskanalAbbildung.richtung(direction),
                quantity, direction, z.cadenceS(), z.enabled(), z.deviceId(), null, List.of());
    }

    private JsonNode lesen(String text) {
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n == null ? null : n.get(feld);
        return v == null || v.isNull() ? null : v.asText();
    }
}
