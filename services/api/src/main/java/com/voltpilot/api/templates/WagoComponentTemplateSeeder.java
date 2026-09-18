package com.voltpilot.api.templates;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Cloud-Vorgriff, kein Eintrag im ausgelieferten Box-Katalog. Der Pilot steht aus. */
@Component
public class WagoComponentTemplateSeeder {
    public static final String REF = "certified:wago:pm494_pm495_registerbild_v1";
    private final JdbcTemplate admin;

    public WagoComponentTemplateSeeder(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void seed() {
        // Nur erstmals anlegen: spätere Pilot-Fassungen, Rücknahmen und Belege bleiben erhalten.
        admin.update("""
                INSERT INTO component_template (kind, template_ref, version, brand, brand_label,
                  model, model_label, device_type, family, family_label, communication,
                  communication_label, transport_schema, control_tier, certification_status,
                  certification_note, note, created_by)
                SELECT 'certified', ?, 1, 'wago', 'WAGO', 'pm494_pm495_registerbild_v1',
                  'WAGO 750-494/495 an Registerbild v1', 'meter', 'registerbild_v1',
                  'WAGO Energiekarte', 'wago_registerbild', 'VoltPilot-Registerbild WAGO v1',
                  '[{"key":"ip","label":"Adresse","type":"text","required":true},
                    {"key":"port","label":"Port","type":"number","required":true},
                    {"key":"unit_id","label":"Geräte-ID","type":"number","required":true},
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
