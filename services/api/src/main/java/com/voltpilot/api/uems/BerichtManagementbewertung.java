package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Wiedervorlage;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto.Zeile;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die Abschnitt-Leser der Managementbewertung (UEMS AP-19 IP-22, MG1–MG3): die Vorlage {@code managementbewertung} am
 * Unternehmen für ein Jahr. Jeder Abschnitt ZITIERT Stände und Zustände — Kennzeichen, Nr., Prüfsumme, das Ergebnis wie
 * festgehalten — und rechnet kein Urteil neu: das Ergebnis eines Energieziels steht in seiner Bewertungs-Kopie, die Wirkung
 * einer Maßnahme in ihrem Stand, das Urteil eines Leistungsvergleichs in seinem Berichtsstand. Kein Abschnitt liest einen
 * Kennzahl-Wert, und keine Quelle hat eine Quellenart mit Kennzahl-Werten ({@code energieziel · massnahme · abweichung ·
 * feststellung · internes_audit · dokument · beschluss · berichtsstand}) — darum trifft keine Korrektur die
 * Managementbewertung über die Kaskade (MG3); was sich später ändert, zeigt die nächste.
 *
 * <p>Die Fristen (Überprüfung einer Grundlage, einer Bezugsbasis, der Bewertung) und der Abschnitt „Wiedervorlage zum
 * Stichtag“ kommen aus dem EINEN Leser {@link EnergiemanagementWiedervorlageService} am Datenstand — dieselben Zeilen wie
 * {@code GET …/energiemanagement/wiedervorlage}. Sitzung und Beschlüsse (MG4, MG5) sind die Zeilen von AP-19 IP-23,
 * wie sie zum Datenstand stehen — die Freigabe friert sie mit ein; die Leitung nur, solange die genannte Person am Tag
 * der Sitzung die laufende Aufgabe „Leitung des Unternehmens“ hat (PA3), sonst {@code null}. Der erste Abschnitt liest die
 * Beschlüsse der vorigen Managementbewertung und ihre Folgen mit dem Zustand von heute (MG6, {@link ManagementbewertungLeser}).
 */
final class BerichtManagementbewertung {

    /** MG3 — die acht Quellenarten der Managementbewertung, in der Folge des Vokabulars. */
    static final List<String> QUELLE_ARTEN = List.of("energieziel", "massnahme", "abweichung", "feststellung",
            "internes_audit", "dokument", "beschluss", "berichtsstand");
    /** MG2 — die Dokument-Arten des Abschnitts „Grundlagen“. */
    static final List<String> GRUNDLAGEN = List.of("energiepolitik", "anwendungsbereich", "rechtliche_anforderungen",
            "risiken_chancen");
    static final String NICHTS_FESTGEHALTEN = "Hier ist noch nichts festgehalten.";
    static final String KEINE_VORIGE = "Keine frühere Managementbewertung festgehalten.";
    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    record Abzug(ObjectNode abzug, List<BerichtAbzugBildung.Quelle> quellen) {}

    private BerichtManagementbewertung() {}

    /**
     * Der Abzug zum Datenstand {@code jetzt}: Kopf wie jeder Unternehmens-Bericht (Geltung, Zeitraum, Datenstand,
     * Regelwerk, Darstellung) plus Stichtag, Grenz- und Verantwortungs-Satz; danach die zwölf Abschnitte der Vorlage.
     */
    static Abzug abzug(JdbcTemplate j, ObjectMapper json, UUID tenant, UUID bericht, String kennung, UUID unternehmen,
            BerichtRegeln.Zeitraum z, ZoneId zone, Instant jetzt, BerichtRegelwerk regelwerk, Wiedervorlage wiedervorlage,
            List<WiedervorlageQuelle.Frist> fristen) {
        LocalDate stichtag = LocalDate.ofInstant(jetzt, zone);
        BerichtAbzugBildung.Geltung g = BerichtUnternehmen.geltung(j, tenant, unternehmen);
        Leser l = new Leser(j, json, tenant, z, zone, stichtag, fristen);

        ObjectNode abzug = json.createObjectNode();
        ObjectNode kopf = abzug.putObject("kopf");
        kopf.put("bericht", kennung);
        kopf.put("vorlage", BerichtRegeln.MANAGEMENTBEWERTUNG);
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
        kopf.put("stichtag", stichtag.toString());
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
        kopf.put("grenz_satz", EnergiemanagementRegeln.SAETZE.get("grenz_satz"));
        kopf.put("verantwortung", EnergiemanagementRegeln.SAETZE.get("verantwortung"));

        abzug.set("vorige_beschluesse", l.vorigeBeschluesse(bericht, z.schluessel()));
        abzug.set("grundlagen", l.grundlagen());
        abzug.set("energieziele", l.energieziele());
        abzug.set("energieleistung", l.energieleistung());
        abzug.set("massnahmen", l.massnahmen());
        abzug.set("abweichungen", l.abweichungen());
        abzug.set("audits_feststellungen", l.auditsFeststellungen());
        abzug.set("bewertung_messplanung", l.bewertungMessplanung());
        abzug.set("wiedervorlage", l.wiedervorlage(wiedervorlage));
        abzug.set("beschluesse", l.beschluesse(bericht, kennung));
        abzug.set("sitzung", l.sitzung(bericht));

        List<BerichtAbzugBildung.Quelle> quellen = List.copyOf(new LinkedHashSet<>(l.quellen));
        ArrayNode verzeichnis = abzug.putArray("quellenverzeichnis");
        for (BerichtAbzugBildung.Quelle q : quellen) {
            ObjectNode v = verzeichnis.addObject();
            v.put("art", q.art());
            v.put("kennzeichen", q.kennzeichen());
            v.put("name_zum_datenstand", q.name());
            v.put("bezug", q.bezug());
            zahl(v, "version", q.version());
            zahl(v, "fassung", q.fassung());
            v.put("erster_tag", q.ersterTag().toString());
            v.put("letzter_tag", q.letzterTag().toString());
        }
        ArrayNode kennzeichen = kopf.putArray("quellenverzeichnis");
        quellen.stream().map(BerichtAbzugBildung.Quelle::kennzeichen).distinct().sorted().forEach(kennzeichen::add);
        return new Abzug(abzug, quellen);
    }

