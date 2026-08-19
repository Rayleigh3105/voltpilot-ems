package com.voltpilot.api.forecast;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Das Vokabular des Schattenbetriebs, api-seitig: welche Prognose-Modell-Ids es
 * gibt, zu welcher Prognoseart sie gehören und welche davon das Basismodell
 * ist.
 *
 * <p><b>Rein und Docker-frei prüfbar</b> (das {@code Tagesprotokoll}/
 * {@code FleetPflege}/{@code RolloutStates}-Muster): hier steht nur Wissen, kein
 * Zugriff. Der Zwilling ist {@code services/forecast}
 * {@code voltpilot_forecast/registry.py} - die Liste ist bewusst klein und
 * zentral, damit Collector, Optimierer, api und Portal dieselben Namen
 * sprechen; <b>wer dort eine Id ergänzt, ergänzt sie hier</b> (und umgekehrt).
 *
 * <p>Die api ERFINDET nie eine Id: eine unbekannte Id auf dem Schreibpfad ist
 * eine Ablehnung mit deutschem Grund, und eine unbekannte Id in einer
 * DB-Zeile wird verworfen statt geraten (die Ingest-Regel des Hauses: ein Wort,
 * das wir nicht verstehen, darf kein Satz werden).
 */
public final class ForecastModels {

    /** Die beiden Prognosearten - das Vokabular der Spalte {@code model_kind}. */
    public static final String KIND_LOAD = "load";
    public static final String KIND_PV = "pv";

    /** Basis-/Vergleichsmodell je Art - zugleich der Vorgabewert. */
    public static final String LOAD_PERSISTENCE = "load-persistence";
    public static final String PV_PHYSICAL = "pv-physical";
    /** Lernende Kandidaten - im Schatten, bis jemand sie bewusst übernimmt. */
    public static final String LOAD_XGB = "load-xgb";
    public static final String PV_RESIDUAL_XGB = "pv-residual-xgb";

    private static final Map<String, List<String>> MODELS_BY_KIND = Map.of(
            KIND_LOAD, List.of(LOAD_PERSISTENCE, LOAD_XGB),
            KIND_PV, List.of(PV_PHYSICAL, PV_RESIDUAL_XGB));

    private static final Map<String, String> BASELINE_BY_KIND = Map.of(
            KIND_LOAD, LOAD_PERSISTENCE,
            KIND_PV, PV_PHYSICAL);

    private ForecastModels() {
    }

    /** Die zwei Prognosearten in stabiler Reihenfolge (Verbrauch, dann PV). */
    public static List<String> kinds() {
        return List.of(KIND_LOAD, KIND_PV);
    }

    public static boolean isKind(String kind) {
        return MODELS_BY_KIND.containsKey(kind);
    }

    /** Alle Modell-Ids einer Art - die wählbare Menge des Schalters. */
    public static List<String> modelsOf(String kind) {
        return MODELS_BY_KIND.getOrDefault(kind, List.of());
    }

    /** Die Art, zu der eine Modell-Id gehört - {@code null} bei unbekannter Id. */
    public static String kindOf(String modelId) {
        for (Map.Entry<String, List<String>> e : MODELS_BY_KIND.entrySet()) {
            if (e.getValue().contains(modelId)) {
                return e.getKey();
            }
        }
        return null;
    }

    /** Das Basismodell einer Art - der Vorgabewert ohne jede Konfiguration. */
    public static String baselineOf(String kind) {
        return BASELINE_BY_KIND.get(kind);
    }

    public static Set<String> known() {
        return Set.of(LOAD_PERSISTENCE, PV_PHYSICAL, LOAD_XGB, PV_RESIDUAL_XGB);
    }

    /**
     * Die AKTIVE Modell-Id einer Art nach der bindenden Präzedenz der Migration
     * V20260825000000: <b>Portal-Wahl &gt; Umgebungsvariable &gt;
     * Registry-Default</b>.
     *
     * <p>Eine unbekannte oder art-fremde Wahl wird VERWORFEN statt übernommen
     * (die Zeile kann nur von Hand entstanden sein - der Schreibpfad validiert)
     * und eine unbekannte Umgebungsvariable ebenso: beides fällt auf das
     * Basismodell zurück, damit eine falsche Konfiguration nie zu einem Modell
     * führt, für das es keine gespeicherten Prognosezeilen gibt.
     */
    public static String resolve(String kind, String choice, String envValue) {
        return resolve(kind, null, choice, envValue);
    }

    /**
     * Dieselbe Auflösung mit der ANLAGEN-Wahl an der Spitze - die bindende
     * Präzedenz der Migration V20260826000000 (Captain-Auftrag 19.08.2026):
     * <b>Anlagen-Wahl &gt; Plattform-Vorgabe &gt; Umgebungsvariable &gt;
     * Registry-Default</b>.
     *
     * <p>Sie steht wortgleich in {@code voltpilot_forecast.model_choice}, damit
     * api und Optimierer über dieselbe Anlage nie Verschiedenes behaupten
     * können. Ohne eine einzige Zeile ist jeder Pfad byte-identisch zu vorher -
     * das ist die Rückwärts-Sicherheit, auf die sich die Tests berufen.
     */
    public static String resolve(
            String kind, String siteChoice, String platformChoice, String envValue) {
        if (belongsTo(kind, siteChoice)) {
            return siteChoice.trim();
        }
        if (belongsTo(kind, platformChoice)) {
            return platformChoice.trim();
        }
        if (belongsTo(kind, envValue)) {
            return envValue.trim();
        }
        return baselineOf(kind);
    }

    private static boolean belongsTo(String kind, String modelId) {
        return modelId != null && !modelId.isBlank() && kind.equals(kindOf(modelId.trim()));
    }
}
