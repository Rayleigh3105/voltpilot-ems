// vp-mqtt-pub ist das RIG-Werkzeug, mit dem ein docker-freies Rig eine
// Nachricht auf einen MQTT-Broker legt - der Ersatz fuer `mosquitto_pub`, den
// `edge-app/test/e2e-ocpp.sh` bewusst nicht voraussetzt (es laeuft auf jedem
// Rechner mit Go, ohne Docker und ohne Systempakete).
//
// ⚠ Dev-/Rig-Werkzeug: es gehoert in KEIN Kunden-Image. Es hat keine
// Identitaet, keine Politik und keinen Zustand - es publiziert, was ihm
// gesagt wird, und beendet sich.
//
//	vp-mqtt-pub -broker tcp://127.0.0.1:1884 -topic ems/.../v2/entities \
//	            -retain -file registry.json
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func main() {
	broker := flag.String("broker", "tcp://127.0.0.1:1883", "Broker-URL")
	topic := flag.String("topic", "", "Topic")
	file := flag.String("file", "", "Datei mit der Nutzlast ('-' = stdin)")
	payload := flag.String("payload", "", "Nutzlast direkt")
	retain := flag.Bool("retain", false, "retained veroeffentlichen")
	qos := flag.Int("qos", 1, "QoS")
	clientID := flag.String("client-id", fmt.Sprintf("vp-mqtt-pub-%d", time.Now().UnixNano()), "Client-Id")
	flag.Parse()

	if *topic == "" {
		die("-topic fehlt")
	}
	body := []byte(*payload)
	switch {
	case *file == "-":
		b, err := os.ReadFile("/dev/stdin")
		if err != nil {
			die("stdin: %v", err)
		}
		body = b
	case *file != "":
		b, err := os.ReadFile(*file)
		if err != nil {
			die("%s: %v", *file, err)
		}
		body = b
	}

	opts := mqtt.NewClientOptions().AddBroker(*broker).SetClientID(*clientID).
		SetConnectTimeout(5 * time.Second).SetCleanSession(true)
	c := mqtt.NewClient(opts)
	if tok := c.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		die("verbinden: %v", tok.Error())
	}
	defer c.Disconnect(250)

	tok := c.Publish(*topic, byte(*qos), *retain, body)
	if !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		die("veroeffentlichen: %v", tok.Error())
	}
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "vp-mqtt-pub: "+format+"\n", a...)
	os.Exit(1)
}
