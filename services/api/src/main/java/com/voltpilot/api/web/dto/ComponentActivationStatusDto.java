package com.voltpilot.api.web.dto;

import java.time.Instant;

public record ComponentActivationStatusDto(int revision, String status, int attempts,
        String lastError, Instant updatedAt, Instant appliedAt) {}
