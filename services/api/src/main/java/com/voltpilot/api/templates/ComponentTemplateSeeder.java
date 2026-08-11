package com.voltpilot.api.templates;

import com.voltpilot.api.templates.BuiltinComponentTemplates.BuiltinTemplate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Spiegelt bei JEDEM Start die eingebauten Komponenten-Vorlagen aus der
 * Ressource {@code componenttemplates/builtin.json} in die Tabelle
 * {@code component_template} (Einheitsmodell Stufe 0a).
 *
 * <p><b>Warum ein Start-Abgleich und kein Seed in der Migration.</b> Eine
 * angewandte Migration ist unveränderlich (AGENTS.md: Flyway prüft jede
 * Prüfsumme beim Boot). Ein 44-Zeilen-Seed wäre ab dem nächsten Katalog-Edit
 * falsch, und jede Korrektur bräuchte eine weitere Migration - genau der
 * Zustand, den „Vorlagen werden Daten" abschaffen soll. Der Abgleich hier ist
 * idempotent, läuft nach jedem Deploy und braucht dafür keinen Menschen; das
 * ist wörtlich das Muster von {@code V2SiteBackfillRunner} und
 * {@code SelfconsumptionFlowSweepRunner}.
 *
 * <p><b>Er schreibt NUR eingebaute Vorlagen</b> (kind = builtin) und rührt
 * geprüfte/private Zeilen nie an - Löschen gibt es hier gar nicht. Eine Vorlage,
 * die aus dem Go-Katalog verschwindet, bleibt also stehen: Komponenten können
 * sie referenzieren, und eine Referenz ins Leere wäre schlimmer als ein
 * überzähliger Listeneintrag. Das Aufräumen ist eine bewusste Betreiber-Handlung
 * (Stufe 6), kein Nebeneffekt eines Deploys.
 *
 * <p><b>Er lässt den Start NIE scheitern.</b> Ohne Vorlagen liefert die
 * Lese-Route eine leere Liste - eine ehrliche Lücke; die api deswegen nicht
 * starten zu lassen wäre der schlechtere Tausch (kein Kundenpfad hängt in
 * dieser Stufe daran).
 */
@Component
public class ComponentTemplateSeeder {

    private static final Logger log = LoggerFactory.getLogger(ComponentTemplateSeeder.class);

    /** Urheber-Stempel der eingebauten Zeilen (das Gegenstück zum JWT-Subject eines Admins). */
    public static final String ACTOR = "startup:builtin-templates";

    /** Was ein Lauf getan hat (für Log + Tests). */
    public record SeedSummary(int total, int written, int failed) {}

    private final BuiltinComponentTemplates builtin;
    private final ComponentTemplateRepository repo;
    private final boolean enabled;

    /** Das {@code @Autowired} ist tragend (die Zwei-Konstruktoren-Falle). */
    @Autowired
    public ComponentTemplateSeeder(BuiltinComponentTemplates builtin,
            ComponentTemplateRepository repo,
            @Value("${voltpilot.templates.builtin-seed.enabled:true}") boolean enabled) {
        this.builtin = builtin;
        this.repo = repo;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void seedOnStartup() {
        if (!enabled) {
            log.info("Vorlagen-Abgleich ist abgeschaltet "
                    + "(voltpilot.templates.builtin-seed.enabled=false) - nichts geschrieben.");
            return;
        }
        SeedSummary summary = seed();
        if (summary.failed() > 0) {
            log.error("Vorlagen-Abgleich: {} von {} Vorlagen konnten nicht geschrieben werden. "
                    + "Der Anlege-Assistent zeigt dann weniger Geräte, als die Box lesen kann.",
                    summary.failed(), summary.total());
        } else if (summary.written() > 0) {
            log.info("Vorlagen-Abgleich: {} von {} eingebauten Vorlagen neu bzw. aktualisiert.",
                    summary.written(), summary.total());
        } else {
            log.info("Vorlagen-Abgleich: {} eingebaute Vorlagen unverändert.", summary.total());
        }
    }

    /**
     * Der Abgleich selbst - für Tests direkt aufrufbar. Ein Fehlschlag auf einer
     * Vorlage wird protokolliert und stoppt den Lauf nicht (die anderen 43 sind
     * deswegen nicht falsch).
     */
    public SeedSummary seed() {
        int written = 0;
        int failed = 0;
        for (BuiltinTemplate t : builtin.all()) {
            try {
                if (repo.upsertBuiltin(t, ACTOR)) {
                    written++;
                }
            } catch (RuntimeException e) {
                failed++;
                log.warn("Vorlage {} konnte nicht geschrieben werden: {}", t.templateRef(),
                        e.toString());
            }
        }
        return new SeedSummary(builtin.all().size(), written, failed);
    }
}
