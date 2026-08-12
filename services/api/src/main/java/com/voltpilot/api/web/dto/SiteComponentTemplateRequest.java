package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Size;

/**
 * Name und Notiz einer PRIVATEN Vorlage (Einheitsmodell Stufe 6).
 *
 * <p>Ein Typ statt der bisherigen rohen {@code Map<String,String>}: die
 * Duplizier-Route nahm ihren Namen ungeprüft und ohne Längenbegrenzung
 * entgegen, während jede andere Kunden-Eingabe des Hauses ihre
 * Bean-Validation trägt.
 *
 * <p>Beide Felder sind optional - beim Duplizieren entsteht ohne Namen der
 * abgeleitete „… (Vorlage)"; beim Umbenennen verlangt der Dienst einen
 * nicht-leeren Namen (eine namenlose Vorlage wäre in der Auswahl nicht
 * unterscheidbar).
 */
public record SiteComponentTemplateRequest(
        @Size(max = 200) String label,
        @Size(max = 200) String note) {}
