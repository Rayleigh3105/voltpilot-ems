package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Bestand;
import com.voltpilot.api.uems.MessstelleRegisterRepository.QuelleZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Verortung;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Das Messstellen-Register (UEMS AP-04 IP-4, §5.16): {@code GET /api/v1/messstellen} mit Zeilen zum
 * Stichtag — Ort mit abgeleitetem Standort, elektrische Stellung, Quelle der Hauptgröße (Gerät ·
 * Messwert · seit, „davor …“), Lebenszyklus — und den Filtern Standort · Ort (mit Teilbaum) ·
 * Anlage · Zustand · ohne Quelle.
 *
 * <p><b>Lesezüge.</b> Alles über die Messstellen kommt aus EINER Abfrage
 * ({@link MessstelleRegisterRepository}); der Ortsbaum zum Stichtag aus dem Lesezug des
 * Standort-Lesemodells ({@link StandortService#baum}) — eine feste Zahl, gleich wie viele
 * Messstellen es gibt. Beides in einer Lese-Transaktion.
 *
 * <p><b>Keine zweite Ableitung.</b> Der Standort einer Messstelle ist {@link OrtsbaumAbleitung#verortung}
 * (dieselbe wie {@code …/{id}/standort?am=}), ob eine Bindung zum Zeitpunkt läuft
 * {@link MessstelleQuelleService#gilt} (dieselbe wie {@code …/{id}/quellen?stichtag=}), der
 * Lebenszyklus der der Messstellen-Antwort ({@link MessstelleService#darstellung}), der Name des
 * Messwerts der des Messkanal-Read-Models ({@link MesskanalService#anzeigename}).
 *
 * <p><b>Was noch nicht da ist, ist {@code null}:</b> Beobachtung und letzter Wert (IP-15), die
 * Formel einer berechneten Messstelle (AP-10; die Quelle sagt {@code berechnet}), Prozesse und
 * Kostenstellen (ihre Objekte fehlen), {@code teilansicht} ist {@code false} bis AP-03.
 */
@Service
public class MessstelleRegisterService {

    /** Die Wörter von {@code quelle.stand}. */
    public static final String GEBUNDEN = "gebunden";
    public static final String BERECHNET = "berechnet";
    public static final String KEINE_DATENQUELLE = "keine_datenquelle";

    private static final String FUEHREND = "fuehrend";
    private static final String VERGLEICH = "vergleich";

    /**
     * Die Filter; {@code null} = keiner. {@code standort} und {@code ort} sind ein Kurzzeichen oder
     * eine ID (Standort, Gebäude, Bereich); {@code ort} schließt den Teilbaum ein, {@code U} ist das
     * Unternehmen (die Messstellen direkt an ihm). {@code zustand} ist ein Wort des Lebenszyklus.
     * {@code ohneQuelle} findet die gemessenen ohne führende Quelle zum Zeitpunkt — die berechneten
     * haben keine und sind deshalb nicht „ohne Quelle“.
     */
    public record Filter(String standort, String ort, UUID anlage, String zustand, boolean ohneQuelle) {

        public static final Filter KEINER = new Filter(null, null, null, null, false);
    }

    private final MessstelleRegisterRepository register;
    private final MessstelleService messstellen;
    private final StandortService standorte;
    private final MesskanalService kanaele;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleRegisterService(MessstelleRegisterRepository register, MessstelleService messstellen,
            StandortService standorte, MesskanalService kanaele) {
        this.register = register;
        this.messstellen = messstellen;
        this.standorte = standorte;
        this.kanaele = kanaele;
    }

    /** Nur für Tests: die Uhr, an der „ohne Stichtag = jetzt“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Das Register zum Zeitpunkt {@code am} ({@code null} = jetzt): Ort und Stellung gelten an
     * dessen Tag (Europe/Berlin — alle zulässigen Zeitzonen haben dieselben Regeln), die Quelle
     * genau zu ihm.
     */
    @Transactional(readOnly = true)
    public MessstelleDto.Liste liste(Instant am, Filter filter) {
        Instant zeitpunkt = am != null ? am : uhr.instant();
        LocalDate tag = LocalDate.ofInstant(zeitpunkt, MessstelleService.ZEITZONE);
        List<Bestand> bestand = register.alle();
        if (bestand.isEmpty()) {
            return new MessstelleDto.Liste(List.of(), List.of(), tag, MessstelleService.zeit(zeitpunkt), false);
        }
        List<MessstelleDto.Messstelle> voll = bestand.stream()
                .map(b -> messstellen.darstellung(b.messstelle(), b.nebengroessen(), b.orte(), b.stellungen(),
                        quellen(b)))
                .toList();
        List<OrtsbaumAbleitung.Messstelle> imBaum = new ArrayList<>();
        for (int i = 0; i < bestand.size(); i++) {
            imBaum.add(imBaum(bestand.get(i), voll.get(i), tag));
        }
        StandortService.Baum baum = standorte.baum(imBaum);
        Map<UUID, String> anlagen = baum.zeilen().anlagen().stream()
                .collect(Collectors.toMap(StandortLesemodell.Anlage::id, StandortLesemodell.Anlage::name));
        Auswahl auswahl = Auswahl.aus(filter, baum);
        List<MessstelleDto.Messstelle> messstellenListe = new ArrayList<>();
        List<MessstelleDto.RegisterZeile> zeilen = new ArrayList<>();
        for (int i = 0; i < bestand.size(); i++) {
            MessstelleDto.RegisterZeile z = zeile(bestand.get(i), voll.get(i), baum, anlagen, tag, zeitpunkt);
            if (auswahl.passt(z)) {
                messstellenListe.add(voll.get(i));
                zeilen.add(z);
            }
        }
        return new MessstelleDto.Liste(List.copyOf(messstellenListe), List.copyOf(zeilen), tag,
                MessstelleService.zeit(zeitpunkt), false);
    }

    // ---------------------------------------------------------------- Zeile

    private MessstelleDto.RegisterZeile zeile(Bestand b, MessstelleDto.Messstelle voll, StandortService.Baum baum,
            Map<UUID, String> anlagen, LocalDate tag, Instant zeitpunkt) {
        MessstelleRepository.Messstelle m = b.messstelle();
        Groesse h = m.hauptgroesse();
        return new MessstelleDto.RegisterZeile(m.id(), m.kennzeichen(), m.name(), m.art(), m.medium(),
                new MessstelleDto.Groesse(h.groesse(), h.richtung(), h.einheit(), h.wertart()),
                ort(b, baum, tag), stellung(b, anlagen, tag), quelle(b, zeitpunkt),
                voll.lebenszyklus(), voll.fehlt(), voll.angehaltenAb(), voll.archiviertAm(), null, null);
    }

    /** Die Verortung am Tag (Regel 7 des Ortsbaums) mit den Namen aus demselben Baum. */
    private static MessstelleDto.RegisterOrt ort(Bestand b, StandortService.Baum baum, LocalDate tag) {
        Ortsbaum o = baum.baum();
        Verortung v = OrtsbaumAbleitung.verortung(o, b.messstelle().kennzeichen(), tag);
        String grund = v.grund().name().toLowerCase(Locale.ROOT);
        OrtZeile amTag = amTag(b.orte(), tag);
        if (v.ort() == null || amTag == null) {
            return new MessstelleDto.RegisterOrt(null, null, null, null, null, null, List.of(), null, null, null,
                    grund);
        }
        String name = OrtsbaumAbleitung.UNTERNEHMEN.equals(v.ort())
                ? (baum.zeilen().unternehmen() == null ? null : baum.zeilen().unternehmen().name())
                : o.ort(v.ort()).map(OrtsbaumAbleitung.Ort::name).orElse(null);
        String standortName = v.standort() == null ? null
                : o.ort(v.standort()).map(OrtsbaumAbleitung.Ort::name).orElse(null);
        return new MessstelleDto.RegisterOrt(amTag.zielId(), v.ort(), amTag.zielArt(), name, amTag.gueltigAb(),
                amTag.gueltigBis(), v.pfad(), v.standort(), v.standort() == null ? null : baum.standorte()
                        .get(v.standort()), standortName, grund);
    }

    private static MessstelleDto.RegisterStellung stellung(Bestand b, Map<UUID, String> anlagen, LocalDate tag) {
        StellungZeile s = amTag(b.stellungen(), tag);
        return s == null ? null : new MessstelleDto.RegisterStellung(s.siteId(), anlagen.get(s.siteId()),
                s.stellung(), s.unterzaehlerVonKennzeichen(), s.gueltigAb(), s.gueltigBis());
    }

    /**
     * Die Quelle der Hauptgröße zum Zeitpunkt: die führende, die dann läuft; davor die führende, die
     * zuletzt VOR ihr (bzw. vor dem Zeitpunkt) endete; die Zahl der laufenden Vergleichsquellen.
     */
    private MessstelleDto.RegisterQuelle quelle(Bestand b, Instant zeitpunkt) {
        Groesse h = b.messstelle().hauptgroesse();
        List<QuelleZeile> derHaupt = b.quellen().stream()
                .filter(z -> z.quelle().groesse().equals(h.groesse()) && z.quelle().richtung().equals(h.richtung()))
                .toList();
        List<QuelleZeile> fuehrende = derHaupt.stream().filter(z -> FUEHREND.equals(z.quelle().rolle()))
                .sorted(Comparator.comparing(z -> z.quelle().gueltigAb())).toList();
        QuelleZeile gilt = fuehrende.stream().filter(z -> MessstelleQuelleService.gilt(z.quelle(), zeitpunkt))
                .findFirst().orElse(null);
        Instant grenze = gilt != null ? gilt.quelle().gueltigAb() : zeitpunkt;
        QuelleZeile davor = fuehrende.stream()
                .filter(z -> z.quelle().gueltigBis() != null && !z.quelle().gueltigBis().isAfter(grenze))
                .reduce((erste, zweite) -> zweite).orElse(null);
        int vergleich = (int) derHaupt.stream().filter(z -> VERGLEICH.equals(z.quelle().rolle())
                && MessstelleQuelleService.gilt(z.quelle(), zeitpunkt)).count();
        String stand = MessstelleRegeln.BERECHNET.equals(b.messstelle().art()) ? BERECHNET
                : gilt != null ? GEBUNDEN : KEINE_DATENQUELLE;
        return new MessstelleDto.RegisterQuelle(stand, bindung(gilt), bindung(davor), vergleich);
    }

    private MessstelleDto.RegisterBindung bindung(QuelleZeile z) {
        if (z == null) {
            return null;
        }
        Quelle q = z.quelle();
        return new MessstelleDto.RegisterBindung(q.id(), q.entityId(), q.komponenteName(), q.kanal(),
                kanaele.anzeigename(q.kanal(), z.kanalDefinition()),
                new MessstelleDto.RegisterGeraet(q.geraetId(), q.geraet(), q.einbau(), z.geraetBezeichnung()),
                MessstelleService.zeit(q.gueltigAb()), MessstelleService.zeit(q.gueltigBis()));
    }

    // ---------------------------------------------------------------- Gerüst

    /** Das wirksame Intervall, das den Tag deckt — dieselbe Tages-Mechanik wie {@code …/standort?am=}. */
    private static <T extends MessstelleZuordnungRepository.Tagesintervall> T amTag(List<T> zeilen, LocalDate tag) {
        return MessstelleService.wirksam(zeilen).stream().filter(z -> z.deckt(tag)).findFirst().orElse(null);
    }

    /** Die Messstelle, wie der Ortsbaum sie kennt ({@link MessstelleOrtsbaumMessstellen}): Kurzzeichen und Ort-Intervalle. */
    private static OrtsbaumAbleitung.Messstelle imBaum(Bestand b, MessstelleDto.Messstelle voll, LocalDate tag) {
        StellungZeile s = amTag(b.stellungen(), tag);
        return new OrtsbaumAbleitung.Messstelle(b.messstelle().kennzeichen(),
                MessstelleOrtsbaumMessstellen.anzeigename(b.messstelle()), s == null ? null : s.siteId().toString(),
                ObjektZustand.valueOf(voll.lebenszyklus().toUpperCase(Locale.ROOT)),
                MessstelleOrtsbaumMessstellen.intervalle(b.orte()));
    }

    private static List<Quelle> quellen(Bestand b) {
        return b.quellen().stream().map(QuelleZeile::quelle).toList();
    }

    /**
     * Die Filter, aufgelöst gegen den Baum: eine ID wird zum Kurzzeichen ihres Standorts bzw. Orts.
     * Eine ID oder ein Kurzzeichen, das es im Kundenbereich nicht gibt (auch ein fremdes), findet
     * nichts — nie ein 403, nie ein Hinweis, dass es sie woanders gibt.
     */
    private record Auswahl(Filter filter, String standort, String ort, boolean nichts) {

        static Auswahl aus(Filter f, StandortService.Baum baum) {
            String standort = kurzzeichen(f.standort(), baum);
            String ort = kurzzeichen(f.ort(), baum);
            // Eine ID, die es hier nicht gibt, ist kein „egal“: sie findet nichts.
            return new Auswahl(f, standort, ort,
                    f.standort() != null && standort == null || f.ort() != null && ort == null);
        }

        boolean passt(MessstelleDto.RegisterZeile z) {
            if (nichts) {
                return false;
            }
            if (filter.standort() != null && !Objects.equals(standort, z.ort().standort())) {
                return false;
            }
            if (filter.ort() != null && !(Objects.equals(ort, z.ort().kennzeichen()) || z.ort().pfad().contains(ort))) {
                return false;
            }
            if (filter.anlage() != null
                    && (z.elektrischeStellung() == null || !filter.anlage().equals(z.elektrischeStellung().anlage()))) {
                return false;
            }
            if (filter.zustand() != null && !filter.zustand().equals(z.lebenszyklus())) {
                return false;
            }
            return !filter.ohneQuelle() || KEINE_DATENQUELLE.equals(z.quelle().stand());
        }

        private static String kurzzeichen(String wert, StandortService.Baum baum) {
            if (wert == null) {
                return null;
            }
            UUID id = uuid(wert);
            if (id == null) {
                return wert;
            }
            Function<Map.Entry<String, UUID>, Boolean> gleich = e -> id.equals(e.getValue());
            return baum.standorte().entrySet().stream().filter(gleich::apply).map(Map.Entry::getKey).findFirst()
                    .or(() -> baum.orte().values().stream().filter(o -> id.equals(o.id()))
                            .map(OrtRepository.Ort::kurzzeichen).findFirst())
                    .orElse(null);
        }

        private static UUID uuid(String wert) {
            try {
                return UUID.fromString(wert);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }
}
