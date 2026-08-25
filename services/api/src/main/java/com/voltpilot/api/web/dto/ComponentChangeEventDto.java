package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/** Ein semantischer Marker in der unveränderlichen Geräte-Historie. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ComponentChangeEventDto(
        int revision,
        String eventType,
        Instant effectiveAt,
        String fromValue,
        String toValue,
        Instant createdAt,
        String createdBy,
        String note) {}