    /** Die Leser der Abschnitte — alle auf DER Verbindung der Bildung, im Mandanten des Berichts. */
    private static final class Leser {
        private final JdbcTemplate j;
        private final ObjectMapper json;
        private final UUID tenant;
        private final BerichtRegeln.Zeitraum z;
        private final ZoneId zone;
        private final LocalDate stichtag;
        private final Map<String, WiedervorlageQuelle.Frist> fristJe = new LinkedHashMap<>();
        private final List<WiedervorlageQuelle.Frist> fristen;
        private final List<BerichtAbzugBildung.Quelle> quellen = new ArrayList<>();

        Leser(JdbcTemplate j, ObjectMapper json, UUID tenant, BerichtRegeln.Zeitraum z, ZoneId zone, LocalDate stichtag,
                List<WiedervorlageQuelle.Frist> fristen) {
            this.j = j;
            this.json = json;
            this.tenant = tenant;
            this.z = z;
            this.zone = zone;
            this.stichtag = stichtag;
            this.fristen = fristen;
            for (WiedervorlageQuelle.Frist f : fristen) {
                fristJe.putIfAbsent(f.art() + "/" + f.kennzeichen(), f);
            }
        }

        private void quelle(String art, String kennzeichen, UUID objekt, Integer version, Integer fassung, String name) {
            quellen.add(new BerichtAbzugBildung.Quelle(art, kennzeichen, objekt, BerichtRegeln.UNMITTELBAR, z.ersterTag(),
                    z.letzterTag(), version, fassung, name));
        }

        /** Die Frist eines Objekts, wie die Wiedervorlage sie trägt — {@code null}, wenn sein Objekt keine hat. */
        private ObjectNode frist(String art, String kennzeichen) {
            WiedervorlageQuelle.Frist f = fristJe.get(art + "/" + kennzeichen);
            if (f == null) {
                return null;
            }
            ObjectNode n = json.createObjectNode();
            n.put("faellig_am", f.faelligAm().toString());
            n.put("satz", EnergiemanagementRegeln.lage((int) ChronoUnit.DAYS.between(f.faelligAm(), stichtag)));
            return n;
        }

        private String tag(Timestamp t) {
            return t == null ? null : LocalDate.ofInstant(t.toInstant(), zone).toString();
        }

        private JsonNode baum(String text) {
            try {
                return text == null ? json.nullNode() : json.readTree(text);
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Gespeicherte Kopie ist ungültig", e);
            }
        }

        // ------------------------------------------------------------ vorige_beschluesse

