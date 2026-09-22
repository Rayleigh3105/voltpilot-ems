package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import com.voltpilot.api.web.dto.BewertungMessabdeckungDto;
import com.voltpilot.api.web.dto.BewertungRanglisteDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.BiPredicate;
import java.util.function.Function;
import java.util.function.Predicate;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Was nur der Abzug eines Unternehmensberichts trägt (UEMS AP-12 IP-6, bericht.md A2/Q3, Vertrag 1.1).
 *
 * <ul>
 *   <li><b>Messstellen (Q3).</b> Je Standort die Hauptzähler Richtung Bezug — die Standort-Summe „Netzbezug“, sie tragen
 *       die Standort-Abschnitte —, die Messstellen mit dem Unternehmen als Ort (MS-19) und die Prozess-Messstellen ohne
 *       Ort (MS-20), je Tag, Tage einschließlich. So zitieren die Vektoren B3 den Unternehmensbericht BR-2026-0002.</li>
 *   <li><b>Kostenstellen.</b> Die Kostenstellen-Sicht (AP-10 IP-11) wird AUFGERUFEN — {@link KostenstelleEnergieService}
 *       mit ausdrücklichem Mandanten —, nie nachgebaut: je Kostenstelle, die einen Tag des Zeitraums besteht, ihre Blöcke
 *       und je Posten die Verteilungs-Sätze zum Tag. Die Posten-Messstellen sind mittelbare Quellen (Q6).</li>
 * </ul>
 *
 * <p>Mandant ausdrücklich in jeder Abfrage: die Kaskade (IP-8) reicht eine Verbindung der Verwaltungsrolle herein.
 */
final class BerichtUnternehmen {

    /** Das Unternehmen als Ort (Referenzunternehmen): Kennzeichen seiner Geltung und Ort seiner Messstellen im Abzug. */
    static final String KENNZEICHEN = "U";

    static final String KOSTENSTELLE = "kostenstelle";

    /** Ein Standort-Abschnitt: der Standort und seine Netzbezugs-Zähler. */
    record Abschnitt(UUID standort, String kennzeichen, String name, List<UUID> messstellen) {}

    /**
     * Die Messstellen eines Berichts je Tag (mit dem Ort, den der Abzug nennt; {@code null} ohne Ort), die Messstellen der
     * Unternehmens-Ebene und die Standort-Abschnitte.
     */
    record Umfang(Map<UUID, TreeMap<LocalDate, String>> tage, Set<UUID> eigene, List<Abschnitt> abschnitte) {}

    /** Der vollständige Abzug der Vorlage {@code energetische_bewertung}. */
    record BewertungsAbzug(ObjectNode abzug, List<BerichtAbzugBildung.Quelle> quellen, List<Instant> zeiten) {}

    private BerichtUnternehmen() {}

    static BerichtAbzugBildung.Geltung geltung(JdbcTemplate j, UUID tenant, UUID unternehmen) {
        return j.queryForObject("SELECT name, sitz_strasse, sitz_plz, sitz_ort FROM unternehmen WHERE id = ? "
                + "AND tenant_id = ?", (rs, i) -> new BerichtAbzugBildung.Geltung(BerichtRegeln.UNTERNEHMEN,
                        rs.getString("name"), KENNZEICHEN, null, rs.getString("name"),
                        sitz(rs.getString("sitz_strasse"), rs.getString("sitz_plz"), rs.getString("sitz_ort"))),
                unternehmen, tenant);
    }

