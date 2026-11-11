package com.voltpilot.api.kundenbereich;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Die EINE Stelle, die „keine Daten" für das SOFORTIGE Löschen eines Kundenbereichs festlegt
 * (vp-kunde-sofort-loeschen; Captain 11.11.2026: einen doppelt angelegten Kunden ohne Datenbestand
 * sofort endgültig löschen können, aktiv oder beendet, ohne Frist) - nach dem Muster von
 * {@code geraete/BoxDatenBestand}. Jede Tabelle mit einer Spalte {@code tenant_id} ist hier GENAU
 * EINER von zwei Klassen zugeordnet; {@code KundeDatenBestandMigrationTest} hält die Zuordnung gegen
 * das tatsächliche Schema vollständig - eine NEUE Tabelle ohne Eintrag macht den Test rot. Im
 * Zweifel gilt ein Kunde als „hat Daten": zweifelhafte Tabellen stehen in {@link #AUFZEICHNUNGEN},
 * nie in {@link #BESTAND_UNBEDENKLICH}.
 *
 * <ul>
 *   <li>{@link #AUFZEICHNUNGEN}: eine Zeile heißt „der Kunde hat Daten" - das sofortige Löschen
 *       wird abgelehnt, es bleibt bei der Frist nach dem Vertragsende (IP-18). Dazu zählt alles,
 *       was der Betrieb aufgezeichnet hat (Messwerte, Meldungen, Befehls- und OCPP-Verläufe) und
 *       jeder vom Kunden geschaffene Inhalt seiner UEMS-Welt (Messstellen, Messreihen-Bearbeitung,
 *       Bezugsdaten, Kennzahlen, Berichte, Nachweise) - das, was er über den Gesamtabzug (IP-17)
 *       herunterladen könnte und beim Löschen verlöre.</li>
 *   <li>{@link #BESTAND_UNBEDENKLICH}: Stammdaten, Einstellungen, Absicht und Verwaltungs-
 *       Buchführung - entsteht beim Einrichten durch den Betrieb oder von selbst (Läufer,
 *       Auto-Komposition, Wetter-/Prognose-Zyklen) und ist keine Aufzeichnung, die der Kunde
 *       verlieren könnte. Der Grund steht je Tabelle daneben.</li>
 * </ul>
 *
 * <p>Dazu kommt die Datenart {@link #HERZSCHLAG} außerhalb der Tabellen-Sicht: hat IRGENDEINE Box
 * des Kunden sich je gemeldet ({@code device.device_status_seen_at}, {@code lan_seen_at}), hat der
 * Kunde Daten - dieselbe Regel wie {@code BoxDatenBestand}, über alle Boxen (auch ausgebaute).
 */
public final class KundeDatenBestand {

    private KundeDatenBestand() {
    }

    /** Datenart {@code herzschlag}: eine Box des Kunden hat sich je gemeldet (Zustand oder LAN-Adresse). */
    public static final String HERZSCHLAG = "herzschlag";

    /**
     * Die Aufzeichnungen je Datenart, in der Reihenfolge der 409-Liste. Jede Tabelle trägt
     * {@code tenant_id}; eine Zeile macht den Kunden sofort unlöschbar (Frist bleibt).
     */
    public static final Map<String, List<String>> AUFZEICHNUNGEN = aufzeichnungen();

    private static Map<String, List<String>> aufzeichnungen() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("messwerte", List.of("telemetry", "telemetry_rollup_15m", "telemetry_rollup_1h",
                "telemetry_rollup_1d", "telemetry_v2", "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h",
                "telemetry_v2_rollup_1d", "device_measurement_sample", "device_measurement_event",
                "device_measurement_point_state", "device_measurement_rollup_5m",
                "device_measurement_rollup_15m", "bilanzwert_eingang"));
        m.put("messreihen", List.of("messreihe_berechnet_stand", "messreihe_ereignis", "messreihe_ersatzwert",
                "messreihe_ersatzwert_wirkung", "messreihe_kaskade_wirkung", "messreihe_korrektur",
                "messreihe_korrektur_vorschlag", "messreihe_luecke_stand", "messreihe_periode",
                "messreihe_periode_arbeit", "messreihe_periode_version", "messreihe_tag", "messreihe_tag_arbeit",
                "messreihe_viertelstunde", "messreihe_viertelstunde_arbeit", "messreihe_viertelstunde_version",
                "messstelle_ablesung_fassung"));
        // Die Messpunkt-Auswahl ist eine Einstellung, ihre Historie eine Aufzeichnung - dieselbe
        // Einordnung wie BoxDatenBestand (im Zweifel „hat Daten").
        m.put("messauswahl", List.of("device_measurement_selection", "device_measurement_selection_event"));
        m.put("meldungen", List.of("device_edge_version", "device_update_status", "box_update_verlauf",
                "registerbild_fassung"));
        m.put("befehle", List.of("device_command_log", "device_command_recording", "register_write_event",
                "ocpp_action", "ocpp_action_intent", "ocpp_action_audit", "erzeuger_vorgabe_lauf",
                "erzeuger_vorgabe_luecke", "rule_event", "rule_event_recording", "consumer_audit_event"));
        m.put("ocpp", List.of("ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                "ocpp_configuration_unknown_key", "ocpp_station_capability"));
        m.put("rueckmeldungen", List.of("device_control_status", "device_curtailment_status",
                "device_curtailment_unit", "device_source_status", "device_data_source_status",
                "consumer_runtime_status", "consumer_requirement_state", "device_battery_control",
                "device_charge_connector", "device_charge_point", "device_charging_budget", "flow_device_ack",
                "flow_node_status", "data_source_box_receipt", "wechselrichter_untergrenze",
                "steuerungsverbund_mitglied", "steuerungsverbund_geraet", "steuerungsverbund_anteil_verlust",
                "steuerungsverbund_sprungprobe", "steuerungsverbund_steckerprobe", "steuerungsverbund_bilanz",
                "steuerung_vorsprung"));
        m.put("komponenten", List.of("entity_observed_state", "device_component_apply"));
        m.put("auswertungen", List.of("forecast_accuracy", "plan_accuracy", "forecast_rueckblick",
                "taeglicher_rueckblick", "auffaelligkeit"));
        m.put("erloese", List.of("schedule_savings_1d"));
        m.put("alarme", List.of("alarm", "alarm_verlauf", "benachrichtigung"));
        m.put("messstellen", List.of("messstelle", "messstelle_aenderung", "messstelle_formel_fassung",
                "messstelle_formel_term", "messstelle_groesse", "messstelle_kennzeichen", "messstelle_ort",
                "messstelle_prozess", "messstelle_quelle", "messstelle_stellung", "messstelle_verteilung",
                "messbedarf", "messbedarf_aenderung"));
        m.put("bezugsdaten", List.of("bezugsbasis", "bezugsbasis_aenderung", "bezugsbasis_anstoss",
                "bezugsbasis_faktor", "bezugsbasis_fassung", "bezugsbasis_variable", "bezugsdaten_import",
                "bezugsdaten_import_freigabe", "bezugsdaten_import_zeile", "bezugsdaten_vorlage",
                "bezugsdaten_vorlage_bezug", "bezugsgroesse", "bezugsgroesse_aenderung",
                "bezugsgroesse_berichtigung", "bezugsgroesse_kanalbindung", "bezugsgroesse_kanallauf",
                "bezugsgroesse_kennzeichen_verlauf", "bezugsgroesse_stammdatum", "bezugsgroesse_wert",
                "bezugsgroesse_wetterbezug"));
        m.put("kennzahlen", List.of("kennzahl", "kennzahl_aenderung", "kennzahl_eingang", "kennzahl_fassung",
                "kennzahl_kennzeichen_verlauf", "kennzahl_wert", "kennzahl_wert_eingang"));
        m.put("berichte", List.of("bericht", "bericht_abruf", "bericht_aenderung", "bericht_entwurf",
                "bericht_kennzahl_abwahl", "bericht_quelle", "bericht_revision_anstoss", "bericht_stand"));
        m.put("nachweise", List.of("abweichung", "abweichung_aenderung", "bewertung_aenderung",
                "bewertung_kriterien_fassung", "bewertung_umfang", "bewertung_umfang_ausschluss",
                "bewertung_umfang_standort", "energiemanagement_aenderung", "energiemanagement_anwendungsbereich",
                "energiemanagement_aufgabe", "energiemanagement_dokument", "energiemanagement_dokument_eintrag",
                "energiemanagement_dokument_fassung", "energiemanagement_einstellung", "energiemanagement_mappe",
                "energiemanagement_mappe_abruf", "energiemanagement_person", "energiemanagement_teil_vermerk",
                "energieziel", "energieziel_aenderung", "feststellung", "feststellung_eintrag",
                "feststellung_wirksamkeit", "internes_audit", "internes_audit_eintrag",
                "managementbewertung_beschluss", "managementbewertung_folge", "managementbewertung_sitzung",
                "massnahme", "massnahme_aenderung", "massnahme_bewertung", "vorgang_anstoss"));
        // Vom Kunden aufgebaute UEMS-Struktur (Geräte, Prozesse, Netzanschlüsse, Energieeinsätze):
        // kein Messwert, aber sein Arbeitsstand im Verzeichnis des Energiemanagements - im Zweifel Daten.
        m.put("uems_struktur", List.of("anlage_netzanschluss", "energieeinsatz", "energieeinsatz_aenderung",
                "energieeinsatz_einflussgroesse", "energieeinsatz_einstufung", "flaeche_gueltigkeit", "funktion",
                "funktion_teilnahme", "geraet", "geraet_aenderung", "geraet_komponente", "geraet_teil",
                "komponente_geraete_rueckfall", "komponente_haengt_an", "kostenstelle", "netzanschluss",
                "netzanschluss_aenderung", "netzanschluss_grenze", "netzanschluss_kennzeichen",
                "netzanschluss_vorschlag_entscheidung", "prozess"));
        // LinkedHashMap, nicht Map.copyOf: die Reihenfolge IST die Reihenfolge der 409-Liste.
        return Collections.unmodifiableMap(m);
    }

    /**
     * Stammdaten, Einstellungen, Absicht, Verwaltungs-Buchführung: darf mit dem Kunden sofort gehen
     * (Grund je Tabelle). Vieles hiervon entsteht ohne jedes Zutun des Kunden - beim Einrichten durch
     * den Betrieb, durch Läufer (Überwachung ab Werk, Standort-Anlage) oder Zyklen (Wetter, Prognose,
     * Planung) - und dürfte das sofortige Löschen eines datenfreien Kunden nie verhindern.
     */
    public static final Map<String, String> BESTAND_UNBEDENKLICH = bestand();

    private static Map<String, String> bestand() {
        Map<String, String> m = new LinkedHashMap<>();
        String stammdaten = "Stammdaten/Topologie - vom Betrieb oder beim Verbinden angelegt";
        for (String t : List.of("site", "device", "asset", "measurement_point", "entity_registry_state",
                "entity_role_assignment", "unternehmen", "standort", "anlage_standort", "ort", "ort_kurzzeichen",
                "ort_zuordnung", "data_source", "component_definition", "site_component_template")) {
            m.put(t, stammdaten);
        }
        // Messkonzepte S1 (nur Anzeige): EA 1 entsteht beim Einrichten von selbst aus der PV-Leistung der Anlage
        // (ErzeugungsanlageBestand) - wie `asset`, aus dem sie folgt. Als Aufzeichnung hielte sie jeden doppelt
        // angelegten Kunden mit eingetragener PV fest.
        String erzeugungsanlage = "Stammdaten der Erzeugungsanlagen samt Protokoll - EA 1 entsteht beim Einrichten aus "
                + "der PV-Leistung";
        for (String t : List.of("erzeugungsanlage", "erzeugungsanlage_fassung", "erzeugungsanlage_komponente",
                "erzeugungsanlage_aenderung")) {
            m.put(t, erzeugungsanlage);
        }
        String einstellung = "Einstellung/Absicht der Cloud - keine Aufzeichnung, wird mit dem Kunden hinfällig";
        for (String t : List.of("device_override", "consumer_override", "consumer_policy", "consumer_profile",
                "flow_definition", "flow_claim", "flow_layout", "flow_gated_node_enablement", "cockpit_layout",
                "site_scene", "site_suggestion_state", "site_profile_state", "site_forecast_automatik",
                "site_forecast_model_choice", "site_charge_point_allowlist", "site_charge_point_priority",
                "site_charge_point_rank", "site_charging_config", "site_supply_price", "site_vehicle_tag",
                "quelle_einstellung", "quelle_kadenz", "erzeuger_vorgabe", "anlage_netz_vermarktung",
                "component_activation_outbox", "move_provisioning_operation", "ladepark_netzgrenze_zugestellt")) {
            m.put(t, einstellung);
        }
        String verbundConfig = "Steuerungsverbund-Einstellung (Laufzeit-Nachweise stehen unter 'rueckmeldungen')";
        for (String t : List.of("steuerungsverbund", "steuerungsverbund_aenderung", "steuerungsverbund_anteile",
                "steuerungsverbund_erzeuger", "steuerungsverbund_vorbehalt")) {
            m.put(t, verbundConfig);
        }
        String zyklus = "Von Zyklen erzeugt und laufend ersetzt (Wetter/Prognose/Planung) - kein Verlust";
        for (String t : List.of("forecast", "forecast_model_state", "forecast_weekly", "weather_forecast",
                "schedule", "site_plan_run", "entity_plan_slot", "plan_zustellung")) {
            m.put(t, zyklus);
        }
        String ueberwachungConfig = "Überwachungs-/Zustell-Einstellung (ab Werk vom Läufer gesät); Alarme stehen "
                + "unter 'alarme'";
        for (String t : List.of("ueberwachung", "ueberwachung_instanz", "ueberwachung_externer_empfaenger",
                "zustellweg", "telegram_ziel", "webhook_ziel", "push_abo", "stummschaltung", "ruhezeit_person",
                "vergleich_toleranz")) {
            m.put(t, ueberwachungConfig);
        }
        String verwaltung = "Verwaltungs-Buchführung des Betriebs - Konten, Zugriff, Vertragsübergänge";
        for (String t : List.of("benutzer", "zugriff", "zugriff_bestand", "zugriff_protokoll",
                "unterstuetzung_anfrage", "unterstuetzung_anfrage_standort", "unterstuetzung_hinweis",
                "anfrage_kennung", "kundenbereich_uebergang", "kundenbereich_abzug", "standort_vorschlag")) {
            m.put(t, verwaltung);
        }
        String protokoll = "Plattform-/Struktur-Protokoll ohne Kundeninhalt - der Löschweg behandelt es selbst";
        for (String t : List.of("box_loesen_protokoll", "box_endgueltig_geloescht_protokoll",
                "box_ausbauen_protokoll", "ort_aenderung",
                "data_source_aenderung", "data_source_assignment", "data_source_handover", "component_change_event",
                "device_site_assignment", "device_succession", "geraetesuche", "geraetesuche_fund",
                "geraetesuche_protokoll")) {
            m.put(t, protokoll);
        }
        String zaehler = "Kennzeichen-/Nummern-Zähler - Buchführung, kein Inhalt";
        for (String t : List.of("alarm_kennzeichen_lauf", "bericht_kennung_seq", "bezugsbasis_kennzeichen_seq",
                "data_source_kennzeichen_seq", "energieeinsatz_kennzeichen_seq", "energiemanagement_kennung_seq",
                "geraet_kennzeichen_seq", "messbedarf_kennzeichen_seq", "messstelle_kennzeichen_seq",
                "netzanschluss_kennzeichen_seq", "ort_kurzzeichen_seq", "verbesserung_kennung_seq")) {
            m.put(t, zaehler);
        }
        return Collections.unmodifiableMap(m);
    }

    /** Jede hier eingeordnete Tabelle, für den Vollständigkeits-Test. */
    public static Set<String> alleEingeordneten() {
        var alle = new TreeSet<String>();
        AUFZEICHNUNGEN.values().forEach(alle::addAll);
        alle.addAll(BESTAND_UNBEDENKLICH.keySet());
        return alle;
    }

    /**
     * EIN Statement für den ganzen Bestand: je Datenart ein OR über die EXISTS ihrer Tabellen,
     * {@code herzschlag} über alle Boxen des Kunden (auch ausgebaute), dazu der Zustand „beendet"
     * aus der Mandantenzeile selbst. Ohne WHERE liefert es jede Kundenzeile (Liste); der Aufrufer
     * hängt {@code WHERE t.id = ?} für einen einzelnen Kunden an.
     */
    public static String abfrage() {
        StringBuilder sql = new StringBuilder("""
                SELECT t.id AS tenant_id, t.name, t.beendet_am, t.beendet_frist_tage, t.beendet_von,
                       EXISTS (SELECT 1 FROM device d WHERE d.tenant_id = t.id
                               AND (d.device_status_seen_at IS NOT NULL OR d.lan_seen_at IS NOT NULL)) AS herzschlag""");
        AUFZEICHNUNGEN.forEach((datenart, tabellen) -> {
            sql.append(",\n       (");
            for (int i = 0; i < tabellen.size(); i++) {
                if (i > 0) {
                    sql.append("\n        OR ");
                }
                sql.append("EXISTS (SELECT 1 FROM ").append(tabellen.get(i))
                        .append(" x WHERE x.tenant_id = t.id)");
            }
            sql.append(") AS ").append(datenart);
        });
        sql.append("\n  FROM tenant t\n");
        return sql.toString();
    }
}
