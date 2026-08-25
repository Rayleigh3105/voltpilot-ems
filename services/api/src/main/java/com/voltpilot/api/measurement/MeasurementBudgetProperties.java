package com.voltpilot.api.measurement;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Optional bench-calibrated per-family ceilings. Absent families use D5's 600;
 * configured values can only tighten, never widen, the platform boundary.
 */
@ConfigurationProperties(prefix = "voltpilot.measurements")
public record MeasurementBudgetProperties(Map<String, Integer> driverSampleLimits) {
    public MeasurementBudgetProperties {
        driverSampleLimits = driverSampleLimits == null ? Map.of() : Map.copyOf(driverSampleLimits);
    }
}
