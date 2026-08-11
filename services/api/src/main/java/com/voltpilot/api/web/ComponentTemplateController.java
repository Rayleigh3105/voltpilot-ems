package com.voltpilot.api.web;

import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Komponenten-VORLAGEN, aus denen der spätere EINE Anlege-Assistent seine
 * Geräte-Auswahl rendert ({@code GET /api/v1/component-templates}) -
 * Einheitsmodell Stufe 0a.
 *
 * <p><b>In dieser Stufe konsumiert die Route NICHTS.</b> Sie ist der Unterbau;
 * am Kundenverhalten ändert sich nichts.
 *
 * <p>Bewusst eine KUNDEN-förmige, authentifizierte Route (das Muster von
 * {@code GET /api/v1/flow-catalog}) und nicht {@code /api/v1/admin/**}: eine
 * Vorlage ist die Geräte-Auswahl, die der Kunde im Assistenten sieht, keine
 * Interna. Sie ist auch nicht anlagenbezogen - es gibt nichts zu mandanten-
 * scopen, die Tabelle ist global und trägt keine RLS.
 *
 * <p><b>Der Zaun ist die Herkunfts-Filterung, nicht die Datenbankrolle.</b>
 * Ausgeliefert werden nur {@link BuiltinComponentTemplates#PUBLIC_KINDS}
 * (builtin + certified). {@code custom} - die private Vorlage je Anlage (Stufe
 * 3) - fehlt darin mit Absicht: sie gehört EINER Anlage, diese Tabelle hat aber
 * bewusst keine {@code tenant_id}, also wäre eine mandantenlose Ausgabe ein
 * Leck. Stufe 3 baut den Zaun, dann erst wächst diese Menge; bis dahin
 * existiert ohnehin kein Schreiber, der eine solche Zeile anlegen könnte.
 * Festgenagelt in {@code ComponentTemplateApiTest}.
 *
 * <p>Eine leere Liste heißt „das Register ist leer" (der Start-Abgleich lief
 * nicht), nicht „es gibt keine Geräte".
 */
@RestController
@RequestMapping("/api/v1/component-templates")
public class ComponentTemplateController {

    private final ComponentTemplateRepository templates;

    public ComponentTemplateController(ComponentTemplateRepository templates) {
        this.templates = templates;
    }

    /** Alle öffentlichen Vorlagen, neueste Fassung je Schlüssel, nach Marke sortiert. */
    @GetMapping
    public List<ComponentTemplateDto> list() {
        return templates.findNewest(BuiltinComponentTemplates.PUBLIC_KINDS);
    }

    /**
     * EINE Vorlage in ihrer neuesten Fassung. Unbekannt UND nicht-öffentlich
     * antworten identisch mit 404 - so verrät die Route nicht, ob es einen
     * Schlüssel gibt (die Enrollment-Disziplin „pending == unknown").
     */
    @GetMapping("/{templateRef}")
    public ComponentTemplateDto one(@PathVariable String templateRef) {
        return templates.findNewestByRef(BuiltinComponentTemplates.PUBLIC_KINDS, templateRef)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Diese Vorlage kennen wir nicht."));
    }
}
