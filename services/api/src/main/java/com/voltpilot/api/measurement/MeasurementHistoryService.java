package com.voltpilot.api.measurement;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.voltpilot.api.measurement.MeasurementCatalog.Point;
import com.voltpilot.api.uems.LesepfadQuelle;
import com.voltpilot.api.uems.VerbrauchRegeln;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** RLS-scoped additional-measurement history with bounded, semantic aggregation. */
@Service
public class MeasurementHistoryService {

    /**
     * Die HERKUNFT je Wert bzw. Intervall (UEMS AP-07 §4.2/§4.4, IP-14) — rein ADDITIV: sie
     * hängt als EIN neues Feld an {@link Datum}, kein bestehendes Feld verschwindet oder
     * ändert seine Bedeutung.
     *
     * <p><b>Nichts darin ist geraten.</b> Jede Angabe kommt aus einer Spalte, die der Writer
     * (IP-6/IP-7) oder die Verdichtung (IP-12/IP-13, AP-08 IP-2) gefüllt hat. Wo eine Angabe
     * für den gezeichneten Schritt nicht EINDEUTIG ist — zwei Geräte, zwei Boxen, zwei
     * Fassungen im selben Raster-Schritt —, bleibt sie LEER statt sich auf einen der beiden
     * Werte festzulegen; der Wechsel selbst steht als Marker im Verlauf.
     *
     * <p>Der Rohwert-Weg füllt, was am Rohwert steht (Gerät-Einbau, Fassung, Katalogstand,
     * Rolle, Wertart, Zustellart); Abdeckung, Qualitätszähler und Zustand entstehen erst in der
     * Viertelstunde und bleiben dort leer. Die bestehenden Verdichtungen der Box tragen
     * überhaupt keine Herkunft — dort ist das Feld {@code null}, nicht erfunden.
     *
     * <p><b>Die Nacharbeit zu AP-08 IP-3/IP-5</b> hängt drei Felder an, die nur die Speicherklassen
     * füllen: {@code mengeZustand} und {@code kennzeichen} der Menge (Viertelstunde, Zeitraum, Tag)
     * und {@code energieAusLeistung} — Wert UND Kennzeichen in einem, nie der Wert allein. Sie
     * erscheinen im JSON nur, wo sie gefüllt sind: die Antwort des Rohwert-Wegs bleibt Zeichen für
     * Zeichen die von vorher.
     */
    public record Herkunft(String quelle, String wertart, Integer abdeckungProzent,
            Integer erhalten, Integer erwartet, Integer nGood, Integer nUncertain,
            Integer nInvalid, Integer nStale, Integer nDeviceError, String zustand,
            Instant endgueltigAb, Integer version, Integer nachgeliefert, String zustellart,
            Instant letzteEingangszeit, UUID geraetEinbau, UUID geraetEinbauZwei, UUID box,
            UUID boxZwei, Long fassung, String katalogVersion, String rolle,
            BigDecimal standAnfang, BigDecimal standEnde,
            @JsonInclude(JsonInclude.Include.NON_NULL) String mengeZustand,
            @JsonInclude(JsonInclude.Include.NON_NULL) List<String> kennzeichen,
            @JsonInclude(JsonInclude.Include.NON_NULL) EnergieAusLeistung energieAusLeistung) {

        /** Die Form von VOR der Nacharbeit — ohne Menge-Zustand, Kennzeichen und Energie. */
        public Herkunft(String quelle, String wertart, Integer abdeckungProzent,
                Integer erhalten, Integer erwartet, Integer nGood, Integer nUncertain,
                Integer nInvalid, Integer nStale, Integer nDeviceError, String zustand,
                Instant endgueltigAb, Integer version, Integer nachgeliefert, String zustellart,
                Instant letzteEingangszeit, UUID geraetEinbau, UUID geraetEinbauZwei, UUID box,
                UUID boxZwei, Long fassung, String katalogVersion, String rolle,
                BigDecimal standAnfang, BigDecimal standEnde) {
            this(quelle, wertart, abdeckungProzent, erhalten, erwartet, nGood, nUncertain, nInvalid,
                    nStale, nDeviceError, zustand, endgueltigAb, version, nachgeliefert, zustellart,
                    letzteEingangszeit, geraetEinbau, geraetEinbauZwei, box, boxZwei, fassung,
                    katalogVersion, rolle, standAnfang, standEnde, null, null, null);
        }
    }

    /**
     * Eine Energie AUS LEISTUNG (AP-08 IP-3, E5) — interpoliert, nicht gemessen. Sie reist nur mit
     * ihrem Kennzeichen „aus Leistung integriert …" (Wortlaut {@link
     * VerbrauchRegeln#AUS_LEISTUNG_INTEGRIERT}); ohne es gibt es sie nicht, damit keine Fläche sie
     * je wie eine gemessene Menge zeigen kann. Die Datenbank hält dasselbe per Prüfregel
     * ({@code messreihe_energie_gekennzeichnet}).
     *
     * @param wert die Energie in der Einheit der Reihe × Stunde, ungerundet wie gespeichert
     * @param kennzeichen der Satz „aus Leistung integriert (…)" aus den Kennzeichen des Schritts
     */
    public record EnergieAusLeistung(BigDecimal wert, String kennzeichen) {

        public EnergieAusLeistung {
            if (wert == null || kennzeichen == null
                    || !kennzeichen.startsWith(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT)) {
                throw new IllegalArgumentException(
                        "eine Energie aus Leistung steht nie ohne ihr Kennzeichen: " + kennzeichen);
            }
        }

        /** Die Energie mit ihrem Kennzeichen — {@code null}, wenn eines von beiden fehlt. */
        public static EnergieAusLeistung aus(BigDecimal wert, List<String> kennzeichen) {
            if (wert == null || kennzeichen == null) {
                return null;
            }
            return kennzeichen.stream()
                    .filter(k -> k.startsWith(VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT_WORT))
                    .findFirst().map(k -> new EnergieAusLeistung(wert, k)).orElse(null);
        }
    }

