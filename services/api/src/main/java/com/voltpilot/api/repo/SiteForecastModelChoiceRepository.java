package com.voltpilot.api.repo;

import com.voltpilot.api.forecast.ModelChoice;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto.ChoiceEventDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Wahl des Prognosemodells JE ANLAGE ({@code site_forecast_model_choice},
 * Migration V20260826000000) - Lese- UND Schreibpfad, beide an der
 * mandantenbezogenen App-Rolle (dem {@code @Primary} {@code JdbcTemplate}).
 *
 * <p><b>Es gibt hier bewusst KEINEN BYPASSRLS-Zwilling</b> (anders als bei der
 * globalen Plattform-Vorgabe, siehe {@link AdminForecastModelChoiceRepository}):
 * die Zeile ist eine Entscheidung über EINE Kundenanlage, also sind es
 * Kundendaten, und Postgres-RLS ist der Zaun - ein Kunde erreicht ausschließlich
 * seine eigenen Anlagen, ein Portal-Admin jede über den
 * {@code X-Tenant-Id}-Umschalter auf demselben Pfad.
 *
 * <p>Die Tabelle ist APPEND-ONLY und damit selbst das Audit-Journal: jede
 * Umstellung ist eine Zeile mit von-&gt;zu, Urheber und Zeitpunkt, und „was gilt
 * gerade" ist die jüngste je (Anlage, Art). Es gibt deshalb kein UPDATE und kein
 * DELETE - die Migration nimmt der App-Rolle beides ausdrücklich weg.
 */
@Repository
public class SiteForecastModelChoiceRepository {

    /**
     * „Was gilt gerade für DIESE Anlage" - {@code DISTINCT ON} über die
     * append-only Historie, geordnet auf {@code id DESC}. Bewusst NICHT auf
     * {@code set_at}: zwei Umstellungen innerhalb derselben Mikrosekunde wären
     * dort ein Gleichstand, die Sequenz ist die Ordnung (wortgleich mit dem
     * Plattform-Pfad und mit {@code voltpilot_forecast.model_choice}).
     */
    private static final String CURRENT_SQL =
            "SELECT DISTINCT ON (model_kind) model_kind, model_id, previous_model_id, "
                    + "set_by, set_by_name, set_at "
                    + "FROM site_forecast_model_choice WHERE site_id = ? "
                    + "ORDER BY model_kind, id DESC";

    private final JdbcTemplate jdbc;

    public SiteForecastModelChoiceRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbcTemplate;
    }

    /**
     * Die aktuelle Wahl der Anlage je Art. Eine Art ohne Zeile FEHLT schlicht in
     * der Map - „nie umgestellt" ist kein Modell, sondern das Signal, auf die
     * Plattform-Vorgabe zurückzufallen.
     */
    public Map<String, ModelChoice> current(UUID siteId) {
        Map<String, ModelChoice> out = new HashMap<>();
        jdbc.query(CURRENT_SQL, rs -> {
            out.put(
                    rs.getString("model_kind"),
                    new ModelChoice(
                            rs.getString("model_kind"),
                            rs.getString("model_id"),
                            rs.getString("previous_model_id"),
                            rs.getString("set_by"),
                            rs.getString("set_by_name"),
                            toInstant(rs.getTimestamp("set_at"))));
        }, siteId);
        return out;
    }

    /** Die Umstellungs-Historie DIESER Anlage, NEUESTE zuerst. */
    public List<ChoiceEventDto> history(UUID siteId, int limit) {
        return jdbc.query(
                "SELECT model_kind, model_id, previous_model_id, set_by_name, set_at "
                        + "FROM site_forecast_model_choice WHERE site_id = ? "
                        + "ORDER BY id DESC LIMIT ?",
                (rs, i) -> new ChoiceEventDto(
                        rs.getString("model_kind"),
                        rs.getString("model_id"),
                        rs.getString("previous_model_id"),
                        rs.getString("set_by_name"),
                        toInstant(rs.getTimestamp("set_at"))),
                siteId, limit);
    }

    /**
     * Schreibt EINE Umstellung dieser Anlage fort (die Zeile IST das
     * Audit-Ereignis).
     *
     * <p>Der Mandant kommt aus der RLS-SITZUNG selbst
     * ({@code current_setting('app.tenant_id')}), nie aus dem Aufruf - das
     * {@code rule_event}-Muster: so kann kein Aufrufer eine Zeile in einen
     * fremden Mandanten schreiben, und die {@code WITH CHECK}-Policy bestätigt
     * es ein zweites Mal.
     */
    public void promote(
            UUID siteId, String kind, String model, String previous,
            String setBy, String setByName) {
        jdbc.update(
                "INSERT INTO site_forecast_model_choice "
                        + "(site_id, tenant_id, model_kind, model_id, previous_model_id, "
                        + "set_by, set_by_name) VALUES ("
                        + "?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                        + "?, ?, ?, ?, ?)",
                siteId, kind, model, previous, setBy, setByName);
    }

    private static Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
