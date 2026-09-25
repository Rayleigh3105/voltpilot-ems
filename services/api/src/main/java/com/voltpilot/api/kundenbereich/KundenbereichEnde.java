package com.voltpilot.api.kundenbereich;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Ein beendeter Kundenbereich (UEMS AP-20 IP-16, E10 = A, BT4, RF-08): seit {@code beendetAm} ist jeder Schreibweg
 * {@code 409 kundenbereich_beendet}, nur der Kundenadministrator liest noch. Gelöscht wird frühestens nach der Frist
 * ({@link #loeschungFruehestens}) — beim Abruf gerechnet, nie gespeichert. Ein aktiver Kundenbereich hat keinen
 * {@code KundenbereichEnde}; „aktiv" ist {@code tenant.beendet_am IS NULL}.
 *
 * <p>Die Sätze stehen HIER und gehen über {@code GET /api/v1/me} ({@code kundenbereich.beendet}) und den Körper
 * der 409 ans Portal — nie dort nachgebaut. Den Gesamtabzug nennt nur der Satz an den Kundenadministrator
 * ({@link #textKundenadministrator}, §5.8): nur er kann ihn laden (IP-17, {@code GET /api/v1/unternehmen/abzug}).
 */
public record KundenbereichEnde(UUID kundenbereich, Instant beendetAm, int fristTage, String beendetVon) {

    public static final String CODE = "kundenbereich_beendet";
    /** Startwert der Frist nach Vertragsende (§4.2, BT4) — die geltende steht im Vertrag mit dem Kunden. */
    public static final int FRIST_STARTWERT = 90;
    /** Die Zone der Vertragsdaten: „beendet am" und „frühestens am" sind Kalendertage in Deutschland. */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    public LocalDate beendetAmTag() {
        return beendetAm.atZone(ZONE).toLocalDate();
    }

    /** Der erste Tag, an dem der Betreiber löschen darf: Tag des Endes plus Frist (RF-08: 30.06.2029 + 90 = 28.09.2029). */
    public LocalDate loeschungFruehestens() {
        return beendetAmTag().plusDays(fristTage);
    }

    /** Der Kopf-Hinweis für jede Person des Kundenbereichs. */
    public String text() {
        return "Ihr Vertrag ist am " + beendetAmTag().format(DATUM) + " beendet. Ihre Daten können Sie nur noch lesen; "
                + "gelöscht werden sie frühestens am " + loeschungFruehestens().format(DATUM) + ".";
    }

    /**
     * Der Kopf-Hinweis für den Kundenadministrator (§5.8, RF-08): der Satz für alle und dazu der Weg zum Gesamtabzug
     * (IP-17), den nur er laden kann.
     */
    public String textKundenadministrator() {
        return text() + " Bis dahin können Sie den Gesamtabzug laden.";
    }

    /** Die Antwort an jede Person außer dem Kundenadministrator: sie liest nicht mehr (E10 „alles gesperrt"). */
    public String textNurKundenadministrator() {
        return "Ihr Vertrag ist am " + beendetAmTag().format(DATUM) + " beendet. Nur Ihr Kundenadministrator kann die "
                + "Daten bis zur Löschung noch lesen.";
    }

    /** Der Körper der 409 — Form der UEMS-Ablehnungen ({@code code}, {@code message}, Fakten). */
    public Map<String, Object> koerper(String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CODE);
        body.put("message", message);
        body.put("beendet_am", beendetAm.toString());
        body.put("loeschung_fruehestens", loeschungFruehestens().toString());
        return body;
    }
}