    /**
     * AP-16 S1/S2: Die Bewertung schreibt die vorhandenen Bewertungs-Leser ab. Keine Zahl wird hier neu gerechnet.
     * Einstufungen tragen ihre wirksame Fassung und die bei der Entscheidung eingefrorene Herkunft; jede Eingangsmenge
     * der Rangliste behält die Version aus dem vorhandenen Leser.
     */
    static BewertungsAbzug bewertung(JdbcTemplate j, ObjectMapper json, UUID tenant, UUID bericht, String kennung,
            UUID unternehmen, BerichtRegeln.Zeitraum z, ZoneId zone, Instant jetzt, BerichtRegelwerk regelwerk,
            BewertungRanglisteService ranglisten, BewertungMessabdeckungService abdeckungen) {
        BewertungRanglisteDto.Rangliste rangliste = ranglisten.lesen(z.ersterTag(), z.letzterTag());
        BewertungMessabdeckungDto.Messabdeckung abdeckung = abdeckungen.lesen(z.ersterTag(), z.letzterTag());
        BerichtAbzugBildung.Geltung g = geltung(j, tenant, unternehmen);
        List<BerichtAbzugBildung.Quelle> quellen = new ArrayList<>();
        List<Instant> zeiten = new ArrayList<>();

        ObjectNode abzug = json.createObjectNode();
        ObjectNode kopf = abzug.putObject("kopf");
        kopf.put("bericht", kennung);
        kopf.put("vorlage", BerichtRegeln.ENERGETISCHE_BEWERTUNG);
        kopf.put("vorlage_fassung", 1);
        ObjectNode geltung = kopf.putObject("geltung");
        geltung.put("art", g.art());
        geltung.put("kennzeichen", g.kennzeichen());
        geltung.put("name_zum_datenstand", g.name());
        kopf.put("unternehmen", g.unternehmen());
        kopf.put("sitz", g.sitz());
        ObjectNode zeitraum = kopf.putObject("zeitraum");
        zeitraum.put("art", z.art());
        zeitraum.put("schluessel", z.schluessel());
        zeitraum.put("von", BerichtAbzugBildung.iso(z.von(), zone));
        zeitraum.put("bis", BerichtAbzugBildung.iso(z.bis(), zone));
        zeitraum.put("zone", zone.getId());
        kopf.putArray("vergleichszeitraeume");
        kopf.put("datenstand", BerichtAbzugBildung.iso(jetzt, zone));
        ObjectNode rw = kopf.putObject("regelwerk");
        rw.put("software", regelwerk.software());
        ObjectNode vertraege = rw.putObject("vertraege");
        regelwerk.vertraege().forEach(vertraege::put);
        ObjectNode darstellung = kopf.putObject("darstellung");
        darstellung.put("zeitzone", zone.getId());
        darstellung.put("zahlenformat", BerichtAbzugBildung.ZAHLENFORMAT);
        darstellung.put("dezimal", BerichtAbzugBildung.DEZIMAL);
        darstellung.put("rundung", BerichtAbzugBildung.RUNDUNG);
        darstellung.put("sommerzeit", BerichtAbzugBildung.SOMMERZEIT);

        ObjectNode umfang = abzug.putObject("umfang");
        umfang.put("id", rangliste.umfangId().toString());
        umfang.put("fassung", rangliste.umfangFassung());
        umfang.put("von", rangliste.von().toString());
        umfang.put("bis", rangliste.bis().toString());
        umfang.put("teilansicht", rangliste.teilansicht());
        quellen.add(new BerichtAbzugBildung.Quelle("umfang", "Umfang", rangliste.umfangId(),
                BerichtRegeln.UNMITTELBAR, z.ersterTag(), z.letzterTag(), null, rangliste.umfangFassung(),
                "Umfang der energetischen Bewertung"));
        abzug.set("rangliste", json.valueToTree(rangliste));
        abzug.set("messabdeckung", json.valueToTree(abdeckung));

        List<BewertungRanglisteDto.Einsatz> einsaetze = new ArrayList<>(rangliste.einsaetze());
        einsaetze.addAll(rangliste.weitereTraeger());
        Set<UUID> einsatzIds = new LinkedHashSet<>();
        Set<UUID> messstellenIds = new LinkedHashSet<>();
        einsaetze.forEach(e -> {
            einsatzIds.add(e.id());
            e.messstellen().forEach(m -> messstellenIds.add(m.id()));
        });

        ArrayNode einstufungen = abzug.putArray("einstufungen");
        j.query("""
                SELECT e.id, e.kennzeichen, e.name, x.nummer, x.einstufung, x.begruendung,
                       x.grund::text, x.herkunft::text, x.gueltig_ab, x.actor_name, x.created_at
                  FROM energieeinsatz e
                  LEFT JOIN LATERAL (
                    SELECT * FROM energieeinsatz_einstufung x
                     WHERE x.tenant_id=e.tenant_id AND x.einsatz_id=e.id
                       AND x.freigabe_status='freigegeben' AND x.gueltig_ab <= ?
                       AND (x.gueltig_bis IS NULL OR x.gueltig_bis >= ?)
                     ORDER BY x.nummer DESC LIMIT 1
                  ) x ON true
                 WHERE e.tenant_id=? ORDER BY e.kennzeichen
                """, rs -> {
                    UUID id = rs.getObject("id", UUID.class);
                    if (!einsatzIds.contains(id)) return;
                    Integer fassung = (Integer) rs.getObject("nummer");
                    ObjectNode n = einstufungen.addObject();
                    n.put("einsatz_id", id.toString());
                    n.put("einsatz", rs.getString("kennzeichen"));
                    n.put("name_zum_datenstand", rs.getString("name"));
                    if (fassung == null) {
                        n.putNull("fassung");
                        n.put("einstufung", "offen");
                        n.putNull("begruendung");
                        n.putArray("grund");
                        n.putNull("herkunft");
                    } else {
                        n.put("fassung", fassung);
                        n.put("einstufung", rs.getString("einstufung"));
                        n.put("begruendung", rs.getString("begruendung"));
                        n.set("grund", baum(json, rs.getString("grund")));
                        n.set("herkunft", baum(json, rs.getString("herkunft")));
                        n.put("gueltig_ab", rs.getObject("gueltig_ab", LocalDate.class).toString());
                        n.put("person", rs.getString("actor_name"));
                        Instant erstellt = rs.getTimestamp("created_at").toInstant();
                        n.put("erstellt_am", BerichtAbzugBildung.iso(erstellt, zone));
                        zeiten.add(erstellt);
                    }
                    quellen.add(new BerichtAbzugBildung.Quelle("energieeinsatz", rs.getString("kennzeichen"), id,
                            BerichtRegeln.UNMITTELBAR, z.ersterTag(), z.letzterTag(), null, fassung,
                            rs.getString("name")));
                }, Date.valueOf(z.letzterTag()), Date.valueOf(z.ersterTag()), tenant);

        ArrayNode messplanung = abzug.putArray("messplanung");
        j.query("""
                SELECT b.id, b.kennzeichen, b.einsatz_id, b.wortlaut, b.ort, b.groesse, b.frist, b.zustand,
                       b.messstelle_id, m.kennzeichen AS messstelle, b.begruendung, b.created_at, b.updated_at
                  FROM messbedarf b LEFT JOIN messstelle m ON m.id=b.messstelle_id AND m.tenant_id=b.tenant_id
                 WHERE b.tenant_id=? ORDER BY b.kennzeichen
                """, rs -> {
                    UUID einsatz = rs.getObject("einsatz_id", UUID.class);
                    if (!einsatzIds.contains(einsatz)) return;
                    UUID id = rs.getObject("id", UUID.class);
                    ObjectNode n = messplanung.addObject();
                    n.put("id", id.toString());
                    n.put("kennzeichen", rs.getString("kennzeichen"));
                    n.put("einsatz_id", einsatz.toString());
                    n.put("wortlaut", rs.getString("wortlaut"));
                    n.put("ort", rs.getString("ort"));
                    n.put("groesse", rs.getString("groesse"));
                    LocalDate frist = rs.getObject("frist", LocalDate.class);
                    n.put("frist", frist == null ? null : frist.toString());
                    n.put("zustand", rs.getString("zustand"));
                    n.put("messstelle", rs.getString("messstelle"));
                    n.put("begruendung", rs.getString("begruendung"));
                    Instant geaendert = rs.getTimestamp("updated_at").toInstant();
                    n.put("datenstand", BerichtAbzugBildung.iso(geaendert, zone));
                    zeiten.add(geaendert);
                    quellen.add(new BerichtAbzugBildung.Quelle("messbedarf", rs.getString("kennzeichen"), id,
                            BerichtRegeln.UNMITTELBAR, z.ersterTag(), z.letzterTag(), null, null,
                            rs.getString("wortlaut")));
                }, tenant);

        ArrayNode messmittel = abzug.putArray("messmittel");
        if (!messstellenIds.isEmpty()) {
            String[] ids = messstellenIds.stream().map(UUID::toString).toArray(String[]::new);
            j.query("""
                    SELECT DISTINCT g.id, g.kennzeichen, g.einbau_kennzeichen, g.genauigkeitsklasse, g.pruefungsart,
                           g.pruefung_am, g.pruefung_gueltig_bis, g.beleg_bezeichnung, g.beleg_ablage, g.beleg_sha256,
                           g.beleg_am
                      FROM messstelle_quelle q JOIN geraet g ON g.id=q.geraet_id AND g.tenant_id=q.tenant_id
                     WHERE q.tenant_id=? AND q.messstelle_id=ANY (?::uuid[])
                       AND q.gueltig_ab < ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)
                     ORDER BY g.kennzeichen, g.einbau_kennzeichen
                    """, rs -> {
                        UUID id = rs.getObject("id", UUID.class);
                        ObjectNode n = messmittel.addObject();
                        n.put("id", id.toString());
                        n.put("geraet", rs.getString("kennzeichen"));
                        n.put("einbau", rs.getString("einbau_kennzeichen"));
                        n.put("genauigkeitsklasse", rs.getString("genauigkeitsklasse"));
                        n.put("pruefungsart", rs.getString("pruefungsart") == null ? MessmittelService.NICHT_ERHOBEN
                                : rs.getString("pruefungsart"));
                        LocalDate am = rs.getObject("pruefung_am", LocalDate.class);
                        LocalDate bis = rs.getObject("pruefung_gueltig_bis", LocalDate.class);
                        n.put("pruefung_am", am == null ? null : am.toString());
                        n.put("pruefung_gueltig_bis", bis == null ? null : bis.toString());
                        ObjectNode beleg = n.putObject("beleg");
                        beleg.put("bezeichnung", rs.getString("beleg_bezeichnung"));
                        beleg.put("ablage", rs.getString("beleg_ablage"));
                        beleg.put("sha256", rs.getString("beleg_sha256"));
                        Timestamp belegAm = rs.getTimestamp("beleg_am");
                        if (belegAm != null) zeiten.add(belegAm.toInstant());
                        quellen.add(new BerichtAbzugBildung.Quelle("messmittel", rs.getString("einbau_kennzeichen"), id,
                                BerichtRegeln.UNMITTELBAR, z.ersterTag(), z.letzterTag(), null, null,
                                rs.getString("kennzeichen")));
                    }, tenant, ids, Timestamp.from(z.bis()), Timestamp.from(z.von()));
        }

        // Die Messwerte der Rangliste bleiben Quellen der Bericht-Maschine; ihre Monatsversionen stehen im Abzug.
        for (BewertungRanglisteDto.Einsatz e : einsaetze) {
            for (BewertungRanglisteDto.Messstelle m : e.messstellen()) {
                int version = m.monatswerte().werte().stream().mapToInt(w -> w.version() == null ? 0 : w.version())
                        .max().orElse(0);
                String name = j.queryForList("SELECT name FROM messstelle WHERE tenant_id=? AND id=?", String.class,
                        tenant, m.id()).stream().findFirst().orElse(m.kennzeichen());
                quellen.add(new BerichtAbzugBildung.Quelle("messstelle", m.kennzeichen(), m.id(),
                        BerichtRegeln.UNMITTELBAR, z.ersterTag(), z.letzterTag(), version == 0 ? null : version, null,
                        name));
            }
        }

        ObjectNode qualitaet = abzug.putObject("qualitaet");
        String abdeckungProzent = abdeckung.summe().abdeckungProzent();
        qualitaet.put("abdeckung_min_prozent", abdeckungProzent == null ? BigDecimal.ZERO
                : new BigDecimal(abdeckungProzent));
        long luecken = abdeckung.jeEinsatz().stream().mapToLong(e -> e.ungemessen().size()).sum();
        long ersatz = abdeckung.jeEinsatz().stream().mapToLong(e -> e.ersatz().size()).sum();
        qualitaet.put("luecken", luecken);
        qualitaet.put("ersatzwerte", ersatz);
        qualitaet.put("korrekturen_im_zeitraum", 0);
        qualitaet.put("vorlaeufig", "vorlaeufig".equals(rangliste.urteil().K7()) ? 1 : 0);

        ArrayNode verzeichnis = kopf.putArray("quellenverzeichnis");
        quellen.stream().map(BerichtAbzugBildung.Quelle::kennzeichen).distinct().sorted().forEach(verzeichnis::add);
        return new BewertungsAbzug(abzug, List.copyOf(new LinkedHashSet<>(quellen)), List.copyOf(zeiten));
    }

