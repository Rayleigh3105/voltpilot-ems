package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Der Abgleich eines Fundes mit den Komponenten der Anlage ({@code docs/contracts/v2/mqtt-geraetesuche.md} §7). Rein:
 * ohne Datenbank, ohne Broker.
 *
 * <p>Die Kennung eines Fundes ist seine Seriennummer und bei einem Solarman-Logger dessen Seriennummer
 * ({@code verbindung.serial}); die einer Komponente die Seriennummer ihres Geräts ({@code geraet.seriennummer}) und die
 * Logger-Seriennummer ihrer Verbindung. Die Adresse ist die IP; zwei verschiedene Unit-IDs hinter derselben IP sind
 * verschiedene Ziele (ein Gateway). Hausregel: eine Adresse allein beweist nie, dass es dasselbe Gerät ist — darum
 * {@code adresse_bekannt_kennung_offen}, wenn einer Seite die Kennung fehlt, und {@code adresse_geaendert} nur, wenn
 * die Kennung passt (DP-7 A: ein Vorschlag, nie still übernommen).
 */
public final class GeraetesucheAbgleich {

    /**
     * Eine Komponente der Anlage, wie der Abgleich sie braucht.
     *
     * @param ip        die Adresse ihrer Verbindung; null = sie hat keine (z. B. eine OCPP-Säule)
     * @param unitId    Unit-ID bzw. Modbus-Adresse hinter dem Logger; null = keine
     * @param kennungen Seriennummer des Geräts und Logger-Seriennummer, normalisiert; leer = keine bekannt
     */
    public record Komponente(UUID id, String name, String ip, Integer unitId, Set<String> kennungen) {
        public Komponente {
            kennungen = Set.copyOf(kennungen);
        }
    }

    /**
     * @param komponente      die abgeglichene Komponente; null bei {@code neu}
     * @param bekannteAdresse die gespeicherte Adresse der Komponente, nur bei {@code adresse_geaendert}
     */
    public record Ergebnis(String abgleich, Komponente komponente, String bekannteAdresse) {
    }

    private static final Ergebnis NEU = new Ergebnis(GeraetesucheVertrag.NEU, null, null);

    private GeraetesucheAbgleich() {
    }

    public static Ergebnis abgleichen(GeraetesucheBericht.Fund fund, List<Komponente> komponenten) {
        if (GeraetesucheVertrag.NETZTECHNIK_ARTEN.contains(fund.art())) {
            return NEU; // Router und Zugangspunkte sind nie eine Komponente
        }
        Set<String> kennungen = kennungen(fund);
        String ip = adresse(fund.verbindung().ip());
        Integer unitId = fund.verbindung().unitId();
        List<Komponente> gleicheKennung = komponenten.stream()
                .filter(k -> !kennungen.isEmpty() && k.kennungen().stream().anyMatch(kennungen::contains)).toList();
        for (Komponente k : gleicheKennung) {
            if (k.ip() == null || gleicheAdresse(ip, unitId, k)) {
                return new Ergebnis(GeraetesucheVertrag.SCHON_EINGERICHTET, k, null);
            }
        }
        if (!gleicheKennung.isEmpty()) {
            Komponente k = gleicheKennung.get(0);
            return new Ergebnis(GeraetesucheVertrag.ADRESSE_GEAENDERT, k, k.ip());
        }
        List<Komponente> gleicheAdresse = komponenten.stream().filter(k -> gleicheAdresse(ip, unitId, k)).toList();
        if (gleicheAdresse.isEmpty()) {
            return NEU;
        }
        // Fehlt einer Seite die Kennung, ist nicht belegbar, ob es dasselbe Gerät ist; nur wenn alle Kennungen da sind
        // und keine passt, antwortet ein anderes Gerät.
        for (Komponente k : gleicheAdresse) {
            if (kennungen.isEmpty() || k.kennungen().isEmpty()) {
                return new Ergebnis(GeraetesucheVertrag.KENNUNG_OFFEN, k, null);
            }
        }
        return new Ergebnis(GeraetesucheVertrag.ANDERES_GERAET, gleicheAdresse.get(0), null);
    }

