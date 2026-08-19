package com.voltpilot.api.forecast;

import com.voltpilot.api.repo.AdminForecastModelChoiceRepository;
import com.voltpilot.api.repo.ForecastModelChoiceRepository;
import com.voltpilot.api.repo.ForecastQualityRepository;
import com.voltpilot.api.repo.SiteForecastModelChoiceRepository;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto;
import com.voltpilot.api.web.dto.ForecastModelChoiceDto.KindChoiceDto;
import com.voltpilot.api.web.dto.SiteForecastModelsDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
    private final SiteForecastModelChoiceRepository siteChoices;
    private final ForecastQualityRepository quality;
    private final String envLoadModel;
    private final String envPvModel;

    public ForecastModelService(
            ForecastModelChoiceRepository choices,
            AdminForecastModelChoiceRepository adminChoices,
            SiteForecastModelChoiceRepository siteChoices,
            ForecastQualityRepository quality,
            @Value("${voltpilot.forecast.active-load-model}") String envLoadModel,
            @Value("${voltpilot.forecast.active-pv-model}") String envPvModel) {
        this.choices = choices;
        this.adminChoices = adminChoices;
        this.siteChoices = siteChoices;
        this.quality = quality;
        this.envLoadModel = envLoadModel;
        this.envPvModel = envPvModel;
    }

    /** Der Vorgabewert der Umgebung für eine Art (ohne jede Portal-Wahl). */
    public String envDefault(String kind) {
        String configured = ForecastModels.KIND_LOAD.equals(kind) ? envLoadModel : envPvModel;
        return ForecastModels.resolve(kind, null, configured);
    }

    /**
     * Das aktive Modell je Art FÜR EINE ANLAGE - die volle Präzedenz
     * <b>Anlagen-Wahl &gt; Plattform-Vorgabe &gt; Umgebung &gt;
     * Registry-Default</b> (Migration V20260826000000).
     *
     * <p>Sie steht hier EINMAL, damit die Kunden-Route
     * {@code /sites/{id}/forecast-quality}, der Anlagen-Schalter und der
     * Optimierer nicht drei Antworten auf dieselbe Frage geben können; der
     * Optimierer löst dieselbe Präzedenz auf seiner Seite auf
     * ({@code voltpilot_forecast.model_choice}) und liest dieselben zwei
     * Tabellen.
     */
    public Map<String, String> activeModels(UUID siteId) {
        Map<String, String> platform = choices.current();
        Map<String, ModelChoice> site = siteChoices.current(siteId);
        Map<String, String> out = new LinkedHashMap<>();
        for (String kind : ForecastModels.kinds()) {
            ModelChoice own = site.get(kind);
            out.put(kind, ForecastModels.resolve(
                    kind,
                    own == null ? null : own.model(),
                    platform.get(kind),
                    envDefault(kind)));
        }
        return out;
    }

    /** Der Panel-Zustand: je Art das aktive Modell samt Herkunft, plus die Historie. */
    public ForecastModelChoiceDto state() {
        Map<String, ModelChoice> stored = adminChoices.current();
        List<KindChoiceDto> kinds = new ArrayList<>();
        for (String kind : ForecastModels.kinds()) {
            ModelChoice choice = stored.get(kind);
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
        String id = validated(kind, model);
        Map<String, ModelChoice> stored = adminChoices.current();
        ModelChoice choice = stored.get(kind);
        String active = ForecastModels.resolve(
                kind, choice == null ? null : choice.model(), envDefault(kind));
        if (active.equals(id)) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT, "Dieses Modell plant bereits - nichts zu tun.");
        }
        adminChoices.promote(kind, id, active, setBy, setByName);
        return state();
    }

    /* ---- der ANLAGEN-Schalter (Captain-Auftrag 19.08.2026) ---------------- */

    /**
     * Der Panel-Zustand EINER Anlage: je Art das Modell, das sie plant, samt
     * HERKUNFT, plus ihre eigene Umstellungs-Historie.
     *
     * <p>Die Herkunft ist die Aussage, an der die ganze Fläche hängt:
     * {@code anlage} = jemand hat das für diese Anlage entschieden,
     * {@code plattform} = sie folgt der Vorgabe von VoltPilot, {@code env} =
     * dem ausgelieferten Standardmodell. „anlage" wird nur behauptet, wenn die
     * gespeicherte Wahl auch WIRKLICH gilt - eine von Hand eingetragene,
     * unbekannte Id wird verworfen, und dann wäre sie eine Behauptung über
     * etwas Wirkungsloses.
     */
    public SiteForecastModelsDto state(UUID siteId) {
        Map<String, String> platformChoice = choices.current();
        Map<String, ModelChoice> site = siteChoices.current(siteId);
        List<SiteForecastModelsDto.KindChoiceDto> kinds = new ArrayList<>();
        for (String kind : ForecastModels.kinds()) {
            String env = envDefault(kind);
            String platform = ForecastModels.resolve(kind, platformChoice.get(kind), env);
            ModelChoice own = site.get(kind);
            String active = ForecastModels.resolve(
                    kind, own == null ? null : own.model(), platformChoice.get(kind), env);
            boolean fromSite = own != null && active.equals(own.model());
            String source = fromSite
                    ? "anlage"
                    : (platform.equals(env) ? "env" : "plattform");
            kinds.add(new SiteForecastModelsDto.KindChoiceDto(
                    kind,
                    active,
                    source,
                    platform,
                    env,
                    fromSite ? own.setByName() : null,
                    fromSite ? own.setAt() : null,
                    ForecastModels.modelsOf(kind)));
        }
        return new SiteForecastModelsDto(siteId, kinds, siteChoices.history(siteId, 20));
    }

    /**
     * Übernimmt ein Modell als aktives Modell seiner Art FÜR EINE ANLAGE.
     *
     * <p><b>Die Sperrgründe der Oberfläche werden hier ein zweites Mal
     * geprüft</b> - dem Client zu glauben wäre keine Prüfung, und beide Sperren
     * schützen vor derselben Sache: einer Umstellung auf ein Modell, für das es
     * auf DIESER Anlage keine Prognosezeilen gibt (der Optimierer fiele dann
     * still auf seine Persistenz-Baseline zurück, während das Portal das neue
     * Modell als „live" zeigt).
     *
     * <ul>
     *   <li>ein Kandidat, der auf dieser Anlage noch SAMMELT, hat noch keine
     *       einzige Prognose abgegeben,</li>
     *   <li>ein Modell ohne eine einzige Tagesbewertung auf dieser Anlage hat
     *       nichts, worauf sich eine Umstellung stützen könnte.</li>
     * </ul>
     *
     * <p>Die Bewertungs-Sperre zählt bewusst JEDE Bewertung, nicht nur die mit
     * einem Skill-Wert: der Maßstab selbst trägt per Konstruktion keinen Skill,
     * ein RÜCKTAUSCH auf ein Modell, das gestern noch geplant hat, muss also
     * jederzeit möglich bleiben.
     */
    public SiteForecastModelsDto promote(
            UUID siteId, String kind, String model, String setBy, String setByName) {
        String id = validated(kind, model);
        String active = activeModels(siteId).get(kind);
        if (active.equals(id)) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "Dieses Modell plant diese Anlage bereits - nichts zu tun.");
        }
        String status = quality.modelStatus(siteId, id);
        if ("collecting".equals(status)) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "Dieses Modell sammelt für diese Anlage noch Daten und hat noch"
                            + " keine Prognose abgegeben.");
        }
        if (quality.evaluatedDays(siteId, id) == 0) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "Für diese Anlage gibt es zu diesem Modell noch keine Tagesbewertung"
                            + " - es gibt nichts, worauf sich eine Umstellung stützen"
                            + " könnte.");
        }
        siteChoices.promote(siteId, kind, id, active, setBy, setByName);
        return state(siteId);
    }

    /** Form-Prüfung beider Schreibpfade: Art bekannt, Modell bekannt, Art passt. */
    private static String validated(String kind, String model) {
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
        return id;
    }
}
