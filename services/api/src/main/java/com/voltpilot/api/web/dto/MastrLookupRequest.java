package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Lookup request: the one human-visible identifier, nothing else. */
public record MastrLookupRequest(@NotBlank String einheitNummer) {
}
