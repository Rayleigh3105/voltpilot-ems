package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Nimmt einen Box-Umschlag auf {@code ems/{t}/{s}/{d}/v2/events} an (Vertrag
 * {@code docs/contracts/v2/mqtt-events-2.1.schema.json}, events-vocabulary.md §2/§5; UEMS AP-07
 * IP-5). Der Umschlag ist die EINHEIT: eine unbekannte Fassung, eine verletzte Form, eine
 * abweichende Kennung oder ein verworfenes Ereignis wirft {@link UmschlagAbgewiesen} mit Grund —
 * nichts wird still weggelassen. Die Zeit-Prüfung (E13) gilt für {@code observed_at} wie für eine
 * Messzeit: geht die Uhr der Box falsch, wird kein Ereignis angenommen ({@code clock_ahead} /
 * {@code too_old} statt {@code rejected}). Sonst wird je Eintrag EIN {@code events.raw} mit
 * Urheber {@code box} gebildet, {@code box} = {@code device_id} aus dem Topic.
 *
 * <p>Zwilling von {@code services/api .../uems/EreignisVokabular.pruefeUmschlag}, beschränkt auf
 * die sechs Arten, die eine Box melden darf. {@code BoxEventsValidatorTest} fährt jeden
 * Umschlag-Fall von {@code events-vocabulary-vectors.json} und hält die Tabellen unten an deren
 * {@code vokabular} (Arten, Box-Felder, Feldtypen, Wörter).
 */
@Component
public class BoxEventsValidator {

    static final String FASSUNG = "2.1";
    static final String STROM = "events";
    static final int EREIGNISSE_HOECHSTENS = 64;
    static final Set<String> UMSCHLAG_FELDER = Set.of("schema_version", "tenant_id", "site_id",
            "device_id", "sequence", "observed_at", "events");

    /** Alle 23 Arten des Vokabulars: eine bekannte, aber nicht von der Box meldbare ist {@code urheber_unzulaessig}. */
    static final Set<String> ARTEN = Set.of("data_gap", "backfill", "duplicate_conflict",
            "sequence_gap", "sequence_reset", "late_arrival", "counter_reset", "device_boundary",
            "handover", "unassigned_reader", "rejected", "clock_ahead", "too_old", "clock_jump",
            "box_restart", "device_restart", "frozen_source", "range_limit", "layout_changed",
            "error_change", "state_change", "bitfield_change", "text_change");

    /** Die Box-Arten mit Pflicht- und erlaubten Feldern (Vektor-Datei: {@code arten[].mqtt}). */
    record BoxArt(Set<String> pflicht, Set<String> felder) {}

