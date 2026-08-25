package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

public record MoveProvisioningStatusDto(UUID deviceId, int revision, String status,
        int attempts, String lastError, Instant updatedAt, Instant appliedAt) {}
