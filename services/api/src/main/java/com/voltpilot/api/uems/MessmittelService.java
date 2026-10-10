package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.MessmittelRepository.Beleg;
import com.voltpilot.api.uems.MessmittelRepository.Stand;
import com.voltpilot.api.web.dto.MessmittelDto;
import com.voltpilot.api.web.dto.MessmittelDto.Angaben;
import com.voltpilot.api.web.dto.MessmittelDto.Eintrag;
import com.voltpilot.api.web.dto.MessmittelDto.Herstellerangabe;
import com.voltpilot.api.web.dto.MessmittelDto.WandlerEintrag;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * AP-16 IP-15/IP-16 (G1–G4, E7 = A): Messmittel-Angaben am Einbau und getrennt „laut Hersteller“.
 *
 * <p>Zahlen werden hier nie erfunden: was fehlt, ist {@code nicht_erhoben} (G3); eine Genauigkeit der
 * Messkette wird nicht gerechnet. Ein Beleg ist ein Verweis mit SHA-256 (G2) — ohne gültige Prüfsumme kein
 * Beleg (422). Jede Änderung steht mit alt/neu und Akteur als {@code messmittel_angabe} im Journal des Einbaus;
 * ein unveränderter PUT schreibt nichts.
 */
@Service
public class MessmittelService {

    /** Das Vokabular von {@code uems-referenzunternehmen.schema.json} ({@code messmittel_angaben.pruefungsart}). */
    public static final List<String> PRUEFUNGSARTEN =
            List.of("eichung", "mid_konformitaet", "kalibrierung", "werksbescheinigung", "keine");
    public static final String NICHT_ERHOBEN = "nicht_erhoben";
    public static final String ERHOBEN = "erhoben";
    private static final Set<String> WANDLER = Set.of("wandler_strom", "wandler_spannung");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");

    private final MessmittelRepository messmittel;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final MeasurementCatalog katalog;
    private final BerichtsBelege berichtsBelege;

    public MessmittelService(MessmittelRepository messmittel, RechtPruefung rechte, ObjectMapper json,
            MeasurementCatalog katalog, BerichtsBelege berichtsBelege) {
        this.messmittel = messmittel;
        this.rechte = rechte;
        this.json = json;
        this.katalog = katalog;
        this.berichtsBelege = berichtsBelege;
    }

    public Angaben lesen(UUID geraetId) {
        rechte.pruefenLesen(RechtZiel.GERAET, geraetId, MessmittelAbgelehnt::fehlt);
        return antwort(messmittel.stand(geraetId).orElseThrow(MessmittelAbgelehnt::fehlt));
    }

    /**
     * AP-19 (VZ1, R3 Schritt 2): die erhobenen Angaben aller Einbauten, die der Aufrufer sieht — im Zaun des Geräts
     * wie {@link #lesen}: ein Einbau außerhalb fehlt ohne Hinweis. Ein Einbau ohne Angabe steht nicht darin.
     */
    public List<Angaben> alle() {
        return messmittel.erhobene().stream().filter(s -> rechte.lesbar(RechtZiel.GERAET, s.id()))
                .map(this::antwort).toList();
    }

    @Transactional
    public Angaben eintragen(UUID geraetId, Eintrag in, ProtokollAkteur akteur) {
        Stand alt = messmittel.standZumAendern(geraetId).orElseThrow(MessmittelAbgelehnt::fehlt);
        Stand neu = geprueft(alt, in, akteur);
        Map<UUID, String[]> klassen = wandlerGeprueft(geraetId, in.wandler());

        ObjectNode altJson = angabe(alt);
        ObjectNode neuJson = angabe(neu);
        ArrayNode altWandler = altJson.putArray("wandler");
        ArrayNode neuWandler = neuJson.putArray("wandler");
        Map<UUID, String> bisher = new LinkedHashMap<>();
        messmittel.wandler(geraetId).forEach(w -> bisher.put(w.id(), w.klasse()));
        boolean wandlerGeaendert = klassen.entrySet().stream()
                .anyMatch(k -> !Objects.equals(bisher.get(k.getKey()), k.getValue()[1]));
        boolean angabeGeaendert = !angabe(alt).equals(angabe(neu));
        if (angabeGeaendert || wandlerGeaendert) {
            berichtsBelege.pruefeObjekt(geraetId, BelegeImWeg.Gegenstand.MESSMITTEL);
        }
        for (Map.Entry<UUID, String[]> k : klassen.entrySet()) {
            String vorher = bisher.get(k.getKey());
            String nachher = k.getValue()[1];
            if (!Objects.equals(vorher, nachher)) {
                messmittel.klasseSetzen(k.getKey(), nachher);
                altWandler.add(wandlerJson(k.getKey(), k.getValue()[0], vorher));
                neuWandler.add(wandlerJson(k.getKey(), k.getValue()[0], nachher));
            }
        }
        if (angabeGeaendert) {
            messmittel.speichern(geraetId, neu);
        }
        if (angabeGeaendert || !neuWandler.isEmpty()) {
            messmittel.protokollieren(geraetId, altJson, neuJson, akteur);
        }
        return antwort(messmittel.stand(geraetId).orElseThrow(MessmittelAbgelehnt::fehlt));
    }

