//go:build !race

package main

// The ordinary build asserts the real budgets. See race_test.go for why the
// race-instrumented one does not.
const raceTimeoutFactor = 1
