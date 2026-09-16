package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/** Erster Kundenadministrator; Startpasswort und Pflichtwechsel werden serverseitig festgelegt. */
public record CreateUserRequest(@NotBlank String username, @NotBlank @Email String email,
        String firstName, String lastName) {}