        ObjectNode vorigeBeschluesse(UUID bericht, String jahr) {
            ObjectNode n = json.createObjectNode();
            List<UUID> vorigeId = new ArrayList<>();
            List<ObjectNode> vorige = j.query("SELECT b.id AS bericht_id, b.kennung, b.zeitraum_schluessel, s.id, s.nr, "
                    + "s.pruefsumme, "
                    + "s.freigegeben_am FROM bericht b JOIN bericht_stand s ON s.tenant_id = b.tenant_id "
                    + "AND s.bericht_id = b.id WHERE b.tenant_id = ? AND b.vorlage = ? AND b.id <> ? "
                    + "AND b.archiviert_am IS NULL AND b.zeitraum_schluessel < ? "
                    + "ORDER BY b.zeitraum_schluessel DESC, s.nr DESC LIMIT 1", (rs, i) -> {
                        ObjectNode v = json.createObjectNode();
                        v.put("kennung", rs.getString("kennung"));
                        v.put("zeitraum", rs.getString("zeitraum_schluessel"));
                        v.put("stand_nr", rs.getInt("nr"));
                        v.put("pruefsumme", rs.getString("pruefsumme"));
                        v.put("freigegeben_am", tag(rs.getTimestamp("freigegeben_am")));
                        quelle("berichtsstand", rs.getString("kennung"), rs.getObject("id", UUID.class), rs.getInt("nr"),
                                null, "Managementbewertung " + rs.getString("zeitraum_schluessel"));
                        vorigeId.add(rs.getObject("bericht_id", UUID.class));
                        return v;
                    }, tenant, BerichtRegeln.MANAGEMENTBEWERTUNG, bericht, jahr);
            ArrayNode beschluesse = n.putArray("beschluesse");
            if (vorige.isEmpty()) {
                n.putNull("managementbewertung");
                n.put("satz", KEINE_VORIGE);
                return n;
            }
            ObjectNode v = vorige.get(0);
            n.set("managementbewertung", v);
            n.putNull("satz");
            // MG6: die Beschlüsse, wie sie im Stand stehen (nach der Freigabe unveränderlich), und ihre Folgen mit dem
            // Zustand von heute; ein Beschluss ohne Folge sagt es in einem Satz (B5).
            String vorigeKennung = v.path("kennung").asText();
            UUID vorigerBericht = vorigeId.get(0);
            List<ManagementbewertungLeser.Beschluss> alle = ManagementbewertungLeser.beschluesse(j, tenant, vorigerBericht,
                    zone);
            List<ManagementbewertungLeser.Folge> folgen = ManagementbewertungLeser.folgen(j, tenant, vorigerBericht,
                    vorigeKennung, zone);
            Map<UUID, String> namen = ManagementbewertungLeser.namen(j, tenant, alle.stream()
                    .map(ManagementbewertungLeser.Beschluss::entschiedenVon).distinct().toList());
            String standVom = v.path("freigegeben_am").isNull() ? null
                    : DATUM.format(LocalDate.parse(v.path("freigegeben_am").asText()));
            for (ManagementbewertungLeser.Beschluss b : alle) {
                String bn = vorigeKennung + "/B" + b.nr();
                ObjectNode x = beschluesse.addObject();
                x.put("nr", b.nr());
                x.put("kennung", bn);
                x.put("art", b.art());
                x.put("wortlaut", b.wortlaut());
                x.put("entschieden_von", namen.get(b.entschiedenVon()));
                ArrayNode fs = x.putArray("folgen");
                folgen.stream().filter(f -> f.beschluss() == b.nr()).forEach(f -> folge(fs.addObject(), f));
                x.put("satz", !fs.isEmpty() || standVom == null ? null : (String) EnergiemanagementRegeln
                        .satz("beschluss_ohne_folge", Map.of("am", standVom)).get("satz"));
                quelle("beschluss", bn, b.id(), null, null, "Beschluss " + b.nr() + " der Managementbewertung "
                        + v.path("zeitraum").asText());
            }
            return n;
        }

        private void folge(ObjectNode n, ManagementbewertungLeser.Folge f) {
            n.put("art", f.art());
            n.put("objekt", f.objekt());
            n.put("wie", f.wie());
            n.put("zustand", f.zustand());
            n.put("tag", f.tag() == null ? null : f.tag().toString());
            n.put("angabe", f.angabe());
            n.put("verknuepft_am", f.verknuepftAm() == null ? null : f.verknuepftAm().toString());
            n.put("eingetragen_von", f.eingetragenVon());
        }

        // ------------------------------------------------------------ beschluesse, sitzung (MG4, MG5)

        ArrayNode beschluesse(UUID bericht, String kennung) {
            ArrayNode a = json.createArrayNode();
            List<ManagementbewertungLeser.Beschluss> alle = ManagementbewertungLeser.beschluesse(j, tenant, bericht, zone);
            List<UUID> ids = new ArrayList<>();
            alle.forEach(b -> {
                ids.add(b.entschiedenVon());
                if (b.zustaendig() != null) ids.add(b.zustaendig());
            });
            Map<UUID, String> namen = ManagementbewertungLeser.namen(j, tenant, ids.stream().distinct().toList());
            for (ManagementbewertungLeser.Beschluss b : alle) {
                ObjectNode x = a.addObject();
                x.put("nr", b.nr());
                x.put("kennung", kennung + "/B" + b.nr());
                x.put("art", b.art());
                x.put("wortlaut", b.wortlaut());
                x.put("entschieden_von", namen.get(b.entschiedenVon()));
                x.put("eingetragen_von", b.eingetragenVon());
                x.put("eingetragen_am", b.eingetragenAm() == null ? null : b.eingetragenAm().toString());
                x.put("zustaendig", b.zustaendig() == null ? null : namen.get(b.zustaendig()));
                x.put("termin", b.termin() == null ? null : b.termin().toString());
            }
            return a;
        }

