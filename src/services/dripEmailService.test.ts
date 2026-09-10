import assert from "node:assert/strict";
import { sendDripEmail } from "./dripEmailService";
import { setEmailSender } from "./emailService";
import {
  CALL_TRACK_STEPS,
  DRIP_STEPS,
  VERIFY_TRACK_STEPS,
  delayForStep,
  isTrackAllowedInStatus,
  stepForEmailNumber,
  tracksBlockedByStatus,
} from "../queue/dripConfig";

const HOUR = 60 * 60 * 1000;

async function main() {
  process.env.FRONTEND_URL = "https://example.com";
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "test-user";
  process.env.SMTP_PASS = "test-pass";
  process.env.FROM_EMAIL = "hello@brookloans.com";
  process.env.FROM_NAME = "Brook Loans";

  const sent: Array<{ subject: string; html: string }> = [];

  setEmailSender(async ({ subject, html }) => {
    sent.push({ subject, html });
    return { messageId: "1" } as any;
  });

  try {
    const cases = [
      {
        emailNumber: 1,
        expectedSubject:
          "Action Required: Finalize your Brook Loans Application",
        expectedText: "your application is currently on hold until we speak",
        expectedHref: "tel:+17472080334",
      },
      {
        emailNumber: 2,
        expectedSubject: "Next Step: Securely Verify Your Bank Account",
        expectedText: "bank-grade encryption to verify your account status",
        expectedHref: "https://example.com/verify-bank?applicationId=12345",
      },
      {
        emailNumber: 3,
        expectedSubject:
          "Reminder: Verify your bank account to receive your funds",
        expectedText: "takes less than 60 seconds",
        expectedHref: "https://example.com/verify-bank?applicationId=12345",
      },
      {
        emailNumber: 8,
        expectedSubject: "Notice: Your Brook Loans application has been closed",
        expectedText: "will not impact your credit score",
        expectedHref: "https://example.com",
      },
      {
        emailNumber: 11,
        expectedSubject:
          "Don't lose your spot: Call Brook Loans to finalize your loan",
        expectedText: "zero hidden fees or prepayment penalties",
        expectedHref: "tel:+17472080334",
      },
    ] as const;

    for (const testCase of cases) {
      await sendDripEmail(testCase.emailNumber, {
        applicationId: "12345",
        firstName: "Jane",
        email: "jane@example.com",
        loanAmount: 2500,
      });

      const lastMessage = sent[sent.length - 1];
      assert.equal(
        lastMessage?.subject,
        testCase.expectedSubject,
        `subject for email ${testCase.emailNumber}`,
      );
      assert.ok(
        lastMessage?.html.includes(testCase.expectedText),
        `body copy for email ${testCase.emailNumber}`,
      );
      assert.ok(
        lastMessage?.html.includes(`href="${testCase.expectedHref}"`),
        `CTA href for email ${testCase.emailNumber}`,
      );
      assert.ok(
        lastMessage?.html.includes("Hi Jane,"),
        `greeting for email ${testCase.emailNumber}`,
      );
    }

    // Every scheduled step must have a template behind it.
    for (const step of DRIP_STEPS) {
      await sendDripEmail(step.emailNumber, {
        applicationId: "12345",
        firstName: "Jane",
        email: "jane@example.com",
        loanAmount: 2500,
      });
    }

    await assert.rejects(
      sendDripEmail(99, {
        applicationId: "12345",
        firstName: "Jane",
        email: "jane@example.com",
        loanAmount: 2500,
      }),
      /No drip template for email #99/,
    );
  } finally {
    setEmailSender();
  }

  // Production schedule: verify spans submission → 3-day cancellation, call
  // spans 2 days from the same anchor. dripConfig.ts can be switched to a
  // compressed schedule for end-to-end testing, in which case skip the exact
  // offsets and only assert the shape both schedules must share.
  const isProductionSchedule = VERIFY_TRACK_STEPS[1].afterMs === 2 * HOUR;
  if (isProductionSchedule) {
    assert.deepEqual(
      VERIFY_TRACK_STEPS.map((s) => s.afterMs / HOUR),
      [0, 2, 14, 26, 38, 50, 62, 74],
    );
    assert.deepEqual(
      CALL_TRACK_STEPS.map((s) => s.afterMs / HOUR),
      [12, 24, 36, 48],
    );
  } else {
    console.log(
      "! compressed drip schedule active — exact offsets not checked",
    );
    assert.equal(VERIFY_TRACK_STEPS.length, 8);
    assert.equal(CALL_TRACK_STEPS.length, 4);
  }

  // Either way, both tracks run forward from their anchor.
  for (const steps of [VERIFY_TRACK_STEPS, CALL_TRACK_STEPS]) {
    for (let i = 1; i < steps.length; i++) {
      assert.ok(
        steps[i].afterMs > steps[i - 1].afterMs,
        `step ${steps[i].emailNumber} must fire after ${steps[i - 1].emailNumber}`,
      );
    }
  }

  // Email numbers are the idempotency key — they must not collide across tracks.
  assert.equal(
    new Set(DRIP_STEPS.map((s) => s.emailNumber)).size,
    DRIP_STEPS.length,
  );

  // The verify track is status-gated; the call track runs whatever the status.
  assert.equal(
    isTrackAllowedInStatus("verify", "bank_verification_pending"),
    true,
  );
  assert.equal(isTrackAllowedInStatus("verify", "funded"), false);
  assert.equal(
    isTrackAllowedInStatus("call", "bank_verification_pending"),
    true,
  );
  assert.equal(isTrackAllowedInStatus("call", "declined"), true);
  assert.deepEqual(tracksBlockedByStatus("bank_verification_pending"), []);
  assert.deepEqual(tracksBlockedByStatus("funded"), ["verify"]);
  assert.equal(stepForEmailNumber(11)?.track, "call");
  assert.equal(stepForEmailNumber(99), undefined);

  // Delays are relative to the anchor and never negative.
  const anchor = new Date("2026-01-01T00:00:00Z");
  assert.equal(
    delayForStep(VERIFY_TRACK_STEPS[1], anchor, anchor),
    VERIFY_TRACK_STEPS[1].afterMs,
    "E2 fires its configured offset after submission",
  );
  assert.equal(
    delayForStep(
      VERIFY_TRACK_STEPS[1],
      anchor,
      new Date(anchor.getTime() + 5 * HOUR),
    ),
    0,
    "a step whose time has passed fires immediately",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
