//go:build race

package main

// raceTimeoutFactor stretches the wall-clock budgets in checkproxy_test.go when
// the binary is built with the race detector. The instrumented handshake against
// the fake proxy does its RSA and DH work on the same CPU as the client, and on a
// loaded two-core CI runner that ran past the 20s budget often enough to make the
// race step a coin flip — with no DATA RACE reported, i.e. pure overhead.
//
// It is a factor rather than a larger constant everywhere so the ordinary run
// keeps asserting the tight budget, which is the one that would catch a real
// regression in how long a check takes.
//
// 8 rather than the 4 that measured sufficient here: a two-core CI runner is
// slower than the machine this was measured on, one unexplained failure was seen
// at 4 and never reproduced in the thirteen runs after it, and the cost of being
// generous is only how long a genuinely hung test takes to give up — `go test`'s
// own panic timeout is the backstop for that.
const raceTimeoutFactor = 8
