package com.voltpilot.api.templates;

import com.voltpilot.api.web.dto.AdminComponentTemplateDto;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Verwaltung geprüfter Vorlagen (Einheitsmodell Stufe 6).
 *
 * <p><b>Der Sinn der Stufe in einem Satz:</b> eine neue geprüfte Gerätevorlage
 * entsteht als DATENSATZ, nie als Software-Auslieferung - ein SG-Ready-Relais
 * wird eine Vorlage statt eines Treibers.
 *
 * <p><b>⚠ EINGEBAUTE VORLAGEN SIND NICHT VON HAND EDITIERBAR.</b> Sie gehören
 * dem Start-Abgleich aus dem Go-Katalog ({@link ComponentTemplateSeeder}): sein
 * Upsert schreibt bei JEDEM Start die 15 Inhalts-Spalten zurück, eine
 * Handänderung wäre also spätestens beim nächsten Neustart weg - lautlos. Wir
 * lehnen deshalb ab und SAGEN es, statt eine Änderung anzunehmen, die nicht
 * hält. Der Weg für ein eingebautes Gerät führt über den Go-Katalog +
 * {@code cmd/vp-template-export}.
 *
 * <p><b>⚠ ZURÜCKZIEHEN BRICHT KEINE KOMPONENTE.</b> Die Fassung bleibt in der
 * Tabelle stehen; nur die AUSWAHL des Assistenten filtert sie heraus
 * ({@link ComponentTemplateRepository}). Eine laufende Komponente trägt ihre
 * Fassung als Schnappschuss ohne Fremdschlüssel - genau dafür ist er so
 * gebaut.
 */
@Service
public class ComponentTemplateAdminService {

    private final ComponentTemplateAdminRepository repo;

    public ComponentTemplateAdminService(ComponentTemplateAdminRepository repo) {
        this.repo = repo;
    }

    /** Alle Fassungen aller Herkunftsarten, mit der Nutzungszahl je Schlüssel. */
    public List<AdminComponentTemplateDto> list() {
        Map<String, Integer> usage = repo.usageByRef();
        return repo.findAll().stream()
                .map(t -> t.withUsage(usage.getOrDefault(t.templateRef(), 0)))
                .toList();
    }

    /**
     * Legt eine NEUE geprüfte Vorlage an (Fassung 1).
     *
     * <p>Der Schlüssel wird aus Marke + Modell ABGELEITET, nie übergeben - er
     * ist per Kontrakt opak, und ein Formularfeld dafür wäre die Einladung,
     * ihn „schöner" zu machen.
     */
    public AdminComponentTemplateDto create(ComponentTemplateDefinition.Input in, String actor) {
        ComponentTemplateDefinition.Result def = validated(in);
        String ref = ComponentTemplateDefinition.refFor(in.brand(), in.model());
        if (!BuiltinComponentTemplates.REF_PATTERN.matcher(ref).matches()) {
            throw refused(HttpStatus.BAD_REQUEST, "Aus Marke und Modell lässt sich kein gültiger "
                    + "Vorlagen-Schlüssel bilden.");
        }
        requireNotBuiltin(ref);
        if (repo.maxVersion(ref) > 0) {
            throw refused(HttpStatus.CONFLICT, "Diese Vorlage gibt es schon. Legen Sie stattdessen "
                    + "eine neue Fassung an - so bleibt nachvollziehbar, was sich geändert hat.");
        }
        repo.insert(ref, 1, in, def, certifiedAt(in), actor);
        return one(ref, 1);
    }