    /** Seriennummer und Logger-Seriennummer eines Fundes, normalisiert. */
    public static Set<String> kennungen(GeraetesucheBericht.Fund fund) {
        Set<String> out = new LinkedHashSet<>();
        if (fund.seriennummer() != null) {
            out.add(kennung(fund.seriennummer()));
        }
        if (fund.verbindung().serial() != null) {
            out.add(kennung(Long.toString(fund.verbindung().serial())));
        }
        out.remove("");
        return out;
    }

    /**
     * Eine Komponente aus ihrer gespeicherten Verbindung ({@code measurement_point.connection_json}) und der
     * Seriennummer ihres Geräts.
     */
    public static Komponente komponente(UUID id, String name, String connectionJson, String seriennummer,
            ObjectMapper mapper) {
        JsonNode c = null;
        if (connectionJson != null && !connectionJson.isBlank()) {
            try {
                c = mapper.readTree(connectionJson);
            } catch (Exception e) {
                c = null;
            }
        }
        Set<String> kennungen = new LinkedHashSet<>();
        if (seriennummer != null) {
            kennungen.add(kennung(seriennummer));
        }
        String ip = null;
        Integer unitId = null;
        if (c != null && c.isObject()) {
            String serial = text(c.get("serial"));
            if (serial != null) {
                kennungen.add(kennung(serial));
            }
            ip = adresse(text(c.get("ip")));
            unitId = ganz(c.has("unit_id") ? c.get("unit_id") : c.get("mb_slave_id"));
        }
        kennungen.remove("");
        return new Komponente(id, name, ip, unitId, kennungen);
    }

    /**
     * Die Vorlagen ({@code templateRef}), die zu einem übernehmbaren Fund passen: dieselbe Kommunikationsart, derselbe
     * Hersteller und — wo die Box eine Bauart nennt und der Katalog sie kennt — dieselbe Bauart (Deye: nur die Modelle
     * der gemeldeten Familie). Leer, wenn der Fund sich nicht übernehmen lässt oder keine Vorlage passt.
     */
    public static List<String> vorlagen(GeraetesucheBericht.Fund fund, List<ComponentTemplateDto> katalog) {
        String communication = fund.verbindung().communication();
        if (!GeraetesucheVertrag.UEBERNEHMEN.equals(fund.anbindung()) || communication == null) {
            return List.of();
        }
        List<ComponentTemplateDto> passend = katalog.stream()
                .filter(t -> communication.equals(t.communication()))
                .filter(t -> fund.hersteller() == null || fund.hersteller().equalsIgnoreCase(t.brand()))
                .toList();
        if (fund.familie() != null) {
            List<ComponentTemplateDto> bauart = passend.stream()
                    .filter(t -> fund.familie().equals(t.family())).toList();
            if (!bauart.isEmpty()) {
                passend = bauart;
            }
        }
        List<String> refs = new ArrayList<>();
        passend.forEach(t -> refs.add(t.templateRef()));
        return List.copyOf(refs);
    }

    private static boolean gleicheAdresse(String ip, Integer unitId, Komponente k) {
        return k.ip() != null && k.ip().equals(ip)
                && (unitId == null || k.unitId() == null || Objects.equals(unitId, k.unitId()));
    }

    private static String kennung(String s) {
        return s.trim().toUpperCase(Locale.ROOT);
    }

    private static String adresse(String s) {
        return s == null || s.isBlank() ? null : s.trim().toLowerCase(Locale.ROOT);
    }

    private static String text(JsonNode n) {
        if (n == null || n.isNull()) {
            return null;
        }
        String s = n.isTextual() ? n.asText() : n.isIntegralNumber() ? n.asText() : null;
        return s == null || s.isBlank() ? null : s.trim();
    }

    private static Integer ganz(JsonNode n) {
        if (n == null || n.isNull()) {
            return null;
        }
        if (n.isIntegralNumber() && n.canConvertToInt()) {
            return n.asInt();
        }
        if (n.isTextual()) {
            try {
                return Integer.valueOf(n.asText().trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }
}
