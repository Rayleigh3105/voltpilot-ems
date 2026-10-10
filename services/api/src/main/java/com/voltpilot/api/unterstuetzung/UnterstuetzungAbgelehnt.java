package com.voltpilot.api.unterstuetzung;

import com.voltpilot.api.uems.RechteAbleitung.Grund;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Unterstützungs-Schnittstelle (UEMS AP-03 IP-8): Code, Status und Kundensatz aus dem
 * geschlossenen Satz {@link Ablehnung}, dazu die Fakten des Urteils (snake_case). Wenn sie fliegt, ist nichts
 * geschrieben — kein Zugriff, kein Protokoll, kein Hinweis.
 *
 * <p><b>Die drei Wörter, die der Rechte-Vertrag schon kennt</b> ({@code standort_fehlt},
 * {@code hoechstens_12_monate}, {@code grund_fehlt}), kommen aus {@link Grund} und werden hier NICHT neu
 * erfunden — {@link #ausGrund} übersetzt das Urteil von {@code RechteAbleitung.gewaehren}. Die übrigen
 * gehören dieser Schnittstelle allein; ihr Zwilling ist der OpenAPI-Enum {@code UnterstuetzungFehler}.
 */
public final class UnterstuetzungAbgelehnt extends RuntimeException {

    /** Der geschlossene Satz — gepinnt gegen den OpenAPI-Enum {@code UnterstuetzungFehler}. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400,
                "Die Anfrage ist nicht vollständig oder nicht lesbar."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Nicht gefunden."),
        BEREITS_BEENDET("bereits_beendet", 409,
                "Diese Unterstützung ist bereits beendet. Gewähren Sie sie neu, wenn sie wieder gebraucht wird."),
        ANFRAGE_ENTSCHIEDEN("anfrage_entschieden", 409,
                "Über diese Anfrage ist schon entschieden. Laden Sie neu."),
        STANDORT_FEHLT(Grund.STANDORT_FEHLT.code(), 422,
                "Wählen Sie mindestens einen Standort — eine Unterstützung gilt nie für das ganze Unternehmen."),
        STANDORT_UNBEKANNT("standort_unbekannt", 422, "Einen der gewählten Standorte gibt es nicht."),
        HOECHSTENS_12_MONATE(Grund.HOECHSTENS_12_MONATE.code(), 422,
                "Eine Unterstützung gilt höchstens zwölf Monate. Wählen Sie ein früheres Enddatum."),
        GRUND_FEHLT(Grund.GRUND_FEHLT.code(), 422,
                "Ein Notfall-Zugriff braucht einen Grund — der Kunde liest ihn."),
        ENDE_NICHT_SPAETER("ende_nicht_spaeter", 422,
                "Verlängern heißt ein SPÄTERES Enddatum. Zum Verkürzen beenden Sie die Unterstützung."),
        NOTFALL_NICHT_VERLAENGERBAR("notfall_nicht_verlaengerbar", 409,
                "Ein Notfall-Zugriff gilt 24 Stunden und wird nicht verlängert. Bitten Sie um eine Unterstützung."),
        KONTO_NICHT_ERREICHBAR("konto_nicht_erreichbar", 502,
                "Die Benutzerverwaltung antwortet gerade nicht. Versuchen Sie es in einigen Minuten noch einmal.");

        private final String code;
        private final int status;
        private final String satz;

        Ablehnung(String code, int status, String satz) {
            this.code = code;
            this.status = status;
            this.satz = satz;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        public String satz() {
            return satz;
        }
    }

    /** Alle Codes, die die Schnittstelle je antwortet. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final transient Map<String, Object> fakten;

    public UnterstuetzungAbgelehnt(Ablehnung ablehnung, Map<String, Object> fakten) {
        super(ablehnung.satz());
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static UnterstuetzungAbgelehnt von(Ablehnung ablehnung) {
        return new UnterstuetzungAbgelehnt(ablehnung, Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static UnterstuetzungAbgelehnt anfrage(String feld) {
        return new UnterstuetzungAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Map.of("feld", feld));
    }

    /**
     * Das Nein des Vertrags ({@code RechteAbleitung.gewaehren}) als Ablehnung dieser Schnittstelle — mit
     * seinem Kundensatz, nicht mit dem hiesigen: der Vertrag ist die Wahrheit über Dauer, Standort und Grund.
     */
    public static UnterstuetzungAbgelehnt ausGrund(Grund grund, String text) {
        Ablehnung a = Arrays.stream(Ablehnung.values()).filter(x -> x.code().equals(grund.code())).findFirst()
                .orElseThrow(() -> new IllegalStateException("Vertragsgrund ohne Ablehnung: " + grund.code()));
        return new UnterstuetzungAbgelehnt(a, text == null ? Map.of() : Map.of("message", text));
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

    /** Der Körper: {@code code}, {@code message} (der Satz des Vertrags geht vor) und die Fakten. */
    public Map<String, Object> koerper() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code());
        Object vertrag = fakten.get("message");
        body.put("message", vertrag instanceof String s && !s.isBlank() ? s : ablehnung.satz());
        fakten.forEach((k, v) -> {
            if (!"message".equals(k)) {
                body.put(k, v);
            }
        });
        return body;
    }
}
