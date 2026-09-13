package com.voltpilot.api.uems;

import com.voltpilot.api.uems.OrtsbaumAbleitung.AnlageAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenIntervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.NichtGezeigt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtAmStichtag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.StandAm;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Predicate;

/**
 * Das STANDORT-LESEMODELL (UEMS AP-02 IP-3 ★): aus den Zeilen der Ortsstruktur
 * (IP-2a/IP-2b) und den Anlagen des Mandanten die Antworten von
 * {@code GET /api/v1/unternehmen}, {@code GET /api/v1/standorte?stichtag=} und
 * das additive Feld {@code standort} an {@code /overview} und {@code /sites/{id}}
 * — die Grundlage der Portal-Navigation Unternehmen → Standort → Anlage
 * (AP-01 E1/IP-5: die Startansicht-Weiche liest hier die Zahl der Standorte,
 * die Anlagen je Standort und „noch nicht zugeordnet", ohne nachzurechnen).
 *
 * <p>Ohne Spring, ohne Uhr: Stichtag und „heute" sind Parameter. Die Ableitung
 * selbst ist NICHT hier — „Stand am", Fläche (eigene ODER Summe der Gebäude,
 * nur wenn jedes eine hat; Bereiche nie addiert; fehlend {@code null}, nie 0)
 * und die Anlagen-Zuordnung zum Stichtag rechnet {@link OrtsbaumAbleitung#standAm}
 * (Vertrag {@code docs/contracts/v2/ortsbaum-vectors.json}). Diese Klasse
 * übersetzt nur Zeilen in dessen Baum und das Ergebnis in die Antwortform.
 * Die Kennzeichen des Baums sind die IDs der Zeilen (als Text) — nie die
 * Kurzzeichen: die Antwort nennt IDs, und ein Kurzzeichen ist änderbar. (Die
 * Schreibrouten legen für ihre SÄTZE die Kurzzeichen hinein, {@link StandortService};
 * zwischen {@code standort} und {@code ort} kollidieren sie seit V20260911210000 nicht mehr.)
 *
 * <h2>Das Bestehen eines Standorts</h2>
 *
 * Ein Standort hat kein eigenes Intervall (V20260911110000): er besteht ab dem
 * Tag seines Anlegens ({@code created_at} in SEINER Zeitzone, E9) bis zum
 * Vortag seines Archivierens. Hängt etwas schon früher an ihm — die
 * Bestandsübernahme (IP-9) ordnet eine Anlage ab ihrem eigenen Beginn zu —,
 * dann besteht er ab diesem Tag: sonst hinge die Anlage an einem Standort, den
 * es nicht gibt (Regel 1; Vektor-Fall {@code a5-bestand-standort-besteht-seit-der-anlage}).
 * Die Lücke zwischen Archivieren und Wiederherstellen lebt nur im Protokoll
 * (IP-4, §4.2: „die Lücke bleibt sichtbar und wird nie aufgefüllt"): je Paar
 * {@code archiviert} (gilt ab A) → {@code wiederhergestellt} (gilt ab W) fehlen
 * die Tage A … W−1 — der Bestand ist dann mehrere Intervalle, genau wie beim
 * Gebäude, dessen Intervalle in {@code ort_zuordnung} stehen. Ein noch
 * archivierter Standort endet am Vortag seines {@code archiviert_am}.
 *
 * <h2>Was ein Stichtag NICHT ändert</h2>
 *
 * Name, Adresse, Zeitzone, Zustand und „es fehlt" sind einfache Felder ohne
 * Gültigkeit (§4.3): sie stehen, wie sie HEUTE sind; der Name zum Stichtag
 * kommt später aus dem Änderungsprotokoll (AP-12). Zeitgültig sind nur der
 * Bestand, die Anlagen, die Gebäude/Bereiche und die Fläche.
 */
public final class StandortLesemodell {

    /** „es fehlt: Adresse" — die einzige Pflichtangabe, die einem Entwurf fehlen kann (E10). */
    public static final String ES_FEHLT_ADRESSE = "adresse";

