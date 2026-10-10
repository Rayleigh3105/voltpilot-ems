package com.voltpilot.api.zugriff;

/**
 * Woran eine Schreibroute ihr Recht prüft (UEMS AP-03 IP-6): das Unternehmen oder der Standort, an dem das Objekt aus
 * dem Pfad HEUTE hängt („Rechte werden zum Anfragezeitpunkt geprüft", AP-03 §4.9).
 *
 * <p>Die Auflösung steht in {@link RechtPruefung}. Ein Objekt, das die Anfrage nicht sieht (fremder Kundenbereich,
 * Standort-Zaun aus IP-5) oder das es nicht gibt, reicht der Interceptor unverändert an die Route durch: ihre eigene
 * 404 bleibt byte-gleich. Nur eine Anlage prüft er selbst ({@link Geltungsbereich#requireSite}, dieselbe Ausnahme wie
 * die Routen).
 */
public enum RechtZiel {

    /** Das Unternehmen: Zeilen ohne Standort (Unternehmen bearbeiten, Standort anlegen, Kostenstellen …). */
    UNTERNEHMEN(""),
    /** Eine Anlage ({@code site}) und ihr Standort heute ({@code anlage_standort}). */
    ANLAGE("siteId"),
    /** Ein Standort. */
    STANDORT("standortId"),
    /** Ein Gebäude oder Bereich ({@code ort}) und sein Standort heute ({@code ort_zuordnung}, eine Stufe). */
    ORT("ortId"),
    /** Ein angemeldetes Gerät ({@code device}) — über seine Anlage. */
    DEVICE("deviceId"),
    /** Ein Gerät im Messstellen-Register ({@code geraet}, AP-04) — über seine Anlage. */
    GERAET("id"),
    /** Eine Messstelle — über ihren Ort heute ({@code messstelle_ort}: Unternehmen, Standort oder Gebäude/Bereich). */
    MESSSTELLE("id"),
    /** Eine Bezugsgröße — über ihre Geltung (Unternehmen, Standort, Gebäude/Bereich, Messstelle; Prozess/Kostenstelle = Unternehmen). */
    BEZUGSGROESSE("id"),
    /**
     * Das Ziel steht erst im Anfragekörper oder in der Geltung des Objekts: der Interceptor prüft vor, ob der Aufrufer
     * eines der Rechte irgendwo hat (Unternehmen oder einer seiner Standorte), die genaue Prüfung macht der Handler bzw.
     * der Dienst ({@code RechtRoutenArchitekturTest.DIENST} nennt die Stelle).
     */
    DIENST("");

    private final String variable;

    RechtZiel(String variable) {
        this.variable = variable;
    }

    /** Die Pfadvariable, die diese Zielart ohne Angabe liest. */
    public String variable() {
        return variable;
    }
}