    public record Datum(Instant time, BigDecimal value, BigDecimal minimum, BigDecimal maximum,
            String text, long sampleCount, boolean gap, Herkunft herkunft) {
        /** Die Form von VOR IP-14 — sie hält jeden bestehenden Aufrufer am Laufen. */
        public Datum(Instant time, BigDecimal value, BigDecimal minimum, BigDecimal maximum,
                String text, long sampleCount, boolean gap) {
            this(time, value, minimum, maximum, text, sampleCount, gap, null);
        }
    }

    public record Marker(Instant time, String kind, String label, Instant until, int count) {
        /** Die Form von VOR IP-14: ein Zeitpunkt-Marker, der genau einmal vorkommt. */
        public Marker(Instant time, String kind, String label) {
            this(time, kind, label, null, 1);
        }
    }

    public record Meta(String pointKey, String label, String sourceLabel, String unit,
            String aggregationKind, String semanticStatus, String catalogVersion,
            String representation, boolean rawAvailable, Instant from, Instant to,
            int bucketSeconds, String aggregationExplanation, UUID siteId, UUID entityId,
            String quelle, String quelleErklaerung, Instant rohGrenze,
            List<String> katalogVersionenGespeichert) {
        /** Die Form von VOR IP-14 — die neuen Felder bleiben leer statt geraten zu werden. */
        public Meta(String pointKey, String label, String sourceLabel, String unit,
                String aggregationKind, String semanticStatus, String catalogVersion,
                String representation, boolean rawAvailable, Instant from, Instant to,
                int bucketSeconds, String aggregationExplanation, UUID siteId, UUID entityId) {
            this(pointKey, label, sourceLabel, unit, aggregationKind, semanticStatus,
                    catalogVersion, representation, rawAvailable, from, to, bucketSeconds,
                    aggregationExplanation, siteId, entityId, null, null, null, List.of());
        }
    }

    public record History(Meta meta, List<Datum> data, List<Marker> markers) {}
    public record ComparisonOption(UUID deviceId, String deviceLabel, String pointKey,
            String label, String unit, String aggregationKind, String compatibilityKey,
            Instant lastReadAt) {}

    private final JdbcTemplate jdbc;
    private final MeasurementCatalog catalog;
    private final MeasurementSelectionRepository selections;
    private final SpeicherklasseHistorie speicherklassen;
    private final Clock uhr;
    private final Geltungsbereich geltungsbereich;

    /** Die Form von VOR IP-14 (ohne Rückfall) — sie hält bestehende Aufrufer am Laufen. */
    public MeasurementHistoryService(JdbcTemplate jdbc, MeasurementCatalog catalog,
            MeasurementSelectionRepository selections) {
        this(jdbc, catalog, selections, null, Clock.systemUTC());
    }

    @Autowired
    public MeasurementHistoryService(JdbcTemplate jdbc, MeasurementCatalog catalog,
            MeasurementSelectionRepository selections, SpeicherklasseHistorie speicherklassen) {
        this(jdbc, catalog, selections, speicherklassen, Clock.systemUTC());
    }