        JsonNode sitzung(UUID bericht) {
            var s = ManagementbewertungLeser.sitzung(j, tenant, bericht, zone).orElse(null);
            if (s == null) {
                return json.nullNode();
            }
            List<UUID> ids = new ArrayList<>(s.teilnehmende());
            ids.add(s.leitung());
            Map<UUID, String> namen = ManagementbewertungLeser.namen(j, tenant, ids.stream().distinct().toList());
            ObjectNode n = json.createObjectNode();
            n.put("tag", s.tag().toString());
            // PA3: die Leitung nur, solange die Person am Tag der Sitzung die laufende Aufgabe hat — sonst sperrt die
            // Freigabe (leitung_fehlt).
            n.put("leitung", ManagementbewertungLeser.istLeitung(j, tenant, s.leitung(), s.tag())
                    ? namen.get(s.leitung()) : null);
            ArrayNode t = n.putArray("teilnehmende");
            s.teilnehmende().forEach(p -> t.add(namen.get(p)));
            n.put("ort", s.ort());
            n.put("eingetragen_von", s.eingetragenVon());
            n.put("eingetragen_am", s.eingetragenAm() == null ? null : s.eingetragenAm().toString());
            return n;
        }

        // ------------------------------------------------------------ grundlagen

        ObjectNode grundlagen() {
            ObjectNode n = json.createObjectNode();
            for (String art : GRUNDLAGEN) {
                List<ObjectNode> dokumente = j.query("SELECT d.kennzeichen, d.titel, d.zustand, f.id AS fassung_id, "
                        + "f.fassung, f.form, f.pruefsumme, f.freigegeben_am, f.entschieden_tag, f.verweis_ablage, f.verweis_fassungsangabe, "
                        + "p.name AS entschieden_von FROM energiemanagement_dokument d "
                        + "LEFT JOIN LATERAL (SELECT x.* FROM energiemanagement_dokument_fassung x "
                        + "WHERE x.tenant_id = d.tenant_id AND x.dokument_id = d.id AND x.freigabe_status = 'freigegeben' "
                        + "ORDER BY x.fassung DESC LIMIT 1) f ON true "
                        + "LEFT JOIN energiemanagement_person p ON p.tenant_id = f.tenant_id AND p.id = f.entschieden_von "
                        + "WHERE d.tenant_id = ? AND d.art = ? AND d.zustand <> 'aufgehoben' "
                        + "ORDER BY length(d.kennzeichen), d.kennzeichen", (rs, i) -> dokument(rs), tenant, art);
                if (dokumente.isEmpty()) {
                    n.put(art, NICHTS_FESTGEHALTEN);
                } else {
                    ArrayNode a = n.putArray(art);
                    dokumente.forEach(a::add);
                }
            }
            ObjectNode aufgaben = n.putObject("aufgaben");
            List<String> laufend = j.queryForList("SELECT aufgabe FROM energiemanagement_aufgabe WHERE tenant_id = ? "
                    + "AND gilt_bis IS NULL AND gilt_ab <= ?", String.class, tenant, Date.valueOf(stichtag));
            aufgaben.put("laufend", laufend.size());
            ArrayNode ohne = aufgaben.putArray("ohne_person");
            EnergiemanagementRegeln.VOKABULARE.get("aufgabe").stream()
                    .filter(a -> !"weitere".equals(a) && !laufend.contains(a)).forEach(ohne::add);
            return n;
        }

        private ObjectNode dokument(ResultSet rs) throws SQLException {
            ObjectNode d = json.createObjectNode();
            String kennzeichen = rs.getString("kennzeichen");
            d.put("dokument", kennzeichen);
            d.put("titel", rs.getString("titel"));
            d.put("zustand", rs.getString("zustand"));
            UUID fassung = rs.getObject("fassung_id", UUID.class);
            if (fassung == null) {
                d.putNull("fassung");
                d.putNull("pruefsumme");
                d.putNull("entschieden_am");
                d.putNull("freigegeben_am");
                d.putNull("entschieden_von");
            } else {
                d.put("fassung", rs.getInt("fassung"));
                d.put("form", rs.getString("form"));
                if ("verweis".equals(rs.getString("form"))) {
                    d.put("ablage", rs.getString("verweis_ablage"));
                    d.put("fassungsangabe", rs.getString("verweis_fassungsangabe"));
                }
                d.put("pruefsumme", rs.getString("pruefsumme"));
                // Der Tag der Entscheidung, wie eingetragen (DK3), und der Augenblick der Freigabe im System.
                d.put("entschieden_am", rs.getDate("entschieden_tag") == null ? null
                        : rs.getDate("entschieden_tag").toString());
                d.put("freigegeben_am", tag(rs.getTimestamp("freigegeben_am")));
                d.put("entschieden_von", rs.getString("entschieden_von"));
                quelle("dokument", kennzeichen, fassung, null, rs.getInt("fassung"), rs.getString("titel"));
            }
            d.set("ueberpruefung", frist("dokument_ueberpruefung", kennzeichen));
            return d;
        }

