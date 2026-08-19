package com.voltpilot.api.registerwrite;

import java.time.Instant;

/**
 * Die Quittung der Box zu EINEM Einmal-Schreibvorgang (Kontrakt
 * {@code docs/contracts/mqtt-register-write.schema.json}).
 *
 * <p><b>Jedes Feld darf fehlen, und ein fehlendes heißt „nicht gemessen", nie
 * 0.</b> Insbesondere ist {@code beforeRaw} bei einem gescheiterten Austausch
 * {@code null} - eine 0 wäre hier ein WERT („gar keine Einspeisung erlaubt"),
 * nie eine Abwesenheit; und {@code adopted} ist DREIWERTIG: {@code null} = es
 * gab keinen Schreibvorgang (Probelauf) oder keine Aussage, {@code false} =
 * angenommen aber NICHT übernommen (die belegte FC6-Klasse), {@code true} = als
 * der angeforderte Wert zurückgelesen.
 *
 * @param errorCode eine der geschlossenen Klassen des Kontrakts, oder
 *                  {@code null}. Ein Wort außerhalb dieser Menge wird beim
 *                  Ingest verworfen - was wir nicht verstehen, darf kein Satz
 *                  werden.
 */
public record RegisterWriteResult(
        String requestId, String mode, boolean ok, Integer beforeRaw, Integer afterRaw,
        Boolean wrote, Boolean adopted, String targetLabel, String errorCode, String message,
        Instant answeredAt) {

    /** Der Modus einer Vorschau-Lesung. */
    public static final String MODE_READ = "lesen";
    /** Der Modus des einen Schreibvorgangs. */
    public static final String MODE_WRITE = "schreiben";

    /**
     * Das Urteil, wie es ins Journal und auf die Oberfläche wandert.
     *
     * <p>Die fünf Ausgänge sind bewusst getrennt: „übernommen" ist die einzige,
     * die aus einer echten Rücklesung stammt; „nicht übernommen" ist NICHT
     * dasselbe wie „abgelehnt"; und „unbekannt" ist die ehrliche Antwort auf
     * Schweigen (die PR-280-Lehre - Schweigen ist nie „nicht geschrieben").
     */
    public String outcome() {
        if (errorCode != null) {
            return switch (errorCode) {
                case "timeout" -> OUTCOME_UNKNOWN;
                case "gate_disabled", "refused_policy", "refused_control_owned",
                        "refused_expected_before", "not_supported", "rate_limited",
                        "busy", "invalid_request" -> OUTCOME_REFUSED;
                default -> OUTCOME_ERROR;
            };
        }
        if (!ok) {
            return OUTCOME_ERROR;
        }
        if (!MODE_WRITE.equals(mode)) {
            return OUTCOME_READ;
        }
        return Boolean.TRUE.equals(adopted) ? OUTCOME_ADOPTED : OUTCOME_NOT_ADOPTED;
    }

    public static final String OUTCOME_ADOPTED = "uebernommen";
    public static final String OUTCOME_NOT_ADOPTED = "nicht_uebernommen";
    public static final String OUTCOME_REFUSED = "abgelehnt";
    public static final String OUTCOME_ERROR = "fehler";
    public static final String OUTCOME_UNKNOWN = "unbekannt";
    /** Ein Probelauf hat kein Schreib-Urteil - er hat einen Ist-Wert. */
    public static final String OUTCOME_READ = "gelesen";

    /** Die ausgebliebene Quittung: der Zustand ist UNBEKANNT, nie „nicht geschrieben". */
    public static RegisterWriteResult silent(String requestId, String mode, String message) {
        return new RegisterWriteResult(requestId, mode, false, null, null, null, null, null,
                "timeout", message, null);
    }
}