    static final Map<String, BoxArt> BOX_ARTEN = Map.of(
            "data_gap", new BoxArt(Set.of("ereignis_id", "art", "von", "bis", "erkannt_aus"),
                    Set.of("ereignis_id", "art", "von", "bis", "erkannt_aus", "datenquelle",
                            "komponente", "messkanal", "erwartet_fehlend")),
            "box_restart", new BoxArt(Set.of("ereignis_id", "art", "zeitpunkt"),
                    Set.of("ereignis_id", "art", "zeitpunkt")),
            "device_restart", new BoxArt(Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                    Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "herzschlag_vorher",
                            "herzschlag_nachher")),
            "frozen_source", new BoxArt(Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                    Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "komponente",
                            "messkanal", "lesungen", "herzschlag")),
            "range_limit", new BoxArt(Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                    Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "komponente",
                            "statuswort")),
            "layout_changed", new BoxArt(Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                    Set.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "fassung_erwartet",
                            "fassung_gelesen", "karten_erwartet", "karten_gelesen")));

    /** Die Typen der Box-Felder (Vektor-Datei: {@code vokabular.felder[].typ}). */
    enum Typ { UUID, WORT, ZEIT, ZEIT_ODER_LEER, KENNUNG, TEXT, GANZ_AB_0, GANZ_AB_1, STATUSWORT }

    static final Map<String, Typ> FELDER = Map.ofEntries(
            Map.entry("ereignis_id", Typ.UUID), Map.entry("art", Typ.WORT),
            Map.entry("zeitpunkt", Typ.ZEIT), Map.entry("von", Typ.ZEIT),
            Map.entry("bis", Typ.ZEIT_ODER_LEER), Map.entry("erkannt_aus", Typ.WORT),
            Map.entry("datenquelle", Typ.KENNUNG), Map.entry("komponente", Typ.KENNUNG),
            Map.entry("messkanal", Typ.TEXT), Map.entry("erwartet_fehlend", Typ.GANZ_AB_0),
            Map.entry("herzschlag_vorher", Typ.GANZ_AB_0), Map.entry("herzschlag_nachher", Typ.GANZ_AB_0),
            Map.entry("lesungen", Typ.GANZ_AB_1), Map.entry("herzschlag", Typ.GANZ_AB_0),
            Map.entry("statuswort", Typ.STATUSWORT), Map.entry("fassung_erwartet", Typ.GANZ_AB_1),
            Map.entry("fassung_gelesen", Typ.GANZ_AB_1), Map.entry("karten_erwartet", Typ.GANZ_AB_0),
            Map.entry("karten_gelesen", Typ.GANZ_AB_0));

    /** {@code erkannt_aus}: das Wort gehört zum Urheber — von der Box nur {@code verdraengung}. */
    static final Set<String> ERKANNT_AUS = Set.of("kadenz", "verdraengung", "herzschlag");
    static final String ERKANNT_AUS_BOX = "verdraengung";

    private static final Pattern UUID_FORM =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern ZEIT_UTC =
            Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    /** Die Kennung, wie die Cloud sie der Box zustellt ({@code mqtt-events-2.1#/$defs/kennung}). */
    private static final Pattern KENNUNG = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:-]*$");

    private final ObjectMapper mapper;
    private final Messzeitregel messzeit;

    public BoxEventsValidator(ObjectMapper mapper, Messzeitregel messzeit) {
        this.mapper = mapper;
        this.messzeit = messzeit;
    }

    public Annahme<List<EventsRawEvent>> annehmen(String topic, String payload, Instant eingang) {
        JsonNode u;
        try {
            u = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
        } catch (Exception e) {
            throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT, "kein JSON", null, null);
        }
        if (u == null || !u.isObject()) {
            throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT, "kein Objekt", null, null);
        }
        JsonNode seq = u.path("sequence");
        Long sequenz = seq.isIntegralNumber() && seq.canConvertToLong() && seq.asLong() >= 0
                ? seq.asLong() : null;
        JsonNode events = u.path("events");
        Kontext k = new Kontext(sequenz, events.isArray() && !events.isEmpty() ? (long) events.size() : null);

        // 1. Umschlag: Fassung → Form → Kennung.
        JsonNode fassung = u.path("schema_version");
        if (!fassung.isTextual() || !FASSUNG.equals(fassung.asText())) {
            k.nein(Grund.FASSUNG_UNBEKANNT, "schema_version");
        }
        for (Iterator<String> it = u.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!UMSCHLAG_FELDER.contains(f)) {
                k.nein(Grund.SCHEMA_VERLETZT, "unbekanntes Feld " + f);
            }
        }
        for (String f : List.of("tenant_id", "site_id", "device_id")) {
            if (!u.path(f).isTextual() || !UUID_FORM.matcher(u.get(f).asText()).matches()) {
                k.nein(Grund.SCHEMA_VERLETZT, f);
            }
        }
        if (sequenz == null) {
            k.nein(Grund.SCHEMA_VERLETZT, "sequence");
        }
        if (!istZeit(u.path("observed_at"))) {
            k.nein(Grund.SCHEMA_VERLETZT, "observed_at");
        }
        if (!events.isArray() || events.isEmpty() || events.size() > EREIGNISSE_HOECHSTENS) {
            k.nein(Grund.SCHEMA_VERLETZT, "events");
        }
        String[] t = topic == null ? new String[0] : topic.split("/", -1);
        if (t.length != 6 || !"ems".equals(t[0]) || !"v2".equals(t[4]) || !STROM.equals(t[5])
                || !t[1].equals(u.get("tenant_id").asText()) || !t[2].equals(u.get("site_id").asText())
                || !t[3].equals(u.get("device_id").asText())) {
            k.nein(Grund.KENNUNG_ABWEICHEND, "Topic ⟷ Umschlag");
        }

        // 2. Jedes Ereignis, wie von der Box gemeldet — das erste verworfene verwirft den Umschlag.
        for (int i = 0; i < events.size(); i++) {
            pruefeEreignis(events.get(i), "events[" + i + "]", k);
        }

        // 3. Zeit (E13) auf observed_at: geht die Uhr falsch, wird KEIN Ereignis angenommen.
        Annahme.Absender absender = new Annahme.Absender(UUID.fromString(t[1]),
                UUID.fromString(t[2]), UUID.fromString(t[3]), STROM, sequenz);
        String observedAt = u.get("observed_at").asText();
        Optional<Messzeitregel.Abweichung> uhr = messzeit.pruefe(Instant.parse(observedAt), eingang);
        if (uhr.isPresent()) {
            Ablehnungen ablehnungen = new Ablehnungen();
            ablehnungen.zeit(uhr.get(), events.size());
            return new Annahme<>(List.of(), absender, ablehnungen.liste());
        }
        List<EventsRawEvent> weiter = new ArrayList<>();
        for (JsonNode e : events) {
            weiter.add(EventsRawEvent.box(absender, topic, observedAt, (ObjectNode) e, eingang));
        }
        return new Annahme<>(List.copyOf(weiter), absender, List.of());
    }

    /** Art → Absender → Felder → Wörter → Zeit → Regeln (events-vocabulary.md §5). */
    private static void pruefeEreignis(JsonNode e, String wo, Kontext k) {
        if (!e.isObject() || e.has("box")) {
            k.nein(Grund.SCHEMA_VERLETZT, wo + ": kein Objekt oder mit box");
        }
        if (!e.path("art").isTextual()) {
            k.nein(Grund.SCHEMA_VERLETZT, wo + ": art");
        }
        String art = e.get("art").asText();
        if (!ARTEN.contains(art)) {
            k.nein(Grund.WORT_UNBEKANNT, wo + ": art " + art);
        }
        BoxArt box = BOX_ARTEN.get(art);
        if (box == null) {
            k.nein(Grund.URHEBER_UNZULAESSIG, wo + ": " + art + " kommt nie von der Box");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = e.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!box.felder().contains(f.getKey())) {
                k.nein(Grund.SCHEMA_VERLETZT, wo + ": unbekanntes Feld " + f.getKey());
            }
            if (!typPasst(FELDER.get(f.getKey()), f.getValue())) {
                k.nein(Grund.SCHEMA_VERLETZT, wo + ": Typ von " + f.getKey());
            }
        }
        for (String p : box.pflicht()) {
            if (!e.has(p) || (e.get(p).isNull() && !"bis".equals(p))) {
                k.nein(Grund.SCHEMA_VERLETZT, wo + ": Pflichtfeld " + p);
            }
        }
        if (e.has("erkannt_aus") && !ERKANNT_AUS.contains(e.get("erkannt_aus").asText())) {
            k.nein(Grund.WORT_UNBEKANNT, wo + ": erkannt_aus");
        }
        if ("data_gap".equals(art)) {
            if (e.get("bis").isNull()) {
                k.nein(Grund.ZEIT_UNGUELTIG, wo + ": eine Box meldet nur eine geschlossene Lücke");
            }
            if (!Instant.parse(e.get("bis").asText()).isAfter(Instant.parse(e.get("von").asText()))) {
                k.nein(Grund.ZEIT_UNGUELTIG, wo + ": bis nicht nach von");
            }
        }
        if (e.has("messkanal") && !e.has("komponente")) {
            k.nein(Grund.REGEL_VERLETZT, wo + ": Reihe unvollständig");
        }
        switch (art) {
            case "data_gap" -> {
                if (!ERKANNT_AUS_BOX.equals(e.get("erkannt_aus").asText())) {
                    k.nein(Grund.REGEL_VERLETZT, wo + ": erkannt_aus gehört nicht zur Box");
                }
            }
            case "device_restart" -> {
                if (e.has("herzschlag_vorher") && e.has("herzschlag_nachher")
                        && e.get("herzschlag_nachher").asLong() >= e.get("herzschlag_vorher").asLong()) {
                    k.nein(Grund.REGEL_VERLETZT, wo + ": Herzschlag springt nicht zurück");
                }
            }
            case "frozen_source" -> {
                if (e.has("lesungen") && e.get("lesungen").asLong() < 3) {
                    k.nein(Grund.REGEL_VERLETZT, wo + ": weniger als 3 Lesungen");
                }
            }
            case "layout_changed" -> {
                paar(e, "fassung_erwartet", "fassung_gelesen", wo, k);
                paar(e, "karten_erwartet", "karten_gelesen", wo, k);
            }
            default -> {
                // box_restart, range_limit: keine Regel über die Felder hinaus
            }
        }
    }

    private static void paar(JsonNode e, String erwartet, String gelesen, String wo, Kontext k) {
        if (e.has(erwartet) != e.has(gelesen)
                || (e.has(erwartet) && e.get(erwartet).asLong() == e.get(gelesen).asLong())) {
            k.nein(Grund.REGEL_VERLETZT, wo + ": " + erwartet + "/" + gelesen);
        }
    }

    private static boolean typPasst(Typ typ, JsonNode w) {
        if (typ == null) {
            return false;
        }
        return switch (typ) {
            case UUID -> w.isTextual() && UUID_FORM.matcher(w.asText()).matches();
            case WORT -> w.isTextual();
            case ZEIT -> istZeit(w);
            case ZEIT_ODER_LEER -> w.isNull() || istZeit(w);
            case KENNUNG -> w.isTextual() && w.asText().length() <= 128
                    && KENNUNG.matcher(w.asText()).matches();
            case TEXT -> w.isTextual() && !w.asText().isEmpty() && w.asText().length() <= 240;
            case GANZ_AB_0 -> ganz(w) && w.asLong() >= 0;
            case GANZ_AB_1 -> ganz(w) && w.asLong() >= 1;
            case STATUSWORT -> ganz(w) && w.asLong() >= 0 && w.asLong() <= 65_535;
        };
    }

    private static boolean ganz(JsonNode w) {
        return w.isIntegralNumber() && w.canConvertToLong();
    }

    private static boolean istZeit(JsonNode w) {
        if (!w.isTextual() || !ZEIT_UTC.matcher(w.asText()).matches()) {
            return false;
        }
        try {
            Instant.parse(w.asText());
            return true;
        } catch (DateTimeParseException ex) {
            return false;
        }
    }

    /** Was über den Umschlag schon lesbar ist, für das {@code rejected} seiner Abweisung. */
    private record Kontext(Long sequenz, Long anzahl) {
        void nein(Grund grund, String hinweis) {
            throw new UmschlagAbgewiesen(grund, hinweis, sequenz, anzahl);
        }
    }
}
