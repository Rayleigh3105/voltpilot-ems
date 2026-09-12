package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5): Code, Status und Kundensatz
 * kommen aus dem geschlossenen Satz {@link Ablehnung} — also aus dem Vertrag
 * ({@code bezugsdaten-vectors.json → verwalten.ablehnungen}), nie aus dieser Klasse. Dazu die
 * Fakten des Urteils ({@code feld}, {@code felder}, {@code erlaubt}, {@code werte}). Wenn sie
 * fliegt, ist nichts geschrieben.
 */
public final class BezugsgroesseAbgelehnt extends RuntimeException {

    /** Alle Codes, die die Schnittstelle je antwortet — gepinnt gegen den OpenAPI-Enum. */
    public static final List<String> CODES =
            java.util.Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    public BezugsgroesseAbgelehnt(Ablehnung ablehnung, Map<String, Object> fakten) {
        super(ablehnung.satz());
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static BezugsgroesseAbgelehnt aus(BezugsgroesseRegeln.Urteil urteil) {
        return new BezugsgroesseAbgelehnt(urteil.ablehnung(), urteil.fakten());
    }

    public static BezugsgroesseAbgelehnt von(Ablehnung ablehnung) {
        return new BezugsgroesseAbgelehnt(ablehnung, Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static BezugsgroesseAbgelehnt anfrage(String feld) {
        return new BezugsgroesseAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
    }

    public Ablehnung ablehnung() {
        return ablehnung;
    }

    public String code() {
        return ablehnung.code();
    }

    public int status() {
        return ablehnung.status();
    }

    /** Die Fakten des Urteils (snake_case wie der Vertrag), ohne Code und Satz. */
    public Map<String, Object> fakten() {
        return fakten;
    }
}