    /**
     * Legt eine neue FASSUNG einer bestehenden geprüften Vorlage an.
     *
     * <p>Eine Fassung wird nie überschrieben: „was lief letzte Woche" muss
     * beantwortbar bleiben - dieselbe Regel wie bei den Komponenten-Fassungen
     * ({@code component_definition}).
     */
    public AdminComponentTemplateDto addVersion(String templateRef,
            ComponentTemplateDefinition.Input in, String actor) {
        ComponentTemplateDefinition.Result def = validated(in);
        requireNotBuiltin(templateRef);
        int max = repo.maxVersion(templateRef);
        if (max == 0) {
            throw notFound();
        }
        // Marke und Modell bilden den Schlüssel; sie zu ändern wäre eine ANDERE
        // Vorlage unter altem Namen - dann wären Schlüssel und Inhalt zwei
        // Wahrheiten über dasselbe Produkt.
        String derived = ComponentTemplateDefinition.refFor(in.brand(), in.model());
        if (!derived.equals(templateRef)) {
            throw refused(HttpStatus.CONFLICT, "Marke und Modell gehören zum Schlüssel dieser "
                    + "Vorlage und lassen sich nicht ändern. Für ein anderes Gerät legen Sie "
                    + "bitte eine eigene Vorlage an.");
        }
        repo.insert(templateRef, max + 1, in, def, certifiedAt(in), actor);
        return one(templateRef, max + 1);
    }

    /**
     * Nimmt eine Fassung aus der Auswahl bzw. gibt sie wieder frei.
     *
     * <p>Die Rücknahme ist UMKEHRBAR - ein Betreiber, der versehentlich die
     * falsche Fassung zurückzieht, braucht einen Weg zurück, und die Fassung
     * ist ja unverändert vorhanden. Ein Löschen gibt es bewusst nicht.
     */
    public AdminComponentTemplateDto setWithdrawn(String templateRef, int version,
            boolean withdrawn, String actor, Instant now) {
        requireNotBuiltin(templateRef);
        repo.find(templateRef, version).orElseThrow(ComponentTemplateAdminService::notFound);
        repo.setWithdrawn(templateRef, version, withdrawn ? now : null, withdrawn ? actor : null);
        return one(templateRef, version);
    }

    private ComponentTemplateDefinition.Result validated(ComponentTemplateDefinition.Input in) {
        ComponentTemplateDefinition.Result def = ComponentTemplateDefinition.validate(in);
        if (!def.ok()) {
            throw refused(HttpStatus.BAD_REQUEST, String.join(" ", def.errors()));
        }
        return def;
    }

    /**
     * Ein {@code certified_at} entsteht genau dann, wenn der Prüf-Zustand
     * „geprüft" lautet - eine Prüf-Zeit an einer ungeprüften Vorlage wäre eine
     * Behauptung über einen Prüfstand, auf dem nichts stand.
     */
    private static Instant certifiedAt(ComponentTemplateDefinition.Input in) {
        return "certified".equals(in.certificationStatus()) ? Instant.now() : null;
    }

    private void requireNotBuiltin(String templateRef) {
        if (repo.kindOf(templateRef)
                .filter(BuiltinComponentTemplates.KIND_BUILTIN::equals).isPresent()) {
            throw refused(HttpStatus.CONFLICT, "Eingebaute Vorlagen lassen sich hier nicht ändern. "
                    + "Sie kommen bei jedem Start aus dem Geräte-Katalog der Edge-Software - eine "
                    + "Änderung hier wäre beim nächsten Neustart wieder weg. Der Weg führt über "
                    + "den Katalog und eine neue Edge-Auslieferung.");
        }
    }

    private AdminComponentTemplateDto one(String templateRef, int version) {
        Map<String, Integer> usage = repo.usageByRef();
        return repo.find(templateRef, version)
                .orElseThrow(ComponentTemplateAdminService::notFound)
                .withUsage(usage.getOrDefault(templateRef, 0));
    }

    private static ResponseStatusException notFound() {
        return refused(HttpStatus.NOT_FOUND, "Diese Vorlage kennen wir nicht.");
    }

    private static ResponseStatusException refused(HttpStatus status, String reason) {
        return new ResponseStatusException(status, reason);
    }
}
