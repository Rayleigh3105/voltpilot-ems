package com.voltpilot.api.repo;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Schalter "automatisch wählen" JE ANLAGE ({@code site_forecast_automatik},
 * Migration V20261111180000, S5) - nur für den Verbrauch (Bericht R.4: die
 * Automatik gilt ausdrücklich dem Lastmodell, nicht der PV-Korrektur).
 *
 * <p>Ohne eine Zeile gilt die Automatik AN (E6 = B, der Vorgabewert) - eine
 * Anlage, die nie etwas gewählt hat, soll das bessere Modell von selbst
 * bekommen. Wählt der Kunde von Hand, schreibt
 * {@code SiteForecastModelController} hier {@code false}; erst ein
 * ausdrückliches "Automatik wieder einschalten" setzt sie zurück auf
 * {@code true}.
 */
@Repository
public class SiteForecastAutomatikRepository {

    private final JdbcTemplate jdbc;

    public SiteForecastAutomatikRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** {@code true}, wenn die Automatik für diese Anlage wählen darf (Vorgabe: an). */
    public boolean aktiv(UUID siteId) {
        return jdbc.query(
                "SELECT aktiv FROM site_forecast_automatik WHERE site_id = ?",
                rs -> rs.next() ? rs.getBoolean("aktiv") : true,
                siteId);
    }

    /** Setzt den Schalter - der Urheber ist das JWT-Subject wie im Journal. */
    public void setzen(UUID siteId, boolean aktiv, String setBy) {
        jdbc.update(
                "INSERT INTO site_forecast_automatik (site_id, tenant_id, aktiv, updated_at, updated_by) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, now(), ?) "
                        + "ON CONFLICT (site_id) DO UPDATE SET "
                        + "aktiv = EXCLUDED.aktiv, updated_at = now(), updated_by = EXCLUDED.updated_by",
                siteId, aktiv, setBy);
    }
}
