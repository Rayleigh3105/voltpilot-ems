package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.ManagementbewertungDto;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * UEMS AP-19 IP-23 (MG4–MG7, §5.5, §5.6): Sitzung, Beschlüsse und Folgen der Managementbewertung — der Bericht der
 * Vorlage {@code managementbewertung} (IP-22) über {@link BerichtService}: Recht, Zaun, Sperre und Uhr sind die des Berichts.
 *
 * <p>Sitzung und Beschlüsse sind bis zur Freigabe änderbar; jede Eingabe bildet den Entwurf in derselben Transaktion neu,
 * damit die Freigabe genau sie einfriert (MG7) — danach 409 {@code managementbewertung_freigegeben}. Folgen gibt es erst
 * nach der Freigabe; sie hängen nur an und ändern den Stand nie (MG6). Eine Maßnahme verknüpft sich selbst über ihre
 * Herkunft {@code managementbewertung} (BR-…/Bn, {@link MassnahmeService}); Aufgabe, Dokument-Fassung und „geprüft,
 * bleibt“ über ihre {@code beschluss_kennung} — {@link ManagementbewertungLeser} liest beides.
 */
@Service
public class ManagementbewertungService {

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final Pattern ENERGIEZIEL = Pattern.compile("^EZ-[0-9]{4}-[0-9]{4,9}$");
    private static final Pattern FASSUNG = Pattern.compile("^(D-[0-9]{4,9})/([0-9]{1,4})$");
    private static final Pattern AUDIT = Pattern.compile("^AU-[0-9]{4}-[0-9]{4,9}$");
    private static final int WORTLAUT = 2000;
    private static final int ORT = 200;

    private final BerichtService berichte;
    private final JdbcTemplate jdbc;