    /** Mit Rückfall auf die Speicherklassen und einer gestellten Uhr (UEMS AP-07 IP-14). */
    public MeasurementHistoryService(JdbcTemplate jdbc, MeasurementCatalog catalog,
            MeasurementSelectionRepository selections, SpeicherklasseHistorie speicherklassen,
            Clock uhr) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.selections = selections;
        this.speicherklassen = speicherklassen;
        this.uhr = uhr;
        this.geltungsbereich = new Geltungsbereich(jdbc);
    }

    public History history(UUID deviceId, String pointKey, String range, Instant freeFrom,
            Instant freeTo, String representation, UUID requestedSiteId, UUID entityId) {
        MeasurementSelectionRepository.DeviceScope scope = selections.deviceScope(deviceId);
        if (scope == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        UUID siteId = requestedSiteId == null ? scope.siteId() : requestedSiteId;
        // Standort-Zaun (UEMS AP-03 IP-5): das Gerät liest nur, wer seine Anlage UND die angefragte
        // Anlage sieht — sonst läse ein ?siteId= der eigenen Anlage ein Gerät einer fremden. Verlauf
        // und Geräte-CSV (`export`) gehen beide hier durch.
        geltungsbereich.requireSite(scope.siteId());
        geltungsbereich.requireSite(siteId);
        if (entityId != null) {
            // Scoped exactly like the family marker below (tenant + site +
            // entity) and like a per-component measurement selection. A
            // `device_id=?` predicate would additionally exclude every
            // component the assistant or a takeover created - those carry no
            // device_id at all - and 404 the very pages this marker is for.
            Boolean entityVisible = jdbc.queryForObject(
                    "SELECT EXISTS(SELECT 1 FROM measurement_point WHERE tenant_id=? AND site_id=? "
                            + "AND id=?)",
                    Boolean.class, scope.tenantId(), siteId, entityId);
            if (!Boolean.TRUE.equals(entityVisible)) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Messkomponente nicht gefunden.");
            }
        }
        Point point = catalog.resolve(pointKey);
        if (point == null && selections.recordedPointKeys(deviceId).stream().noneMatch(pointKey::equals)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Messwert nicht gefunden.");
        }
        CustomMeta custom = point == null ? customMeta(deviceId, pointKey) : null;
        String aggregation = point == null ? custom == null ? "unknown" : "gauge"
                : point.aggregationKind();
        Window window = window(range, freeFrom, freeTo);
        String selectedRepresentation = "raw".equals(representation) ? "raw" : "decoded";
        boolean rollup = selectedRepresentation.equals("decoded")
                && window.duration().compareTo(Duration.ofDays(2)) > 0;
        List<Datum> data = rollup
                ? rollupData(scope, siteId, deviceId, pointKey, window, aggregation)
                : rawData(scope, siteId, deviceId, pointKey, window, selectedRepresentation,
                        aggregation);
        boolean rawAvailable = Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM device_measurement_sample WHERE tenant_id=? "
                        + "AND site_id=? AND device_id=? AND "
                        + pointKeyPredicate("point_key", pointKey) + " AND quality='good' "
                        + "AND time>=? AND time<=? AND "
                        + "(raw_numeric IS NOT NULL OR raw_text IS NOT NULL))",
                Boolean.class, scope.tenantId(), siteId, deviceId, pointKeyValue(pointKey),
                Timestamp.from(window.from()),
                Timestamp.from(window.to())));

        // ---- UEMS AP-07 IP-14: der Rückfall auf die Speicherklassen ---------------------
        // Er greift NUR, wenn der Zeitraum über die Rohdaten-Frist hinausreicht UND der
        // bestehende Weg für ihn nichts hergibt. Innerhalb der Frist bleibt jede Antwort —
        // auch der Fehler „keine echten Rohdaten" — Zeichen für Zeichen die von vorher.
        Instant rohGrenze = LesepfadQuelle.rohGrenze(uhr.instant(), MeasurementRetention.RAW_DAYS);
        boolean jenseits = LesepfadQuelle.jenseitsDerFrist(window.from(), rohGrenze);
        LesepfadQuelle.Quelle quelle = rollup
                ? window.duration().compareTo(Duration.ofDays(31)) <= 0
                        ? LesepfadQuelle.Quelle.ROLLUP_5M : LesepfadQuelle.Quelle.ROLLUP_15M
                : LesepfadQuelle.Quelle.ROH;
        List<String> katalogfassungen = List.of();
        int bucketSeconds = window.bucketSeconds();
        UUID reihe = speicherklassen == null ? null
                : speicherklassen.komponente(scope.tenantId(), deviceId, pointKey, entityId);
        if (jenseits && data.isEmpty() && reihe != null) {
            LesepfadQuelle.Quelle klasse =
                    LesepfadQuelle.speicherklasse(window.duration(), MeasurementRetention.RAW_DAYS);
            int raster = klasse == LesepfadQuelle.Quelle.VIERTELSTUNDE
                    ? LesepfadQuelle.raster(window.duration(), 900,
                            SpeicherklasseHistorie.HOECHSTENS_ZEILEN)
                    : 86400;
            List<SpeicherklasseHistorie.Zeile> zeilen =
                    klasse == LesepfadQuelle.Quelle.VIERTELSTUNDE
                            ? speicherklassen.viertelstunden(scope.tenantId(), reihe, pointKey,
                                    window.from(), window.to(), raster)
                            : speicherklassen.tage(scope.tenantId(), reihe, pointKey,
                                    window.from(), window.to());
            if (!zeilen.isEmpty()) {
                data = zeilen.stream().map(MeasurementHistoryService::datum).toList();
                katalogfassungen = speicherklassen.katalogfassungen(zeilen);
                quelle = klasse;
                bucketSeconds = raster;
            }
        }
        // Die Marken der Reihe treten ADDITIV zu den bestehenden — auf JEDEM Weg, nicht nur im
        // Rückfall: ein Gerätewechsel von gestern ist genau der Sprung, der eine Erklärung
        // braucht. Sie sind die EINE Stelle, an der dieses Paket ein bestehendes Feld
        // anreichert; ohne Ereignis zur Reihe ist die Antwort unverändert.
        List<Marker> markers = markers(scope, siteId, deviceId, entityId, reihe, pointKey, window);
        if (reihe != null) {
            markers = mitEreignissen(markers, speicherklassen.ereignisse(scope.tenantId(), reihe,
                    pointKey, window.from(), window.to(), bucketSeconds));
        }
        if (selectedRepresentation.equals("raw") && !rawAvailable && !jenseits) {
            // Innerhalb der Frist sagt der Fehler etwas Wahres: Rohwerte werden noch
            // aufbewahrt, es sind hier keine. Jenseits der Frist wäre er eine Lüge über eine
            // Frage, die wir beantworten können — und fällt darum weg.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für diesen Zeitraum sind keine echten Rohdaten vorhanden.");
        }
        String explanation = switch (aggregation) {
            case "counter" -> "Zähler: positive Differenzen je Zeitfenster; Resets werden nicht als Verbrauch gezählt.";
            case "gauge" -> "Messwert: Mittelwert je Zeitfenster; Minimum und Maximum bleiben sichtbar.";
            default -> "Zustand/Ereignis: letzter Wert je Zeitfenster; Wechsel bleiben als Marker erhalten.";
        };
        Meta meta = new Meta(pointKey, point == null ? custom == null ? pointKey : custom.label()
                : point.labelDe() == null ? point.labelSource() : point.labelDe(),
                point == null ? custom == null ? null : "Eigenes Register" : point.labelSource(),
                point == null ? custom == null ? null : custom.unit() : point.unit(),
                aggregation, point == null ? "unknown" : point.semanticStatus(),
                point == null ? custom == null ? null : custom.catalogVersion() : catalog.version(),
                selectedRepresentation, rawAvailable,
                window.from(), window.to(), bucketSeconds, explanation, siteId, entityId,
                quelle.wort(), LesepfadQuelle.erklaerung(quelle, rohGrenze), rohGrenze,
                katalogfassungen);
        return new History(meta, data, markers);
    }

    /** Eine Zeile einer Speicherklasse wird ein {@link Datum} mit seiner {@link Herkunft}. */
    private static Datum datum(SpeicherklasseHistorie.Zeile z) {
        return new Datum(z.zeit(), z.wert(), z.minimum(), z.maximum(), z.text(), z.anzahl(),
                z.luecke(), new Herkunft(z.quelle().wort(), z.wertart(), z.abdeckungProzent(),
                        z.erhalten(), z.erwartet(), z.nGood(), z.nUncertain(), z.nInvalid(),
                        z.nStale(), z.nDeviceError(), z.zustand(), z.endgueltigAb(), z.version(),
                        z.nachgeliefert(), z.zustellart(), z.letzteEingangszeit(),
                        z.geraetEinbau(), z.geraetEinbauZwei(), z.box(), z.boxZwei(), z.fassung(),
                        z.katalogVersion(), z.rolle(), z.standAnfang(), z.standEnde(),
                        z.mengeZustand(), z.kennzeichen(), z.energie()));
    }

    /**
     * Die Ereignisse der Reihe treten zu den bestehenden Markern — als GEBÜNDELTE Marken mit
     * ihrer Anzahl, damit ein Sprung erklärbar wird, ohne die Kurve zuzudecken.
     */
    private static List<Marker> mitEreignissen(List<Marker> bestehende,
            List<SpeicherklasseHistorie.Ereignis> ereignisse) {
        List<Marker> out = new ArrayList<>(bestehende);
        for (SpeicherklasseHistorie.Ereignis e : ereignisse) {
            out.add(new Marker(e.von(), e.art(), ereignisWort(e.art(), e.anzahl()) + zuwachsSatz(e.zuwachs()),
                    e.bis() == null || e.bis().equals(e.von()) ? null : e.bis(), e.anzahl()));
        }
        out.sort(java.util.Comparator.comparing(Marker::time));
        return List.copyOf(out);
    }

    /**
     * AP-08 IP-6 — der Zusatz am Lücken-Marker, Wort für Wort der des Ereignis-Vertrags
     * ({@code events-vocabulary-vectors.json}, {@code data_gap.zusaetze.zuwachs}): gemessen, aber
     * nicht verteilbar. Zahlen deutsch mit höchstens drei Nachkommastellen, wie im TS-Zwilling.
     */
    public static String zuwachsSatz(SpeicherklasseHistorie.Zuwachs zuwachs) {
        if (zuwachs == null) {
            return "";
        }
        java.text.NumberFormat zahl = java.text.NumberFormat.getNumberInstance(java.util.Locale.GERMANY);
        zahl.setMaximumFractionDigits(3);
        return " · der Zähler hat weitergezählt: Zuwachs " + zahl.format(zuwachs.menge()) + " "
                + zuwachs.einheit() + " — nicht auf Viertelstunden verteilbar";
    }

    /**
     * Kundensprache für die Ereignisarten, die der Verlauf zeigt (§4.8, AP-08 IP-4; AP-05 IP-11
     * für die vier Meldungen an der Datenquelle). Die Wörter sind die Überschriften des
     * Ereignis-Vokabulars — wer {@code MARKER_ARTEN} erweitert, erweitert auch diese Liste,
     * sonst stünde das englische Vertragswort in der Kundensicht.
     */
    private static String ereignisWort(String art, int anzahl) {
        String wort = switch (art) {
            case "data_gap" -> "Datenlücke";
            case "counter_reset" -> "Zählerneustart";
            case "counter_overflow" -> "Zähler übergelaufen";
            case "device_boundary" -> "Gerät gewechselt";
            case "handover" -> "Messung von einer anderen Box übernommen";
            case "duplicate_conflict" -> "Doppelte Zustellung mit abweichendem Wert";
            case "late_arrival" -> "Nachträglich eingetroffene Werte";
            case "device_restart" -> "Neustart des Geräts";
            case "frozen_source" -> "Werte eingefroren";
            case "range_limit" -> "Bereichsbegrenzung";
            case "layout_changed" -> "Aufbau geändert";
            default -> art;
        };
        return anzahl > 1 ? wort + " (" + anzahl + "×)" : wort;
    }

    public History history(UUID deviceId, String pointKey, String range, Instant freeFrom,
            Instant freeTo, String representation, UUID requestedSiteId) {
        return history(deviceId, pointKey, range, freeFrom, freeTo, representation,
                requestedSiteId, null);
    }

    public History history(UUID deviceId, String pointKey, String range, Instant freeFrom,
            Instant freeTo, String representation) {
        return history(deviceId, pointKey, range, freeFrom, freeTo, representation, null, null);
    }

    private List<Datum> rawData(MeasurementSelectionRepository.DeviceScope scope, UUID siteId,
            UUID deviceId, String pointKey, Window window, String representation,
            String aggregation) {
        String numeric = representation.equals("raw") ? "raw_numeric"
                : "COALESCE(decoded_numeric,raw_numeric)";
        String text = representation.equals("raw") ? "raw_text"
                : "COALESCE(decoded_text,raw_text)";
        // Die Herkunfts-Spalten (UEMS AP-07 IP-6/IP-7) kommen ADDITIV mit: sie treten als
        // weitere Aggregate in dieselbe Gruppierung ein. Kein bestehender Ausdruck und keine
        // GROUP-BY-Spalte ändert sich — die gezeichneten Werte bleiben Zeichen für Zeichen.
        String sql = "WITH ordered AS (SELECT time,aggregation_kind,gap," + numeric
                + " value_numeric," + text + " value_text,device_install_id,applied_revision,"
                + "catalog_version,role,value_kind,delivery,received_at,lag(" + numeric + ") OVER "
                + "(PARTITION BY tenant_id,site_id,device_id,point_key ORDER BY time,edge_sequence) "
                + "previous_numeric FROM device_measurement_sample WHERE tenant_id=? AND site_id=? "
                + "AND device_id=? AND " + pointKeyPredicate("point_key", pointKey)
                + " AND quality='good' AND time>=? AND time<=?),"
                + "bucketed AS (SELECT time_bucket(CAST(? AS interval),time) bucket,aggregation_kind,"
                + "avg(value_numeric) avg_value,min(value_numeric) min_value,max(value_numeric) max_value,"
                + "sum(CASE WHEN previous_numeric IS NOT NULL AND value_numeric>=previous_numeric "
                + "THEN value_numeric-previous_numeric ELSE 0 END) positive_delta,"
                + "last(value_numeric,time) last_numeric,last(value_text,time) last_text,count(*) samples,"
                + "bool_or(gap) has_gap,"
                + "(CASE WHEN count(DISTINCT device_install_id)=1 THEN max(device_install_id::text) "
                + "END)::uuid h_geraet,NULL::uuid h_geraet_2,"
                + "CASE WHEN count(DISTINCT applied_revision)=1 THEN max(applied_revision) END h_fassung,"
                + "CASE WHEN count(DISTINCT catalog_version)=1 THEN max(catalog_version) END h_katalog,"
                + "CASE WHEN count(DISTINCT role)=1 THEN max(role) END h_rolle,"
                + "CASE WHEN count(DISTINCT value_kind)=1 THEN max(value_kind) END h_wertart,"
                + "CASE WHEN count(DISTINCT delivery)=1 THEN max(delivery) END h_zustellart,"
                + "count(*) FILTER (WHERE delivery='nachgeliefert')::int h_nachgeliefert,"
                + "max(received_at) h_eingang FROM ordered GROUP BY 1,2) SELECT *,CASE "
                + "WHEN aggregation_kind='counter' THEN positive_delta "
                + "WHEN aggregation_kind='gauge' THEN avg_value ELSE last_numeric END chart_value "
                + "FROM bucketed ORDER BY bucket LIMIT 2200";
        List<Datum> data = new ArrayList<>(jdbc.query(sql,
                (rs, n) -> mapRohDatum(rs, deviceId),
                scope.tenantId(), siteId, deviceId, pointKeyValue(pointKey),
                Timestamp.from(window.from()),
                Timestamp.from(window.to()), window.bucket()));
        prependRawState(scope, siteId, deviceId, pointKey, window, representation,
                aggregation, data);
        return List.copyOf(data);
    }

    private List<Datum> rollupData(MeasurementSelectionRepository.DeviceScope scope, UUID siteId,
            UUID deviceId, String pointKey, Window window, String aggregation) {
        String table = window.duration().compareTo(Duration.ofDays(31)) <= 0
                ? "device_measurement_rollup_5m" : "device_measurement_rollup_15m";
        String sql = "WITH bucketed AS (SELECT time_bucket(CAST(? AS interval),bucket) chart_bucket,"
                + "aggregation_kind,sum(avg_numeric*sample_count)/NULLIF(sum(sample_count),0) avg_value,"
                + "min(min_numeric) min_value,max(max_numeric) max_value,sum(positive_delta) positive_delta,"
                + "last(last_numeric,bucket) last_numeric,last(last_text,bucket) last_text,"
                + "sum(sample_count) samples,false has_gap FROM " + table
                + " WHERE tenant_id=? AND site_id=? AND device_id=? AND "
                + pointKeyPredicate("point_key", pointKey) + " "
                + "AND bucket>=? AND bucket<=? GROUP BY 1,2) SELECT chart_bucket bucket,*,CASE "
                + "WHEN aggregation_kind='counter' THEN positive_delta "
                + "WHEN aggregation_kind='gauge' THEN avg_value ELSE last_numeric END chart_value "
                + "FROM bucketed ORDER BY chart_bucket LIMIT 2200";
        List<Datum> data = new ArrayList<>(jdbc.query(sql,
                MeasurementHistoryService::mapDatum, window.bucket(),
                scope.tenantId(), siteId, deviceId, pointKeyValue(pointKey),
                Timestamp.from(window.from()),
                Timestamp.from(window.to())));
        prependRollupState(table, scope, siteId, deviceId, pointKey, window, aggregation, data);
        return List.copyOf(data);
    }

    private void prependRawState(MeasurementSelectionRepository.DeviceScope scope, UUID siteId,
            UUID deviceId, String pointKey, Window window, String representation,
            String aggregation, List<Datum> data) {
        if (!stateLike(aggregation) || startsAtWindow(data, window)) return;
        String numeric = representation.equals("raw") ? "raw_numeric"
                : "COALESCE(decoded_numeric,raw_numeric)";
        String text = representation.equals("raw") ? "raw_text"
                : "COALESCE(decoded_text,raw_text)";
        List<Datum> seed = jdbc.query("SELECT ?::timestamptz bucket," + numeric
                        + " chart_value,NULL::numeric min_value,NULL::numeric max_value," + text
                        + " last_text,0::bigint samples,false has_gap FROM device_measurement_sample "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=? AND "
                        + pointKeyPredicate("point_key", pointKey) + " "
                        + "AND quality='good' AND time<? ORDER BY time DESC,edge_sequence DESC LIMIT 1",
                MeasurementHistoryService::mapDatum, Timestamp.from(window.from()),
                scope.tenantId(), siteId, deviceId, pointKeyValue(pointKey),
                Timestamp.from(window.from()));
        if (!seed.isEmpty()) data.add(0, seed.get(0));
    }

    private void prependRollupState(String table, MeasurementSelectionRepository.DeviceScope scope,
            UUID siteId, UUID deviceId, String pointKey, Window window, String aggregation,
            List<Datum> data) {
        if (!stateLike(aggregation) || startsAtWindow(data, window)) return;
        List<Datum> seed = jdbc.query("SELECT ?::timestamptz bucket,last_numeric chart_value,"
                        + "NULL::numeric min_value,NULL::numeric max_value,last_text,0::bigint samples,"
                        + "false has_gap FROM " + table + " WHERE tenant_id=? AND site_id=? "
                        + "AND device_id=? AND " + pointKeyPredicate("point_key", pointKey)
                        + " AND bucket<? ORDER BY bucket DESC LIMIT 1",
                MeasurementHistoryService::mapDatum, Timestamp.from(window.from()),
                scope.tenantId(), siteId, deviceId, pointKeyValue(pointKey),
                Timestamp.from(window.from()));
        if (!seed.isEmpty()) data.add(0, seed.get(0));
    }

    private static boolean stateLike(String aggregation) {
        return List.of("state", "event", "bitfield", "text").contains(aggregation);
    }

    private static boolean startsAtWindow(List<Datum> data, Window window) {
        return !data.isEmpty() && data.get(0).time().equals(window.from());
    }

    private static Datum mapDatum(java.sql.ResultSet rs, int ignored) throws java.sql.SQLException {
        return new Datum(rs.getTimestamp("bucket").toInstant(), nullableDecimal(rs, "chart_value"),
                nullableDecimal(rs, "min_value"), nullableDecimal(rs, "max_value"),
                rs.getString("last_text"), rs.getLong("samples"), rs.getBoolean("has_gap"));
    }

    /**
     * Derselbe Datenpunkt wie {@link #mapDatum}, dazu die Herkunft, die am ROHWERT steht
     * (UEMS AP-07 IP-14). Was es dort nicht gibt, bleibt leer: Abdeckung, Qualitätszähler und
     * Zustand entstehen erst in der Viertelstunde — der Rohwert-Weg sieht nur gute Werte und
     * kennt die erwartete Häufigkeit nicht, also wird hier nichts davon behauptet.
     */
    private static Datum mapRohDatum(java.sql.ResultSet rs, UUID deviceId)
            throws java.sql.SQLException {
        long samples = rs.getLong("samples");
        Herkunft herkunft = new Herkunft(LesepfadQuelle.Quelle.ROH.wort(),
                rs.getString("h_wertart"), null, (int) samples, null, (int) samples, null, null,
                null, null, null, null, null, nullableInt(rs, "h_nachgeliefert"),
                rs.getString("h_zustellart"), instant(rs, "h_eingang"),
                rs.getObject("h_geraet", UUID.class), rs.getObject("h_geraet_2", UUID.class),
                deviceId, null, nullableLong(rs, "h_fassung"), rs.getString("h_katalog"),
                rs.getString("h_rolle"), null, null);
        return new Datum(rs.getTimestamp("bucket").toInstant(), nullableDecimal(rs, "chart_value"),
                nullableDecimal(rs, "min_value"), nullableDecimal(rs, "max_value"),
                rs.getString("last_text"), samples, rs.getBoolean("has_gap"), herkunft);
    }

    private static Integer nullableInt(java.sql.ResultSet rs, String name)
            throws java.sql.SQLException {
        int wert = rs.getInt(name);
        return rs.wasNull() ? null : wert;
    }

    private static Long nullableLong(java.sql.ResultSet rs, String name)
            throws java.sql.SQLException {
        long wert = rs.getLong(name);
        return rs.wasNull() ? null : wert;
    }

    private static Instant instant(java.sql.ResultSet rs, String name)
            throws java.sql.SQLException {
        Timestamp t = rs.getTimestamp(name);
        return t == null ? null : t.toInstant();
    }

    /**
     * Die neun Kopfzeilen, die UEMS AP-12 IP-10 (E11 DA4) dem Export additiv anhängt — in dieser
     * Folge, direkt hinter {@code # catalog_version_gespeichert=}.
     */
    public static final List<String> KOPF_ERZEUGUNG = List.of("zeitraum_von", "zeitraum_bis",
            "erzeugt_am", "erzeugt_von", "zeitzone", "dezimal", "trenner", "standort", "unternehmen");

    /**
     * Wann, von wem und wo ein Export erzeugt wurde (UEMS AP-12 IP-10, DA4). {@code standort}
     * und {@code unternehmen} sind {@code null}, wo es kein Objekt dafür gibt — nie geraten.
     */
    public record Erzeugung(Instant erzeugtAm, String erzeugtVon, String standort,
            String unternehmen, String teilansicht) {
        public Erzeugung(Instant erzeugtAm, String erzeugtVon, String standort, String unternehmen) {
            this(erzeugtAm, erzeugtVon, standort, unternehmen, null);
        }
    }

    /**
     * Der Export — ADDITIV erweitert (UEMS AP-07 IP-14).
     *
     * <p>Die zehn Kopfzeilen und die sieben Spalten von vorher stehen unverändert an
     * derselben Stelle; ein bestehender Empfänger liest weiter. NEU dahinter: die
     * Herkunfts-Spalten und — die eigentliche Pointe — die je Wert GESPEICHERTE
     * Katalogfassung. Der Kopf {@code # catalog_version=} nennt weiter den HEUTIGEN Stand des
     * Katalogs; ein Export, der eine alte Messung mit heutigen Stammdaten beschreibt, ist
     * falsch, darum steht die Fassung des Werts in seiner eigenen Spalte und der Kopf
     * {@code # catalog_version_gespeichert=} nennt die im Zeitraum vorkommenden.
     *
     * <p><b>UEMS AP-12 IP-10 (E11 DA4):</b> dahinter neun Kopfzeilen mehr ({@link #KOPF_ERZEUGUNG})
     * — Zeitraum, wann und von wem erzeugt, {@code zeitzone="UTC"}, {@code dezimal="."},
     * {@code trenner=","}, Standort und Unternehmen, Text in Anführungszeichen wie jede Kopfzeile
     * davor. Die Datei bleibt Maschinenform; jede Kopfzeile davor, die Spalten und jede Zeile
     * bleiben Byte für Byte ({@code BestandGeraeteCsvTest}, md5-Karte in
     * {@code UemsLesepfadMengenTest}).
     */
    public byte[] csv(History history, Erzeugung erzeugung) {
        StringBuilder out = new StringBuilder();
        if (erzeugung.teilansicht() != null) {
            out.append("# ").append(erzeugung.teilansicht().replace('\r', ' ').replace('\n', ' ')).append('\n');
        }
        Meta m = history.meta();
        out.append("# point_key=").append(csv(m.pointKey())).append('\n')
                .append("# label=").append(csv(m.label())).append('\n')
                .append("# source_label=").append(csv(m.sourceLabel())).append('\n')
                .append("# unit=").append(csv(m.unit())).append('\n')
                .append("# aggregation=").append(csv(m.aggregationKind())).append('\n')
                .append("# semantic_status=").append(csv(m.semanticStatus())).append('\n')
                .append("# catalog_version=").append(csv(m.catalogVersion())).append('\n')
                .append("# representation=").append(csv(m.representation())).append('\n')
                .append("# site_id=").append(csv(m.siteId().toString())).append('\n')
                .append("# entity_id=").append(csv(m.entityId() == null ? null
                        : m.entityId().toString())).append('\n')
                .append("# quelle=").append(csv(m.quelle())).append('\n')
                .append("# quelle_erklaerung=").append(csv(m.quelleErklaerung())).append('\n')
                .append("# raw_available=").append(m.rawAvailable()).append('\n')
                .append("# roh_grenze=").append(csv(m.rohGrenze() == null ? null
                        : m.rohGrenze().toString())).append('\n')
                .append("# catalog_version_gespeichert=")
                .append(csv(String.join(" ", m.katalogVersionenGespeichert()))).append('\n')
                // UEMS AP-12 IP-10 (E11 DA4): additiv — die Datei sagt selbst, welcher Zeitraum,
                // wann, von wem, in welcher Form und wo.
                .append("# zeitraum_von=").append(csv(m.from() == null ? null
                        : m.from().toString())).append('\n')
                .append("# zeitraum_bis=").append(csv(m.to() == null ? null
                        : m.to().toString())).append('\n')
                .append("# erzeugt_am=").append(csv(erzeugung.erzeugtAm().toString())).append('\n')
                .append("# erzeugt_von=").append(csv(erzeugung.erzeugtVon())).append('\n')
                .append("# zeitzone=").append(csv("UTC")).append('\n')
                .append("# dezimal=").append(csv(".")).append('\n')
                .append("# trenner=").append(csv(",")).append('\n')
                .append("# standort=").append(csv(erzeugung.standort())).append('\n')
                .append("# unternehmen=").append(csv(erzeugung.unternehmen())).append('\n')
                .append("time,value,min,max,text,sample_count,gap")
                .append(",quelle,wertart,abdeckung_prozent,erhalten,erwartet,n_good,n_uncertain,")
                .append("n_invalid,n_stale,n_device_error,zustand,endgueltig_ab,version,")
                .append("nachgeliefert,zustellart,letzte_eingangszeit,geraet_einbau,")
                .append("geraet_einbau_2,box,box_2,fassung,katalog_version,rolle,stand_anfang,")
                .append("stand_ende\n");
        for (Datum d : history.data()) {
            out.append(d.time()).append(',').append(value(d.value())).append(',')
                    .append(value(d.minimum())).append(',').append(value(d.maximum())).append(',')
                    .append(csv(d.text())).append(',').append(d.sampleCount()).append(',')
                    .append(d.gap());
            Herkunft h = d.herkunft();
            out.append(',').append(csv(h == null ? null : h.quelle()))
                    .append(',').append(csv(h == null ? null : h.wertart()))
                    .append(',').append(zahl(h == null ? null : h.abdeckungProzent()))
                    .append(',').append(zahl(h == null ? null : h.erhalten()))
                    .append(',').append(zahl(h == null ? null : h.erwartet()))
                    .append(',').append(zahl(h == null ? null : h.nGood()))
                    .append(',').append(zahl(h == null ? null : h.nUncertain()))
                    .append(',').append(zahl(h == null ? null : h.nInvalid()))
                    .append(',').append(zahl(h == null ? null : h.nStale()))
                    .append(',').append(zahl(h == null ? null : h.nDeviceError()))
                    .append(',').append(csv(h == null ? null : h.zustand()))
                    .append(',').append(zeit(h == null ? null : h.endgueltigAb()))
                    .append(',').append(zahl(h == null ? null : h.version()))
                    .append(',').append(zahl(h == null ? null : h.nachgeliefert()))
                    .append(',').append(csv(h == null ? null : h.zustellart()))
                    .append(',').append(zeit(h == null ? null : h.letzteEingangszeit()))
                    .append(',').append(kennung(h == null ? null : h.geraetEinbau()))
                    .append(',').append(kennung(h == null ? null : h.geraetEinbauZwei()))
                    .append(',').append(kennung(h == null ? null : h.box()))
                    .append(',').append(kennung(h == null ? null : h.boxZwei()))
                    .append(',').append(zahl(h == null ? null : h.fassung()))
                    .append(',').append(csv(h == null ? null : h.katalogVersion()))
                    .append(',').append(csv(h == null ? null : h.rolle()))
                    .append(',').append(value(h == null ? null : h.standAnfang()))
                    .append(',').append(value(h == null ? null : h.standEnde()))
                    .append('\n');
        }
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** A deliberately small, recent, semantically known site picker; never a catalog wall. */
    public List<ComparisonOption> comparisonOptions(UUID siteId) {
        geltungsbereich.requireSite(siteId);
        record Seen(UUID deviceId, String deviceLabel, String pointKey, Instant lastReadAt) {}
        List<Seen> seen = jdbc.query("SELECT d.id device_id, COALESCE(d.name,d.external_ref) device_label,"
                        + "s.point_key,s.last_read_at last_read FROM device_measurement_point_state s "
                        + "JOIN device d ON d.id=s.device_id WHERE s.site_id=? "
                        + "ORDER BY s.last_read_at DESC LIMIT 200",
                (rs, n) -> new Seen(rs.getObject("device_id", UUID.class),
                        rs.getString("device_label"), rs.getString("point_key"),
                        rs.getTimestamp("last_read").toInstant()), siteId);
        List<ComparisonOption> result = new ArrayList<>();
        for (Seen item : seen) {
            Point point = catalog.resolve(item.pointKey());
            if (point == null) {
                point = catalog.resolve(MeasurementSelectionRepository.templateKey(item.pointKey()));
            }
            if (point == null || !"known".equals(point.semanticStatus()) || point.unit() == null
                    || !(point.aggregationKind().equals("gauge")
                            || point.aggregationKind().equals("counter"))) continue;
            String label = point.labelDe() == null ? point.labelSource() : point.labelDe();
            String compatibility = point.aggregationKind() + "|"
                    + label.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9äöüß]+", "-");
            result.add(new ComparisonOption(item.deviceId(), item.deviceLabel(), item.pointKey(),
                    label, point.unit(), point.aggregationKind(), compatibility, item.lastReadAt()));
            if (result.size() == 40) break;
        }
        return List.copyOf(result);
    }

    private List<Marker> markers(MeasurementSelectionRepository.DeviceScope scope, UUID siteId,
            UUID deviceId, UUID entityId, UUID reihe, String pointKey, Window w) {
        List<Marker> result = new ArrayList<>();
        result.addAll(jdbc.query("SELECT requested_at marker_time,event_kind,requested_enabled,apply_status "
                        + "FROM device_measurement_selection_event WHERE tenant_id=? AND site_id=? "
                        + "AND device_id=? AND point_key=? "
                        + "AND requested_at>=? AND requested_at<=? ORDER BY requested_at",
                (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                        rs.getString("event_kind"), selectionLabel(rs.getString("event_kind"),
                                rs.getBoolean("requested_enabled"), rs.getString("apply_status"))),
                scope.tenantId(), siteId, deviceId, pointKey,
                Timestamp.from(w.from()), Timestamp.from(w.to())));
        // UEMS AP-08 IP-4: eine Bestands-Rücksetzung, zu der der Writer an derselben Messzeit
        // einen Überlauf meldet, IST dieser Überlauf — er steht als Marke der Reihe da, die
        // Rücksetzung nicht noch einmal. Ohne Reihe bleibt die Abfrage Zeichen für Zeichen die alte.
        List<Object> bestandArgs = new ArrayList<>(List.of(scope.tenantId(), siteId, deviceId,
                pointKeyValue(pointKey), Timestamp.from(w.from()), Timestamp.from(w.to())));
        if (reihe != null) {
            bestandArgs.add(reihe);
        }
        result.addAll(jdbc.query("SELECT occurred_at marker_time,event_kind,previous_numeric,"
                        + "value_numeric,previous_text,value_text FROM device_measurement_event "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=? "
                        + "AND (" + pointKeyPredicate("point_key", pointKey)
                        + " OR point_key='_pipeline') AND occurred_at>=? AND occurred_at<=? "
                        + "AND event_kind IN ('data_gap','counter_reset','state_change','error_change',"
                        + "'bitfield_change','text_change') "
                        + (reihe == null ? ""
                                : "AND " + SpeicherklasseHistorie.RUECKSETZUNG_OHNE_UEBERLAUF + " ")
                        + "ORDER BY occurred_at",
                (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                        rs.getString("event_kind"), eventLabel(rs)), bestandArgs.toArray()));
        if (entityId != null) {
            result.addAll(jdbc.query("SELECT effective_at marker_time,event_type,from_value,to_value "
                            + "FROM component_change_event WHERE tenant_id=? AND site_id=? "
                            + "AND entity_id=? AND event_type='family_changed' "
                            + "AND effective_at>=? AND effective_at<=? ORDER BY effective_at",
                    (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                            rs.getString("event_type"), "Anbindungsfamilie gewechselt: "
                                    + display(rs.getString("from_value")) + " → "
                                    + display(rs.getString("to_value"))),
                    scope.tenantId(), siteId, entityId, Timestamp.from(w.from()),
                    Timestamp.from(w.to())));
        }
        result.sort(java.util.Comparator.comparing(Marker::time));
        return List.copyOf(result);
    }

    private static String eventLabel(java.sql.ResultSet rs) throws java.sql.SQLException {
        String kind = rs.getString("event_kind");
        if ("data_gap".equals(kind)) return "Datenlücke";
        if ("counter_reset".equals(kind)) return "Zählerneustart";
        String before = display(rs.getString("previous_text"));
        String after = display(rs.getString("value_text"));
        if (rs.getString("previous_text") == null && rs.getObject("previous_numeric") != null) {
            before = rs.getString("previous_numeric");
        }
        if (rs.getString("value_text") == null && rs.getObject("value_numeric") != null) {
            after = rs.getString("value_numeric");
        }
        return switch (kind) {
            case "error_change" -> "Qualität/Fehler: " + before + " → " + after;
            case "bitfield_change" -> "Bitfeld: " + before + " → " + after;
            case "text_change" -> "Text: " + before + " → " + after;
            default -> "Zustand: " + before + " → " + after;
        };
    }

    private CustomMeta customMeta(UUID deviceId, String pointKey) {
        List<CustomMeta> rows = jdbc.query("SELECT custom_definition->>'label' label, "
                        + "custom_definition->>'unit' unit,catalog_version "
                        + "FROM device_measurement_selection WHERE device_id=? AND point_key=? "
                        + "AND custom_definition IS NOT NULL",
                (rs, n) -> new CustomMeta(rs.getString("label"), rs.getString("unit"),
                        rs.getString("catalog_version")), deviceId, pointKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static String selectionLabel(String kind, boolean enabled, String status) {
        if ("first_sample".equals(kind) || "first_sample".equals(status)) return "Erster Wert";
        if ("edge_ack".equals(kind)) return "Auswahl angewendet";
        return enabled ? "Aufzeichnung angefordert" : "Aufzeichnung beendet (Historie bleibt)";
    }

    private static String display(String value) {
        return value == null || value.isBlank() ? "unbekannt" : value;
    }

    private static String pointKeyPredicate(String column, String pointKey) {
        return pointKey != null && pointKey.contains("[*]")
                ? column + " LIKE ? ESCAPE '\\'" : column + "=?";
    }

    private static String pointKeyValue(String pointKey) {
        if (pointKey == null || !pointKey.contains("[*]")) return pointKey;
        return pointKey.replace("\\", "\\\\").replace("%", "\\%")
                .replace("_", "\\_").replace("[*]", "[%]");
    }

    private static Window window(String range, Instant freeFrom, Instant freeTo) {
        Instant to = freeTo == null ? Instant.now() : freeTo;
        Duration duration = switch (range == null ? "24h" : range) {
            case "24h" -> Duration.ofHours(24);
            case "7d" -> Duration.ofDays(7);
            case "30d" -> Duration.ofDays(30);
            case "90d" -> Duration.ofDays(90);
            case "year" -> Duration.ofDays(366);
            case "free" -> freeFrom == null ? null : Duration.between(freeFrom, to);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unbekannter Zeitraum.");
        };
        if (duration == null || duration.isNegative() || duration.isZero()
                || duration.compareTo(Duration.ofDays(366)) > 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der freie Zeitraum muss zwischen einer Sekunde und einem Jahr liegen.");
        }
        Instant from = "free".equals(range) ? freeFrom : to.minus(duration);
        int bucketSeconds = duration.compareTo(Duration.ofDays(2)) <= 0 ? 300
                : duration.compareTo(Duration.ofDays(31)) <= 0 ? 900
                : duration.compareTo(Duration.ofDays(100)) <= 0 ? 3600 : 21600;
        return new Window(from.truncatedTo(ChronoUnit.SECONDS), to.truncatedTo(ChronoUnit.SECONDS),
                bucketSeconds + " seconds", bucketSeconds, duration);
    }

    private record Window(Instant from, Instant to, String bucket, int bucketSeconds,
            Duration duration) {}
    private record CustomMeta(String label, String unit, String catalogVersion) {}

    private static BigDecimal nullableDecimal(java.sql.ResultSet rs, String name)
            throws java.sql.SQLException {
        return rs.getBigDecimal(name);
    }
    private static String value(BigDecimal value) {
        return value == null ? "" : value.toPlainString();
    }
    /** Eine fehlende Zahl bleibt LEER — nie eine erfundene 0 (Hausregel „Ehrlichkeit der Zahlen"). */
    private static String zahl(Number value) {
        return value == null ? "" : value.toString();
    }
    private static String zeit(Instant value) {
        return value == null ? "" : value.toString();
    }
    private static String kennung(UUID value) {
        return value == null ? "" : value.toString();
    }
    private static String csv(String value) {
        if (value == null) return "";
        if (!value.isEmpty() && "=+-@\t\r".indexOf(value.charAt(0)) >= 0) value = "'" + value;
        return '"' + value.replace("\"", "\"\"") + '"';
    }
}