        // ------------------------------------------------------------ energieziele

        ArrayNode energieziele() {
            ArrayNode a = json.createArrayNode();
            String jahr = z.schluessel();
            j.query("SELECT id, kennzeichen, wortlaut, zielwert_prozent, zielperiode, zustand, ergebnis, bewertung_status, "
                    + "bewertung_kopie, bewertung_pruefsumme, freigabe_am, entschieden_am, freigabe_name "
                    + "FROM energieziel WHERE tenant_id = ? AND substring(zielperiode FROM 1 FOR 4) <= ? "
                    + "AND substring(zielperiode FROM 9 FOR 4) >= ? ORDER BY kennzeichen", rs -> {
                        ObjectNode e = a.addObject();
                        e.put("kennzeichen", rs.getString("kennzeichen"));
                        e.put("zielwert_prozent", rs.getBigDecimal("zielwert_prozent"));
                        e.put("zielperiode", rs.getString("zielperiode"));
                        e.put("zustand", rs.getString("zustand"));
                        boolean bewertet = "bewertet".equals(rs.getString("bewertung_status"));
                        e.put("ergebnis", bewertet ? rs.getString("ergebnis") : null);
                        Timestamp am = rs.getTimestamp("entschieden_am") != null ? rs.getTimestamp("entschieden_am")
                                : rs.getTimestamp("freigabe_am");
                        e.put("bewertet_am", bewertet ? tag(am) : null);
                        e.put("person", bewertet ? rs.getString("freigabe_name") : null);
                        JsonNode stand = bewertet ? baum(rs.getString("bewertung_kopie")).path("stand") : null;
                        if (stand == null || stand.isMissingNode()) {
                            e.putNull("stand");
                        } else {
                            ObjectNode s = e.putObject("stand");
                            s.set("delta_prozent", stand.path("delta_prozent"));
                            s.put("monate", stand.path("monate_bewertbar").asInt() + " von "
                                    + stand.path("monate_gesamt").asInt());
                        }
                        e.put("pruefsumme", bewertet ? rs.getString("bewertung_pruefsumme") : null);
                        quelle("energieziel", rs.getString("kennzeichen"), rs.getObject("id", UUID.class), null, null,
                                rs.getString("wortlaut"));
                    }, tenant, jahr, jahr);
            return a;
        }

        // ------------------------------------------------------------ energieleistung

        ObjectNode energieleistung() {
            ObjectNode n = json.createObjectNode();
            ArrayNode vergleiche = n.putArray("leistungsvergleiche");
            j.query("SELECT b.kennung, b.zeitraum_schluessel, s.id AS stand_id, s.nr, s.pruefsumme, s.freigegeben_am, "
                    + "s.abzug FROM bericht b JOIN LATERAL (SELECT x.* FROM bericht_stand x WHERE x.tenant_id = b.tenant_id "
                    + "AND x.bericht_id = b.id ORDER BY x.nr DESC LIMIT 1) s ON true WHERE b.tenant_id = ? "
                    + "AND b.vorlage = ? AND b.archiviert_am IS NULL ORDER BY b.kennung", rs -> {
                        ObjectNode v = vergleiche.addObject();
                        String kennung = rs.getString("kennung");
                        UUID stand = rs.getObject("stand_id", UUID.class);
                        v.put("kennung", kennung);
                        v.put("zeitraum", rs.getString("zeitraum_schluessel"));
                        v.put("stand", rs.getInt("nr"));
                        v.put("freigegeben_am", tag(rs.getTimestamp("freigegeben_am")));
                        JsonNode urteil = baum(rs.getString("abzug")).path("urteil");
                        v.set("delta_prozent", urteil.path("delta_prozent").isMissingNode() ? json.nullNode()
                                : urteil.path("delta_prozent"));
                        v.set("urteil", urteil.path("urteil").isMissingNode() ? json.nullNode() : urteil.path("urteil"));
                        v.put("pruefsumme", rs.getString("pruefsumme"));
                        ArrayNode anstoesse = v.putArray("anstoesse_offen");
                        j.query("SELECT anlass_kennung, erkannt_am FROM bericht_revision_anstoss WHERE tenant_id = ? "
                                + "AND stand_id = ? AND zustand = 'offen' ORDER BY erkannt_am, anlass_kennung", r -> {
                                    ObjectNode o = anstoesse.addObject();
                                    o.put("anlass", r.getString("anlass_kennung"));
                                    o.put("erkannt_am", tag(r.getTimestamp("erkannt_am")));
                                }, tenant, stand);
                        quelle("berichtsstand", kennung, stand, rs.getInt("nr"), null,
                                "Leistungsvergleich " + rs.getString("zeitraum_schluessel"));
                    }, tenant, BerichtRegeln.LEISTUNGSVERGLEICH);
            ArrayNode basen = n.putArray("bezugsbasen");
            fristen.stream().filter(f -> "bezugsbasis_ueberpruefung".equals(f.art())).forEach(f -> {
                ObjectNode b = basen.addObject();
                b.put("kennzeichen", f.kennzeichen());
                b.put("titel", f.titel());
                b.set("ueberpruefung", frist(f.art(), f.kennzeichen()));
            });
            return n;
        }

