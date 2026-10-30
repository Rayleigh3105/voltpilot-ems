package com.voltpilot.api.geraetesuche;

import java.util.Locale;
import java.util.Map;

/**
 * Der Produktname zu einem Shelly-Modellcode, wie die Box ihn meldet ({@code /shelly}: Gen2+ {@code model}, Gen1
 * {@code type}). Nur Codes, die Shelly selbst einem Namen zuordnet; jeder andere Code bleibt, wie er ist (kein
 * erfundener Name).
 *
 * <p>Quellen: Gen1 die eingecheckte API-Dokumentation {@code catalog/measurement-points/sources/shelly/raw/gen1.html}
 * (CoIoT-Beispiele „Shelly 1 SHSW-1“ usw.); Gen2+ die Zeile „Device model“ der Gerät-Seiten in der Shelly-Knowledge-Base
 * ({@code https://kb.shelly.cloud/knowledge-base/<seite>}, gelesen am 30.10.2026). Die v.0-Codes der Pro-Reihe nennt
 * die Seite ihrer v.1 („a modification of Shelly Pro 1 (SPSW-001XE16EU)“).
 */
public final class ShellyModellnamen {

    private static final Map<String, String> NAMEN = Map.ofEntries(
            // Gen1: gen1.html
            Map.entry("SHSW-1", "Shelly 1"),
            Map.entry("SHSW-PM", "Shelly 1PM"),
            Map.entry("SHSW-L", "Shelly 1L"),
            Map.entry("SHSW-25", "Shelly 2.5"),
            Map.entry("SHPLG-1", "Shelly Plug"),
            Map.entry("SHPLG-S", "Shelly Plug S"),
            Map.entry("SHPLG-U1", "Shelly Plug US"),
            Map.entry("SHPLG2-1", "Shelly Plug E"),
            Map.entry("SHEM", "Shelly EM"),
            Map.entry("SHEM-3", "Shelly 3EM"),
            // Gen2 Pro: shelly-pro-3-v1, shelly-pro-1-v1, shelly-pro-1pm-v1, shelly-pro-2-v1, shelly-pro-2pm-v1,
            // shelly-pro-4pm, shelly-pro-4pm-v2, shelly-pro-3em, shelly-pro-3em-400, shelly-pro-em-50
            Map.entry("SPSW-003XE16EU", "Shelly Pro 3"),
            Map.entry("SPSW-001XE16EU", "Shelly Pro 1"),
            Map.entry("SPSW-201XE16EU", "Shelly Pro 1"),
            Map.entry("SPSW-001PE16EU", "Shelly Pro 1PM"),
            Map.entry("SPSW-201PE16EU", "Shelly Pro 1PM"),
            Map.entry("SPSW-002XE16EU", "Shelly Pro 2"),
            Map.entry("SPSW-202XE16EU", "Shelly Pro 2"),
            Map.entry("SPSW-002PE16EU", "Shelly Pro 2PM"),
            Map.entry("SPSW-202PE16EU", "Shelly Pro 2PM"),
            Map.entry("SPSW-004PE16EU", "Shelly Pro 4PM"),
            Map.entry("SPSW-104PE16EU", "Shelly Pro 4PM"),
            Map.entry("SPEM-003CEBEU", "Shelly Pro 3EM"),
            Map.entry("SPEM-003CEBEU400", "Shelly Pro 3EM-400"),
            Map.entry("SPEM-002CEBEU50", "Shelly Pro EM-50"),
            // Gen2 Plus: shelly-plus-1, shelly-plus-1pm, shelly-plus-2pm, shelly-plus-plug-s, shelly-plus-pm-mini,
            // shelly-plus-1-mini, shelly-plus-1pm-mini
            Map.entry("SNSW-001X16EU", "Shelly Plus 1"),
            Map.entry("SNSW-001P16EU", "Shelly Plus 1PM"),
            Map.entry("SNSW-002P16EU", "Shelly Plus 2PM"),
            Map.entry("SNPL-00112EU", "Shelly Plus Plug S"),
            Map.entry("SNPM-001PCEU16", "Shelly Plus PM Mini"),
            Map.entry("SNSW-001X8EU", "Shelly Plus 1 Mini"),
            Map.entry("SNSW-001P8EU", "Shelly Plus 1PM Mini"),
            // Gen3: shelly-1-gen3, shelly-1pm-gen3, shelly-em-gen3, shelly-3em-63-gen3
            Map.entry("S3SW-001X16EU", "Shelly 1 Gen3"),
            Map.entry("S3SW-001P16EU", "Shelly 1PM Gen3"),
            Map.entry("S3EM-002CXCEU", "Shelly EM Gen3"),
            Map.entry("S3EM-003CXCEU63", "Shelly 3EM-63 Gen3"));

    private ShellyModellnamen() {
    }

    /** Der Produktname eines Shelly-Fundes; null, wenn er kein Shelly ist oder Shelly den Code nicht nennt. */
    public static String name(GeraetesucheBericht.Fund fund) {
        if (!"shelly".equalsIgnoreCase(fund.hersteller()) || fund.modell() == null) {
            return null;
        }
        return NAMEN.get(fund.modell().trim().toUpperCase(Locale.ROOT));
    }
}
