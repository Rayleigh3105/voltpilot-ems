package com.voltpilot.api.components;

import com.voltpilot.api.tenant.TenantContext;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Dokumentierte Kartenfakten. Wandler/Skalierung nutzt weiter QuelleEinstellungService. */
@Service
public class WagoMetadataService {
    public record Karte(Integer slot, Boolean anwenderskalierung, Integer register35, int version) {}
    public record KartenEintrag(@NotNull @Positive Integer expectedRevision,
            Boolean anwenderskalierung, @Min(0) @Max(65535) Integer register35) {}
    public record Geraet(String seriennummer, String firmware, String anwendung) {}
    public record GeraetEintrag(@Size(max = 200) String seriennummer,
            @Size(max = 200) String firmware, @Size(max = 200) String anwendung) {}
    private final JdbcTemplate jdbc;
    private final ComponentDefinitionRepository definitions;
    private final ComponentActivationOutboxService activation;

    public WagoMetadataService(JdbcTemplate jdbc, ComponentDefinitionRepository definitions,
            ComponentActivationOutboxService activation) {
        this.jdbc = jdbc;
        this.definitions = definitions;
        this.activation = activation;
    }

    public Karte karte(UUID site, UUID entity) {
        return jdbc.query("SELECT m.slot, m.wago_anwenderskalierung, m.wago_register_35, "
                + "m.definition_version FROM measurement_point m JOIN site s ON s.id=m.site_id "
                + "WHERE m.site_id=? AND m.id=? AND lower(m.brand)='wago'",
                (rs, n) -> new Karte((Integer) rs.getObject(1), (Boolean) rs.getObject(2),
                        (Integer) rs.getObject(3), rs.getInt(4)), site, entity).stream()
                .findFirst().orElseThrow(WagoMetadataService::nichtGefunden);
    }

    @Transactional
    public Karte eintragen(UUID site, UUID entity, KartenEintrag in, String actor) {
        karte(site, entity); // Sichtbarkeit vor fachlichen Fehlern, fremde Anlage = 404.
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(site))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Komponenten dieser Anlage werden noch auf der Box verwaltet.");
        }
        // E4: Der Steckplatz kommt aus der ausdrücklichen Geräte-/Kartenzuordnung.
        // Eine Modbus-Adresse oder gleiche Verbindung erzeugt keine physische Identität.
        List<Integer> slots = jdbc.query("SELECT t.steckplatz FROM geraet_komponente k "
                + "JOIN geraet_teil t ON t.id=k.teil_id AND t.tenant_id=k.tenant_id "
                + "JOIN measurement_point m ON m.id=k.entity_id JOIN site s ON s.id=m.site_id "
                + "WHERE m.id=? AND m.site_id=? AND k.gueltig_ab<=now() "
                + "AND (k.gueltig_bis IS NULL OR k.gueltig_bis>now()) FOR UPDATE OF m, k, t",
                (rs, n) -> (Integer) rs.getObject(1), entity, site);
        if (slots.size() != 1 || slots.getFirst() == null
                || slots.getFirst() < 1 || slots.getFirst() > 65535) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Zuerst die Energiekarte mit ihrem Steckplatz zuordnen.");
        }
        int changed = jdbc.update("UPDATE measurement_point SET slot=?, wago_anwenderskalierung=?, "
                + "wago_register_35=?, definition_version=definition_version+1 "
                + "WHERE id=? AND site_id=? AND definition_version=?", slots.getFirst(),
                in.anwenderskalierung(), in.register35(), entity, site, in.expectedRevision());
        if (changed != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Komponente hat inzwischen eine andere Fassung.");
        }
        definitions.recordStoredVersion(TenantContext.get(), site, entity, in.expectedRevision() + 1,
                actor, "WAGO-Kartenangaben dokumentiert");
        // Die vorhandene Revision bleibt mit der Registry synchron. Keine neuen
        // Kartenfelder gehen an die Box; die Verbindung bleibt unverändert.
        activation.enqueue(TenantContext.get(), site, entity, in.expectedRevision() + 1, "component_edit");
        return karte(site, entity);
    }

    public Geraet geraet(UUID id) {
        return jdbc.query("SELECT g.seriennummer, g.firmware, g.anwendung FROM geraet g "
                + "JOIN site s ON s.id=g.site_id WHERE g.id=? AND lower(g.hersteller)='wago'",
                (rs, n) -> new Geraet(rs.getString(1), rs.getString(2), rs.getString(3)), id)
                .stream().findFirst().orElseThrow(WagoMetadataService::nichtGefunden);
    }

    @Transactional
    public Geraet eintragen(UUID id, GeraetEintrag in) {
        geraet(id);
        jdbc.update("UPDATE geraet SET seriennummer=?, firmware=?, anwendung=? WHERE id=?",
                text(in.seriennummer()), text(in.firmware()), text(in.anwendung()), id);
        return geraet(id);
    }

    private static String text(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
    private static ResponseStatusException nichtGefunden() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "WAGO-Gerät oder Komponente nicht gefunden.");
    }
}
