package com.voltpilot.api.repo;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ForecastQualityDto.FeatureImportanceDto;
import com.voltpilot.api.web.dto.ForecastQualityDto.ForecastAccuracyPointDto;
import com.voltpilot.api.web.dto.ForecastQualityDto.ForecastModelDto;
import com.voltpilot.api.web.dto.ForecastQualityDto.PlanAccuracyPointDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Reads the shadow-mode forecasting measurement tables for the portal's
 * "Prognosequalität" view. All three tables ({@code forecast_model_state},
 * {@code forecast_accuracy}, {@code plan_accuracy} - migration
 * V20260701040000) carry {@code tenant_id} and are RLS-scoped, so - like
 * telemetry - every query is transparently narrowed to the caller's tenant.
 * Written by the forecast collector/evaluator (services/forecast) as the
 * trusted backend role; the api only reads.
 */
@Repository
public class ForecastQualityRepository {

    /** Model activeness is config, not client data; ids are pinned vocabulary. */
    private static final Set<String> KNOWN_STATUSES = Set.of("collecting", "ready");

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public ForecastQualityRepository(JdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    /** Every model that has ever run on this site, with its lifecycle state. */
    public List<ForecastModelDto> modelStates(UUID siteId, Set<String> activeModels) {
        return jdbc.query(
                "SELECT model, kind, status, days_collected, days_required, "
                        + "trained_at, train_rows, feature_importance::text AS fi, updated_at "
                        + "FROM forecast_model_state WHERE site_id = ? "
                        + "ORDER BY kind, model",
                (rs, i) -> {
                    String status = rs.getString("status");
                    return new ForecastModelDto(
                            rs.getString("model"),
                            rs.getString("kind"),
                            KNOWN_STATUSES.contains(status) ? status : "ready",
                            activeModels.contains(rs.getString("model")),
                            (Integer) rs.getObject("days_collected"),
                            (Integer) rs.getObject("days_required"),
                            toInstant(rs.getTimestamp("trained_at")),
                            (Integer) rs.getObject("train_rows"),
                            parseImportance(rs.getString("fi")),
                            toInstant(rs.getTimestamp("updated_at")));
                },
                siteId);
    }

    /** Daily error/skill series of every model, newest-first capped window. */
    public List<ForecastAccuracyPointDto> accuracySeries(UUID siteId, LocalDate since) {
        return jdbc.query(
                "SELECT day, model, kind, mae_kw, nmae_pct, bias_kw, "
                        + "skill_vs_baseline, n_slots "
                        + "FROM forecast_accuracy WHERE site_id = ? AND day >= ? "
                        + "ORDER BY day, kind, model",
                (rs, i) -> new ForecastAccuracyPointDto(
                        rs.getObject("day", LocalDate.class),
                        rs.getString("model"),
                        rs.getString("kind"),
                        toDouble(rs.getBigDecimal("mae_kw")),
                        toDouble(rs.getBigDecimal("nmae_pct")),
                        toDouble(rs.getBigDecimal("bias_kw")),
                        toDouble(rs.getBigDecimal("skill_vs_baseline")),
                        (Integer) rs.getObject("n_slots")),
                siteId, since);
    }

    /** Daily plan-vs-actual economics of the optimizer's persisted plans. */
    public List<PlanAccuracyPointDto> planAccuracySeries(UUID siteId, LocalDate since) {
        return jdbc.query(
                "SELECT day, planned_cost_eur, baseline_cost_eur, realized_cost_eur, n_slots "
                        + "FROM plan_accuracy WHERE site_id = ? AND day >= ? ORDER BY day",
                (rs, i) -> new PlanAccuracyPointDto(
                        rs.getObject("day", LocalDate.class),
                        toDouble(rs.getBigDecimal("planned_cost_eur")),
                        toDouble(rs.getBigDecimal("baseline_cost_eur")),
                        toDouble(rs.getBigDecimal("realized_cost_eur")),
                        (Integer) rs.getObject("n_slots")),
                siteId, since);
    }

    /**
     * Der Lebenszyklus-Zustand EINES Modells auf DIESER Anlage
     * ({@code collecting} | {@code ready}), {@code null} wenn es hier noch nie
     * gelaufen ist.
     *
     * <p>Er ist der SERVER-seitige Beleg für die erste Sperre des
     * „Kandidat übernehmen"-Knopfes: ein sammelnder Kandidat hat noch keine
     * einzige Prognose abgegeben, ihn zu übernehmen hieße, den Optimierer auf
     * eine leere Reihe zu setzen. Die Fläche nennt denselben Grund vor dem
     * Klick - dem Client zu glauben wäre keine Prüfung.
     */
    public String modelStatus(UUID siteId, String model) {
        List<String> rows = jdbc.query(
                "SELECT status FROM forecast_model_state "
                        + "WHERE site_id = ? AND model = ?",
                (rs, i) -> rs.getString("status"),
                siteId, model);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Wie viele TAGE dieses Modell auf DIESER Anlage schon bewertet wurde - der
     * Beleg, auf den sich eine Umstellung stützen kann.
     *
     * <p>Gezählt wird jede Bewertung, nicht nur die mit einem Skill-Wert: der
     * Maßstab selbst (das gerade aktive Modell) trägt per Konstruktion keinen
     * Skill, und ein RÜCKTAUSCH auf ein Modell, das gestern noch geplant hat,
     * darf nicht daran scheitern, dass es als Maßstab keine Skill-Zeile bekam.
     */
    public int evaluatedDays(UUID siteId, String model) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM forecast_accuracy WHERE site_id = ? AND model = ?",
                Integer.class, siteId, model);
        return n == null ? 0 : n;
    }

    private List<FeatureImportanceDto> parseImportance(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<>() {});
        } catch (Exception e) {
            // A malformed trail must never break the quality view; show none.
            return List.of();
        }
    }

    private static Double toDouble(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }

    private static java.time.Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
