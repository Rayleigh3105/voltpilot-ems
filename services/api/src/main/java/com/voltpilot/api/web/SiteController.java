package com.voltpilot.api.web;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Stub for the portal sites endpoint (see {@code docs/contracts/openapi.yaml}).
 * Returns static demo data mirroring the TimescaleDB dev seed until the
 * repository/RLS layer lands.
 */
@RestController
@RequestMapping("/api/v1/sites")
public class SiteController {

    @GetMapping
    public List<Map<String, Object>> listSites() {
        return List.of(Map.of(
            "id", "00000000-0000-0000-0000-000000000002",
            "name", "Demo Site Berlin",
            "biddingZone", "DE-LU"));
    }
}
