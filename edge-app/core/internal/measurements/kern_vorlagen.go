package measurements

// KernEigeneVorlagen are the point_key templates the core reads itself - the
// add-on sensors of a Shelly (agent/shelly_sensors.go, the single reader of
// the device socket). Every other reader leaves them alone: Edge Light's
// measurement library does not plan them, so the core's verdict for them
// stands in the merged status (StatusMerger) and no point is read twice.
// agent's TestShellySensorTemplatesAreTheCoreOwnedTemplates pins the reader
// to this list.
var KernEigeneVorlagen = map[string]bool{
	"shelly.gen2plus.temperature[*].tc":                   true,
	"shelly.gen2plus.input[*].state":                      true,
	"shelly.gen1.external_sensor[*].ext_temperature.*.tc": true,
}
