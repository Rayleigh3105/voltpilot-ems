package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Positive;

/** Optimistic lock for rollback: the visible current revision is mandatory. */
public record RollbackComponentRequest(@Positive int expectedRevision) {}