    private static com.fasterxml.jackson.databind.JsonNode baum(ObjectMapper json, String text) {
        try {
            return text == null ? json.nullNode() : json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("Gespeicherte Bewertungs-Herkunft ist ungültig", e);
        }
    }

    /** „Straße, PLZ Ort“ — fehlende Teile fallen weg. */
    static String sitz(String strasse, String plz, String ort) {
        List<String> stadt = new ArrayList<>();
        if (plz != null) {
            stadt.add(plz);
        }
        if (ort != null) {
            stadt.add(ort);
        }
        List<String> teile = new ArrayList<>();
        if (strasse != null) {
            teile.add(strasse);
        }
        if (!stadt.isEmpty()) {
            teile.add(String.join(" ", stadt));
        }
        return String.join(", ", teile);
    }

    // =========================================================================== Q3

    static Umfang umfang(JdbcTemplate j, UUID tenant, UUID unternehmen, LocalDate von, LocalDate bis,
            MessstelleRepository messstellen, BiPredicate<MessstelleRepository.Messstelle, LocalDate> netzbezug) {
        Map<UUID, TreeMap<LocalDate, String>> tage = new LinkedHashMap<>();
        List<Abschnitt> abschnitte = new ArrayList<>();
        List<Object[]> standorte = j.query("SELECT id, kurzzeichen, name FROM standort WHERE tenant_id = ? "
                + "AND unternehmen_id = ? ORDER BY kurzzeichen, id", (rs, i) -> new Object[] {
                    rs.getObject("id", UUID.class), rs.getString("kurzzeichen"), rs.getString("name")},
                tenant, unternehmen);
        for (Object[] s : standorte) {
            Map<UUID, TreeMap<LocalDate, String>> amStandort = BerichtAbzugBildung.messstellenDerGeltung(j, tenant,
                    (UUID) s[0], von, bis);
            if (amStandort.isEmpty()) {
                continue;
            }
            List<MessstelleRepository.Messstelle> zaehler = new ArrayList<>();
            amStandort.forEach((id, t) -> {
                MessstelleRepository.Messstelle m = messstellen.finde(id).orElseThrow(() ->
                        new IllegalStateException("Messstelle " + id + " fehlt"));
                if (netzbezug.test(m, t.lastKey())) {
                    zaehler.add(m);
                    tage.put(id, t);
                }
            });
            zaehler.sort(Comparator.comparing(MessstelleRepository.Messstelle::kennzeichen));
            abschnitte.add(new Abschnitt((UUID) s[0], (String) s[1], (String) s[2],
                    zaehler.stream().map(MessstelleRepository.Messstelle::id).toList()));
        }
        Set<UUID> eigene = new LinkedHashSet<>();
        j.query("""
                SELECT d::date AS tag, o.messstelle_id
                  FROM generate_series(?::date, ?::date, interval '1 day') AS d
                  JOIN messstelle_ort o ON o.tenant_id = ? AND o.unternehmen_id = ? AND o.aufgehoben_am IS NULL
                   AND daterange(o.gueltig_ab, o.gueltig_bis, '[]') @> d::date
                 ORDER BY 2, 1
                """, rs -> {
                    UUID id = rs.getObject("messstelle_id", UUID.class);
                    tage.computeIfAbsent(id, x -> new TreeMap<>()).put(rs.getObject("tag", LocalDate.class), KENNZEICHEN);
                    eigene.add(id);
                }, Date.valueOf(von), Date.valueOf(bis), tenant, unternehmen);
        j.query("""
                SELECT DISTINCT d::date AS tag, p.messstelle_id
                  FROM generate_series(?::date, ?::date, interval '1 day') AS d
                  JOIN messstelle_prozess p ON p.tenant_id = ? AND p.aufgehoben_am IS NULL
                   AND daterange(p.gueltig_ab, p.gueltig_bis, '[]') @> d::date
                 WHERE NOT EXISTS (SELECT 1 FROM messstelle_ort o WHERE o.tenant_id = p.tenant_id
                         AND o.messstelle_id = p.messstelle_id AND o.aufgehoben_am IS NULL
                         AND daterange(o.gueltig_ab, o.gueltig_bis, '[]') @> d::date)
                 ORDER BY 2, 1
                """, rs -> {
                    UUID id = rs.getObject("messstelle_id", UUID.class);
                    tage.computeIfAbsent(id, x -> new TreeMap<>()).put(rs.getObject("tag", LocalDate.class), null);
                    eigene.add(id);
                }, Date.valueOf(von), Date.valueOf(bis), tenant);
        return new Umfang(tage, eigene, abschnitte);
    }