    /** Das Unternehmen ist angelegt — oder (ein Kundenbereich ohne Zeile) ehrlich nicht. */
    public static final String UNTERNEHMEN_ANGELEGT = "angelegt";
    public static final String UNTERNEHMEN_NICHT_ANGELEGT = "nicht_angelegt";

    private static final String VORHANDEN = "vorhanden";

    private StandortLesemodell() {}

    // ------------------------------------------------------------------ Eingang

    /** Eine Anlage des Mandanten ({@code site}), in der Reihenfolge der Anlagen-Liste. */
    public record Anlage(UUID id, String name) {}

    /**
     * Eine wirksame Bindung Anlage ↔ Netzanschluss (UEMS AP-10 IP-6, {@code anlage_netzanschluss}):
     * Tage, {@code gueltigBis} der letzte einschließlich, {@code null} = offen.
     */
    public record NetzanschlussBindung(UUID siteId, UUID netzanschlussId, String kennzeichen,
            LocalDate gueltigAb, LocalDate gueltigBis) {

        boolean laeuftAm(LocalDate tag) {
            return !tag.isBefore(gueltigAb) && (gueltigBis == null || !tag.isAfter(gueltigBis));
        }
    }

    /**
     * Alle Zeilen, aus denen das Lesemodell lebt — unter RLS gelesen, also genau
     * die des Mandanten. {@code unternehmen} ist {@code null} für einen
     * Kundenbereich ohne Unternehmen-Zeile.
     */
    public record Zeilen(
            UnternehmenRepository.Unternehmen unternehmen,
            List<StandortRepository.Standort> standorte,
            List<OrtRepository.Ort> orte,
            List<OrtZuordnungRepository.Zuordnung> ortZuordnungen,
            List<AnlageStandortRepository.Zuordnung> anlageZuordnungen,
            List<FlaecheRepository.Flaeche> flaechen,
            List<Anlage> anlagen,
            List<OrtAenderungRepository.ArchivSchritt> standortArchiv,
            List<NetzanschlussBindung> netzanschluesse) {

        public Zeilen {
            standorte = List.copyOf(standorte);
            orte = List.copyOf(orte);
            ortZuordnungen = List.copyOf(ortZuordnungen);
            anlageZuordnungen = List.copyOf(anlageZuordnungen);
            flaechen = List.copyOf(flaechen);
            anlagen = List.copyOf(anlagen);
            standortArchiv = standortArchiv == null ? List.of() : List.copyOf(standortArchiv);
            netzanschluesse = netzanschluesse == null ? List.of() : List.copyOf(netzanschluesse);
        }

        /** Ohne Netzanschluss-Bindungen (der Stand vor AP-10 IP-6). */
        public Zeilen(
                UnternehmenRepository.Unternehmen unternehmen,
                List<StandortRepository.Standort> standorte,
                List<OrtRepository.Ort> orte,
                List<OrtZuordnungRepository.Zuordnung> ortZuordnungen,
                List<AnlageStandortRepository.Zuordnung> anlageZuordnungen,
                List<FlaecheRepository.Flaeche> flaechen,
                List<Anlage> anlagen,
                List<OrtAenderungRepository.ArchivSchritt> standortArchiv) {
            this(unternehmen, standorte, orte, ortZuordnungen, anlageZuordnungen, flaechen, anlagen,
                    standortArchiv, List.of());
        }

        /** Ohne Archiv-Schritte: nie archiviert und wiederhergestellt (der Stand von IP-3). */
        public Zeilen(
                UnternehmenRepository.Unternehmen unternehmen,
                List<StandortRepository.Standort> standorte,
                List<OrtRepository.Ort> orte,
                List<OrtZuordnungRepository.Zuordnung> ortZuordnungen,
                List<AnlageStandortRepository.Zuordnung> anlageZuordnungen,
                List<FlaecheRepository.Flaeche> flaechen,
                List<Anlage> anlagen) {
            this(unternehmen, standorte, orte, ortZuordnungen, anlageZuordnungen, flaechen, anlagen,
                    List.of(), List.of());
        }

        /** Die Zeitzonen-Vorgabe des Unternehmens; ohne Unternehmen die feste von heute. */
        public ZoneId zeitzone() {
            return unternehmen == null
                    ? OrtsbaumAbleitung.VORGABE_ZEITZONE
                    : ZoneId.of(unternehmen.zeitzone());
        }
    }

