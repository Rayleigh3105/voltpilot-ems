package com.voltpilot.api.forecast;

import com.voltpilot.api.repo.AdminForecastModelChoiceRepository;
import com.voltpilot.api.repo.AdminForecastModelChoiceRepository.Choice;
import com.voltpilot.api.repo.ForecastModelChoiceRepository;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto.KindChoiceDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die EINE Auflösung „welches Prognosemodell plant gerade?" und der einzige
 * Schreibpfad dorthin (Captain-Auftrag 18.08.2026).
 *
 * <p><b>Präzedenz, wörtlich wie in Migration V20260825000000:</b> eine
 * Portal-Wahl gewinnt, sonst die Umgebungsvariable, sonst das Basismodell. Die
 * Umgebungsvariable bleibt also der Vorgabewert - eine Flotte ohne Zeile ist
 * von der Zeit vor dem Schalter nicht zu unterscheiden.
 *
 * <p>Sie steht hier EINMAL, damit die Kunden-Route
 * {@code /sites/{id}/forecast-quality} und die Admin-Route
 * {@code /admin/forecast-models} nicht zwei Antworten auf dieselbe Frage geben
 * können. Der Optimierer löst dieselbe Präzedenz auf seiner Seite auf
 * ({@code voltpilot_forecast/model_choice.py}) - beide lesen dieselbe Tabelle
 * und dieselbe Umgebung, also können sie nicht auseinanderlaufen.
 */
@Service
public class ForecastModelService {

    private final ForecastModelChoiceRepository choices;
    private final AdminForecastModelChoiceRepository adminChoices;
    private final String envLoadModel;
    private final String envPvModel;

    public ForecastModelService(
            ForecastModelChoiceRepository choices,
            AdminForecastModelChoiceRepository adminChoices,
            @Value("${voltpilot.forecast.active-load-model}") String envLoadModel,
            @Value("${voltpilot.forecast.active-pv-model}") String envPvModel) {
        this.choices = choices;
        this.adminChoices = adminChoices;
        this.envLoadModel = envLoadModel;
        this.envPvModel = envPvModel;
    }

    /** Der Vorgabewert der Umgebung für eine Art (ohne jede Portal-Wahl). */
    public String envDefault(String kind) {
        String configured = ForecastModels.KIND_LOAD.equals(kind) ? envLoadModel : envPvModel;
        return ForecastModels.resolve(kind, null, configured);
    }

    /**
     * Das aktive Modell je Art - der Lesepfad der KUNDEN-Seite (App-Rolle,
     * eine einzige billige Abfrage).
     */
    public Map<String, String> activeModels() {
        Map<String, String> stored = choices.current();
        Map<String, String> out = new LinkedHashMap<>();
        for (String kind : ForecastModels.kinds()) {
            out.put(kind, ForecastModels.resolve(kind, stored.get(kind), envDefault(kind)));
        }
        return out;
    }

    /** Der Panel-Zustand: je Art das aktive Modell samt Herkunft, plus die Historie. */
    public ForecastModelChoiceDto state() {
        Map<String, Choice> stored = adminChoices.current();
        List<KindChoiceDto> kinds = new ArrayList<>();
        for (String kind : ForecastModels.kinds()) {
            Choice choice = stored.get(kind);
            String env = envDefault(kind);
            String active = ForecastModels.resolve(
                    kind, choice == null ? null : choice.model(), env);
            // „portal" nur, wenn die gespeicherte Wahl auch WIRKLICH gilt - eine
            // von Hand eingetragene, unbekannte Id wird verworfen, und dann wäre
            // „vom Portal gesetzt" eine Behauptung über etwas Wirkungsloses.
            boolean fromPortal = choice != null && active.equals(choice.model());
            kinds.add(new KindChoiceDto(
                    kind,
                    active,
                    fromPortal ? "portal" : "env",
                    env,
                    fromPortal ? choice.setByName() : null,
                    fromPortal ? choice.setAt() : null,
                    ForecastModels.modelsOf(kind)));
        }
        return new ForecastModelChoiceDto(kinds, adminChoices.history(20));
    }

    /**
     * Übernimmt ein Modell als aktives Modell seiner Art - der Schalter.
     *
     * <p>Jede Ablehnung ist ein deutscher Satz: eine unbekannte Id, eine Id der
     * FALSCHEN Art (der Kern-Schutz - eine PV-Id als Verbrauchsmodell fände null
     * gespeicherte Zeilen und ließe den Optimierer still auf seine
     * Persistenz-Baseline zurückfallen, während das Portal weiter „live"
     * anzeigt), und der No-op (das Modell plant bereits) - Letzteres, damit das
     * Journal keine Zeilen ohne Ereignis sammelt.
     */
    public ForecastModelChoiceDto promote(
            String kind, String model, String setBy, String setByName) {
        if (kind == null || !ForecastModels.isKind(kind)) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "Unbekannte Prognoseart. Erlaubt sind 'load' (Verbrauch) und 'pv'.");
        }
        String id = model == null ? "" : model.trim();
        String modelKind = ForecastModels.kindOf(id);
        if (modelKind == null) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "Unbekanntes Prognosemodell. Wählbar sind: "
                            + String.join(", ", ForecastModels.modelsOf(kind)) + ".");
        }
        if (!modelKind.equals(kind)) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "„" + id + "\" ist ein Modell für eine andere Prognoseart"
                            + " und kann hier nicht aktiv werden.");
        }
        Map<String, Choice> stored = adminChoices.current();
        Choice choice = stored.get(kind);
        String active = ForecastModels.resolve(
                kind, choice == null ? null : choice.model(), envDefault(kind));
        if (active.equals(id)) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT, "Dieses Modell plant bereits - nichts zu tun.");
        }
        adminChoices.promote(kind, id, active, setBy, setByName);
        return state();
    }
}
