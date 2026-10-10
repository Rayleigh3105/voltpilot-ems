package com.voltpilot.api.templates;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Cloud-Vorgriff, kein Eintrag im ausgelieferten Box-Katalog. Der Pilot steht aus. */
@Component
public class WagoComponentTemplateSeeder {
    private static final Logger log = LoggerFactory.getLogger(WagoComponentTemplateSeeder.class);
    public static final String REF = "certified:wago:pm494_pm495_registerbild_v1";
    private final JdbcTemplate admin;

    public WagoComponentTemplateSeeder(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /**
     * Wie die Bestands-Läufer daneben: ein Fehlschlag wird protokolliert, nicht geworfen. Eine
     * Ausnahme aus einem {@link ApplicationReadyEvent}-Hörer verlässt {@code SpringApplication.run}
     * und beendet die api - eine kurz nicht erreichbare Admin-Rolle würde sonst den Start der
     * ganzen api verhindern. Ohne Vorlage fehlt nur der WAGO-Eintrag im Anlege-Assistenten; der
     * nächste Start legt sie nach.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void seed() {
        try {
            schreibe();
        } catch (RuntimeException e) {
            log.error("WAGO-Vorlage {} konnte beim Start nicht angelegt werden, die api läuft ohne sie "
                    + "weiter (der Anlege-Assistent zeigt die Karte dann nicht): {}", REF, e.toString(), e);
        }
    }

    /** Der Schreibvorgang selbst - für Tests direkt aufrufbar. */
    public void schreibe() {
        // Nur erstmals anlegen: spätere Pilot-Fassungen, Rücknahmen und Belege bleiben erhalten.
        admin.update("""
                INSERT INTO component_template (kind, template_ref, version, brand, brand_label,
                  model, model_label, device_type, family, family_label, communication,
                  communication_label, transport_schema, control_tier, certification_status,
                  certification_note, note, created_by)
                SELECT 'certified', ?, 1, 'wago', 'WAGO', 'pm494_pm495_registerbild_v1',
                  'WAGO 750-494/495 an Registerbild v1', 'meter', 'registerbild_v1',
                  'WAGO Energiekarte', 'modbus_tcp', 'Modbus TCP · VoltPilot-Registerbild WAGO v1',
                  '[{"key":"ip","label":"Adresse","type":"text","required":true},
                    {"key":"port","label":"Port","type":"number","required":true},
                    {"key":"mb_slave_id","label":"Geräte-ID","type":"number","required":true},
                    {"key":"base_address","label":"Basisadresse","type":"number","required":true},
                    {"key":"function_code","label":"Funktionscode","type":"select","required":true,
                     "options":[{"value":"3","label":"3"},{"value":"4","label":"4"}]},
                    {"key":"word_order","label":"Wortfolge","type":"select","required":true,
                     "options":[{"value":"big","label":"Höheres Wort zuerst"},
                                {"value":"little","label":"Niedrigeres Wort zuerst"}]}]'::jsonb,
                  0, 'in_certification', 'Pilotnachweis ausstehend.',
                  '750-494: Messwert-Tabelle und Skalierungsfaktoren zu erheben. '
                  '750-495: Handbuchangaben ersetzen keinen Pilotnachweis. Box-Leser noch nicht freigegeben.',
                  'startup:wago-registerbild-v1'
                WHERE NOT EXISTS (SELECT 1 FROM component_template WHERE template_ref = ?)
                ON CONFLICT (template_ref, version) DO NOTHING
                """, REF, REF);
    }
}