    // ---------------------------------------------------------------- Antworten

    /**
     * {@code GET /api/v1/unternehmen}. Die Zahlen gelten HEUTE. Ohne
     * Unternehmen-Zeile ist {@code zustand} {@value #UNTERNEHMEN_NICHT_ANGELEGT}
     * und die Stammdaten sind {@code null} — nie erfunden; die Zahlen stimmen
     * trotzdem. {@code sitz} und {@code rechtsform} (additiv, IP-4: was
     * {@code PUT /api/v1/unternehmen} bearbeitet) sind {@code null}, wenn nicht
     * angegeben. Additiv vorgesehen: {@code teilansicht} (AP-03 IP-10).
     */
    public record UnternehmenSicht(
            String zustand,
            UUID id,
            String name,
            String kurzname,
            String zeitzone,
            int standortZahl,
            int anlagenZahl,
            int nochNichtZugeordnetZahl,
            Adresse sitz,
            String rechtsform) {}

    /** Die Adresse; ein einzelnes Feld darf fehlen ({@code null}), die ganze Adresse auch. */
    public record Adresse(String strasse, String plz, String ort, String land) {}

    /** Die Lage auf der Karte — beide Koordinaten oder keine (W4). */
    public record Lage(BigDecimal breitengrad, BigDecimal laengengrad) {}

    /**
     * §4.1 / E10: eine Adresse ist da, wenn Straße, Ort und Land da sind. Die PLZ
     * ist optional — das Referenzunternehmen führt seine aktiven Standorte ohne
     * („{@code plz: null}" = nicht erhoben, nie erfunden); ist sie da, prüft
     * der Schreibweg ihr Format je Land. Dieselbe Regel für „es fehlt: Adresse"
     * (hier) und für Anlegen und Einrichten (IP-4, {@link StandortService}).
     */
    public static boolean adresseVollstaendig(String strasse, String ort, String land) {
        return strasse != null && ort != null && land != null;
    }

    /**
     * Eine Anlage am Standort mit dem Intervall, das am Stichtag gilt ({@code gueltigBis} einschließlich),
     * und dem Netzanschluss, an dem sie an dem Tag hängt ({@code null}: keiner gebunden — nie erfunden).
     */
    public record ZugeordneteAnlage(UUID id, String name, LocalDate gueltigAb, LocalDate gueltigBis,
            NetzanschlussBezug netzanschluss) {}

