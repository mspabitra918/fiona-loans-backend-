import "dotenv/config";

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./queue/connection";
import {
  DRIP_EXPIRY_STATUS,
  DRIP_QUEUE_NAME,
  DRIP_TRACK_STATUS,
  isTrackAllowedInStatus,
  stepForEmailNumber,
} from "./queue/dripConfig";
import type { DripJobData } from "./queue/dripQueue";
import {
  getApplicationById,
  purgeExpiredSensitiveData,
  updateApplicationStatus,
} from "./services/applicationService";
import { sendNewDripEmail } from "./services/newDripEmailService";
import { recordDripSent, hasDripBeenSent } from "./services/dripLogService";
import { queryOne } from "./db";

/**
 * Always-on BullMQ worker for the bank-verification drip sequence.
 *
 * Deploy this as a separate long-running process (e.g. on the Hostinger VPS):
 *   npm run build && npm run worker
 * It must NOT run inside the Vercel serverless app — serverless functions are
 * frozen between requests and cannot host a worker.
 *
 * The two safeguards from the spec are enforced here, not just by job removal:
 *   - Instant kill-switch: every job re-reads the live loan status and refuses
 *     to send unless it still matches the status its track is gated on.
 *   - Idempotency: `drip_email_log` has a UNIQUE (application_id, email_number)
 *     constraint, so a retried job can never double-send.
 *
 * The last step of the sequence (T+72h) is also the point of no return: after
 * its cancellation notice goes out the application is moved to `declined`.
 */
async function processDripJob(job: Job<DripJobData>): Promise<void> {
  const { applicationId, emailNumber } = job.data;
  const debugApplication = await queryOne<{
    id: string;
    application_id: string;
    email: string;
    status: string;
  }>(
    `SELECT
     id::text,
     application_id::text,
     email,
     status
   FROM loan_applications
   WHERE id::text = $1`,
    [applicationId],
  );

  console.log("[drip] direct DB lookup:", debugApplication);

  const application = await getApplicationById(applicationId);

  if (!application) {
    console.log(
      `[drip] application ${applicationId} no longer exists — skipping email ${emailNumber}`,
    );
    return;
  }

  const step = stepForEmailNumber(emailNumber);
  if (!step) {
    console.log(`[drip] no schedule entry for email ${emailNumber} — skipping`);
    return;
  }

  // KILL-SWITCH: only send while the application is still in the status its
  // track is gated on — `bank_verification_pending` — so a file that has moved
  // on (e.g. `bank_verification_completed`) sends nothing.
  if (!isTrackAllowedInStatus(step.track, application.status)) {
    console.log(
      `[drip] application ${applicationId} is now "${application.status}" (${step.track} track needs "${DRIP_TRACK_STATUS[step.track]}") — skipping email ${emailNumber}`,
    );
    return;
  }

  // Idempotency: never send the same numbered email twice.
  if (await hasDripBeenSent(applicationId, emailNumber)) {
    console.log(
      `[drip] email ${emailNumber} already sent for ${applicationId} — skipping`,
    );
    return;
  }

  await sendNewDripEmail(step.templateNumber, {
    applicationId: application.application_id,
    firstName: application.first_name,
    email: application.email,
    loanAmount: Number(application.loan_amount),
  });

  await recordDripSent(applicationId, emailNumber, application.status);
  console.log(
    `[drip] sent email ${emailNumber} to ${application.email} (application ${applicationId})`,
  );

  // End of the sequence: the borrower never verified inside the 72h window, so
  // the cancellation notice they just received is made true on the file. The
  // status change itself drops any remaining drip jobs.
  if (step.declinesApplication) {
    try {
      await updateApplicationStatus(
        applicationId,
        DRIP_EXPIRY_STATUS,
        "system:drip",
      );
      console.log(
        `[drip] application ${applicationId} moved to "${DRIP_EXPIRY_STATUS}" after the 72h verification window closed`,
      );
    } catch (error) {
      // The email is already out; a failed status write must not retry the job
      // and re-send it. Surface it and let the next sweep or an admin fix it.
      console.error(
        `[drip] failed to move application ${applicationId} to "${DRIP_EXPIRY_STATUS}":`,
        error,
      );
    }
  }
}

const worker = new Worker<DripJobData>(DRIP_QUEUE_NAME, processDripJob, {
  connection: getRedisConnection(),
  concurrency: 5,
});

const retentionSweep = setInterval(
  () => {
    purgeExpiredSensitiveData().catch((error) => {
      console.error("Sensitive-data retention sweep failed:", error);
    });
  },
  24 * 60 * 60 * 1000,
);

worker.on("ready", () => {
  console.log(`[drip] worker ready — listening on queue "${DRIP_QUEUE_NAME}"`);
});

worker.on("failed", (job, err) => {
  console.error(`[drip] job ${job?.id} failed:`, err.message);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[drip] received ${signal}, closing worker...`);
  await worker.close();
  clearInterval(retentionSweep);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