    // ------------------------------------------------------------------ Prüfen

    private static Stand geprueft(Stand alt, Eintrag in, ProtokollAkteur akteur) {
        String klasse = text(in.genauigkeitsklasse(), 60, "genauigkeitsklasse");
        String art = in.pruefungsart() == null ? null : in.pruefungsart().strip();
        if (art != null && (art.isEmpty() || NICHT_ERHOBEN.equals(art))) {
            art = null;
        }
        if (art != null && !PRUEFUNGSARTEN.contains(art)) {
            throw MessmittelAbgelehnt.angabe("pruefungsart_unbekannt", "pruefungsart",
                    "Diese Prüfungsart gibt es nicht. Möglich sind Eichung, MID-Konformität, Kalibrierung, "
                            + "Werksbescheinigung, keine Prüfung — oder nicht erhoben.");
        }
        if (in.pruefungAm() != null && in.pruefungGueltigBis() != null
                && in.pruefungGueltigBis().isBefore(in.pruefungAm())) {
            throw MessmittelAbgelehnt.angabe("zeitraum_ungueltig", "pruefung_gueltig_bis",
                    "„Gültig bis“ liegt vor dem Tag der Prüfung.");
        }
        return new Stand(alt.id(), alt.kennzeichen(), alt.einbauKennzeichen(), klasse, art, in.pruefungAm(),
                in.pruefungGueltigBis(), beleg(alt.beleg(), in.beleg(), akteur));
    }

    /**
     * Der Beleg (G2). Derselbe Verweis wie bisher behält Person und Zeitpunkt seines Eintragens; ein neuer
     * trägt den Akteur dieser Anfrage und die Minute jetzt.
     */
    private static Beleg beleg(Beleg bisher, MessmittelDto.BelegEintrag in, ProtokollAkteur akteur) {
        if (in == null) {
            return null;
        }
        String bezeichnung = text(in.bezeichnung(), 200, "beleg.bezeichnung");
        if (bezeichnung == null) {
            throw MessmittelAbgelehnt.angabe("beleg_unvollstaendig", "beleg.bezeichnung",
                    "Ein Beleg braucht eine Bezeichnung.");
        }
        String ablage = text(in.ablage(), 200, "beleg.ablage");
        String sha = in.sha256() == null ? "" : in.sha256().strip();
        if (!SHA256.matcher(sha).matches()) {
            throw MessmittelAbgelehnt.angabe("pruefsumme_ungueltig", "beleg.sha256",
                    "Ein Beleg braucht die Prüfsumme (SHA-256) der Datei — bitte die Datei auswählen.");
        }
        sha = sha.toLowerCase(Locale.ROOT);
        if (bisher != null && bisher.bezeichnung().equals(bezeichnung) && Objects.equals(bisher.ablage(), ablage)
                && bisher.sha256().equals(sha)) {
            return bisher;
        }
        return new Beleg(bezeichnung, ablage, sha, akteur, Instant.now().truncatedTo(ChronoUnit.SECONDS));
    }