        // ------------------------------------------------------------ massnahmen

        ArrayNode massnahmen() {
            ArrayNode a = json.createArrayNode();
            j.query("SELECT m.id, m.kennzeichen, m.titel, m.herkunft_art, m.herkunft_kennung, m.zustand, m.termin, "
                    + "m.umgesetzt_am, m.erwartete_wirkung_prozent, b.stand_nr, b.ergebnis, b.wirkung, b.pruefsumme, "
                    + "coalesce(b.entschieden_am, b.freigabe_am) AS bewertet_am FROM massnahme m "
                    + "LEFT JOIN LATERAL (SELECT x.* FROM massnahme_bewertung x WHERE x.tenant_id = m.tenant_id "
                    + "AND x.massnahme_id = m.id AND x.status = 'bewertet' ORDER BY x.stand_nr DESC LIMIT 1) b ON true "
                    + "WHERE m.tenant_id = ? AND NOT (m.zustand = 'verworfen' AND m.verworfen_am < ?) "
                    + "ORDER BY m.kennzeichen", rs -> {
                        ObjectNode m = a.addObject();
                        String kennzeichen = rs.getString("kennzeichen");
                        m.put("kennzeichen", kennzeichen);
                        m.put("titel", rs.getString("titel"));
                        m.put("herkunft_art", rs.getString("herkunft_art"));
                        m.put("herkunft_kennung", rs.getString("herkunft_kennung"));
                        m.put("zustand", rs.getString("zustand"));
                        m.put("termin", rs.getDate("termin") == null ? null : rs.getDate("termin").toString());
                        m.put("umgesetzt_am", rs.getDate("umgesetzt_am") == null ? null
                                : rs.getDate("umgesetzt_am").toString());
                        Integer nr = (Integer) rs.getObject("stand_nr");
                        if (nr == null) {
                            m.putNull("bewertung");
                        } else {
                            ObjectNode b = m.putObject("bewertung");
                            b.put("stand", nr);
                            b.put("ergebnis", rs.getString("ergebnis"));
                            b.put("am", tag(rs.getTimestamp("bewertet_am")));
                            JsonNode w = baum(rs.getString("wirkung"));
                            JsonNode wirkung = w.path("wirkung");
                            b.set("wirkung_prozent", wirkung.path("delta_prozent").isMissingNode() ? json.nullNode()
                                    : wirkung.path("delta_prozent"));
                            b.set("monate_bewertbar", wirkung.path("monate_bewertbar").isMissingNode() ? json.nullNode()
                                    : wirkung.path("monate_bewertbar"));
                            b.set("erwartet_prozent", w.path("erwartete_wirkung_prozent").isMissingNode()
                                    ? json.nullNode() : w.path("erwartete_wirkung_prozent"));
                            b.put("pruefsumme", rs.getString("pruefsumme"));
                        }
                        quelle("massnahme", kennzeichen, rs.getObject("id", UUID.class), nr, null, rs.getString("titel"));
                    }, tenant, java.sql.Timestamp.from(z.von()));
            return a;
        }

        // ------------------------------------------------------------ abweichungen