    /** Der Netzanschluss einer Anlage am Stichtag (UEMS AP-10 IP-6): ID, Kennzeichen, die Tage der Bindung. */
    public record NetzanschlussBezug(UUID id, String kennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Ein Standort zum Stichtag. {@code bestand} ist {@code vorhanden},
     * {@code gab_es_noch_nicht} oder {@code archiviert} (das Vokabular des
     * Ortsbaum-Vertrags), {@code bestandText} der Satz dazu (nur, wenn nicht
     * vorhanden). Ohne Bestand sind die zeitgültigen Teile leer: keine Anlagen,
     * Zahlen und Fläche {@code null} — nie eine 0 für einen Standort, den es an
     * dem Tag nicht gab. {@code flaecheQuelle}: {@code eigen} ·
     * {@code aus_gebaeuden_summiert} · {@code null}. Additiv (IP-4, was die
     * Schreibrouten bearbeiten; einfache Felder wie heute): {@code nutzung} als
     * Codes (die erste ist die Hauptnutzung, {@code null} = nichts gewählt),
     * {@code notiz}, {@code lage} und {@code archiviertAm} ({@code null}, solange
     * er nicht archiviert ist).
     */
    public record StandortAmStichtag(
            UUID id,
            String kurzzeichen,
            String name,
            Adresse adresse,
            String zeitzone,
            String zustand,
            List<String> esFehlt,
            String bestand,
            String bestandText,
            List<ZugeordneteAnlage> anlagen,
            Integer anlagenZahl,
            Integer gebaeudeZahl,
            Integer bereichZahl,
            Integer flaecheM2,
            String flaecheQuelle,
            List<String> nutzung,
            String notiz,
            Lage lage,
            Instant archiviertAm) {}

    public record NichtZugeordneteAnlage(UUID id, String name) {}

    /** Die Gruppe „Noch nicht zugeordnet" — es gibt sie nur, solange sie etwas enthält (A15). */
    public record NochNichtZugeordnet(int anlagenZahl, List<NichtZugeordneteAnlage> anlagen) {}

    /**
     * {@code GET /api/v1/standorte?stichtag=}: {@code standorte} sind die, die
     * es an dem Tag gab (in der Reihenfolge des Anlegens), {@code nichtGezeigt}
     * die übrigen mit Grund und Satz; {@code nochNichtZugeordnet} ist
     * {@code null}, sobald alles zugeordnet ist (kein „0 nicht zugeordnet").
     * Additiv vorgesehen: {@code teilansicht} (AP-03 IP-10).
     */
    public record StandorteAmStichtag(
            LocalDate stichtag,
            List<StandortAmStichtag> standorte,
            List<StandortAmStichtag> nichtGezeigt,
            NochNichtZugeordnet nochNichtZugeordnet) {}

    /** Das additive Feld {@code standort} an {@code /overview} und {@code /sites/{id}}. */
    public record StandortBezug(UUID id, String name, String kurzzeichen, LocalDate gueltigAb) {}

    // --------------------------------------------------------------- Ableitung

    /** Der Tag „heute" in der Zeitzonen-Vorgabe des Unternehmens. */
    public static LocalDate heute(Zeilen z, Instant jetzt) {
        return jetzt.atZone(z.zeitzone()).toLocalDate();
    }

    public static UnternehmenSicht unternehmen(Zeilen z, LocalDate heute) {
        StandorteAmStichtag stand = standorte(z, heute);
        int nichtZugeordnet = stand.nochNichtZugeordnet() == null
                ? 0 : stand.nochNichtZugeordnet().anlagenZahl();
        UnternehmenRepository.Unternehmen u = z.unternehmen();
        return u == null
                ? new UnternehmenSicht(UNTERNEHMEN_NICHT_ANGELEGT, null, null, null, null,
                        stand.standorte().size(), z.anlagen().size(), nichtZugeordnet, null, null)
                : new UnternehmenSicht(UNTERNEHMEN_ANGELEGT, u.id(), u.name(), u.kurzname(),
                        u.zeitzone(), stand.standorte().size(), z.anlagen().size(), nichtZugeordnet,
                        adresse(u.sitzStrasse(), u.sitzPlz(), u.sitzOrt(), u.sitzLand()),
                        u.rechtsform());
    }

    public static StandorteAmStichtag standorte(Zeilen z, LocalDate stichtag) {
        Auswertung a = auswerten(z, stichtag);
        List<StandortAmStichtag> vorhanden = new ArrayList<>();
        List<StandortAmStichtag> nichtGezeigt = new ArrayList<>();
        for (StandortRepository.Standort s : z.standorte()) {
            StandortAmStichtag st = standortAm(a, s);
            (VORHANDEN.equals(st.bestand()) ? vorhanden : nichtGezeigt).add(st);
        }
        List<NichtZugeordneteAnlage> offen = z.anlagen().stream()
                .filter(an -> a.standortDerAnlage().get(key(an.id())) == null)
                .map(an -> new NichtZugeordneteAnlage(an.id(), an.name()))
                .toList();
        return new StandorteAmStichtag(stichtag, List.copyOf(vorhanden), List.copyOf(nichtGezeigt),
                offen.isEmpty() ? null : new NochNichtZugeordnet(offen.size(), offen));
    }

    /** Ein Standort zum Stichtag — leer, wenn es ihn im Mandanten nicht gibt (die Route: 404). */
    public static Optional<StandortAmStichtag> standort(Zeilen z, UUID id, LocalDate stichtag) {
        Optional<StandortRepository.Standort> s = z.standorte().stream()
                .filter(x -> x.id().equals(id)).findFirst();
        if (s.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(standortAm(auswerten(z, stichtag), s.get()));
    }

    /** Je Anlage ihr Standort am Tag; eine Anlage ohne gültige Zuordnung fehlt in der Abbildung. */
    public static Map<UUID, StandortBezug> bezugJeAnlage(Zeilen z, LocalDate tag) {
        Auswertung a = auswerten(z, tag);
        Map<UUID, StandortRepository.Standort> jeId = new HashMap<>();
        z.standorte().forEach(s -> jeId.put(s.id(), s));
        Map<UUID, StandortBezug> out = new LinkedHashMap<>();
        for (Anlage an : z.anlagen()) {
            String st = a.standortDerAnlage().get(key(an.id()));
            if (st == null) {
                continue;
            }
            StandortRepository.Standort s = jeId.get(UUID.fromString(st));
            AnlageStandortRepository.Zuordnung iv = intervallAm(z, an.id(), s.id(), tag);
            out.put(an.id(), new StandortBezug(s.id(), s.name(), s.kurzzeichen(),
                    iv == null ? null : iv.gueltigAb()));
        }
        return out;
    }

    // ------------------------------------------------------------------ Innen

    /** Das Ergebnis von {@link OrtsbaumAbleitung#standAm}, nach Kennzeichen aufgeschlagen. */
    private record Auswertung(
            Zeilen zeilen,
            LocalDate stichtag,
            Map<String, OrtAmStichtag> orte,
            Map<String, NichtGezeigt> nichtGezeigt,
            Map<String, String> standortDerAnlage,
            Map<String, OrtArt> art) {}

    private static Auswertung auswerten(Zeilen z, LocalDate stichtag) {
        StandAm stand = OrtsbaumAbleitung.standAm(baum(z, stichtag), stichtag);
        Map<String, OrtAmStichtag> orte = new HashMap<>();
        stand.orte().forEach(o -> orte.put(o.kennzeichen(), o));
        Map<String, NichtGezeigt> nicht = new HashMap<>();
        stand.nichtGezeigt().forEach(n -> nicht.put(n.kennzeichen(), n));
        Map<String, String> anlagen = new HashMap<>();
        for (AnlageAmStichtag an : stand.anlagen()) {
            anlagen.put(an.kennzeichen(), an.standort());
        }
        Map<String, OrtArt> art = new HashMap<>();
        z.standorte().forEach(s -> art.put(key(s.id()), OrtArt.STANDORT));
        z.orte().forEach(o -> art.put(key(o.id()), ortArt(o.art())));
        return new Auswertung(z, stichtag, orte, nicht, anlagen, art);
    }

    private static StandortAmStichtag standortAm(Auswertung a, StandortRepository.Standort s) {
        String k = key(s.id());
        OrtAmStichtag o = a.orte().get(k);
        if (o == null) {
            NichtGezeigt n = a.nichtGezeigt().get(k);
            return new StandortAmStichtag(s.id(), s.kurzzeichen(), s.name(), adresse(s),
                    s.zeitzone(), s.zustand(), esFehlt(s), code(n.grund()), n.text(),
                    List.of(), null, null, null, null, null,
                    s.nutzung(), s.notiz(), lage(s), s.archiviertAm());
        }
        List<ZugeordneteAnlage> anlagen = new ArrayList<>();
        for (Anlage an : a.zeilen().anlagen()) {
            if (k.equals(a.standortDerAnlage().get(key(an.id())))) {
                AnlageStandortRepository.Zuordnung iv =
                        intervallAm(a.zeilen(), an.id(), s.id(), a.stichtag());
                NetzanschlussBindung na = netzanschlussAm(a.zeilen(), an.id(), a.stichtag());
                anlagen.add(new ZugeordneteAnlage(an.id(), an.name(),
                        iv == null ? null : iv.gueltigAb(), iv == null ? null : iv.gueltigBis(),
                        na == null ? null : new NetzanschlussBezug(na.netzanschlussId(), na.kennzeichen(),
                                na.gueltigAb(), na.gueltigBis())));
            }
        }
        int gebaeude = zaehle(a, k, OrtArt.GEBAEUDE);
        int bereiche = zaehle(a, k, OrtArt.BEREICH);
        return new StandortAmStichtag(s.id(), s.kurzzeichen(), s.name(), adresse(s), s.zeitzone(),
                s.zustand(), esFehlt(s), VORHANDEN, null, List.copyOf(anlagen), anlagen.size(),
                gebaeude, bereiche, o.flaecheM2(),
                o.flaecheQuelle() == null ? null : code(o.flaecheQuelle()),
                s.nutzung(), s.notiz(), lage(s), s.archiviertAm());
    }

    /** Gebäude bzw. Bereiche, deren Wurzel am Stichtag dieser Standort ist. */
    private static int zaehle(Auswertung a, String standort, OrtArt art) {
        return (int) a.orte().values().stream()
                .filter(o -> a.art().get(o.kennzeichen()) == art && standort.equals(o.standort()))
                .count();
    }

    /**
     * Das wirksame Intervall der Anlage an diesem Standort am Tag — nur für
     * „gültig ab/bis" der Antwort; WELCHER Standort gilt, hat
     * {@link OrtsbaumAbleitung#standAm} schon entschieden.
     */
    private static AnlageStandortRepository.Zuordnung intervallAm(
            Zeilen z, UUID anlage, UUID standort, LocalDate tag) {
        return z.anlageZuordnungen().stream()
                .filter(iv -> !iv.aufgehoben() && iv.siteId().equals(anlage)
                        && iv.standortId().equals(standort)
                        && !iv.gueltigAb().isAfter(tag)
                        && (iv.gueltigBis() == null || !tag.isAfter(iv.gueltigBis())))
                .findFirst().orElse(null);
    }

    /**
     * Die Zeilen als Ortsbaum des Vertrags; Kennzeichen = ID der Zeile. Ohne Tag trägt jede Anlage den
     * Netzanschluss ihrer JÜNGSTEN Bindung — der Baum hat für ihn keine Zeitachse; wer einen Tag hat,
     * nimmt {@link #baum(Zeilen, LocalDate)}.
     */
    static Ortsbaum baum(Zeilen z) {
        return baum(z, null);
    }

    /**
     * Die Zeilen als Ortsbaum des Vertrags; jede Anlage trägt das KENNZEICHEN des Netzanschlusses, an dem
     * sie am {@code tag} hängt (AP-10 IP-6, E8: je Tag genau einer) — {@code null}, wenn keiner.
     */
    static Ortsbaum baum(Zeilen z, LocalDate tag) {
        Map<UUID, LocalDate> frueheste = fruehesteBindung(z);
        Map<UUID, List<OrtAenderungRepository.ArchivSchritt>> archiv = new HashMap<>();
        z.standortArchiv().forEach(x -> archiv.computeIfAbsent(x.objektId(), k -> new ArrayList<>()).add(x));
        List<OrtsbaumAbleitung.Ort> orte = new ArrayList<>();
        for (StandortRepository.Standort s : z.standorte()) {
            ZoneId zone = ZoneId.of(s.zeitzone());
            LocalDate beginn = s.createdAt().atZone(zone).toLocalDate();
            LocalDate frueh = frueheste.get(s.id());
            if (frueh != null && frueh.isBefore(beginn)) {
                beginn = frueh;
            }
            // Archiviert am Tag X: der letzte Tag des Bestehens ist der Vortag (§4.2).
            // Wurde er am Tag seines Beginns archiviert, bleibt bis < ab stehen: dann
            // gab es ihn an keinem Tag, und danach ist er „archiviert", nie „noch nicht".
            LocalDate ende = s.archiviertAm() == null
                    ? null : s.archiviertAm().atZone(zone).toLocalDate().minusDays(1);
            orte.add(new OrtsbaumAbleitung.Ort(key(s.id()), OrtArt.STANDORT, s.name(),
                    s.zeitzone(), bestehen(beginn, ende, archiv.getOrDefault(s.id(), List.of())),
                    flaechen(z, f -> s.id().equals(f.standortId()))));
        }
        Map<UUID, List<Intervall>> ortIntervalle = new HashMap<>();
        for (OrtZuordnungRepository.Zuordnung iv : z.ortZuordnungen()) {
            ortIntervalle.computeIfAbsent(iv.ortId(), x -> new ArrayList<>()).add(new Intervall(
                    iv.gueltigAb(), iv.gueltigBis(), key(iv.eltern()), iv.aufgehoben()));
        }
        for (OrtRepository.Ort o : z.orte()) {
            orte.add(new OrtsbaumAbleitung.Ort(key(o.id()), ortArt(o.art()), o.name(), null,
                    ortIntervalle.getOrDefault(o.id(), List.of()),
                    flaechen(z, f -> o.id().equals(f.ortId()))));
        }
        Map<UUID, List<Intervall>> anlageIntervalle = new HashMap<>();
        for (AnlageStandortRepository.Zuordnung iv : z.anlageZuordnungen()) {
            anlageIntervalle.computeIfAbsent(iv.siteId(), x -> new ArrayList<>()).add(new Intervall(
                    iv.gueltigAb(), iv.gueltigBis(), key(iv.standortId()), iv.aufgehoben()));
        }
        List<OrtsbaumAbleitung.Anlage> anlagen = z.anlagen().stream()
                .map(an -> new OrtsbaumAbleitung.Anlage(key(an.id()), an.name(),
                        netzanschlussKennzeichen(z, an.id(), tag),
                        ObjektZustand.AKTIV, anlageIntervalle.getOrDefault(an.id(), List.of())))
                .toList();
        return new Ortsbaum(z.zeitzone(), orte, anlagen, List.of());
    }

    /**
     * Das Bestehen eines Standorts als Intervalle: {@code [beginn, ende]}, aus dem jede
     * ABGESCHLOSSENE Archiv-Lücke des Protokolls herausgeschnitten ist — ein Paar
     * {@code archiviert} (gilt ab A) → {@code wiederhergestellt} (gilt ab W) nimmt die Tage
     * A … W−1 heraus (§4.2 „die Lücke bleibt sichtbar"). Das laufende Archiv steht in der
     * Zeile ({@code ende}), nicht hier; ohne Schritte bleibt es EIN Intervall wie in IP-3.
     * Am selben Tag archiviert und wiederhergestellt: keine Lücke.
     */
    static List<Intervall> bestehen(LocalDate beginn, LocalDate ende,
            List<OrtAenderungRepository.ArchivSchritt> schritte) {
        List<Intervall> out = new ArrayList<>();
        LocalDate ab = beginn;
        LocalDate archiviertAb = null;
        for (OrtAenderungRepository.ArchivSchritt x : schritte) {
            if (OrtAenderungRepository.ARCHIVIERT.equals(x.art())) {
                archiviertAb = x.giltAb();
            } else if (archiviertAb != null && x.giltAb().isAfter(archiviertAb)) {
                out.add(new Intervall(ab, archiviertAb.minusDays(1), null));
                ab = x.giltAb();
                archiviertAb = null;
            } else {
                archiviertAb = null;
            }
        }
        out.add(new Intervall(ab, ende, null));
        return List.copyOf(out);
    }

    /** Die Bindung, an der die Anlage am Tag hängt — ohne Tag die jüngste; {@code null}, wenn keine. */
    private static NetzanschlussBindung netzanschlussAm(Zeilen z, UUID anlage, LocalDate tag) {
        NetzanschlussBindung treffer = null;
        for (NetzanschlussBindung b : z.netzanschluesse()) {
            if (!b.siteId().equals(anlage) || (tag != null && !b.laeuftAm(tag))) {
                continue;
            }
            if (treffer == null || b.gueltigAb().isAfter(treffer.gueltigAb())) {
                treffer = b;
            }
        }
        return treffer;
    }

    private static String netzanschlussKennzeichen(Zeilen z, UUID anlage, LocalDate tag) {
        NetzanschlussBindung b = netzanschlussAm(z, anlage, tag);
        return b == null ? null : b.kennzeichen();
    }

    /** Je Standort der früheste Tag, an dem etwas wirksam an ihm hängt (Anlage, Ort, Fläche). */
    private static Map<UUID, LocalDate> fruehesteBindung(Zeilen z) {
        Map<UUID, LocalDate> out = new HashMap<>();
        for (AnlageStandortRepository.Zuordnung iv : z.anlageZuordnungen()) {
            if (!iv.aufgehoben()) {
                out.merge(iv.standortId(), iv.gueltigAb(), StandortLesemodell::frueher);
            }
        }
        for (OrtZuordnungRepository.Zuordnung iv : z.ortZuordnungen()) {
            if (!iv.aufgehoben() && iv.elternStandortId() != null) {
                out.merge(iv.elternStandortId(), iv.gueltigAb(), StandortLesemodell::frueher);
            }
        }
        for (FlaecheRepository.Flaeche f : z.flaechen()) {
            if (!f.aufgehoben() && f.standortId() != null) {
                out.merge(f.standortId(), f.gueltigAb(), StandortLesemodell::frueher);
            }
        }
        return out;
    }

    private static LocalDate frueher(LocalDate a, LocalDate b) {
        return a.isBefore(b) ? a : b;
    }

    /** Die wirksamen Flächen eines Objekts; eine aufgehobene belegt keinen Tag. */
    private static List<FlaechenIntervall> flaechen(
            Zeilen z, Predicate<FlaecheRepository.Flaeche> gehoert) {
        return z.flaechen().stream()
                .filter(f -> !f.aufgehoben() && gehoert.test(f))
                .map(f -> new FlaechenIntervall(f.gueltigAb(), f.gueltigBis(), f.m2()))
                .toList();
    }

    private static Adresse adresse(StandortRepository.Standort s) {
        return adresse(s.strasse(), s.plz(), s.ort(), s.land());
    }

    /** Die Adresse — {@code null}, wenn kein einziges Feld da ist. */
    static Adresse adresse(String strasse, String plz, String ort, String land) {
        if (strasse == null && plz == null && ort == null && land == null) {
            return null;
        }
        return new Adresse(strasse, plz, ort, land);
    }

    private static Lage lage(StandortRepository.Standort s) {
        return s.lageBreitengrad() == null ? null : new Lage(s.lageBreitengrad(), s.lageLaengengrad());
    }

    /**
     * Was einem ENTWURF fehlt (§4.2, E10): eingerichtet ist ein Standort mit
     * Name + Adresse + Zeitzone; Name und Zeitzone erzwingt die Datenbank, also
     * kann nur die Adresse fehlen — nach {@link #adresseVollstaendig}. Außerhalb
     * des Entwurfs fehlt nichts.
     */
    private static List<String> esFehlt(StandortRepository.Standort s) {
        if (!"entwurf".equals(s.zustand())) {
            return List.of();
        }
        return adresseVollstaendig(s.strasse(), s.ort(), s.land()) ? List.of() : List.of(ES_FEHLT_ADRESSE);
    }

    private static OrtArt ortArt(String code) {
        return OrtArt.valueOf(code.toUpperCase(Locale.ROOT));
    }

    /** Das Wort der Vektor-Datei: der Name in Kleinbuchstaben. */
    private static String code(Enum<?> e) {
        return e.name().toLowerCase(Locale.ROOT);
    }

    private static String key(UUID id) {
        return id.toString();
    }
}
