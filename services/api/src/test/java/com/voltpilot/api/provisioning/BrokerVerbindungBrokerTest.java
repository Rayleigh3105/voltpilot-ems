package com.voltpilot.api.provisioning;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementConfigStatusListener;
import com.voltpilot.api.uems.ErwarteteKadenz;
import com.voltpilot.api.uems.PlanResultListener;
import com.voltpilot.api.uems.SprungprobeBerichtListener;
import com.voltpilot.api.uems.VerbundAnteileResultListener;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.core.env.MapPropertySource;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die vier Rückmeldewege und der Messplan-Sender gegen einen ECHTEN EMQX 5.8.3 (die Prod-Version), mit einem
 * Störproxy davor, der Verbindungen kappt oder ohne Antwort annimmt (Nachstellung der Störung ab 12.10.2026). Die
 * Wege laufen wie in der api: Start über {@code ContextRefreshedEvent}, {@code ensureConnected} als
 * {@code @Scheduled} auf EINEM Scheduler-Thread {@code scheduling-1}, daneben ein Kanarien-Job im 100-ms-Takt
 * stellvertretend für jeden anderen getakteten Job (Läufer, Sammler, Abgleich). Nur {@code handle} ist zum Zählen
 * überschrieben.
 *
 * <ul>
 *   <li>(a) Abriss mit hängendem Aufbau: genau ein Paho-Client je Weg, keine Zeile „subscribe failed" oder
 *       „awaits broker", danach geht alles wieder durch.</li>
 *   <li>(b) Neustart mit mehr als zehn gestauten Nachrichten: alle verarbeitet.</li>
 *   <li>(c) In beiden Fällen läuft der Kanarien-Job weiter.</li>
 *   <li>(d) Ein Erstaufbau ohne CONNACK endet nach {@link BrokerVerbindung#ZEITGRENZE_MS} und beginnt neu.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class BrokerVerbindungBrokerTest {

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883);

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-00000000c0de");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-00000000517e");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-00000000b0c5");
    private static final String STATUS = "measurement-config-status";
    private static final String PLAN = "plan-result";
    private static final String VERBUND = "verbund-anteile-result";
    private static final String SPRUNG = "sprungprobe-result";
    private static final List<String> ARTEN = List.of(STATUS, PLAN, VERBUND, SPRUNG);
    /** Die Client-IDs der Wege: vier mit {@code -<UUID>}, die Sprungprobe fest. */
    private static final List<String> PRAEFIXE = List.of("voltpilot-api-measurement-status",
            "voltpilot-api-plan-result", "voltpilot-api-verbund-anteile-result", "voltpilot-api-sprungprobe-result",
            "voltpilot-api-measurements");
    private static final List<Class<?>> KLASSEN = List.of(MeasurementConfigStatusListener.class,
            PlanResultListener.class, VerbundAnteileResultListener.class, SprungprobeBerichtListener.class,
            MeasurementConfigPublisher.class);

    private ListAppender<ILoggingEvent> logs;

    @BeforeEach
    void logsMitschreiben() {
        logs = new ListAppender<>();
        logs.start();
        KLASSEN.forEach(k -> ((Logger) LoggerFactory.getLogger(k)).addAppender(logs));
    }

    @AfterEach
    void logsLoesen() {
        KLASSEN.forEach(k -> ((Logger) LoggerFactory.getLogger(k)).detachAppender(logs));
    }

    @Test
    @Timeout(180)
    void abrissMitHaengendemAufbauBehaeltEinenClientJeWegUndKeinenStehendenScheduler() throws Exception {
        try (StoerProxy proxy = new StoerProxy(); Box box = box();
                Clientzaehlung zaehlung = new Clientzaehlung(); var api = api(proxy.url())) {
            Wege w = new Wege(api);
            markenBisAngekommen(box, w, "a-start");
            long uebernahmenVorher = metrik("session.takenover");
            int logAb = logZeilen().size();
            w.kanarie().zuruecksetzen();

            proxy.haengen(true);
            proxy.kappen();
            // 15 s ohne Antwort (länger als jede Zeitgrenze); die Box sendet weiter: alle 0,5 s je Weg eine Nachricht.
            for (int i = 1; i <= 30; i++) {
                for (String art : ARTEN) senden(box, topic(DEVICE, art), "a-" + art + "-" + i, !SPRUNG.equals(art));
                Thread.sleep(500);
            }
            assertThat(w.alleGetrennt()).as("während des Ausfalls ist kein Weg verbunden").isTrue();
            // Der Broker antwortet wieder; die hängenden Aufbauten enden (er schließt sie).
            long geheilt = System.nanoTime();
            proxy.haengen(false);
            proxy.gehalteneSchliessen();
            for (String art : ARTEN) senden(box, topic(DEVICE, art), "a-ende-" + art, !SPRUNG.equals(art));
            warten(Duration.ofSeconds(30), () -> ARTEN.stream().allMatch(a -> w.zaehler(a).hat("a-ende-" + a)),
                    "jeder Weg empfängt nach dem Ausfall wieder");
            long wiederDaMs = (System.nanoTime() - geheilt) / 1_000_000;
            warten(Duration.ofSeconds(15), () -> w.sender().clear(TENANT, SITE, DEVICE), "der Sender sendet wieder");

            Map<String, Integer> clients = zaehlung.hoechstens();
            List<String> zeilen = logZeilen().subList(logAb, logZeilen().size());
            long uebernahmen = metrik("session.takenover") - uebernahmenVorher;
            System.out.printf("BEFUND (a) Paho-Clients je Weg (höchstens, ganzer Lauf): %s; Kanarien-Lücke höchstens %d ms;"
                    + " wieder empfangen %d ms nach der Heilung; Sprungprobe-Berichte aus der Sitzung %d/30;"
                    + " EMQX session.takenover +%d; Zeilen subscribe failed %d, awaits broker %d, lost %d;"
                    + " Broker-Clients verbunden %s%n", clients, w.kanarie().groessteLueckeMs(), wiederDaMs,
                    w.zaehler(SPRUNG).anzahlMit("a-" + SPRUNG + "-"), uebernahmen, zaehle(zeilen, "subscribe failed"),
                    zaehle(zeilen, "awaits broker"), zaehle(zeilen, "lost the broker connection"), brokerClients());

            PRAEFIXE.forEach(p -> assertThat(clients.get(p)).as("Paho-Clients von %s in der JVM", p).isEqualTo(1));
            Map<String, Integer> beimBroker = brokerClients();
            PRAEFIXE.forEach(p -> assertThat(beimBroker.get(p)).as("verbundene Clients von %s beim Broker", p)
                    .isEqualTo(1));
            assertThat(zeilen).as("keine Zeile vom Abo oder vom Takt während und nach dem Ausfall")
                    .noneMatch(z -> z.contains("subscribe failed") || z.contains("awaits broker")
                            || z.contains("not connected"));
            // EMQX 5 zählt auch das Wiederaufnehmen der dauerhaften Sprungprobe-Sitzung als Übernahme; ein Streit
            // zweier Clients um eine ID zählte eine je Wiederverbindung, und das ohne Ende.
            assertThat(uebernahmen).as("Übernahmen: nur die Wiederaufnahme der Sprungprobe-Sitzung")
                    .isLessThanOrEqualTo(zaehle(zeilen, "sprungprobe result listener lost the broker connection"));
            assertThat(w.zaehler(SPRUNG).anzahlMit("a-" + SPRUNG + "-"))
                    .as("die Sitzung der Sprungprobe hält die Berichte des Ausfalls").isEqualTo(30);
            assertThat(w.kanarie().groessteLueckeMs()).as("(c) der zweite getaktete Job lief weiter").isLessThan(2_000);
        }
    }

    @Test
    @Timeout(180)
    void neustartMitMehrAlsZehnGestautenNachrichtenVerarbeitetAlle() throws Exception {
        List<String> retained = new ArrayList<>();
        try (Box box = box()) {
            // Die api lief schon einmal: die Sitzung der Sprungprobe (feste ID, dauerhaft) besteht beim Broker.
            try (var vorher = api(direkt())) {
                markenBisAngekommen(box, new Wege(vorher), "b-vorher");
            }
            // Während des Neustarts: 30 Berichte (nicht retained) in die Sitzung, je Quittungsweg 30 Boxen retained.
            for (int i = 1; i <= 30; i++) senden(box, topic(DEVICE, SPRUNG), "b-" + SPRUNG + "-" + i, false);
            for (String art : List.of(STATUS, PLAN, VERBUND)) {
                for (int i = 1; i <= 30; i++) {
                    String t = topic(UUID.nameUUIDFromBytes(("b-" + i).getBytes(UTF_8)), art);
                    senden(box, t, "b-" + art + "-" + i, true);
                    retained.add(t);
                }
            }
            long start = System.nanoTime();
            try (Clientzaehlung zaehlung = new Clientzaehlung(); var api = api(direkt())) {
                Wege w = new Wege(api);
                warten(Duration.ofSeconds(30), () -> ARTEN.stream()
                        .allMatch(a -> w.zaehler(a).anzahlMit("b-" + a + "-") == 30), "alle gestauten Nachrichten");
                long dauerMs = (System.nanoTime() - start) / 1_000_000;
                Map<String, Integer> je = new LinkedHashMap<>();
                ARTEN.forEach(a -> je.put(a, (int) w.zaehler(a).anzahlMit("b-" + a + "-")));
                System.out.printf("BEFUND (b) verarbeitet je Weg %s binnen %d ms ab Start der api; Paho-Clients je Weg %s;"
                        + " Kanarien-Lücke höchstens %d ms; Zeilen subscribe failed %d%n", je, dauerMs,
                        zaehlung.hoechstens(), w.kanarie().groessteLueckeMs(), zaehle(logZeilen(), "subscribe failed"));

                assertThat(w.kanarie().groessteLueckeMs()).as("(c) der zweite getaktete Job lief weiter")
                        .isLessThan(2_000);
                PRAEFIXE.forEach(p -> assertThat(zaehlung.hoechstens().get(p)).as("Paho-Clients von %s", p)
                        .isEqualTo(1));
                assertThat(logZeilen()).noneMatch(z -> z.contains("subscribe failed"));
            }
        } finally {
            try (Box aufraeumen = box()) {
                for (String t : retained) aufraeumen.publish(t, new byte[0], true);
            }
        }
    }

    @Test
    @Timeout(180)
    void erstaufbauOhneConnackEndetNachDerZeitgrenzeUndBeginntNeu() throws Exception {
        try (StoerProxy proxy = new StoerProxy(); Box box = box(); Clientzaehlung zaehlung = new Clientzaehlung()) {
            proxy.haengen(true);
            // 2 s nach dem Start gehen neue Verbindungen durch; die schon angenommenen bleiben stumm und offen.
            ScheduledExecutorService heilen = Executors.newSingleThreadScheduledExecutor();
            heilen.schedule(() -> proxy.haengen(false), 2, TimeUnit.SECONDS);
            heilen.shutdown();
            long start = System.nanoTime();
            try (var api = api(proxy.url())) {
                long startDauerMs = (System.nanoTime() - start) / 1_000_000;
                Wege w = new Wege(api);
                markenBisAngekommen(box, w, "d");
                long verbundenMs = (System.nanoTime() - start) / 1_000_000;
                warten(Duration.ofSeconds(30), () -> w.sender().clear(TENANT, SITE, DEVICE), "der Sender sendet");
                List<String> zeilen = logZeilen();
                System.out.printf("BEFUND (d) Start der api %d ms; alle Wege empfangen nach %d ms; Abbrüche ohne CONNACK"
                        + " %d; Paho-Clients je Weg %s; Kanarien-Lücke höchstens %d ms%n", startDauerMs, verbundenMs,
                        zaehle(zeilen, "no CONNACK within"), zaehlung.hoechstens(), w.kanarie().groessteLueckeMs());

                assertThat(startDauerMs).as("der Start wartet höchstens die Zeitgrenze")
                        .isLessThan(BrokerVerbindung.ZEITGRENZE_MS + 5_000);
                assertThat(zaehle(zeilen, "no CONNACK within")).as("jeder Weg bricht seinen stummen Aufbau genau einmal ab")
                        .isEqualTo(5);
                PRAEFIXE.forEach(p -> assertThat(zaehlung.hoechstens().get(p)).as("Paho-Clients von %s", p)
                        .isEqualTo(1));
                assertThat(w.kanarie().groessteLueckeMs()).as("(c) der zweite getaktete Job lief weiter")
                        .isLessThan(2_000);
            }
        }
    }

    // ---------------------------------------------------------------- die api im Kleinen

    /** Wie die api: ein Scheduler-Thread {@code scheduling-1} für alle getakteten Jobs. */
    @Configuration
    @EnableScheduling
    static class Takt {
        @Bean
        static PropertySourcesPlaceholderConfigurer platzhalter() {
            return new PropertySourcesPlaceholderConfigurer();
        }

        @Bean
        ThreadPoolTaskScheduler taskScheduler() {
            ThreadPoolTaskScheduler s = new ThreadPoolTaskScheduler();
            s.setPoolSize(1);
            s.setThreadNamePrefix("scheduling-");
            return s;
        }

        @Bean
        Kanarie kanarie() {
            return new Kanarie();
        }
    }

    /** Stellvertretend für jeden anderen {@code @Scheduled}-Job der api; misst die größte Lücke ab dem ersten Takt. */
    static class Kanarie {
        private volatile long letzte;
        private final AtomicLong groessteLuecke = new AtomicLong();

        @Scheduled(fixedDelay = 100)
        public void ticken() {
            long jetzt = System.nanoTime();
            if (letzte != 0) groessteLuecke.accumulateAndGet(jetzt - letzte, Math::max);
            letzte = jetzt;
        }

        void zuruecksetzen() {
            letzte = System.nanoTime();
            groessteLuecke.set(0);
        }

        long groessteLueckeMs() {
            assertThat(letzte).as("der Kanarien-Job lief überhaupt").isNotZero();
            return Math.max(groessteLuecke.get(), System.nanoTime() - letzte) / 1_000_000;
        }
    }

    private static AnnotationConfigApplicationContext api(String brokerUrl) {
        var ctx = new AnnotationConfigApplicationContext();
        ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test",
                Map.of("voltpilot.provisioning.enabled", "true", "voltpilot.measurements.status-reconnect-ms", "1000")));
        ctx.register(Takt.class);
        ctx.registerBean(Status.class, () -> new Status(brokerUrl));
        ctx.registerBean(Plan.class, () -> new Plan(brokerUrl));
        ctx.registerBean(Verbund.class, () -> new Verbund(brokerUrl));
        ctx.registerBean(Sprungprobe.class, () -> new Sprungprobe(brokerUrl));
        ctx.registerBean(MeasurementConfigPublisher.class,
                () -> new MeasurementConfigPublisher(brokerUrl, "", "", MAPPER, ErwarteteKadenz.KEINE));
        ctx.refresh();
        return ctx;
    }

    static final class Zaehler {
        private final Set<String> eindeutig = ConcurrentHashMap.newKeySet();

        void zaehlen(byte[] payload) {
            eindeutig.add(new String(payload, UTF_8));
        }

        boolean hat(String text) {
            return eindeutig.contains(text);
        }

        long anzahlMit(String praefix) {
            return eindeutig.stream().filter(s -> s.startsWith(praefix)).count();
        }
    }

    static final class Status extends MeasurementConfigStatusListener {
        final Zaehler zaehler = new Zaehler();

        Status(String url) {
            super(url, "", "", null, MAPPER);
        }

        @Override
        public boolean handle(String topic, byte[] payload) {
            zaehler.zaehlen(payload);
            return true;
        }
    }

    static final class Plan extends PlanResultListener {
        final Zaehler zaehler = new Zaehler();

        Plan(String url) {
            super(url, "", "", null, MAPPER);
        }

        @Override
        public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
            zaehler.zaehlen(payload);
            return true;
        }
    }

    static final class Verbund extends VerbundAnteileResultListener {
        final Zaehler zaehler = new Zaehler();

        Verbund(String url) {
            super(url, "", "", null, MAPPER);
        }

        @Override
        public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
            zaehler.zaehlen(payload);
            return true;
        }
    }

    static final class Sprungprobe extends SprungprobeBerichtListener {
        final Zaehler zaehler = new Zaehler();

        Sprungprobe(String url) {
            super(url, "", "", null, MAPPER);
        }

        @Override
        public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
            zaehler.zaehlen(payload);
            return true;
        }
    }

    record Wege(Status status, Plan plan, Verbund verbund, Sprungprobe sprung, MeasurementConfigPublisher sender,
            Kanarie kanarie) {
        Wege(AnnotationConfigApplicationContext c) {
            this(c.getBean(Status.class), c.getBean(Plan.class), c.getBean(Verbund.class),
                    c.getBean(Sprungprobe.class), c.getBean(MeasurementConfigPublisher.class), c.getBean(Kanarie.class));
        }

        Zaehler zaehler(String art) {
            return switch (art) {
                case STATUS -> status.zaehler;
                case PLAN -> plan.zaehler;
                case VERBUND -> verbund.zaehler;
                default -> sprung.zaehler;
            };
        }

        /** Getrennt = eine frische Marke erreicht keinen Weg. */
        boolean alleGetrennt() throws Exception {
            try (Box box = box()) {
                for (String art : ARTEN) senden(box, topic(DEVICE, art), "getrennt-" + art, false);
            }
            Thread.sleep(500);
            return ARTEN.stream().noneMatch(a -> zaehler(a).hat("getrennt-" + a));
        }
    }

    /**
     * Sendet je Weg eine Marke (alle 0,5 s neu), bis jeder Weg sie verarbeitet hat - mit derselben
     * letzten, frischen Prüfung an der Frist wie {@link #warten} (keine Last-Flake der 500-ms-Taktung).
     */
    private static void markenBisAngekommen(Box box, Wege w, String marke) throws Exception {
        long bis = System.nanoTime() + Duration.ofSeconds(BrokerVerbindung.ZEITGRENZE_MS / 1000 + 30).toNanos();
        while (!ARTEN.stream().allMatch(a -> w.zaehler(a).hat(marke + "-" + a))) {
            if (System.nanoTime() >= bis) {
                assertThat(ARTEN.stream().allMatch(a -> w.zaehler(a).hat(marke + "-" + a)))
                        .as("die Marke %s erreicht jeden Weg", marke).isTrue();
                return;
            }
            for (String art : ARTEN) senden(box, topic(DEVICE, art), marke + "-" + art, false);
            Thread.sleep(500);
        }
    }

    // ---------------------------------------------------------------- Box, Broker, Proxy

    private static String direkt() {
        return "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
    }

    private static String topic(UUID device, String art) {
        return "ems/" + TENANT + "/" + SITE + "/" + device + "/v2/" + art;
    }

    /** Die Box-Seite: direkt am Broker, QoS 1. */
    static final class Box implements AutoCloseable {
        private final MqttClient client;

        Box() throws MqttException {
            client = new MqttClient(direkt(), "box-sim-" + UUID.randomUUID(), new MemoryPersistence());
            client.setTimeToWait(10_000);
            MqttConnectOptions o = new MqttConnectOptions();
            o.setCleanSession(true);
            client.connect(o);
        }

        void publish(String topic, byte[] payload, boolean retained) throws MqttException {
            client.publish(topic, payload, 1, retained);
        }

        @Override
        public void close() throws MqttException {
            client.disconnect();
            client.close();
        }
    }

    private static Box box() throws MqttException {
        return new Box();
    }

    private static void senden(Box box, String topic, String text, boolean retained) throws MqttException {
        box.publish(topic, text.getBytes(UTF_8), retained);
    }

    private static long metrik(String name) throws Exception {
        for (String zeile : EMQX.execInContainer("emqx", "ctl", "broker", "metrics").getStdout().split("\n")) {
            String[] teile = zeile.split(":");
            if (teile.length == 2 && teile[0].trim().equals(name)) return Long.parseLong(teile[1].trim());
        }
        throw new IllegalStateException("EMQX-Metrik " + name + " fehlt");
    }

    /** Verbundene Clients je Präfix, wie der Broker sie sieht ({@code emqx ctl clients list}). */
    private static Map<String, Integer> brokerClients() throws Exception {
        Map<String, Integer> je = new LinkedHashMap<>();
        PRAEFIXE.forEach(p -> je.put(p, 0));
        for (String zeile : EMQX.execInContainer("emqx", "ctl", "clients", "list").getStdout().split("\n")) {
            if (!zeile.contains("connected=true")) continue;
            for (String p : PRAEFIXE) if (zeile.startsWith("Client(" + p)) je.merge(p, 1, Integer::sum);
        }
        return je;
    }

    private List<String> logZeilen() {
        synchronized (logs) {
            return logs.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
        }
    }

    private static long zaehle(List<String> zeilen, String text) {
        return zeilen.stream().filter(z -> z.contains(text)).count();
    }

    /**
     * Pollt alle 200 ms, bis die Bedingung erfüllt ist oder die Frist verstreicht - mit einer letzten,
     * frischen Prüfung GENAU an der Frist, bevor der Fehlschlag feststeht: ohne sie entschiede der
     * Zufall der 200-ms-Taktung, ob eine Erfüllung Millisekunden vor der Frist noch gesehen wird oder
     * knapp als Fristüberschreitung durchfällt - eine Last-Flake, keine echte Verzögerung.
     */
    private static void warten(Duration hoechstens, Bedingung bedingung, String was) throws Exception {
        long bis = System.nanoTime() + hoechstens.toNanos();
        while (!bedingung.erfuellt()) {
            if (System.nanoTime() >= bis) {
                assertThat(bedingung.erfuellt()).as("binnen %s: %s", hoechstens, was).isTrue();
                return;
            }
            Thread.sleep(200);
        }
    }

    @FunctionalInterface
    interface Bedingung {
        boolean erfuellt() throws Exception;
    }

    /**
     * Zählt die Paho-Clients der Wege an ihren Threads ({@code MQTT Call: <id>} usw.), alle 100 ms, und merkt sich je
     * Weg das Höchste: verschiedene IDs (die Wege mit {@code -<UUID>}) oder mehrere Threads derselben Art (die feste ID
     * der Sprungprobe; ein Client hat je Art höchstens einen). Threads, die vorher schon liefen, zählen nicht.
     */
    static final class Clientzaehlung implements AutoCloseable {
        private static final Pattern PAHO = Pattern.compile("MQTT (Call|Rec|Snd|Reconnect): (.+)");
        private final Set<Thread> vorher = Set.copyOf(Thread.getAllStackTraces().keySet());
        private final Map<String, Integer> hoechstens = new ConcurrentHashMap<>();
        private final ScheduledExecutorService takt = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "clientzaehlung");
            t.setDaemon(true);
            return t;
        });

        Clientzaehlung() {
            takt.scheduleAtFixedRate(this::probe, 0, 100, TimeUnit.MILLISECONDS);
        }

        private void probe() {
            Map<String, Set<String>> ids = new HashMap<>();
            Map<String, Integer> jeArt = new HashMap<>();
            for (Thread t : Thread.getAllStackTraces().keySet()) {
                if (vorher.contains(t) || !t.isAlive()) continue;
                Matcher m = PAHO.matcher(t.getName());
                if (!m.matches()) continue;
                for (String p : PRAEFIXE) {
                    if (!m.group(2).startsWith(p)) continue;
                    ids.computeIfAbsent(p, k -> ConcurrentHashMap.newKeySet()).add(m.group(2));
                    jeArt.merge(p + " " + m.group(1), 1, Integer::sum);
                }
            }
            for (String p : PRAEFIXE) {
                int n = ids.getOrDefault(p, Set.of()).size();
                for (var e : jeArt.entrySet()) if (e.getKey().startsWith(p + " ")) n = Math.max(n, e.getValue());
                hoechstens.merge(p, n, Math::max);
            }
        }

        Map<String, Integer> hoechstens() {
            probe();
            return new LinkedHashMap<>(hoechstens);
        }

        @Override
        public void close() {
            takt.shutdownNow();
        }
    }

    /** Vor dem Broker: reicht durch, kappt alle Verbindungen oder nimmt neue an, ohne je zu antworten. */
    static final class StoerProxy implements AutoCloseable {
        private final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        private final Set<Socket> offen = ConcurrentHashMap.newKeySet();
        private final Set<Socket> gehalten = ConcurrentHashMap.newKeySet();
        private volatile boolean haengen;

        StoerProxy() throws IOException {
            Thread t = new Thread(this::annehmen, "stoerproxy");
            t.setDaemon(true);
            t.start();
        }

        String url() {
            return "tcp://127.0.0.1:" + server.getLocalPort();
        }

        void haengen(boolean an) {
            haengen = an;
        }

        void kappen() {
            offen.forEach(StoerProxy::zu);
            offen.clear();
        }

        void gehalteneSchliessen() {
            gehalten.forEach(StoerProxy::zu);
            gehalten.clear();
        }

        private void annehmen() {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    if (haengen) {
                        gehalten.add(s);
                        continue;
                    }
                    Socket b = new Socket(EMQX.getHost(), EMQX.getMappedPort(1883));
                    offen.add(s);
                    offen.add(b);
                    pumpe(s, b);
                    pumpe(b, s);
                } catch (IOException e) {
                    // geschlossen
                }
            }
        }

        private static void pumpe(Socket von, Socket nach) {
            Thread t = new Thread(() -> {
                try (InputStream in = von.getInputStream(); OutputStream out = nach.getOutputStream()) {
                    in.transferTo(out);
                } catch (IOException e) {
                    // gekappt
                } finally {
                    zu(von);
                    zu(nach);
                }
            }, "stoerproxy-pumpe");
            t.setDaemon(true);
            t.start();
        }

        private static void zu(Socket s) {
            try {
                s.close();
            } catch (IOException e) {
                // schon zu
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
            kappen();
            gehalteneSchliessen();
        }
    }
}
