// The cold-start protections: the DH exchange budget follows the caller's
// timeout instead of a hard 2s, and a scan that loses its first exchange to a
// transient network window gets exactly one full-length retry instead of
// failing every check in the run. Both guards live in main.go beside
// newCheckOptions and sharedSession; see the issue-#28 signature — zero found
// in one run, fine in the next, with the UI timeout raised and ignored.
package main

import (
	"context"
	"testing"
	"time"

	"github.com/go-faster/errors"
)

// TestExchangeTimeoutFollowsTheCallerTimeout pins the derivation: the 2s floor
// for snappy failure at the minimum timeout, and a budget that grows with a
// caller who raises theirs. The old hard 2s is what left a slow first exchange
// unrecoverable while the UI claimed 20s of patience.
func TestExchangeTimeoutFollowsTheCallerTimeout(t *testing.T) {
	tests := []struct {
		timeoutSec int
		wantFloor  time.Duration
		wantCeil   time.Duration
	}{
		// At and below 6s the 2s floor binds: timeout/3 never exceeds it.
		{3, 2 * time.Second, 2 * time.Second},
		{6, 2 * time.Second, 2 * time.Second},
		// Above 6s the budget grows, but never past the caller's own timeout
		// — the check context remains the outermost bound.
		{9, 3 * time.Second, 3 * time.Second},
		{30, 10 * time.Second, 10 * time.Second},
	}
	for _, tt := range tests {
		got := exchangeTimeout(tt.timeoutSec)
		if got < tt.wantFloor || got > tt.wantCeil {
			t.Errorf("exchangeTimeout(%d) = %v, want within [%v, %v]",
				tt.timeoutSec, got, tt.wantFloor, tt.wantCeil)
		}
	}
}

// TestClaimColdStartRetrySpendsOnce pins the budget as a one-shot: exactly one
// claim succeeds until the budget is refilled, so an all-dead list pays one
// extra timeout, not one per proxy.
func TestClaimColdStartRetrySpendsOnce(t *testing.T) {
	coldStartRetryBudget.Store(1)
	defer coldStartRetryBudget.Store(0)

	if !claimColdStartRetry() {
		t.Fatal("first claim with a full budget = false; want true")
	}
	if claimColdStartRetry() {
		t.Fatal("second claim spent the budget twice; want false")
	}
}

// TestColdStartRetryOnlyForDeadlineErrors pins the trigger: only a deadline
// exceeded can be a slow first exchange. A cancelled context, a pre-dial
// decode error, or a refused connection must never earn a retry — retrying
// those doubles the caller's latency for a failure that is not about budget.
func TestColdStartRetryOnlyForDeadlineErrors(t *testing.T) {
	if !coldStartRetryable(context.DeadlineExceeded) {
		t.Error("DeadlineExceeded must be retryable: it is the slow-exchange signature")
	}
	if coldStartRetryable(context.Canceled) {
		t.Error("Canceled must not be retryable: the caller asked to stop")
	}
	wrapped := errors.Wrap(context.DeadlineExceeded, "help.getNearestDC")
	if !coldStartRetryable(wrapped) {
		t.Error("a wrapped DeadlineExceeded must stay retryable: gotd wraps its errors")
	}
}