    /**
     * „Energiemanagement seit“ am Unternehmen (Q5): der früheste Tag bis {@code bis}, an dem der Bericht eine Messstelle
     * hätte — eine Zugehörigkeit beginnt nur am {@code gueltig_ab} einer Orts-, Stellungs- oder Prozess-Zuordnung.
     */
    static LocalDate bestehtSeit(JdbcTemplate j, UUID tenant, LocalDate bis, Predicate<LocalDate> hatMessstellen) {
        List<LocalDate> kandidaten = j.query("SELECT tag FROM (SELECT gueltig_ab AS tag FROM messstelle_ort "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL UNION SELECT gueltig_ab FROM ort_zuordnung "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL UNION SELECT gueltig_ab FROM messstelle_stellung "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL UNION SELECT gueltig_ab FROM messstelle_prozess "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL) k WHERE tag <= ? ORDER BY tag",
                (rs, i) -> rs.getObject(1, LocalDate.class), tenant, tenant, tenant, tenant, Date.valueOf(bis));
        for (LocalDate tag : kandidaten) {
            if (hatMessstellen.test(tag)) {
                return tag;
            }
        }
        return null;
    }

    // =========================================================================== Standort-Abschnitte

    /** Je Standort: seine Netzbezugs-Summe (fehlt, sobald ein Zähler keine Zahl hat — unbekannt ist keine Null). */
    static ArrayNode standorte(ObjectMapper json, Umfang u, Map<UUID, BigDecimal> mengen,
            Function<UUID, String> kennzeichen) {
        ArrayNode aus = json.createArrayNode();
        for (Abschnitt a : u.abschnitte()) {
            ObjectNode n = aus.addObject();
            n.put("kennzeichen", a.kennzeichen());
            n.put("name_zum_datenstand", a.name());
            ObjectNode summen = n.putObject("summen");
            BigDecimal summe = a.messstellen().isEmpty() ? null : BigDecimal.ZERO;
            for (UUID id : a.messstellen()) {
                BigDecimal menge = mengen.get(id);
                summe = summe == null || menge == null ? null : summe.add(menge);
            }
            if (summe != null) {
                summen.put(BerichtAbzugBildung.NETZBEZUG, summe);
            }
            ArrayNode liste = n.putArray("messstellen");
            a.messstellen().forEach(id -> liste.add(kennzeichen.apply(id)));
        }
        return aus;
    }

