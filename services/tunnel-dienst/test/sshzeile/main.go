// sshzeile gibt für die Integrationsprobe einen öffentlichen SSH-Schlüssel in
// Normalform aus: `sshzeile <nr>`, verschiedene Nummern ergeben verschiedene
// Schlüssel. Es sind Prüfwerte, keine echten Schlüssel (internal/probe).
package main

import (
	"fmt"
	"os"
	"strconv"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/probe"
)

func main() {
	nr := 1
	if len(os.Args) > 1 {
		n, err := strconv.Atoi(os.Args[1])
		if err != nil || n < 0 {
			fmt.Fprintln(os.Stderr, "sshzeile <nr>")
			os.Exit(2)
		}
		nr = n
	}
	fmt.Println(probe.SSHZeile(2048, nr))
}
