/**
 * Drip email schedule.
 *
 * Both tracks are anchored to lead submission, start together, and are gated on
 * the same status: `bank_verification_pending`. They only fire while the
 * application is still sitting in that status — the moment it moves on (most
 * often to `bank_verification_completed`, but any other status counts), the
 * pending jobs for BOTH tracks are dropped (see `cancelDripSequence`) and the
 * worker re-checks the live status as a backstop.
 *
 *   "verify"
 *     E1  T+0     Application submitted (call us to finalize)
 *     E2  T+2h    Secure bank verification link
 *     E3-E7       Verification reminder, every 12h for 3 days
 *     E8  T+74h   Final cancellation notice
 *
 *   "call"
 *     E11-E14     Call reminder, every 12h for 2 days
 *
 * Email numbers are globally unique across tracks because they are the
 * idempotency key in `drip_email_log`.
 */

export const DRIP_QUEUE_NAME = "bank-verification-drip";

export type DripTrack = "verify" | "call";

export const DRIP_TRACKS: DripTrack[] = ["verify", "call"];

/** The loan status during which each track is allowed to run. */
export const DRIP_TRACK_STATUS: Record<DripTrack, string> = {
  verify: "bank_verification_pending",
  call: "bank_verification_pending",
};

/** The status both drip tracks run in. */
export const DRIP_ACTIVE_STATUS = "bank_verification_pending";

export interface DripStep {
  emailNumber: number;
  track: DripTrack;
  /** Offset from the track's anchor instant. */
  afterMs: number;
}

const HOUR = 60 * 60 * 1000;

// const MINUTE = 60 * 1000;
// const TOTAL_TIME = 5 * MINUTE; // 5 minutes
// const STEP = Math.floor(TOTAL_TIME / 8); // ~37.5 seconds

/**
 * Verification track. Offsets are from lead submission. The reminders run on a
 * 12-hour cadence starting 12h after the verification link (T+2h), and the
 * cancellation notice lands 3 days after that link.
 */
export const VERIFY_TRACK_STEPS: DripStep[] = [
  { emailNumber: 1, track: "verify", afterMs: 0 },
  { emailNumber: 2, track: "verify", afterMs: 2 * HOUR },
  { emailNumber: 3, track: "verify", afterMs: 14 * HOUR },
  { emailNumber: 4, track: "verify", afterMs: 26 * HOUR },
  { emailNumber: 5, track: "verify", afterMs: 38 * HOUR },
  { emailNumber: 6, track: "verify", afterMs: 50 * HOUR },
  { emailNumber: 7, track: "verify", afterMs: 62 * HOUR },
  { emailNumber: 8, track: "verify", afterMs: 74 * HOUR },
];

/**
 * Call track. Offsets are from lead submission, the same anchor as the verify
 * track, and it is gated on the same status.
 */
export const CALL_TRACK_STEPS: DripStep[] = [
  { emailNumber: 11, track: "call", afterMs: 12 * HOUR },
  { emailNumber: 12, track: "call", afterMs: 24 * HOUR },
  { emailNumber: 13, track: "call", afterMs: 36 * HOUR },
  { emailNumber: 14, track: "call", afterMs: 48 * HOUR },
];

// export const VERIFY_TRACK_STEPS: DripStep[] = [
//   { emailNumber: 1, track: "verify", afterMs: 0 }, // 0:00
//   { emailNumber: 2, track: "verify", afterMs: STEP }, // ~0:37
//   { emailNumber: 3, track: "verify", afterMs: STEP * 2 }, // ~1:15
//   { emailNumber: 4, track: "verify", afterMs: STEP * 3 }, // ~1:52
//   { emailNumber: 5, track: "verify", afterMs: STEP * 4 }, // ~2:30
//   { emailNumber: 6, track: "verify", afterMs: STEP * 5 }, // ~3:07
//   { emailNumber: 7, track: "verify", afterMs: STEP * 6 }, // ~3:45
//   { emailNumber: 8, track: "verify", afterMs: STEP * 7 }, // ~4:22
// ];

// export const CALL_TRACK_STEPS: DripStep[] = [
//   { emailNumber: 11, track: "call", afterMs: STEP }, // ~0:37
//   { emailNumber: 12, track: "call", afterMs: STEP * 2 }, // ~1:15
//   { emailNumber: 13, track: "call", afterMs: STEP * 3 }, // ~1:52
//   { emailNumber: 14, track: "call", afterMs: STEP * 4 }, // ~2:30
// ];

export const DRIP_STEPS: DripStep[] = [
  ...VERIFY_TRACK_STEPS,
  ...CALL_TRACK_STEPS,
];

export function stepsForTrack(track: DripTrack): DripStep[] {
  return track === "verify" ? VERIFY_TRACK_STEPS : CALL_TRACK_STEPS;
}

export function stepForEmailNumber(emailNumber: number): DripStep | undefined {
  return DRIP_STEPS.find((step) => step.emailNumber === emailNumber);
}

/** Whether a track may keep sending while the application sits in `status`. */
export function isTrackAllowedInStatus(
  track: DripTrack,
  status: string,
): boolean {
  return DRIP_TRACK_STATUS[track] === status;
}

/** Tracks that must be cancelled because `status` locks them out. */
export function tracksBlockedByStatus(status: string): DripTrack[] {
  return DRIP_TRACKS.filter((track) => !isTrackAllowedInStatus(track, status));
}

/**
 * Delay in milliseconds (from now) before a step should fire, given the track's
 * anchor instant. Never negative — a step whose time has already passed is
 * scheduled to run immediately.
 */
export function delayForStep(
  step: DripStep,
  anchoredAt: Date,
  now: Date = new Date(),
): number {
  return Math.max(0, anchoredAt.getTime() + step.afterMs - now.getTime());
}