        ObjectNode abweichungen() {
            ObjectNode n = json.createObjectNode();
            String erster = z.ersterTag().toString().substring(0, 7);
            String letzter = z.letzterTag().toString().substring(0, 7);
            // Im Jahr: ein Monat im Jahr, im Jahr eröffnet oder abgeschlossen — und jede offene.
            ArrayNode im = n.putArray("im_jahr");
            j.query("SELECT a.id, a.kennzeichen, a.monate, a.zustand, a.ergebnis, a.abgeschlossen_am, m.kennzeichen AS "
                    + "massnahme FROM abweichung a LEFT JOIN massnahme m ON m.tenant_id = a.tenant_id "
                    + "AND m.id = a.massnahme_id WHERE a.tenant_id = ? AND (a.zustand = 'offen' "
                    + "OR EXISTS (SELECT 1 FROM unnest(a.monate) x WHERE x BETWEEN ? AND ?) "
                    + "OR (a.eroeffnet_am >= ? AND a.eroeffnet_am < ?) OR (a.abgeschlossen_am >= ? AND a.abgeschlossen_am < ?)) "
                    + "ORDER BY a.kennzeichen", rs -> {
                        ObjectNode w = im.addObject();
                        String kennzeichen = rs.getString("kennzeichen");
                        w.put("kennzeichen", kennzeichen);
                        ArrayNode monate = w.putArray("monate");
                        for (String m : (String[]) rs.getArray("monate").getArray()) {
                            monate.add(m);
                        }
                        w.put("zustand", rs.getString("zustand"));
                        w.put("ergebnis", rs.getString("ergebnis"));
                        w.put("abgeschlossen_am", tag(rs.getTimestamp("abgeschlossen_am")));
                        w.put("massnahme", rs.getString("massnahme"));
                        quelle("abweichung", kennzeichen, rs.getObject("id", UUID.class), null, null,
                                "Abweichung " + String.join(", ", (String[]) rs.getArray("monate").getArray()));
                    }, tenant, erster, letzter, Timestamp.from(z.von()), Timestamp.from(z.bis()), Timestamp.from(z.von()),
                    Timestamp.from(z.bis()));
            ArrayNode auff = n.putArray("auffaelligkeiten");
            j.query("SELECT k.kennzeichen AS kennzahl, a.periode, a.zustand, a.antwort, a.beantwortet_am "
                    + "FROM auffaelligkeit a JOIN kennzahl k ON k.tenant_id = a.tenant_id AND k.id = a.kennzahl_id "
                    + "WHERE a.tenant_id = ? AND (a.zustand = 'offen' OR a.periode BETWEEN ? AND ?) "
                    + "ORDER BY a.periode, k.kennzeichen", rs -> {
                        ObjectNode w = auff.addObject();
                        w.put("kennzahl", rs.getString("kennzahl"));
                        w.put("monat", rs.getString("periode"));
                        w.put("zustand", rs.getString("zustand"));
                        w.put("antwort", rs.getString("antwort"));
                        w.put("am", tag(rs.getTimestamp("beantwortet_am")));
                    }, tenant, erster, letzter);
            n.put("offen", j.queryForObject("SELECT count(*) FROM abweichung WHERE tenant_id = ? AND zustand = 'offen'",
                    Integer.class, tenant));
            return n;
        }

        // ------------------------------------------------------------ audits_feststellungen

        ObjectNode auditsFeststellungen() {
            ObjectNode n = json.createObjectNode();
            Date seit = Date.valueOf(z.ersterTag());
            ArrayNode audits = n.putArray("audits");
            j.query("SELECT id, kennzeichen, titel, termin, zustand, durchgefuehrt_am, abgeschlossen_am, pruefsumme "
                    + "FROM internes_audit WHERE tenant_id = ? AND zustand <> 'abgesagt' AND (termin >= ? "
                    + "OR zustand IN ('geplant', 'durchgefuehrt')) ORDER BY kennzeichen", rs -> {
                        ObjectNode a = audits.addObject();
                        String kennzeichen = rs.getString("kennzeichen");
                        a.put("kennzeichen", kennzeichen);
                        a.put("titel", rs.getString("titel"));
                        a.put("termin", rs.getDate("termin").toString());
                        a.put("zustand", rs.getString("zustand"));
                        a.put("durchgefuehrt_am", rs.getDate("durchgefuehrt_am") == null ? null
                                : rs.getDate("durchgefuehrt_am").toString());
                        a.put("abgeschlossen_am", rs.getDate("abgeschlossen_am") == null ? null
                                : rs.getDate("abgeschlossen_am").toString());
                        a.put("pruefsumme", rs.getString("pruefsumme"));
                        quelle("internes_audit", kennzeichen, rs.getObject("id", UUID.class), null, null,
                                rs.getString("titel"));
                    }, tenant, seit);
            ArrayNode feststellungen = n.putArray("feststellungen");
            j.query("SELECT f.id, f.kennzeichen, f.quelle_art, f.festgestellt_am, f.frist, f.zustand, w.stand_nr, "
                    + "w.ergebnis, w.pruefsumme FROM feststellung f LEFT JOIN LATERAL (SELECT x.* FROM "
                    + "feststellung_wirksamkeit x WHERE x.tenant_id = f.tenant_id AND x.feststellung_id = f.id "
                    + "AND x.status = 'freigegeben' ORDER BY x.stand_nr DESC LIMIT 1) w ON true WHERE f.tenant_id = ? "
                    + "AND (f.festgestellt_am >= ? OR f.zustand = 'offen') ORDER BY f.kennzeichen", rs -> {
                        ObjectNode f = feststellungen.addObject();
                        String kennzeichen = rs.getString("kennzeichen");
                        f.put("kennzeichen", kennzeichen);
                        f.put("quelle", rs.getString("quelle_art"));
                        f.put("festgestellt_am", rs.getDate("festgestellt_am").toString());
                        f.put("frist", rs.getDate("frist").toString());
                        f.put("zustand", rs.getString("zustand"));
                        Integer nr = (Integer) rs.getObject("stand_nr");
                        if (nr == null) {
                            f.putNull("wirksamkeit");
                        } else {
                            ObjectNode w = f.putObject("wirksamkeit");
                            w.put("stand", nr);
                            w.put("ergebnis", rs.getString("ergebnis"));
                            w.put("pruefsumme", rs.getString("pruefsumme"));
                        }
                        quelle("feststellung", kennzeichen, rs.getObject("id", UUID.class), nr, null,
                                "Feststellung " + kennzeichen);
                    }, tenant, seit);
            n.put("offen", j.queryForObject("SELECT count(*) FROM feststellung WHERE tenant_id = ? AND zustand = 'offen'",
                    Integer.class, tenant));
            return n;
        }

