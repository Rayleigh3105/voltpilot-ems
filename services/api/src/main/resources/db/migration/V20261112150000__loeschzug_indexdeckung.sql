-- =============================================================================
-- V20261112150000 - Löschzug-Indexdeckung I: jede Katalog-Tabelle mit tenant_id
--                   trägt einen Index, der mit tenant_id beginnt (Befund
--                   vp-kunde-loeschen-504, Prod 12.11.2026).
-- -----------------------------------------------------------------------------
-- Der Löschzug zählt vor und nach dem Abbau jede Katalog-Tabelle
-- (`SELECT count(*) … WHERE tenant_id = ?`, KundenbereichLoeschung), die
-- Datenauskunft des Lösch-Dialogs fragt jede mit EXISTS (KundeDatenBestand),
-- und der letzte Schritt löscht über den Katalog (katalogRestLoeschen). Ohne
-- einen mit tenant_id beginnenden Index ist jede dieser Abfragen ein
-- Seq-Scan über die Zeilen ALLER Mandanten - in Produktion lief der Löschzug
-- eines fast leeren Kunden dadurch ~60 s und der Ingress (60-s-Grenze)
-- antwortete 504, obwohl der Zug serverseitig durchlief.
--
-- Hier die gewöhnlichen Tabellen (ein CREATE INDEX je Tabelle, kleine
-- Bestände, transaktional); die Hypertables folgen in V20261112151000 mit
-- timescaledb.transaction_per_chunk. Dazu die Fremdschlüssel OHNE tenant_id
-- unter ihren Spalten, deren Elterntabelle im Löschzug Zeilen verliert: die
-- RI-Prüfung (CASCADE/RESTRICT/SET NULL) sucht je gelöschter Elternzeile über
-- genau diese Spalten - ohne Index ein Seq-Scan je Zeile.
-- Wächter: LoeschzugIndexdeckungTest.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_anlage_netz_vermarktung_tenant ON anlage_netz_vermarktung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_anlage_netzanschluss_tenant ON anlage_netzanschluss (tenant_id);
CREATE INDEX IF NOT EXISTS idx_anlage_standort_tenant ON anlage_standort (tenant_id);
CREATE INDEX IF NOT EXISTS idx_asset_tenant ON asset (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bericht_kennzahl_abwahl_tenant ON bericht_kennzahl_abwahl (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bewertung_aenderung_tenant ON bewertung_aenderung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bezugsbasis_faktor_tenant ON bezugsbasis_faktor (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bezugsbasis_variable_tenant ON bezugsbasis_variable (tenant_id);
CREATE INDEX IF NOT EXISTS idx_box_update_verlauf_tenant ON box_update_verlauf (tenant_id);
CREATE INDEX IF NOT EXISTS idx_cockpit_layout_tenant ON cockpit_layout (tenant_id);
CREATE INDEX IF NOT EXISTS idx_component_activation_outbox_tenant ON component_activation_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_component_change_event_tenant ON component_change_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_component_definition_tenant ON component_definition (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_audit_event_tenant ON consumer_audit_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_override_tenant ON consumer_override (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_policy_tenant ON consumer_policy (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_profile_tenant ON consumer_profile (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_requirement_state_tenant ON consumer_requirement_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consumer_runtime_status_tenant ON consumer_runtime_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_data_source_aenderung_tenant ON data_source_aenderung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_data_source_assignment_tenant ON data_source_assignment (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_tenant ON device (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_battery_control_tenant ON device_battery_control (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_charge_connector_tenant ON device_charge_connector (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_charge_point_tenant ON device_charge_point (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_charging_budget_tenant ON device_charging_budget (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_command_log_tenant ON device_command_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_command_recording_tenant ON device_command_recording (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_component_apply_tenant ON device_component_apply (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_control_status_tenant ON device_control_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_curtailment_status_tenant ON device_curtailment_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_curtailment_unit_tenant ON device_curtailment_unit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_data_source_status_tenant ON device_data_source_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_edge_version_tenant ON device_edge_version (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_measurement_selection_tenant ON device_measurement_selection (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_measurement_selection_event_tenant ON device_measurement_selection_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_override_tenant ON device_override (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_site_assignment_tenant ON device_site_assignment (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_source_status_tenant ON device_source_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_update_status_tenant ON device_update_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_energieeinsatz_einflussgroesse_tenant ON energieeinsatz_einflussgroesse (tenant_id);
CREATE INDEX IF NOT EXISTS idx_energiemanagement_anwendungsbereich_tenant ON energiemanagement_anwendungsbereich (tenant_id);
CREATE INDEX IF NOT EXISTS idx_energiemanagement_person_tenant ON energiemanagement_person (tenant_id);
CREATE INDEX IF NOT EXISTS idx_energiemanagement_teil_vermerk_tenant ON energiemanagement_teil_vermerk (tenant_id);
CREATE INDEX IF NOT EXISTS idx_entity_observed_state_tenant ON entity_observed_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_entity_role_assignment_tenant ON entity_role_assignment (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erzeuger_vorgabe_lauf_tenant ON erzeuger_vorgabe_lauf (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flaeche_gueltigkeit_tenant ON flaeche_gueltigkeit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_claim_tenant ON flow_claim (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_definition_tenant ON flow_definition (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_device_ack_tenant ON flow_device_ack (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_gated_node_enablement_tenant ON flow_gated_node_enablement (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_layout_tenant ON flow_layout (tenant_id);
CREATE INDEX IF NOT EXISTS idx_flow_node_status_tenant ON flow_node_status (tenant_id);
CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_tenant ON forecast_accuracy (tenant_id);
CREATE INDEX IF NOT EXISTS idx_forecast_model_state_tenant ON forecast_model_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_forecast_rueckblick_tenant ON forecast_rueckblick (tenant_id);
CREATE INDEX IF NOT EXISTS idx_funktion_tenant ON funktion (tenant_id);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_tenant ON geraetesuche (tenant_id);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_fund_tenant ON geraetesuche_fund (tenant_id);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_protokoll_tenant ON geraetesuche_protokoll (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kennzahl_aenderung_tenant ON kennzahl_aenderung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_komponente_geraete_rueckfall_tenant ON komponente_geraete_rueckfall (tenant_id);
CREATE INDEX IF NOT EXISTS idx_komponente_haengt_an_tenant ON komponente_haengt_an (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ladepark_netzgrenze_zugestellt_tenant ON ladepark_netzgrenze_zugestellt (tenant_id);
CREATE INDEX IF NOT EXISTS idx_measurement_point_tenant ON measurement_point (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messreihe_periode_version_tenant ON messreihe_periode_version (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messstelle_ort_tenant ON messstelle_ort (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messstelle_prozess_tenant ON messstelle_prozess (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messstelle_quelle_tenant ON messstelle_quelle (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messstelle_stellung_tenant ON messstelle_stellung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messstelle_verteilung_tenant ON messstelle_verteilung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_move_provisioning_operation_tenant ON move_provisioning_operation (tenant_id);
CREATE INDEX IF NOT EXISTS idx_netzanschluss_aenderung_tenant ON netzanschluss_aenderung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_netzanschluss_grenze_tenant ON netzanschluss_grenze (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_action_audit_tenant ON ocpp_action_audit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_action_intent_tenant ON ocpp_action_intent (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_configuration_key_tenant ON ocpp_configuration_key (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_configuration_unknown_key_tenant ON ocpp_configuration_unknown_key (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_connector_state_tenant ON ocpp_connector_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_station_tenant ON ocpp_station (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_station_capability_tenant ON ocpp_station_capability (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_transaction_tenant ON ocpp_transaction (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ort_zuordnung_tenant ON ort_zuordnung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_plan_accuracy_tenant ON plan_accuracy (tenant_id);
CREATE INDEX IF NOT EXISTS idx_plan_zustellung_tenant ON plan_zustellung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_register_write_event_tenant ON register_write_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_rule_event_tenant ON rule_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_rule_event_recording_tenant ON rule_event_recording (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_charge_point_allowlist_tenant ON site_charge_point_allowlist (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_charge_point_priority_tenant ON site_charge_point_priority (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_charge_point_rank_tenant ON site_charge_point_rank (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_charging_config_tenant ON site_charging_config (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_component_template_tenant ON site_component_template (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_forecast_automatik_tenant ON site_forecast_automatik (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_forecast_model_choice_tenant ON site_forecast_model_choice (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_profile_state_tenant ON site_profile_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_scene_tenant ON site_scene (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_suggestion_state_tenant ON site_suggestion_state (tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_vehicle_tag_tenant ON site_vehicle_tag (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerung_vorsprung_tenant ON steuerung_vorsprung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_aenderung_tenant ON steuerungsverbund_aenderung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_anteil_verlust_tenant ON steuerungsverbund_anteil_verlust (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_anteile_tenant ON steuerungsverbund_anteile (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_bilanz_tenant ON steuerungsverbund_bilanz (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_erzeuger_tenant ON steuerungsverbund_erzeuger (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_geraet_tenant ON steuerungsverbund_geraet (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_mitglied_tenant ON steuerungsverbund_mitglied (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_sprungprobe_tenant ON steuerungsverbund_sprungprobe (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_steckerprobe_tenant ON steuerungsverbund_steckerprobe (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_vorbehalt_tenant ON steuerungsverbund_vorbehalt (tenant_id);
CREATE INDEX IF NOT EXISTS idx_telegram_ziel_tenant ON telegram_ziel (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ueberwachung_externer_empfaenger_tenant ON ueberwachung_externer_empfaenger (tenant_id);
CREATE INDEX IF NOT EXISTS idx_unterstuetzung_anfrage_tenant ON unterstuetzung_anfrage (tenant_id);
CREATE INDEX IF NOT EXISTS idx_unterstuetzung_anfrage_standort_tenant ON unterstuetzung_anfrage_standort (tenant_id);
CREATE INDEX IF NOT EXISTS idx_unterstuetzung_hinweis_tenant ON unterstuetzung_hinweis (tenant_id);
CREATE INDEX IF NOT EXISTS idx_vorgang_anstoss_tenant ON vorgang_anstoss (tenant_id);

CREATE INDEX IF NOT EXISTS idx_asset_device_id ON asset (device_id);
CREATE INDEX IF NOT EXISTS idx_box_ausbauen_protokoll_site_id ON box_ausbauen_protokoll (site_id);
CREATE INDEX IF NOT EXISTS idx_box_endgueltig_geloescht_protokoll_site_id ON box_endgueltig_geloescht_protokoll (site_id);
CREATE INDEX IF NOT EXISTS idx_box_loesen_protokoll_site_id ON box_loesen_protokoll (site_id);
CREATE INDEX IF NOT EXISTS idx_device_component_apply_site_id ON device_component_apply (site_id);
CREATE INDEX IF NOT EXISTS idx_einheit_geraet_geraet_teil_id ON einheit_geraet (geraet_teil_id);
CREATE INDEX IF NOT EXISTS idx_einheit_geraet_measurement_point_id ON einheit_geraet (measurement_point_id);
CREATE INDEX IF NOT EXISTS idx_entity_registry_state_device_id ON entity_registry_state (device_id);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_fund_site_id ON geraetesuche_fund (site_id);
CREATE INDEX IF NOT EXISTS idx_measurement_point_device_id ON measurement_point (device_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_action_audit_action_id ON ocpp_action_audit (action_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_sprungprobe_device_id ON steuerungsverbund_sprungprobe (device_id);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_steckerprobe_box_id ON steuerungsverbund_steckerprobe (box_id);
