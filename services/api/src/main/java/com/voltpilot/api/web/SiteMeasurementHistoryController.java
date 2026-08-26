package com.voltpilot.api.web;

import com.voltpilot.api.measurement.MeasurementHistoryService;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/sites/{siteId}/measurement-history")
public class SiteMeasurementHistoryController {

    private final MeasurementHistoryService history;

    public SiteMeasurementHistoryController(MeasurementHistoryService history) {
        this.history = history;
    }

    @GetMapping("/options")
    public List<MeasurementHistoryService.ComparisonOption> options(@PathVariable UUID siteId) {
        return history.comparisonOptions(siteId);
    }
}