    public ManagementbewertungService(BerichtService berichte, JdbcTemplate jdbc) {
        this.berichte = berichte;
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Lesen

    /** Sitzung, Beschlüsse und ihre Folgen mit dem Zustand von heute ({@code energiemanagement.ansehen}). */
    public ManagementbewertungDto.Managementbewertung lesen(String kennung, ProtokollAkteur wer) {
        return ansicht(berichte.managementbewertungLesen(kennung, wer));
    }

    // ------------------------------------------------------------------ Schreiben

    /** MG4: Sitzung festhalten — Tag (nie in der Zukunft), Leitung (PA3), Teilnehmende, wahlfrei Ort. */
    public ManagementbewertungDto.Managementbewertung sitzung(String kennung,
            ManagementbewertungDto.SitzungFesthalten s, ProtokollAkteur wer) {
        var e = berichte.managementbewertungEingabe(kennung, wer, true, x -> {
            offen(x);
            if (s.tag() == null) throw EnergiemanagementAbgelehnt.anfrage("tag");
            if (s.tag().isAfter(LocalDate.ofInstant(x.jetzt(), x.zone()))) {
                throw EnergiemanagementAbgelehnt.fachlich("tag_in_der_zukunft", "Eine Sitzung halten Sie fest, "
                        + "wenn sie stattgefunden hat — der Tag liegt in der Zukunft.", Map.of("feld", "tag"));
            }
            if (s.leitung() == null) throw EnergiemanagementAbgelehnt.anfrage("leitung");
            person(x, s.leitung(), "leitung");
            leitung(x, s.leitung(), s.tag(), "leitung");
            List<UUID> teilnehmende = new ArrayList<>(new LinkedHashSet<>(s.teilnehmende() == null ? List.of()
                    : s.teilnehmende()));
            if (teilnehmende.contains(null)) throw EnergiemanagementAbgelehnt.anfrage("teilnehmende");
            for (UUID p : teilnehmende) person(x, p, "teilnehmende");
            String ort = text(s.ort());
            if (ort != null && ort.length() > ORT) throw EnergiemanagementAbgelehnt.anfrage("ort");
            Object[] werte = {s.tag(), s.leitung(), ManagementbewertungLeser.feld(teilnehmende), ort, wer.sub(), wer.name(),
                    wer.rolle(), wer.art(), Timestamp.from(x.jetzt())};
            int geaendert = jdbc.update("UPDATE managementbewertung_sitzung SET tag = ?, leitung_person_id = ?, "
                    + "teilnehmende = ?::uuid[], ort = ?, actor_sub = ?, actor_name = ?, actor_rolle = ?, actor_art = ?, "
                    + "geaendert_am = ? WHERE tenant_id = ? AND bericht_id = ?", anhaengen(werte, x.tenant(), x.bericht()));
            if (geaendert == 0) {
                jdbc.update("INSERT INTO managementbewertung_sitzung (tag, leitung_person_id, teilnehmende, ort, "
                        + "actor_sub, actor_name, actor_rolle, actor_art, geaendert_am, created_at, tenant_id, bericht_id) "
                        + "VALUES (?, ?, ?::uuid[], ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        anhaengen(werte, Timestamp.from(x.jetzt()), x.tenant(), x.bericht()));
            }
            return x;
        });
        return ansicht(e);
    }

    /** MG5: Beschluss festhalten — die nächste Nr.; entschieden von der Leitung (Vorgabe: die Leitung der Sitzung). */
    public ManagementbewertungDto.Managementbewertung beschluss(String kennung,
            ManagementbewertungDto.BeschlussFesthalten b, ProtokollAkteur wer) {
        return ansicht(berichte.managementbewertungEingabe(kennung, wer, true, x -> {
            offen(x);
            Object[] werte = beschlussWerte(x, b, wer);
            Integer nr = jdbc.queryForObject("SELECT coalesce(max(nr), 0) + 1 FROM managementbewertung_beschluss "
                    + "WHERE tenant_id = ? AND bericht_id = ?", Integer.class, x.tenant(), x.bericht());
            jdbc.update("INSERT INTO managementbewertung_beschluss (art, wortlaut, entschieden_von, zustaendig, termin, "
                    + "actor_sub, actor_name, actor_rolle, actor_art, geaendert_am, created_at, tenant_id, bericht_id, nr) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    anhaengen(werte, Timestamp.from(x.jetzt()), x.tenant(), x.bericht(), nr));
            return x;
        }));
    }

    /** MG5: einen Beschluss ändern — bis zur Freigabe; die Nr. bleibt. Unbekannte Nr. 404. */
    public ManagementbewertungDto.Managementbewertung beschlussAendern(String kennung, int nr,
            ManagementbewertungDto.BeschlussFesthalten b, ProtokollAkteur wer) {
        return ansicht(berichte.managementbewertungEingabe(kennung, wer, true, x -> {
            offen(x);
            Object[] werte = beschlussWerte(x, b, wer);
            int n = jdbc.update("UPDATE managementbewertung_beschluss SET art = ?, wortlaut = ?, entschieden_von = ?, "
                    + "zustaendig = ?, termin = ?, actor_sub = ?, actor_name = ?, actor_rolle = ?, actor_art = ?, "
                    + "geaendert_am = ? WHERE tenant_id = ? AND bericht_id = ? AND nr = ?",
                    anhaengen(werte, x.tenant(), x.bericht(), nr));
            if (n == 0) throw beschlussFehlt(nr);
            return x;
        }));
    }

    /**
     * MG6: eine Folge verknüpfen — nach der Freigabe, nur anhängen; dasselbe Objekt ein zweites Mal ändert nichts. Die
     * Maßnahme verknüpft sich selbst (422 {@code folge_art}); das Objekt muss sichtbar sein (422 {@code objekt_unbekannt}).
     */
    public ManagementbewertungDto.Managementbewertung folge(String kennung, int nr,
            ManagementbewertungDto.FolgeVerknuepfen f, ProtokollAkteur wer) {
        return ansicht(berichte.managementbewertungEingabe(kennung, wer, false, x -> {
            if (!x.freigegeben()) {
                throw EnergiemanagementAbgelehnt.konflikt("managementbewertung_nicht_freigegeben", "Folgen "
                        + "verknüpfen Sie nach der Freigabe — erst dann steht der Beschluss im Stand.", Map.of());
            }
            UUID beschluss = jdbc.queryForList("SELECT id FROM managementbewertung_beschluss WHERE tenant_id = ? "
                    + "AND bericht_id = ? AND nr = ?", UUID.class, x.tenant(), x.bericht(), nr).stream().findFirst()
                    .orElseThrow(() -> beschlussFehlt(nr));
            String art = text(f.art());
            String objekt = text(f.objekt());
            if (art == null) throw EnergiemanagementAbgelehnt.anfrage("art");
            if (objekt == null) throw EnergiemanagementAbgelehnt.anfrage("objekt");
            String spalte;
            UUID id;
            switch (art) {
                case "energieziel" -> {
                    spalte = "energieziel_id";
                    id = ENERGIEZIEL.matcher(objekt).matches() ? eins("SELECT id FROM energieziel WHERE tenant_id = ? "
                            + "AND kennzeichen = ?", x.tenant(), objekt) : null;
                }
                case "dokument" -> {
                    spalte = "fassung_id";
                    var m = FASSUNG.matcher(objekt);
                    id = m.matches() ? eins("SELECT fa.id FROM energiemanagement_dokument_fassung fa JOIN "
                            + "energiemanagement_dokument d ON d.tenant_id = fa.tenant_id AND d.id = fa.dokument_id "
                            + "WHERE fa.tenant_id = ? AND d.kennzeichen = ? AND fa.fassung = ?", x.tenant(), m.group(1),
                            Integer.parseInt(m.group(2))) : null;
                }
                case "aufgabe" -> {
                    spalte = "aufgabe_id";
                    UUID a;
                    try {
                        a = UUID.fromString(objekt);
                    } catch (IllegalArgumentException keine) {
                        a = null;
                    }
                    id = a == null ? null : eins("SELECT id FROM energiemanagement_aufgabe WHERE tenant_id = ? "
                            + "AND id = ?", x.tenant(), a);
                }
                case "audit" -> {
                    spalte = "audit_id";
                    id = AUDIT.matcher(objekt).matches() ? eins("SELECT id FROM internes_audit WHERE tenant_id = ? "
                            + "AND kennzeichen = ?", x.tenant(), objekt) : null;
                }
                case "massnahme" -> throw EnergiemanagementAbgelehnt.fachlich("folge_art", "Eine Maßnahme verknüpft "
                        + "sich selbst: legen Sie sie mit der Herkunft „Managementbewertung“ und " + x.kennung() + "/B"
                        + nr + " an.", Map.of("feld", "art"));
                default -> throw EnergiemanagementAbgelehnt.anfrage("art");
            }
            if (id == null) {
                throw EnergiemanagementAbgelehnt.fachlich("objekt_unbekannt", objekt + " gibt es in Ihrem "
                        + "Kundenbereich nicht.", Map.of("feld", "objekt"));
            }
            jdbc.update("INSERT INTO managementbewertung_folge (tenant_id, beschluss_id, art, " + spalte + ", actor_sub, "
                    + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    + "ON CONFLICT DO NOTHING", x.tenant(), beschluss, art, id, wer.sub(), wer.name(), wer.rolle(),
                    wer.art(), Timestamp.from(x.jetzt()));
            return x;
        }));
    }

    // ------------------------------------------------------------------ Hilfen

    private Object[] beschlussWerte(BerichtService.Eingabe x, ManagementbewertungDto.BeschlussFesthalten b,
            ProtokollAkteur wer) {
        var sitzung = ManagementbewertungLeser.sitzung(jdbc, x.tenant(), x.bericht(), x.zone()).orElseThrow(() ->
                EnergiemanagementAbgelehnt.fachlich("sitzung_fehlt", "Halten Sie zuerst die Sitzung fest — ein "
                        + "Beschluss ist eine Entscheidung der Leitung in dieser Sitzung.", Map.of()));
        String art = text(b.art());
        if (art == null || !EnergiemanagementRegeln.VOKABULARE.get("beschluss_art").contains(art)) {
            throw EnergiemanagementAbgelehnt.anfrage("art");
        }
        String wortlaut = text(b.wortlaut());
        if (wortlaut == null || wortlaut.length() > WORTLAUT) throw EnergiemanagementAbgelehnt.anfrage("wortlaut");
        UUID entschieden = b.entschiedenVon() == null ? sitzung.leitung() : b.entschiedenVon();
        person(x, entschieden, "entschieden_von");
        leitung(x, entschieden, sitzung.tag(), "entschieden_von");
        if (b.zustaendig() != null) person(x, b.zustaendig(), "zustaendig");
        return new Object[] {art, wortlaut, entschieden, b.zustaendig(), b.termin(), wer.sub(), wer.name(), wer.rolle(),
                wer.art(), Timestamp.from(x.jetzt())};
    }

    private static void offen(BerichtService.Eingabe x) {
        if (x.freigegeben()) {
            throw EnergiemanagementAbgelehnt.konflikt("managementbewertung_freigegeben", "Die Managementbewertung "
                    + x.kennung() + " ist freigegeben — Sitzung und Beschlüsse stehen im Stand und ändern sich nicht "
                    + "mehr. Eine Berichtigung ist eine neue Freigabe mit Grund.", Map.of());
        }
    }

    private void person(BerichtService.Eingabe x, UUID id, String feld) {
        if (ManagementbewertungLeser.namen(jdbc, x.tenant(), List.of(id)).isEmpty()) {
            throw EnergiemanagementAbgelehnt.fachlich("person_unbekannt", "Diese Person gibt es im Energiemanagement "
                    + "nicht.", Map.of("feld", feld));
        }
    }

    /** PA3: nur wer am {@code tag} die laufende Aufgabe „Leitung des Unternehmens“ hat, leitet und entscheidet. */
    private void leitung(BerichtService.Eingabe x, UUID person, LocalDate tag, String feld) {
        if (!ManagementbewertungLeser.istLeitung(jdbc, x.tenant(), person, tag)) {
            throw EnergiemanagementAbgelehnt.fachlich("leitung_fehlt", "Diese Person hat am " + DATUM.format(tag)
                    + " nicht die Aufgabe ‚Leitung des Unternehmens‘. Ordnen Sie die Leitung unter „Aufgaben“ zu.",
                    Map.of("feld", feld, "tag", tag.toString()));
        }
    }

    private UUID eins(String sql, Object... werte) {
        return jdbc.queryForList(sql, UUID.class, werte).stream().findFirst().orElse(null);
    }

    private static EnergiemanagementAbgelehnt beschlussFehlt(int nr) {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Den Beschluss B" + nr + " gibt es nicht.", null);
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static Object[] anhaengen(Object[] werte, Object... mehr) {
        Object[] aus = new Object[werte.length + mehr.length];
        System.arraycopy(werte, 0, aus, 0, werte.length);
        System.arraycopy(mehr, 0, aus, werte.length, mehr.length);
        return aus;
    }

    private ManagementbewertungDto.Managementbewertung ansicht(BerichtService.Eingabe x) {
        var sitzung = ManagementbewertungLeser.sitzung(jdbc, x.tenant(), x.bericht(), x.zone()).orElse(null);
        var alle = ManagementbewertungLeser.beschluesse(jdbc, x.tenant(), x.bericht(), x.zone());
        var folgen = ManagementbewertungLeser.folgen(jdbc, x.tenant(), x.bericht(), x.kennung(), x.zone());
        List<UUID> ids = new ArrayList<>();
        if (sitzung != null) {
            ids.add(sitzung.leitung());
            ids.addAll(sitzung.teilnehmende());
        }
        alle.forEach(b -> {
            ids.add(b.entschiedenVon());
            if (b.zustaendig() != null) ids.add(b.zustaendig());
        });
        Map<UUID, String> namen = ManagementbewertungLeser.namen(jdbc, x.tenant(), ids.stream().distinct().toList());
        List<Map<String, Object>> stand = jdbc.queryForList("SELECT nr, freigegeben_am FROM bericht_stand "
                + "WHERE tenant_id = ? AND bericht_id = ? ORDER BY nr DESC LIMIT 1", x.tenant(), x.bericht());
        Integer standNr = stand.isEmpty() ? null : (Integer) stand.get(0).get("nr");
        String standVom = stand.isEmpty() ? null : DATUM.format(LocalDate.ofInstant(
                ((Timestamp) stand.get(0).get("freigegeben_am")).toInstant(), x.zone()));
        ManagementbewertungDto.Sitzung s = sitzung == null ? null : new ManagementbewertungDto.Sitzung(sitzung.tag(),
                p(sitzung.leitung(), namen), ManagementbewertungLeser.istLeitung(jdbc, x.tenant(), sitzung.leitung(),
                        sitzung.tag()), sitzung.teilnehmende().stream().map(t -> p(t, namen)).toList(), sitzung.ort(),
                sitzung.eingetragenVon(), sitzung.eingetragenAm());
        List<ManagementbewertungDto.Beschluss> beschluesse = alle.stream().map(b -> {
            List<ManagementbewertungDto.Folge> fs = folgen.stream().filter(f -> f.beschluss() == b.nr())
                    .map(f -> new ManagementbewertungDto.Folge(f.art(), f.objekt(), f.objektId(), f.wie(), f.zustand(),
                            f.tag(), f.angabe(), f.verknuepftAm(), f.eingetragenVon()))
                    .toList();
            String satz = standVom != null && fs.isEmpty() ? (String) EnergiemanagementRegeln
                    .satz("beschluss_ohne_folge", Map.of("am", standVom)).get("satz") : null;
            return new ManagementbewertungDto.Beschluss(b.nr(), x.kennung() + "/B" + b.nr(), b.art(), b.wortlaut(),
                    p(b.entschiedenVon(), namen), b.zustaendig() == null ? null : p(b.zustaendig(), namen), b.termin(),
                    b.eingetragenVon(), b.eingetragenAm(), fs, satz);
        }).toList();
        return new ManagementbewertungDto.Managementbewertung(x.kennung(), x.freigegeben(), standNr, s, beschluesse);
    }

    private static ManagementbewertungDto.Person p(UUID id, Map<UUID, String> namen) {
        return new ManagementbewertungDto.Person(id, namen.get(id));
    }
}
