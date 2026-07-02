package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * "Prognosequalität" for one site: which forecast model is live per kind, the
 * lifecycle of every model that has run (incl. challengers still collecting
 * training data), the daily error/skill series from the evaluation, and the
 * daily plan-vs-actual economics. All rows come from RLS-scoped tables; the
 * active model ids come from the api's own configuration (the same env the
 * optimizer reads), never from client input.
 */
public record ForecastQualityDto(
        String activeLoadModel,
        String activePvModel,
        List<ForecastModelDto> models,
        List<ForecastAccuracyPointDto> accuracy,
        List<PlanAccuracyPointDto> planAccuracy) {

    /** One model's lifecycle on this site (a forecast_model_state row). */
    public record ForecastModelDto(
            String model,
            String kind,
            /** 'collecting' (self-gate unmet, no predictions) | 'ready'. */
            String status,
            /** Whether the optimizer consumes THIS model's forecasts. */
            boolean active,
            Integer daysCollected,
            Integer daysRequired,
            Instant trainedAt,
            Integer trainRows,
            /** Top features of the last training run, plain-German labels. */
            List<FeatureImportanceDto> featureImportance,
            Instant updatedAt) {
    }

    public record FeatureImportanceDto(String feature, String label, Double weight) {
    }

    /** One day's forecast-vs-actual metrics for one model (forecast_accuracy). */
    public record ForecastAccuracyPointDto(
            LocalDate day,
            String model,
            String kind,
            Double maeKw,
            Double nmaePct,
            Double biasKw,
            /** 1 - mae/mae_baseline; positive = better than the baseline; null for the baseline. */
            Double skillVsBaseline,
            Integer nSlots) {
    }

    /** One day's plan economics (plan_accuracy). */
    public record PlanAccuracyPointDto(
            LocalDate day,
            Double plannedCostEur,
            Double baselineCostEur,
            Double realizedCostEur,
            Integer nSlots) {
    }
}
