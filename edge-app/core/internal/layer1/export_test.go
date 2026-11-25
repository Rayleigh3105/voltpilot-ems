package layer1

import "time"

// SetPruefstandForTest opens (true) or closes the Edge Light release like the
// bench build does - for the integration tests of package layer1_test only.
func SetPruefstandForTest(on bool) { pruefstandBuild.Store(on) }

// SetVermarkterForTest points the partner interface at a test address instead
// of the tunnel device, moves its port and shrinks the profile's watchdog
// deadline - for the integration tests of package layer1_test only. The
// returned func restores everything.
func SetVermarkterForTest(adresse string, port int, frist time.Duration) func() {
	alteAdresse, alterPort, alteFrist := vermarkterTunnelAdresse, vermarkterPort, vermarkterFristOverride
	vermarkterTunnelAdresse = func() string { return adresse }
	vermarkterPort, vermarkterFristOverride = port, frist
	return func() {
		vermarkterTunnelAdresse, vermarkterPort, vermarkterFristOverride = alteAdresse, alterPort, alteFrist
	}
}
