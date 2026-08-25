package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/** Vorprüfung des getrennten „Gerät verschieben“-Flows. */
public record DeviceMovePreviewDto(UUID deviceId, UUID currentSiteId, int revision,
        List<TargetSiteDto> targets) {
    public record TargetSiteDto(UUID siteId, String name, boolean allowed, String reason) {}
}
