package com.voltpilot.api.repo;

import java.util.HashMap;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der LESEPFAD auf die Wahl des aktiven Prognosemodells
 * ({@code forecast_model_choice}, Migration V20260825000000) - eine Zeile je
 * Prognoseart, die JÜNGSTE gewinnt.
 *
 * <p>Er hängt bewusst an der mandantenbezogenen App-Rolle (dem {@code @Primary}
 * {@code JdbcTemplate}), weil ihn die KUNDEN-Route {@code /forecast-quality}
 * braucht: sie muss sagen können, welches Modell gerade plant. Die Tabelle ist
 * global und trägt keine RLS, die App-Rolle hat dort ausschließlich SELECT
 * (die Migration nimmt ihr INSERT/UPDATE/DELETE ausdrücklich weg) - geschrieben
 * wird nur über {@link AdminForecastModelChoiceRepository} an der
 * BYPASSRLS-Rolle.
 */
@Repository
public class ForecastModelChoiceRepository {

    /**
     * Die EINE Abfrage „was gilt gerade" - {@code DISTINCT ON} über die
     * append-only Historie, geordnet auf {@code id DESC}. Bewusst NICHT auf
     * {@code set_at}: zwei Umstellungen innerhalb derselben Mikrosekunde wären
     * dort ein Gleichstand, die Sequenz ist die Ordnung. Als Konstante hier,
     * damit Kunden- und Admin-Lesepfad garantiert dieselbe Zeile sehen.
     */
    static final String CURRENT_SQL =
            "SELECT DISTINCT ON (model_kind) model_kind, model_id, previous_model_id, "
                    + "set_by, set_by_name, set_at "
                    + "FROM forecast_model_choice ORDER BY model_kind, id DESC";

    private final JdbcTemplate jdbc;

    public ForecastModelChoiceRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbcTemplate;
    }

    /**
     * Die aktuelle Wahl je Art als {@code kind -> model_id}. Eine Art ohne
     * Zeile fehlt schlicht in der Map - „nie umgestellt" ist kein Modell,
     * sondern das Signal, auf die Umgebung zurückzufallen.
     */
    public Map<String, String> current() {
        Map<String, String> out = new HashMap<>();
        jdbc.query(CURRENT_SQL, rs -> {
            out.put(rs.getString("model_kind"), rs.getString("model_id"));
        });
        return out;
    }
}