    /** Je genannter Fassung: {art, klasse}. Nur Wandler-Fassungen DIESES Einbaus tragen eine Klasse. */
    private Map<UUID, String[]> wandlerGeprueft(UUID geraetId, List<WandlerEintrag> wandler) {
        Map<UUID, String[]> klassen = new LinkedHashMap<>();
        if (wandler == null) {
            return klassen;
        }
        Set<UUID> gesehen = new HashSet<>();
        for (WandlerEintrag w : wandler) {
            if (w == null || w.fassung() == null) {
                throw MessmittelAbgelehnt.anfrage("wandler.fassung", "Jede Wandler-Angabe nennt ihre Fassung.");
            }
            if (!gesehen.add(w.fassung())) {
                throw MessmittelAbgelehnt.anfrage("wandler.fassung", "Jede Fassung steht höchstens einmal.");
            }
            String art = messmittel.artDerFassung(geraetId, w.fassung()).orElseThrow(() ->
                    MessmittelAbgelehnt.angabe("fassung_unbekannt", "wandler.fassung",
                            "Diese Einstellung gehört nicht zu diesem Gerät."));
            if (!WANDLER.contains(art)) {
                throw MessmittelAbgelehnt.angabe("klasse_nur_am_wandler", "wandler.klasse",
                        "Eine Klasse steht nur an einem Strom- oder Spannungswandler.");
            }
            klassen.put(w.fassung(), new String[] {art, text(w.klasse(), 60, "wandler.klasse")});
        }
        return klassen;
    }

    private static String text(String wert, int max, String feld) {
        if (wert == null || wert.isBlank()) {
            return null;
        }
        String t = wert.strip();
        if (t.length() > max) {
            throw MessmittelAbgelehnt.angabe("text_zu_lang", feld, "Höchstens " + max + " Zeichen.");
        }
        return t;
    }

    // ------------------------------------------------------------------ Antwort und Journal

    private Angaben antwort(Stand s) {
        boolean erhoben = s.genauigkeitsklasse() != null || s.pruefungsart() != null || s.pruefungAm() != null
                || s.pruefungGueltigBis() != null || s.beleg() != null;
        Beleg b = s.beleg();
        return new Angaben(s.id(), s.kennzeichen(), s.einbauKennzeichen(), erhoben ? ERHOBEN : NICHT_ERHOBEN,
                s.genauigkeitsklasse(), s.pruefungsart() == null ? NICHT_ERHOBEN : s.pruefungsart(), s.pruefungAm(),
                s.pruefungGueltigBis(),
                b == null ? null : new MessmittelDto.Beleg(b.bezeichnung(), b.ablage(), b.sha256(), b.person(), b.am()),
                messmittel.wandler(s.id()).stream().map(w -> new MessmittelDto.Wandler(w.id(), w.art(), w.wert(),
                        w.gueltigAb(), w.gueltigBis(), w.klasse(), w.klasse() == null ? NICHT_ERHOBEN : ERHOBEN))
                        .toList(),
                messmittel.katalogZiele(s.id()).stream().map(z -> {
                    MeasurementCatalog.HerstellerGenauigkeit a = katalog.herstellerGenauigkeit(
                            z.hersteller(), z.modell());
                    return a == null ? null : new Herstellerangabe(z.art(), z.id(), z.bezeichnung(), z.hersteller(),
                            z.modell(), a.zustand(), a.klasse(), a.wert(), a.bezug(), a.fundstelle(), a.sourceUrl(),
                            a.sourceSha256());
                }).filter(Objects::nonNull).toList());
    }

    /** Die Angabe im Journal — dieselben Wörter wie die Antwort; der Beleg ohne Person (die steht am Eintrag). */
    private ObjectNode angabe(Stand s) {
        ObjectNode o = json.createObjectNode();
        o.put("einbau", s.einbauKennzeichen());
        o.put("genauigkeitsklasse", s.genauigkeitsklasse());
        o.put("pruefungsart", s.pruefungsart() == null ? NICHT_ERHOBEN : s.pruefungsart());
        o.put("pruefung_am", s.pruefungAm() == null ? null : s.pruefungAm().toString());
        o.put("pruefung_gueltig_bis", s.pruefungGueltigBis() == null ? null : s.pruefungGueltigBis().toString());
        if (s.beleg() == null) {
            o.putNull("beleg");
        } else {
            ObjectNode b = o.putObject("beleg");
            b.put("bezeichnung", s.beleg().bezeichnung());
            b.put("ablage", s.beleg().ablage());
            b.put("sha256", s.beleg().sha256());
        }
        return o;
    }

    private JsonNode wandlerJson(UUID fassung, String art, String klasse) {
        ObjectNode o = json.createObjectNode();
        o.put("fassung", fassung.toString());
        o.put("art", art);
        o.put("klasse", klasse);
        return o;
    }
}
