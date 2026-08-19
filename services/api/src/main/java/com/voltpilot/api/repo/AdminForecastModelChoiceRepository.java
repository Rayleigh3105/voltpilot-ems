package com.voltpilot.api.repo;

import com.voltpilot.api.forecast.ModelChoice;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto.ChoiceEventDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der SCHREIBPFAD auf die Wahl des aktiven Prognosemodells plus die Historie -
 * an der dedizierten BYPASSRLS-Rolle {@code voltpilot_admin}, erreichbar
 * ausschließlich aus einem {@code @PreAuthorize("hasRole('platform-admin')")}
 * -Endpunkt (die {@code /admin/fleet}-Disziplin; die App-Rolle hat hier nur
 * SELECT).
 *
 * <p>Die Tabelle ist APPEND-ONLY und damit selbst das Audit-Journal: jede
 * Umstellung ist eine Zeile mit von-&gt;zu, Urheber und Zeitpunkt, und „was
 * gilt gerade" ist die jüngste je Art. Es gibt hier deshalb kein UPDATE und
 * kein DELETE - ein nachträglich änderbares Journal wäre keins.
 */
@Repository
public class AdminForecastModelChoiceRepository {

    private final JdbcTemplate jdbc;

    public AdminForecastModelChoiceRepository(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Die aktuelle Wahl je Art, samt Urheber - dieselbe Abfrage wie der Kundenpfad. */
    public Map<String, ModelChoice> current() {
        Map<String, ModelChoice> out = new HashMap<>();
        jdbc.query(ForecastModelChoiceRepository.CURRENT_SQL, rs -> {
            out.put(
                    rs.getString("model_kind"),
                    new ModelChoice(
                            rs.getString("model_kind"),
                            rs.getString("model_id"),
                            rs.getString("previous_model_id"),
                            rs.getString("set_by"),
                            rs.getString("set_by_name"),
                            toInstant(rs.getTimestamp("set_at"))));
        });
        return out;
    }

    /** Die Umstellungs-Historie, NEUESTE zuerst. */
    public List<ChoiceEventDto> history(int limit) {
        return jdbc.query(
                "SELECT model_kind, model_id, previous_model_id, set_by_name, set_at "
                        + "FROM forecast_model_choice ORDER BY id DESC LIMIT ?",
                (rs, i) -> new ChoiceEventDto(
                        rs.getString("model_kind"),
                        rs.getString("model_id"),
                        rs.getString("previous_model_id"),
                        rs.getString("set_by_name"),
                        toInstant(rs.getTimestamp("set_at"))),
                limit);
    }

    /** Schreibt EINE Umstellung fort (die Zeile IST das Audit-Ereignis). */
    public void promote(
            String kind, String model, String previous, String setBy, String setByName) {
        jdbc.update(
                "INSERT INTO forecast_model_choice "
                        + "(model_kind, model_id, previous_model_id, set_by, set_by_name) "
                        + "VALUES (?, ?, ?, ?, ?)",
                kind, model, previous, setBy, setByName);
    }

    private static Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