        // ------------------------------------------------------------ bewertung_messplanung

        ObjectNode bewertungMessplanung() {
            ObjectNode n = json.createObjectNode();
            ArrayNode bewertungen = n.putArray("bewertungen");
            j.query("SELECT b.kennung, b.zeitraum_schluessel, s.id AS stand_id, s.nr, s.pruefsumme, s.freigegeben_am "
                    + "FROM bericht b JOIN LATERAL (SELECT x.* FROM bericht_stand x WHERE x.tenant_id = b.tenant_id "
                    + "AND x.bericht_id = b.id ORDER BY x.nr DESC LIMIT 1) s ON true WHERE b.tenant_id = ? "
                    + "AND b.vorlage = ? AND b.archiviert_am IS NULL ORDER BY b.kennung", rs -> {
                        ObjectNode b = bewertungen.addObject();
                        String kennung = rs.getString("kennung");
                        b.put("kennung", kennung);
                        b.put("zeitraum", rs.getString("zeitraum_schluessel"));
                        b.put("stand", rs.getInt("nr"));
                        b.put("freigegeben_am", tag(rs.getTimestamp("freigegeben_am")));
                        b.put("pruefsumme", rs.getString("pruefsumme"));
                        b.set("ueberpruefung", frist("bewertung_ueberpruefung", kennung));
                        quelle("berichtsstand", kennung, rs.getObject("stand_id", UUID.class), rs.getInt("nr"), null,
                                "Energetische Bewertung " + rs.getString("zeitraum_schluessel"));
                    }, tenant, BerichtRegeln.ENERGETISCHE_BEWERTUNG);
            ArrayNode bedarfe = n.putArray("messbedarfe");
            j.query("SELECT kennzeichen, zustand, frist FROM messbedarf WHERE tenant_id = ? "
                    + "ORDER BY length(kennzeichen), kennzeichen", rs -> {
                        ObjectNode m = bedarfe.addObject();
                        m.put("kennzeichen", rs.getString("kennzeichen"));
                        m.put("zustand", rs.getString("zustand"));
                        m.put("frist", rs.getDate("frist") == null ? null : rs.getDate("frist").toString());
                    }, tenant);
            n.put("messbedarfe_offen", j.queryForObject("SELECT count(*) FROM messbedarf WHERE tenant_id = ? "
                    + "AND zustand = 'offen'", Integer.class, tenant));
            return n;
        }

        // ------------------------------------------------------------ wiedervorlage

        ObjectNode wiedervorlage(Wiedervorlage w) {
            ObjectNode n = json.createObjectNode();
            n.put("stichtag", stichtag.toString());
            n.put("vorschau_tage", w.vorschauTage());
            zeilen(n.putArray("faellig"), w.faellig());
            zeilen(n.putArray("vorschau"), w.vorschau());
            n.put("anzahl_faellig", w.anzahlFaellig());
            n.put("anzahl_vorschau", w.anzahlVorschau());
            return n;
        }

        private static void zeilen(ArrayNode a, List<Zeile> zeilen) {
            for (Zeile z : zeilen) {
                ObjectNode o = a.addObject();
                o.put("art", z.art());
                o.put("kennzeichen", z.kennzeichen());
                o.put("titel", z.titel());
                o.put("faellig_am", z.faelligAm().toString());
                o.put("satz", z.satz());
            }
        }
    }

    private static void zahl(ObjectNode n, String feld, Integer wert) {
        if (wert == null) {
            n.putNull(feld);
        } else {
            n.put(feld, wert);
        }
    }
}
