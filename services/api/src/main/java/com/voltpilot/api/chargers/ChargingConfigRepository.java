package com.voltpilot.api.chargers;

import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.LadeparkRahmenDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.WallboxDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die im Portal gepflegte Lastmanagement-Konfiguration (Migration
 * V20260829000000): eine Zeile je Anlage plus die VORRANG-Menge je Säule.
 * RLS-gefenced wie alle Kundendaten einer Anlage.
 *
 * <p>Der Vorrang ist eine MENGE, und die ANWESENHEIT der Zeile IST die Aussage
 * (das {@code device_control_activation}-Muster) - kein {@code priority}-Flag,
 * das auf false stehen und trotzdem Historie vortäuschen könnte.
 */
@Repository
public class ChargingConfigRepository {

    /** Der Deckel des Kontrakts fuer die Grabstein-Liste. */
    private static final int MAX_REMOVED = 64;

    private final JdbcTemplate jdbc;

    public ChargingConfigRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public String ocppControl(UUID siteId) {
        return jdbc.query("SELECT ocpp_control::text FROM site_charging_config WHERE site_id = ?",
                (rs, n) -> rs.getString(1), siteId).stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    @Transactional
    public boolean saveOcppControl(UUID tenantId, UUID siteId, String value, long expectedRevision, String actor) {
        jdbc.update("INSERT INTO site_charging_config(site_id, tenant_id) VALUES (?, ?) ON CONFLICT (site_id) DO NOTHING", siteId, tenantId);
        return jdbc.update("UPDATE site_charging_config SET ocpp_control = ?::jsonb, updated_at = now(), updated_by = ? "
                + "WHERE site_id = ? AND COALESCE((ocpp_control->>'revision')::bigint, 0) = ?",
                value, actor, siteId, expectedRevision) == 1;
    }

    /** Die gepflegte Konfiguration; leere Felder = noch nichts gepflegt. */
    public ChargingConfigDto forSite(UUID siteId) {
        List<Object[]> head = jdbc.query(
                "SELECT grid_limit_kw, surplus_policy, storage_priority, house_reserve_kw, "
                        + "margin_pct, min_power_kw, rotation_minutes, max_house_load_kw, "
                        + "static_budget, storage_rank, updated_at, updated_by "
                        + "FROM site_charging_config WHERE site_id = ?",
                (rs, n) -> new Object[] {rs.getObject("grid_limit_kw"),
                        rs.getTimestamp("updated_at"), rs.getString("updated_by"),
                        rs.getString("surplus_policy"), rs.getString("storage_priority"),
                        new LadeparkRahmenDto(dbl(rs.getObject("house_reserve_kw")),
                                dbl(rs.getObject("margin_pct")), dbl(rs.getObject("min_power_kw")),
                                (Integer) rs.getObject("rotation_minutes"),
                                dbl(rs.getObject("max_house_load_kw")),
                                (Boolean) rs.getObject("static_budget")),
                        (Integer) rs.getObject("storage_rank")},
                siteId);
        List<String> priorities = jdbc.query(
                "SELECT charge_point_id FROM site_charge_point_priority WHERE site_id = ? "
                        + "ORDER BY charge_point_id",
                (rs, n) -> rs.getString("charge_point_id"), siteId);
        List<AllowedChargePointDto> allowed = allowlist(siteId);
        List<String> removed = removedChargePointIds(siteId);
        List<WallboxDto> wallboxes = wallboxes(siteId);
        if (head.isEmpty()) {
            return new ChargingConfigDto(null, List.copyOf(priorities), null, null, allowed,
                    removed, null, null, wallboxes, null, null);
        }
        Object[] row = head.get(0);
        Timestamp at = (Timestamp) row[1];
        LadeparkRahmenDto frame = (LadeparkRahmenDto) row[5];
        return new ChargingConfigDto((Double) row[0], List.copyOf(priorities),
                (String) row[3], (String) row[4], allowed, removed,
                // ⚠ Ein Rahmen, zu dem NICHTS gepflegt ist, wird als null
                // gemeldet - nie als Objekt aus lauter Nullen: „das Portal
                // sagt dazu nichts" ist eine Aussage, sechs leere Felder sind
                // eine Behauptung ueber sechs Zahlen.
                frame.leer() ? null : frame, (Integer) row[6], wallboxes,
                at == null ? null : at.toInstant(), (String) row[2]);
    }

    /** Die eingetragenen Kennungen dieser Anlage (aelteste zuerst). */
    public List<AllowedChargePointDto> allowlist(UUID siteId) {
        return List.copyOf(jdbc.query(
                // ⚠ Der Rang wohnt in einer EIGENEN Tabelle und wird hier nur
                // MITGELESEN: die Allowlist ist die ZULASSUNG, die Rangliste
                // die Reihenfolge - eine Zeile hier anzulegen, weil jemand
                // sortiert hat, waere eine Zulassung als Nebenwirkung.
                "SELECT a.charge_point_id, a.label, a.rated_kw, a.connectors, a.source, "
                        + "a.min_kw, a.connection, r.rank, a.added_at, a.added_by "
                        + "FROM site_charge_point_allowlist a "
                        + "LEFT JOIN site_charge_point_rank r "
                        + "ON r.site_id = a.site_id AND r.charge_point_id = a.charge_point_id "
                        + "WHERE a.site_id = ? AND a.removed_at IS NULL "
                        + "ORDER BY a.added_at, a.charge_point_id",
                (rs, n) -> new AllowedChargePointDto(rs.getString("charge_point_id"),
                        rs.getString("label"), dbl(rs.getObject("rated_kw")),
                        (Integer) rs.getObject("connectors"), rs.getString("source"),
                        dbl(rs.getObject("min_kw")), rs.getString("connection"),
                        (Integer) rs.getObject("rank"),
                        rs.getTimestamp("added_at") == null ? null
                                : rs.getTimestamp("added_at").toInstant(),
                        rs.getString("added_by")),
                siteId));
    }

    /**
     * Die zurueckgenommenen Kennungen dieser Anlage - die GRABSTEIN-Liste, die
     * in jedem folgenden Dokument mitreist (neueste zuerst).
     *
     * <p>⚠ Sie ist gedeckelt wie die Allowlist selbst: der Kontrakt traegt
     * hoechstens so viele Zeilen, und was hier still wegfiele, kaeme bei der Box
     * nie an. Gekappt wird deshalb die AELTESTE Ruecknahme - eine Loeschung, die
     * so lange her ist, hat jede lebende Box laengst gesehen.
     */
    public List<String> removedChargePointIds(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT charge_point_id FROM site_charge_point_allowlist WHERE site_id = ? "
                        + "AND removed_at IS NOT NULL ORDER BY removed_at DESC, charge_point_id "
                        + "LIMIT " + MAX_REMOVED,
                (rs, n) -> rs.getString("charge_point_id"), siteId));
    }

    /**
     * Traegt eine Kennung ein bzw. frischt ihre Angaben auf.
     *
     * <p>⚠ Ein erneutes Eintragen BELEBT eine zurueckgenommene Zeile wieder
     * ({@code removed_at = NULL}) - sie verschwindet damit aus der
     * Grabstein-Liste und steht wieder in {@code charge_points}. Eine Kennung
     * steht deshalb nie in beiden Listen.
     */
    @Transactional
    public void admitChargePoint(UUID tenantId, UUID siteId, String chargePointId, String label,
            Double ratedKw, Integer connectors, String source, Double minKw, String connection,
            String actor) {
        jdbc.update("INSERT INTO site_charge_point_allowlist (site_id, charge_point_id, tenant_id, "
                + "label, rated_kw, connectors, source, min_kw, connection, added_at, added_by) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id, charge_point_id) DO UPDATE SET "
                + "label = COALESCE(EXCLUDED.label, site_charge_point_allowlist.label), "
                + "rated_kw = COALESCE(EXCLUDED.rated_kw, site_charge_point_allowlist.rated_kw), "
                + "connectors = COALESCE(EXCLUDED.connectors, "
                + "site_charge_point_allowlist.connectors), "
                // ⚠ Der Anschluss folgt derselben COALESCE-Regel wie die
                // anderen Angaben (nicht gesagt = behalten), ist aber die EINE,
                // die auch auf der BOX ueberschreibt: dort hat er gar keine
                // Oberflaeche, es gibt also nichts zu schuetzen, und ein Kunde,
                // der ihn spaeter aendert, erreichte die Box sonst nie.
                + "connection = COALESCE(EXCLUDED.connection, "
                + "site_charge_point_allowlist.connection), "
                // ⚠ Die STEUERART folgt derselben Regel: nicht gesagt =
                // behalten. Sie ist wie der Anschluss eine, die auch auf der
                // BOX ueberschreibt - dort gibt es fuer sie keine Oberflaeche,
                // es ist also nichts zu schuetzen, und ein Kunde, der seine
                // Quelle spaeter aendert, erreichte die Box sonst nie.
                + "source = COALESCE(EXCLUDED.source, site_charge_point_allowlist.source), "
                + "min_kw = COALESCE(EXCLUDED.min_kw, site_charge_point_allowlist.min_kw), "
                + "removed_at = NULL, removed_by = NULL",
                siteId, chargePointId, tenantId, label, ratedKw, connectors, source, minKw,
                connection, Timestamp.from(Instant.now()), actor);
    }

    /**
     * Nimmt eine Kennung zurueck - als GRABSTEIN, nicht als Loeschung.
     *
     * <p>⚠ Die Zeile BLEIBT stehen. Das retained Dokument wird als Ganzes
     * ersetzt, also wuerde eine Kennung nur wegzulassen von einer Box, die
     * gerade offline war, nie gesehen ({@code charge_points} fuegt nur hinzu).
     * Die Ruecknahme muss deshalb dauerhaft gefuehrt und in jedem folgenden
     * Dokument genannt werden.
     *
     * <p>Idempotent: eine schon zurueckgenommene Kennung behaelt ihren ersten
     * Stempel (die Papier-Spur nennt, wer sie WIRKLICH entfernt hat).
     *
     * @return true, wenn diese Kennung eingetragen WAR
     */
    @Transactional
    public boolean removeChargePoint(UUID siteId, String chargePointId, String actor) {
        return jdbc.update("UPDATE site_charge_point_allowlist SET removed_at = ?, removed_by = ? "
                + "WHERE site_id = ? AND charge_point_id = ? AND removed_at IS NULL",
                Timestamp.from(Instant.now()), actor, siteId, chargePointId) > 0;
    }

    /** Setzt die Anschlussgrenze (Upsert, mit Papier-Spur wer und wann). */
    @Transactional
    public void saveGridLimit(UUID tenantId, UUID siteId, double gridLimitKw, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw, "
                + "updated_at, updated_by) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET grid_limit_kw = EXCLUDED.grid_limit_kw, "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, gridLimitKw, Timestamp.from(Instant.now()), actor);
    }

    /**
     * Setzt die QUELLEN-Wahl (Stufe 4). Beide Felder sind einzeln optional:
     * null heißt „dazu sagt der Kunde nichts" und der gespeicherte Wert bleibt
     * stehen - dieselbe PATCH-Semantik wie überall auf diesem Pfad.
     */
    @Transactional
    public void saveSourceChoice(UUID tenantId, UUID siteId, String surplusPolicy,
            String storagePriority, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, surplus_policy, "
                + "storage_priority, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET "
                + "surplus_policy = COALESCE(EXCLUDED.surplus_policy, site_charging_config.surplus_policy), "
                + "storage_priority = COALESCE(EXCLUDED.storage_priority, site_charging_config.storage_priority), "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, surplusPolicy, storagePriority, Timestamp.from(Instant.now()),
                actor);
    }

    /**
     * Setzt die STEUERART einer eingetragenen Säule (P5). Beide Felder sind
     * einzeln optional - dieselbe PATCH-Regel wie überall auf diesem Pfad.
     *
     * @return true, wenn diese Kennung eingetragen IST (eine unbekannte oder
     *         zurückgenommene Säule wird NICHT still angelegt: das Eintragen ist
     *         eine eigene, bewusste Handlung)
     */
    @Transactional
    public boolean saveChargePointSource(UUID siteId, String chargePointId, String source,
            Double minKw) {
        return jdbc.update("UPDATE site_charge_point_allowlist SET "
                + "source = COALESCE(?, source), min_kw = COALESCE(?, min_kw) "
                + "WHERE site_id = ? AND charge_point_id = ? AND removed_at IS NULL",
                source, minKw, siteId, chargePointId) > 0;
    }

    /**
     * Setzt den Ladepark-RAHMEN (P5/E10). Jedes Feld einzeln optional: null =
     * „dazu sagt das Portal nichts" und der gespeicherte Wert bleibt stehen.
     */
    @Transactional
    public void saveFrame(UUID tenantId, UUID siteId, LadeparkRahmenDto frame, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, house_reserve_kw, "
                + "margin_pct, min_power_kw, rotation_minutes, max_house_load_kw, static_budget, "
                + "updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET "
                + "house_reserve_kw = COALESCE(EXCLUDED.house_reserve_kw, "
                + "site_charging_config.house_reserve_kw), "
                + "margin_pct = COALESCE(EXCLUDED.margin_pct, site_charging_config.margin_pct), "
                + "min_power_kw = COALESCE(EXCLUDED.min_power_kw, "
                + "site_charging_config.min_power_kw), "
                + "rotation_minutes = COALESCE(EXCLUDED.rotation_minutes, "
                + "site_charging_config.rotation_minutes), "
                + "max_house_load_kw = COALESCE(EXCLUDED.max_house_load_kw, "
                + "site_charging_config.max_house_load_kw), "
                + "static_budget = COALESCE(EXCLUDED.static_budget, "
                + "site_charging_config.static_budget), "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, frame.houseReserveKw(), frame.marginPct(), frame.minPowerKw(),
                frame.rotationMinutes(), frame.maxHouseLoadKw(), frame.staticBudget(),
                Timestamp.from(Instant.now()), actor);
    }

    /**
     * NUMERIC kommt als BigDecimal zurück, nicht als Double - ein blindes
     * {@code (Double) rs.getObject(...)} wirft dort eine ClassCastException.
     */
    private static Double dbl(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof BigDecimal b) {
            return b.doubleValue();
        }
        return ((Number) v).doubleValue();
    }

    /** Ersetzt die Vorrang-Menge (leer = ausdrücklich keine Vorrang-Säule). */
    @Transactional
    public void replacePriorities(UUID tenantId, UUID siteId, List<String> chargePointIds) {
        jdbc.update("DELETE FROM site_charge_point_priority WHERE site_id = ?", siteId);
        for (String id : chargePointIds) {
            jdbc.update("INSERT INTO site_charge_point_priority (site_id, charge_point_id, "
                    + "tenant_id) VALUES (?, ?, ?)", siteId, id, tenantId);
        }
    }

    /**
     * Die WALLBOXEN dieser Anlage (P6) - v2-Verbraucher vom Typ {@code wallbox},
     * die dem Ladepark-Rahmen als virtuelle Sitzung beitreten.
     *
     * <p><b>⚠ Gefiltert wird NUR ueber den Typ, nicht ueber „ist sie gerade
     * bereit".</b> Ob eine Wallbox wirklich teilnimmt, entscheidet die BOX aus
     * dem, was sie MISST und was der Arbiter ihr gibt - hier fehlt jede
     * Grundlage dafuer (eine pausierte oder ungebundene Wallbox kann von der
     * Box gar nicht beansprucht werden, weil sie kein Kommando bekommt).
     *
     * <p>Jede Zahl ist optional: {@code null} = unbekannt, nie 0.
     */
    public List<WallboxDto> wallboxes(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT mp.id, mp.label, cp.rated_power_kw, cp.min_power_kw, "
                        + "cp.default_service_rank FROM measurement_point mp "
                        + "JOIN consumer_profile cp ON cp.entity_id = mp.id "
                        + "WHERE mp.site_id = ? AND mp.entity_type = 'wallbox' ORDER BY mp.id",
                (rs, n) -> new WallboxDto(rs.getObject("id", UUID.class), rs.getString("label"),
                        dbl(rs.getObject("rated_power_kw")), dbl(rs.getObject("min_power_kw")),
                        (Integer) rs.getObject("default_service_rank")),
                siteId));
    }

    /**
     * Die GESPEICHERTEN Raenge dieser Anlage - ALLE, auch die von Saeulen, die
     * (noch) nicht zugelassen sind.
     *
     * <p><b>⚠ Das ist bewusst eine andere Menge als die der Allowlist.</b> Eine
     * Reihenfolge gehoert dem Kunden und wird gespeichert, sobald er sie zieht;
     * ob sie eine bestimmte Saeule ERREICHT, entscheidet erst der Publisher.
     * Der Aenderungs-Vergleich muss deshalb hier lesen - ueber die Allowlist
     * gemessen sae he eine Anlage ohne Portal-Zulassung ihre Raenge nie als
     * „geaendert" und speicherte sie nie.
     */
    public Map<String, Integer> chargePointRanks(UUID siteId) {
        Map<String, Integer> out = new LinkedHashMap<>();
        jdbc.query("SELECT charge_point_id, rank FROM site_charge_point_rank WHERE site_id = ? "
                + "ORDER BY charge_point_id", rs -> {
                    out.put(rs.getString("charge_point_id"), (Integer) rs.getObject("rank"));
                }, siteId);
        return out;
    }

    /**
     * Ersetzt die Raenge der Saeulen (P6). Leer = die Anlage hat keine
     * Reihenfolge (mehr), und dann entscheidet wieder allein die Vorrang-Menge.
     *
     * <p><b>⚠ Es wird NICHT geprueft, ob die Kennung zugelassen ist.</b> Eine
     * Saeule kann an der Box eingetragen worden sein; ihre Position gehoert dem
     * Kunden, und sie hier abzulehnen naehme ihm eine Reihenfolge, die er
     * getroffen hat. Der PUBLISHER entscheidet danach, WEN das Dokument
     * erreicht - eine Zeile hier laesst niemanden herein.
     */
    @Transactional
    public void replaceChargePointRanks(UUID tenantId, UUID siteId, Map<String, Integer> ranks) {
        jdbc.update("DELETE FROM site_charge_point_rank WHERE site_id = ?", siteId);
        for (Map.Entry<String, Integer> e : ranks.entrySet()) {
            if (e.getValue() == null) {
                continue;
            }
            jdbc.update("INSERT INTO site_charge_point_rank (site_id, charge_point_id, rank, "
                    + "tenant_id) VALUES (?, ?, ?, ?)", siteId, e.getKey(), e.getValue(), tenantId);
        }
    }

    /**
     * Die Position des Speichers. {@code null} loescht sie (die Anlage hat
     * keinen Speicher mehr in ihrer Reihenfolge) - anders als jedes andere Feld
     * dieser Zeile, denn hier IST die Abwesenheit die Aussage „es gibt kein
     * Oben und Unten".
     */
    public void saveStorageRank(UUID tenantId, UUID siteId, Integer rank, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, storage_rank, "
                + "updated_at, updated_by) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET storage_rank = EXCLUDED.storage_rank, "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, rank, Timestamp.from(Instant.now()), actor);
    }

    /** Die Geräte dieser Anlage - die Empfänger des retained Dokuments. */
    public List<UUID> deviceIds(UUID siteId) {
        return new ArrayList<>(jdbc.query("SELECT id FROM device WHERE site_id = ? ORDER BY id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId));
    }
}