    // =========================================================================== Kostenstellen

    static ArrayNode kostenstellen(JdbcTemplate j, ObjectMapper json, UUID tenant, KostenstelleEnergieService sicht,
            BerichtRegeln.Zeitraum z, ZoneId zone, Instant jetzt, Set<UUID> berichtMessstellen,
            Collection<BerichtAbzugBildung.Quelle> quellen) {
        ArrayNode aus = json.createArrayNode();
        List<KostenstelleProzessRepository.Objekt> liste = j.query("SELECT id, kennzeichen, name, gueltig_ab, "
                + "gueltig_bis, created_at FROM kostenstelle WHERE tenant_id = ? AND gueltig_ab <= ? "
                + "AND (gueltig_bis IS NULL OR gueltig_bis >= ?) ORDER BY kennzeichen, id",
                (rs, i) -> {
                    Timestamp angelegt = rs.getTimestamp("created_at");
                    return new KostenstelleProzessRepository.Objekt(rs.getObject("id", UUID.class),
                            rs.getString("kennzeichen"), rs.getString("name"), null, null,
                            rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class),
                            angelegt == null ? null : angelegt.toInstant());
                }, tenant, Date.valueOf(z.letzterTag()), Date.valueOf(z.ersterTag()));
        for (KostenstelleProzessRepository.Objekt k : liste) {
            KostenstelleEnergieDto.Energie e = sicht.energie(tenant, k, z.art(), z.ersterTag(), zone, jetzt);
            ObjectNode n = aus.addObject();
            n.put("quelle", k.kennzeichen());
            n.put("name_zum_datenstand", k.name());
            n.put("gueltig_ab", k.gueltigAb().toString());
            n.put("gueltig_bis", k.gueltigBis() == null ? null : k.gueltigBis().toString());
            n.put("periode", z.schluessel());
            n.put("berechnet_am", BerichtAbzugBildung.iso(jetzt, zone));
            n.put("zeitzone", zone.getId());
            n.set("gemessen", block(json, e.gemessen()));
            n.set("verteilt", block(json, e.verteilt()));
            n.set("berechnet", block(json, e.berechnet()));
            n.set("summe", block(json, e.summe()));
            n.set("nicht_verteilt", block(json, e.nichtVerteilt()));

            LocalDate von = k.gueltigAb().isAfter(z.ersterTag()) ? k.gueltigAb() : z.ersterTag();
            LocalDate bis = k.gueltigBis() != null && k.gueltigBis().isBefore(z.letzterTag()) ? k.gueltigBis()
                    : z.letzterTag();
            Integer fassung = null;
            for (KostenstelleEnergieDto.Block b : List.of(e.gemessen(), e.verteilt(), e.berechnet())) {
                for (KostenstelleEnergieDto.Posten p : b.posten()) {
                    for (Integer f : p.fassungen()) {
                        fassung = fassung == null ? f : Math.max(fassung, f);
                    }
                }
            }
            quellen.add(new BerichtAbzugBildung.Quelle(KOSTENSTELLE, k.kennzeichen(), k.id(),
                    BerichtRegeln.UNMITTELBAR, von, bis, null, fassung, k.name()));
            // Q6 — was die Kostenstelle trägt, zitiert der Bericht mittelbar: je Posten die Tage mit einem Anteil.
            for (KostenstelleEnergieDto.Block b : List.of(e.gemessen(), e.verteilt(), e.berechnet())) {
                for (KostenstelleEnergieDto.Posten p : b.posten()) {
                    if (berichtMessstellen.contains(p.messstelle().id())) {
                        continue;
                    }
                    for (LocalDate[] lauf : laeufe(p.tage().stream().filter(t -> t.anteilProzent() != null)
                            .map(KostenstelleEnergieDto.Tag::tag).toList())) {
                        quellen.add(new BerichtAbzugBildung.Quelle(BerichtKennzahlen.MESSSTELLE,
                                p.messstelle().kennzeichen(), p.messstelle().id(), BerichtRegeln.MITTELBAR, lauf[0],
                                lauf[1], p.version(), null, p.messstelle().name()));
                    }
                }
            }
        }
        return aus;
    }

    /** Ein Block der Sicht ohne Kennungen; je Posten die Verteilungs-Sätze zum Tag statt der einzelnen Tage. */
    private static ObjectNode block(ObjectMapper json, KostenstelleEnergieDto.Block b) {
        ObjectNode n = json.createObjectNode();
        n.put("menge", b.menge());
        n.put("einheit", b.einheit());
        n.put("zustand", b.zustand());
        n.put("grund", b.grund());
        ArrayNode summen = n.putArray("summen");
        for (KostenstelleEnergieDto.Summe s : b.summen()) {
            ObjectNode x = summen.addObject();
            x.put("groesse", s.groesse());
            x.put("richtung", s.richtung());
            x.put("einheit", s.einheit());
            x.put("menge", s.menge());
            x.put("zustand", s.zustand());
            x.put("abdeckung_prozent", s.abdeckungProzent());
            x.put("vorhanden", s.vorhanden());
            x.put("gesamt", s.gesamt());
            texte(x.putArray("fehlend"), s.fehlend());
        }
        ArrayNode posten = n.putArray("posten");
        for (KostenstelleEnergieDto.Posten p : b.posten()) {
            ObjectNode x = posten.addObject();
            x.put("quelle", p.messstelle().kennzeichen());
            x.put("name_zum_datenstand", p.messstelle().name());
            x.put("art", p.messstelle().art());
            x.put("groesse", p.groesse());
            x.put("richtung", p.richtung());
            x.put("einheit", p.einheit());
            x.put("menge", p.menge());
            x.put("zustand", p.zustand());
            x.put("abdeckung_prozent", p.abdeckungProzent());
            x.put("version", p.version());
            texte(x.putArray("kennzeichen"), p.kennzeichen());
            ArrayNode fassungen = x.putArray("fassungen");
            (p.fassungen() == null ? List.<Integer>of() : p.fassungen()).forEach(fassungen::add);
            texte(x.putArray("fehlend"), p.fehlend());
            ArrayNode saetze = x.putArray("saetze");
            for (Object[] satz : saetze(p.tage())) {
                ObjectNode s = saetze.addObject();
                s.put("von", satz[0].toString());
                s.put("bis", satz[1].toString());
                s.put("anteil_prozent", (BigDecimal) satz[2]);
            }
            if (p.herkunft() == null) {
                x.putNull("herkunft");
            } else {
                // Die Hülle {satz, fehlt} der Kostenstellen-Sicht (bilanzwert-herkunft), so wie die Route sie ausliefert.
                ObjectNode h = x.putObject("herkunft");
                h.set("satz", json.valueToTree(p.herkunft().get("satz")));
                h.set("fehlt", json.valueToTree(p.herkunft().get("fehlt") == null ? List.of() : p.herkunft().get("fehlt")));
            }
        }
        return n;
    }

    /** Aufeinanderfolgende Tage mit demselben Anteil → {von, bis, anteil}; ein Tag ohne Anteil trennt. */
    static List<Object[]> saetze(List<KostenstelleEnergieDto.Tag> tage) {
        List<Object[]> aus = new ArrayList<>();
        Object[] offen = null;
        for (KostenstelleEnergieDto.Tag t : tage) {
            BigDecimal anteil = t.anteilProzent();
            boolean weiter = offen != null && anteil != null && ((BigDecimal) offen[2]).compareTo(anteil) == 0
                    && ((LocalDate) offen[1]).plusDays(1).equals(t.tag());
            if (weiter) {
                offen[1] = t.tag();
                continue;
            }
            offen = anteil == null ? null : new Object[] {t.tag(), t.tag(), anteil};
            if (offen != null) {
                aus.add(offen);
            }
        }
        return aus;
    }

    /** Aufeinanderfolgende Tage → {von, bis} (Tage einschließlich). */
    static List<LocalDate[]> laeufe(List<LocalDate> tage) {
        List<LocalDate[]> aus = new ArrayList<>();
        LocalDate[] offen = null;
        for (LocalDate tag : tage.stream().sorted().distinct().toList()) {
            if (offen != null && offen[1].plusDays(1).equals(tag)) {
                offen[1] = tag;
            } else {
                offen = new LocalDate[] {tag, tag};
                aus.add(offen);
            }
        }
        return aus;
    }

    private static void texte(ArrayNode ziel, List<String> texte) {
        (texte == null ? List.<String>of() : texte).forEach(ziel::add);
    }
}
